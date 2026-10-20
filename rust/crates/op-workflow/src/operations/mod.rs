//! The five fixed business entry points of the PodHub workflow.
//!
//! slice / recognize / upload / send / prepare decide **what should happen
//! now**; Cloud adapters execute. The kernel is I/O-free: no HTTP, S3 or
//! filesystem dependency, and every payload type is a generic parameter
//! carried through Decision<T> / JobSpec<T> unchanged (executor Request
//! shapes stay with Cloud or the browser).
//!
//! Decision contract:
//! - Blocked is a decision, not an error — missing PSD, unconfigured prompt,
//!   unsettled candidates and required reconciliation are displayable,
//!   fixable conditions.
//! - OperationError covers only contract violations (revision conflict,
//!   cancelled generation, invalid identity/evidence/input).
//! - Async results are fenced by revision == job.input_revision plus the
//!   adapter's lease-epoch check; the kernel hands
//!   the revision to fence against in every JobSpec.

mod key;
mod model;
#[cfg(test)]
mod tests;

pub use key::{recognize_job_key, send_job_key, slice_job_key, upload_job_key};
pub use model::{
    ActiveOperations, Decision, JobSpec, NoopReason, OperationBlocker, OperationError,
    OperationFacts, OperationKind, PrepareInput, PrepareMediaPlan, PrepareOutcome, PreparePlan,
    RecognizeInput, RenderEvidence, SendBatchInput, SendRowInput, SliceInput, SubmissionFact,
    SubmissionIntentSpec, UploadInput, ValidationFact, WorkFact,
};

/// One Seller import per Store: at most this many rows in one batch.
const SEND_BATCH_MAX_ROWS: usize = 100;

/// Preconditions shared by every operation, in the fixed order: revision
/// fence, cancellation, row identity.
fn guard_row(facts: &OperationFacts<'_>) -> Result<(), OperationError> {
    if facts.expected_revision != facts.actual_revision {
        return Err(OperationError::RevisionConflict {
            expected: facts.expected_revision,
            actual: facts.actual_revision,
        });
    }
    if facts.cancelled {
        return Err(OperationError::Cancelled);
    }
    if facts.workflow_id.trim().is_empty() {
        return Err(OperationError::InvalidIdentity);
    }
    Ok(())
}

/// Decide whether a committed render manifest must be produced from the bound
/// source image + PSD template.
///
/// Order: revision → cancelled → evidence match → active Job → missing
/// inputs/bindings → Start. Success commits only RenderEvidence; it never
/// marks media ready — media becomes ready only after upload completes.
pub fn slice<T>(input: SliceInput<'_, T>) -> Result<Decision<T>, OperationError> {
    let facts = input.facts;
    guard_row(facts)?;

    let source = input.source_sha256.trim();
    let template = input.template_sha256.trim();
    let renderer = input.renderer_contract_version.trim();

    let evidence_matches = facts.render.is_some_and(|evidence| {
        evidence.source_sha256 == source
            && evidence.template_sha256 == template
            && evidence.renderer_contract_version == renderer
    });
    if evidence_matches {
        return Ok(Decision::Noop {
            reason: NoopReason::RenderEvidenceMatches,
        });
    }
    if let Some(job_id) = &facts.active.slice_job_id {
        return Ok(Decision::Wait {
            job_id: job_id.clone(),
        });
    }
    if source.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingSourceImage],
        });
    }
    if template.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingTemplate],
        });
    }
    if renderer.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingRendererContract],
        });
    }
    if !input.bindings_consistent {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::InconsistentBinding],
        });
    }

    Ok(Decision::Start {
        job: JobSpec {
            kind: OperationKind::Slice,
            idempotency_key: slice_job_key(
                facts.workflow_id,
                facts.actual_revision,
                source,
                template,
                renderer,
            ),
            input_revision: facts.actual_revision,
            cancel_generation: facts.cancel_generation,
            payload: input.request,
        },
    })
}

/// Decide whether candidate content must be recognized from the source image,
/// the (hashed) prompt and the model version. Recognition never overwrites
/// committed manual fields — the adapter applies fill-blank-only writeback.
pub fn recognize<T>(input: RecognizeInput<'_, T>) -> Result<Decision<T>, OperationError> {
    let facts = input.facts;
    guard_row(facts)?;

    if facts.content == WorkFact::Ready {
        return Ok(Decision::Noop {
            reason: NoopReason::ContentReady,
        });
    }
    if let Some(job_id) = &facts.active.recognize_job_id {
        return Ok(Decision::Wait {
            job_id: job_id.clone(),
        });
    }
    if facts.content == WorkFact::Running {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::OrphanedRunningState {
                operation: OperationKind::Recognize,
            }],
        });
    }
    // Missing and Failed both restart: the idempotency key (row + image +
    // hash(prompt) + processing contract) reuses the original Job. A Draft
    // revision bump from unrelated field edits does not mint a new key.
    let image = input.image_sha256.trim();
    let prompt = input.prompt_sha256.trim();
    let contract = input.recognition_contract_version.trim();
    if image.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingSourceImage],
        });
    }
    if prompt.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingPrompt],
        });
    }
    if contract.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingRendererContract],
        });
    }
    Ok(Decision::Start {
        job: JobSpec {
            kind: OperationKind::Recognize,
            idempotency_key: recognize_job_key(facts.workflow_id, image, prompt, contract),
            input_revision: facts.actual_revision,
            cancel_generation: facts.cancel_generation,
            payload: input.request,
        },
    })
}

/// Decide whether already-committed PSD slices must be delivered to public
/// object storage. One Job per Product Instance, never one Job per slice; the
/// executor drains slices with bounded parallelism and per-slice writeback.
pub fn upload<T>(input: UploadInput<'_, T>) -> Result<Decision<T>, OperationError> {
    let facts = input.facts;
    guard_row(facts)?;

    if facts.media == WorkFact::Ready {
        return Ok(Decision::Noop {
            reason: NoopReason::MediaReady,
        });
    }
    if let Some(job_id) = &facts.active.upload_job_id {
        return Ok(Decision::Wait {
            job_id: job_id.clone(),
        });
    }
    let Some(evidence) = facts.render else {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingRenderEvidence],
        });
    };
    if evidence.manifest_digest != input.manifest_digest.trim() {
        return Err(OperationError::InvalidEvidence);
    }
    let media_account = input.media_account_id.trim();
    let delivery_contract = input.delivery_contract_version.trim();
    if media_account.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingMediaAccount],
        });
    }
    if delivery_contract.is_empty() {
        return Ok(Decision::Blocked {
            blockers: vec![OperationBlocker::MissingDeliveryContract],
        });
    }

    Ok(Decision::Start {
        job: JobSpec {
            kind: OperationKind::Upload,
            idempotency_key: upload_job_key(
                facts.workflow_id,
                facts.actual_revision,
                &evidence.manifest_digest,
                media_account,
                delivery_contract,
            ),
            input_revision: facts.actual_revision,
            cancel_generation: facts.cancel_generation,
            payload: input.request,
        },
    })
}

/// Decide whether one Store batch may be submitted to Seller. This is the
/// only entry point with an irreversible external effect; it never calls the
/// Seller API itself — it returns the frozen intent the adapter persists in a
/// short transaction before any worker dials Seller.
pub fn send(input: SendBatchInput<'_>) -> Result<Decision<SubmissionIntentSpec>, OperationError> {
    if input.rows.is_empty() || input.rows.len() > SEND_BATCH_MAX_ROWS {
        return Err(OperationError::InvalidInput);
    }
    let target_store_id = input.target_store_id.trim();
    let frozen_payload_digest = input.frozen_payload_digest.trim();
    if frozen_payload_digest.is_empty() || target_store_id.is_empty() {
        return Err(OperationError::InvalidInput);
    }

    let mut blockers = Vec::new();
    let mut wait_job_id: Option<String> = None;
    let mut accepted_rows = 0usize;
    let mut start_rows: Vec<(String, u64)> = Vec::new();
    let mut schema_revisions: Vec<String> = Vec::new();

    for row in input.rows {
        guard_row(row.facts)?;

        if row.draft_ref.cloud_draft_id().is_none() {
            blockers.push(OperationBlocker::MissingCloudIdentity);
            continue;
        }
        let bound_store = row.target_store_id.trim();
        if bound_store != target_store_id {
            blockers.push(OperationBlocker::TargetStoreMismatch {
                bound: bound_store.to_owned(),
                requested: target_store_id.to_owned(),
            });
            continue;
        }
        if row.facts.content != WorkFact::Ready {
            blockers.push(OperationBlocker::ContentNotReady);
            continue;
        }
        if row.facts.media != WorkFact::Ready {
            blockers.push(OperationBlocker::MediaNotReady);
            continue;
        }
        if !row.facts.candidates_settled {
            blockers.push(OperationBlocker::CandidatesUnsettled);
            continue;
        }
        // The stored validation fact is a display snapshot. Whether the fields
        // can be sent is the caller's current validate result, not this fact.
        match row.facts.submission {
            SubmissionFact::Accepted => {
                accepted_rows += 1;
            }
            SubmissionFact::None | SubmissionFact::Rejected => {
                // A send Job for the store must never duplicate an intent for
                // the same rows already in flight.
                if let Some(job_id) = &row.facts.active.send_job_id {
                    wait_job_id = Some(job_id.clone());
                } else {
                    start_rows.push((row.facts.workflow_id.to_owned(), row.facts.actual_revision));
                    schema_revisions.push(row.draft_ref.schema_revision.clone());
                }
            }
            SubmissionFact::Queued | SubmissionFact::Submitting => {
                if let Some(job_id) = &row.facts.active.send_job_id {
                    wait_job_id = Some(job_id.clone());
                } else {
                    blockers.push(OperationBlocker::SubmissionInFlight);
                }
            }
            SubmissionFact::Unknown => {
                blockers.push(OperationBlocker::NeedsReconciliation);
            }
        }
    }

    if !blockers.is_empty() {
        return Ok(Decision::Blocked { blockers });
    }
    if accepted_rows == input.rows.len() {
        return Ok(Decision::Noop {
            reason: NoopReason::SubmissionAccepted,
        });
    }
    if let Some(job_id) = wait_job_id {
        return Ok(Decision::Wait { job_id });
    }

    start_rows.sort();
    schema_revisions.sort();
    schema_revisions.dedup();
    let idempotency_key = send_job_key(target_store_id, &start_rows, frozen_payload_digest);
    let max_revision = start_rows
        .iter()
        .map(|(_, revision)| *revision)
        .max()
        .unwrap_or(0);
    let max_generation = input
        .rows
        .iter()
        .map(|row| row.facts.cancel_generation)
        .max()
        .unwrap_or(0);

    Ok(Decision::Start {
        job: JobSpec {
            kind: OperationKind::Send,
            idempotency_key: idempotency_key.clone(),
            input_revision: max_revision,
            cancel_generation: max_generation,
            payload: SubmissionIntentSpec {
                row_revisions: start_rows,
                target_store_id: target_store_id.to_owned(),
                schema_revisions,
                payload_digest: frozen_payload_digest.to_owned(),
                idempotency_key,
            },
        },
    })
}

/// The fixed one-click prepare combinator.
///
/// Recognition, slicing and upload run in strict order; a stopped generation
/// starts nothing. prepare() never
/// creates a submission intent — send stays an explicit user action.
pub fn prepare<R, S, U>(
    input: PrepareInput<'_, R, S, U>,
) -> Result<PreparePlan<R, S, U>, OperationError> {
    guard_row(input.facts)?;

    // Decision matrix row 8 (design §六): while a submission is in flight or
    // awaiting reconciliation, preparation neither re-prepares nor sends —
    // it returns the current facts untouched.
    if matches!(
        input.facts.submission,
        SubmissionFact::Queued | SubmissionFact::Submitting | SubmissionFact::Unknown
    ) {
        let blocker = if input.facts.submission == SubmissionFact::Unknown {
            OperationBlocker::NeedsReconciliation
        } else {
            OperationBlocker::SubmissionInFlight
        };
        return Ok(PreparePlan {
            recognition: Decision::Blocked {
                blockers: vec![blocker.clone()],
            },
            media: PrepareMediaPlan::Blocked(vec![blocker.clone()]),
            outcome: PrepareOutcome::Blocked(vec![blocker]),
        });
    }

    let recognition = recognize(input.recognize)?;

    let media = if input.facts.content != WorkFact::Ready {
        // A single row never spends renderer/upload capacity before OCR has
        // produced accepted content. The browser re-plans after OCR settles.
        if input.facts.media == WorkFact::Ready {
            PrepareMediaPlan::Ready
        } else {
            PrepareMediaPlan::Wait
        }
    } else {
        match (input.facts.media, input.facts.render, input.upload) {
            (WorkFact::Ready, _, _) => PrepareMediaPlan::Ready,
            // Committed evidence exists: only delivery is missing. Upload failure
            // retries upload without ever re-slicing.
            (_, Some(_), Some(upload_input)) => PrepareMediaPlan::Upload(upload(upload_input)?),
            (_, Some(_), None) => {
                PrepareMediaPlan::Blocked(vec![OperationBlocker::UploadPlanMissing])
            }
            // Slicing is already running; subscribe to the existing Job.
            (WorkFact::Running, None, _) if input.facts.active.slice_job_id.is_some() => {
                PrepareMediaPlan::Wait
            }
            // No trusted evidence: fixed slice -> upload chain.
            _ => PrepareMediaPlan::SliceThenUpload(slice(input.slice)?),
        }
    };

    let outcome = derive_prepare_outcome(input.facts, &recognition, &media);

    Ok(PreparePlan {
        recognition,
        media,
        outcome,
    })
}

/// Aggregate the per-rail decisions into one derived outcome. Never persisted:
/// prepare_state does not exist; the UI derives it from sub-jobs and facts.
fn derive_prepare_outcome<R, S, U>(
    facts: &OperationFacts<'_>,
    recognition: &Decision<R>,
    media: &PrepareMediaPlan<S, U>,
) -> PrepareOutcome {
    let mut blockers = Vec::new();
    let mut had_start = false;
    let mut had_wait = false;

    match recognition {
        Decision::Blocked { blockers: row } => blockers.extend(row.iter().cloned()),
        Decision::Start { .. } => had_start = true,
        Decision::Wait { .. } => had_wait = true,
        Decision::Noop { .. } => {}
    }
    match media {
        PrepareMediaPlan::Blocked(row) => blockers.extend(row.iter().cloned()),
        PrepareMediaPlan::Upload(Decision::Blocked { blockers: row })
        | PrepareMediaPlan::SliceThenUpload(Decision::Blocked { blockers: row }) => {
            blockers.extend(row.iter().cloned())
        }
        PrepareMediaPlan::Upload(Decision::Start { .. })
        | PrepareMediaPlan::SliceThenUpload(Decision::Start { .. }) => had_start = true,
        PrepareMediaPlan::Upload(Decision::Wait { .. })
        | PrepareMediaPlan::SliceThenUpload(Decision::Wait { .. })
        | PrepareMediaPlan::Wait => had_wait = true,
        PrepareMediaPlan::Ready
        | PrepareMediaPlan::Upload(Decision::Noop { .. })
        | PrepareMediaPlan::SliceThenUpload(Decision::Noop { .. }) => {}
    }

    if !blockers.is_empty() {
        PrepareOutcome::Blocked(blockers)
    } else if had_start {
        PrepareOutcome::Running
    } else if had_wait {
        PrepareOutcome::Waiting
    } else if !facts.candidates_settled {
        PrepareOutcome::NeedsReview
    } else {
        PrepareOutcome::Prepared
    }
}

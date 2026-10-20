use super::super::*;
use super::{blockers_of, cloud_draft, ready_row, send_row, start_payload};
use crate::DraftRef;

// ── send ───────────────────────────────────────────────────────────────

#[test]
fn send_requires_cloud_uuid() {
    let facts = ready_row();
    let facts = facts.facts();
    let local_draft = DraftRef {
        draft_id: "workflow_instance_product".to_owned(),
        ..cloud_draft()
    };
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &local_draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(blockers_of(&decision).contains(&OperationBlocker::MissingCloudIdentity));
}

#[test]
fn send_rejects_mixed_store_batch() {
    let facts_a = ready_row();
    let facts_b = ready_row();
    let facts_a = facts_a.facts();
    let facts_b = facts_b.facts();
    let draft_a = cloud_draft();
    let draft_b = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[
            send_row(&facts_a, &draft_a, "store-1"),
            send_row(&facts_b, &draft_b, "store-2"),
        ],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(
        blockers_of(&decision).contains(&OperationBlocker::TargetStoreMismatch {
            bound: "store-2".to_owned(),
            requested: "store-1".to_owned(),
        })
    );
}

#[test]
fn same_store_batch_is_one_send() {
    let a = ready_row();
    let mut b = ready_row();
    b.workflow_id = "listing-row-2".to_owned();
    let facts_a = a.facts();
    let facts_b = b.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[
            send_row(&facts_a, &draft, "store-1"),
            send_row(&facts_b, &draft, " store-1 "),
        ],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    let spec = &start_payload(&decision).payload;
    assert_eq!(spec.target_store_id, "store-1");
    assert_eq!(spec.row_revisions.len(), 2);
}

#[test]
fn send_unknown_requires_reconciliation() {
    let facts = ready_row();
    let mut facts = facts;
    facts.submission = SubmissionFact::Unknown;
    let facts = facts.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(blockers_of(&decision).contains(&OperationBlocker::NeedsReconciliation));
}

#[test]
fn accepted_send_is_a_noop() {
    let facts = ready_row();
    let mut facts = facts;
    facts.submission = SubmissionFact::Accepted;
    let facts = facts.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(matches!(
        decision,
        Decision::Noop {
            reason: NoopReason::SubmissionAccepted
        }
    ));
}

#[test]
fn send_returns_frozen_intent_spec() {
    let a = ready_row();
    let mut a = a;
    a.workflow_id = "row-b".to_owned();
    a.actual_revision = 2;
    a.expected_revision = 2;
    let a = a.facts();
    let b = ready_row();
    let mut b = b;
    b.workflow_id = "row-a".to_owned();
    b.actual_revision = 1;
    let b = b.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[
            send_row(&a, &draft, "store-1"),
            send_row(&b, &draft, "store-1"),
        ],
        frozen_payload_digest: "payload-digest",
        target_store_id: "store-1",
    })
    .expect("no error");

    let job = start_payload(&decision);
    assert_eq!(job.kind, OperationKind::Send);
    assert_eq!(job.input_revision, 2);
    assert_eq!(
        job.idempotency_key,
        "send:v1:store-1:row-a@1,row-b@2:payload-digest"
    );
    // The frozen spec carries the sorted rows and the digest: the adapter
    // persists this intent in one short transaction before any Seller call.
    assert_eq!(
        job.payload.row_revisions,
        vec![("row-a".to_owned(), 1), ("row-b".to_owned(), 2)]
    );
    assert_eq!(job.payload.target_store_id, "store-1");
    assert_eq!(job.payload.schema_revisions, vec!["schema-v2".to_owned()]);
    assert_eq!(job.payload.payload_digest, "payload-digest");
    assert_eq!(job.payload.idempotency_key, job.idempotency_key);
}

#[test]
fn send_empty_or_oversized_batch_is_invalid() {
    let facts = ready_row();
    let facts = facts.facts();
    let draft = cloud_draft();
    assert_eq!(
        send(SendBatchInput {
            rows: &[],
            frozen_payload_digest: "digest",
            target_store_id: "store-1",
        }),
        Err(OperationError::InvalidInput)
    );

    let many: Vec<SendRowInput<'_>> =
        std::iter::repeat_with(|| send_row(&facts, &draft, "store-1"))
            .take(super::super::SEND_BATCH_MAX_ROWS + 1)
            .collect();
    assert_eq!(
        send(SendBatchInput {
            rows: &many,
            frozen_payload_digest: "digest",
            target_store_id: "store-1",
        }),
        Err(OperationError::InvalidInput)
    );
}

#[test]
fn send_waits_on_existing_job() {
    let facts = ready_row();
    let mut facts = facts;
    facts.active.send_job_id = Some("job-send-11".to_owned());
    let facts = facts.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert_eq!(
        decision,
        Decision::Wait {
            job_id: "job-send-11".to_owned()
        }
    );
}

#[test]
fn send_row_conditions_are_checked() {
    // content not ready
    let mut facts = ready_row();
    facts.content = WorkFact::Missing;
    let facts = facts.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(blockers_of(&decision).contains(&OperationBlocker::ContentNotReady));

    // media not ready
    let mut facts = ready_row();
    facts.media = WorkFact::Missing;
    let facts = facts.facts();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(blockers_of(&decision).contains(&OperationBlocker::MediaNotReady));

    // candidates unsettled
    let mut facts = ready_row();
    facts.candidates_settled = false;
    let facts = facts.facts();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(blockers_of(&decision).contains(&OperationBlocker::CandidatesUnsettled));

    // A stale or blocked snapshot does not veto. The field gate lives with the
    // caller that already ran validate_resolved.
    let mut facts = ready_row();
    facts.validation = ValidationFact::Stale;
    let facts = facts.facts();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(matches!(decision, Decision::Start { .. }));

    let mut facts = ready_row();
    facts.validation = ValidationFact::Blocked;
    let facts = facts.facts();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(matches!(decision, Decision::Start { .. }));
}

#[test]
fn send_mixed_accepted_and_fresh_rows_submits_only_fresh_rows() {
    let accepted = ready_row();
    let mut accepted = accepted;
    accepted.workflow_id = "row-accepted".to_owned();
    accepted.submission = SubmissionFact::Accepted;
    let accepted = accepted.facts();
    let fresh = ready_row();
    let mut fresh = fresh;
    fresh.workflow_id = "row-fresh".to_owned();
    let fresh = fresh.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[
            send_row(&accepted, &draft, "store-1"),
            send_row(&fresh, &draft, "store-1"),
        ],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    let job = start_payload(&decision);
    assert_eq!(job.payload.row_revisions, vec![("row-fresh".to_owned(), 1)]);
}

#[test]
fn rejected_row_can_resubmit() {
    let facts = ready_row();
    let mut facts = facts;
    facts.submission = SubmissionFact::Rejected;
    let facts = facts.facts();
    let draft = cloud_draft();
    let decision = send(SendBatchInput {
        rows: &[send_row(&facts, &draft, "store-1")],
        frozen_payload_digest: "digest",
        target_store_id: "store-1",
    })
    .expect("no error");
    assert!(matches!(decision, Decision::Start { .. }));
}

#[test]
fn empty_workflow_id_is_an_invalid_identity() {
    let mut facts = ready_row();
    facts.workflow_id = String::new();
    let facts = facts.facts();
    let draft = cloud_draft();
    assert_eq!(
        send(SendBatchInput {
            rows: &[send_row(&facts, &draft, "store-1")],
            frozen_payload_digest: "digest",
            target_store_id: "store-1",
        }),
        Err(OperationError::InvalidIdentity)
    );
}

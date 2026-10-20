use super::super::*;
use super::{
    DeliveryRequest, Facts, blockers_of, evidence, ready_row_facts, recognize_input, run_prepare,
    slice_input, start_payload, upload_input,
};

// ── prepare (§5.5, §6) ────────────────────────────────────────────────

#[test]
fn fresh_prepare_starts_only_recognition() {
    let facts = Facts::new();
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("fresh row is startable");

    let recognize = start_payload(&plan.recognition);
    assert_eq!(recognize.kind, OperationKind::Recognize);
    assert_eq!(plan.media, PrepareMediaPlan::Wait);
    assert_eq!(plan.outcome, PrepareOutcome::Running);
}

#[test]
fn prepare_never_creates_send_intent() {
    let facts = Facts::new();
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("startable");

    // The first plan carries only Recognize — never media or Send work.
    assert_eq!(
        start_payload(&plan.recognition).kind,
        OperationKind::Recognize
    );
    assert_eq!(plan.media, PrepareMediaPlan::Wait);
}

#[test]
fn rendered_media_failure_retries_upload_without_reslice() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    facts.media = WorkFact::Failed;
    facts.render = Some(evidence());
    let facts = facts.facts();

    let plan = run_prepare(&facts, Some(upload_input(&facts))).expect("retry upload");

    assert!(matches!(
        plan.recognition,
        Decision::Noop {
            reason: NoopReason::ContentReady
        }
    ));
    match plan.media {
        PrepareMediaPlan::Upload(decision) => {
            assert_eq!(start_payload(&decision).kind, OperationKind::Upload)
        }
        other => panic!("expected Upload, got {other:?}"),
    }
    assert_eq!(plan.outcome, PrepareOutcome::Running);

    // The same failure leaves slice() a Noop: evidence matches, no re-render.
    let sliced = slice(slice_input(&facts)).expect("no error");
    assert!(matches!(
        sliced,
        Decision::Noop {
            reason: NoopReason::RenderEvidenceMatches
        }
    ));
}

#[test]
fn missing_render_evidence_schedules_slice_then_upload() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    facts.media = WorkFact::Failed;
    let facts = facts.facts();

    let plan = run_prepare(&facts, None).expect("slice then upload");
    match plan.media {
        PrepareMediaPlan::SliceThenUpload(decision) => {
            assert_eq!(start_payload(&decision).kind, OperationKind::Slice)
        }
        other => panic!("expected SliceThenUpload, got {other:?}"),
    }

    // Standalone upload without evidence is a blocked decision, not an error.
    let uploaded = upload(upload_input(&facts)).expect("no error");
    assert!(blockers_of(&uploaded).contains(&OperationBlocker::MissingRenderEvidence));
}

#[test]
fn ready_recognition_is_not_repeated() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    let facts = facts.facts();
    let decision = recognize(recognize_input(&facts)).expect("no error");
    assert!(matches!(
        decision,
        Decision::Noop {
            reason: NoopReason::ContentReady
        }
    ));
}

#[test]
fn unsettled_candidates_return_needs_review() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    facts.media = WorkFact::Ready;
    facts.candidates_settled = false;
    let facts = facts.facts();

    let plan = run_prepare(&facts, None).expect("no error");
    assert!(matches!(plan.recognition, Decision::Noop { .. }));
    assert_eq!(plan.media, PrepareMediaPlan::Ready);
    assert_eq!(plan.outcome, PrepareOutcome::NeedsReview);
}

#[test]
fn prepare_all_ready_is_prepared() {
    let facts = ready_row_facts();
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("no error");
    assert!(matches!(
        plan.recognition,
        Decision::Noop {
            reason: NoopReason::ContentReady
        }
    ));
    assert_eq!(plan.media, PrepareMediaPlan::Ready);
    assert_eq!(plan.outcome, PrepareOutcome::Prepared);
}

#[test]
fn prepare_ai_done_media_missing_starts_only_slice() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("no error");
    assert!(matches!(plan.recognition, Decision::Noop { .. }));
    match plan.media {
        PrepareMediaPlan::SliceThenUpload(decision) => {
            assert_eq!(start_payload(&decision).kind, OperationKind::Slice)
        }
        other => panic!("expected SliceThenUpload, got {other:?}"),
    }
    assert_eq!(plan.outcome, PrepareOutcome::Running);
}

#[test]
fn prepare_waits_when_slice_job_runs() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    facts.media = WorkFact::Running;
    facts.active.slice_job_id = Some("job-slice-9".to_owned());
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("no error");
    assert_eq!(plan.media, PrepareMediaPlan::Wait);
    assert_eq!(plan.outcome, PrepareOutcome::Waiting);
}

#[test]
fn prepare_blocks_when_upload_plan_missing_despite_evidence() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Ready;
    facts.media = WorkFact::Failed;
    facts.render = Some(evidence());
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("no error");
    match &plan.media {
        PrepareMediaPlan::Blocked(blockers) => {
            assert!(blockers.contains(&OperationBlocker::UploadPlanMissing))
        }
        other => panic!("expected Blocked, got {other:?}"),
    }
    assert_eq!(
        plan.outcome,
        PrepareOutcome::Blocked(vec![OperationBlocker::UploadPlanMissing])
    );
}

#[test]
fn prepare_missing_template_still_starts_recognition() {
    let facts = Facts::new();
    let facts = facts.facts();
    let mut slice = slice_input(&facts);
    slice.template_sha256 = "";
    let plan = prepare(PrepareInput {
        facts: &facts,
        recognize: recognize_input(&facts),
        slice,
        upload: None::<UploadInput<'_, DeliveryRequest>>,
    })
    .expect("partial plan");
    assert_eq!(
        start_payload(&plan.recognition).kind,
        OperationKind::Recognize
    );
    assert_eq!(plan.media, PrepareMediaPlan::Wait);
}

#[test]
fn prepare_failed_recognition_keeps_ready_media() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Failed;
    facts.media = WorkFact::Ready;
    let facts = facts.facts();
    let plan = run_prepare(&facts, None).expect("retry recognition only");
    assert_eq!(
        start_payload(&plan.recognition).kind,
        OperationKind::Recognize
    );
    assert_eq!(plan.media, PrepareMediaPlan::Ready);
}

#[test]
fn prepare_does_not_restart_while_submission_is_in_flight() {
    for (submission, expected_blocker) in [
        (SubmissionFact::Queued, OperationBlocker::SubmissionInFlight),
        (
            SubmissionFact::Submitting,
            OperationBlocker::SubmissionInFlight,
        ),
        (
            SubmissionFact::Unknown,
            OperationBlocker::NeedsReconciliation,
        ),
    ] {
        let mut facts = Facts::new();
        facts.submission = submission;
        let facts = facts.facts();
        let plan = run_prepare(&facts, None).expect("no error");
        // Nothing starts: both rails report the same business blocker and the
        // aggregate outcome is Blocked (decision matrix row 8).
        assert_eq!(
            plan.recognition,
            Decision::Blocked {
                blockers: vec![expected_blocker.clone()]
            }
        );
        assert_eq!(
            plan.media,
            PrepareMediaPlan::Blocked(vec![expected_blocker.clone()])
        );
        assert_eq!(
            plan.outcome,
            PrepareOutcome::Blocked(vec![expected_blocker])
        );
    }
}

use super::super::*;
use super::{Facts, blockers_of, recognize_input, start_payload};

// ── recognize ──────────────────────────────────────────────────────────

#[test]
fn recognize_waits_on_active_job() {
    let mut facts = Facts::new();
    facts.active.recognize_job_id = Some("job-ai-2".to_owned());
    let facts = facts.facts();
    let decision = recognize(recognize_input(&facts)).expect("no error");
    assert_eq!(
        decision,
        Decision::Wait {
            job_id: "job-ai-2".to_owned()
        }
    );
}

#[test]
fn recognize_failed_restarts_with_the_same_revision_key() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Failed;
    let facts = facts.facts();
    let decision = recognize(recognize_input(&facts)).expect("no error");
    let job = start_payload(&decision);
    assert_eq!(job.kind, OperationKind::Recognize);
    assert_eq!(
        job.idempotency_key,
        recognize_job_key("row-1", "img-sha-1", "prompt-hash-1", "recognition-v1")
    );
}

#[test]
fn recognize_orphaned_running_is_blocked() {
    let mut facts = Facts::new();
    facts.content = WorkFact::Running;
    let facts = facts.facts();
    let decision = recognize(recognize_input(&facts)).expect("no error");
    assert!(
        blockers_of(&decision).contains(&OperationBlocker::OrphanedRunningState {
            operation: OperationKind::Recognize,
        })
    );
}

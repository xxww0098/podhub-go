use super::super::*;
use super::{Facts, blockers_of, evidence, upload_input};

// ── upload ─────────────────────────────────────────────────────────────

#[test]
fn upload_requires_media_account() {
    let mut facts = Facts::new();
    facts.render = Some(evidence());
    let facts = facts.facts();
    let mut input = upload_input(&facts);
    input.media_account_id = "";
    let decision = upload(input).expect("no error");
    assert!(blockers_of(&decision).contains(&OperationBlocker::MissingMediaAccount));
}

#[test]
fn upload_rejects_evidence_mismatch() {
    let mut facts = Facts::new();
    facts.render = Some(evidence());
    let facts = facts.facts();
    let mut input = upload_input(&facts);
    input.manifest_digest = "manifest-sha-OTHER";
    assert_eq!(upload(input), Err(OperationError::InvalidEvidence));
}

#[test]
fn upload_waits_on_active_job() {
    let mut facts = Facts::new();
    facts.render = Some(evidence());
    facts.active.upload_job_id = Some("job-upload-7".to_owned());
    let facts = facts.facts();
    let decision = upload(upload_input(&facts)).expect("no error");
    assert_eq!(
        decision,
        Decision::Wait {
            job_id: "job-upload-7".to_owned()
        }
    );
}

#[test]
fn ready_media_makes_upload_a_noop() {
    let mut facts = Facts::new();
    facts.media = WorkFact::Ready;
    let facts = facts.facts();
    let decision = upload(upload_input(&facts)).expect("no error");
    assert!(matches!(
        decision,
        Decision::Noop {
            reason: NoopReason::MediaReady
        }
    ));
}

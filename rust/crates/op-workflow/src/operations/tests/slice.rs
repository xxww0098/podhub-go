use super::super::*;
use super::{Facts, blockers_of, evidence, slice_input, start_payload};

// ── slice ──────────────────────────────────────────────────────────────

#[test]
fn slice_with_matching_evidence_is_a_noop() {
    let mut facts = Facts::new();
    facts.render = Some(evidence());
    let facts = facts.facts();
    let decision = slice(slice_input(&facts)).expect("no error");
    assert!(matches!(
        decision,
        Decision::Noop {
            reason: NoopReason::RenderEvidenceMatches
        }
    ));
}

#[test]
fn slice_title_revision_does_not_invalidate_matching_evidence() {
    let mut facts = Facts::new();
    facts.render = Some(evidence());
    facts.actual_revision = 99;
    facts.expected_revision = 99;
    let facts = facts.facts();
    let decision = slice(slice_input(&facts)).expect("no error");
    assert!(matches!(
        decision,
        Decision::Noop {
            reason: NoopReason::RenderEvidenceMatches
        }
    ));
}

#[test]
fn slice_evidence_mismatch_starts_a_new_render() {
    let mut facts = Facts::new();
    facts.render = Some(RenderEvidence {
        template_sha256: "psd-sha-old".to_owned(),
        ..evidence()
    });
    let facts = facts.facts();
    let decision = slice(slice_input(&facts)).expect("no error");
    assert_eq!(start_payload(&decision).kind, OperationKind::Slice);
}

#[test]
fn slice_waits_on_active_job() {
    let mut facts = Facts::new();
    facts.active.slice_job_id = Some("job-slice-4".to_owned());
    let facts = facts.facts();
    let decision = slice(slice_input(&facts)).expect("no error");
    assert_eq!(
        decision,
        Decision::Wait {
            job_id: "job-slice-4".to_owned()
        }
    );
}

#[test]
fn slice_blocks_on_missing_bindings() {
    let facts = Facts::new();
    let facts = facts.facts();

    let mut no_template = slice_input(&facts);
    no_template.template_sha256 = "";
    assert!(
        blockers_of(&slice(no_template).expect("no error"))
            .contains(&OperationBlocker::MissingTemplate)
    );

    let mut no_source = slice_input(&facts);
    no_source.source_sha256 = "";
    assert!(
        blockers_of(&slice(no_source).expect("no error"))
            .contains(&OperationBlocker::MissingSourceImage)
    );

    let mut inconsistent = slice_input(&facts);
    inconsistent.bindings_consistent = false;
    assert!(
        blockers_of(&slice(inconsistent).expect("no error"))
            .contains(&OperationBlocker::InconsistentBinding)
    );
}

use super::super::*;
use super::{
    Facts, cloud_draft, recognize_input, run_prepare, send_row, slice_input, upload_input,
};

// ── revision / cancellation fences ─────────────────────────────────────

#[test]
fn stale_expected_revision_is_rejected() {
    let mut facts = Facts::new();
    facts.expected_revision = 2;
    let facts = facts.facts();

    let expected = OperationError::RevisionConflict {
        expected: 2,
        actual: 1,
    };
    assert_eq!(recognize(recognize_input(&facts)), Err(expected.clone()));
    assert_eq!(slice(slice_input(&facts)), Err(expected.clone()));
    assert_eq!(upload(upload_input(&facts)), Err(expected.clone()));
    assert_eq!(run_prepare(&facts, None), Err(expected));
}

#[test]
fn cancelled_generation_starts_no_new_effect() {
    let mut facts = Facts::new();
    facts.cancelled = true;
    let facts = facts.facts();

    assert_eq!(
        recognize(recognize_input(&facts)),
        Err(OperationError::Cancelled)
    );
    assert_eq!(slice(slice_input(&facts)), Err(OperationError::Cancelled));
    assert_eq!(upload(upload_input(&facts)), Err(OperationError::Cancelled));
    assert_eq!(run_prepare(&facts, None), Err(OperationError::Cancelled));
    assert!(matches!(
        send(SendBatchInput {
            rows: &[send_row(&facts, &cloud_draft(), "store-1")],
            frozen_payload_digest: "digest",
            target_store_id: "store-1",
        }),
        Err(OperationError::Cancelled)
    ));
}

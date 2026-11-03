use super::*;

fn digest() -> String {
    "ab".repeat(32)
}

fn candidate(pending: bool) -> ConfirmCandidate {
    let digest = digest();
    ConfirmCandidate {
        index: 0,
        extension: "jpg".to_owned(),
        object_key: format!(
            "uploads/2026-10-15/1792094400000-22222222-2222-4222-8222-222222222222/{digest}.jpg"
        ),
        digest,
        byte_length: 12,
        storage_revision: 3,
        upload_ticket: "ticket".to_owned(),
        account_id: "acct".to_owned(),
        workspace_uuid: "test-workspace".to_owned(),
        pending_confirm: pending,
    }
}

#[test]
fn a_consistent_pending_object_is_admitted() {
    assert_eq!(MAX_CONFIRM_BATCH, 32);
    let plan = plan_confirm(&[candidate(true)]);
    assert_eq!(plan.batch, vec![0]);
    assert!(matches!(plan.items[0], ConfirmItem::Admit { index: 0 }));
}

#[test]
fn an_already_confirmed_object_is_skipped() {
    let plan = plan_confirm(&[candidate(false)]);
    assert!(plan.batch.is_empty());
    assert!(matches!(plan.items[0], ConfirmItem::Skip { index: 0 }));
}

#[test]
fn a_mismatched_key_never_joins_the_batch() {
    let mut bad = candidate(true);
    bad.object_key = "o/slice-1.jpg".to_owned();
    let plan = plan_confirm(&[bad]);
    assert!(plan.batch.is_empty());
    match &plan.items[0] {
        ConfirmItem::Reject { code, .. } => assert_eq!(*code, "media_confirm_key"),
        other => panic!("{other:?}"),
    }
}

#[test]
fn a_nested_or_mismatched_slice_key_is_rejected() {
    let mut bad = candidate(true);
    bad.object_key = format!("uploads/2026-10-15/batch/extra/{}.jpg", digest());
    assert!(matches!(
        plan_confirm(&[bad]).items[0],
        ConfirmItem::Reject {
            code: "media_confirm_key",
            ..
        }
    ));
}

#[test]
fn a_duplicate_slice_is_rejected() {
    let mut second = candidate(true);
    second.index = 1;
    let plan = plan_confirm(&[candidate(true), second]);
    assert_eq!(plan.batch, vec![0]);
    assert!(matches!(
        plan.items[1],
        ConfirmItem::Reject {
            code: "media_confirm_duplicate",
            ..
        }
    ));
}

#[test]
fn jpeg_is_stored_as_jpg() {
    let mut item = candidate(true);
    item.extension = "jpeg".to_owned();
    assert_eq!(plan_confirm(&[item]).batch, vec![0]);
}

#[test]
fn admission_refusal_keeps_the_batch() {
    assert_eq!(
        confirm_after_batch(429, "user_over_budget", false),
        ConfirmAfterBatch::KeepBatch
    );
    assert_eq!(
        confirm_after_batch(503, "saturated", false),
        ConfirmAfterBatch::KeepBatch
    );
    assert_eq!(
        confirm_after_batch(409, "conflict", false),
        ConfirmAfterBatch::KeepBatch
    );
}

#[test]
fn a_missing_object_may_confirm_alone() {
    assert_eq!(
        confirm_after_batch(404, "media_complete_missing", false),
        ConfirmAfterBatch::SplitOnes
    );
    assert_eq!(
        confirm_after_batch(500, "", true),
        ConfirmAfterBatch::SplitOnes
    );
}

#[test]
fn settled_text_is_shown_locally_and_settled_once() {
    let plan = plan_ocr(&OcrFacts {
        has_recovery: true,
        has_display_text: true,
        original_status: "settled".to_owned(),
        original_usable: Some(true),
        original_request_id: "air-1".to_owned(),
        ..empty_facts()
    });
    assert_eq!(plan.step, OcrStep::Settle);
    assert_eq!(plan.request_id.as_deref(), Some("air-1"));
    assert_eq!(plan.display, OcrDisplay::ShowLocal);
}

#[test]
fn invalid_paid_or_released_answers_require_a_person_and_unknown_results_pause() {
    for status in ["settled", "unbilled_unknown"] {
        let plan = plan_ocr(&OcrFacts {
            has_recovery: true,
            original_status: status.into(),
            original_usable: Some(false),
            ..empty_facts()
        });
        assert_eq!(plan.step, OcrStep::Unusable);
    }
    let plan = plan_ocr(&OcrFacts {
        has_recovery: true,
        original_status: "unbilled_unknown".into(),
        ..empty_facts()
    });
    assert_eq!(plan.step, OcrStep::Pause);
}

#[test]
fn held_and_absent_receipts_stay_on_the_server_ledger() {
    let held = plan_ocr(&OcrFacts {
        has_recovery: true,
        original_status: "held".to_owned(),
        ..empty_facts()
    });
    assert_eq!(held.step, OcrStep::Wait);
    let absent = plan_ocr(&OcrFacts {
        has_recovery: true,
        ..empty_facts()
    });
    assert_eq!(absent.step, OcrStep::PurchaseOriginal);
    let missing = plan_ocr(&OcrFacts {
        has_display_text: true,
        ..empty_facts()
    });
    assert_eq!(missing.step, OcrStep::Wait);
    assert_eq!(missing.display, OcrDisplay::ShowLocal);
}

/// A struct variant inherits none of the enum-level `rename_all`: without its
/// own attribute, `outcomeUnknown` from the wire lands nowhere, falls into
/// `#[serde(default)]`, and the uncertain retry silently becomes a certain
/// one (`KeepBatch` instead of `SplitOnes`). Decoding is where that is
/// visible, so the test asserts the decoded field, not just the plan.
#[test]
fn a_confirm_retry_decodes_the_camel_case_uncertainty_flag() {
    let request: StageRequest = serde_json::from_str(
        r#"{"kind":"confirmRetry","status":429,"code":"user_over_budget","outcomeUnknown":true}"#,
    )
    .expect("the browser's own spelling decodes");
    match request {
        StageRequest::ConfirmRetry {
            status,
            code,
            outcome_unknown,
        } => {
            assert_eq!(status, 429);
            assert_eq!(code, "user_over_budget");
            assert!(outcome_unknown, "outcomeUnknown must decode into the field");
        }
        other => panic!("{other:?}"),
    }
}

/// The whole point of the flag: an uncertain batch must not be re-sent as one
/// batch. Pinned end-to-end through `plan_stage` so the field reaching
/// `confirm_after_batch` is what is checked, not the decoder alone.
#[test]
fn an_uncertain_retry_splits_the_batch_instead_of_keeping_it() {
    let uncertain: StageRequest = serde_json::from_str(
        r#"{"kind":"confirmRetry","status":429,"code":"user_over_budget","outcomeUnknown":true}"#,
    )
    .expect("decodes");
    let plan = plan_stage(uncertain).expect("plan builds");
    assert_eq!(plan["after"], "split_ones");

    let certain: StageRequest = serde_json::from_str(
        r#"{"kind":"confirmRetry","status":429,"code":"user_over_budget","outcomeUnknown":false}"#,
    )
    .expect("decodes");
    let plan = plan_stage(certain).expect("plan builds");
    assert_eq!(plan["after"], "keep_batch");
}

fn empty_facts() -> OcrFacts {
    OcrFacts {
        has_recovery: false,
        has_display_text: false,
        original_status: String::new(),
        original_usable: None,
        original_request_id: String::new(),
    }
}

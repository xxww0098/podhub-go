//! Op 11 (`freezeListing`) through the native ABI, plus the golden input the
//! compiled-WASM parity test (`web/src/features/workflow/platforms/wasm-freeze.test.ts`)
//! replays. The input is `compose_tests`' wire-golden row/card — the same pair
//! Cloud's compose path pins against `fixtures/listing/ozon/product-import-request.json`
//! and `PINNED_REQUEST_DIGEST` — committed once so TypeScript never
//! hand-transcribes it. An ordinary test run only compares against the
//! committed file: a missing or unreadable fixture fails, it is never written
//! on first run and then passed against itself.
//!
//! `put`/`call` repeat `abi.rs`'s helpers: each `tests/*.rs` is its own crate,
//! and two callers do not justify a shared `tests/common` module yet.

use std::path::Path;

use listing_core::compose::compose_tests::{
    PINNED_REQUEST_DIGEST, golden_card, golden_import, golden_row,
};
use listing_core::issue_keys::IssueStage;
use listing_core::ops::{FreezeRefusal, LeanRow};
use listing_core::validate::FieldIssue;
use serde_json::{Value, json};

const ROW_ID: &str = "draft-ozon-golden";

fn call(op: u32, handle: u32, body: &[u8]) -> Result<Value, Value> {
    let ptr = listing_core_wasm::alloc(body.len());
    // SAFETY: `ptr` was just returned by `alloc(body.len())`; no one else sees it.
    unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), ptr, body.len()) };
    // SAFETY: `ptr`/`len` describe the initialised buffer written above.
    let status = unsafe { listing_core_wasm::call(op, handle, ptr, body.len()) };
    // SAFETY: the exact pair `alloc` returned above.
    unsafe { listing_core_wasm::free(ptr, body.len()) };
    let (ptr, len) = if status == 0 {
        (
            listing_core_wasm::result_ptr(),
            listing_core_wasm::result_len() as usize,
        )
    } else {
        (
            listing_core_wasm::last_error_ptr(),
            listing_core_wasm::last_error_len() as usize,
        )
    };
    // SAFETY: result/last-error ptr+len always describe a buffer owned by the
    // module's thread-local state, valid until the next call.
    let value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) })
        .expect("ABI answers JSON");
    listing_core_wasm::drop_result();
    if status == 0 { Ok(value) } else { Err(value) }
}

fn golden_handle() -> (u32, Value) {
    let (row, snapshot) = LeanRow::from_row(golden_row());
    let body = json!({"snapshot": snapshot, "searchMaterials": []}).to_string();
    let ptr = listing_core_wasm::alloc(body.len());
    // SAFETY: fresh allocation of exactly `body.len()` bytes.
    unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), ptr, body.len()) };
    // SAFETY: initialised buffer from `alloc`.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, body.len()) };
    // SAFETY: the exact pair `alloc` returned above.
    unsafe { listing_core_wasm::free(ptr, body.len()) };
    assert_ne!(handle, 0);
    (handle, serde_json::to_value(row).expect("lean row"))
}

/// `path` must already hold exactly `rendered`. Read-only: no branch writes
/// the fixture, so a test can never bless its own output.
fn assert_matches_committed_fixture(path: &Path, rendered: &str) {
    let committed = std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!(
            "{} is a committed golden and must be readable: {error}",
            path.display()
        )
    });
    assert_eq!(
        committed,
        rendered,
        "{} drifted from the native golden; if intended, replace it with the \
         rendered (right) side and review the diff",
        path.display()
    );
}

/// A missing fixture fails the comparison and nothing is left behind. The
/// path is a fresh temp name, never the committed fixture.
#[test]
fn a_missing_golden_fixture_fails_without_being_written() {
    let path = std::env::temp_dir().join(format!(
        "listing-core-wasm-freeze-abi-missing-{}.json",
        std::process::id()
    ));
    assert!(!path.exists(), "{} must not pre-exist", path.display());
    let outcome = std::panic::catch_unwind(|| assert_matches_committed_fixture(&path, "{}\n"));
    assert!(outcome.is_err(), "a missing fixture must fail");
    assert!(!path.exists(), "the comparison wrote {}", path.display());
}

#[test]
fn ozon_freeze_golden_input_matches_the_committed_fixture() {
    let (_, row) = golden_handle();
    let fixture = json!({
        "rowId": ROW_ID,
        "row": row,
        "card": golden_card(),
        "expected": {
            "digest": PINNED_REQUEST_DIGEST,
            "offerId": "ART-001",
            "clientOperationId": format!("workflow:{ROW_ID}:ART-001:{PINNED_REQUEST_DIGEST}"),
        },
    });
    let rendered = serde_json::to_string_pretty(&fixture).expect("fixture") + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ambient/ozon-freeze-golden.json");
    assert_matches_committed_fixture(&path, &rendered);
}

#[test]
fn freeze_listing_answers_the_wire_golden_body_and_identities() {
    let (handle, row) = golden_handle();
    let body = json!({"card": golden_card(), "row": row, "rowId": ROW_ID}).to_string();
    let frozen = call(11, handle, body.as_bytes()).expect("golden freezes");
    assert_eq!(frozen["status"], "frozen");
    assert_eq!(frozen["import"], golden_import());
    assert_eq!(frozen["digest"], PINNED_REQUEST_DIGEST);
    assert_eq!(frozen["offerId"], "ART-001");
    assert_eq!(
        frozen["clientOperationId"],
        format!("workflow:{ROW_ID}:ART-001:{PINNED_REQUEST_DIGEST}")
    );
    assert!(
        frozen["evidence"]["digest"]
            .as_str()
            .unwrap()
            .starts_with("sha256:")
    );
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn freeze_listing_refusal_is_a_successful_call_with_field_issues() {
    let (handle, mut row) = golden_handle();
    row["draft"]["values"]
        .as_object_mut()
        .unwrap()
        .remove("name");
    let body = json!({"card": golden_card(), "row": row, "rowId": ROW_ID}).to_string();
    let refused = call(11, handle, body.as_bytes()).expect("a refusal is not an ABI error");
    assert_eq!(refused["status"], "refused");
    assert_eq!(refused["reason"], "validation_failed");
    let issues = refused["issues"].as_array().unwrap();
    assert!(issues.iter().any(|issue| issue["field_key"] == "name"
        && issue["severity"] == "blocking"
        && issue["remediation"].is_string()));
    listing_core_wasm::schema_drop(handle);
}

/// Every refused issue classifies as a known key of the stage the refusal
/// names, and of no other stage: the ABI tag is the native producer's fact.
/// The `reason` decodes strictly into the native closed `FreezeRefusal`, whose
/// own stage is the tag — nothing on the wire is a separately spelled copy.
fn assert_issue_stage(refused: &Value, stage: IssueStage) {
    assert_eq!(refused["issueStage"], stage.as_str());
    let reason: FreezeRefusal =
        serde_json::from_value(refused["reason"].clone()).expect("a native refusal reason");
    assert_eq!(reason.issue_stage(), stage, "{reason:?}");
    let issues: Vec<FieldIssue> =
        serde_json::from_value(refused["issues"].clone()).expect("field issues");
    assert!(!issues.is_empty());
    let other = match stage {
        IssueStage::Validate => IssueStage::Freeze,
        _ => IssueStage::Validate,
    };
    for issue in &issues {
        let key = issue
            .known_key(stage)
            .expect("known under the tagged stage");
        assert_eq!(key.stage(), stage, "{}", issue.code);
        assert_eq!(issue.known_key(other), None, "{}", issue.code);
    }
}

/// `validation_failed` forwards validate's issues and says so; a refusal
/// freeze finds on its own is tagged `freeze`. Only the refused answer
/// carries the tag.
#[test]
fn freeze_listing_refusal_names_the_stage_of_its_issues() {
    let (handle, row) = golden_handle();
    let body = json!({"card": golden_card(), "row": row, "rowId": ROW_ID}).to_string();
    let frozen = call(11, handle, body.as_bytes()).expect("golden freezes");
    assert!(frozen.get("issueStage").is_none());

    let mut nameless = row.clone();
    nameless["draft"]["values"]
        .as_object_mut()
        .unwrap()
        .remove("name");
    let body = json!({"card": golden_card(), "row": nameless, "rowId": ROW_ID}).to_string();
    let invalid = call(11, handle, body.as_bytes()).expect("validation refusal");
    assert_eq!(invalid["reason"], "validation_failed");
    assert_issue_stage(&invalid, IssueStage::Validate);

    let body = json!({"card": golden_card(), "row": row, "rowId": " "}).to_string();
    let bad_id = call(11, handle, body.as_bytes()).expect("row id refusal");
    assert_eq!(bad_id["reason"], "row_id_invalid");
    assert_issue_stage(&bad_id, IssueStage::Freeze);
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn freeze_listing_needs_a_resident_schema_and_a_row_id() {
    let (handle, row) = golden_handle();
    let body = json!({"card": golden_card(), "row": row, "rowId": ROW_ID}).to_string();
    assert_eq!(
        call(11, 424_242, body.as_bytes()).unwrap_err()["code"],
        "CORE_SCHEMA_HANDLE"
    );
    for row_id in [" ", "draft-ozon-golden "] {
        let body = json!({"card": golden_card(), "row": row, "rowId": row_id}).to_string();
        let refused = call(11, handle, body.as_bytes()).expect("a bad row id is a refusal");
        assert_eq!(refused["reason"], "row_id_invalid");
        assert_eq!(refused["issues"][0]["field_key"], "row_id");
    }
    let missing = json!({"card": golden_card(), "row": row}).to_string();
    assert_eq!(
        call(11, handle, missing.as_bytes()).unwrap_err()["code"],
        "CORE_DECODE"
    );
    listing_core_wasm::schema_drop(handle);
}

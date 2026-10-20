//! Op 12 (`projectSubmitDraft`) and op 13 (`issueManifest`) through the native
//! ABI, compared byte-for-byte with the native `listing_core` functions they
//! forward to. The golden input/output pair is a committed fixture so the
//! compiled-WASM parity test on the browser side replays the same bytes
//! instead of a hand transcription. An ordinary test run only compares
//! against it (like `freeze_abi.rs`): a missing or unreadable fixture fails,
//! it is never written on first run and then passed against itself.
//!
//! `call` and the fixture comparison repeat `freeze_abi.rs`'s helpers: each
//! `tests/*.rs` is its own crate, and a shared `tests/common` module is not
//! justified yet.

use std::path::Path;

use listing_core::compose::compose_tests::{golden_card, golden_row};
use listing_core::issue_keys::known_issue_manifest;
use listing_core::ops::{LeanRow, SubmitDraft};
use serde_json::{Value, json};

const ROW_ID: &str = "draft-ozon-golden";
const OP_SUBMIT_DRAFT: u32 = 9;
const OP_PROJECT_SUBMIT_DRAFT: u32 = 12;
const OP_ISSUE_MANIFEST: u32 = 13;

fn call_raw(op: u32, handle: u32, body: &[u8]) -> Result<Vec<u8>, Value> {
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
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    listing_core_wasm::drop_result();
    if status == 0 {
        Ok(bytes)
    } else {
        Err(serde_json::from_slice(&bytes).expect("ABI errors are JSON"))
    }
}

fn golden_lean_row() -> LeanRow {
    LeanRow::from_row(golden_row()).0
}

#[test]
fn project_submit_draft_is_byte_identical_to_native_from_row() {
    let row = golden_lean_row();
    let body = json!({"rowId": ROW_ID, "row": row}).to_string();
    // No schema handle: `0` names none, and op 12 must not need one.
    let abi = call_raw(OP_PROJECT_SUBMIT_DRAFT, 0, body.as_bytes()).expect("projects");
    let native = serde_json::to_vec(&SubmitDraft::from_row(ROW_ID.to_owned(), &row))
        .expect("native encodes");
    assert_eq!(abi, native);

    let draft: Value = serde_json::from_slice(&abi).expect("json");
    assert_eq!(draft["rowId"], ROW_ID);
    assert_eq!(draft["schemaRevision"], json!(row.schema_revision));
    for server_only in [
        "normalizedSnapshot",
        "validationIssues",
        "renderEvidence",
        "ai",
        "failureLog",
    ] {
        assert!(
            draft.get(server_only).is_none(),
            "{server_only} never travels in a Draft"
        );
    }
}

/// Op 12 then op 9 against the row's own Card rebuilds every field a Draft
/// may carry: the two ops are exact inverses on the Draft subset, so the
/// browser never needs to assemble or disassemble a Draft by hand.
#[test]
fn projected_draft_rebuilds_through_op_nine() {
    let row = golden_lean_row();
    let body = json!({"rowId": ROW_ID, "row": row}).to_string();
    let draft: Value =
        serde_json::from_slice(&call_raw(OP_PROJECT_SUBMIT_DRAFT, 0, body.as_bytes()).unwrap())
            .unwrap();
    let body = json!({"draft": draft, "card": golden_card()}).to_string();
    let rebuilt: LeanRow =
        serde_json::from_slice(&call_raw(OP_SUBMIT_DRAFT, 0, body.as_bytes()).unwrap()).unwrap();
    assert_eq!(rebuilt.draft, row.draft);
    assert_eq!(rebuilt.schema_revision, row.schema_revision);
    assert_eq!(rebuilt.language, row.language);
    assert_eq!(rebuilt.hand_edited_keys, row.hand_edited_keys);
    assert_eq!(rebuilt.field_origins, row.field_origins);
    assert_eq!(rebuilt.media, row.media);
    assert_eq!(rebuilt.source.file_name, row.source.file_name);
    assert!(rebuilt.validation_issues.is_empty());
}

#[test]
fn project_submit_draft_refuses_a_malformed_body() {
    let missing_row = json!({"rowId": ROW_ID}).to_string();
    assert_eq!(
        call_raw(OP_PROJECT_SUBMIT_DRAFT, 0, missing_row.as_bytes()).unwrap_err()["code"],
        "CORE_DECODE"
    );
    let missing_id = json!({"row": golden_lean_row()}).to_string();
    assert_eq!(
        call_raw(OP_PROJECT_SUBMIT_DRAFT, 0, missing_id.as_bytes()).unwrap_err()["code"],
        "CORE_DECODE"
    );
}

#[test]
fn issue_manifest_is_the_native_declaration() {
    let abi = call_raw(OP_ISSUE_MANIFEST, 0, b"").expect("manifest");
    assert_eq!(
        abi,
        serde_json::to_vec(known_issue_manifest()).expect("native encodes")
    );
    let manifest: Vec<Value> = serde_json::from_slice(&abi).unwrap();
    // The ratchet: a new declared code changes this test on purpose. 19
    // validate + 6 freeze + 7 pre_dispatch + 6 submit + 9 preview (Ozon),
    // 4 metadata + 12 validate + 2 preview (WB).
    assert_eq!(manifest.len(), 65);
    assert_eq!(
        manifest
            .iter()
            .filter(|key| key["platform"] == "ozon")
            .count(),
        47
    );
    assert_eq!(
        manifest[0],
        json!({"platform": "ozon", "stage": "validate", "code": "required"})
    );
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
        "listing-core-wasm-submit-draft-abi-missing-{}.json",
        std::process::id()
    ));
    assert!(!path.exists(), "{} must not pre-exist", path.display());
    let outcome = std::panic::catch_unwind(|| assert_matches_committed_fixture(&path, "{}\n"));
    assert!(outcome.is_err(), "a missing fixture must fail");
    assert!(!path.exists(), "the comparison wrote {}", path.display());
}

#[test]
fn ozon_submit_draft_golden_matches_the_committed_fixture() {
    let row = golden_lean_row();
    let expected: Value =
        serde_json::to_value(SubmitDraft::from_row(ROW_ID.to_owned(), &row)).expect("draft");
    let fixture = json!({
        "rowId": ROW_ID,
        "row": row,
        "expected": expected,
        "manifest": known_issue_manifest().iter().filter(|key| key.platform() == listing_core::issue_keys::IssuePlatform::Ozon).collect::<Vec<_>>(),
    });
    let rendered = serde_json::to_string_pretty(&fixture).expect("fixture") + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ambient/ozon-submit-draft-golden.json");
    assert_matches_committed_fixture(&path, &rendered);
}

/// The full op 13 contract preserves every platform, stage and declaration
/// position independently of the Ozon-only SubmitDraft projection above.
#[test]
fn known_issue_manifest_golden_matches_the_committed_fixture() {
    let rendered = serde_json::to_string_pretty(known_issue_manifest()).expect("manifest") + "\n";
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ambient/known-issue-manifest-golden.json");
    assert_matches_committed_fixture(&path, &rendered);
}

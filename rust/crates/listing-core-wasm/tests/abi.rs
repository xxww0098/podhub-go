//! ABI-plumbing tests: alloc/free, schema handles, `call()`'s dispatch and
//! error contract. These call the crate's `extern "C"` exports directly as
//! ordinary Rust functions (native, no wasm runtime) — proving the encode/
//! decode/handle-table logic is correct is this suite's job; proving the
//! *compiled-to-wasm32* artifact byte-matches slice 02's native golden fixtures
//! is `web/tests/listing-core-wasm.test.ts`'s job (this crate's `[lib]`
//! comment explains the split).

use serde_json::{Value, json};

/// Copies `bytes` into a fresh `alloc`ation and returns `(ptr, len)`. Callers
/// must `free` it (or hand it to a `call`/`schema_load` that consumes it).
fn put(bytes: &[u8]) -> (*mut u8, usize) {
    let ptr = listing_core_wasm::alloc(bytes.len());
    assert!(
        !ptr.is_null() || bytes.is_empty(),
        "alloc must not fail for a small buffer"
    );
    if !bytes.is_empty() {
        // SAFETY: `ptr` was just returned by `alloc(bytes.len())`, and no one
        // else can see it yet.
        unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    }
    (ptr, bytes.len())
}

fn last_error() -> Value {
    let ptr = listing_core_wasm::last_error_ptr();
    let len = listing_core_wasm::last_error_len() as usize;
    // SAFETY: `last_error_ptr`/`last_error_len` always describe a valid
    // (possibly empty) buffer owned by this module's thread-local state.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    serde_json::from_slice(bytes).expect("last_error is always a {code, message} JSON object")
}

fn take_result() -> Value {
    let ptr = listing_core_wasm::result_ptr();
    let len = listing_core_wasm::result_len() as usize;
    // SAFETY: `result_ptr`/`result_len` always describe a valid buffer owned
    // by this module's thread-local state, valid until `drop_result`.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let value = serde_json::from_slice(bytes).expect("a successful call's result is JSON");
    listing_core_wasm::drop_result();
    value
}

fn load_schema(snapshot: &Value, search_materials: &Value) -> u32 {
    let body = json!({"snapshot": snapshot, "searchMaterials": search_materials}).to_string();
    let (ptr, len) = put(body.as_bytes());
    // SAFETY: `ptr`/`len` came straight from `put`, which used `alloc`.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, len) };
    // SAFETY: `ptr`/`len` are the exact pair `alloc` returned above; nothing
    // else has touched them since.
    unsafe { listing_core_wasm::free(ptr, len) };
    handle
}

fn call(op: u32, handle: u32, body: &Value) -> Result<Value, Value> {
    let bytes = body.to_string();
    let (ptr, len) = put(bytes.as_bytes());
    // SAFETY: `ptr`/`len` came straight from `put`.
    let status = unsafe { listing_core_wasm::call(op, handle, ptr, len) };
    // SAFETY: the exact pair `alloc` returned above.
    unsafe { listing_core_wasm::free(ptr, len) };
    if status == 0 {
        Ok(take_result())
    } else {
        Err(last_error())
    }
}

/// The smallest schema `SchemaMaterial::new` accepts: no fields, no search
/// materials. Enough to smoke-test the ABI without pulling in a full
/// category's field list.
fn minimal_snapshot() -> Value {
    json!({
        "category_key": "abi-smoke-test",
        "label": "ABI smoke test",
        "description_category_id": 1,
        "type_id": 1,
        "schema_revision": "abi-smoke-v1",
        "recipe_id": 0,
        "recipe_revision": 1,
        "catalog_schema_version": 1,
        "fields": [],
    })
}

fn minimal_card() -> Value {
    json!({
        "categoryKey": "abi-smoke-test",
        "descriptionCategoryId": 1,
        "typeId": 1,
        "language": "ru",
        "defaults": {"values": {}, "complex_values": []},
        "aiFieldPolicy": {"allowed_field_keys": [], "protected_field_keys": []},
    })
}

#[test]
fn alloc_and_free_round_trip_without_corrupting_the_allocator() {
    let (ptr, len) = put(b"hello wasm");
    assert!(!ptr.is_null());
    // SAFETY: exact pair `alloc` returned.
    unsafe { listing_core_wasm::free(ptr, len) };
    // A second, unrelated allocation must still work after the free above.
    let (ptr2, len2) = put(b"still fine");
    assert!(!ptr2.is_null());
    // SAFETY: exact pair `alloc` returned.
    unsafe { listing_core_wasm::free(ptr2, len2) };
}

#[test]
fn schema_load_returns_a_nonzero_handle_and_schema_drop_is_idempotent() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    assert_ne!(handle, 0, "a valid schema must never mint handle 0");
    listing_core_wasm::schema_drop(handle);
    // Dropping again (or a handle that never existed) must not panic.
    listing_core_wasm::schema_drop(handle);
    listing_core_wasm::schema_drop(999_999);
}

#[test]
fn schema_load_rejects_malformed_json_with_core_decode() {
    let (ptr, len) = put(b"not json");
    // SAFETY: exact pair `put` returned via `alloc`.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, len) };
    // SAFETY: exact pair `alloc` returned.
    unsafe { listing_core_wasm::free(ptr, len) };
    assert_eq!(handle, 0);
    assert_eq!(last_error()["code"], "CORE_DECODE");
}

#[test]
fn call_against_an_unknown_or_dropped_schema_handle_is_core_schema_handle() {
    let error = call(1, 424_242, &json!({})).unwrap_err();
    assert_eq!(error["code"], "CORE_SCHEMA_HANDLE");
}

#[test]
fn call_seed_row_produces_a_row_seeded_from_the_supplied_draft() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    let body = json!({
        "card": minimal_card(),
        "source": {"assetId": "", "sha256": "sha256:abi", "fileName": "abi.psd"},
        "nowMs": 1_700_000_000_000_u64,
    });
    let row = call(1, handle, &body).expect("seed_row succeeds against a minimal schema/card");
    assert_eq!(row["categoryKey"], "abi-smoke-test");
    assert_eq!(row["source"]["sha256"], "sha256:abi");
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn call_schema_revision_reads_back_the_loaded_snapshots_revision() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    let revision = call(10, handle, &json!(null))
        .expect("schemaRevision always succeeds for a resident handle");
    assert_eq!(revision, "abi-smoke-v1");
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn call_submit_draft_reconstructs_a_lean_row_from_the_cards_category_and_needs_no_schema_handle() {
    // Handle `0`, exactly like recordRender/valuesEqual: `SubmitDraft::into_row`
    // takes only the Card (see its own doc on why no `&SchemaMaterial`),
    // so op 9 must succeed with no resident schema at all.
    let draft = json!({
        "rowId": "row-abi-1",
        "schemaRevision": "abi-smoke-v1",
        "draft": {"values": {}, "complex_values": []},
        "sourceFileName": "abi.psd",
    });
    let row = call(9, 0, &json!({"draft": draft, "card": minimal_card()}))
        .expect("submitDraft needs no schema handle");
    assert_eq!(row["categoryKey"], "abi-smoke-test");
    assert_eq!(row["schemaRevision"], "abi-smoke-v1");
    assert_eq!(row["source"]["fileName"], "abi.psd");
}

#[test]
fn call_submit_draft_with_a_malformed_body_is_core_decode() {
    let error = call(9, 0, &json!({"draft": {}})).unwrap_err();
    assert_eq!(error["code"], "CORE_DECODE");
}

#[test]
fn call_an_unknown_op_number_is_core_decode() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    let error = call(999, handle, &json!({})).unwrap_err();
    assert_eq!(error["code"], "CORE_DECODE");
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn call_with_a_malformed_body_is_core_decode_not_a_panic() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    let error = call(1, handle, &json!({"nonsense": true})).unwrap_err();
    assert_eq!(error["code"], "CORE_DECODE");
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn record_render_and_values_equal_need_no_schema_handle() {
    // Handle `0` never names a resident schema (handles start at 1) — both
    // ops must still succeed, proving they never touch the schema table.
    // `WorkflowImageLifecycle` has no `rename_all` — snake_case, matching
    // `fixtures/listing/core-ops/record_render/*.input.json`.
    let hash = format!("sha256:{}", "a".repeat(64));
    let images = json!([{
        "index": 0, "file_name": "slice-0.jpg", "content_hash": hash,
        "group_name": "hero", "width": 10, "height": 10, "byte_size": 100,
        "phase": "rendered", "public_url": null, "object_key": null, "error_code": null,
    }]);
    let manifest = json!({"slices": [{
        "index": 0, "groupName": "hero", "fileName": "slice-0.jpg", "contentHash": hash,
        "width": 10, "height": 10,
    }]});
    let render = call(
        5,
        0,
        &json!({"images": images, "rendererManifest": manifest}),
    )
    .expect("recordRender needs no schema handle");
    assert!(
        render["manifestDigest"]
            .as_str()
            .unwrap()
            .starts_with("manifest:sha256:")
    );

    let equal = call(
        8,
        0,
        &json!({"editor": "decimal", "left": {"kind": "text", "value": "1.10"}, "right": {"kind": "text", "value": "1.1"}}),
    )
    .expect("valuesEqual needs no schema handle");
    assert_eq!(equal, true);
}

#[test]
fn result_slot_is_a_singleton_a_second_call_replaces_the_first() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    let equal_body = json!({"editor": "text", "left": {"kind": "text", "value": "a"}, "right": {"kind": "text", "value": "a"}});
    let not_equal_body = json!({"editor": "text", "left": {"kind": "text", "value": "a"}, "right": {"kind": "text", "value": "b"}});

    let bytes = equal_body.to_string();
    let (ptr, len) = put(bytes.as_bytes());
    // SAFETY: exact pair `put` returned via `alloc`.
    assert_eq!(unsafe { listing_core_wasm::call(8, handle, ptr, len) }, 0);
    // SAFETY: exact pair `alloc` returned.
    unsafe { listing_core_wasm::free(ptr, len) };
    // Deliberately do not drain the first result — a second `call` must still
    // overwrite the singleton slot rather than leak or panic.

    let bytes = not_equal_body.to_string();
    let (ptr, len) = put(bytes.as_bytes());
    // SAFETY: exact pair `put` returned via `alloc`.
    assert_eq!(unsafe { listing_core_wasm::call(8, handle, ptr, len) }, 0);
    // SAFETY: exact pair `alloc` returned.
    unsafe { listing_core_wasm::free(ptr, len) };

    assert_eq!(
        take_result(),
        false,
        "the singleton result slot must hold the latest call's answer"
    );
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn plan_stage_needs_no_schema_and_keeps_an_admission_refusal_on_the_batch() {
    let digest = "ab".repeat(32);
    let admitted = call(
        16,
        0,
        &json!({
            "kind": "confirm",
            "candidates": [{
                "index": 0,
                "digest": digest,
                "extension": "jpg",
                "objectKey": format!("images/teams/test-workspace/sha256/{digest}.jpg"),
                "byteLength": 4,
                "storageRevision": 1,
                "uploadTicket": "ticket",
                "accountId": "acct",
                "workspaceUuid": "test-workspace",
                "pendingConfirm": true
            }]
        }),
    )
    .expect("planStage needs no schema handle");
    assert_eq!(admitted["batch"], json!([0]));

    let after = call(
        16,
        0,
        &json!({"kind": "confirmRetry", "status": 429, "code": "user_over_budget"}),
    )
    .expect("retry class");
    assert_eq!(after["after"], "keep_batch");

    // An uncertain retry must not be re-sent as one batch: the flag travels in
    // `outcomeUnknown` and only lands in the op's field if the struct variant
    // carries its own `rename_all`. Silently defaulting it to `false` here
    // would answer `keep_batch` to a caller whose outcome is unknown.
    let uncertain = call(
        16,
        0,
        &json!({
            "kind": "confirmRetry",
            "status": 429,
            "code": "user_over_budget",
            "outcomeUnknown": true,
        }),
    )
    .expect("retry class");
    assert_eq!(uncertain["after"], "split_ones");
}

/// Both of these ops need `Ctx::card`, and the wasm boundary decodes `card` as
/// `Option` (the edit-time card-less path is real, see `ops::Ctx`). A missing
/// Card must therefore come back as a diagnosable `CORE_REFUSED`, not an
/// `.expect()` abort — a trap kills the whole instance and every resident
/// schema handle with it (`lib.rs`'s "Traps" section).
#[test]
fn a_card_less_recognition_or_candidate_call_is_core_refused_not_a_trap() {
    let handle = load_schema(&minimal_snapshot(), &json!([]));
    let row = call(
        1,
        handle,
        &json!({
            "card": minimal_card(),
            "source": {"assetId": "", "sha256": "sha256:abi", "fileName": "abi.psd"},
            "nowMs": 1_700_000_000_000_u64,
        }),
    )
    .expect("seed_row succeeds");

    let recognition = call(
        3,
        handle,
        &json!({
            "nowMs": 1_700_000_000_001_u64,
            "row": row,
            "ru": "Описание",
            "description": "Описание товара",
            "tags": [],
            "model": "qwen-vl",
            "costMicrofen": 1_200,
            "requestId": "req-abi-1",
            "promptSha256": "sha256:prompt-abi",
        }),
    )
    .unwrap_err();
    assert_eq!(recognition["code"], "CORE_REFUSED");
    assert!(
        recognition["message"]
            .as_str()
            .unwrap_or_default()
            .contains("card"),
        "the refusal must name the missing card: {recognition}"
    );

    let candidates = call(
        4,
        handle,
        &json!({
            "nowMs": 1_700_000_000_002_u64,
            "row": row,
            "decisions": [{"index": 0, "accept": true}],
        }),
    )
    .unwrap_err();
    assert_eq!(candidates["code"], "CORE_REFUSED");
    assert!(
        candidates["message"]
            .as_str()
            .unwrap_or_default()
            .contains("card"),
        "the refusal must name the missing card: {candidates}"
    );

    // The instance is still usable: had either op trapped, this handle would
    // be gone and the allocator possibly corrupt.
    assert_eq!(
        call(10, handle, &json!(null)).expect("schema still resident"),
        "abi-smoke-v1"
    );
    listing_core_wasm::schema_drop(handle);
}

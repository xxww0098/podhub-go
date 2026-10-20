//! Native ABI bytes the Go wazero host must reproduce.
//!
//! `ORACLE_WRITE=1` replaces the committed file. A normal run only reads it.
//! The wasm32 artifact is checked from Go against the same bytes, so native
//! Rust, the compiled module, and the host are one comparison.

use std::path::PathBuf;

use listing_core::compose::compose_tests::{golden_card, golden_row};
use listing_core::ops::LeanRow;
use serde_json::json;

const ROW_ID: &str = "draft-ozon-golden";

fn oracle_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../internal/listing/core/testdata/freeze_oracle.json")
}

fn call(op: u32, handle: u32, body: &[u8]) -> Result<Vec<u8>, Vec<u8>> {
    let ptr = listing_core_wasm::alloc(body.len());
    // SAFETY: `ptr` was just returned by `alloc(body.len())`.
    unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), ptr, body.len()) };
    // SAFETY: `ptr`/`len` describe the buffer written above.
    let status = unsafe { listing_core_wasm::call(op, handle, ptr, body.len()) };
    // SAFETY: the exact pair `alloc` returned.
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
    // SAFETY: the slot stays valid until drop_result.
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    listing_core_wasm::drop_result();
    if status == 0 { Ok(bytes) } else { Err(bytes) }
}

fn schema_load(body: &[u8]) -> u32 {
    let ptr = listing_core_wasm::alloc(body.len());
    // SAFETY: fresh allocation of exactly `body.len()` bytes.
    unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), ptr, body.len()) };
    // SAFETY: initialised buffer from `alloc`.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, body.len()) };
    // SAFETY: the exact pair `alloc` returned.
    unsafe { listing_core_wasm::free(ptr, body.len()) };
    handle
}

fn case(name: &str, schema: &[u8], op: u32, body: &[u8]) -> serde_json::Value {
    let handle = schema_load(schema);
    assert_ne!(handle, 0, "{name}");
    let result = call(op, handle, body).unwrap_or_else(|error| panic!("{name}: {error:?}"));
    listing_core_wasm::schema_drop(handle);
    json!({
        "name": name,
        "schema": String::from_utf8(schema.to_vec()).unwrap(),
        "op": op,
        "body": String::from_utf8(body.to_vec()).unwrap(),
        "result": String::from_utf8(result).unwrap(),
    })
}

fn rendered() -> String {
    let (row, snapshot) = LeanRow::from_row(golden_row());
    let schema = serde_json::to_vec(&json!({"snapshot": snapshot, "searchMaterials": []})).unwrap();
    let row_value = serde_json::to_value(&row).unwrap();
    let card = serde_json::to_value(golden_card()).unwrap();
    let freeze = serde_json::to_vec(&json!({"card": card, "row": row_value, "rowId": ROW_ID})).unwrap();
    let mut nameless = row_value.clone();
    nameless["draft"]["values"]
        .as_object_mut()
        .unwrap()
        .remove("name");
    let refused = serde_json::to_vec(&json!({"card": card, "row": nameless, "rowId": ROW_ID})).unwrap();
    let bad_id = serde_json::to_vec(&json!({"card": card, "row": row_value, "rowId": " "})).unwrap();
    let doc = json!({
        "cases": [
            case("golden-freeze", &schema, 11, &freeze),
            case("missing-name", &schema, 11, &refused),
            case("blank-row-id", &schema, 11, &bad_id),
        ]
    });
    serde_json::to_string_pretty(&doc).unwrap() + "\n"
}

#[test]
fn native_freeze_abi_matches_the_committed_oracle() {
    let path = oracle_path();
    let rendered = rendered();
    if std::env::var("ORACLE_WRITE").ok().as_deref() == Some("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!("{} must exist (ORACLE_WRITE=1 to create it): {error}", path.display())
    });
    assert_eq!(committed, rendered);
}

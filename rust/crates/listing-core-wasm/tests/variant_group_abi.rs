//! Op 18, `validateVariantGroup`: the browser half of the Cloud/browser
//! parity contract.
//!
//! `fixtures/listing/variant-group-parity.json` is the same file Cloud's
//! `schema_builder` test reads, and it pins the expected `problems` list for
//! one recorded input. Both halves compare against that one list, so a
//! divergence between the browser's rules and Cloud's fails here rather than
//! in front of an operator. No live Seller is involved.
//!
//! `call` repeats `abi.rs`'s helpers: each `tests/*.rs` is its own crate, and
//! a shared `tests/common` module is not justified yet.

use serde_json::{Value, json};

const OP_VALIDATE_VARIANT_GROUP: u32 = 18;
const FIXTURE: &str = include_str!("../../../../fixtures/listing/variant-group-parity.json");

fn call(op: u32, handle: u32, body: &Value) -> Value {
    let bytes = body.to_string();
    let ptr = listing_core_wasm::alloc(bytes.len());
    // SAFETY: `ptr` was just returned by `alloc(bytes.len())`; no one else
    // can see it yet.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    // SAFETY: `ptr`/`len` describe the initialised buffer written above.
    let status = unsafe { listing_core_wasm::call(op, handle, ptr, bytes.len()) };
    // SAFETY: the exact pair `alloc` returned above.
    unsafe { listing_core_wasm::free(ptr, bytes.len()) };
    assert_eq!(status, 0, "op 18 must not fail for the parity fixture");
    let (ptr, len) = (
        listing_core_wasm::result_ptr(),
        listing_core_wasm::result_len() as usize,
    );
    // SAFETY: result ptr+len always describe a buffer owned by this module's
    // thread-local state, valid until the next call.
    let value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) })
        .expect("a successful call's result is JSON");
    listing_core_wasm::drop_result();
    value
}

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the parity fixture is valid JSON")
}

fn input(fixture: &Value) -> Value {
    json!({ "fields": fixture["fields"], "group": fixture["group"] })
}

/// Loads the smallest schema `SchemaMaterial::new` accepts, so the op is seen
/// to ignore a live handle as well as tolerate a zero one.
fn load_smoke_schema() -> u32 {
    let body = json!({
        "snapshot": {
            "category_key": "workbench:17028964:94897",
            "label": "Ozon 17028964 / 94897",
            "description_category_id": 17_028_964,
            "type_id": 94_897,
            "schema_revision": "fixture",
            "recipe_id": 0,
            "recipe_revision": 0,
            "catalog_schema_version": 0,
            "fields": [],
        },
        "searchMaterials": [],
    })
    .to_string();
    let ptr = listing_core_wasm::alloc(body.len());
    // SAFETY: `ptr` was just returned by `alloc(body.len())`.
    unsafe { std::ptr::copy_nonoverlapping(body.as_ptr(), ptr, body.len()) };
    // SAFETY: `ptr`/`len` describe the initialised buffer written above.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, body.len()) };
    // SAFETY: the exact pair `alloc` returned above.
    unsafe { listing_core_wasm::free(ptr, body.len()) };
    assert_ne!(handle, 0, "the smoke schema must load");
    handle
}

#[test]
fn wasm_and_cloud_agree_on_the_variant_group_fixture() {
    let fixture = fixture();
    let expected = fixture["problems"].clone();
    let handle = load_smoke_schema();
    assert_eq!(
        call(OP_VALIDATE_VARIANT_GROUP, handle, &input(&fixture)),
        expected
    );
    listing_core_wasm::schema_drop(handle);

    // And without any resident schema at all: the rule is about the category
    // material in the body, so a browser that never loaded a Card schema can
    // still ask — and gets the identical answer.
    assert_eq!(
        call(OP_VALIDATE_VARIANT_GROUP, 0, &input(&fixture)),
        expected
    );
}

/// The problem list is the *result*, not an error: a refused grouping never
/// sets `last_error`, so a caller cannot mistake "this grouping is invalid"
/// for "this call failed".
#[test]
fn a_refused_grouping_is_a_result_not_an_error() {
    let fixture = fixture();
    let _ = call(OP_VALIDATE_VARIANT_GROUP, 0, &input(&fixture));
    assert_eq!(listing_core_wasm::last_error_len(), 0);
}

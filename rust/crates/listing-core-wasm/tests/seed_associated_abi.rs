//! Op 19, `seedAssociatedRow`: one member row of a same-design association.
//!
//! The host sends the Workspace, supplier database, variant group and the
//! source digest; the answer carries the stamped row and the two values the
//! host stores beside it. A category with no plain 9048 is refused.
//!
//! `call` repeats `abi.rs`'s helpers: each `tests/*.rs` is its own crate.

use serde_json::{Value, json};

const OP_SEED_ASSOCIATED_ROW: u32 = 19;
const WALL_ART: &str = include_str!("fixtures/ambient/decorative-wall-art-schema.json");

fn put(bytes: &[u8]) -> *mut u8 {
    let ptr = listing_core_wasm::alloc(bytes.len());
    // SAFETY: `ptr` was just returned by `alloc(bytes.len())`; no one else can see it.
    unsafe { std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len()) };
    ptr
}

fn take_result() -> Value {
    let (ptr, len) = (
        listing_core_wasm::result_ptr(),
        listing_core_wasm::result_len() as usize,
    );
    // SAFETY: result ptr+len describe a buffer owned by this module, valid until `drop_result`.
    let value = serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) })
        .expect("a successful call's result is JSON");
    listing_core_wasm::drop_result();
    value
}

fn last_error() -> Value {
    let (ptr, len) = (
        listing_core_wasm::last_error_ptr(),
        listing_core_wasm::last_error_len() as usize,
    );
    // SAFETY: last_error ptr+len always describe a valid, possibly empty buffer.
    serde_json::from_slice(unsafe { std::slice::from_raw_parts(ptr, len) }).expect("error JSON")
}

fn model_field(key: &str, attribute_id: i64, complex_id: Option<i64>) -> Value {
    json!({
        "key": key, "label": key, "group": "基础", "editor": "text", "required": false,
        "constraints": {"collection": false, "max_value_count": null, "dictionary_id": null},
        "attribute_id": attribute_id.to_string(), "complex_id": complex_id.map(|id| id.to_string()), "description": "",
        "raw_type": null, "read_only": false, "complex_group_collection": false,
        "options": [], "options_truncated": false, "aspect": false
    })
}

fn load(with_model: Option<Option<i64>>) -> u32 {
    let mut snapshot: Value = serde_json::from_str(WALL_ART).expect("fixture JSON");
    if let Some(complex_id) = with_model {
        let fields = snapshot["fields"].as_array_mut().expect("fields");
        fields.push(model_field("attribute_9024", 9024, None));
        fields.push(model_field("attribute_9048", 9048, complex_id));
    }
    let body = json!({"snapshot": snapshot, "searchMaterials": []}).to_string();
    let ptr = put(body.as_bytes());
    // SAFETY: the pair `put` returned.
    let handle = unsafe { listing_core_wasm::schema_load(ptr, body.len()) };
    // SAFETY: the same pair, untouched since.
    unsafe { listing_core_wasm::free(ptr, body.len()) };
    assert_ne!(handle, 0, "schema must load");
    handle
}

fn call(handle: u32, body: &Value) -> Result<Value, Value> {
    let bytes = body.to_string();
    let ptr = put(bytes.as_bytes());
    // SAFETY: the pair `put` returned.
    let status = unsafe { listing_core_wasm::call(OP_SEED_ASSOCIATED_ROW, handle, ptr, bytes.len()) };
    // SAFETY: the same pair, untouched since.
    unsafe { listing_core_wasm::free(ptr, bytes.len()) };
    if status == 0 { Ok(take_result()) } else { Err(last_error()) }
}

fn body(row_id: &str, sha: &str) -> Value {
    json!({
        "card": {
            "categoryKey": "decorative-wall-art-40x50",
            "descriptionCategoryId": 17_027_906,
            "typeId": 91_976,
            "language": "default",
            "defaults": {"values": {}, "complex_values": []},
            "aiFieldPolicy": {"allowed_field_keys": [], "protected_field_keys": []},
        },
        "source": {"assetId": "", "sha256": sha, "fileName": "a.psd"},
        "nowMs": 1,
        "rowId": row_id,
        "orgId": 7,
        "supplierSourceId": "db-1",
        "variantGroup": "G9",
    })
}

fn text<'a>(row: &'a Value, key: &str) -> &'a str {
    row["draft"]["values"][key]["value"]
        .as_str()
        .unwrap_or_else(|| panic!("draft value {key} missing in {}", row["draft"]["values"]))
}

#[test]
fn members_of_one_design_share_model_and_association_with_distinct_offers() {
    let handle = load(Some(None));
    let sha = "a".repeat(64);
    let first = call(handle, &body("row-1", &sha)).expect("first member");
    let second = call(handle, &body("row-2", &sha)).expect("second member");
    assert_eq!(first["associationId"], second["associationId"]);
    assert_eq!(first["modelValue"], second["modelValue"]);
    let model = first["modelValue"].as_str().expect("model");
    assert!(model.starts_with("PHM-"), "{model}");
    assert_eq!(text(&first["row"], "offer_id"), "PH-row-1");
    assert_eq!(text(&second["row"], "offer_id"), "PH-row-2");
    assert_eq!(text(&first["row"], "attribute_9024"), "PH-row-1");
    assert_eq!(text(&first["row"], "attribute_9048"), model);

    let other = call(handle, &body("row-3", &"b".repeat(64))).expect("other design");
    assert_ne!(other["modelValue"], first["modelValue"]);
    assert_ne!(other["associationId"], first["associationId"]);
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn a_category_without_a_plain_model_field_is_refused() {
    let sha = "a".repeat(64);
    for model in [None, Some(Some(7))] {
        let handle = load(model);
        let error = call(handle, &body("row-1", &sha)).expect_err("refused");
        assert_eq!(error["code"], "CORE_REFUSED");
        assert!(error["message"].as_str().unwrap().contains("9048"), "{error}");
        listing_core_wasm::schema_drop(handle);
    }
}

#[test]
fn a_digest_that_is_not_sha256_is_refused() {
    let handle = load(Some(None));
    let error = call(handle, &body("row-1", "a-file-name.psd")).expect_err("refused");
    assert_eq!(error["code"], "CORE_REFUSED");
    listing_core_wasm::schema_drop(handle);
}

use super::fixtures::*;
use serde_json::{Value, json};

#[test]
fn wb_preview_reuses_one_material_and_matches_native_bytes() {
    let m = material();
    let handle = load_wb(&m);
    for vendor in ["A", "界", "B"] {
        let mut c = config();
        c.variants[0].vendor_code = vendor.into();
        let bytes = call(14, handle, &json!({"config":c})).unwrap();
        assert_eq!(
            bytes,
            serde_json::to_vec(&listing_core::wb::build_preview(&m, &c)).unwrap()
        );
        let preview: listing_core::wb::Preview = serde_json::from_slice(&bytes).unwrap();
        assert!(preview.issues.is_empty());
        assert_eq!(
            serde_json::from_slice::<Value>(&preview.upload_bytes.unwrap()).unwrap(),
            json!([{"subjectID":100,"variants":[{"vendorCode":vendor,"characteristics":[{"id":7,"value":["blue"]}]}]}])
        );
    }
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn wb_abi_preserves_validation_stage_scope_and_clear_required_refusal() {
    let m = material();
    let handle = load_wb(&m);
    let mut c = config();
    c.variants[0].cleared.insert(7);
    let bytes = call(14, handle, &json!({"config":c})).unwrap();
    assert_eq!(
        bytes,
        serde_json::to_vec(&listing_core::wb::build_preview(&m, &c)).unwrap()
    );
    let preview: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        preview["issues"][0],
        json!({"key":{"platform":"wb","stage":"validate","code":"required"},"field":"characteristic","characteristicId":7,"variantIndex":0,"scope":"variant"})
    );
    assert!(preview["group"].is_null());
    assert!(preview["uploadBytes"].is_null());
    c.subject_id = 101;
    let mismatch: Value =
        serde_json::from_slice(&call(14, handle, &json!({"config":c})).unwrap()).unwrap();
    assert_eq!(mismatch["issues"][0]["key"]["code"], "coordinate_mismatch");
    listing_core_wasm::schema_drop(handle);
}

#[test]
fn wb_preview_bad_input_and_full_manifest_are_explicit() {
    let handle = load_wb(&material());
    assert_eq!(
        call(14, handle, &json!({})).unwrap_err()["code"],
        "CORE_DECODE"
    );
    let mut c = serde_json::to_value(config()).unwrap();
    c["variants"][0]["characteristics"] = json!({"7":"scalar"});
    assert_eq!(
        call(14, handle, &json!({"config":c})).unwrap_err()["code"],
        "CORE_DECODE"
    );
    let bytes = call(13, 0, &json!({})).unwrap();
    assert_eq!(
        bytes,
        serde_json::to_vec(listing_core::issue_keys::known_issue_manifest()).unwrap()
    );
    let manifest: Vec<Value> = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        manifest
            .iter()
            .filter(|key| key["platform"] == "wb")
            .count(),
        18
    );
    // The ratchet: adding a declared Ozon code changes this test on purpose.
    assert_eq!(
        manifest
            .iter()
            .filter(|key| key["platform"] == "ozon")
            .count(),
        47
    );
    listing_core_wasm::schema_drop(handle);
}

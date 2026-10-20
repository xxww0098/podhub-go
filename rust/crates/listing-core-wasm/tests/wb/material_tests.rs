use super::fixtures::*;
use serde_json::{Value, json};

#[test]
fn resident_material_handles_reject_cross_platform_calls_and_drop() {
    let wb = load_wb(&material());
    let ozon = load(&ozon()).unwrap();
    assert_ne!(wb, ozon);
    assert_eq!(
        call(10, wb, &json!({})).unwrap_err()["code"],
        "CORE_SCHEMA_HANDLE"
    );
    assert_eq!(
        call(14, ozon, &json!({"config":config()})).unwrap_err()["code"],
        "CORE_SCHEMA_HANDLE"
    );
    assert_eq!(
        call(15, ozon, &json!({})).unwrap_err()["code"],
        "CORE_SCHEMA_HANDLE"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&call(10, ozon, &json!({})).unwrap()).unwrap(),
        json!("ozon")
    );
    listing_core_wasm::schema_drop(wb);
    assert_eq!(
        call(14, wb, &json!({"config":config()})).unwrap_err()["code"],
        "CORE_SCHEMA_HANDLE"
    );
    listing_core_wasm::schema_drop(wb);
    listing_core_wasm::schema_drop(ozon);
}

#[test]
fn wb_load_rejects_unknown_platform_and_scalar_text_without_ozon_fallback() {
    let mut wrong = ozon();
    wrong["platform"] = json!("future");
    assert_eq!(load(&wrong).unwrap_err()["code"], "CORE_DECODE");
    let mut wrong = json!({"platform":"wb","material":material()});
    wrong["material"]["defaults"]["values"]["7"] = json!("scalar");
    assert_eq!(load(&wrong).unwrap_err()["code"], "CORE_DECODE");
    let mut wrong = ozon();
    wrong["platform"] = json!("wb");
    assert_eq!(load(&wrong).unwrap_err()["code"], "CORE_DECODE");
}

#[test]
fn wb_metadata_op_is_byte_identical_for_missing_and_stale_material() {
    for (catalog, defaults) in [(true, false), (true, true), (false, false)] {
        let mut m = material();
        m.catalog.as_mut().unwrap().usable = false;
        if defaults {
            m.defaults.as_mut().unwrap().validated_catalog_digest = "old".into();
        }
        if !catalog {
            m.catalog = None;
        }
        let handle = load_wb(&m);
        assert_eq!(
            call(15, handle, &json!({})).unwrap(),
            serde_json::to_vec(&listing_core::wb::metadata_issues(&m)).unwrap()
        );
        listing_core_wasm::schema_drop(handle);
    }
}

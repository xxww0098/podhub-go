use super::tests::{config, material, variant};
use super::*;
use serde_json::json;

#[test]
fn wb_build_defaults_manual_clear_and_required_follow_ownership_order() {
    let m = material();
    let mut c = config();
    c.variants[0]
        .characteristics
        .insert(7, FieldValue::Text(vec!["manual".into()]));
    let built = build_preview(&m, &c);
    assert!(built.issues.is_empty());
    assert_eq!(
        serde_json::to_value(&built.group.unwrap()).unwrap()["variants"][0]["characteristics"][0]["value"],
        json!(["manual"])
    );
    c.variants[0].cleared.insert(7);
    let built = build_preview(&m, &c);
    assert!(built.group.is_none());
    assert!(built.upload_bytes.is_none());
    assert_eq!(built.issues[0].key.code(), "required");
    assert_eq!(built.issues[0].variant_index, Some(0));
    c.variants[0].cleared.insert(999);
    assert!(
        build_preview(&m, &c)
            .issues
            .iter()
            .any(|i| i.characteristic_id == Some(999) && i.key.code() == "unknown_characteristic")
    );
}

#[test]
fn wb_preview_preserves_every_upload_field_and_variant_order() {
    let mut c = config();
    let v = &mut c.variants[0];
    v.title = Some("Title".into());
    v.brand = Some("Brand".into());
    v.description = Some("Description".into());
    v.kiz_marked = Some(true);
    v.wholesale = Some(protocol::Wholesale {
        enabled: Some(true),
        quantum: Some(3),
    });
    v.dimensions = Some(protocol::Dimensions {
        length: Some(10),
        width: Some(20),
        height: Some(30),
        weight_brutto: Some(1.5),
    });
    v.sizes = vec![protocol::CardSize {
        tech_size: Some("XL".into()),
        wb_size: Some("50".into()),
        price: Some(1234),
        skus: vec!["barcode".into()],
    }];
    v.documents = Some(protocol::CardDocuments {
        exclude_documents: Some(false),
        items: vec![protocol::CardDocument {
            document_type: Some(2),
            number: Some("n".into()),
            product_number: Some("p".into()),
            trade_name: Some("t".into()),
            applicant: Some("a".into()),
            start_date: Some("start".into()),
            end_date: Some("end".into()),
            is_endless: Some(false),
        }],
    });
    v.characteristics.insert(8, FieldValue::Number(4.5));
    c.variants.push(variant("B"));
    let preview = build_preview(&material(), &c);
    assert!(preview.issues.is_empty(), "{:?}", preview.issues);
    let bytes = preview.upload_bytes.unwrap();
    let expected = json!([{"subjectID":100,"variants":[{
        "vendorCode":"A","title":"Title","brand":"Brand","description":"Description","kizMarked":true,
        "wholesale":{"enabled":true,"quantum":3},"dimensions":{"length":10,"width":20,"height":30,"weightBrutto":1.5},
        "sizes":[{"techSize":"XL","wbSize":"50","price":1234,"skus":["barcode"]}],
        "documents":{"excludeDocuments":false,"items":[{"type":2,"number":"n","productNumber":"p","tradeName":"t","applicant":"a","startDate":"start","endDate":"end","isEndless":false}]},
        "characteristics":[{"id":7,"value":["default"]},{"id":8,"value":4.5}]
    },{"vendorCode":"B","characteristics":[{"id":7,"value":["default"]}]}]}]);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
        expected
    );
    assert_eq!(bytes, encode_upload(&[preview.group.unwrap()]).unwrap());
}

#[test]
fn wb_preview_coordinates_and_named_fields_have_precise_issues() {
    let m = material();
    let mut c = config();
    c.subject_id = 101;
    c.language = Language::En;
    let issues = build_preview(&m, &c).issues;
    assert_eq!(
        issues.iter().map(|i| i.field).collect::<Vec<_>>(),
        [IssueField::Subject, IssueField::Language]
    );
    for (vendor, title, code, field) in [
        (
            " ".into(),
            None,
            "vendor_code_required",
            IssueField::VendorCode,
        ),
        (
            "界".repeat(73),
            None,
            "vendor_code_too_long",
            IssueField::VendorCode,
        ),
        (
            "A".into(),
            Some("🦀".repeat(61)),
            "title_too_long",
            IssueField::Title,
        ),
    ] {
        let mut c = config();
        c.variants[0].vendor_code = vendor;
        c.variants[0].title = title;
        let issue = build_preview(&m, &c).issues.remove(0);
        assert_eq!(issue.key.code(), code);
        assert_eq!(issue.field, field);
        assert_eq!(issue.variant_index, Some(0));
    }
    for count in [0, 31] {
        let mut c = config();
        c.variants = vec![variant("A"); count];
        assert_eq!(build_preview(&m, &c).issues[0].key.code(), "variant_count");
    }
}

#[test]
fn wb_preview_rejects_nonfinite_dimensions_and_exact_oversize_body() {
    let mut c = config();
    c.variants[0].dimensions = Some(protocol::Dimensions {
        length: None,
        width: None,
        height: None,
        weight_brutto: Some(f64::NAN),
    });
    let preview = build_preview(&material(), &c);
    assert!(preview.upload_bytes.is_none());
    assert!(
        preview
            .issues
            .iter()
            .all(|issue| issue.key.code() == "invalid_dimensions")
    );
    let mut c = config();
    c.variants[0].description = Some("x".repeat(MAX_UPLOAD_BYTES));
    let preview = build_preview(&material(), &c);
    assert_eq!(preview.issues[0].key.code(), "upload_too_large");
    assert_eq!(
        preview.issues[0].key.stage(),
        crate::issue_keys::IssueStage::Preview
    );
}

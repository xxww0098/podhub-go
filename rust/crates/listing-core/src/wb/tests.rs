use super::*;
use crate::issue_keys::{IssuePlatform, IssueStage, KnownIssueKey, WbMetadataCode};

pub(super) fn field(id: i64, kind: u32, required: bool) -> Characteristic {
    Characteristic {
        id,
        name: format!("field-{id}"),
        required,
        value_kind: kind,
        max_count: 1,
        unit_name: None,
        popular: false,
        has_filter: false,
        is_variable: true,
        required_for_create: None,
        named_field: None,
    }
}

pub(super) fn material() -> Material {
    Material {
        subject_id: 100,
        language: Language::Ru,
        catalog: Some(Catalog {
            fields: vec![field(7, 1, true), field(8, 4, false)],
            content_digest: "sha256:catalog".into(),
            usable: true,
        }),
        defaults: Some(Defaults {
            values: Fields::from([(7, FieldValue::Text(vec!["default".into()]))]),
            revision: 1,
            validated_catalog_digest: "sha256:catalog".into(),
        }),
    }
}

pub(super) fn variant(code: &str) -> VariantConfig {
    VariantConfig {
        vendor_code: code.into(),
        title: None,
        brand: None,
        description: None,
        kiz_marked: None,
        wholesale: None,
        dimensions: None,
        sizes: vec![],
        documents: None,
        characteristics: Fields::new(),
        cleared: Default::default(),
    }
}

pub(super) fn config() -> WbProductConfig {
    WbProductConfig {
        subject_id: 100,
        language: Language::Ru,
        variants: vec![variant("A")],
    }
}

#[test]
fn wb_metadata_keeps_missing_expired_and_default_stamp_evidence_distinct() {
    let mut m = material();
    assert!(metadata_issues(&m).is_empty());
    m.catalog.as_mut().unwrap().usable = false;
    m.defaults.as_mut().unwrap().validated_catalog_digest = "old".into();
    assert_eq!(
        metadata_issues(&m)
            .iter()
            .map(|i| i.key)
            .collect::<Vec<_>>(),
        [
            WbMetadataCode::CatalogStale.key(),
            WbMetadataCode::DefaultsStale.key()
        ]
    );
    m.catalog = None;
    assert_eq!(
        metadata_issues(&m)[0].key,
        WbMetadataCode::CatalogUnavailable.key()
    );
    assert!(build_preview(&m, &config()).group.is_none());
}

#[test]
fn wb_material_rejects_duplicate_invalid_ids_and_bad_defaults() {
    let mut m = material();
    m.catalog.as_mut().unwrap().fields.push(field(7, 1, false));
    assert!(
        metadata_issues(&m)
            .iter()
            .any(|i| i.key == WbMetadataCode::CatalogInvalid.key())
    );
    let mut m = material();
    m.subject_id = 0;
    assert!(
        metadata_issues(&m)
            .iter()
            .any(|i| i.key == WbMetadataCode::CatalogInvalid.key())
    );
    let mut m = material();
    m.defaults
        .as_mut()
        .unwrap()
        .values
        .insert(8, FieldValue::Number(f64::INFINITY));
    let issue = metadata_issues(&m).remove(0);
    assert_eq!(issue.scope, IssueScope::Material);
    assert_eq!(issue.characteristic_id, Some(8));
    assert_eq!(issue.key.code(), "nonfinite_number");
}

#[test]
fn wb_manifest_is_closed_and_platform_stage_qualified() {
    let groups = [
        (
            IssueStage::Metadata,
            vec![
                "catalog_unavailable",
                "catalog_stale",
                "defaults_stale",
                "catalog_invalid",
            ],
        ),
        (
            IssueStage::Validate,
            vec![
                "unknown_characteristic",
                "blank_text",
                "max_count",
                "nonfinite_number",
                "value_type",
                "required",
                "coordinate_mismatch",
                "invalid_dimensions",
                "variant_count",
                "vendor_code_required",
                "vendor_code_too_long",
                "title_too_long",
            ],
        ),
        (
            IssueStage::Preview,
            vec!["upload_too_large", "encoding_failed"],
        ),
    ];
    for (stage, codes) in groups {
        assert_eq!(
            KnownIssueKey::ALL
                .iter()
                .filter(|k| k.platform() == IssuePlatform::Wb && k.stage() == stage)
                .map(|k| k.code())
                .collect::<Vec<_>>(),
            codes
        );
    }
    assert_ne!(
        KnownIssueKey::classify(IssuePlatform::Ozon, IssueStage::Validate, "required"),
        KnownIssueKey::classify(IssuePlatform::Wb, IssueStage::Validate, "required")
    );
    assert!(
        KnownIssueKey::classify(IssuePlatform::Ozon, IssueStage::Metadata, "catalog_stale")
            .is_none()
    );
}

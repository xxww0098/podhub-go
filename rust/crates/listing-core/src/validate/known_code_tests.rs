//! Every issue `normalize_and_validate` produces is a declared validate-stage
//! key, and a stored issue with an undeclared code still round-trips intact.

use std::collections::BTreeMap;

use super::*;
use crate::categories::decorative_wall_art;
use crate::issue_keys::{IssueStage, KnownIssueKey, OzonValidateCode};

fn draft(values: BTreeMap<String, String>) -> ListingDraftRecord {
    let schema = decorative_wall_art::local_schema_snapshot();
    ListingDraftRecord {
        draft_id: "draft-known-codes".to_owned(),
        draft_revision: 1,
        category_key: decorative_wall_art::CATEGORY_KEY.to_owned(),
        description_category_id: 17027906,
        type_id: 91976,
        schema_revision: schema.schema_revision.clone(),
        recipe_id: schema.recipe_id,
        recipe_revision: schema.recipe_revision,
        catalog_schema_version: schema.catalog_schema_version,
        schema_snapshot: std::sync::Arc::new(schema),
        field_values: values,
        raw_values: Default::default(),
        list_elements: Default::default(),
        complex_values: Default::default(),
        field_origins: Default::default(),
        lifecycle_state: ListingLifecycleState::Draft,
        normalized_snapshot: None,
        execution_plan: None,
        updated_at_ms: 1,
        envelope_version: crate::records::CURRENT_ENVELOPE_VERSION,
        unusable: false,
        preview_required: false,
        decode_failures: Vec::new(),
    }
}

fn rejected(values: &[(&str, &str)]) -> Vec<FieldIssue> {
    let values = values
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect();
    match normalize_and_validate(&draft(values)) {
        ValidationOutcome::Rejected { issues } => issues,
        ValidationOutcome::Accepted { .. } => panic!("expected a rejection"),
    }
}

/// A Draft that breaks several fixed rules at once: every resulting code is
/// a validate key, none of them classifies under the freeze stage, and the
/// literal strings are the historical ones (no wire drift).
#[test]
fn validate_issues_are_declared_validate_keys_only() {
    let name = "画".repeat(PRODUCT_NAME_MAX_CHARS + 1);
    let issues = rejected(&[
        (
            "offer_id",
            "ТОВАР 1 with spaces and a very long tail over fifty chars",
        ),
        ("name", &name),
        ("price", "-1"),
        ("barcode", "123"),
        ("width", "0"),
    ]);
    assert!(!issues.is_empty());
    for issue in &issues {
        let key = issue
            .known_key(IssueStage::Validate)
            .unwrap_or_else(|| panic!("{} is not a declared validate code", issue.code));
        assert_eq!(key.stage(), IssueStage::Validate);
        assert_eq!(issue.known_key(IssueStage::Freeze), None, "{}", issue.code);
    }
    let codes: Vec<&str> = issues.iter().map(|issue| issue.code.as_str()).collect();
    for expected in [
        OzonValidateCode::OfferIdTooLong,
        OzonValidateCode::OfferIdCharset,
        OzonValidateCode::NameContainsHan,
        OzonValidateCode::NameTooLong,
        OzonValidateCode::InvalidPrice,
        OzonValidateCode::InvalidPositiveInteger,
    ] {
        assert!(
            codes.contains(&expected.as_str()),
            "{expected:?} missing from {codes:?}"
        );
    }
}

/// The byte shape of a validate issue is unchanged by the typed producer:
/// `code` is the same plain string field it always was.
#[test]
fn typed_producer_keeps_the_historical_json_literal() {
    let issues = rejected(&[("price", "0")]);
    let price = issues
        .iter()
        .find(|issue| issue.field_key == "price")
        .expect("price issue");
    let value = serde_json::to_value(price).expect("serialize");
    assert_eq!(value["code"], "invalid_price");
    assert_eq!(value["severity"], "blocking");
    assert_eq!(
        value["address"],
        serde_json::json!({"kind": "plain", "field_key": "price"})
    );
}

/// A persisted issue whose code this build does not declare (a newer or an
/// older writer) decodes, keeps its code and text byte-for-byte, and is
/// merely unclassified — it neither fails the row nor becomes a known key.
#[test]
fn an_undeclared_stored_code_survives_and_stays_unclassified() {
    let stored = serde_json::json!({
        "field_key": "attribute_4180",
        "code": "future_rule_v9",
        "parameters": {"limit": {"kind": "integer", "value": 3}},
        "severity": "blocking",
        "address": {"kind": "plain", "field_key": "attribute_4180"},
        "message": "未来规则",
        "remediation": null
    });
    let issue: FieldIssue = serde_json::from_value(stored.clone()).expect("decodes");
    assert_eq!(issue.code, "future_rule_v9");
    assert_eq!(issue.known_key(IssueStage::Validate), None);
    assert_eq!(issue.known_key(IssueStage::Freeze), None);
    assert_eq!(serde_json::to_value(&issue).expect("serialize"), stored);

    let row = serde_json::json!({
        "categoryKey": decorative_wall_art::CATEGORY_KEY,
        "descriptionCategoryId": 17027906,
        "typeId": 91976,
        "schemaRevision": "rev-known-codes",
        "validationIssues": [stored],
    });
    let lean: crate::ops::LeanRow = serde_json::from_value(row).expect("row decodes");
    assert_eq!(lean.validation_issues.len(), 1);
    assert_eq!(lean.validation_issues[0].code, "future_rule_v9");
}

/// Every declared validate code classifies back to itself; no two share a
/// string.
#[test]
fn every_validate_code_classifies_to_itself() {
    for code in OzonValidateCode::ALL {
        assert_eq!(
            KnownIssueKey::classify(
                crate::issue_keys::IssuePlatform::Ozon,
                IssueStage::Validate,
                code.as_str()
            ),
            Some(code.key())
        );
    }
    assert_eq!(OzonValidateCode::ALL.len(), 19);
}

//! Validation rule tests. Shared Draft helpers and the fixed product-field
//! rules live here; the editor, complex-group, dictionary and equality rules
//! each have their own file under `tests/`, mirroring `validate/`'s split.

use super::*;
use crate::categories::decorative_wall_art;
use crate::draft::default_field_values;

mod complex;
mod dictionary;
mod editor;
mod equality;

fn filled_values() -> BTreeMap<String, String> {
    let mut values = default_field_values(&decorative_wall_art::local_schema_snapshot());
    values.insert("offer_id".to_owned(), "  ART-001  ".to_owned());
    values.insert("name".to_owned(), " Настенная картина ".to_owned());
    values.insert("price".to_owned(), "90".to_owned());
    values.insert("barcode".to_owned(), "4006381333931".to_owned());
    values.insert("description".to_owned(), "40 × 50 cm".to_owned());
    values.insert("brand".to_owned(), "NoBrand".to_owned());
    values.insert("merge".to_owned(), "group-a".to_owned());
    values.insert("width".to_owned(), "400".to_owned());
    values.insert("height".to_owned(), "25".to_owned());
    values.insert("depth".to_owned(), "300".to_owned());
    values.insert("weight".to_owned(), "310".to_owned());
    values.insert("currency_code".to_owned(), "RUB".to_owned());
    values
}

fn draft_with(values: BTreeMap<String, String>) -> ListingDraftRecord {
    let schema = decorative_wall_art::local_schema_snapshot();
    ListingDraftRecord {
        draft_id: "draft-1".to_owned(),
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

#[test]
fn accepts_and_normalizes_representative_draft() {
    let outcome = normalize_and_validate(&draft_with(filled_values()));
    let ValidationOutcome::Accepted {
        normalized_values,
        snapshot,
    } = outcome
    else {
        panic!("expected acceptance");
    };
    assert_eq!(
        normalized_values.get("offer_id"),
        Some(&"ART-001".to_owned())
    );
    assert_eq!(snapshot.price, "90");
    assert_eq!(snapshot.width, 400);
    assert_eq!(snapshot.currency_code, "RUB");
    assert!(
        snapshot
            .attributes
            .iter()
            .any(|attribute| attribute.id == 4191)
    );
    assert!(
        snapshot
            .attributes
            .iter()
            .any(|attribute| attribute.id == 31)
    );
    assert!(
        snapshot
            .attributes
            .iter()
            .any(|attribute| attribute.id == 8292)
    );
}

#[test]
fn preserves_the_draft_currency_in_the_normalized_snapshot() {
    let mut values = filled_values();
    values.insert("currency_code".to_owned(), " CNY ".to_owned());

    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft_with(values))
    else {
        panic!("expected acceptance");
    };

    assert_eq!(snapshot.currency_code, "CNY");
}

#[test]
fn rejects_missing_currency_instead_of_inventing_rub() {
    let mut values = filled_values();
    values.remove("currency_code");

    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft_with(values)) else {
        panic!("a missing store currency must block Seller dispatch");
    };

    assert!(issues.iter().any(|issue| {
        issue.field_key == "currency_code"
            && issue.code == "required"
            && issue.message == "价格币种为必填项"
    }));
}

#[test]
fn preserves_the_draft_vat_and_units_in_the_normalized_snapshot() {
    let mut values = filled_values();
    values.insert("vat".to_owned(), " 0.2 ".to_owned());
    values.insert("dimension_unit".to_owned(), "cm".to_owned());
    values.insert("weight_unit".to_owned(), "kg".to_owned());

    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft_with(values))
    else {
        panic!("expected acceptance");
    };

    assert_eq!(snapshot.vat, "0.2");
    assert_eq!(snapshot.dimension_unit, "cm");
    assert_eq!(snapshot.weight_unit, "kg");
}

#[test]
fn preserves_non_empty_old_price_in_the_normalized_snapshot() {
    let mut values = filled_values();
    values.insert("old_price".to_owned(), " 120.50 ".to_owned());

    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft_with(values))
    else {
        panic!("expected acceptance");
    };

    assert_eq!(snapshot.old_price, "120.50");
}

#[test]
fn rejects_missing_required_and_bad_price() {
    let mut values = filled_values();
    values.insert("offer_id".to_owned(), String::new());
    values.insert("price".to_owned(), "not-a-number".to_owned());
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft_with(values)) else {
        panic!("expected rejection");
    };
    assert!(
        issues
            .iter()
            .any(|issue| { issue.field_key == "offer_id" && issue.code == "required" })
    );
    assert!(
        issues
            .iter()
            .any(|issue| { issue.field_key == "price" && issue.code == "invalid_price" })
    );
}

#[test]
fn rejects_han_in_product_name() {
    assert!(contains_han("〇"));

    let mut values = filled_values();
    values.insert(
        "name".to_owned(),
        "Картина по номерам «Губка Боб吹泡泡»".to_owned(),
    );

    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft_with(values)) else {
        panic!("a Russian product name containing Han must be rejected");
    };

    assert!(
        issues
            .iter()
            .any(|issue| { issue.field_key == "name" && issue.code == "name_contains_han" })
    );
}

#[test]
fn golden_rejection_cases_pass() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing");
    assert_golden_rejection_cases(&root).expect("goldens");
}

#[test]
fn product_name_limit_counts_unicode_characters_after_trim() {
    for character in ["a", "я", "😀"] {
        let mut values = filled_values();
        let name = character.repeat(PRODUCT_NAME_MAX_CHARS);
        values.insert("name".to_owned(), format!("  {name}  "));
        let ValidationOutcome::Accepted { snapshot, .. } =
            normalize_and_validate(&draft_with(values.clone()))
        else {
            panic!("a 200-character name must pass");
        };
        assert_eq!(snapshot.name, name);
        assert!(crate::compose::validate_product_name(&name).is_ok());

        let too_long = format!("{name}{character}");
        values.insert("name".to_owned(), too_long.clone());
        let draft = draft_with(values);
        let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
            panic!("a 201-character name must block Seller dispatch");
        };
        assert!(
            issues
                .iter()
                .any(|issue| { issue.field_key == "name" && issue.code == "name_too_long" })
        );
        assert_eq!(draft.field_values["name"], too_long);
        assert!(crate::compose::validate_product_name(&too_long).is_err());
    }
}

#[test]
fn golden_success_normalizes_like_import_fixture() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/listing/validation/success-normalized.json");
    let raw = std::fs::read_to_string(&root).expect("read success golden");
    let case: serde_json::Value = serde_json::from_str(&raw).expect("json");
    let field_values: BTreeMap<String, String> =
        serde_json::from_value(case["field_values"].clone()).expect("values");
    let ValidationOutcome::Accepted { snapshot, .. } =
        normalize_and_validate(&draft_with(field_values))
    else {
        panic!("success golden must accept");
    };
    assert_eq!(snapshot.offer_id, "ART-001");
    assert_eq!(snapshot.price, "90");
    assert_eq!(snapshot.width, 400);
    assert_eq!(snapshot.depth, 300);
    assert_eq!(snapshot.height, 25);
    assert_eq!(snapshot.weight, 310);
    assert_eq!(snapshot.currency_code, "RUB");
    assert_eq!(snapshot.barcode.as_deref(), Some("4006381333931"));
}

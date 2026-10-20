//! Dictionary audit: legal ids are kept, illegal ids are addressed issues,
//! truncated dictionaries use prefetched material, and labels never replace
//! an id's identity.

use super::*;

/// A single/multi select field on dictionary 44. Shared with the equality
/// tests, which compare values of such a field.
pub(super) fn select_field(
    key: &str,
    attribute_id: &str,
    collection: bool,
    truncated: bool,
) -> crate::schema::ListingFieldDefinition {
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};
    ListingFieldDefinition {
        key: key.to_owned(),
        label: key.to_owned(),
        group: "属性".to_owned(),
        editor: ListingFieldEditor::SingleSelect,
        required: false,
        constraints: ListingFieldConstraints {
            collection,
            dictionary_id: Some("44".to_owned()),
            ..ListingFieldConstraints::default()
        },
        attribute_id: Some(attribute_id.to_owned()),
        options_truncated: truncated,
        ..ListingFieldDefinition::default()
    }
}

#[test]
fn legal_dictionary_id_is_kept_on_the_attribute() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(select_field("attribute_color", "3301", false, false));
    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "42".to_owned(),
            label: "红".to_owned(),
        }),
    );
    draft
        .field_values
        .insert("attribute_color".to_owned(), "红".to_owned());
    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("a numeric dictionary id is a value");
    };
    let color = snapshot
        .attributes
        .iter()
        .find(|attribute| attribute.id == 3301)
        .expect("color attribute");
    assert_eq!(color.values[0].dictionary_value_id, Some(42));
}

#[test]
fn illegal_dictionary_id_is_an_addressed_issue_not_free_text() {
    use crate::draft::RawDraftValue;
    use crate::records::{ChoiceValue, FieldAddress};
    use crate::validate::IssueParameter;

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(select_field("attribute_color", "3301", false, false));
    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "nope".to_owned(),
            label: "红".to_owned(),
        }),
    );
    draft
        .field_values
        .insert("attribute_color".to_owned(), "红".to_owned());
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("an unparseable dictionary id must not be accepted as text");
    };
    assert!(issues.iter().any(|issue| {
        issue.code == "invalid_dictionary_id"
            && matches!(issue.address, FieldAddress::Plain { ref field_key } if field_key == "attribute_color")
            && issue.parameters.get("id") == Some(&IssueParameter::Text("nope".to_owned()))
    }));
}

#[test]
fn truncated_dictionary_uses_material_and_does_not_call_seller() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;
    use crate::records::ListingFieldOption;

    let mut draft = draft_with(filled_values());
    let mut field = select_field("attribute_color", "3301", false, true);
    field.options.push(ListingFieldOption {
        id: "1".to_owned(),
        value: "红".to_owned(),
        ..ListingFieldOption::default()
    });
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(field);
    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "999".to_owned(),
            label: String::new(),
        }),
    );
    draft
        .field_values
        .insert("attribute_color".to_owned(), "999".to_owned());

    let ValidationOutcome::Rejected { issues } =
        normalize_and_validate_with(&draft, &DictionaryMaterials::default())
    else {
        panic!("a truncated dictionary without material must ask for material");
    };
    assert!(issues.iter().any(|issue| {
        issue.code == "dictionary_material_required" && issue.field_key == "attribute_color"
    }));

    let mut materials = DictionaryMaterials::default();
    materials.insert(draft.description_category_id, 3301, 44, 999, "远处的红");
    let ValidationOutcome::Accepted { snapshot, .. } =
        normalize_and_validate_with(&draft, &materials)
    else {
        panic!("material that contains the id is enough; validation does not call Seller");
    };
    let color = snapshot
        .attributes
        .iter()
        .find(|attribute| attribute.id == 3301)
        .expect("color");
    assert_eq!(color.values[0].dictionary_value_id, Some(999));
    assert_eq!(color.values[0].value, "远处的红");

    // A search page proves only the IDs it returned, not that other IDs are absent.
    let mut searched = DictionaryMaterials::default();
    searched.insert_searched(draft.description_category_id, 3301, 44, 999, "远处的红");
    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "999".to_owned(),
            label: "伪造名称".to_owned(),
        }),
    );
    let ValidationOutcome::Accepted { snapshot, .. } =
        normalize_and_validate_with(&draft, &searched)
    else {
        panic!("Seller-confirmed search result should validate the selected ID");
    };
    assert_eq!(
        snapshot
            .attributes
            .iter()
            .find(|attribute| attribute.id == 3301)
            .unwrap()
            .values[0]
            .value,
        "远处的红"
    );
    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "998".to_owned(),
            label: String::new(),
        }),
    );
    assert!(matches!(
        normalize_and_validate_with(&draft, &searched),
        ValidationOutcome::Rejected { issues }
            if issues.iter().any(|issue| issue.code == "dictionary_material_required")
    ));
}

#[test]
fn same_label_different_ids_stay_distinct_and_missing_label_keeps_the_id() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;
    use crate::records::ListingFieldOption;

    let mut draft = draft_with(filled_values());
    let mut field = select_field("attribute_color", "3302", true, false);
    field.editor = crate::schema::ListingFieldEditor::MultiSelect;
    field.options.extend([
        ListingFieldOption {
            id: "1".to_owned(),
            value: "红".to_owned(),
            ..ListingFieldOption::default()
        },
        ListingFieldOption {
            id: "2".to_owned(),
            value: "红".to_owned(),
            ..ListingFieldOption::default()
        },
        ListingFieldOption {
            id: "7".to_owned(),
            value: "棉".to_owned(),
            ..ListingFieldOption::default()
        },
    ]);
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(field);
    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::ManyChoices(vec![
            ChoiceValue {
                id: "1".to_owned(),
                label: "红".to_owned(),
            },
            ChoiceValue {
                id: "2".to_owned(),
                label: "红".to_owned(),
            },
        ]),
    );
    draft
        .field_values
        .insert("attribute_color".to_owned(), "红".to_owned());
    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("two ids with the same label are two choices");
    };
    let ids: Vec<_> = snapshot
        .attributes
        .iter()
        .find(|attribute| attribute.id == 3302)
        .expect("color")
        .values
        .iter()
        .map(|value| value.dictionary_value_id)
        .collect();
    assert_eq!(ids, vec![Some(1), Some(2)]);

    draft.raw_values.insert(
        "attribute_color".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "7".to_owned(),
            label: String::new(),
        }),
    );
    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("a missing label must not drop the dictionary id");
    };
    let kept = snapshot
        .attributes
        .iter()
        .find(|attribute| attribute.id == 3302)
        .expect("color");
    assert_eq!(kept.values[0].dictionary_value_id, Some(7));
    assert_eq!(kept.values[0].value, "棉");
}

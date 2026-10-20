//! Editor-driven rules on arbitrary attribute keys: integer/select/url
//! editors, `max_value_count`, and single/multi choice cardinality.

use super::*;

#[test]
fn editor_rules_apply_to_arbitrary_attribute_keys() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_999".to_owned(),
            label: "件数".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::Integer,
            required: true,
            constraints: ListingFieldConstraints::default(),
            attribute_id: Some("999".to_owned()),
            ..ListingFieldDefinition::default()
        });
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_1000".to_owned(),
            label: "材质".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::SingleSelect,
            required: true,
            constraints: ListingFieldConstraints {
                dictionary_id: Some("44".to_owned()),
                ..ListingFieldConstraints::default()
            },
            attribute_id: Some("1000".to_owned()),
            ..ListingFieldDefinition::default()
        });
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_1001".to_owned(),
            label: "参考图".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::Url,
            required: false,
            constraints: ListingFieldConstraints::default(),
            attribute_id: Some("1001".to_owned()),
            ..ListingFieldDefinition::default()
        });
    draft
        .field_values
        .insert("attribute_999".to_owned(), "not-int".to_owned());
    draft
        .field_values
        .insert("attribute_1000".to_owned(), String::new());
    draft
        .raw_values
        .insert("attribute_1000".to_owned(), RawDraftValue::ClearedChoice);
    draft.field_values.insert(
        "attribute_1001".to_owned(),
        "ftp://example.test/a.jpg".to_owned(),
    );

    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("expected rejection from editor rules");
    };
    assert!(
        issues
            .iter()
            .any(|issue| { issue.field_key == "attribute_999" && issue.code == "invalid_integer" }),
        "integer editor must reject non-integers on arbitrary keys: {issues:?}"
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.field_key == "attribute_1000" && issue.code == "required"),
        "required select without choice must fail: {issues:?}"
    );
    assert!(
        issues
            .iter()
            .any(|issue| issue.field_key == "attribute_1001" && issue.code == "invalid_url"),
        "url editor must reject non-http URLs: {issues:?}"
    );

    // A valid dictionary choice clears the select issue.
    draft
        .field_values
        .insert("attribute_999".to_owned(), "3".to_owned());
    draft
        .field_values
        .insert("attribute_1000".to_owned(), "棉".to_owned());
    draft.raw_values.insert(
        "attribute_1000".to_owned(),
        RawDraftValue::OneChoice(ChoiceValue {
            id: "12".to_owned(),
            label: "棉".to_owned(),
        }),
    );
    draft.field_values.remove("attribute_1001");
    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("valid editor-backed fields must accept");
    };
    assert!(
        snapshot
            .attributes
            .iter()
            .any(|attribute| attribute.id == 999 && attribute.values[0].value == "3")
    );
    assert!(snapshot.attributes.iter().any(|attribute| {
        attribute.id == 1000 && attribute.values[0].dictionary_value_id == Some(12)
    }));
}

#[test]
fn max_value_count_is_enforced_from_schema_constraints() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_tags".to_owned(),
            label: "标签".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::MultiSelect,
            required: false,
            constraints: ListingFieldConstraints {
                collection: true,
                max_value_count: Some(1),
                dictionary_id: Some("7".to_owned()),
            },
            attribute_id: Some("77".to_owned()),
            ..ListingFieldDefinition::default()
        });
    draft
        .field_values
        .insert("attribute_tags".to_owned(), "a, b".to_owned());
    draft.raw_values.insert(
        "attribute_tags".to_owned(),
        RawDraftValue::ManyChoices(vec![
            ChoiceValue {
                id: "1".to_owned(),
                label: "a".to_owned(),
            },
            ChoiceValue {
                id: "2".to_owned(),
                label: "b".to_owned(),
            },
        ]),
    );

    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("expected max_value_count rejection");
    };
    assert!(
        issues.iter().any(|issue| {
            issue.field_key == "attribute_tags" && issue.code == "max_value_count"
        })
    );
}

#[test]
fn choice_cardinality_follows_collection_and_accepts_legacy_single_item() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_search_single".to_owned(),
            label: "原产国".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::DictionarySearch,
            required: false,
            constraints: ListingFieldConstraints {
                collection: false,
                dictionary_id: Some("44".to_owned()),
                ..ListingFieldConstraints::default()
            },
            attribute_id: Some("2000".to_owned()),
            ..ListingFieldDefinition::default()
        });
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_search_multi".to_owned(),
            label: "设置内容".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::DictionarySearch,
            required: false,
            constraints: ListingFieldConstraints {
                collection: true,
                max_value_count: Some(2),
                dictionary_id: Some("45".to_owned()),
            },
            attribute_id: Some("2001".to_owned()),
            ..ListingFieldDefinition::default()
        });
    let choice = |id: &str, label: &str| ChoiceValue {
        id: id.to_owned(),
        label: label.to_owned(),
    };

    draft
        .field_values
        .insert("attribute_search_single".to_owned(), "中国".to_owned());
    draft.raw_values.insert(
        "attribute_search_single".to_owned(),
        RawDraftValue::ManyChoices(vec![choice("1", "中国")]),
    );
    draft
        .field_values
        .insert("attribute_search_multi".to_owned(), "成人, 儿童".to_owned());
    draft.raw_values.insert(
        "attribute_search_multi".to_owned(),
        RawDraftValue::ManyChoices(vec![choice("2", "成人"), choice("3", "儿童")]),
    );

    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("one legacy single choice and a search multi-select must be accepted");
    };
    assert!(snapshot.attributes.iter().any(|attribute| {
        attribute.id == 2000 && attribute.values.len() == 1 && attribute.values[0].value == "中国"
    }));
    assert!(
        snapshot
            .attributes
            .iter()
            .any(|attribute| { attribute.id == 2001 && attribute.values.len() == 2 })
    );

    draft.raw_values.insert(
        "attribute_search_single".to_owned(),
        RawDraftValue::ManyChoices(vec![choice("1", "中国"), choice("4", "俄罗斯")]),
    );
    draft.field_values.insert(
        "attribute_search_single".to_owned(),
        "中国, 俄罗斯".to_owned(),
    );
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("a single-select field with two choices must be rejected");
    };
    assert!(issues.iter().any(|issue| {
        issue.field_key == "attribute_search_single" && issue.code == "invalid_choice_cardinality"
    }));
}

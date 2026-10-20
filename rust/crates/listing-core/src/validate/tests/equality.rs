//! Semantic value equality: dictionary ids over labels, numbers by value,
//! list order kept for non-dictionary fields, and the workflow wire forward.

use super::dictionary::select_field;
use super::*;

#[test]
fn semantic_equality_uses_id_number_and_list_order() {
    use crate::draft::RawDraftValue;
    use crate::records::ChoiceValue;
    use crate::schema::{ListingFieldDefinition, ListingFieldEditor};

    let dictionary = select_field("attribute_color", "3301", true, false);
    let red = |id: &str, label: &str| {
        RawDraftValue::OneChoice(ChoiceValue {
            id: id.to_owned(),
            label: label.to_owned(),
        })
    };
    assert!(semantically_equal(
        &dictionary,
        &red("5", "红"),
        &red("5", "Red"),
    ));
    assert!(!semantically_equal(
        &dictionary,
        &RawDraftValue::ManyChoices(vec![
            ChoiceValue {
                id: "1".to_owned(),
                label: "红".to_owned(),
            },
            ChoiceValue {
                id: "2".to_owned(),
                label: "红".to_owned(),
            },
        ]),
        &RawDraftValue::ManyChoices(vec![ChoiceValue {
            id: "1".to_owned(),
            label: "红".to_owned(),
        }]),
    ));
    assert!(semantically_equal(
        &dictionary,
        &RawDraftValue::ManyChoices(vec![
            ChoiceValue {
                id: "2".to_owned(),
                label: "蓝".to_owned(),
            },
            ChoiceValue {
                id: "1".to_owned(),
                label: "红".to_owned(),
            },
        ]),
        &RawDraftValue::ManyChoices(vec![
            ChoiceValue {
                id: "1".to_owned(),
                label: "Red".to_owned(),
            },
            ChoiceValue {
                id: "2".to_owned(),
                label: "Blue".to_owned(),
            },
        ]),
    ));

    let decimal = ListingFieldDefinition {
        editor: ListingFieldEditor::Decimal,
        ..select_field("price_like", "1", false, false)
    };
    assert!(semantically_equal(
        &decimal,
        &RawDraftValue::Text("1".to_owned()),
        &RawDraftValue::Text("1.0".to_owned()),
    ));
    assert!(workflow_values_equal(
        ListingFieldEditor::Decimal,
        Some(&crate::WorkflowDraftValue::TextList(vec![
            "1".to_owned(),
            "2.5".to_owned(),
        ])),
        Some(&crate::WorkflowDraftValue::TextList(vec![
            "1.0".to_owned(),
            "2.50".to_owned(),
        ])),
    ));
    assert!(!workflow_values_equal(
        ListingFieldEditor::Decimal,
        Some(&crate::WorkflowDraftValue::TextList(vec![
            "1".to_owned(),
            "2".to_owned(),
        ])),
        Some(&crate::WorkflowDraftValue::TextList(vec![
            "2".to_owned(),
            "1".to_owned(),
        ])),
    ));
    assert!(semantically_equal(
        &dictionary,
        &RawDraftValue::ClearedChoice,
        &RawDraftValue::ClearedChoice,
    ));
    assert!(!semantically_equal(
        &dictionary,
        &RawDraftValue::ClearedChoice,
        &RawDraftValue::ManyChoices(Vec::new()),
    ));
}

#[test]
fn workflow_decimal_two_matches_text_two_and_dictionary_ids_ignore_labels() {
    use crate::WorkflowDraftValue;
    use crate::schema::ListingFieldEditor;

    assert!(workflow_values_equal(
        ListingFieldEditor::Decimal,
        Some(&WorkflowDraftValue::Decimal(2.0)),
        Some(&WorkflowDraftValue::Text("2".to_owned())),
    ));
    assert!(!workflow_values_equal(
        ListingFieldEditor::Decimal,
        Some(&WorkflowDraftValue::Decimal(2.0)),
        Some(&WorkflowDraftValue::Text("22".to_owned())),
    ));
    let red = WorkflowDraftValue::MultiSelect(vec![crate::WorkflowDraftSelection {
        dictionary_value_id: 5,
        value: "红".to_owned(),
    }]);
    let red_en = WorkflowDraftValue::MultiSelect(vec![crate::WorkflowDraftSelection {
        dictionary_value_id: 5,
        value: "Red".to_owned(),
    }]);
    assert!(workflow_values_equal(
        ListingFieldEditor::MultiSelect,
        Some(&red),
        Some(&red_en),
    ));
}

//! Semantic field-value equality: the one comparison the editor, the server
//! and the WASM `valuesEqual` op share.

use std::collections::BTreeSet;

use super::dictionary::is_dictionary_editor;
use crate::records::{ListingFieldEditor, RawDraftValue};

/// Dictionary values match by id. Numbers match numerically. Lists of a
/// non-dictionary field keep schema order. Labels are not an identity.
pub fn semantically_equal(
    field: &crate::schema::ListingFieldDefinition,
    left: &RawDraftValue,
    right: &RawDraftValue,
) -> bool {
    if is_dictionary_editor(field.editor) {
        return match (dictionary_identity(left), dictionary_identity(right)) {
            (DictionaryIdentity::Cleared, DictionaryIdentity::Cleared) => true,
            (DictionaryIdentity::Ids(left_ids), DictionaryIdentity::Ids(right_ids)) => {
                left_ids == right_ids
            }
            _ => false,
        };
    }
    match (left, right) {
        (RawDraftValue::ClearedChoice, RawDraftValue::ClearedChoice) => true,
        (RawDraftValue::ClearedChoice, _) | (_, RawDraftValue::ClearedChoice) => false,
        _ => scalar_equal(field, &scalar_text(left), &scalar_text(right)),
    }
}

enum DictionaryIdentity {
    Cleared,
    Ids(BTreeSet<String>),
    Other,
}

fn dictionary_identity(raw: &RawDraftValue) -> DictionaryIdentity {
    let choices: Vec<&crate::records::ChoiceValue> = match raw {
        RawDraftValue::OneChoice(choice) => vec![choice],
        RawDraftValue::ManyChoices(choices) => choices.iter().collect(),
        RawDraftValue::ClearedChoice => return DictionaryIdentity::Cleared,
        _ => return DictionaryIdentity::Other,
    };
    DictionaryIdentity::Ids(
        choices
            .into_iter()
            .map(|choice| match choice.id.trim().parse::<i64>() {
                Ok(id) => id.to_string(),
                Err(_) => choice.id.trim().to_owned(),
            })
            .filter(|id| !id.is_empty())
            .collect(),
    )
}

fn scalar_equal(field: &crate::schema::ListingFieldDefinition, left: &str, right: &str) -> bool {
    match field.editor {
        ListingFieldEditor::Integer | ListingFieldEditor::Decimal => numeric_equal(left, right),
        ListingFieldEditor::Boolean => match (boolean_bit(left), boolean_bit(right)) {
            (Some(left_bit), Some(right_bit)) => left_bit == right_bit,
            _ => left.trim() == right.trim(),
        },
        _ => left.trim() == right.trim(),
    }
}

fn numeric_equal(left: &str, right: &str) -> bool {
    matches!(
        (left.trim().parse::<f64>(), right.trim().parse::<f64>()),
        (Ok(left_value), Ok(right_value))
            if left_value.is_finite() && right_value.is_finite() && left_value == right_value
    )
}

fn boolean_bit(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "是" => Some(true),
        "false" | "0" | "no" | "否" => Some(false),
        _ => None,
    }
}

fn scalar_text(raw: &RawDraftValue) -> String {
    match raw {
        RawDraftValue::Text(value) => value.trim().to_owned(),
        RawDraftValue::OneChoice(choice) => {
            let label = choice.label.trim();
            if label.is_empty() {
                choice.id.trim().to_owned()
            } else {
                label.to_owned()
            }
        }
        RawDraftValue::ManyChoices(choices) => choices
            .iter()
            .map(|choice| choice.label.trim())
            .filter(|label| !label.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        RawDraftValue::ClearedChoice => String::new(),
    }
}

/// Process-boundary forward. Callers pass an editor and two workflow values.
/// The comparison is [`semantically_equal`]; this function only adapts the
/// wire shape.
pub fn workflow_values_equal(
    editor: ListingFieldEditor,
    left: Option<&crate::WorkflowDraftValue>,
    right: Option<&crate::WorkflowDraftValue>,
) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(left), Some(right)) => {
            let field = crate::schema::ListingFieldDefinition {
                editor,
                key: "field".to_owned(),
                label: "field".to_owned(),
                group: String::new(),
                ..crate::schema::ListingFieldDefinition::default()
            };
            match (
                crate::bridge::list_elements_of(left, false),
                crate::bridge::list_elements_of(right, false),
            ) {
                (Some(left_items), Some(right_items)) => {
                    left_items.len() == right_items.len()
                        && left_items
                            .iter()
                            .zip(right_items)
                            .all(|(left_item, right_item)| {
                                scalar_equal(&field, left_item, &right_item)
                            })
                }
                (Some(_), None) | (None, Some(_)) => false,
                (None, None) => {
                    semantically_equal(&field, &workflow_to_raw(left), &workflow_to_raw(right))
                }
            }
        }
        _ => false,
    }
}

fn workflow_to_raw(value: &crate::WorkflowDraftValue) -> RawDraftValue {
    match value {
        crate::WorkflowDraftValue::Text(text) | crate::WorkflowDraftValue::Url(text) => {
            RawDraftValue::Text(text.clone())
        }
        crate::WorkflowDraftValue::Integer(value) => RawDraftValue::Text(value.to_string()),
        crate::WorkflowDraftValue::Decimal(value) => RawDraftValue::Text(format_decimal(*value)),
        crate::WorkflowDraftValue::Boolean(value) => {
            RawDraftValue::Text(if *value { "true" } else { "false" }.to_owned())
        }
        crate::WorkflowDraftValue::TextList(_)
        | crate::WorkflowDraftValue::UrlList(_)
        | crate::WorkflowDraftValue::IntegerList(_)
        | crate::WorkflowDraftValue::DecimalList(_)
        | crate::WorkflowDraftValue::BooleanList(_) => RawDraftValue::Text(String::new()),
        crate::WorkflowDraftValue::SingleSelect(choice) => {
            RawDraftValue::OneChoice(crate::records::ChoiceValue {
                id: choice.dictionary_value_id.to_string(),
                label: choice.value.clone(),
            })
        }
        crate::WorkflowDraftValue::MultiSelect(choices) => RawDraftValue::ManyChoices(
            choices
                .iter()
                .map(|choice| crate::records::ChoiceValue {
                    id: choice.dictionary_value_id.to_string(),
                    label: choice.value.clone(),
                })
                .collect(),
        ),
    }
}

fn format_decimal(value: f64) -> String {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 1e15 {
        format!("{}", value as i64)
    } else {
        value.to_string()
    }
}

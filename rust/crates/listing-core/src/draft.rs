#[cfg(test)]
use std::collections::BTreeMap;
#[cfg(test)]
use std::sync::Arc;

#[cfg(test)]
use serde::{Deserialize, Serialize};

#[cfg(test)]
use super::ListingError;
#[cfg(test)]
use super::records::CategorySchemaSnapshot;
pub use super::records::RawDraftValue;
#[cfg(test)]
pub use super::records::{ComplexDraftItem, FieldValueOrigin, ListingDraftRecord};

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DraftEdit {
    SetRaw {
        field_key: String,
        value: RawDraftValue,
    },
    InsertComplexItem {
        group_key: String,
        item_id: String,
    },
    RemoveComplexItem {
        group_key: String,
        item_id: String,
    },
    SetComplexRaw {
        group_key: String,
        item_id: String,
        field_key: String,
        value: RawDraftValue,
    },
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OriginatedDraftEdit {
    pub edit: DraftEdit,
    pub origin: FieldValueOrigin,
}

#[cfg(test)]
pub fn default_field_values(schema: &CategorySchemaSnapshot) -> BTreeMap<String, String> {
    schema
        .fields
        .iter()
        .map(|field| (field.key.clone(), String::new()))
        .collect()
}

/// Text projection of a typed raw value. Must stay byte-identical with
/// `workflow::draft_ref::workflow_value_text` for the corresponding DTO kinds:
/// choice labels join with `", "`, the same separator `dynamic_listing_draft`
/// uses when it projects a DTO back into Listing.
pub fn raw_value_text(value: &RawDraftValue) -> String {
    match value {
        RawDraftValue::Text(text) => text.clone(),
        RawDraftValue::OneChoice(choice) => choice.label.clone(),
        RawDraftValue::ManyChoices(choices) => choices
            .iter()
            .map(|choice| choice.label.as_str())
            .collect::<Vec<_>>()
            .join(", "),
        RawDraftValue::ClearedChoice => String::new(),
    }
}

#[cfg(test)]
pub fn apply_edit(draft: &mut ListingDraftRecord, edit: DraftEdit) -> Result<(), ListingError> {
    match edit {
        DraftEdit::SetRaw { field_key, value } => {
            if !draft
                .schema_snapshot
                .fields
                .iter()
                .any(|field| field.key == field_key)
            {
                return Err(ListingError::InvalidDraftEdit {
                    code: "unknown_field",
                    address: field_key,
                });
            }
            // Keep the text projection in lockstep with the typed value. The
            // decide seam writes here (candidate confirmations, AI prose); if
            // field_values stayed stale, the next DTO save would see a text
            // diff, treat the address as changed and re-stamp its origin as
            // Manual — silently undoing the AiConfirmed origin just recorded.
            draft
                .field_values
                .insert(field_key.clone(), raw_value_text(&value));
            draft.raw_values.insert(field_key, value);
        }
        DraftEdit::InsertComplexItem { group_key, item_id } => {
            let items = draft.complex_values.entry(group_key.clone()).or_default();
            if items.iter().any(|item| item.item_id == item_id) {
                return Err(ListingError::InvalidDraftEdit {
                    code: "duplicate_item",
                    address: format!("{group_key}/{item_id}"),
                });
            }
            items.push(ComplexDraftItem {
                item_id,
                values: Default::default(),
                list_elements: Default::default(),
            });
        }
        DraftEdit::RemoveComplexItem { group_key, item_id } => {
            let items =
                draft
                    .complex_values
                    .get_mut(&group_key)
                    .ok_or(ListingError::InvalidDraftEdit {
                        code: "unknown_group",
                        address: group_key.clone(),
                    })?;
            let index = items
                .iter()
                .position(|item| item.item_id == item_id)
                .ok_or(ListingError::InvalidDraftEdit {
                    code: "unknown_item",
                    address: format!("{group_key}/{item_id}"),
                })?;
            items.remove(index);
        }
        DraftEdit::SetComplexRaw {
            group_key,
            item_id,
            field_key,
            value,
        } => {
            let items =
                draft
                    .complex_values
                    .get_mut(&group_key)
                    .ok_or(ListingError::InvalidDraftEdit {
                        code: "unknown_group",
                        address: group_key.clone(),
                    })?;
            let item = items
                .iter_mut()
                .find(|item| item.item_id == item_id)
                .ok_or(ListingError::InvalidDraftEdit {
                    code: "unknown_item",
                    address: format!("{group_key}/{item_id}"),
                })?;
            item.values.insert(field_key, value);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;
    use crate::records::{ChoiceValue, ListingLifecycleState};

    fn raw_value_has_content(value: &RawDraftValue) -> bool {
        value.has_content()
    }

    #[test]
    fn default_values_are_empty_strings() {
        let schema = decorative_wall_art::local_schema_snapshot();
        let values = default_field_values(&schema);
        assert_eq!(values.get("offer_id"), Some(&String::new()));
        assert_eq!(values.len(), schema.fields.len());
    }

    #[test]
    fn raw_value_has_content_matches_all_draft_value_variants() {
        let cases: Vec<(RawDraftValue, bool)> = vec![
            // Text: empty, whitespace-only, and non-empty
            (RawDraftValue::Text(String::new()), false),
            (RawDraftValue::Text("   ".to_string()), false),
            (RawDraftValue::Text(" x ".to_string()), true),
            // OneChoice: empty id + empty label, empty id + label, id + empty label
            (
                RawDraftValue::OneChoice(ChoiceValue {
                    id: String::new(),
                    label: String::new(),
                }),
                false,
            ),
            (
                RawDraftValue::OneChoice(ChoiceValue {
                    id: String::new(),
                    label: "label".to_string(),
                }),
                true,
            ),
            (
                RawDraftValue::OneChoice(ChoiceValue {
                    id: "id".to_string(),
                    label: String::new(),
                }),
                true,
            ),
            // OneChoice: whitespace-only id/label does not count as content
            (
                RawDraftValue::OneChoice(ChoiceValue {
                    id: "  ".to_string(),
                    label: "  ".to_string(),
                }),
                false,
            ),
            // ManyChoices: empty and non-empty
            (RawDraftValue::ManyChoices(Vec::new()), false),
            (
                RawDraftValue::ManyChoices(vec![ChoiceValue {
                    id: "id".to_string(),
                    label: "label".to_string(),
                }]),
                true,
            ),
            // ClearedChoice: never has content
            (RawDraftValue::ClearedChoice, false),
        ];
        for (value, expected) in cases {
            assert_eq!(
                raw_value_has_content(&value),
                expected,
                "unexpected result for variant"
            );
        }
    }

    #[test]
    fn apply_edit_keeps_the_text_projection_in_lockstep_with_the_raw_value() {
        let schema = decorative_wall_art::local_schema_snapshot();
        let mut draft = ListingDraftRecord {
            draft_id: "draft-apply-edit".to_owned(),
            draft_revision: 1,
            category_key: decorative_wall_art::CATEGORY_KEY.to_owned(),
            description_category_id: 17027906,
            type_id: 91976,
            schema_revision: schema.schema_revision.clone(),
            recipe_id: 0,
            recipe_revision: 0,
            catalog_schema_version: 0,
            schema_snapshot: Arc::new(schema),
            field_values: default_field_values(&decorative_wall_art::local_schema_snapshot()),
            raw_values: Default::default(),
            list_elements: Default::default(),
            complex_values: Default::default(),
            field_origins: Default::default(),
            lifecycle_state: ListingLifecycleState::Draft,
            normalized_snapshot: None,
            execution_plan: None,
            updated_at_ms: 0,
            envelope_version: crate::records::CURRENT_ENVELOPE_VERSION,
            unusable: false,
            preview_required: false,
            decode_failures: Vec::new(),
        };
        let cases: Vec<(RawDraftValue, &str)> = vec![
            (RawDraftValue::Text(" 标题 ".to_owned()), " 标题 "),
            (
                RawDraftValue::OneChoice(ChoiceValue {
                    id: "7".to_owned(),
                    label: "NoBrand".to_owned(),
                }),
                "NoBrand",
            ),
            (
                RawDraftValue::ManyChoices(vec![
                    ChoiceValue {
                        id: "1".to_owned(),
                        label: "甲".to_owned(),
                    },
                    ChoiceValue {
                        id: "2".to_owned(),
                        label: "乙".to_owned(),
                    },
                ]),
                "甲, 乙",
            ),
            (RawDraftValue::ClearedChoice, ""),
        ];
        for (value, expected_text) in cases {
            apply_edit(
                &mut draft,
                DraftEdit::SetRaw {
                    field_key: "name".to_owned(),
                    value,
                },
            )
            .expect("apply");
            assert_eq!(
                draft.field_values.get("name").map(String::as_str),
                Some(expected_text)
            );
        }
    }
}

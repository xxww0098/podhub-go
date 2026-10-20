//! Seller attribute values → typed SKU candidate values, and (test-only) the
//! candidates → Listing Draft edit mapping with SellerSku origin.

#[cfg(test)]
use crate::draft::{DraftEdit, OriginatedDraftEdit};
use crate::records::ListingFieldEditor;
#[cfg(test)]
use crate::records::{
    ChoiceValue, FieldAddress, FieldValueOrigin, FieldValueOriginKind, RawDraftValue,
};

use super::{SellerSkuAttributeValue, SkuImportSchemaField, SkuImportSelection, SkuImportValue};
#[cfg(test)]
use super::{SkuImportCandidate, SkuImportLocation};

pub(super) fn convert_value(
    field: &SkuImportSchemaField,
    values: &[SellerSkuAttributeValue],
) -> Option<SkuImportValue> {
    let values = values
        .iter()
        .filter(|value| !value.value.trim().is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    let strings = || {
        values
            .iter()
            .map(|value| value.value.clone())
            .collect::<Vec<_>>()
    };
    match field.editor {
        ListingFieldEditor::Text => Some(if field.collection {
            SkuImportValue::TextList(strings())
        } else {
            SkuImportValue::Text(values[0].value.clone())
        }),
        ListingFieldEditor::Url => Some(SkuImportValue::Url(values[0].value.clone())),
        ListingFieldEditor::UrlList => Some(SkuImportValue::UrlList(strings())),
        ListingFieldEditor::Integer => {
            if field.collection {
                Some(SkuImportValue::IntegerList(
                    values
                        .iter()
                        .map(|value| value.value.trim().parse::<i64>())
                        .collect::<Result<Vec<_>, _>>()
                        .ok()?,
                ))
            } else {
                Some(SkuImportValue::Integer(
                    values[0].value.trim().parse().ok()?,
                ))
            }
        }
        ListingFieldEditor::Decimal => {
            if field.collection {
                Some(SkuImportValue::DecimalList(
                    values
                        .iter()
                        .map(|value| value.value.trim().parse::<f64>())
                        .collect::<Result<Vec<_>, _>>()
                        .ok()?,
                ))
            } else {
                Some(SkuImportValue::Decimal(
                    values[0].value.trim().parse().ok()?,
                ))
            }
        }
        ListingFieldEditor::Boolean => {
            let parse = |value: &str| match value.trim().to_ascii_lowercase().as_str() {
                "true" | "1" | "yes" | "是" => Some(true),
                "false" | "0" | "no" | "否" => Some(false),
                _ => None,
            };
            if field.collection {
                Some(SkuImportValue::BooleanList(
                    values
                        .iter()
                        .map(|value| parse(&value.value))
                        .collect::<Option<Vec<_>>>()?,
                ))
            } else {
                Some(SkuImportValue::Boolean(parse(&values[0].value)?))
            }
        }
        ListingFieldEditor::SingleSelect
        | ListingFieldEditor::MultiSelect
        | ListingFieldEditor::DictionarySearch
            if field.collection =>
        {
            Some(SkuImportValue::MultiSelect(
                values
                    .iter()
                    .map(|value| resolve_selection(field, value))
                    .collect::<Option<Vec<_>>>()?,
            ))
        }
        ListingFieldEditor::SingleSelect
        | ListingFieldEditor::MultiSelect
        | ListingFieldEditor::DictionarySearch => Some(SkuImportValue::SingleSelect(
            resolve_selection(field, values[0])?,
        )),
    }
}

/// Map SKU candidates onto Listing's Draft edit interface with SellerSku origin.
#[cfg(test)]
pub fn candidates_to_originated_edits(
    candidates: &[SkuImportCandidate],
    source_sku: i64,
    updated_at_ms: u64,
) -> Vec<OriginatedDraftEdit> {
    let source_ref = Some(format!("sku:{source_sku}"));
    candidates
        .iter()
        .filter_map(|candidate| {
            let raw = sku_value_to_raw(&candidate.value)?;
            let (edit, address) = match &candidate.location {
                SkuImportLocation::Plain => (
                    DraftEdit::SetRaw {
                        field_key: candidate.field_key.clone(),
                        value: raw,
                    },
                    FieldAddress::Plain {
                        field_key: candidate.field_key.clone(),
                    },
                ),
                SkuImportLocation::Complex {
                    complex_id,
                    item_index,
                } => {
                    let group_key = complex_id.to_string();
                    let item_id = format!("sku-{complex_id}-{item_index}");
                    (
                        DraftEdit::SetComplexRaw {
                            group_key: group_key.clone(),
                            item_id: item_id.clone(),
                            field_key: candidate.field_key.clone(),
                            value: raw,
                        },
                        FieldAddress::Complex {
                            group_key,
                            item_id,
                            field_key: candidate.field_key.clone(),
                            value_index: None,
                        },
                    )
                }
            };
            Some(OriginatedDraftEdit {
                edit,
                origin: FieldValueOrigin {
                    address,
                    kind: FieldValueOriginKind::SellerSku,
                    source_ref: source_ref.clone(),
                    updated_at_ms,
                },
            })
        })
        .collect()
}

#[cfg(test)]
fn sku_value_to_raw(value: &SkuImportValue) -> Option<RawDraftValue> {
    match value {
        SkuImportValue::Text(text) | SkuImportValue::Url(text) => {
            Some(RawDraftValue::Text(text.clone()))
        }
        SkuImportValue::Integer(n) => Some(RawDraftValue::Text(n.to_string())),
        SkuImportValue::Decimal(n) => Some(RawDraftValue::Text(n.to_string())),
        SkuImportValue::Boolean(b) => Some(RawDraftValue::Text(b.to_string())),
        SkuImportValue::TextList(_)
        | SkuImportValue::UrlList(_)
        | SkuImportValue::IntegerList(_)
        | SkuImportValue::DecimalList(_)
        | SkuImportValue::BooleanList(_) => None,
        SkuImportValue::SingleSelect(selection) => Some(RawDraftValue::OneChoice(ChoiceValue {
            id: selection.dictionary_value_id.to_string(),
            label: selection.value.clone(),
        })),
        SkuImportValue::MultiSelect(selections) => Some(RawDraftValue::ManyChoices(
            selections
                .iter()
                .map(|selection| ChoiceValue {
                    id: selection.dictionary_value_id.to_string(),
                    label: selection.value.clone(),
                })
                .collect(),
        )),
    }
}

fn resolve_selection(
    field: &SkuImportSchemaField,
    value: &SellerSkuAttributeValue,
) -> Option<SkuImportSelection> {
    let id = if value.dictionary_value_id > 0 {
        value.dictionary_value_id
    } else {
        field
            .options
            .iter()
            .find(|option| option.value == value.value)?
            .id
    };
    Some(SkuImportSelection {
        dictionary_value_id: id,
        value: value.value.clone(),
    })
}

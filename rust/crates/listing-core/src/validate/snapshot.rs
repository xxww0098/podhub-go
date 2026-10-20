//! Building the `NormalizedListingSnapshot` from an accepted Draft, and the
//! value normalization it shares with the orchestrator.

use std::collections::BTreeMap;

use super::dictionary::{
    DictionaryMaterials, fill_choice_label, is_dictionary_editor, parsed_choice,
};
use super::issues::{FieldIssue, issue};
use super::scalar::parse_positive_u64;
use crate::issue_keys::OzonValidateCode as Code;
use crate::records::{
    CategorySchemaSnapshot, ListingDraftRecord, NormalizedAttribute, NormalizedAttributeValue,
    NormalizedComplexAttributeGroup, NormalizedListingSnapshot, RawDraftValue,
};

fn snapshot_text<'a>(
    values: &'a BTreeMap<String, String>,
    draft: &'a ListingDraftRecord,
    key: &str,
    default: &'a str,
) -> &'a str {
    values
        .get(key)
        .or_else(|| draft.field_values.get(key))
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default)
}

pub(super) fn build_snapshot(
    draft: &ListingDraftRecord,
    schema: &CategorySchemaSnapshot,
    values: &BTreeMap<String, String>,
    materials: &DictionaryMaterials,
) -> Result<NormalizedListingSnapshot, Vec<FieldIssue>> {
    let mut issues = Vec::new();
    let offer_id = required_value(values, "offer_id", &mut issues);
    let name = required_value(values, "name", &mut issues);
    let price = required_value(values, "price", &mut issues);
    let width = required_positive_u64(values, "width", "宽度 (mm)", &mut issues);
    let height = required_positive_u64(values, "height", "高度 (mm)", &mut issues);
    let depth = required_positive_u64(values, "depth", "深度 (mm)", &mut issues);
    let weight = required_positive_u64(values, "weight", "重量 (g)", &mut issues);
    let currency_code = snapshot_text(values, draft, "currency_code", "").to_owned();
    if currency_code.is_empty() {
        issues.push(issue(
            "currency_code",
            Code::Required,
            "价格币种为必填项",
            Some("在「默认字段」选择店铺币种后再发送".to_owned()),
        ));
    }

    if !issues.is_empty() {
        return Err(issues);
    }

    let barcode = values
        .get("barcode")
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    let description = values
        .get("description")
        .map(|value| value.trim().to_owned())
        .unwrap_or_default();
    let old_price = snapshot_text(values, draft, "old_price", "");
    let vat = snapshot_text(values, draft, "vat", "");
    let dimension_unit = snapshot_text(values, draft, "dimension_unit", "");
    let weight_unit = snapshot_text(values, draft, "weight_unit", "");

    let mut attributes = Vec::new();
    for field in &schema.fields {
        let Some(attribute_id) = field.attribute_id.as_deref() else {
            continue;
        };
        let Ok(id) = attribute_id.parse::<i64>() else {
            continue;
        };
        let value = values
            .get(&field.key)
            .map(|entry| entry.trim())
            .unwrap_or("");
        let from_raw = draft
            .list_elements
            .get(&field.key)
            .map(|elements| normalize_elements(elements))
            .or_else(|| draft.raw_values.get(&field.key).map(normalize_raw_values));
        let has_dictionary_id = from_raw.as_ref().is_some_and(|entries| {
            entries
                .iter()
                .any(|entry| entry.dictionary_value_id.is_some())
        });
        if value.is_empty() && !has_dictionary_id {
            continue;
        }
        let mut normalized_values = if is_dictionary_editor(field.editor) {
            from_raw.unwrap_or_default()
        } else {
            from_raw
                .filter(|entries| !entries.is_empty())
                .unwrap_or_else(|| {
                    vec![NormalizedAttributeValue {
                        value: value.to_owned(),
                        dictionary_value_id: None,
                    }]
                })
        };
        for entry in &mut normalized_values {
            fill_choice_label(field, draft.description_category_id, materials, entry);
        }
        normalized_values.retain(|entry| !entry.value.is_empty());
        if normalized_values.is_empty() {
            continue;
        }
        attributes.push(NormalizedAttribute {
            id,
            complex_id: 0,
            values: normalized_values,
        });
    }
    attributes.sort_by_key(|attribute| attribute.id);
    let mut complex_attributes = Vec::new();
    for (group_key, items) in &draft.complex_values {
        let Ok(complex_id) = group_key.parse::<i64>() else {
            continue;
        };
        let fields = schema
            .fields
            .iter()
            .filter(|field| field.complex_id.as_deref() == Some(group_key.as_str()))
            .collect::<Vec<_>>();
        for item in items {
            let mut item_attributes = Vec::new();
            for field in &fields {
                let Some(attribute_id) = field
                    .attribute_id
                    .as_deref()
                    .and_then(|value| value.parse::<i64>().ok())
                else {
                    continue;
                };
                let Some(raw) = item.values.get(&field.key) else {
                    continue;
                };
                let mut values = normalize_field_values(
                    Some(raw),
                    item.list_elements.get(&field.key).map(Vec::as_slice),
                );
                for entry in &mut values {
                    fill_choice_label(field, draft.description_category_id, materials, entry);
                }
                values.retain(|value| !value.value.is_empty());
                if values.is_empty() {
                    continue;
                }
                item_attributes.push(NormalizedAttribute {
                    id: attribute_id,
                    complex_id,
                    values,
                });
            }
            if !item_attributes.is_empty() {
                item_attributes.sort_by_key(|attribute| attribute.id);
                complex_attributes.push(NormalizedComplexAttributeGroup {
                    complex_id,
                    attributes: item_attributes,
                });
            }
        }
    }
    complex_attributes.sort_by_key(|group| group.complex_id);

    Ok(NormalizedListingSnapshot {
        draft_revision: draft.draft_revision,
        schema_revision: draft.schema_revision.clone(),
        offer_id: offer_id.expect("checked"),
        barcode,
        name: name.expect("checked"),
        description,
        description_category_id: draft.description_category_id,
        type_id: draft.type_id,
        price: price.expect("checked"),
        old_price: old_price.to_owned(),
        currency_code,
        vat: vat.to_owned(),
        depth: depth.expect("checked"),
        width: width.expect("checked"),
        height: height.expect("checked"),
        dimension_unit: dimension_unit.to_owned(),
        weight: weight.expect("checked"),
        weight_unit: weight_unit.to_owned(),
        attributes,
        complex_attributes,
    })
}

pub(super) fn normalize_elements(values: &[String]) -> Vec<NormalizedAttributeValue> {
    values
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(|value| NormalizedAttributeValue {
            value: value.to_owned(),
            dictionary_value_id: None,
        })
        .collect()
}

pub(super) fn normalize_field_values(
    raw: Option<&RawDraftValue>,
    elements: Option<&[String]>,
) -> Vec<NormalizedAttributeValue> {
    if let Some(values) = elements {
        return normalize_elements(values);
    }
    raw.map(normalize_raw_values).unwrap_or_default()
}

pub(super) fn normalize_raw_values(raw: &RawDraftValue) -> Vec<NormalizedAttributeValue> {
    match raw {
        RawDraftValue::Text(value) => vec![NormalizedAttributeValue {
            value: value.trim().to_owned(),
            dictionary_value_id: None,
        }],
        RawDraftValue::OneChoice(choice) => parsed_choice(choice).into_iter().collect(),
        RawDraftValue::ManyChoices(values) => values.iter().filter_map(parsed_choice).collect(),
        RawDraftValue::ClearedChoice => Vec::new(),
    }
}

fn required_value(
    values: &BTreeMap<String, String>,
    key: &str,
    issues: &mut Vec<FieldIssue>,
) -> Option<String> {
    match values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    {
        Some(value) => Some(value.to_owned()),
        None => {
            issues.push(issue(key, Code::Required, format!("{key} 为必填项"), None));
            None
        }
    }
}

fn required_positive_u64(
    values: &BTreeMap<String, String>,
    key: &str,
    label: &str,
    issues: &mut Vec<FieldIssue>,
) -> Option<u64> {
    let Some(raw) = values
        .get(key)
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
    else {
        issues.push(issue(
            key,
            Code::Required,
            format!("{label} 为必填项"),
            None,
        ));
        return None;
    };
    match parse_positive_u64(raw) {
        Some(value) => Some(value),
        None => {
            issues.push(issue(
                key,
                Code::InvalidPositiveInteger,
                format!("{label} 必须是正整数"),
                None,
            ));
            None
        }
    }
}

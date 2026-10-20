//! Canonical listing normalization and final validation.
//!
//! React never reimplements these rules.
//!
//! This file is the orchestrator: it walks the pinned schema's plain and
//! complex fields and delegates each rule family to its own module —
//! `scalar` (fixed product fields and editor rules), `dictionary`
//! (dictionary materials and the membership audit), `snapshot` (the
//! `NormalizedListingSnapshot` an accepted Draft becomes), `equality`
//! (semantic value comparison) and `issues` (the `FieldIssue` wire shape and
//! its typed validate-stage producer). Every issue minted here names an
//! [`crate::issue_keys::OzonValidateCode`]; the stage of all of them is
//! `validate`.

use std::collections::{BTreeMap, BTreeSet};
#[cfg(test)]
use std::path::Path;

use crate::issue_keys::OzonValidateCode as Code;
use crate::records::ListingDraftRecord;

mod dictionary;
mod equality;
#[cfg(test)]
mod golden;
mod issues;
mod scalar;
mod snapshot;

pub use dictionary::DictionaryMaterials;
pub use equality::{semantically_equal, workflow_values_equal};
pub use issues::{FieldIssue, IssueParameter, IssueSeverity};
pub use scalar::contains_han;

/// Ozon product names are limited by Unicode characters, not UTF-8 bytes.
pub const PRODUCT_NAME_MAX_CHARS: usize = 200;

#[cfg(test)]
pub use crate::records::ListingLifecycleState;
pub use crate::records::{
    FieldAddress, NormalizedAttribute, NormalizedAttributeValue, NormalizedComplexAttributeGroup,
    NormalizedListingSnapshot,
};

#[cfg(test)]
pub use golden::assert_golden_rejection_cases;

// The rule tests (`validate/tests*`) name these through `use super::*`, as
// they did before this file was split by responsibility.
#[cfg(test)]
use crate::records::{ListingFieldEditor, RawDraftValue};
#[cfg(test)]
use snapshot::{normalize_elements, normalize_raw_values};

use dictionary::audit_dictionary;
/// One owner for "is this a dictionary choice": the equality rule, the
/// dictionary audit and `crate::variants`' member normalisation all ask the
/// same question.
pub(crate) use dictionary::is_dictionary_editor;
use issues::issue;
use scalar::{
    element_count, validate_barcode, validate_by_editor, validate_name, validate_offer_id,
    validate_positive_int, validate_price,
};
use snapshot::{build_snapshot, normalize_field_values};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValidationOutcome {
    Accepted {
        normalized_values: BTreeMap<String, String>,
        snapshot: NormalizedListingSnapshot,
    },
    Rejected {
        issues: Vec<FieldIssue>,
    },
}

pub fn normalize_and_validate(draft: &ListingDraftRecord) -> ValidationOutcome {
    normalize_and_validate_with(draft, &DictionaryMaterials::default())
}

pub fn normalize_and_validate_with(
    draft: &ListingDraftRecord,
    materials: &DictionaryMaterials,
) -> ValidationOutcome {
    let schema = &draft.schema_snapshot;
    let mut issues = Vec::new();
    let mut normalized_values = BTreeMap::new();

    for field in &schema.fields {
        if field.complex_id.is_some() {
            continue;
        }
        let raw = draft
            .field_values
            .get(&field.key)
            .map(String::as_str)
            .unwrap_or("");
        let trimmed = raw.trim().to_owned();
        normalized_values.insert(field.key.clone(), trimmed.clone());
        let typed = draft.raw_values.get(&field.key);
        let elements = draft.list_elements.get(&field.key).map(Vec::as_slice);
        let value_count = element_count(elements, typed, !trimmed.is_empty());

        if field.required && value_count == 0 {
            issues.push(issue(
                &field.key,
                Code::Required,
                format!("{} 为必填项", field.label),
                Some(format!("填写「{}」后再校验", field.label)),
            ));
            continue;
        }
        if value_count == 0 {
            continue;
        }

        if let Some(max) = field.constraints.max_value_count
            && value_count as u32 > max
        {
            issues.push(issue(
                &field.key,
                Code::MaxValueCount,
                format!("{} 最多允许 {max} 个值", field.label),
                Some(format!("将「{}」减少到 {max} 个值以内", field.label)),
            ));
        }

        // Fixed product-level rules keep their stable codes; everything else is
        // driven by the pinned editor + constraints so non-decorative categories
        // are not a vacuum at Validated.
        match field.key.as_str() {
            "offer_id" => validate_offer_id(&trimmed, &mut issues),
            "name" => validate_name(&trimmed, &mut issues),
            "barcode" => validate_barcode(&trimmed, &mut issues),
            "price" => validate_price(&trimmed, &mut issues),
            "width" | "height" | "depth" | "weight" => {
                validate_positive_int(&field.key, &field.label, &trimmed, &mut issues);
            }
            _ => validate_by_editor(field, &trimmed, typed, elements, &mut issues, None),
        }
        if is_dictionary_editor(field.editor) {
            audit_dictionary(
                field,
                typed,
                None,
                draft.description_category_id,
                materials,
                &mut issues,
            );
        }
    }

    let mut seen_complex_groups = BTreeSet::new();
    for field in schema
        .fields
        .iter()
        .filter(|field| field.complex_id.is_some())
    {
        let group_key = field.complex_id.as_deref().unwrap_or_default();
        let items = draft.complex_values.get(group_key);
        if seen_complex_groups.insert(group_key.to_owned())
            && !field.complex_group_collection
            && let Some(items) = items
        {
            for item in items
                .iter()
                .filter(|item| crate::field_pack::occupies(!item.values.is_empty(), false))
                .skip(1)
            {
                let mut field_issue = issue(
                    &field.key,
                    Code::ComplexSingleItem,
                    format!("{} 不是可重复组，不能提交第二项", field.label),
                    Some("删掉多余的项，或把该组改成可重复".to_owned()),
                );
                field_issue.address = FieldAddress::Complex {
                    group_key: group_key.to_owned(),
                    item_id: item.item_id.clone(),
                    field_key: field.key.clone(),
                    value_index: None,
                };
                issues.push(field_issue);
            }
        }
        if field.required {
            let mut saw_content = false;
            if let Some(items) = items {
                for item in items
                    .iter()
                    .filter(|item| crate::field_pack::occupies(!item.values.is_empty(), false))
                {
                    saw_content = true;
                    let satisfied = item.values.get(&field.key).is_some_and(|value| {
                        normalize_field_values(
                            Some(value),
                            item.list_elements.get(&field.key).map(Vec::as_slice),
                        )
                        .iter()
                        .any(|normalized| !normalized.value.trim().is_empty())
                    });
                    if !satisfied {
                        let mut field_issue = issue(
                            field.key.clone(),
                            Code::Required,
                            format!("{} 为必填项", field.label),
                            Some(format!("填写「{}」后再校验", field.label)),
                        );
                        field_issue.address = FieldAddress::Complex {
                            group_key: group_key.to_owned(),
                            item_id: item.item_id.clone(),
                            field_key: field.key.clone(),
                            value_index: None,
                        };
                        issues.push(field_issue);
                    }
                }
            }
            if !saw_content {
                let item_id = items
                    .and_then(|items| items.first())
                    .map(|item| item.item_id.clone())
                    .unwrap_or_else(|| format!("{group_key}/item_0"));
                let mut field_issue = issue(
                    field.key.clone(),
                    Code::Required,
                    format!("{} 为必填项", field.label),
                    Some(format!("填写「{}」后再校验", field.label)),
                );
                field_issue.address = FieldAddress::Complex {
                    group_key: group_key.to_owned(),
                    item_id,
                    field_key: field.key.clone(),
                    value_index: None,
                };
                issues.push(field_issue);
            }
        }

        let Some(items) = items else {
            continue;
        };
        for item in items {
            let Some(raw) = item.values.get(&field.key) else {
                continue;
            };
            let elements = item.list_elements.get(&field.key).map(Vec::as_slice);
            let value_count = element_count(elements, Some(raw), false);
            if value_count == 0 {
                continue;
            }
            let address = FieldAddress::Complex {
                group_key: group_key.to_owned(),
                item_id: item.item_id.clone(),
                field_key: field.key.clone(),
                value_index: None,
            };
            if let Some(max) = field.constraints.max_value_count
                && value_count as u32 > max
            {
                let mut field_issue = issue(
                    &field.key,
                    Code::MaxValueCount,
                    format!("{} 最多允许 {max} 个值", field.label),
                    Some(format!("将「{}」减少到 {max} 个值以内", field.label)),
                );
                field_issue.address = address.clone();
                issues.push(field_issue);
            }
            let trimmed = if let Some(elements) = elements {
                elements.join(", ")
            } else {
                crate::draft::raw_value_text(raw)
            };
            validate_by_editor(
                field,
                &trimmed,
                Some(raw),
                elements,
                &mut issues,
                Some(&address),
            );
            if is_dictionary_editor(field.editor) {
                audit_dictionary(
                    field,
                    Some(raw),
                    Some(&address),
                    draft.description_category_id,
                    materials,
                    &mut issues,
                );
            }
        }
    }

    if !issues.is_empty() {
        issues.sort_by(|left, right| {
            left.field_key
                .cmp(&right.field_key)
                .then(left.code.cmp(&right.code))
        });
        return ValidationOutcome::Rejected { issues };
    }

    match build_snapshot(draft, schema, &normalized_values, materials) {
        Ok(snapshot) => ValidationOutcome::Accepted {
            normalized_values,
            snapshot,
        },
        Err(build_issues) => ValidationOutcome::Rejected {
            issues: build_issues,
        },
    }
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod known_code_tests;

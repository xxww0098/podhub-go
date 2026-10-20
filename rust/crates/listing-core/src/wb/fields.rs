use std::collections::{BTreeMap, BTreeSet};

use super::{Characteristic, FieldValue, Fields, Issue, IssueField, IssueScope, Material};
use crate::issue_keys::{WbMetadataCode, WbValidateCode};

/// Validates partial defaults or complete, already-composed variant fields.
pub fn validate_fields(fields: &[Characteristic], values: &Fields, complete: bool) -> Vec<Issue> {
    let mut issues = Vec::new();
    let indexed: BTreeMap<_, _> = fields.iter().map(|field| (field.id, field)).collect();
    for (id, value) in values {
        let code = match indexed.get(id) {
            None => Some(WbValidateCode::UnknownCharacteristic),
            Some(field) => match (field.value_kind, value) {
                (1, FieldValue::Text(values)) => {
                    if values.is_empty() || values.iter().any(|value| value.trim().is_empty()) {
                        Some(WbValidateCode::BlankText)
                    } else if field.max_count > 0 && values.len() > field.max_count as usize {
                        Some(WbValidateCode::MaxCount)
                    } else {
                        None
                    }
                }
                (4, FieldValue::Number(number)) if number.is_finite() => None,
                (4, FieldValue::Number(_)) => Some(WbValidateCode::NonfiniteNumber),
                _ => Some(WbValidateCode::ValueType),
            },
        };
        if let Some(code) = code {
            issues.push(field_issue(code, *id));
        }
    }
    if complete {
        for field in fields {
            if (field.required || field.required_for_create == Some(true))
                && !values.contains_key(&field.id)
            {
                issues.push(field_issue(WbValidateCode::Required, field.id));
            }
        }
    }
    issues
}

pub(super) fn field_issue(code: WbValidateCode, id: i64) -> Issue {
    let mut issue = Issue::new(code.key(), IssueField::Characteristic, IssueScope::Variant);
    issue.characteristic_id = Some(id);
    issue
}

/// Distinct evidence survives even when both catalog and defaults are stale.
pub fn metadata_issues(material: &Material) -> Vec<Issue> {
    let mut issues = Vec::new();
    let Some(catalog) = &material.catalog else {
        issues.push(Issue::new(
            WbMetadataCode::CatalogUnavailable.key(),
            IssueField::Catalog,
            IssueScope::Material,
        ));
        return issues;
    };
    if !catalog.usable {
        issues.push(Issue::new(
            WbMetadataCode::CatalogStale.key(),
            IssueField::Catalog,
            IssueScope::Material,
        ));
    }
    let mut ids = BTreeSet::new();
    if material.subject_id <= 0
        || catalog.content_digest.trim().is_empty()
        || catalog
            .fields
            .iter()
            .any(|field| field.id <= 0 || !ids.insert(field.id))
    {
        issues.push(Issue::new(
            WbMetadataCode::CatalogInvalid.key(),
            IssueField::Catalog,
            IssueScope::Material,
        ));
    }
    if let Some(defaults) = &material.defaults {
        if defaults.validated_catalog_digest != catalog.content_digest || defaults.revision <= 0 {
            issues.push(Issue::new(
                WbMetadataCode::DefaultsStale.key(),
                IssueField::Defaults,
                IssueScope::Material,
            ));
        }
        for mut issue in validate_fields(&catalog.fields, &defaults.values, false) {
            issue.scope = IssueScope::Material;
            issues.push(issue);
        }
    }
    issues
}

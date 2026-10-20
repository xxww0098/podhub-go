//! Pure workflow projections: Listing schema material → renderer-safe views,
//! Listing issues → workflow issues, and the AI field policy.
//!
//! No I/O.

use std::collections::BTreeMap;
#[cfg(test)]
use std::collections::BTreeSet;

use crate::{
    CategoryComplexGroup, CategoryFieldConstraints, CategoryFieldEditor, CategoryFieldOption,
    CategoryFieldSource, CategoryFieldView, CategorySchemaView, WorkflowAiFieldPolicy,
    WorkflowCategoryDraft, WorkflowDraftValue, WorkflowLanguage,
};
#[cfg(test)]
use crate::{WorkflowValidationIssue, WorkflowValidationIssueCode};

#[cfg(test)]
use super::records::FieldAddress;
use super::records::{
    CategorySchemaSnapshot, ListingFieldDefinition, ListingFieldEditor, ListingFieldOption,
};
#[cfg(test)]
use super::validate::FieldIssue;

pub const OZON_SELLER_CODE_ATTRIBUTE_ID: i64 = 9024;
pub const OZON_MODEL_NAME_ATTRIBUTE_ID: i64 = 9048;

/// An AI allow-list is never accepted on trust: a requested key must exist in
/// the pinned schema, must not be protected, and must not be read-only.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("AI field policy names a protected, unknown or read-only field")]
pub struct AiFieldPolicyInvalid;

#[cfg(test)]
pub fn resolve_ai_binding(
    existing: Option<(&str, &WorkflowAiFieldPolicy)>,
    binding: Option<(String, Vec<String>)>,
    schema: &CategorySchemaView,
) -> Result<(String, WorkflowAiFieldPolicy), AiFieldPolicyInvalid> {
    let (target_store_id, requested) = match binding {
        Some((store_id, fields)) => (store_id, fields),
        None => {
            let store_id = existing
                .map(|(store_id, _)| store_id.to_owned())
                .unwrap_or_default();
            let policy = existing
                .map(|(_, policy)| policy.clone())
                .unwrap_or_else(|| default_ai_policy(schema));
            return Ok((store_id, policy));
        }
    };
    let available = schema
        .fields
        .iter()
        .map(|field| field.key.as_str())
        .collect::<BTreeSet<_>>();
    let mut protected_field_keys = schema
        .fields
        .iter()
        .filter(|field| is_ai_protected_field(field))
        .map(|field| field.key.clone())
        .collect::<Vec<_>>();
    protected_field_keys.sort();
    protected_field_keys.dedup();
    let protected = protected_field_keys.iter().collect::<BTreeSet<_>>();
    let requested = if requested.is_empty() {
        schema
            .fields
            .iter()
            .filter(|field| !is_ai_protected_field(field) && !field.read_only)
            .map(|field| field.key.clone())
            .collect::<Vec<_>>()
    } else {
        requested
    };
    if requested.iter().any(|key| {
        !available.contains(key.as_str())
            || protected.contains(key)
            || schema
                .fields
                .iter()
                .any(|field| field.key == *key && field.read_only)
    }) {
        return Err(AiFieldPolicyInvalid);
    }
    let mut allowed_field_keys = requested;
    allowed_field_keys.sort();
    allowed_field_keys.dedup();
    Ok((
        target_store_id,
        WorkflowAiFieldPolicy {
            allowed_field_keys,
            protected_field_keys,
        },
    ))
}

pub fn default_ai_policy(schema: &CategorySchemaView) -> WorkflowAiFieldPolicy {
    let mut protected_field_keys = schema
        .fields
        .iter()
        .filter(|field| is_ai_protected_field(field))
        .map(|field| field.key.clone())
        .collect::<Vec<_>>();
    protected_field_keys.sort();
    protected_field_keys.dedup();
    let mut allowed_field_keys = schema
        .fields
        .iter()
        .filter(|field| !is_ai_protected_field(field) && !field.read_only)
        .map(|field| field.key.clone())
        .collect::<Vec<_>>();
    allowed_field_keys.sort();
    allowed_field_keys.dedup();
    WorkflowAiFieldPolicy {
        allowed_field_keys,
        protected_field_keys,
    }
}

pub fn effective_ai_policy(
    schema: &CategorySchemaView,
    stored: &WorkflowAiFieldPolicy,
) -> WorkflowAiFieldPolicy {
    if stored.allowed_field_keys.is_empty() {
        default_ai_policy(schema)
    } else {
        stored.clone()
    }
}

const PROTECTED_FIELD_KEYS: &[&str] = &[
    "price",
    "old_price",
    "depth",
    "width",
    "height",
    "dimension",
    "weight",
    "offer_id",
    "images",
    "images360",
    "primary_image",
    "color_image",
];

/// Brand, plus the two identity attributes an operator or the server owns:
///
/// - 9024 货号 (Seller code) is the definite instance identity. Like
///   `offer_id` it is pipeline-filled for a new row and never typed per row.
/// - 9048 型号 (common model) is the design identity this slice makes an
///   explicit, per-row editable value. An AI allow-list may never name it,
///   so no recognition result and no card policy can overwrite an
///   explicitly set model.
///
/// Certificate has no attribute id in this table.
const PROTECTED_ATTRIBUTE_IDS: &[i64] = &[
    85,
    OZON_SELLER_CODE_ATTRIBUTE_ID,
    OZON_MODEL_NAME_ATTRIBUTE_ID,
];

// Media ownership and the system media rule (Ozon video / cover groups).
mod media;

pub use media::{
    FieldMediaClass, SystemMediaDefaultsRefusal, SystemMediaEntry, admit_card_defaults,
    field_media_class, system_media_draft_error, system_media_write_error,
};
pub(crate) use media::{SystemMediaFields, system_media_row_refusal};

pub fn is_ai_protected_field(field: &CategoryFieldView) -> bool {
    PROTECTED_FIELD_KEYS.contains(&field.key.as_str())
        || field
            .attribute_id
            .is_some_and(|id| PROTECTED_ATTRIBUTE_IDS.contains(&id))
}

#[cfg(test)]
pub fn dictionary_candidate_issue(field: &CategoryFieldView, value: &str) -> Option<&'static str> {
    field.constraints.dictionary_id?;
    let matches = field
        .options
        .iter()
        .filter(|option| option.value == value)
        .count();
    match matches {
        0 => Some("字典值未知，未自动猜测"),
        1 => None,
        _ => Some("字典值不唯一，需要人工确认"),
    }
}

/// The field key a **plain** (non-complex) attribute carries in this Schema —
/// the address the pipeline's source-identity injection and the per-row 型号
/// column both write. `None` when the Schema names no such field, or names it
/// only inside a complex group: this slice supports a plain 9048 only, and a
/// complex-group model is reported as unsupported rather than half-filled.
pub fn plain_attribute_field_key(schema: &CategorySchemaView, attribute_id: i64) -> Option<&str> {
    schema
        .fields
        .iter()
        .find(|field| field.attribute_id == Some(attribute_id) && field.complex_id.is_none())
        .map(|field| field.key.as_str())
}

/// Stamp the source file stem onto the identity fields a new row derives from
/// its PSD / photo name.
///
/// 货号 and 型号 are separate owners here, and the split is deliberate:
///
/// - **货号** = `offer_id` plus its 9024 Seller code. The definite instance
///   identity: the pipeline's to fill, never an operator's to type. A row
///   created by the opt-in same-design import already carries a fixed
///   `PH-<row_id>` here, so this fill is a no-op for it.
/// - **型号** = plain attribute **9048**, the common model. An instance-owned
///   but *operator editable* value: the file name only stands in while the
///   draft holds no value at all. Once a model is set — by an operator, by a
///   batch assign, or by the association import's derived digest — no rebuild
///   and no rename overwrites it. "恢复独立型号" is therefore an explicit
///   assignment of a new value, never a clear that waits for the file name.
pub fn inject_source_identity(
    schema: &CategorySchemaView,
    draft: &mut WorkflowCategoryDraft,
    source_file_name: &str,
) {
    let Some(source_stem) = std::path::Path::new(source_file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
    else {
        return;
    };
    fill_text_if_blank(draft, "offer_id", source_stem.clone());
    if let Some(seller_code_key) = plain_attribute_field_key(schema, OZON_SELLER_CODE_ATTRIBUTE_ID)
    {
        fill_text_if_blank(draft, seller_code_key, source_stem.clone());
    }
    if let Some(model_key) = plain_attribute_field_key(schema, OZON_MODEL_NAME_ATTRIBUTE_ID) {
        fill_text_if_blank(draft, model_key, source_stem);
    }
}

fn fill_text_if_blank(draft: &mut WorkflowCategoryDraft, key: &str, value: String) {
    if draft_value_is_blank(draft.values.get(key)) {
        draft
            .values
            .insert(key.to_owned(), WorkflowDraftValue::Text(value));
    }
}

pub fn draft_value_is_blank(value: Option<&WorkflowDraftValue>) -> bool {
    match value {
        None => true,
        Some(WorkflowDraftValue::Text(text) | WorkflowDraftValue::Url(text)) => {
            text.trim().is_empty()
        }
        Some(WorkflowDraftValue::TextList(values) | WorkflowDraftValue::UrlList(values)) => {
            values.iter().all(|text| text.trim().is_empty())
        }
        Some(WorkflowDraftValue::IntegerList(values)) => values.is_empty(),
        Some(WorkflowDraftValue::DecimalList(values)) => values.is_empty(),
        Some(WorkflowDraftValue::BooleanList(values)) => values.is_empty(),
        Some(WorkflowDraftValue::MultiSelect(values)) => values.is_empty(),
        _ => false,
    }
}

pub fn category_schema_view(
    snapshot: &CategorySchemaSnapshot,
    language: Option<WorkflowLanguage>,
) -> CategorySchemaView {
    CategorySchemaView {
        description_category_id: snapshot.description_category_id,
        type_id: snapshot.type_id,
        language,
        fields: snapshot.fields.iter().map(category_field_view).collect(),
        complex_groups: complex_groups_from_snapshot(snapshot),
    }
}

pub fn category_field_view(field: &ListingFieldDefinition) -> CategoryFieldView {
    CategoryFieldView {
        key: field.key.clone(),
        name: field.label.clone(),
        description: field.description.clone(),
        group_name: field.group.clone(),
        source: if field.attribute_id.is_some() {
            CategoryFieldSource::Attribute
        } else {
            CategoryFieldSource::Fixed
        },
        editor: category_field_editor(field.editor),
        raw_type: field.raw_type.clone(),
        attribute_id: field.attribute_id_i64(),
        complex_id: field.complex_id_i64(),
        complex_group_collection: field.complex_group_collection,
        read_only: field.read_only,
        aspect: field.aspect,
        constraints: CategoryFieldConstraints {
            required: field.required,
            collection: field.constraints.collection,
            max_value_count: field
                .constraints
                .max_value_count
                .map(|count| count as usize),
            dictionary_id: field.dictionary_id_i64(),
        },
        options: field.options.iter().map(category_field_option).collect(),
        options_truncated: field.options_truncated,
    }
}

pub fn category_field_editor(editor: ListingFieldEditor) -> CategoryFieldEditor {
    match editor {
        ListingFieldEditor::Text => CategoryFieldEditor::Text,
        ListingFieldEditor::Integer => CategoryFieldEditor::Integer,
        ListingFieldEditor::Decimal => CategoryFieldEditor::Decimal,
        ListingFieldEditor::Boolean => CategoryFieldEditor::Boolean,
        ListingFieldEditor::SingleSelect => CategoryFieldEditor::SingleSelect,
        ListingFieldEditor::MultiSelect => CategoryFieldEditor::MultiSelect,
        ListingFieldEditor::DictionarySearch => CategoryFieldEditor::DictionarySearch,
        ListingFieldEditor::Url => CategoryFieldEditor::Url,
        ListingFieldEditor::UrlList => CategoryFieldEditor::UrlList,
    }
}

pub fn category_field_option(option: &ListingFieldOption) -> CategoryFieldOption {
    CategoryFieldOption {
        id: option.id.parse().unwrap_or(0),
        value: option.value.clone(),
        info: option.info.clone(),
        picture: option.picture.clone(),
    }
}

pub fn complex_groups_from_snapshot(
    snapshot: &CategorySchemaSnapshot,
) -> Vec<CategoryComplexGroup> {
    let mut grouped = BTreeMap::<i64, CategoryComplexGroup>::new();
    for field in &snapshot.fields {
        let Some(complex_id) = field.complex_id_i64() else {
            continue;
        };
        let group = grouped
            .entry(complex_id)
            .or_insert_with(|| CategoryComplexGroup {
                complex_id,
                name: field.group.clone(),
                collection: field.complex_group_collection,
                field_keys: Vec::new(),
            });
        group.collection |= field.complex_group_collection;
        group.field_keys.push(field.key.clone());
    }
    grouped.into_values().collect()
}

#[cfg(test)]
pub fn workflow_issue_from_listing(issue: FieldIssue) -> WorkflowValidationIssue {
    let complex_id = match &issue.address {
        FieldAddress::Complex { group_key, .. } => group_key.parse().ok(),
        FieldAddress::Plain { .. } => None,
    };
    let item_index = match &issue.address {
        FieldAddress::Complex { item_id, .. } => item_id
            .rsplit(['-', '/'])
            .next()
            .and_then(|value| value.parse().ok()),
        FieldAddress::Plain { .. } => None,
    };
    WorkflowValidationIssue {
        field_key: issue.field_key,
        code: match issue.code.as_str() {
            "required" => WorkflowValidationIssueCode::Required,
            "max_value_count" => WorkflowValidationIssueCode::Cardinality,
            "offer_id_too_long" | "offer_id_charset" => WorkflowValidationIssueCode::Range,
            _ => WorkflowValidationIssueCode::Type,
        },
        message: issue.message,
        value_index: None,
        complex_id,
        item_index,
    }
}

#[cfg(test)]
mod tests;

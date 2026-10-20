//! Domain draft, schema and recognition values.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use super::{FieldAddress, WorkflowLanguage};

/// One selected value from an Ozon dictionary.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowDraftSelection {
    pub dictionary_value_id: i64,
    pub value: String,
}

/// Renderer-safe typed value accepted by the canonical Rust validator.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum WorkflowDraftValue {
    Text(String),
    TextList(Vec<String>),
    Integer(i64),
    IntegerList(Vec<i64>),
    Decimal(f64),
    DecimalList(Vec<f64>),
    Boolean(bool),
    BooleanList(Vec<bool>),
    SingleSelect(WorkflowDraftSelection),
    MultiSelect(Vec<WorkflowDraftSelection>),
    Url(String),
    UrlList(Vec<String>),
}

/// One item inside a repeated complex Ozon attribute group.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkflowComplexDraftItem {
    /// Stable identity. Empty only on a placeholder that occupies nothing.
    /// Never an index (`workflow-{group}-{n}` or `item_{n}`).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub item_id: String,
    pub values: BTreeMap<String, WorkflowDraftValue>,
}

/// Values for one complex group. A vector keeps numeric IDs lossless across serde.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowComplexDraftGroup {
    pub complex_id: i64,
    pub items: Vec<WorkflowComplexDraftItem>,
}

/// Complete dynamic Draft submitted for validation.
///
/// Occupancy is three-way: a missing key is unset, a present key is a value
/// (`0` / `false` included), and [`Self::cleared`] is an explicit empty that
/// fill-empty and overlay must not restore.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkflowCategoryDraft {
    pub values: BTreeMap<String, WorkflowDraftValue>,
    pub complex_values: Vec<WorkflowComplexDraftGroup>,
    /// Plain field keys the operator cleared. Absent from `values` on purpose.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub cleared: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowAiFieldPolicy {
    pub allowed_field_keys: Vec<String>,
    pub protected_field_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowAiResult {
    pub ru: String,
    pub tags: Vec<String>,
    pub description: String,
    pub model: String,
    /// What Cloud charged for this recognition, in microfen.
    ///
    /// Every request is bought, and the account-level usage panel can only
    /// answer "what did this workspace spend this week" — not "what did the batch I
    /// just ran cost", which is the question an operator asks before running
    /// another one. Carried per result so the batch can be totalled.
    #[serde(default)]
    pub cost_microfen: i64,
    #[serde(default)]
    pub candidates: Vec<WorkflowAiCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowAiCandidateState {
    Proposed,
    Confirmed,
    Rejected,
    Unresolved,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkflowAiCandidate {
    pub address: FieldAddress,
    pub value: WorkflowDraftValue,
    /// Snapshot of the reviewed value at candidate arrival; this is display
    /// evidence only and is never trusted for persistence.
    #[serde(default)]
    pub current_value: Option<WorkflowDraftValue>,
    pub source: String,
    pub state: WorkflowAiCandidateState,
    pub issue: Option<String>,
}

/// Stable validator issue kinds mirrored from `seller-api`.
#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowValidationIssueCode {
    Required,
    Type,
    Cardinality,
    UnknownOption,
    DictionaryId,
    UnknownField,
    Range,
    Coordinate,
    ComplexPlacement,
}

/// One field-local issue returned to the form.
#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowValidationIssue {
    pub field_key: String,
    pub code: WorkflowValidationIssueCode,
    pub message: String,
    pub value_index: Option<usize>,
    pub complex_id: Option<i64>,
    pub item_index: Option<usize>,
}

/// Renderer-safe field origin.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryFieldSource {
    Fixed,
    Attribute,
}

/// Renderer-safe editor choice for a dynamic category field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CategoryFieldEditor {
    Text,
    Integer,
    Decimal,
    Boolean,
    SingleSelect,
    MultiSelect,
    DictionarySearch,
    Url,
    UrlList,
}

/// Cardinality and dictionary constraints projected to the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryFieldConstraints {
    pub required: bool,
    pub collection: bool,
    pub max_value_count: Option<usize>,
    pub dictionary_id: Option<i64>,
}

/// One inline dictionary option projected to the renderer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryFieldOption {
    pub id: i64,
    pub value: String,
    pub info: String,
    pub picture: String,
}

/// One fixed or category-specific field in display/API order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryFieldView {
    pub key: String,
    pub name: String,
    pub description: String,
    pub group_name: String,
    pub source: CategoryFieldSource,
    pub editor: CategoryFieldEditor,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub raw_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attribute_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complex_id: Option<i64>,
    pub complex_group_collection: bool,
    pub read_only: bool,
    /// Ozon `is_aspect`: does this field distinguish variants of one model?
    ///
    /// Serialized even when unknown: `true`/`false` are Seller facts and
    /// `null` means the category material predates aspect metadata, which the
    /// browser must turn into "refresh the material" — never into "this
    /// category has no variant dimensions".
    pub aspect: Option<bool>,
    pub constraints: CategoryFieldConstraints,
    pub options: Vec<CategoryFieldOption>,
    pub options_truncated: bool,
}

/// One complex-attribute group and its field membership.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategoryComplexGroup {
    pub complex_id: i64,
    pub name: String,
    pub collection: bool,
    pub field_keys: Vec<String>,
}

/// Complete renderer-safe category schema snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategorySchemaView {
    pub description_category_id: i64,
    pub type_id: i64,
    pub language: Option<WorkflowLanguage>,
    pub fields: Vec<CategoryFieldView>,
    pub complex_groups: Vec<CategoryComplexGroup>,
}

// ===== video.rs =====

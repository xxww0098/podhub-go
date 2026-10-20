use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::protocol;
use crate::issue_keys::KnownIssueKey;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Ru,
    En,
    Zh,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Characteristic {
    pub id: i64,
    pub name: String,
    pub required: bool,
    pub value_kind: u32,
    pub max_count: u32,
    pub unit_name: Option<String>,
    pub popular: bool,
    pub has_filter: bool,
    pub is_variable: bool,
    pub required_for_create: Option<bool>,
    pub named_field: Option<bool>,
}

/// Scalar text is deliberately absent: upload text must be an array.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FieldValue {
    Text(Vec<String>),
    Number(f64),
}

pub type Fields = BTreeMap<i64, FieldValue>;

/// Cloud supplies usability. This module neither reads time nor owns expiry policy.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Catalog {
    pub fields: Vec<Characteristic>,
    pub content_digest: String,
    pub usable: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Defaults {
    pub values: Fields,
    pub revision: i64,
    pub validated_catalog_digest: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Material {
    pub subject_id: i64,
    pub language: Language,
    pub catalog: Option<Catalog>,
    pub defaults: Option<Defaults>,
}

/// One native group, with variants retained in the user's order.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WbProductConfig {
    pub subject_id: i64,
    pub language: Language,
    pub variants: Vec<VariantConfig>,
}

/// Named fields are owned by each variant; only characteristics inherit catalog
/// defaults. Protocol leaf records have no competing domain semantics.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VariantConfig {
    pub vendor_code: String,
    pub title: Option<String>,
    pub brand: Option<String>,
    pub description: Option<String>,
    pub kiz_marked: Option<bool>,
    pub wholesale: Option<protocol::Wholesale>,
    pub dimensions: Option<protocol::Dimensions>,
    #[serde(default)]
    pub sizes: Vec<protocol::CardSize>,
    pub documents: Option<protocol::CardDocuments>,
    #[serde(default)]
    pub characteristics: Fields,
    /// A clear is an explicit ownership decision and wins over a manual value.
    #[serde(default)]
    pub cleared: BTreeSet<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueField {
    Catalog,
    Defaults,
    Subject,
    Language,
    Variants,
    VendorCode,
    Title,
    Dimensions,
    Characteristic,
    Payload,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IssueScope {
    Material,
    Group,
    Variant,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub key: KnownIssueKey,
    pub field: IssueField,
    pub characteristic_id: Option<i64>,
    pub variant_index: Option<usize>,
    pub scope: IssueScope,
}

impl Issue {
    pub(super) fn new(key: KnownIssueKey, field: IssueField, scope: IssueScope) -> Self {
        Self {
            key,
            field,
            characteristic_id: None,
            variant_index: None,
            scope,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    /// Absent on any refusal; no partial body can accidentally be uploaded.
    pub group: Option<protocol::CardGroup>,
    /// Exact UTF-8 upload bytes, including the outer group array.
    pub upload_bytes: Option<Vec<u8>>,
    pub issues: Vec<Issue>,
}

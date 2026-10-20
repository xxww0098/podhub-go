//! Cloud's server-side view of the Seller category schema cache wire.
//! Goldens under `fixtures/cloud/goldens` pin the bytes.

use serde::{Deserialize, Serialize};

/// Language variant of the cached Seller category schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CatalogSchemaLanguage {
    Default,
    Ru,
    En,
    Tr,
    ZhHans,
}

impl CatalogSchemaLanguage {
    /// Stable storage key for the cache table.
    pub fn key(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Ru => "ru",
            Self::En => "en",
            Self::Tr => "tr",
            Self::ZhHans => "zh_hans",
        }
    }
}

/// Editor kind of one cached field — the same closed set and snake_case values
/// as `listing::records::ListingFieldEditor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum CatalogSchemaEditor {
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

/// One dictionary option carried with a field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaOption {
    pub id: String,
    pub value: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub info: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub picture: String,
}

/// One cached field. `collection` / `max_value_count` / `dictionary_id` are
/// flattened here: the cache carries field material, not nested constraints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaField {
    pub key: String,
    pub label: String,
    pub group: String,
    pub editor: CatalogSchemaEditor,
    pub required: bool,
    pub collection: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_value_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dictionary_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attribute_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub complex_id: Option<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub raw_type: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub complex_group_collection: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub options: Vec<CatalogSchemaOption>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub options_truncated: bool,
    /// Ozon `is_aspect` for this field's Seller attribute. Absent = unknown:
    /// the payload was written before aspect metadata existed, and
    /// `variants::carries_aspect_metadata` refuses to read it as "no variant
    /// dimensions". Kept omitted-when-unknown rather than written as `null`
    /// so one rule covers both an old payload and a field that has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub aspect: Option<bool>,
}

/// The cached material for one `(category, type, language)` coordinate. No
/// `schema_revision`: it is recomputed from the fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaData {
    pub description_category_id: i64,
    pub type_id: i64,
    pub language: CatalogSchemaLanguage,
    pub fetched_at_ms: i64,
    pub fields: Vec<CatalogSchemaField>,
    /// Read-only projection for the browser's `schema_load`, built per GET from
    /// exactly `fields` above. Never part of the stored payload or any hash
    /// input; `None` only on historical fixtures, a served GET always sets it.
    #[serde(
        default,
        rename = "nativeMaterial",
        skip_serializing_if = "Option::is_none"
    )]
    pub native_material: Option<CatalogSchemaNativeMaterial>,
}

/// `listing-core-wasm`'s `SchemaLoadInput` wire shape: the native snapshot plus
/// the same Seller-confirmed search bag native validation reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSchemaNativeMaterial {
    /// Native `CategorySchemaSnapshot` serde is authoritative; OpenAPI leaves
    /// it opaque rather than mirroring every native model.
    #[cfg_attr(feature = "openapi", schema(value_type = Object))]
    pub snapshot: crate::records::CategorySchemaSnapshot,
    pub search_materials: Vec<CatalogSearchMaterialEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogSearchMaterialEntry {
    pub description_category_id: i64,
    pub attribute_id: i64,
    pub dictionary_id: i64,
    pub value_id: i64,
    pub label: String,
}

/// `data: null` on a fresh miss or an expired entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaResponse {
    pub data: Option<CatalogSchemaData>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaWriteRequest {
    pub description_category_id: i64,
    pub type_id: i64,
    pub language: CatalogSchemaLanguage,
    pub fields: Vec<CatalogSchemaField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaWriteData {
    pub description_category_id: i64,
    pub type_id: i64,
    pub language: CatalogSchemaLanguage,
    pub fetched_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogSchemaWriteResponse {
    pub data: CatalogSchemaWriteData,
}

/// Platform-authenticated live dictionary lookup; no Store credential selector.
#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(deny_unknown_fields)]
pub struct CatalogDictionarySearchRequest {
    pub attribute_id: i64,
    pub description_category_id: i64,
    pub type_id: i64,
    #[serde(default)]
    pub language: Option<CatalogSchemaLanguage>,
    pub limit: i64,
    pub value: String,
}

#[derive(Debug, Serialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
pub struct CatalogDictionarySearchResponse {
    pub data: Vec<CatalogSchemaOption>,
}

//! Leaf listing types that persistence may name without importing listing behavior.
//!
//! No SQL or HTTP. Behavior modules import these types; this module
//! does not import draft/plan/schema/validate/media_exec or store.

use std::collections::BTreeMap;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

/// Persisted listing envelope version. Kept here so this
/// leaf stays free of persistence imports.
pub const CURRENT_ENVELOPE_VERSION: i32 = 1;

/// Row-decode report attached when Store cannot read a column.
///
/// Lives next to [`ListingDraftRecord`] so records stays a leaf. Store envelope
/// helpers re-export this single declaration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DecodeFailure {
    pub table: String,
    pub row: String,
    pub column: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum RawDraftValue {
    Text(String),
    OneChoice(ChoiceValue),
    ManyChoices(Vec<ChoiceValue>),
    ClearedChoice,
}

#[cfg(test)]
impl RawDraftValue {
    pub fn has_content(&self) -> bool {
        match self {
            Self::Text(value) => !value.trim().is_empty(),
            Self::OneChoice(choice) => {
                !choice.id.trim().is_empty() || !choice.label.trim().is_empty()
            }
            Self::ManyChoices(choices) => !choices.is_empty(),
            Self::ClearedChoice => false,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChoiceValue {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ComplexDraftItem {
    pub item_id: String,
    pub values: BTreeMap<String, RawDraftValue>,
    /// Element lists for this item. Not a second raw variant.
    #[serde(default)]
    pub list_elements: BTreeMap<String, Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum FieldValueOriginKind {
    CardDefault,
    SellerSku,
    #[default]
    Manual,
    AiConfirmed,
    SystemMedia,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FieldValueOrigin {
    pub address: FieldAddress,
    pub kind: FieldValueOriginKind,
    #[serde(default)]
    pub source_ref: Option<String>,
    pub updated_at_ms: u64,
}

/// Form control vocabulary for Listing's pinned Category Schema.
///
/// This is the same closed set as the workflow renderer DTO
/// (`CategoryFieldEditor`). Submission validation must not collapse these
/// into Text/Number.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ListingFieldEditor {
    #[default]
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

/// One inline dictionary option pinned with a Category Schema field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ListingFieldOption {
    pub id: String,
    pub value: String,
    #[serde(default)]
    pub info: String,
    #[serde(default)]
    pub picture: String,
}

/// Cardinality and dictionary constraints pinned with the schema revision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ListingFieldConstraints {
    pub collection: bool,
    #[serde(default)]
    pub max_value_count: Option<u32>,
    #[serde(default)]
    pub dictionary_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ListingFieldDefinition {
    pub key: String,
    pub label: String,
    pub group: String,
    pub editor: ListingFieldEditor,
    pub required: bool,
    #[serde(default)]
    pub constraints: ListingFieldConstraints,
    pub attribute_id: Option<String>,
    #[serde(default)]
    pub complex_id: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub raw_type: Option<String>,
    #[serde(default)]
    pub read_only: bool,
    #[serde(default)]
    pub complex_group_collection: bool,
    #[serde(default)]
    pub options: Vec<ListingFieldOption>,
    #[serde(default)]
    pub options_truncated: bool,
    /// Ozon `is_aspect` for the Seller attribute this field was built from:
    /// does it distinguish variants of one model?
    ///
    /// Three states, and the third is not the second: `Some(true)` = yes,
    /// `Some(false)` = known not to, `None` = **unknown** — material written
    /// before aspect metadata existed. `None` must never be read as `false`;
    /// `variants::resolve_variant_rule` refuses the whole category instead.
    ///
    /// Fixed listing fields (`offer_id`, `price`, …) have no Seller attribute
    /// and stay `None` — they are not "unknown", they simply have no variant
    /// role to report. `variants::declares_aspect` is the distinction.
    #[serde(default)]
    pub aspect: Option<bool>,
}

impl ListingFieldDefinition {
    // `test-support`, not plain `test`: `categories::decorative_wall_art`
    // (also `test-support`-gated, a cross-crate fixture — see its own doc
    // comment) calls this.
    #[cfg(any(test, feature = "test-support"))]
    pub fn plain(
        key: impl Into<String>,
        label: impl Into<String>,
        group: impl Into<String>,
        editor: ListingFieldEditor,
        required: bool,
    ) -> Self {
        Self {
            key: key.into(),
            label: label.into(),
            group: group.into(),
            editor,
            required,
            ..Self::default()
        }
    }

    /// Key a fixed attribute gets when the Seller schema names no field key.
    pub fn attribute_key(attribute_id: i64) -> String {
        format!("attribute_{attribute_id}")
    }

    pub fn attribute_id_i64(&self) -> Option<i64> {
        self.attribute_id.as_deref()?.parse().ok()
    }

    pub fn complex_id_i64(&self) -> Option<i64> {
        self.complex_id.as_deref()?.parse().ok()
    }

    pub fn dictionary_id_i64(&self) -> Option<i64> {
        self.constraints.dictionary_id.as_deref()?.parse().ok()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CategorySchemaSnapshot {
    pub category_key: String,
    pub label: String,
    pub description_category_id: i64,
    pub type_id: i64,
    pub schema_revision: String,
    pub recipe_id: i64,
    pub recipe_revision: i64,
    pub catalog_schema_version: u32,
    pub fields: Vec<ListingFieldDefinition>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ListingLifecycleState {
    Draft,
    Validated,
    Planned,
}

/// Field addressing shared by Candidate Edits and Listing CAS. One type for
/// both sides: the record's normalized `item_id` and the workflow wire's raw
/// one are the same shape, and persistence may name this leaf.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FieldAddress {
    Plain {
        field_key: String,
    },
    Complex {
        group_key: String,
        item_id: String,
        field_key: String,
        #[serde(default)]
        value_index: Option<u32>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedAttributeValue {
    pub value: String,
    pub dictionary_value_id: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedAttribute {
    pub id: i64,
    pub complex_id: i64,
    pub values: Vec<NormalizedAttributeValue>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedComplexAttributeGroup {
    pub complex_id: i64,
    pub attributes: Vec<NormalizedAttribute>,
}

/// Normalized listing snapshot persisted on Draft → Validated.
///
/// Media URLs (`primary_image` / `images`) are intentionally absent: media
/// travels separately (`product_import::ProductImportMedia`); serializer
/// cross-check covers validation-covered fields only.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NormalizedListingSnapshot {
    pub draft_revision: u64,
    pub schema_revision: String,
    pub offer_id: String,
    pub barcode: Option<String>,
    pub name: String,
    pub description: String,
    pub description_category_id: i64,
    pub type_id: i64,
    pub price: String,
    pub old_price: String,
    pub currency_code: String,
    pub vat: String,
    pub depth: u64,
    pub width: u64,
    pub height: u64,
    pub dimension_unit: String,
    pub weight: u64,
    pub weight_unit: String,
    pub attributes: Vec<NormalizedAttribute>,
    #[serde(default)]
    pub complex_attributes: Vec<NormalizedComplexAttributeGroup>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedMediaOperation {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub effect: String,
    pub depends_on: Vec<String>,
    pub produces: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PlannedOzonOperation {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub effect: String,
    pub depends_on: Vec<String>,
    pub produces: Vec<String>,
}

/// Pure, user-visible Execution Plan for a Validated listing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionPlan {
    pub draft_id: String,
    pub draft_revision: u64,
    pub category_key: String,
    pub description_category_id: i64,
    pub type_id: i64,
    pub schema_revision: String,
    pub recipe_id: i64,
    pub recipe_revision: i64,
    pub catalog_schema_version: u32,
    pub offer_id: String,
    pub media_operations: Vec<PlannedMediaOperation>,
    pub ozon_operations: Vec<PlannedOzonOperation>,
    pub topological_order: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListingDraftRecord {
    pub draft_id: String,
    #[serde(default = "default_draft_revision")]
    pub draft_revision: u64,
    pub category_key: String,
    pub description_category_id: i64,
    pub type_id: i64,
    pub schema_revision: String,
    pub recipe_id: i64,
    pub recipe_revision: i64,
    pub catalog_schema_version: u32,
    pub schema_snapshot: Arc<CategorySchemaSnapshot>,
    pub field_values: BTreeMap<String, String>,
    #[serde(default)]
    pub raw_values: BTreeMap<String, RawDraftValue>,
    /// Element lists keyed by field. Production validation reads these.
    /// `RawDraftValue` does not carry a list variant.
    #[serde(default)]
    pub list_elements: BTreeMap<String, Vec<String>>,
    #[serde(default)]
    pub complex_values: BTreeMap<String, Vec<ComplexDraftItem>>,
    #[serde(default)]
    pub field_origins: Vec<FieldValueOrigin>,
    pub lifecycle_state: ListingLifecycleState,
    pub normalized_snapshot: Option<NormalizedListingSnapshot>,
    pub execution_plan: Option<ExecutionPlan>,
    pub updated_at_ms: u64,
    #[serde(default = "default_envelope_version")]
    pub envelope_version: i32,
    /// Schema or field values could not be decoded; draft is listed but unusable.
    #[serde(default)]
    pub unusable: bool,
    /// Stored plan (or normalized snapshot) could not be decoded; preview again.
    #[serde(default)]
    pub preview_required: bool,
    #[serde(default)]
    pub decode_failures: Vec<DecodeFailure>,
}

fn default_envelope_version() -> i32 {
    CURRENT_ENVELOPE_VERSION
}

fn default_draft_revision() -> u64 {
    1
}

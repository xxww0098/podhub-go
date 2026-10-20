//! The SKU import wire and preview model: the Seller product material a SKU
//! lookup returns, the schema slice the projection reads, and the candidates
//! it answers with.

use serde::{Deserialize, Serialize};

use crate::records::ListingFieldEditor;

/// Read-only Seller product material a SKU lookup returns. The transport that
/// fills it lives in `seller_egress`; these leaves stay pure so the projection
/// below is testable without a Seller call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellerSkuAttributeValue {
    pub dictionary_value_id: i64,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellerSkuAttribute {
    pub id: i64,
    pub complex_id: i64,
    pub values: Vec<SellerSkuAttributeValue>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellerSkuComplexItem {
    pub attributes: Vec<SellerSkuAttribute>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SellerSkuSnapshot {
    pub sku: i64,
    pub product_id: i64,
    pub offer_id: String,
    pub name: String,
    pub description_category_id: i64,
    pub type_id: i64,
    pub price: String,
    pub old_price: String,
    pub currency_code: String,
    pub vat: String,
    pub width: i64,
    pub height: i64,
    pub depth: i64,
    pub dimension_unit: String,
    pub weight: i64,
    pub weight_unit: String,
    pub attributes: Vec<SellerSkuAttribute>,
    pub complex_items: Vec<SellerSkuComplexItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SkuImportOption {
    pub id: i64,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SkuImportSchemaField {
    pub key: String,
    pub name: String,
    pub group_name: String,
    /// Same closed control vocabulary as Listing Category Schema (C7).
    pub editor: ListingFieldEditor,
    pub collection: bool,
    pub read_only: bool,
    pub attribute_id: Option<i64>,
    pub complex_id: Option<i64>,
    pub options: Vec<SkuImportOption>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct SkuImportSchema {
    pub description_category_id: i64,
    pub type_id: i64,
    pub fields: Vec<SkuImportSchemaField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SkuImportSelection {
    pub dictionary_value_id: i64,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum SkuImportValue {
    Text(String),
    TextList(Vec<String>),
    Integer(i64),
    IntegerList(Vec<i64>),
    Decimal(f64),
    DecimalList(Vec<f64>),
    Boolean(bool),
    BooleanList(Vec<bool>),
    SingleSelect(SkuImportSelection),
    MultiSelect(Vec<SkuImportSelection>),
    Url(String),
    UrlList(Vec<String>),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SkuImportLocation {
    Plain,
    Complex { complex_id: i64, item_index: usize },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkuImportCandidate {
    pub candidate_id: String,
    pub field_key: String,
    pub field_name: String,
    pub group_name: String,
    pub location: SkuImportLocation,
    pub value: SkuImportValue,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SkuImportPreview {
    pub source_sku: i64,
    pub source_product_id: i64,
    pub source_offer_id: String,
    pub source_name: String,
    pub source_description_category_id: i64,
    pub source_type_id: i64,
    pub category_matches: bool,
    pub candidates: Vec<SkuImportCandidate>,
    pub skipped_fields: usize,
}

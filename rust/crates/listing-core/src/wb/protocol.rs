//! WB upload protocol; independent of HTTP response DTOs.
use serde::{Deserialize, Serialize};

/// One group of individual or merged product-card variants.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardGroup {
    /// WB subject ID (`subjectID`).
    #[serde(rename = "subjectID")]
    pub subject_id: u64,
    /// One to 30 variants.
    pub variants: Vec<CardVariant>,
}

/// One product card to create.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardVariant {
    /// Seller article. Required by WB and limited to 72 characters.
    pub vendor_code: String,
    /// Brand.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brand: Option<String>,
    /// Product title, limited to 60 characters.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// Product description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Seller confirmation that mandatory marking is present.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kiz_marked: Option<bool>,
    /// Wholesale configuration.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wholesale: Option<Wholesale>,
    /// Packed dimensions in centimetres and kilograms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dimensions: Option<Dimensions>,
    /// Product sizes.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub sizes: Vec<CardSize>,
    /// Product characteristics.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub characteristics: Vec<CardCharacteristic>,
    /// Product documents accepted by WB for the card.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub documents: Option<CardDocuments>,
}

/// Wholesale sale settings.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Wholesale {
    /// Whether wholesale sale is enabled.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    /// Units in one wholesale package.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quantum: Option<u64>,
}

/// Packed product dimensions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dimensions {
    /// Length in centimetres.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<u32>,
    /// Width in centimetres.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    /// Height in centimetres.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    /// Gross weight in kilograms.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight_brutto: Option<f64>,
}

/// A product size in an upload request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSize {
    /// Technical size, such as `XL`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tech_size: Option<String>,
    /// WB/Russian size.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wb_size: Option<String>,
    /// Price in the smallest whole currency unit used by WB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<u64>,
    /// Barcodes associated with the size.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skus: Vec<String>,
}

/// Characteristic value in a WB upload. Scalar response text is not an upload value.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CharacteristicValue {
    /// One or more text values.
    Strings(Vec<String>),
    /// An integer or decimal JSON number.
    Number(serde_json::Number),
}

/// A characteristic attached to an uploaded card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CardCharacteristic {
    /// Characteristic ID.
    pub id: u64,
    /// Value matching the characteristic's `charcType`.
    pub value: CharacteristicValue,
}

/// Document settings attached to an uploaded card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDocuments {
    /// Document records.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<CardDocument>,
    /// Skip document checks and clear supplied document values when `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exclude_documents: Option<bool>,
}

/// One compliance document attached to an uploaded card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDocument {
    /// WB document type code.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub document_type: Option<u8>,
    /// Document number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<String>,
    /// Additional product-specific document number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_number: Option<String>,
    /// Registered trade name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trade_name: Option<String>,
    /// Manufacturer representative or applicant.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applicant: Option<String>,
    /// Validity start date-time as supplied to WB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_date: Option<String>,
    /// Validity end date-time as supplied to WB.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_date: Option<String>,
    /// Whether the document has no expiry date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_endless: Option<bool>,
}

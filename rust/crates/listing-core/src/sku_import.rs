//! Seller SKU → Listing Draft candidate projection.
//!
//! Candidates are pure previews. Application is the same Draft edit interface
//! used by AI/manual edits, with [`FieldValueOriginKind::SellerSku`]. Editor
//! vocabulary is Listing's closed set — not a fourth parallel enum (C7).
//!
//! [`FieldValueOriginKind::SellerSku`]: crate::records::FieldValueOriginKind::SellerSku

use crate::projections::{FieldMediaClass, field_media_class};
use crate::{
    DESCRIPTION_ATTRIBUTE_ID, RICH_CONTENT_ATTRIBUTE_ID, SEARCH_TAGS_ATTRIBUTE_ID,
    THEME_ATTRIBUTE_ID,
};

use super::records::ListingFieldEditor;

// The SKU material, schema slice and preview model.
mod model;
// Seller attribute values → typed candidate values.
mod convert;

#[cfg(test)]
pub use convert::candidates_to_originated_edits;
use convert::convert_value;
pub use model::{
    SellerSkuAttribute, SellerSkuAttributeValue, SellerSkuComplexItem, SellerSkuSnapshot,
    SkuImportCandidate, SkuImportLocation, SkuImportOption, SkuImportPreview, SkuImportSchema,
    SkuImportSchemaField, SkuImportSelection, SkuImportValue,
};

const SELLER_CODE_ATTRIBUTE_ID: i64 = 9024;
const MODEL_NAME_ATTRIBUTE_ID: i64 = 9048;

/// Project a renderer-safe category schema view onto the SKU import schema.
/// Editors are Listing's closed vocabulary — no parallel SKU-only enum.
pub fn sku_import_schema(schema: &crate::CategorySchemaView) -> SkuImportSchema {
    SkuImportSchema {
        description_category_id: schema.description_category_id,
        type_id: schema.type_id,
        fields: schema
            .fields
            .iter()
            .map(|field| SkuImportSchemaField {
                key: field.key.clone(),
                name: field.name.clone(),
                group_name: field.group_name.clone(),
                editor: listing_editor_from_workflow(field.editor),
                collection: field.constraints.collection,
                read_only: field.read_only,
                attribute_id: field.attribute_id,
                complex_id: field.complex_id,
                options: field
                    .options
                    .iter()
                    .map(|option| SkuImportOption {
                        id: option.id,
                        value: option.value.clone(),
                    })
                    .collect(),
            })
            .collect(),
    }
}

fn listing_editor_from_workflow(editor: crate::CategoryFieldEditor) -> ListingFieldEditor {
    match editor {
        crate::CategoryFieldEditor::Text => ListingFieldEditor::Text,
        crate::CategoryFieldEditor::Integer => ListingFieldEditor::Integer,
        crate::CategoryFieldEditor::Decimal => ListingFieldEditor::Decimal,
        crate::CategoryFieldEditor::Boolean => ListingFieldEditor::Boolean,
        crate::CategoryFieldEditor::SingleSelect => ListingFieldEditor::SingleSelect,
        crate::CategoryFieldEditor::MultiSelect => ListingFieldEditor::MultiSelect,
        crate::CategoryFieldEditor::DictionarySearch => ListingFieldEditor::DictionarySearch,
        crate::CategoryFieldEditor::Url => ListingFieldEditor::Url,
        crate::CategoryFieldEditor::UrlList => ListingFieldEditor::UrlList,
    }
}

pub fn preview_sku_import(
    schema: &SkuImportSchema,
    source: &SellerSkuSnapshot,
) -> SkuImportPreview {
    let category_matches = schema.description_category_id == source.description_category_id
        && schema.type_id == source.type_id;
    let mut candidates = Vec::new();
    let mut skipped_fields = 0;

    if category_matches {
        for field in &schema.fields {
            if field.read_only || excluded_field(field) {
                skipped_fields += 1;
                continue;
            }
            let values = if let Some(attribute_id) = field.attribute_id {
                source
                    .attributes
                    .iter()
                    .find(|attribute| {
                        attribute.id == attribute_id
                            && field.complex_id.unwrap_or_default() == attribute.complex_id
                    })
                    .map(|attribute| attribute.values.clone())
            } else {
                fixed_values(source, &field.key)
            };
            let Some(values) = values else {
                skipped_fields += 1;
                continue;
            };
            let Some(value) = convert_value(field, &values) else {
                skipped_fields += 1;
                continue;
            };
            candidates.push(SkuImportCandidate {
                candidate_id: format!("plain:{}", field.key),
                field_key: field.key.clone(),
                field_name: field.name.clone(),
                group_name: field.group_name.clone(),
                location: SkuImportLocation::Plain,
                value,
            });
        }

        for (item_index, item) in source.complex_items.iter().enumerate() {
            for attribute in &item.attributes {
                let Some(field) = schema.fields.iter().find(|field| {
                    field.attribute_id == Some(attribute.id)
                        && field.complex_id == Some(attribute.complex_id)
                        && !field.read_only
                        && !excluded_field(field)
                }) else {
                    skipped_fields += 1;
                    continue;
                };
                let Some(value) = convert_value(field, &attribute.values) else {
                    skipped_fields += 1;
                    continue;
                };
                candidates.push(SkuImportCandidate {
                    candidate_id: format!(
                        "complex:{}:{item_index}:{}",
                        attribute.complex_id, field.key
                    ),
                    field_key: field.key.clone(),
                    field_name: field.name.clone(),
                    group_name: field.group_name.clone(),
                    location: SkuImportLocation::Complex {
                        complex_id: attribute.complex_id,
                        item_index,
                    },
                    value,
                });
            }
        }
    }

    SkuImportPreview {
        source_sku: source.sku,
        source_product_id: source.product_id,
        source_offer_id: source.offer_id.clone(),
        source_name: source.name.clone(),
        source_description_category_id: source.description_category_id,
        source_type_id: source.type_id,
        category_matches,
        candidates,
        skipped_fields,
    }
}

/// Fields a SKU never contributes: one row's identity and media, the
/// per-image copy, and system media (the product-video and video-cover
/// groups), which only send-time media evidence writes. System media is named
/// by the Native media rule itself rather than a copy of its ids here.
fn excluded_field(field: &SkuImportSchemaField) -> bool {
    matches!(
        field.key.as_str(),
        "offer_id"
            | "barcode"
            | "name"
            | "images"
            | "images360"
            | "primary_image"
            | "color_image"
            | "description_category_id"
            | "type_id"
    ) || matches!(
        field.attribute_id,
        Some(
            DESCRIPTION_ATTRIBUTE_ID
                | SELLER_CODE_ATTRIBUTE_ID
                | MODEL_NAME_ATTRIBUTE_ID
                | SEARCH_TAGS_ATTRIBUTE_ID
                | RICH_CONTENT_ATTRIBUTE_ID
                | THEME_ATTRIBUTE_ID,
        )
    ) || is_system_media(field)
}

fn is_system_media(field: &SkuImportSchemaField) -> bool {
    field_media_class(&field.key, field.attribute_id, field.complex_id) == FieldMediaClass::System
}

fn fixed_values(source: &SellerSkuSnapshot, key: &str) -> Option<Vec<SellerSkuAttributeValue>> {
    let (dictionary_value_id, value) = match key {
        "price" => (0, source.price.as_str()),
        "old_price" => (0, source.old_price.as_str()),
        "currency_code" => (0, source.currency_code.as_str()),
        "vat" => (0, source.vat.as_str()),
        "width" => return positive_integer_value(source.width),
        "height" => return positive_integer_value(source.height),
        "depth" => return positive_integer_value(source.depth),
        "dimension_unit" => (0, source.dimension_unit.as_str()),
        "weight" => return positive_integer_value(source.weight),
        "weight_unit" => (0, source.weight_unit.as_str()),
        _ => return None,
    };
    if value.trim().is_empty() {
        return None;
    }
    Some(vec![SellerSkuAttributeValue {
        dictionary_value_id,
        value: value.to_owned(),
    }])
}

fn positive_integer_value(value: i64) -> Option<Vec<SellerSkuAttributeValue>> {
    (value > 0).then(|| {
        vec![SellerSkuAttributeValue {
            dictionary_value_id: 0,
            value: value.to_string(),
        }]
    })
}

#[cfg(test)]
mod tests;

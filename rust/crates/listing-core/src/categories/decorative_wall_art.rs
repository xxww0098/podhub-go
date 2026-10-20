//! Hand-written fixture schema, `test-support`-gated (not plain `#[cfg(test)]`)
//! because Cloud's own test suite (a separate crate) builds fixtures from
//! `local_schema_snapshot` cross-crate — see e.g.
//! `src/listing/api/row_view_tests.rs`.

#[cfg(any(test, feature = "test-support"))]
use crate::records::{CategorySchemaSnapshot, ListingFieldDefinition, ListingFieldEditor};

/// Catalog schema revision this hand-written snapshot was cut against.
#[cfg(any(test, feature = "test-support"))]
const CATALOG_SCHEMA_VERSION: u32 = 7;

#[cfg(any(test, feature = "test-support"))]
pub const CATEGORY_KEY: &str = "decorative-wall-art-40x50";
#[cfg(any(test, feature = "test-support"))]
pub const LOCAL_SCHEMA_REVISION: &str = "local-v1";
#[cfg(any(test, feature = "test-support"))]
pub const LOCAL_RECIPE_ID: i64 = 0;
#[cfg(any(test, feature = "test-support"))]
pub const LOCAL_RECIPE_REVISION: i64 = 1;

#[cfg(any(test, feature = "test-support"))]
pub fn local_schema_snapshot() -> CategorySchemaSnapshot {
    CategorySchemaSnapshot {
        category_key: CATEGORY_KEY.to_owned(),
        label: "住宅和花园 / 装饰和房间内饰 / 装饰画".to_owned(),
        description_category_id: 17027906,
        type_id: 91976,
        schema_revision: LOCAL_SCHEMA_REVISION.to_owned(),
        recipe_id: LOCAL_RECIPE_ID,
        recipe_revision: LOCAL_RECIPE_REVISION,
        catalog_schema_version: CATALOG_SCHEMA_VERSION,
        fields: vec![
            ListingFieldDefinition::plain(
                "offer_id",
                "Offer ID",
                "基础",
                ListingFieldEditor::Text,
                true,
            ),
            ListingFieldDefinition::plain(
                "name",
                "商品名称",
                "基础",
                ListingFieldEditor::Text,
                true,
            ),
            ListingFieldDefinition::plain(
                "price",
                "价格 (RUB)",
                "基础",
                ListingFieldEditor::Decimal,
                true,
            ),
            ListingFieldDefinition::plain(
                "barcode",
                "条形码",
                "基础",
                ListingFieldEditor::Text,
                false,
            ),
            ListingFieldDefinition {
                key: "description".to_owned(),
                label: "简介".to_owned(),
                group: "属性".to_owned(),
                editor: ListingFieldEditor::Text,
                required: false,
                constraints: Default::default(),
                attribute_id: Some(crate::DESCRIPTION_ATTRIBUTE_ID.to_string()),
                ..ListingFieldDefinition::default()
            },
            ListingFieldDefinition {
                key: "brand".to_owned(),
                label: "品牌".to_owned(),
                group: "属性".to_owned(),
                editor: ListingFieldEditor::Text,
                required: true,
                constraints: Default::default(),
                attribute_id: Some("31".to_owned()),
                ..ListingFieldDefinition::default()
            },
            ListingFieldDefinition {
                key: "merge".to_owned(),
                label: "合并".to_owned(),
                group: "属性".to_owned(),
                editor: ListingFieldEditor::Text,
                required: true,
                constraints: Default::default(),
                attribute_id: Some("8292".to_owned()),
                ..ListingFieldDefinition::default()
            },
            ListingFieldDefinition::plain(
                "width",
                "宽度 (mm)",
                "尺寸",
                ListingFieldEditor::Integer,
                true,
            ),
            ListingFieldDefinition::plain(
                "height",
                "高度 (mm)",
                "尺寸",
                ListingFieldEditor::Integer,
                true,
            ),
            ListingFieldDefinition::plain(
                "depth",
                "深度 (mm)",
                "尺寸",
                ListingFieldEditor::Integer,
                true,
            ),
            ListingFieldDefinition::plain(
                "weight",
                "重量 (g)",
                "尺寸",
                ListingFieldEditor::Integer,
                true,
            ),
        ],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_exposes_category_specific_fields_only() {
        let schema = local_schema_snapshot();
        let keys: Vec<_> = schema
            .fields
            .iter()
            .map(|field| field.key.as_str())
            .collect();
        assert!(keys.contains(&"offer_id"));
        assert!(keys.contains(&"description"));
        assert!(!keys.contains(&"director"));
        assert_eq!(
            schema
                .fields
                .iter()
                .find(|field| field.key == "width")
                .map(|field| field.editor),
            Some(ListingFieldEditor::Integer)
        );
        assert_eq!(
            schema
                .fields
                .iter()
                .find(|field| field.key == "price")
                .map(|field| field.editor),
            Some(ListingFieldEditor::Decimal)
        );
    }
}

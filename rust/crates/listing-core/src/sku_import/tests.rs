use super::*;

use crate::draft::DraftEdit;
use crate::records::{FieldValueOriginKind, RawDraftValue};
use crate::{CategoryFieldConstraints, CategoryFieldEditor, CategoryFieldView, CategorySchemaView};

fn source() -> SellerSkuSnapshot {
    SellerSkuSnapshot {
        sku: 123,
        product_id: 456,
        offer_id: "must-not-copy".to_owned(),
        name: "装饰画 40×50".to_owned(),
        description_category_id: 17027906,
        type_id: 91955,
        price: "90".to_owned(),
        old_price: String::new(),
        currency_code: "RUB".to_owned(),
        vat: "0.2".to_owned(),
        width: 50,
        height: 40,
        depth: 2,
        dimension_unit: "cm".to_owned(),
        weight: 500,
        weight_unit: "g".to_owned(),
        attributes: vec![SellerSkuAttribute {
            id: 85,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 7,
                value: "Черный".to_owned(),
            }],
        }],
        complex_items: vec![SellerSkuComplexItem { attributes: vec![] }],
    }
}

fn field(key: &str, editor: ListingFieldEditor) -> SkuImportSchemaField {
    SkuImportSchemaField {
        key: key.to_owned(),
        name: key.to_owned(),
        group_name: "test".to_owned(),
        editor,
        collection: false,
        read_only: false,
        attribute_id: None,
        complex_id: None,
        options: Vec::new(),
    }
}

#[test]
fn same_category_projects_reusable_fields_but_never_instance_owned_fields() {
    let mut source = source();
    source.attributes.extend([
        SellerSkuAttribute {
            id: 4191,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 0,
                value: "旧商品简介".to_owned(),
            }],
        },
        SellerSkuAttribute {
            id: 9024,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 0,
                value: "old-seller-code".to_owned(),
            }],
        },
        SellerSkuAttribute {
            id: 9048,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 0,
                value: "old-model-name".to_owned(),
            }],
        },
        SellerSkuAttribute {
            id: 23171,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 0,
                value: "#old #tags".to_owned(),
            }],
        },
        SellerSkuAttribute {
            id: 11254,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 0,
                value: "{\"content\":[]}".to_owned(),
            }],
        },
        SellerSkuAttribute {
            id: 7109,
            complex_id: 0,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 970_742_650,
                value: "花卉和植物".to_owned(),
            }],
        },
    ]);
    source.complex_items = vec![SellerSkuComplexItem {
        attributes: vec![SellerSkuAttribute {
            id: 4191,
            complex_id: 99,
            values: vec![SellerSkuAttributeValue {
                dictionary_value_id: 0,
                value: "旧复杂简介".to_owned(),
            }],
        }],
    }];
    let mut description = field("attribute_4191", ListingFieldEditor::Text);
    description.attribute_id = Some(4191);
    let mut seller_code = field("attribute_9024", ListingFieldEditor::Text);
    seller_code.attribute_id = Some(9024);
    let mut model_name = field("attribute_9048", ListingFieldEditor::Text);
    model_name.attribute_id = Some(9048);
    let mut search_tags = field("attribute_23171", ListingFieldEditor::Text);
    search_tags.attribute_id = Some(23171);
    let mut rich_content = field("attribute_11254", ListingFieldEditor::Text);
    rich_content.attribute_id = Some(11254);
    let mut theme = field("attribute_7109", ListingFieldEditor::MultiSelect);
    theme.attribute_id = Some(7109);
    let mut complex_description = field("complex_4191", ListingFieldEditor::Text);
    complex_description.attribute_id = Some(4191);
    complex_description.complex_id = Some(99);
    let schema = SkuImportSchema {
        description_category_id: 17027906,
        type_id: 91955,
        fields: vec![
            field("offer_id", ListingFieldEditor::Text),
            field("images", ListingFieldEditor::UrlList),
            field("name", ListingFieldEditor::Text),
            field("price", ListingFieldEditor::Decimal),
            description,
            seller_code,
            model_name,
            search_tags,
            rich_content,
            theme,
            complex_description,
        ],
    };
    let preview = preview_sku_import(&schema, &source);
    assert!(preview.category_matches);
    assert_eq!(preview.source_name, "装饰画 40×50");
    // 主题、简介、编号、型号、搜索标签与富内容都是逐行/逐图的值：SKU 只贡献
    // 可复用的固定字段（销售价），绝不把另一件商品的这些值搬进来。
    assert_eq!(
        preview
            .candidates
            .iter()
            .map(|candidate| candidate.field_key.as_str())
            .collect::<Vec<_>>(),
        ["price"]
    );
}

#[test]
fn category_mismatch_has_no_applicable_candidates() {
    let schema = SkuImportSchema {
        description_category_id: 1,
        type_id: 2,
        fields: vec![field("name", ListingFieldEditor::Text)],
    };
    let preview = preview_sku_import(&schema, &source());
    assert!(!preview.category_matches);
    assert!(preview.candidates.is_empty());
}

#[test]
fn sku_import_schema_from_view_maps_all_listing_field_editors() {
    let editors = [
        CategoryFieldEditor::Text,
        CategoryFieldEditor::Integer,
        CategoryFieldEditor::Decimal,
        CategoryFieldEditor::Boolean,
        CategoryFieldEditor::SingleSelect,
        CategoryFieldEditor::MultiSelect,
        CategoryFieldEditor::DictionarySearch,
        CategoryFieldEditor::Url,
        CategoryFieldEditor::UrlList,
    ];
    let view = CategorySchemaView {
        description_category_id: 123,
        type_id: 456,
        language: None,
        fields: editors
            .iter()
            .enumerate()
            .map(|(index, editor)| CategoryFieldView {
                key: format!("field_{index}"),
                name: format!("Field {index}"),
                description: String::new(),
                group_name: "main".into(),
                source: crate::CategoryFieldSource::Fixed,
                editor: *editor,
                raw_type: None,
                attribute_id: Some(index as i64),
                complex_id: None,
                complex_group_collection: false,
                read_only: false,
                aspect: None,
                constraints: CategoryFieldConstraints {
                    required: false,
                    collection: false,
                    max_value_count: None,
                    dictionary_id: None,
                },
                options: vec![],
                options_truncated: false,
            })
            .collect(),
        complex_groups: vec![],
    };
    let schema = sku_import_schema(&view);
    let expected = [
        ListingFieldEditor::Text,
        ListingFieldEditor::Integer,
        ListingFieldEditor::Decimal,
        ListingFieldEditor::Boolean,
        ListingFieldEditor::SingleSelect,
        ListingFieldEditor::MultiSelect,
        ListingFieldEditor::DictionarySearch,
        ListingFieldEditor::Url,
        ListingFieldEditor::UrlList,
    ];
    assert_eq!(schema.description_category_id, 123);
    assert_eq!(schema.type_id, 456);
    assert_eq!(schema.fields.len(), expected.len());
    for (field, expected_editor) in schema.fields.iter().zip(expected.iter()) {
        assert_eq!(field.editor, *expected_editor);
        assert_eq!(field.attribute_id, Some(field.key[6..].parse().unwrap()));
        assert_eq!(field.group_name, "main");
    }
}

#[test]
fn candidates_become_originated_draft_edits_with_seller_sku_origin() {
    let candidates = vec![SkuImportCandidate {
        candidate_id: "plain:price".to_owned(),
        field_key: "price".to_owned(),
        field_name: "销售价".to_owned(),
        group_name: "基础".to_owned(),
        location: SkuImportLocation::Plain,
        value: SkuImportValue::Decimal(90.0),
    }];
    let edits = candidates_to_originated_edits(&candidates, 123, 99);
    assert_eq!(edits.len(), 1);
    assert_eq!(edits[0].origin.kind, FieldValueOriginKind::SellerSku);
    assert_eq!(edits[0].origin.source_ref.as_deref(), Some("sku:123"));
    assert!(matches!(
        edits[0].edit,
        DraftEdit::SetRaw {
            ref field_key,
            value: RawDraftValue::Text(ref text),
        } if field_key == "price" && text == "90"
    ));
}

#[test]
fn dictionary_search_import_preserves_collection_cardinality() {
    let mut field = field("brand", ListingFieldEditor::DictionarySearch);
    field.collection = true;
    let values = vec![
        SellerSkuAttributeValue {
            dictionary_value_id: 7,
            value: "Черный".to_owned(),
        },
        SellerSkuAttributeValue {
            dictionary_value_id: 8,
            value: "Белый".to_owned(),
        },
    ];

    assert!(matches!(
        convert_value(&field, &values),
        Some(SkuImportValue::MultiSelect(values)) if values.len() == 2
    ));
}

fn attribute(id: i64, complex_id: i64, value: &str) -> SellerSkuAttribute {
    SellerSkuAttribute {
        id,
        complex_id,
        values: vec![SellerSkuAttributeValue {
            dictionary_value_id: 0,
            value: value.to_owned(),
        }],
    }
}

fn attribute_field(key: &str, attribute_id: i64, complex_id: Option<i64>) -> SkuImportSchemaField {
    let mut field = field(key, ListingFieldEditor::Text);
    field.attribute_id = Some(attribute_id);
    field.complex_id = complex_id;
    field
}

#[test]
fn system_media_fields_never_become_candidates_while_ordinary_complex_fields_do() {
    const FORGED: &str = "https://evil.example.invalid/forged.mp4";
    let mut source = source();
    // A plain system attribute (the schema keys it as a plain alias) and the
    // same video / cover attributes as complex items beside an ordinary one.
    source.attributes.push(attribute(21841, 0, FORGED));
    source.complex_items = vec![SellerSkuComplexItem {
        attributes: vec![
            attribute(21837, 100001, "Old title"),
            attribute(21841, 100001, FORGED),
            attribute(22273, 100001, "OLD-OFFER"),
            attribute(21845, 100002, FORGED),
            attribute(9999, 7, "kept"),
        ],
    }];
    let schema = SkuImportSchema {
        description_category_id: 17027906,
        type_id: 91955,
        fields: vec![
            field("price", ListingFieldEditor::Decimal),
            attribute_field("video_url", 21841, None),
            attribute_field("attribute_21837", 21837, Some(100001)),
            attribute_field("attribute_21841", 21841, Some(100001)),
            attribute_field("attribute_22273", 22273, Some(100001)),
            attribute_field("attribute_21845", 21845, Some(100002)),
            attribute_field("attribute_9999", 9999, Some(7)),
        ],
    };

    let preview = preview_sku_import(&schema, &source);

    assert!(preview.category_matches);
    assert_eq!(
        preview
            .candidates
            .iter()
            .map(|candidate| candidate.candidate_id.as_str())
            .collect::<Vec<_>>(),
        ["plain:price", "complex:7:0:attribute_9999"],
        "system media is neither a plain nor a complex candidate"
    );
    assert_eq!(
        preview.candidates[1].value,
        SkuImportValue::Text("kept".to_owned())
    );
    assert!(
        preview
            .candidates
            .iter()
            .all(|candidate| !format!("{candidate:?}").contains(FORGED)),
        "{:?}",
        preview.candidates
    );
}

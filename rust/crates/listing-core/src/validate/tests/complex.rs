//! Complex groups, list-valued fields and addressed media URLs: per-item
//! cardinality and required members, repeated items, list shapes, and the
//! address every such issue carries.

use super::*;

#[test]
fn complex_choice_cardinality_is_validated_per_item() {
    use crate::draft::{ComplexDraftItem, RawDraftValue};
    use crate::records::ChoiceValue;
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_complex_country".to_owned(),
            label: "复杂属性原产国".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::SingleSelect,
            required: false,
            constraints: ListingFieldConstraints {
                dictionary_id: Some("44".to_owned()),
                ..ListingFieldConstraints::default()
            },
            attribute_id: Some("2002".to_owned()),
            complex_id: Some("77".to_owned()),
            ..ListingFieldDefinition::default()
        });
    draft.complex_values.insert(
        "77".to_owned(),
        vec![ComplexDraftItem {
            item_id: "item-0".to_owned(),
            values: [(
                "attribute_complex_country".to_owned(),
                RawDraftValue::ManyChoices(vec![
                    ChoiceValue {
                        id: "1".to_owned(),
                        label: "中国".to_owned(),
                    },
                    ChoiceValue {
                        id: "2".to_owned(),
                        label: "俄罗斯".to_owned(),
                    },
                ]),
            )]
            .into_iter()
            .collect(),
            list_elements: Default::default(),
        }],
    );

    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("complex single-select with two choices must be rejected");
    };
    assert!(issues.iter().any(|issue| {
            issue.field_key == "attribute_complex_country"
                && issue.code == "invalid_choice_cardinality"
                && matches!(issue.address, FieldAddress::Complex { ref item_id, .. } if item_id == "item-0")
        }));
}

#[test]
fn preserves_repeated_complex_items_as_distinct_groups() {
    use crate::draft::{ComplexDraftItem, RawDraftValue};
    use crate::records::ChoiceValue;
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_complex_country".to_owned(),
            label: "复杂属性原产国".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::SingleSelect,
            required: false,
            constraints: ListingFieldConstraints {
                dictionary_id: Some("44".to_owned()),
                ..ListingFieldConstraints::default()
            },
            attribute_id: Some("2002".to_owned()),
            complex_id: Some("77".to_owned()),
            complex_group_collection: true,
            ..ListingFieldDefinition::default()
        });
    draft.complex_values.insert(
        "77".to_owned(),
        [("item-0", "1", "中国"), ("item-1", "2", "俄罗斯")]
            .into_iter()
            .map(|(item_id, id, label)| ComplexDraftItem {
                item_id: item_id.to_owned(),
                values: [(
                    "attribute_complex_country".to_owned(),
                    RawDraftValue::OneChoice(ChoiceValue {
                        id: id.to_owned(),
                        label: label.to_owned(),
                    }),
                )]
                .into_iter()
                .collect(),
                list_elements: Default::default(),
            })
            .collect(),
    );

    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("expected acceptance");
    };
    assert_eq!(snapshot.complex_attributes.len(), 2);
    assert_eq!(
        snapshot
            .complex_attributes
            .iter()
            .map(|group| {
                let value = &group.attributes[0].values[0];
                (value.dictionary_value_id, value.value.as_str())
            })
            .collect::<Vec<_>>(),
        vec![(Some(1), "中国"), (Some(2), "俄罗斯")]
    );
}

#[test]
fn list_cardinality_ignores_joined_field_text_and_keeps_five_shapes() {
    use crate::records::NormalizedAttributeValue;
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_tags".to_owned(),
            label: "标签".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::Text,
            required: false,
            constraints: ListingFieldConstraints {
                collection: true,
                max_value_count: None,
                dictionary_id: None,
            },
            attribute_id: Some("77".to_owned()),
            ..ListingFieldDefinition::default()
        });
    draft
        .field_values
        .insert("attribute_tags".to_owned(), "a, b, c".to_owned());
    draft.list_elements.insert(
        "attribute_tags".to_owned(),
        vec!["a, b".to_owned(), "c; d\ne".to_owned()],
    );

    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("expected acceptance");
    };
    let values = &snapshot
        .attributes
        .iter()
        .find(|attribute| attribute.id == 77)
        .expect("tags")
        .values;
    assert_eq!(values.len(), 2);
    assert_eq!(values[0].value, "a, b");
    assert_eq!(values[1].value, "c; d\ne");

    let request = crate::product_import::build_product_import_request(
        &snapshot,
        &crate::product_import::placeholder_media(),
    )
    .expect("serialize");
    let sent = request.items[0]
        .attributes
        .iter()
        .find(|attribute| attribute.id == 77)
        .expect("sent tags");
    assert_eq!(sent.values.len(), 2);
    assert_eq!(sent.values[0].value, "a, b");
    assert_eq!(sent.values[1].value, "c; d\ne");

    assert_eq!(
        normalize_raw_values(&RawDraftValue::Text("0".to_owned())),
        vec![NormalizedAttributeValue {
            value: "0".to_owned(),
            dictionary_value_id: None,
        }]
    );
    assert_eq!(
        normalize_raw_values(&RawDraftValue::Text("false".to_owned())),
        vec![NormalizedAttributeValue {
            value: "false".to_owned(),
            dictionary_value_id: None,
        }]
    );
    assert!(normalize_elements(&[]).is_empty());
    assert!(normalize_raw_values(&RawDraftValue::ClearedChoice).is_empty());
    assert!(draft.list_elements.contains_key("attribute_tags"));
    assert_ne!(
        draft.raw_values.get("attribute_tags"),
        Some(&RawDraftValue::ClearedChoice)
    );
}

#[test]
fn non_collection_second_content_item_is_rejected_with_an_address() {
    use crate::draft::{ComplexDraftItem, RawDraftValue};
    use crate::records::FieldAddress;
    use crate::schema::{ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_part".to_owned(),
            label: "部件".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::Text,
            required: false,
            attribute_id: Some("3001".to_owned()),
            complex_id: Some("88".to_owned()),
            complex_group_collection: false,
            ..ListingFieldDefinition::default()
        });
    draft.complex_values.insert(
        "88".to_owned(),
        vec![
            ComplexDraftItem {
                item_id: "item-0".to_owned(),
                values: [(
                    "attribute_part".to_owned(),
                    RawDraftValue::Text("A".to_owned()),
                )]
                .into_iter()
                .collect(),
                list_elements: Default::default(),
            },
            ComplexDraftItem {
                item_id: "item-1".to_owned(),
                values: [(
                    "attribute_part".to_owned(),
                    RawDraftValue::Text("B".to_owned()),
                )]
                .into_iter()
                .collect(),
                list_elements: Default::default(),
            },
        ],
    );
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("a non-collection group cannot carry a second content item");
    };
    assert!(issues.iter().any(|issue| {
        issue.code == "complex_single_item"
            && matches!(
                &issue.address,
                FieldAddress::Complex {
                    group_key,
                    item_id,
                    ..
                } if group_key == "88" && item_id == "item-1"
            )
    }));
}

#[test]
fn each_content_item_fails_its_own_required_members() {
    use crate::draft::{ComplexDraftItem, RawDraftValue};
    use crate::records::FieldAddress;
    use crate::schema::{ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    for (key, attribute_id) in [("member_a", "3101"), ("member_b", "3102")] {
        std::sync::Arc::make_mut(&mut draft.schema_snapshot)
            .fields
            .push(ListingFieldDefinition {
                key: key.to_owned(),
                label: key.to_owned(),
                group: "属性".to_owned(),
                editor: ListingFieldEditor::Text,
                required: true,
                attribute_id: Some(attribute_id.to_owned()),
                complex_id: Some("89".to_owned()),
                complex_group_collection: true,
                ..ListingFieldDefinition::default()
            });
    }
    draft.complex_values.insert(
        "89".to_owned(),
        vec![
            ComplexDraftItem {
                item_id: "item-0".to_owned(),
                values: [("member_a".to_owned(), RawDraftValue::Text("A".to_owned()))]
                    .into_iter()
                    .collect(),
                list_elements: Default::default(),
            },
            ComplexDraftItem {
                item_id: "item-1".to_owned(),
                values: [("member_b".to_owned(), RawDraftValue::Text("B".to_owned()))]
                    .into_iter()
                    .collect(),
                list_elements: Default::default(),
            },
        ],
    );
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("each content item must carry its own required members");
    };
    assert!(issues.iter().any(|issue| {
        issue.field_key == "member_b"
            && issue.code == "required"
            && matches!(
                &issue.address,
                FieldAddress::Complex { item_id, .. } if item_id == "item-0"
            )
    }));
    assert!(issues.iter().any(|issue| {
        issue.field_key == "member_a"
            && issue.code == "required"
            && matches!(
                &issue.address,
                FieldAddress::Complex { item_id, .. } if item_id == "item-1"
            )
    }));
}

#[test]
fn empty_array_on_a_collection_field_emits_no_attribute() {
    use crate::schema::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "attribute_tags".to_owned(),
            label: "标签".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::Text,
            required: false,
            constraints: ListingFieldConstraints {
                collection: true,
                ..ListingFieldConstraints::default()
            },
            attribute_id: Some("3201".to_owned()),
            ..ListingFieldDefinition::default()
        });
    draft
        .list_elements
        .insert("attribute_tags".to_owned(), Vec::new());
    let ValidationOutcome::Accepted { snapshot, .. } = normalize_and_validate(&draft) else {
        panic!("an empty array is a present value, not a validation failure");
    };
    assert!(
        snapshot
            .attributes
            .iter()
            .all(|attribute| attribute.id != 3201)
    );
}

#[test]
fn missing_required_primary_image_is_an_addressed_issue() {
    use crate::records::FieldAddress;
    use crate::schema::{ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "primary_image".to_owned(),
            label: "主图".to_owned(),
            group: "媒体".to_owned(),
            editor: ListingFieldEditor::Url,
            required: true,
            ..ListingFieldDefinition::default()
        });
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("a required primary image with no URL must fail");
    };
    assert!(issues.iter().any(|issue| {
        issue.code == "required"
            && matches!(issue.address, FieldAddress::Plain { ref field_key } if field_key == "primary_image")
    }));
}

#[test]
fn media_urls_require_https_and_other_urls_keep_http() {
    use crate::draft::RawDraftValue;
    use crate::records::FieldAddress;
    use crate::schema::{ListingFieldDefinition, ListingFieldEditor};

    let mut draft = draft_with(filled_values());
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "images".to_owned(),
            label: "图片".to_owned(),
            group: "媒体".to_owned(),
            editor: ListingFieldEditor::Url,
            required: true,
            ..ListingFieldDefinition::default()
        });
    std::sync::Arc::make_mut(&mut draft.schema_snapshot)
        .fields
        .push(ListingFieldDefinition {
            key: "reference_url".to_owned(),
            label: "参考链接".to_owned(),
            group: "属性".to_owned(),
            editor: ListingFieldEditor::Url,
            required: false,
            ..ListingFieldDefinition::default()
        });
    draft.field_values.insert(
        "images".to_owned(),
        "http://cdn.example.test/a.jpg".to_owned(),
    );
    draft.raw_values.insert(
        "images".to_owned(),
        RawDraftValue::Text("http://cdn.example.test/a.jpg".to_owned()),
    );
    draft.field_values.insert(
        "reference_url".to_owned(),
        "http://example.test/spec".to_owned(),
    );
    let ValidationOutcome::Rejected { issues } = normalize_and_validate(&draft) else {
        panic!("an http image URL must be rejected");
    };
    assert!(issues.iter().any(|issue| {
        issue.field_key == "images"
            && issue.code == "invalid_url"
            && matches!(issue.address, FieldAddress::Plain { ref field_key } if field_key == "images")
    }));
    assert!(
        issues
            .iter()
            .all(|issue| issue.field_key != "reference_url")
    );

    draft.field_values.insert(
        "images".to_owned(),
        "https://cdn.example.test/a.jpg".to_owned(),
    );
    draft.raw_values.insert(
        "images".to_owned(),
        RawDraftValue::Text("https://cdn.example.test/a.jpg".to_owned()),
    );
    let ValidationOutcome::Accepted { .. } = normalize_and_validate(&draft) else {
        panic!("https image and http non-media URL must pass");
    };
}

use super::*;
use crate::categories::decorative_wall_art;

fn field(key: &str) -> CategoryFieldView {
    CategoryFieldView {
        key: key.to_owned(),
        name: key.to_owned(),
        description: String::new(),
        group_name: String::new(),
        source: CategoryFieldSource::Attribute,
        editor: CategoryFieldEditor::Text,
        raw_type: None,
        attribute_id: None,
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
        options: Vec::new(),
        options_truncated: false,
    }
}

#[test]
fn ai_policy_never_authorizes_protected_or_media_fields() {
    let schema = CategorySchemaView {
        description_category_id: 1,
        type_id: 2,
        language: None,
        fields: vec![field("name"), field("price"), field("images")],
        complex_groups: Vec::new(),
    };
    resolve_ai_binding(
        None,
        Some(("store_01".to_owned(), vec!["price".to_owned()])),
        &schema,
    )
    .expect_err("protected price cannot be enabled");
    let (_, policy) = resolve_ai_binding(None, Some(("store_01".to_owned(), Vec::new())), &schema)
        .expect("default policy");
    assert_eq!(policy.allowed_field_keys, vec!["name"]);
    assert_eq!(policy.protected_field_keys, vec!["images", "price"]);
    assert_eq!(
        effective_ai_policy(
            &schema,
            &WorkflowAiFieldPolicy {
                allowed_field_keys: Vec::new(),
                protected_field_keys: Vec::new(),
            },
        ),
        policy,
        "an empty browser Card policy keeps the schema-safe default meaning"
    );
}

#[test]
fn dictionary_candidates_fail_closed_on_unknown_or_ambiguous_values() {
    let mut field = field("color");
    field.editor = CategoryFieldEditor::SingleSelect;
    field.constraints.dictionary_id = Some(7);
    field.options = vec![
        CategoryFieldOption {
            id: 1,
            value: "蓝色".to_owned(),
            info: String::new(),
            picture: String::new(),
        },
        CategoryFieldOption {
            id: 2,
            value: "蓝色".to_owned(),
            info: String::new(),
            picture: String::new(),
        },
    ];
    assert_eq!(
        dictionary_candidate_issue(&field, "蓝色"),
        Some("字典值不唯一，需要人工确认")
    );
    assert_eq!(
        dictionary_candidate_issue(&field, "不存在"),
        Some("字典值未知，未自动猜测")
    );
    let mut unique = field.clone();
    unique.options.pop();
    assert_eq!(dictionary_candidate_issue(&unique, "蓝色"), None);
}

#[test]
fn snapshot_projects_into_a_schema_view_with_its_complex_groups() {
    let snapshot = decorative_wall_art::local_schema_snapshot();
    let view = category_schema_view(&snapshot, Some(WorkflowLanguage::ZhHans));
    assert_eq!(view.description_category_id, 17027906);
    assert_eq!(view.type_id, 91976);
    assert_eq!(view.fields.len(), snapshot.fields.len());
    assert_eq!(
        view.complex_groups.len(),
        complex_groups_from_snapshot(&snapshot).len()
    );
    assert!(
        view.fields
            .iter()
            .any(|field| field.key == "offer_id" && field.constraints.required)
    );
}

#[test]
fn source_file_stem_becomes_the_offer_id() {
    let schema = category_schema_view(&decorative_wall_art::local_schema_snapshot(), None);
    let mut draft = WorkflowCategoryDraft::default();
    inject_source_identity(&schema, &mut draft, "  ART-001.psd");
    assert_eq!(
        draft.values.get("offer_id"),
        Some(&WorkflowDraftValue::Text("ART-001".to_owned()))
    );
    inject_source_identity(&schema, &mut draft, "   ");
    assert_eq!(
        draft.values.get("offer_id"),
        Some(&WorkflowDraftValue::Text("ART-001".to_owned())),
        "a blank source name must not clear an existing identity"
    );
    inject_source_identity(&schema, &mut draft, "OTHER.jpg");
    assert_eq!(
        draft.values.get("offer_id"),
        Some(&WorkflowDraftValue::Text("ART-001".to_owned())),
        "a filled offer_id is Manual and must not be restamped"
    );
}

/// 货号 vs 型号: the file-name fallback fills both while the draft is blank,
/// and once a model is set (by an operator, a batch assign, or the
/// association import's digest) no rename or rebuild overwrites it. Restoring
/// an independent model is assigning a new value, never re-opening the
/// fallback by clearing.
#[test]
fn a_set_model_is_never_overwritten_by_the_file_name() {
    let mut schema = category_schema_view(&decorative_wall_art::local_schema_snapshot(), None);
    for (key, attribute_id) in [("attribute_9024", 9024), ("attribute_9048", 9048)] {
        let mut column = field(key);
        column.attribute_id = Some(attribute_id);
        schema.fields.push(column);
    }
    let mut draft = crate::WorkflowCategoryDraft::default();
    inject_source_identity(&schema, &mut draft, "ART-001.psd");
    for key in ["offer_id", "attribute_9024", "attribute_9048"] {
        assert_eq!(
            draft.values.get(key),
            Some(&crate::WorkflowDraftValue::Text("ART-001".to_owned())),
            "{key} starts from the file name"
        );
    }

    // The operator (or a batch assign, or the association import) sets the
    // common model explicitly ...
    draft.values.insert(
        "attribute_9048".to_owned(),
        crate::WorkflowDraftValue::Text("PHM-0123456789abcdef".to_owned()),
    );
    // ... and the same row is rebuilt from a renamed source file.
    inject_source_identity(&schema, &mut draft, "ART-001-renamed.psd");
    assert_eq!(
        draft.values.get("attribute_9048"),
        Some(&crate::WorkflowDraftValue::Text(
            "PHM-0123456789abcdef".to_owned()
        )),
        "an explicitly set model is not a filename fallback target"
    );
    assert_eq!(
        draft.values.get("offer_id"),
        Some(&crate::WorkflowDraftValue::Text("ART-001".to_owned())),
        "货号 keeps its own rule: filled once, never restamped"
    );
}

/// 9024 货号 and 9048 型号 are instance/pipeline owned: an AI allow-list may
/// never name them, so no recognition result can move a row's identity or its
/// common model.
#[test]
fn the_seller_code_and_model_attributes_are_ai_protected() {
    for (key, attribute_id) in [("attribute_9024", 9024), ("attribute_9048", 9048)] {
        let mut column = field(key);
        column.attribute_id = Some(attribute_id);
        assert!(is_ai_protected_field(&column), "{key}");
    }
    let mut seller_code = field("attribute_9024");
    seller_code.attribute_id = Some(9024);
    let schema = CategorySchemaView {
        description_category_id: 1,
        type_id: 2,
        language: None,
        fields: vec![seller_code, field("name")],
        complex_groups: Vec::new(),
    };
    resolve_ai_binding(
        None,
        Some(("store_01".to_owned(), vec!["attribute_9024".to_owned()])),
        &schema,
    )
    .expect_err("the Seller code cannot be AI-enabled");
    let (_, policy) = resolve_ai_binding(None, Some(("store_01".to_owned(), Vec::new())), &schema)
        .expect("default policy");
    assert_eq!(policy.allowed_field_keys, vec!["name"]);
    assert_eq!(policy.protected_field_keys, vec!["attribute_9024"]);
}

#[test]
fn cleared_filename_identity_can_still_be_filled() {
    let mut schema = category_schema_view(&decorative_wall_art::local_schema_snapshot(), None);
    for (key, attribute_id) in [("attribute_9024", 9024), ("attribute_9048", 9048)] {
        let mut column = field(key);
        column.attribute_id = Some(attribute_id);
        schema.fields.push(column);
    }
    let mut draft = crate::WorkflowCategoryDraft {
        cleared: ["offer_id", "attribute_9024", "attribute_9048"]
            .into_iter()
            .map(str::to_owned)
            .collect(),
        ..crate::WorkflowCategoryDraft::default()
    };
    inject_source_identity(&schema, &mut draft, "ART-001.psd");
    assert_eq!(
        draft.values.get("offer_id"),
        Some(&crate::WorkflowDraftValue::Text("ART-001".to_owned()))
    );
    assert_eq!(
        draft.values.get("attribute_9024"),
        Some(&crate::WorkflowDraftValue::Text("ART-001".to_owned()))
    );
    assert_eq!(
        draft.values.get("attribute_9048"),
        Some(&crate::WorkflowDraftValue::Text("ART-001".to_owned()))
    );
}

#[test]
fn system_media_writes_are_rejected() {
    use crate::schema::ListingFieldDefinition;
    use crate::{WorkflowCategoryDraft, WorkflowComplexDraftGroup};

    let mut snapshot = decorative_wall_art::local_schema_snapshot();
    snapshot.fields.push(ListingFieldDefinition {
        key: "attribute_21837".to_owned(),
        attribute_id: Some("21837".to_owned()),
        ..ListingFieldDefinition::default()
    });
    let mut draft = WorkflowCategoryDraft {
        complex_values: vec![WorkflowComplexDraftGroup {
            complex_id: 100001,
            items: Vec::new(),
        }],
        ..WorkflowCategoryDraft::default()
    };
    assert!(system_media_write_error(&snapshot, &draft).is_some());
    draft.complex_values.clear();
    draft.complex_values.push(WorkflowComplexDraftGroup {
        complex_id: 100002,
        items: Vec::new(),
    });
    assert!(system_media_write_error(&snapshot, &draft).is_some());
    draft.complex_values.clear();
    draft.cleared.insert("attribute_21837".to_owned());
    assert!(system_media_write_error(&snapshot, &draft).is_some());
    draft.cleared.clear();
    assert!(system_media_write_error(&snapshot, &draft).is_none());
}

#[test]
fn listing_issue_codes_map_onto_the_workflow_vocabulary() {
    let issue = FieldIssue {
        field_key: "offer_id".to_owned(),
        code: "offer_id_charset".to_owned(),
        parameters: BTreeMap::new(),
        severity: crate::validate::IssueSeverity::Blocking,
        address: FieldAddress::Complex {
            group_key: "7".to_owned(),
            item_id: "workflow-7-3".to_owned(),
            field_key: "offer_id".to_owned(),
            value_index: None,
        },
        message: "bad".to_owned(),
        remediation: None,
    };
    let projected = workflow_issue_from_listing(issue);
    assert_eq!(projected.code, WorkflowValidationIssueCode::Range);
    assert_eq!(projected.complex_id, Some(7));
    assert_eq!(projected.item_index, Some(3));
}

#[test]
fn is_ai_protected_field_uses_attribute_id_not_display_name() {
    for name in ["Brand", "品牌", "Бренд"] {
        let mut brand = field("attribute_85");
        brand.name = name.to_owned();
        brand.attribute_id = Some(85);
        assert!(is_ai_protected_field(&brand), "{name}");
    }
}

#[test]
fn is_ai_protected_field_keeps_stable_keys() {
    for key in [
        "price",
        "old_price",
        "depth",
        "width",
        "height",
        "dimension",
        "weight",
        "offer_id",
        "images",
        "images360",
        "primary_image",
        "color_image",
    ] {
        assert!(is_ai_protected_field(&field(key)), "{key}");
    }
}

#[test]
fn is_ai_protected_field_ignores_english_fragments() {
    let mut decoy = field("attribute_999");
    decoy.name = "brand image certificate".to_owned();
    decoy.attribute_id = Some(999);
    assert!(!is_ai_protected_field(&decoy));
}

#[test]
fn ai_allowed_protection_matches_is_ai_protected_field() {
    let mut brand = field("attribute_85");
    brand.name = "品牌".to_owned();
    brand.attribute_id = Some(85);
    let mut decoy = field("attribute_999");
    decoy.name = "brand image".to_owned();
    decoy.attribute_id = Some(999);
    decoy.complex_id = Some(7);
    decoy.group_name = "image group".to_owned();
    let name = field("name");
    let schema = CategorySchemaView {
        description_category_id: 1,
        type_id: 2,
        language: None,
        fields: vec![brand.clone(), decoy.clone(), name.clone()],
        complex_groups: Vec::new(),
    };
    let policy = WorkflowAiFieldPolicy {
        allowed_field_keys: vec![
            "attribute_85".to_owned(),
            "attribute_999".to_owned(),
            "name".to_owned(),
        ],
        protected_field_keys: Vec::new(),
    };
    let allowed =
        |address: &FieldAddress| crate::content_policy::ai_allowed(&schema, &policy, address);
    let brand_address = FieldAddress::Plain {
        field_key: brand.key.clone(),
    };
    let decoy_address = FieldAddress::Complex {
        group_key: "7".to_owned(),
        item_id: "item".to_owned(),
        field_key: decoy.key.clone(),
        value_index: None,
    };
    let other_group = FieldAddress::Complex {
        group_key: "8".to_owned(),
        item_id: "item".to_owned(),
        field_key: decoy.key.clone(),
        value_index: None,
    };
    let name_address = FieldAddress::Plain {
        field_key: name.key,
    };
    assert_eq!(allowed(&brand_address), !is_ai_protected_field(&brand));
    assert!(is_ai_protected_field(&brand));
    assert_eq!(allowed(&decoy_address), !is_ai_protected_field(&decoy));
    assert!(!is_ai_protected_field(&decoy));
    assert!(!allowed(&other_group));
    assert!(allowed(&name_address));
}

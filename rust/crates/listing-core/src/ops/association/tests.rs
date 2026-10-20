//! The association identity rules, exercised as pure functions: the same
//! design must re-derive the same 货号 batch key and common 型号 under a retry,
//! and a different design must not merge into it.

use super::*;
use crate::categories::decorative_wall_art;
use crate::records::{FieldAddress, FieldValueOrigin, FieldValueOriginKind};
use crate::workflow_dto::{
    CategoryFieldConstraints, CategoryFieldEditor, CategoryFieldSource, CategoryFieldView,
    model_field_key,
};

fn hex(value: char) -> String {
    std::iter::repeat(value).take(64).collect()
}

fn attribute_field(key: &str, attribute_id: i64, complex_id: Option<i64>) -> CategoryFieldView {
    CategoryFieldView {
        key: key.to_owned(),
        name: key.to_owned(),
        description: String::new(),
        group_name: String::new(),
        source: CategoryFieldSource::Attribute,
        editor: CategoryFieldEditor::Text,
        raw_type: None,
        attribute_id: Some(attribute_id),
        complex_id,
        complex_group_collection: false,
        read_only: false,
        constraints: CategoryFieldConstraints {
            required: false,
            collection: false,
            max_value_count: None,
            dictionary_id: None,
        },
        // The model attribute is not a variant dimension in this fixture;
        // `aspect` is carried from the Seller material (ticket 01).
        aspect: Some(false),
        options: Vec::new(),
        options_truncated: false,
    }
}

/// 9048 (and 9024) as a plain field — the supported shape — or only inside a
/// complex group, which this slice reports as unsupported.
fn schema(model_complex: bool) -> CategorySchemaView {
    let complex_id = model_complex.then_some(7);
    CategorySchemaView {
        description_category_id: 17_027_906,
        type_id: 91_976,
        language: None,
        fields: vec![
            attribute_field("attribute_9024", OZON_SELLER_CODE_ATTRIBUTE_ID, None),
            attribute_field("attribute_9048", OZON_MODEL_NAME_ATTRIBUTE_ID, complex_id),
        ],
        complex_groups: Vec::new(),
    }
}

fn row() -> RowPayload {
    let snapshot = decorative_wall_art::local_schema_snapshot();
    RowPayload {
        category_key: snapshot.category_key.clone(),
        description_category_id: snapshot.description_category_id,
        type_id: snapshot.type_id,
        supplier_product_id: None,
        language: crate::WorkflowLanguage::Default,
        schema_revision: snapshot.schema_revision.clone(),
        schema_snapshot: std::sync::Arc::new(snapshot),
        draft: WorkflowCategoryDraft::default(),
        hand_edited_keys: Default::default(),
        field_origins: Vec::new(),
        normalized_snapshot: None,
        validation_issues: Vec::new(),
        source: crate::envelope::RowSource::default(),
        render_evidence: None,
        media: Default::default(),
        ai: Default::default(),
        failure_log: Vec::new(),
    }
}

fn text(draft: &WorkflowCategoryDraft, key: &str) -> String {
    match draft.values.get(key) {
        Some(WorkflowDraftValue::Text(value)) => value.clone(),
        other => panic!("{key} is not text: {other:?}"),
    }
}

const ROW_IDS: [&str; 3] = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
];

/// 同一源图、同库同款号、三规格：三个固定不同货号、一个共同型号、同一个 association。
#[test]
fn three_sizes_of_one_design_keep_distinct_offers_and_one_model() {
    let image = hex('a');
    let identity = association_identity(7, "db-1", "GRP-9", &image).expect("identity");
    let mut offers = Vec::new();
    let mut models = Vec::new();
    for row_id in ROW_IDS {
        let mut seeded = row();
        stamp_association_identity(&mut seeded, &schema(false), row_id, &identity).expect("stamp");
        let offer = text(&seeded.draft, "offer_id");
        assert_eq!(offer, format!("PH-{row_id}"));
        assert_eq!(text(&seeded.draft, "attribute_9024"), offer);
        assert_eq!(text(&seeded.draft, "attribute_9048"), identity.model_value);
        assert_eq!(
            model_value(&schema(false), &seeded.draft),
            identity.model_value
        );
        offers.push(offer);
        models.push(text(&seeded.draft, "attribute_9048"));
    }
    offers.sort();
    offers.dedup();
    models.dedup();
    assert_eq!(offers.len(), 3, "one offer id per size");
    assert_eq!(models.len(), 1, "one common model for the design");
    assert!(
        offers.iter().all(|offer| offer.len() <= 50),
        "inside Ozon's Seller-code limit"
    );
    // The same request re-derives the same identity: a retry is a replay.
    assert_eq!(
        association_identity(7, "db-1", "GRP-9", &image).expect("identity"),
        identity
    );
}

/// 同款不同源图、同款号不同库、不同 Workspace：都不合并。
#[test]
fn only_the_whole_design_tuple_merges() {
    let base = association_identity(7, "db-1", "GRP-9", &hex('a')).expect("identity");
    for other in [
        association_identity(7, "db-1", "GRP-9", &hex('b')).expect("other image"),
        association_identity(7, "db-2", "GRP-9", &hex('a')).expect("other database"),
        association_identity(8, "db-1", "GRP-9", &hex('a')).expect("other workspace"),
        association_identity(7, "db-1", "GRP-8", &hex('a')).expect("other variant group"),
    ] {
        assert_ne!(other.model_value, base.model_value);
        assert_ne!(other.association_id, base.association_id);
    }
    // The digest accepts the sha256: form and is case-insensitive, so a client
    // that echoes the digest back with a prefix is the same design.
    assert_eq!(
        association_identity(
            7,
            "db-1",
            "GRP-9",
            &format!("sha256:{}", hex('a').to_uppercase())
        )
        .expect("prefixed"),
        base
    );
}

#[test]
fn a_missing_source_identity_is_refused_instead_of_guessed() {
    let image = hex('a');
    for (source, group) in [
        ("", "GRP-9"),
        ("db-1", ""),
        ("   ", "GRP-9"),
        ("db-1", "  "),
    ] {
        assert_eq!(
            association_identity(7, source, group, &image),
            Err(AssociationRefusal::SourceIdentityEmpty)
        );
    }
    for bad in ["sha256:source", "", "abc", &hex('a')[..63]] {
        assert_eq!(
            association_identity(7, "db-1", "GRP-9", bad),
            Err(AssociationRefusal::SourceDigestInvalid),
            "{bad}"
        );
    }
}

/// 没有 plain 9048 / 只有复杂分组：入口拒绝，不半填。
#[test]
fn a_category_without_a_plain_model_field_is_unsupported() {
    let identity = association_identity(7, "db-1", "GRP-9", &hex('a')).expect("identity");
    for complex in [false, true] {
        let view = if complex {
            schema(true)
        } else {
            CategorySchemaView {
                fields: Vec::new(),
                ..schema(false)
            }
        };
        let mut seeded = row();
        assert_eq!(
            stamp_association_identity(&mut seeded, &view, ROW_IDS[0], &identity),
            Err(AssociationRefusal::ModelFieldUnsupported)
        );
        assert!(seeded.draft.values.is_empty(), "nothing is half-stamped");
        assert_eq!(model_value(&view, &seeded.draft), "");
        assert_eq!(model_field_key(&view), None);
    }
    assert_eq!(
        model_field_key(&schema(false)).as_deref(),
        Some("attribute_9048")
    );
}

/// The server identity replaces whatever the caller's draft claimed for these
/// keys — value, clear mark, hand-edited mark and origin all move together.
#[test]
fn stamping_replaces_caller_claims_for_the_identity_keys() {
    let identity = association_identity(7, "db-1", "GRP-9", &hex('a')).expect("identity");
    let mut seeded = row();
    for key in ["offer_id", "attribute_9024", "attribute_9048"] {
        seeded.draft.values.insert(
            key.to_owned(),
            WorkflowDraftValue::Text("caller-supplied".to_owned()),
        );
        seeded.hand_edited_keys.insert(key.to_owned());
        seeded.draft.cleared.insert(key.to_owned());
        seeded.field_origins.push(FieldValueOrigin {
            address: FieldAddress::Plain {
                field_key: key.to_owned(),
            },
            kind: FieldValueOriginKind::Manual,
            source_ref: None,
            updated_at_ms: 1,
        });
    }
    // A complex item's own value is untouched: only plain addresses are stamped.
    seeded.field_origins.push(FieldValueOrigin {
        address: FieldAddress::Complex {
            group_key: "7".to_owned(),
            item_id: "item_1".to_owned(),
            field_key: "attribute_9048".to_owned(),
            value_index: None,
        },
        kind: FieldValueOriginKind::Manual,
        source_ref: None,
        updated_at_ms: 1,
    });

    stamp_association_identity(&mut seeded, &schema(false), ROW_IDS[1], &identity).expect("stamp");

    assert!(seeded.draft.cleared.is_empty());
    assert!(seeded.hand_edited_keys.is_empty());
    assert_eq!(seeded.field_origins.len(), 1);
    assert!(matches!(
        seeded.field_origins[0].address,
        FieldAddress::Complex { .. }
    ));
    assert_eq!(
        text(&seeded.draft, "offer_id"),
        format!("PH-{}", ROW_IDS[1])
    );
}

#[test]
fn the_model_projection_reads_plain_text_only() {
    let view = schema(false);
    let mut draft = WorkflowCategoryDraft::default();
    assert_eq!(model_value(&view, &draft), "");
    draft.values.insert(
        "attribute_9048".to_owned(),
        WorkflowDraftValue::Text("  PHM-0123456789abcdef  ".to_owned()),
    );
    assert_eq!(model_value(&view, &draft), "PHM-0123456789abcdef");
    draft.values.insert(
        "attribute_9048".to_owned(),
        WorkflowDraftValue::Integer(9048),
    );
    assert_eq!(model_value(&view, &draft), "");
}

#[test]
fn a_create_fingerprint_binds_content_and_the_client_declaration() {
    let draft = WorkflowCategoryDraft {
        values: [(
            "attribute_9048".to_owned(),
            WorkflowDraftValue::Text("PHM-1".to_owned()),
        )]
        .into_iter()
        .collect(),
        ..WorkflowCategoryDraft::default()
    };
    let identity = association_identity(7, "db-1", "GRP-9", &hex('a')).expect("identity");
    let base = CreateRequestContent {
        card_id: "card-1",
        store_id: Some("store-1"),
        source_sha256: &hex('a'),
        source_file_name: "design.psd",
        association: Some(&identity),
        draft: Some(&draft),
        client_fingerprint: "client-1",
    };
    let fingerprint = create_request_fingerprint(&base).expect("fingerprint");
    assert!(fingerprint.starts_with("sha256:"));

    // The same parsed content fingerprints the same however the JSON was keyed.
    let swapped = WorkflowCategoryDraft {
        values: draft
            .values
            .iter()
            .rev()
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        ..WorkflowCategoryDraft::default()
    };
    assert_eq!(
        create_request_fingerprint(&CreateRequestContent {
            draft: Some(&swapped),
            ..base
        })
        .expect("fingerprint"),
        fingerprint
    );

    let mut changed_draft = draft.clone();
    changed_draft.values.insert(
        "attribute_9048".to_owned(),
        WorkflowDraftValue::Text("PHM-2".to_owned()),
    );
    for changed in [
        CreateRequestContent {
            store_id: None,
            ..base
        },
        CreateRequestContent {
            source_file_name: "other.psd",
            ..base
        },
        CreateRequestContent {
            draft: None,
            ..base
        },
        CreateRequestContent {
            draft: Some(&changed_draft),
            ..base
        },
        CreateRequestContent {
            client_fingerprint: "client-2",
            ..base
        },
    ] {
        assert_ne!(
            create_request_fingerprint(&changed).expect("fingerprint"),
            fingerprint
        );
    }
}

//! Seeding never carries system media (the video group 100001 and the cover
//! group 100002) into a fresh row: not from the supplied Draft, not from Card
//! defaults saved before the write guard. The schema below carries both
//! groups keyed the way the live schema builder keys them, a plain alias of
//! the video URL attribute, and one ordinary group.

use std::collections::{BTreeMap, BTreeSet};

use crate::envelope::RowSource;
use crate::ops::golden_tests::{golden_card, golden_schema_material};
use crate::ops::{Ctx, SchemaMaterial, seed_row};
use crate::projections::category_schema_view;
use crate::records::{
    CategorySchemaSnapshot, FieldAddress, FieldValueOriginKind, ListingFieldDefinition,
    ListingFieldEditor,
};
use crate::validate::DictionaryMaterials;
use crate::{
    CategorySchemaView, WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem,
    WorkflowDraftValue,
};

use super::seed_gaps;

const FORGED: &str = "https://evil.example.invalid/forged.mp4";
/// An ordinary complex group of the schema below; its one field is `part`.
const PART_GROUP: i64 = 7;
/// Every key that names system media under the schema below.
const SYSTEM_KEYS: [&str; 5] = [
    "video_url",
    "attribute_21837",
    "attribute_21841",
    "attribute_22273",
    "attribute_21845",
];

fn attribute_field(
    key: &str,
    attribute_id: i64,
    complex_id: Option<i64>,
) -> ListingFieldDefinition {
    ListingFieldDefinition {
        key: key.to_owned(),
        label: key.to_owned(),
        group: "属性".to_owned(),
        attribute_id: Some(attribute_id.to_string()),
        complex_id: complex_id.map(|id| id.to_string()),
        complex_group_collection: complex_id.is_some(),
        ..ListingFieldDefinition::default()
    }
}

/// Both system groups under their canonical keys, plus `video_url`: the video
/// URL attribute under a plain schema alias.
fn system_fields() -> Vec<ListingFieldDefinition> {
    let mut fields = vec![attribute_field("video_url", 21841, None)];
    for (attribute, group) in [
        (21837, 100001),
        (21841, 100001),
        (22273, 100001),
        (21845, 100002),
    ] {
        let key = ListingFieldDefinition::attribute_key(attribute);
        fields.push(attribute_field(&key, attribute, Some(group)));
    }
    fields
}

fn plain_field(key: &str) -> ListingFieldDefinition {
    ListingFieldDefinition::plain(key, key, "基础", ListingFieldEditor::Text, false)
}

fn view() -> CategorySchemaView {
    let mut fields: Vec<_> = ["style", "material", "finish"]
        .into_iter()
        .map(plain_field)
        .collect();
    fields.push(attribute_field("part", 9999, Some(PART_GROUP)));
    fields.extend(system_fields());
    let snapshot = CategorySchemaSnapshot {
        category_key: "system-media-seed".to_owned(),
        label: "测试类目".to_owned(),
        description_category_id: 1,
        type_id: 2,
        schema_revision: "system-media-seed-v1".to_owned(),
        recipe_id: 0,
        recipe_revision: 1,
        catalog_schema_version: 1,
        fields,
    };
    category_schema_view(&snapshot, None)
}

fn text(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Text(value.to_owned())
}

fn url(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Url(value.to_owned())
}

fn values(pairs: &[(&str, WorkflowDraftValue)]) -> BTreeMap<String, WorkflowDraftValue> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect()
}

fn keys(keys: &[&str]) -> BTreeSet<String> {
    keys.iter().map(|key| (*key).to_owned()).collect()
}

fn item(item_id: &str, pairs: &[(&str, WorkflowDraftValue)]) -> WorkflowComplexDraftItem {
    WorkflowComplexDraftItem {
        item_id: item_id.to_owned(),
        values: values(pairs),
    }
}

fn group(complex_id: i64, items: Vec<WorkflowComplexDraftItem>) -> WorkflowComplexDraftGroup {
    WorkflowComplexDraftGroup { complex_id, items }
}

/// One ordinary item in `complex_id`: its own value under `key`, and a
/// forged cover URL beside it when `with_cover`.
fn ordinary(
    complex_id: i64,
    key: &str,
    id: &str,
    own: &str,
    with_cover: bool,
) -> WorkflowComplexDraftGroup {
    let mut item = item(id, &[(key, text(own))]);
    if with_cover {
        item.values
            .insert("attribute_21845".to_owned(), url(FORGED));
    }
    group(complex_id, vec![item])
}

/// The video and cover groups exactly as a legacy Card or a forged Draft
/// would hold them.
fn system_groups() -> Vec<WorkflowComplexDraftGroup> {
    let video = item(
        "video-1",
        &[
            ("attribute_21837", text("old title")),
            ("attribute_21841", url(FORGED)),
            ("attribute_22273", text("OLD-OFFER")),
        ],
    );
    let cover = item("cover-1", &[("attribute_21845", url(FORGED))]);
    vec![group(100001, vec![video]), group(100002, vec![cover])]
}

fn assert_no_system_media(draft: &WorkflowCategoryDraft) {
    let json = serde_json::to_string(draft).expect("draft json");
    assert!(!json.contains("evil.example.invalid"), "{json}");
    for key in SYSTEM_KEYS {
        assert!(!json.contains(key), "{key} left in {json}");
    }
    assert!(
        draft
            .complex_values
            .iter()
            .all(|group| group.complex_id != 100001 && group.complex_id != 100002),
        "{json}"
    );
}

#[test]
fn legacy_card_defaults_seed_without_system_media_and_everything_else_still_fills() {
    let mut draft = WorkflowCategoryDraft {
        values: values(&[("style", text("own"))]),
        ..Default::default()
    };
    let mut complex_values = system_groups();
    complex_values.push(ordinary(PART_GROUP, "part", "part-1", "default", true));
    let defaults = WorkflowCategoryDraft {
        values: values(&[
            ("style", text("default")),
            ("material", text("canvas")),
            ("video_url", url(FORGED)),
            ("attribute_21837", text("old title")),
        ]),
        cleared: keys(&["finish", "attribute_22273"]),
        complex_values,
    };

    seed_gaps(&view(), &mut draft, defaults);

    assert_no_system_media(&draft);
    assert_eq!(
        draft.values,
        values(&[("style", text("own")), ("material", text("canvas"))]),
        "the supplied value wins and the ordinary default fills its gap"
    );
    assert_eq!(draft.cleared, keys(&["finish"]));
    assert_eq!(
        draft.complex_values,
        vec![ordinary(PART_GROUP, "part", "part-1", "default", false)],
        "the ordinary group keeps its own value without the foreign cover key"
    );
}

#[test]
fn a_supplied_draft_loses_its_system_media_and_keeps_its_own_order_and_clears() {
    let mut parts = ordinary(PART_GROUP, "part", "part-b", "B", true);
    parts.items.push(item("part-a", &[("part", text("A"))]));
    let mut complex_values = system_groups();
    complex_values.push(parts);
    let mut draft = WorkflowCategoryDraft {
        values: values(&[
            ("style", text("own")),
            ("video_url", url(FORGED)),
            ("attribute_21845", url(FORGED)),
        ]),
        cleared: keys(&["material", "attribute_21841"]),
        complex_values,
    };
    let defaults = WorkflowCategoryDraft {
        values: values(&[
            ("style", text("default")),
            ("material", text("canvas")),
            ("finish", text("matte")),
        ]),
        ..Default::default()
    };

    seed_gaps(&view(), &mut draft, defaults);

    assert_no_system_media(&draft);
    assert_eq!(
        draft.values,
        values(&[("style", text("own")), ("finish", text("matte"))])
    );
    assert_eq!(
        draft.cleared,
        keys(&["material"]),
        "an ordinary clear is still never backfilled"
    );
    let mut expected = ordinary(PART_GROUP, "part", "part-b", "B", false);
    expected.items.push(item("part-a", &[("part", text("A"))]));
    assert_eq!(
        draft.complex_values,
        vec![expected],
        "items keep their order"
    );
}

#[test]
fn an_item_holding_only_system_media_does_not_block_the_default_group() {
    let cover_only = item("part-x", &[("attribute_21845", url(FORGED))]);
    let mut draft = WorkflowCategoryDraft {
        complex_values: vec![group(PART_GROUP, vec![cover_only])],
        ..Default::default()
    };
    let defaults = WorkflowCategoryDraft {
        complex_values: vec![ordinary(PART_GROUP, "part", "part-1", "default", false)],
        ..Default::default()
    };

    seed_gaps(&view(), &mut draft, defaults);

    assert_eq!(
        draft.complex_values,
        vec![ordinary(PART_GROUP, "part", "part-1", "default", false)]
    );
}

#[test]
fn seed_row_records_no_system_media_address_and_keeps_manual_and_card_default_origins() {
    let mut snapshot = golden_schema_material().snapshot().clone();
    std::sync::Arc::make_mut(&mut snapshot)
        .fields
        .extend(system_fields());
    let schema = SchemaMaterial::new(snapshot, DictionaryMaterials::default());
    let mut complex_values = system_groups();
    complex_values.push(ordinary(10, "size", "size-default", "large", true));
    let card = golden_card(WorkflowCategoryDraft {
        values: values(&[
            ("offer_id", text("ART-DEFAULT")),
            ("attribute_21841", url(FORGED)),
        ]),
        cleared: keys(&["attribute_22273"]),
        complex_values,
    });
    let supplied = WorkflowCategoryDraft {
        values: values(&[("name", text("wall art")), ("video_url", url(FORGED))]),
        cleared: keys(&["price"]),
        complex_values: vec![system_groups().remove(1)],
    };
    let mut next = 0u128;
    let mut ids = move || {
        next += 1;
        next.to_be_bytes()
    };
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_000,
        ids: &mut ids,
    };
    let source = RowSource {
        asset_id: String::new(),
        sha256: "sha256:source-system-media".to_owned(),
        file_name: "system-media.psd".to_owned(),
    };

    let row = seed_row(&ctx, source, Some(supplied));

    assert_no_system_media(&row.draft);
    assert_eq!(row.draft.values.get("name"), Some(&text("wall art")));
    assert_eq!(row.draft.values.get("offer_id"), Some(&text("ART-DEFAULT")));
    assert!(row.draft.cleared.contains("price"));
    assert_eq!(
        row.draft.complex_values,
        vec![ordinary(10, "size", "size-default", "large", false)]
    );
    assert_eq!(row.hand_edited_keys, keys(&["name"]));
    let kind_at = |address: FieldAddress| {
        row.field_origins
            .iter()
            .find(|origin| origin.address == address)
            .map(|origin| origin.kind)
    };
    let plain = |key: &str| FieldAddress::Plain {
        field_key: key.to_owned(),
    };
    let size = FieldAddress::Complex {
        group_key: "10".to_owned(),
        item_id: "size-default".to_owned(),
        field_key: "size".to_owned(),
        value_index: None,
    };
    assert_eq!(kind_at(plain("name")), Some(FieldValueOriginKind::Manual));
    let card_default = Some(FieldValueOriginKind::CardDefault);
    assert_eq!(kind_at(plain("offer_id")), card_default);
    assert_eq!(kind_at(size), card_default);
    for origin in &row.field_origins {
        let (group, key) = match &origin.address {
            FieldAddress::Plain { field_key } => (None, field_key.as_str()),
            FieldAddress::Complex {
                group_key,
                field_key,
                ..
            } => (Some(group_key.as_str()), field_key.as_str()),
        };
        assert!(
            !matches!(group, Some("100001" | "100002")) && !SYSTEM_KEYS.contains(&key),
            "no origin names system media: {origin:?}"
        );
    }
}

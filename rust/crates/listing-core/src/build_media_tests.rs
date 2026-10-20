//! System media — Ozon's product-video group 100001 (21837 / 21841 / 22273)
//! and video-cover group 100002 (21845) — through the one build every send
//! path shares (the Cloud Draft and row sends, op 11 freeze).
//!
//! Whatever a Draft, a stored Card default or a replayed Manual origin puts
//! on a system field — raw group, plain value, clear, schema alias, or an
//! item value inside another group — is gone from the built Draft, its
//! sources and the frozen body. The media evidence alone still produces the
//! two groups, and ordinary plain and complex fields are untouched.

use super::*;
use crate::compose::compose_frozen_import;
use crate::compose::compose_tests::{golden_card, golden_row};
use crate::projections::{category_schema_view, system_media_draft_error};
use crate::records::{FieldValueOrigin, ListingFieldDefinition, ListingFieldEditor};
use crate::{
    WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowVideoMetadata,
    WorkflowVideoOrigin, WorkflowVideoRole,
};

const FORGED_VIDEO: &str = "https://evil.example.invalid/forged.mp4";
const FORGED_COVER: &str = "https://evil.example.invalid/forged-cover.jpg";
const MANAGED_VIDEO: &str = "https://media.example.invalid/videos/clip.mp4";
const MANAGED_COVER: &str = "https://media.example.invalid/images/cover.jpg";
/// A schema key for the video URL attribute that is not its canonical
/// `attribute_21841`.
const VIDEO_ALIAS: &str = "product_video_url";
/// An ordinary complex group and its one field.
const OTHER_GROUP: i64 = 7;
const OTHER_FIELD: &str = "attribute_9999";
/// Every key a system media value may hide under in these schemas.
const SYSTEM_KEYS: [&str; 5] = [
    "attribute_21837",
    "attribute_21841",
    "attribute_22273",
    "attribute_21845",
    VIDEO_ALIAS,
];

fn field(key: &str, attribute_id: i64, complex_id: Option<i64>) -> ListingFieldDefinition {
    ListingFieldDefinition {
        key: key.to_owned(),
        label: key.to_owned(),
        group: "属性".to_owned(),
        editor: ListingFieldEditor::Text,
        attribute_id: Some(attribute_id.to_string()),
        complex_id: complex_id.map(|id| id.to_string()),
        complex_group_collection: complex_id.is_some(),
        ..ListingFieldDefinition::default()
    }
}

/// The system media fields keyed the way the live schema builder keys them
/// (`attribute_{id}` inside 100001 / 100002), a plain alias of the video URL
/// attribute, and one ordinary complex group.
fn system_media_fields() -> Vec<ListingFieldDefinition> {
    vec![
        field("attribute_21837", 21837, Some(100001)),
        field("attribute_21841", 21841, Some(100001)),
        field("attribute_22273", 22273, Some(100001)),
        field("attribute_21845", 21845, Some(100002)),
        field(VIDEO_ALIAS, 21841, None),
        field(OTHER_FIELD, 9999, Some(OTHER_GROUP)),
    ]
}

fn row_with_system_schema() -> RowPayload {
    let mut row = golden_row();
    std::sync::Arc::make_mut(&mut row.schema_snapshot)
        .fields
        .extend(system_media_fields());
    row
}

fn text(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Text(value.to_owned())
}

fn url(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Url(value.to_owned())
}

fn item(item_id: &str, values: &[(&str, WorkflowDraftValue)]) -> WorkflowComplexDraftItem {
    WorkflowComplexDraftItem {
        item_id: item_id.to_owned(),
        values: values
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    }
}

fn group(complex_id: i64, items: Vec<WorkflowComplexDraftItem>) -> WorkflowComplexDraftGroup {
    WorkflowComplexDraftGroup { complex_id, items }
}

fn complex(complex_id: i64, item_id: &str, key: &str) -> FieldAddress {
    FieldAddress::Complex {
        group_key: complex_id.to_string(),
        item_id: item_id.to_owned(),
        field_key: key.to_owned(),
        value_index: None,
    }
}

fn manual(address: FieldAddress) -> FieldValueOrigin {
    FieldValueOrigin {
        address,
        kind: FieldValueOriginKind::Manual,
        source_ref: None,
        updated_at_ms: 1,
    }
}

fn video(role: WorkflowVideoRole, public_url: &str) -> WorkflowVideoMetadata {
    WorkflowVideoMetadata {
        role,
        origin: WorkflowVideoOrigin::ManagedUpload,
        file_name: "clip.mp4".to_owned(),
        content_type: "video/mp4".to_owned(),
        size_bytes: 4096,
        duration_ms: 10_000,
        public_url: Some(public_url.to_owned()),
        object_key: None,
        content_hash: None,
    }
}

/// No system group, no system key anywhere in the built Draft, and no source
/// left pointing at one.
fn assert_no_system_media(built: &BuiltListing) {
    let draft = &built.draft;
    assert!(
        draft
            .complex_values
            .iter()
            .all(|group| group.complex_id != 100001 && group.complex_id != 100002),
        "{:?}",
        draft.complex_values
    );
    for key in SYSTEM_KEYS {
        assert!(!draft.values.contains_key(key), "{key}");
        assert!(!draft.cleared.contains(key), "{key}");
        assert!(
            draft
                .complex_values
                .iter()
                .flat_map(|group| &group.items)
                .all(|item| !item.values.contains_key(key)),
            "{key}"
        );
    }
    let system_address = |address: &FieldAddress| match address {
        FieldAddress::Plain { field_key } => SYSTEM_KEYS.contains(&field_key.as_str()),
        FieldAddress::Complex {
            group_key,
            field_key,
            ..
        } => {
            group_key == "100001"
                || group_key == "100002"
                || SYSTEM_KEYS.contains(&field_key.as_str())
        }
    };
    assert!(
        built
            .sources
            .iter()
            .all(|(address, _)| !system_address(address)),
        "{:?}",
        built.sources
    );
}

/// The frozen `/v3/product/import` body of `row` under `card`.
fn frozen(row: &RowPayload, card: &CardPayload) -> serde_json::Value {
    compose_frozen_import("row-system-media", row, card)
        .expect("the ordinary fields still validate and freeze")
        .import
}

/// `(complex_id, attribute_id, value)` of every attribute in the frozen body,
/// plain and complex, sorted.
fn frozen_attributes(import: &serde_json::Value) -> Vec<(i64, i64, String)> {
    let item = &import["items"][0];
    let top_level = item["attributes"].as_array().into_iter().flatten();
    let grouped = item["complex_attributes"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|group| group["attributes"].as_array().into_iter().flatten());
    let mut attributes: Vec<(i64, i64, String)> = top_level
        .chain(grouped)
        .map(|attribute| {
            (
                attribute["complex_id"].as_i64().expect("complex_id"),
                attribute["id"].as_i64().expect("id"),
                attribute["values"][0]["value"]
                    .as_str()
                    .expect("value")
                    .to_owned(),
            )
        })
        .collect();
    attributes.sort();
    attributes
}

fn system_attributes(import: &serde_json::Value) -> Vec<(i64, i64, String)> {
    frozen_attributes(import)
        .into_iter()
        .filter(|(_, id, _)| [21837, 21841, 22273, 21845].contains(id))
        .collect()
}

/// A stable item in 100001 / 100002 that also carries an instance-owned key
/// survives the Card overlay, and its Manual origins would replay the forged
/// URLs onto it; the build drops the whole group instead.
#[test]
fn manual_origins_on_system_groups_never_reach_the_built_draft_or_the_body() {
    let mut row = row_with_system_schema();
    row.draft.complex_values = vec![
        group(
            100001,
            vec![item(
                "video-item-1",
                &[
                    ("name", text("Owned")),
                    ("attribute_21837", text("Forged title")),
                    ("attribute_21841", url(FORGED_VIDEO)),
                    ("attribute_22273", text("ART-001")),
                ],
            )],
        ),
        group(
            100002,
            vec![item(
                "cover-item-1",
                &[
                    ("name", text("Owned")),
                    ("attribute_21845", url(FORGED_COVER)),
                ],
            )],
        ),
    ];
    row.field_origins = ["attribute_21837", "attribute_21841", "attribute_22273"]
        .into_iter()
        .map(|key| manual(complex(100001, "video-item-1", key)))
        .chain([manual(complex(100002, "cover-item-1", "attribute_21845"))])
        .collect();
    let card = golden_card();

    // The path is real: the overlay the build starts from keeps both items.
    let schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let overlaid = overlay_current_card_defaults(
        row.draft.clone(),
        &card.defaults,
        &schema,
        &row.hand_edited_keys,
    );
    assert!(
        overlaid
            .complex_values
            .iter()
            .any(|group| group.complex_id == 100001 && group.items[0].item_id == "video-item-1"),
        "{:?}",
        overlaid.complex_values
    );

    let built = build_listing(&row, &card);
    assert_no_system_media(&built);
    assert!(built.media.product_videos.is_empty());
    assert!(built.media.video_cover_url.is_none());

    let body = frozen(&row, &card);
    assert_eq!(system_attributes(&body), Vec::new(), "{body}");
    assert!(!body.to_string().contains("evil.example.invalid"), "{body}");
}

/// A plain value, a plain alias and a clear on system fields, and a system
/// key inside an ordinary group, are dropped; the ordinary group's own field
/// and every plain default stay as they were.
#[test]
fn plain_cleared_aliased_and_foreign_group_system_values_are_dropped() {
    let mut row = row_with_system_schema();
    row.draft
        .values
        .insert("attribute_21841".to_owned(), url(FORGED_VIDEO));
    row.draft
        .values
        .insert(VIDEO_ALIAS.to_owned(), url(FORGED_VIDEO));
    row.draft.cleared.insert("attribute_21845".to_owned());
    row.draft.complex_values = vec![group(
        OTHER_GROUP,
        vec![item(
            "other-item-1",
            &[
                ("name", text("Owned")),
                (OTHER_FIELD, text("kept")),
                ("attribute_21845", url(FORGED_COVER)),
            ],
        )],
    )];
    row.field_origins = vec![
        manual(plain("attribute_21841")),
        manual(plain(VIDEO_ALIAS)),
        manual(plain("attribute_21845")),
        manual(complex(OTHER_GROUP, "other-item-1", OTHER_FIELD)),
        manual(complex(OTHER_GROUP, "other-item-1", "attribute_21845")),
    ];
    let card = golden_card();

    let built = build_listing(&row, &card);
    assert_no_system_media(&built);
    let other = built
        .draft
        .complex_values
        .iter()
        .find(|group| group.complex_id == OTHER_GROUP)
        .expect("the ordinary group stays");
    assert_eq!(other.items[0].values.get(OTHER_FIELD), Some(&text("kept")));
    assert_eq!(
        built.source_of(&complex(OTHER_GROUP, "other-item-1", OTHER_FIELD)),
        Some(FieldLayer::UserCustom)
    );
    assert_eq!(built.draft.values.get("price"), Some(&text("90")));
    assert_eq!(
        built.source_of(&plain("price")),
        Some(FieldLayer::DatabaseDefault)
    );

    let body = frozen(&row, &card);
    assert_eq!(system_attributes(&body), Vec::new(), "{body}");
    assert!(
        frozen_attributes(&body).contains(&(OTHER_GROUP, 9999, "kept".to_owned())),
        "{body}"
    );
    assert!(!body.to_string().contains("evil.example.invalid"), "{body}");
}

/// A Card stored before the write guard existed may still hold system media
/// in its defaults. The build never lets them out; ordinary defaults, plain
/// and complex, still build and send.
#[test]
fn stored_card_defaults_never_carry_system_media_into_the_build() {
    let row = row_with_system_schema();
    let mut card = golden_card();
    card.defaults.complex_values = vec![
        group(
            100001,
            vec![item(
                "",
                &[
                    ("attribute_21837", text("Forged title")),
                    ("attribute_21841", url(FORGED_VIDEO)),
                ],
            )],
        ),
        group(
            OTHER_GROUP,
            vec![item(
                "",
                &[
                    (OTHER_FIELD, text("card-kept")),
                    ("attribute_21845", url(FORGED_COVER)),
                ],
            )],
        ),
    ];
    card.defaults
        .values
        .insert(VIDEO_ALIAS.to_owned(), url(FORGED_VIDEO));
    card.defaults
        .values
        .insert("attribute_21845".to_owned(), url(FORGED_COVER));

    let built = build_listing(&row, &card);
    assert_no_system_media(&built);
    assert_eq!(built.draft.values.get("price"), Some(&text("90")));

    let body = frozen(&row, &card);
    assert_eq!(system_attributes(&body), Vec::new(), "{body}");
    assert!(
        frozen_attributes(&body).contains(&(OTHER_GROUP, 9999, "card-kept".to_owned())),
        "{body}"
    );
    assert!(!body.to_string().contains("evil.example.invalid"), "{body}");
}

/// The media evidence still produces both system groups — with its own URLs,
/// never a Draft value that tried to ride along.
#[test]
fn media_evidence_alone_produces_the_system_groups() {
    let mut row = row_with_system_schema();
    row.media.videos = vec![video(WorkflowVideoRole::Product, MANAGED_VIDEO)];
    row.media.video_cover = Some(video(WorkflowVideoRole::Cover, MANAGED_COVER));
    row.draft.complex_values = vec![group(
        100001,
        vec![item(
            "video-item-1",
            &[
                ("name", text("Owned")),
                ("attribute_21841", url(FORGED_VIDEO)),
            ],
        )],
    )];
    row.field_origins = vec![manual(complex(100001, "video-item-1", "attribute_21841"))];
    let card = golden_card();

    let built = build_listing(&row, &card);
    assert_no_system_media(&built);
    assert_eq!(built.media.product_videos.len(), 1);
    assert_eq!(built.media.product_videos[0].public_url, MANAGED_VIDEO);
    assert_eq!(built.media.video_cover_url.as_deref(), Some(MANAGED_COVER));

    let body = frozen(&row, &card);
    let offer_id = body["items"][0]["offer_id"]
        .as_str()
        .expect("offer_id")
        .to_owned();
    assert_eq!(
        system_attributes(&body),
        vec![
            (100001, 21837, "clip.mp4".to_owned()),
            (100001, 21841, MANAGED_VIDEO.to_owned()),
            (100001, 22273, offer_id),
            (100002, 21845, MANAGED_COVER.to_owned()),
        ],
        "{body}"
    );
    assert!(!body.to_string().contains("evil.example.invalid"), "{body}");
}

/// The write guard (Draft edits, Card defaults, the Cloud Draft send) names
/// the same fields the build drops. Without a cached schema it still knows
/// the raw groups and the canonical keys; an alias needs the schema.
#[test]
fn the_write_guard_refuses_what_the_build_drops_with_or_without_a_schema() {
    let cached = system_media_fields();
    let refused = |draft: &WorkflowCategoryDraft, with_schema: bool| {
        let fields: &[ListingFieldDefinition] = if with_schema { &cached } else { &[] };
        system_media_draft_error(fields, draft).is_some()
    };
    let plain_value = |key: &str| WorkflowCategoryDraft {
        values: [(key.to_owned(), url(FORGED_VIDEO))].into_iter().collect(),
        ..WorkflowCategoryDraft::default()
    };
    let cleared = WorkflowCategoryDraft {
        cleared: ["attribute_21845".to_owned()].into_iter().collect(),
        ..WorkflowCategoryDraft::default()
    };
    let raw_group = WorkflowCategoryDraft {
        complex_values: vec![group(100002, Vec::new())],
        ..WorkflowCategoryDraft::default()
    };
    let foreign_group = WorkflowCategoryDraft {
        complex_values: vec![group(
            OTHER_GROUP,
            vec![item(
                "other-item-1",
                &[("attribute_21841", url(FORGED_VIDEO))],
            )],
        )],
        ..WorkflowCategoryDraft::default()
    };
    for with_schema in [false, true] {
        for (label, draft) in [
            ("plain canonical key", plain_value("attribute_21841")),
            ("cleared canonical key", cleared.clone()),
            ("raw system group", raw_group.clone()),
            ("system key in another group", foreign_group.clone()),
        ] {
            assert!(
                refused(&draft, with_schema),
                "{label}, schema {with_schema}"
            );
        }
    }
    assert!(refused(&plain_value(VIDEO_ALIAS), true));
    assert!(!refused(&plain_value(VIDEO_ALIAS), false));

    let ordinary = WorkflowCategoryDraft {
        values: golden_card().defaults.values,
        complex_values: vec![group(
            OTHER_GROUP,
            vec![item("other-item-1", &[(OTHER_FIELD, text("kept"))])],
        )],
        ..WorkflowCategoryDraft::default()
    };
    assert!(!refused(&ordinary, true));
    assert!(!refused(&ordinary, false));
}

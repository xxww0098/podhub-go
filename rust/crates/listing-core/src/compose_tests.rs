//! Byte-equality proof for the frozen `/v3/product/import` body.
//!
//! `fixtures/listing/ozon/product-import-request.json` and the pinned digest
//! are the same artefacts `product_import.rs`'s own tests assert against, so
//! the two serialization paths stay equal through the shared fixture. If any
//! of these three constants move, an already-dispatched listing looks new and
//! Ozon can be submitted twice.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::{
    WorkflowAiFieldPolicy, WorkflowCategoryDraft, WorkflowDraftValue, WorkflowImageLifecycle,
    WorkflowImagePhase, WorkflowLanguage,
};
#[cfg(test)]
use crate::{WorkflowVideoMetadata, WorkflowVideoOrigin, WorkflowVideoRole};
use serde_json::Value;

use super::*;
#[cfg(test)]
use crate::build::build_listing;
use crate::categories::decorative_wall_art;
use crate::envelope::{CardQueue, RowAi, RowMedia, RowSource};

/// The digest of the wire-golden Validated Draft. `product_import.rs` pins the
/// same value; the two must never diverge.
pub const PINNED_REQUEST_DIGEST: &str =
    "sha256:86486aa18947881ff742c51d4d3a26b03e8972caa18be7d257625325643b0e89";
#[cfg(test)]
const GOLDEN_ROW_ID: &str = "draft-ozon-golden";
const HERO: &str = "https://media.example.invalid/hero.jpg";

/// These goldens live at the repository root (`fixtures/listing`), shared
/// with `migration`'s own drain test (`listing_submit_outbox_drain_tests.rs`)
/// — not duplicated into this crate, so the two suites cannot silently drift
/// onto different bytes.
/// `CARGO_MANIFEST_DIR` is this crate's own directory (`rust/crates/listing-core`),
/// two levels below the repository root.
fn fixtures_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing")
}

/// Raw operator input for the wire golden, exactly as
/// `fixtures/listing/validation/success-normalized.json` records it —
/// untrimmed, so normalization is part of what the golden proves.
pub fn golden_draft_values() -> BTreeMap<String, WorkflowDraftValue> {
    let path = fixtures_root().join("validation/success-normalized.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let case: Value =
        serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    let values: BTreeMap<String, String> = serde_json::from_value(case["field_values"].clone())
        .expect("fixture field_values must be a string map");
    values
        .into_iter()
        .map(|(key, value)| (key, WorkflowDraftValue::Text(value)))
        .collect()
}

/// Fields the Product Instance owns (identity, prose, media) live on the row;
/// everything else is a shared Card default, so composing has to put the two
/// halves back together before it can serialize anything.
const ROW_OWNED_KEYS: [&str; 3] = ["offer_id", "name", "description"];

pub fn golden_row() -> RowPayload {
    let schema = decorative_wall_art::local_schema_snapshot();
    let values = golden_draft_values()
        .into_iter()
        .filter(|(key, _)| ROW_OWNED_KEYS.contains(&key.as_str()))
        .collect();
    RowPayload {
        category_key: schema.category_key.clone(),
        description_category_id: schema.description_category_id,
        type_id: schema.type_id,
        supplier_product_id: None,
        language: WorkflowLanguage::Default,
        schema_revision: schema.schema_revision.clone(),
        schema_snapshot: std::sync::Arc::new(schema),
        draft: WorkflowCategoryDraft {
            values,
            complex_values: Vec::new(),
            ..Default::default()
        },
        hand_edited_keys: BTreeSet::new(),
        field_origins: Vec::new(),
        normalized_snapshot: None,
        validation_issues: Vec::new(),
        source: RowSource {
            asset_id: "asset_golden".to_owned(),
            sha256: "sha256:source".to_owned(),
            file_name: "ART-001.psd".to_owned(),
        },
        render_evidence: None,
        media: RowMedia {
            images: vec![public_ready_image(0, HERO, "")],
            videos: Vec::new(),
            video_cover: None,
        },
        ai: RowAi::default(),
        failure_log: Vec::new(),
    }
}

pub fn golden_card() -> CardPayload {
    let schema = decorative_wall_art::local_schema_snapshot();
    let defaults = golden_draft_values()
        .into_iter()
        .filter(|(key, _)| !ROW_OWNED_KEYS.contains(&key.as_str()))
        .collect();
    CardPayload {
        category_key: schema.category_key.clone(),
        description_category_id: schema.description_category_id,
        type_id: schema.type_id,
        language: WorkflowLanguage::Default,
        defaults: WorkflowCategoryDraft {
            values: defaults,
            complex_values: Vec::new(),
            ..Default::default()
        },
        ai_prompt_id: String::new(),
        ai_prompt_sha256: String::new(),
        supplier_product_id: None,
        psd_template_asset_id: String::new(),
        psd_template_sha256: String::new(),
        psd_template_file_name: String::new(),
        ai_field_policy: WorkflowAiFieldPolicy {
            allowed_field_keys: Vec::new(),
            protected_field_keys: Vec::new(),
        },
        videos: Vec::new(),
        video_cover: None,
        queue: CardQueue::default(),
    }
}

pub fn public_ready_image(index: u32, url: &str, group_name: &str) -> WorkflowImageLifecycle {
    WorkflowImageLifecycle {
        account_id: None,
        index,
        file_name: format!("ART-001-{}.jpg", index + 1),
        content_hash: format!("sha256:slice-{index}"),
        group_name: group_name.to_owned(),
        width: 900,
        height: 1200,
        byte_size: Some(2048),
        phase: WorkflowImagePhase::PublicReady,
        public_url: Some(url.to_owned()),
        object_key: None,
        error_code: None,
    }
}

pub fn golden_import() -> Value {
    let path = fixtures_root().join("ozon/product-import-request.json");
    let raw = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&raw).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The Cloud compose path emits the same bytes as the wire golden, keyed by
/// the same three identities.
#[test]
fn compose_frozen_import_equals_the_wire_golden_and_its_pinned_identities() {
    let frozen = compose_frozen_import(GOLDEN_ROW_ID, &golden_row(), &golden_card())
        .expect("golden row must compose");

    assert_eq!(
        frozen.import,
        golden_import(),
        "frozen import no longer equals fixtures/listing/ozon/product-import-request.json"
    );
    assert_eq!(
        frozen.digest, PINNED_REQUEST_DIGEST,
        "idempotency identity changed: the wire-golden request digest moved"
    );
    assert_eq!(frozen.offer_id, "ART-001");
    assert_eq!(
        frozen.client_operation_id,
        format!("workflow:{GOLDEN_ROW_ID}:ART-001:{PINNED_REQUEST_DIGEST}"),
        "clientOperationId must stay workflow:{{row}}:{{offer}}:{{digest}}"
    );
}

#[test]
fn serialize_validated_copies_the_snapshot_and_leaves_the_row_draft() {
    let row = golden_row();
    let card = golden_card();
    let before = row.draft.clone();
    let built = build_listing(&row, &card);
    assert_eq!(row.draft, before);
    let validated = validate_built(
        &row,
        &built.draft,
        &crate::validate::DictionaryMaterials::default(),
    )
    .expect("golden builds");
    let request = serialize_validated(&validated, &built.media).expect("serialize");
    let frozen = compose_frozen_import(GOLDEN_ROW_ID, &row, &card).expect("freeze");
    assert_eq!(serde_json::to_value(&request).unwrap(), frozen.import);
    assert_eq!(
        request.items[0].attributes.len(),
        validated.snapshot.attributes.len()
    );
    for (wire, normalized) in request.items[0]
        .attributes
        .iter()
        .zip(&validated.snapshot.attributes)
    {
        assert_eq!(wire.values.len(), normalized.values.len());
    }
}

/// The card overlay is not decoration: without it the shared defaults are gone
/// and the row cannot validate at all.
#[test]
fn a_row_without_its_card_defaults_cannot_be_frozen() {
    let mut card = golden_card();
    card.defaults = WorkflowCategoryDraft::default();

    assert!(matches!(
        compose_frozen_import(GOLDEN_ROW_ID, &golden_row(), &card),
        Err(ListingError::NotValidated)
    ));
}

/// Filename stem and public slices are send-time, not a second Draft the
/// operator has to paste into the row.
#[test]
fn compose_stamps_filename_identity_and_public_slices_when_the_row_omits_them() {
    let mut row = golden_row();
    row.draft.values.remove("offer_id");
    let mut card = golden_card();
    card.defaults.values.remove("images");
    card.defaults.values.remove("primary_image");
    card.defaults.values.remove("color_image");

    let frozen = compose_frozen_import(GOLDEN_ROW_ID, &row, &card)
        .expect("filename + public slices must be enough to freeze");
    assert_eq!(frozen.offer_id, "ART-001");
    assert_eq!(
        frozen.import["items"][0]["offer_id"],
        serde_json::json!("ART-001")
    );
    assert_eq!(
        frozen.import["items"][0]["primary_image"],
        serde_json::json!(HERO)
    );
}

/// Validation judges the media the body carries: 360° slices count against the
/// 15-image limit before Ozon ever sees them.
#[test]
fn delivered_360_slices_are_validated_like_the_body_that_carries_them() {
    let mut row = golden_row();
    // The live builder's fixed field; the local fixture category omits media.
    let mut images360 = crate::records::ListingFieldDefinition::plain(
        "images360",
        "360 images",
        "Fixed",
        crate::records::ListingFieldEditor::UrlList,
        false,
    );
    images360.constraints.collection = true;
    images360.constraints.max_value_count = Some(15);
    std::sync::Arc::make_mut(&mut row.schema_snapshot)
        .fields
        .push(images360);
    row.media.images.extend((1..=16).map(|index| {
        public_ready_image(
            index,
            &format!("https://media.example.invalid/360-{index}.jpg"),
            "images360",
        )
    }));
    let built = build_listing(&row, &golden_card());
    assert_eq!(built.media.images360.len(), 16);
    assert!(matches!(
        built.draft.values.get("images360"),
        Some(WorkflowDraftValue::UrlList(urls)) if urls == &built.media.images360
    ));
    assert!(matches!(
        compose_frozen_import(GOLDEN_ROW_ID, &row, &golden_card()),
        Err(ListingError::NotValidated)
    ));
}

/// Hand-edited keys win over the card default they shadow.
#[test]
fn a_hand_edited_value_survives_the_card_overlay() {
    let mut row = golden_row();
    row.draft.values.insert(
        "price".to_owned(),
        WorkflowDraftValue::Text("125".to_owned()),
    );
    row.hand_edited_keys = BTreeSet::from(["price".to_owned()]);

    let frozen = compose_frozen_import(GOLDEN_ROW_ID, &row, &golden_card()).expect("compose");

    assert_eq!(frozen.import["items"][0]["price"], serde_json::json!("125"));
    assert_ne!(frozen.digest, PINNED_REQUEST_DIGEST);
}

/// Ozon rejects a Chinese product name and says nothing useful about why, so
/// both the validator and the last gate before dispatch refuse it.
#[test]
fn a_chinese_product_name_never_reaches_the_seller() {
    assert!(validate_product_name("装饰画").is_err());
    assert!(validate_product_name("Настенная картина").is_ok());

    let mut row = golden_row();
    row.draft.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("装饰画".to_owned()),
    );
    assert!(matches!(
        compose_frozen_import(GOLDEN_ROW_ID, &row, &golden_card()),
        Err(ListingError::NotValidated)
    ));
}

#[test]
fn lifecycle_media_prefers_operator_urls_and_reads_roles_off_the_group_name() {
    let draft = WorkflowCategoryDraft {
        values: BTreeMap::from([(
            "images".to_owned(),
            WorkflowDraftValue::UrlList(vec![
                "https://manual.example.invalid/a.jpg".to_owned(),
                "https://manual.example.invalid/b.jpg".to_owned(),
            ]),
        )]),
        complex_values: Vec::new(),
        ..Default::default()
    };
    let images = vec![
        public_ready_image(1, "https://media.example.invalid/360.jpg", "images360"),
        public_ready_image(0, HERO, ""),
    ];

    let media = lifecycle_media(&images, &[], None, &draft);

    assert_eq!(
        media.images,
        vec![
            "https://manual.example.invalid/a.jpg".to_owned(),
            "https://manual.example.invalid/b.jpg".to_owned()
        ],
        "an operator-supplied list wins over delivered slices"
    );
    assert_eq!(media.primary_image, "https://manual.example.invalid/a.jpg");
    assert_eq!(
        media.images360,
        vec!["https://media.example.invalid/360.jpg".to_owned()],
        "the 360 set still falls back to the delivered slices"
    );
}

#[test]
fn lifecycle_media_ignores_slices_that_are_not_public_yet() {
    let mut pending = public_ready_image(0, HERO, "");
    pending.phase = WorkflowImagePhase::Rendered;
    let ready = public_ready_image(1, "https://media.example.invalid/second.jpg", "");

    let media = lifecycle_media(
        &[pending, ready],
        &[video("https://media.example.invalid/clip.mp4")],
        Some(&video("https://media.example.invalid/cover.mp4")),
        &WorkflowCategoryDraft::default(),
    );

    assert_eq!(
        media.images,
        vec!["https://media.example.invalid/second.jpg".to_owned()]
    );
    assert_eq!(media.product_videos.len(), 1);
    assert_eq!(
        media.video_cover_url.as_deref(),
        Some("https://media.example.invalid/cover.mp4")
    );
}

#[cfg(test)]
fn video(url: &str) -> WorkflowVideoMetadata {
    WorkflowVideoMetadata {
        role: WorkflowVideoRole::Product,
        origin: WorkflowVideoOrigin::PublicUrl,
        file_name: "clip.mp4".to_owned(),
        content_type: "video/mp4".to_owned(),
        size_bytes: 10,
        duration_ms: 1000,
        public_url: Some(url.to_owned()),
        object_key: None,
        content_hash: None,
    }
}

/// Batch identity is a hash of the ordered digest set, not a list: joining
/// ~72 B digests overflowed the jobs btree around 38 rows.
#[test]
fn the_batch_id_is_bounded_and_changes_with_its_contents() {
    let digests = vec!["sha256:a".to_owned(), "sha256:b".to_owned()];
    let id = batch_client_operation_id("store_01", &digests);

    assert!(id.starts_with("workflow-batch:store_01:"));
    assert_eq!(id.len(), "workflow-batch:store_01:".len() + 64);
    assert_ne!(
        id,
        batch_client_operation_id("store_01", &["sha256:b".to_owned(), "sha256:a".to_owned()])
    );
    assert_ne!(id, batch_client_operation_id("store_02", &digests));
}

#[test]
fn a_batch_must_hold_between_one_and_the_seller_limit() {
    assert!(check_batch_size(0).is_err());
    assert!(check_batch_size(1).is_ok());
    assert!(check_batch_size(100).is_ok());
    assert!(check_batch_size(101).is_err());
}

#[test]
fn supplier_video_changes_are_adopted_before_freezing_without_invalidating_images() {
    let mut row = golden_row();
    row.supplier_product_id = Some("supplier-product".into());
    let mut card = golden_card();
    card.supplier_product_id = row.supplier_product_id.clone();
    let images = row.media.images.clone();
    let evidence = row.render_evidence.clone();
    let draft = row.draft.clone();
    let new_video = "https://media.example.invalid/new-supplier-video.mp4";
    card.videos = vec![video(new_video)];
    card.video_cover = Some(video("https://media.example.invalid/new-cover.mp4"));
    assert!(adopt_supplier_videos(&mut row, &card));
    assert_eq!(row.media.images, images);
    assert_eq!(row.render_evidence, evidence);
    assert_eq!(row.draft, draft);
    let frozen = compose_frozen_import(GOLDEN_ROW_ID, &row, &card).unwrap();
    let groups = frozen.import["items"][0]["complex_attributes"]
        .as_array()
        .unwrap();
    assert!(groups.iter().any(|group| {
        group["attributes"]
            .as_array()
            .unwrap()
            .iter()
            .any(|attribute| {
                attribute["id"] == 21841 && attribute["values"][0]["value"] == new_video
            })
    }));
    assert!(
        !adopt_supplier_videos(&mut row, &card),
        "no spurious revision on unchanged media"
    );
    card.videos.clear();
    card.video_cover = None;
    assert!(adopt_supplier_videos(&mut row, &card));
    assert!(row.media.videos.is_empty());
    assert!(row.media.video_cover.is_none());
    assert_eq!(row.media.images, images);
}

#[test]
fn manual_row_videos_do_not_follow_card_edits() {
    let mut row = golden_row();
    row.media.videos = vec![video("https://media.example.invalid/row-video.mp4")];
    let before = row.media.clone();
    let mut card = golden_card();
    card.videos = vec![video("https://media.example.invalid/new-card-video.mp4")];
    assert!(!adopt_supplier_videos(&mut row, &card));
    assert_eq!(row.media, before);
}

#[test]
fn cleared_and_empty_media_slots_are_not_refilled_and_primary_is_not_a_placeholder() {
    let delivered = vec![
        public_ready_image(0, HERO, ""),
        public_ready_image(1, "https://media.example.invalid/360.jpg", "images360"),
        public_ready_image(2, "https://media.example.invalid/color.jpg", "color_image"),
    ];
    let occupied = WorkflowCategoryDraft {
        values: BTreeMap::from([
            ("images".to_owned(), WorkflowDraftValue::UrlList(Vec::new())),
            (
                "images360".to_owned(),
                WorkflowDraftValue::UrlList(Vec::new()),
            ),
            (
                "color_image".to_owned(),
                WorkflowDraftValue::UrlList(Vec::new()),
            ),
        ]),
        cleared: BTreeSet::from(["primary_image".to_owned()]),
        ..WorkflowCategoryDraft::default()
    };
    let media = lifecycle_media(&delivered, &[], None, &occupied);
    assert!(media.images.is_empty());
    assert!(media.images360.is_empty());
    assert!(media.primary_image.is_empty());
    assert!(media.color_image.is_none());
    assert!(!media.primary_image.contains("placeholder.jpg"));

    let unset = lifecycle_media(&[], &[], None, &WorkflowCategoryDraft::default());
    assert!(unset.primary_image.is_empty());
    assert!(!unset.primary_image.contains("placeholder.jpg"));
}

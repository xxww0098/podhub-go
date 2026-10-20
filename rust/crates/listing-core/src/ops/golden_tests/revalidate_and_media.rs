//! `revalidate` (a complete Draft passes and earns its evidence) and
//! `record_render` (三张图 preserve manifest ordering — 多图媒体顺序) golden
//! cases.

use serde_json::{Value, json};

use crate::WorkflowLanguage;
use crate::envelope::RowSource;
use crate::ops::{Ctx, LeanRow, RenderManifest, SchemaMaterial, record_render, revalidate};
use crate::validate::DictionaryMaterials;

use super::{assert_golden, golden_card, sequential_ids};

/// `build_snapshot` (`validate.rs`) requires `offer_id`/`name`/`price` plus
/// the fixed Ozon dimension quartet (`width`/`height`/`depth`/`weight`) and
/// `currency_code` unconditionally, regardless of which category schema is
/// pinned — the same universal contract `decorative_wall_art`'s own schema
/// fixture and `compose_tests::golden_draft_values` were built to satisfy.
/// Reusing both here (rather than hand-rolling another "complete" draft
/// against this slice's own custom schema, which has none of the dimension
/// fields) is exactly AGENTS.md's "复用稳定的业务语义": this crate already
/// has one battle-tested complete Draft and there is no reason to trust a
/// second, freshly-invented one.
fn fully_valid_row() -> LeanRow {
    let snapshot = crate::categories::decorative_wall_art::local_schema_snapshot();
    let mut draft = crate::WorkflowCategoryDraft::default();
    draft.values = crate::compose::compose_tests::golden_draft_values();
    let hand_edited_keys = draft.values.keys().cloned().collect();
    LeanRow {
        category_key: snapshot.category_key.clone(),
        description_category_id: snapshot.description_category_id,
        type_id: snapshot.type_id,
        supplier_product_id: None,
        language: WorkflowLanguage::Ru,
        schema_revision: snapshot.schema_revision.clone(),
        draft,
        hand_edited_keys,
        field_origins: Vec::new(),
        normalized_snapshot: None,
        validation_issues: Vec::new(),
        source: RowSource {
            asset_id: String::new(),
            sha256: "sha256:golden-revalidate".to_owned(),
            file_name: "golden.psd".to_owned(),
        },
        render_evidence: None,
        media: Default::default(),
        ai: Default::default(),
        failure_log: Vec::new(),
    }
}

#[test]
fn revalidate_passes_a_complete_draft_and_mints_its_evidence() {
    let row = fully_valid_row();
    let snapshot = crate::categories::decorative_wall_art::local_schema_snapshot();
    let schema = SchemaMaterial::new(
        std::sync::Arc::new(snapshot),
        DictionaryMaterials::default(),
    );
    let card = golden_card(crate::WorkflowCategoryDraft::default());
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_600,
        ids: &mut ids,
    };
    let input_row = row.clone();
    let edited = revalidate(&ctx, row);
    assert_eq!(edited.verdict.fact, op_workflow::ValidationFact::Passed);
    assert!(edited.verdict.evidence.is_some());
    assert_golden(
        "revalidate",
        "complete-draft-passes",
        &input_row,
        &json!({
            "row": &edited.row,
            "fact": format!("{:?}", edited.verdict.fact),
            "contentReady": edited.verdict.content_ready,
            "evidenceDigest": edited.verdict.evidence.as_ref().map(|evidence| evidence.digest.clone()),
        }),
    );
}

fn golden_image(index: u32, hash: &str, group: &str) -> crate::WorkflowImageLifecycle {
    crate::WorkflowImageLifecycle {
        account_id: None,
        index,
        file_name: format!("slice-{index}.jpg"),
        content_hash: hash.to_owned(),
        group_name: group.to_owned(),
        width: 900,
        height: 1200,
        byte_size: Some(2048),
        phase: crate::WorkflowImagePhase::Rendered,
        public_url: None,
        object_key: None,
        error_code: None,
    }
}

#[test]
fn record_render_orders_three_images_and_mints_one_manifest_digest() {
    // Exactly 64 lowercase hex digits after `sha256:` — `record_render`'s
    // `valid_digest` check refuses anything shorter or longer.
    let hash_of = |repeat: char| format!("sha256:{}", repeat.to_string().repeat(64));
    let images = vec![
        golden_image(0, &hash_of('1'), "hero"),
        golden_image(1, &hash_of('2'), "gallery"),
        golden_image(2, &hash_of('3'), "gallery"),
    ];
    let renderer_manifest = json!({
        "slices": images.iter().map(|image| json!({
            "index": image.index,
            "groupName": image.group_name,
            "fileName": image.file_name,
            "contentHash": image.content_hash,
            "width": image.width,
            "height": image.height,
        })).collect::<Vec<Value>>(),
    });
    let input = RenderManifest {
        images: images.clone(),
        renderer_manifest: renderer_manifest.clone(),
    };
    let record = record_render(input).expect("ordered manifest is accepted");
    assert_eq!(
        record
            .images
            .iter()
            .map(|image| image.index)
            .collect::<Vec<_>>(),
        vec![0, 1, 2]
    );
    assert_golden(
        "record_render",
        "three-image-manifest-ordering",
        &json!({"images": &images, "rendererManifest": &renderer_manifest}),
        &json!({
            "images": &record.images,
            "manifest": &record.manifest,
            "manifestDigest": &record.manifest_digest,
        }),
    );
}

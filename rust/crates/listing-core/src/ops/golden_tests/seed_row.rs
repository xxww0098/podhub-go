//! `seed_row` golden cases: empty/clear values, a Chinese name plus a
//! float-text price, complex field ordering and a supplier-projection Card.

use std::collections::BTreeMap;

use serde_json::json;

use crate::envelope::RowSource;
use crate::ops::{Ctx, seed_row};
use crate::workflow_dto::types::{
    WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
};

use super::{assert_golden, golden_card, golden_schema_material, sequential_ids};

#[test]
fn seed_row_empty_draft_leaves_gaps_unfilled_and_respects_an_explicit_clear() {
    let mut defaults = WorkflowCategoryDraft::default();
    defaults.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("默认名称".to_owned()),
    );
    let card = golden_card(defaults);
    let mut supplied = WorkflowCategoryDraft::default();
    supplied.cleared.insert("name".to_owned());
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_000,
        ids: &mut ids,
    };
    let source = RowSource {
        asset_id: String::new(),
        sha256: "sha256:source-empty".to_owned(),
        file_name: "empty.psd".to_owned(),
    };
    let row = seed_row(&ctx, source.clone(), Some(supplied.clone()));
    assert!(
        !row.draft.values.contains_key("name"),
        "an explicit clear on the supplied draft must survive seed_gaps, not be \
         backfilled by the Card default"
    );
    assert!(row.draft.cleared.contains("name"));
    assert_golden(
        "seed_row",
        "empty-draft-respects-explicit-clear",
        &json!({"card": &card, "source": &source, "suppliedDraft": &supplied}),
        &row,
    );
}

#[test]
fn seed_row_keeps_a_chinese_name_and_a_float_text_price_and_fills_the_card_default() {
    let mut defaults = WorkflowCategoryDraft::default();
    defaults.values.insert(
        "offer_id".to_owned(),
        WorkflowDraftValue::Text("ART-DEFAULT".to_owned()),
    );
    let card = golden_card(defaults);
    let mut supplied = WorkflowCategoryDraft::default();
    supplied.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("装饰画 中文名称".to_owned()),
    );
    supplied.values.insert(
        "price".to_owned(),
        WorkflowDraftValue::Text("199.90".to_owned()),
    );
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_000,
        ids: &mut ids,
    };
    let source = RowSource {
        asset_id: String::new(),
        sha256: "sha256:source-cn".to_owned(),
        file_name: "装饰画.psd".to_owned(),
    };
    let row = seed_row(&ctx, source.clone(), Some(supplied.clone()));
    assert_eq!(
        row.draft.values.get("name"),
        Some(&WorkflowDraftValue::Text("装饰画 中文名称".to_owned()))
    );
    assert_eq!(
        row.draft.values.get("price"),
        Some(&WorkflowDraftValue::Text("199.90".to_owned()))
    );
    assert_eq!(
        row.draft.values.get("offer_id"),
        Some(&WorkflowDraftValue::Text("ART-DEFAULT".to_owned())),
        "the Card default fills the gap the supplied Draft left"
    );
    assert!(row.hand_edited_keys.contains("name"));
    assert!(row.hand_edited_keys.contains("price"));
    assert!(!row.hand_edited_keys.contains("offer_id"));
    assert_golden(
        "seed_row",
        "chinese-name-and-price-float-text",
        &json!({"card": &card, "source": &source, "suppliedDraft": &supplied}),
        &row,
    );
}

#[test]
fn seed_row_preserves_the_supplied_complex_item_order() {
    let card = golden_card(WorkflowCategoryDraft::default());
    let mut supplied = WorkflowCategoryDraft::default();
    supplied.complex_values.push(WorkflowComplexDraftGroup {
        complex_id: 10,
        items: vec![
            WorkflowComplexDraftItem {
                item_id: "item-b".to_owned(),
                values: BTreeMap::from([(
                    "size".to_owned(),
                    WorkflowDraftValue::Text("大".to_owned()),
                )]),
            },
            WorkflowComplexDraftItem {
                item_id: "item-a".to_owned(),
                values: BTreeMap::from([(
                    "size".to_owned(),
                    WorkflowDraftValue::Text("小".to_owned()),
                )]),
            },
        ],
    });
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_000,
        ids: &mut ids,
    };
    let source = RowSource {
        asset_id: String::new(),
        sha256: "sha256:source-complex".to_owned(),
        file_name: "variant.psd".to_owned(),
    };
    let row = seed_row(&ctx, source.clone(), Some(supplied.clone()));
    let items = &row.draft.complex_values[0].items;
    assert_eq!(
        items
            .iter()
            .map(|item| item.item_id.as_str())
            .collect::<Vec<_>>(),
        vec!["item-b", "item-a"],
        "seed_row must not reorder complex items — the caller's order is the \
         only order"
    );
    assert_golden(
        "seed_row",
        "complex-field-ordering",
        &json!({"card": &card, "source": &source, "suppliedDraft": &supplied}),
        &row,
    );
}

#[test]
fn seed_row_copies_a_supplier_cards_projection_onto_a_fresh_row() {
    let mut card = golden_card(WorkflowCategoryDraft::default());
    card.supplier_product_id = Some("sp-golden-100".to_owned());
    card.videos = vec![crate::WorkflowVideoMetadata {
        role: crate::WorkflowVideoRole::Product,
        origin: crate::WorkflowVideoOrigin::PublicUrl,
        file_name: "clip.mp4".to_owned(),
        content_type: "video/mp4".to_owned(),
        size_bytes: 1024,
        duration_ms: 5_000,
        public_url: Some("https://media.example.invalid/clip.mp4".to_owned()),
        object_key: None,
        content_hash: Some("sha256:clip".to_owned()),
    }];
    card.video_cover = Some(crate::WorkflowVideoMetadata {
        role: crate::WorkflowVideoRole::Cover,
        ..card.videos[0].clone()
    });
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_000,
        ids: &mut ids,
    };
    let source = RowSource {
        asset_id: String::new(),
        sha256: "sha256:source-supplier".to_owned(),
        file_name: "supplier.psd".to_owned(),
    };
    let row = seed_row(&ctx, source.clone(), None);
    assert_eq!(row.supplier_product_id.as_deref(), Some("sp-golden-100"));
    assert_eq!(row.media.videos.len(), 1);
    assert!(row.media.video_cover.is_some());
    assert_golden(
        "seed_row",
        "supplier-projection-card",
        &json!({"card": &card, "source": &source}),
        &row,
    );
}

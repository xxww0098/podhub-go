//! Seed a new Product Instance from its Card: the Draft the caller sent
//! wins, the Card's defaults fill its gaps, and every filled field records
//! where it came from (called from `src/listing/api/cards.rs`'s
//! `seed_row_payload`).

use crate::WorkflowCategoryDraft;
use crate::content_policy::{addresses, field_key, has_content, record_origin, value_at};
use crate::envelope::{RowMedia, RowPayload, RowSource};
use crate::field_pack::seed_gaps;
use crate::records::{FieldAddress, FieldValueOriginKind};

use super::{Ctx, LeanRow};

/// Seed a fresh row under `ctx.card`. The Card's product videos are copied
/// into the row the same way the defaults are — a fresh row has no media of
/// its own, so the copy fills a blank and never overwrites one; from here
/// the row owns them.
///
/// # Panics
///
/// Panics if `ctx.card` is `None`. Unlike [`super::edit_row`] and
/// [`super::revalidate`], which reproduce Cloud's real card-less edit
/// fallbacks, creating a row always has a Card behind it (D3/S1 of the plan
/// README: "今天没有方案就没有行") — a caller reaching this without one is a
/// programming error in the caller, not a state this op needs to model.
pub fn seed_row(
    ctx: &Ctx<'_>,
    source: RowSource,
    supplied_draft: Option<WorkflowCategoryDraft>,
) -> LeanRow {
    let card = ctx
        .card
        .expect("seed_row requires ctx.card — 今天没有方案就没有行");
    let schema_view = ctx.schema.view(card.language);

    let mut draft = supplied_draft.unwrap_or_default();
    let supplied = draft.clone();
    seed_gaps(&schema_view, &mut draft, card.defaults.clone());

    let mut full = RowPayload {
        category_key: ctx.schema.snapshot().category_key.clone(),
        description_category_id: ctx.schema.snapshot().description_category_id,
        type_id: ctx.schema.snapshot().type_id,
        language: card.language,
        schema_revision: ctx.schema.snapshot().schema_revision.clone(),
        schema_snapshot: ctx.schema.snapshot().clone(),
        draft,
        hand_edited_keys: Default::default(),
        field_origins: Vec::new(),
        normalized_snapshot: None,
        validation_issues: Vec::new(),
        source,
        render_evidence: None,
        media: RowMedia {
            images: Vec::new(),
            videos: card.videos.clone(),
            video_cover: card.video_cover.clone(),
        },
        supplier_product_id: card.supplier_product_id.clone(),
        ai: Default::default(),
        failure_log: Vec::new(),
    };

    for address in addresses(&full.draft) {
        let manual = has_content(value_at(&supplied, &address));
        let kind = if manual {
            if matches!(address, FieldAddress::Plain { .. }) {
                full.hand_edited_keys.insert(field_key(&address).to_owned());
            }
            FieldValueOriginKind::Manual
        } else {
            FieldValueOriginKind::CardDefault
        };
        record_origin(&mut full, address, kind, None, ctx.now_ms);
    }

    LeanRow::from_row(full).0
}

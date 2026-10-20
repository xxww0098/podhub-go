//! Settle a purchased OCR recognition onto a row: fill blank prose, record
//! candidate edits, and revalidate (called from
//! `src/listing/api/recognition.rs`'s `settle_ai_with_card`).

use crate::ai_settlement::settlement_plan;
use crate::projections::effective_ai_policy;
use crate::{WorkflowAiCandidate, WorkflowAiResult};

use super::verdict::{Edited, revalidate};
use super::{Ctx, LeanRow};

/// One purchased recognition, already decoded from the AI answer contract
/// (`src/ai/` owns that decode — see this crate's module docs and the plan
/// README's 单一所有者 table) — including `tags`, which Cloud's own
/// `purchased_result` prepends the prompt's fixed tags onto before this op
/// ever sees it (the `submit_reconcile_tests/recognition_purchase.rs` suite
/// pins that merge order on `purchased_result`'s own return, so this op takes
/// the merged list rather than repeating the merge).
pub struct RecognitionAnswer {
    pub ru: String,
    pub description: String,
    pub tags: Vec<String>,
    pub candidates: Vec<WorkflowAiCandidate>,
    pub model: String,
    pub cost_microfen: i64,
    pub request_id: String,
    pub prompt_sha256: String,
}

/// Fill blank prose, record every candidate for review, and revalidate.
///
/// Requires `ctx.card` — recognition never runs on a row without one — and
/// says so as a refusal rather than aborting: `Ctx::card` is `Option` on
/// purpose (edit-time fallback runs card-less, see `ops`'s module docs), so a
/// caller that reaches this op without a Card has a wiring bug, and the
/// browser boundary turns `Err` into `CORE_REFUSED` with a diagnosable
/// sentence. Panicking here instead would abort the wasm instance
/// (`wasm32-unknown-unknown` has no unwinding) and take every resident schema
/// handle down with it.
pub fn settle_recognition(
    ctx: &Ctx<'_>,
    row: LeanRow,
    answer: RecognitionAnswer,
) -> Result<Edited, &'static str> {
    let card = ctx
        .card
        .ok_or("settle_recognition requires a card: recognition never runs on a card-less row")?;
    let schema_view = ctx.schema.view(row.language);
    // Browser-created Cards historically persisted an empty allow-list; the
    // old Host treated that as "all schema-safe fields" — preserved here
    // exactly as `settle_ai_with_card` preserved it, not by this op's own
    // policy.
    let ai_field_policy = if card.supplier_product_id.is_some() {
        card.ai_field_policy.clone()
    } else {
        effective_ai_policy(&schema_view, &card.ai_field_policy)
    };

    let result = WorkflowAiResult {
        ru: answer.ru,
        tags: answer.tags,
        description: answer.description,
        model: answer.model,
        cost_microfen: answer.cost_microfen,
        candidates: answer.candidates,
    };

    let full = row.into_row(ctx.schema.snapshot().clone());
    let next = settlement_plan(
        &schema_view,
        &full,
        &ai_field_policy,
        &result,
        &answer.request_id,
        &answer.prompt_sha256,
        ctx.now_ms,
    );
    let (lean, _snapshot) = LeanRow::from_row(next);
    Ok(revalidate(ctx, lean))
}

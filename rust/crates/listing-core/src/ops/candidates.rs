//! Apply explicit AI candidate decisions and revalidate (called from
//! `src/listing/api/candidates.rs`'s `write_decisions`).

use crate::content_policy::decide_candidate;
use crate::projections::effective_ai_policy;

use super::verdict::{Edited, revalidate};
use super::{Ctx, LeanRow};

/// One candidate index accepted or rejected, exactly as the client sent it.
pub struct CandidateDecision {
    pub index: usize,
    pub accept: bool,
}

/// Apply every decision in order, then revalidate.
///
/// Two fallible parts, both refusals rather than aborts: the missing
/// `ctx.card` (candidate decisions only exist on a row that has one, but
/// `Ctx::card` is `Option` on purpose — see `ops`'s module docs — so a
/// caller that reaches this op card-less has a wiring bug worth reporting),
/// and each decision itself (`decide_candidate`'s own preconditions: the
/// index exists, the candidate is still pending, the address is writable).
pub fn decide_candidates(
    ctx: &Ctx<'_>,
    row: LeanRow,
    decisions: &[CandidateDecision],
) -> Result<Edited, &'static str> {
    let card = ctx
        .card
        .ok_or("decide_candidates requires a card: a row with candidates always has one")?;
    let schema_view = ctx.schema.view(row.language);
    let policy = effective_ai_policy(&schema_view, &card.ai_field_policy);
    let mut full = row.into_row(ctx.schema.snapshot().clone());
    for decision in decisions {
        decide_candidate(
            &mut full,
            &schema_view,
            &policy,
            decision.index,
            decision.accept,
            ctx.now_ms,
        )?;
    }
    let (lean, _snapshot) = LeanRow::from_row(full);
    Ok(revalidate(ctx, lean))
}

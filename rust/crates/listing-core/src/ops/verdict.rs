//! Recompute one row's verdict: normalize, validate, and (with a Card) build
//! its send fields and the evidence digest that proves what built them.

use op_workflow::ValidationFact;

use crate::WorkflowAiCandidateState;
use crate::build::BuildEvidence;
use crate::service::validate_row_with;
use crate::validate::FieldIssue;

use super::{Ctx, LeanRow};

/// A verdict earned by [`revalidate`]: the field issues a `Blocked` draft
/// carries, the send-field evidence a Card-backed build produced (`None`
/// when there was no Card to build against), and whether every AI candidate
/// has left the reviewer's queue.
#[derive(Debug, Clone)]
pub struct Verdict {
    pub fact: ValidationFact,
    pub issues: Vec<FieldIssue>,
    pub evidence: Option<BuildEvidence>,
    pub content_ready: bool,
}

/// A row plus the verdict recomputing it just earned.
#[derive(Debug, Clone)]
pub struct Edited {
    pub row: LeanRow,
    pub verdict: Verdict,
}

/// Recompute one row's Draft against `ctx.schema` and `ctx.card`.
///
/// This is the one place [`validate_row_with`] is called outside tests —
/// every write op that ends in a verdict ([`super::edit_row`],
/// [`super::decide_candidates`], [`super::settle_recognition`]) and every
/// read-time verdict mint Cloud runs today (`PATCH .../rows/rebuild`,
/// `POST .../rows/{id}/prepare`, the terminal media-receipt revalidation in
/// `apply_confirm_row_images`) call through here instead of
/// `validate_row_with` directly.
pub fn revalidate(ctx: &Ctx<'_>, row: LeanRow) -> Edited {
    let full = row.into_row(ctx.schema.snapshot().clone());
    let (validated, fact, evidence) = validate_row_with(&full, ctx.card, ctx.schema.materials());
    let content_ready = fact == ValidationFact::Passed
        && validated.ai.candidates.iter().all(|candidate| {
            matches!(
                candidate.state,
                WorkflowAiCandidateState::Confirmed | WorkflowAiCandidateState::Rejected
            )
        });
    let issues = validated.validation_issues.clone();
    let (lean, _snapshot) = LeanRow::from_row(validated);
    Edited {
        row: lean,
        verdict: Verdict {
            fact,
            issues,
            evidence,
            content_ready,
        },
    }
}

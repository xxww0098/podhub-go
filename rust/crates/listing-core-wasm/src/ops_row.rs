//! The five ops whose `Ctx` needs a schema handle and (optionally) a Card:
//! `seedRow`, `editRow`, `settleRecognition`, `decideCandidates`, `revalidate`
//! (also reached as `recordUpload`, op 6 — see `dispatch.rs`'s module docs).
//!
//! Every input struct here mirrors a slice 02 golden fixture's `.input.json`
//! shape as closely as the ABI allows, plus the two fields no fixture
//! carries because they were fixed test constants, not case data:
//! `card` (`Ctx::card`) and `nowMs` (`Ctx::now_ms`). `web/tests/listing-core-wasm.test.ts`
//! documents exactly how each of the 12 golden cases maps onto these shapes.

use listing_core::envelope::{CardPayload, RowSource};
use listing_core::ops::{
    self, CandidateDecision, DraftEdit, FreezeOutcome, LeanRow, RecognitionAnswer, RowEdit,
    SchemaMaterial,
};
use listing_core::{WorkflowAiCandidate, WorkflowCategoryDraft};
use serde::Deserialize;
use serde_json::Value as JsonValue;

use crate::error::CoreError;
use crate::ids::new_id_source;

/// Every `Edited`-shaped op (`settleRecognition`, `decideCandidates`,
/// `revalidate`, `recordUpload`) answers with this same JSON: `listing_core`
/// itself does not derive `Serialize` on `Edited`/`Verdict` (its own golden
/// tests hand-pick fields into ad hoc `json!` objects instead — see
/// `rust/crates/listing-core/src/ops/golden_tests/*.rs`), so this is that same
/// projection made once, reused by every op in this file that returns an
/// `Edited`. Lives here, not `dispatch.rs`: this file is `edited_json`'s only
/// caller, and `dispatch.rs` already depends on this module (to reach
/// `seed_row` etc.) — the reverse dependency would be a module cycle
/// the architecture gate (`cargo xtask ci --tier 1`) refuses.
fn edited_json(edited: &ops::Edited) -> JsonValue {
    serde_json::json!({
        "row": &edited.row,
        "fact": format!("{:?}", edited.verdict.fact),
        "issues": &edited.verdict.issues,
        "evidence": edited.verdict.evidence.as_ref(),
        "contentReady": edited.verdict.content_ready,
    })
}

pub(crate) fn seed_row(schema: &SchemaMaterial, bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        card: CardPayload,
        source: RowSource,
        #[serde(default)]
        supplied_draft: Option<WorkflowCategoryDraft>,
        now_ms: u64,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let mut ids = new_id_source();
    let ctx = ops::Ctx {
        schema,
        card: Some(&input.card),
        now_ms: input.now_ms,
        ids: &mut ids,
    };
    let row = ops::seed_row(&ctx, input.source, input.supplied_draft);
    serde_json::to_vec(&row).map_err(CoreError::decode)
}

/// `RowEdit` has no `Deserialize` of its own (it is a plain Rust enum built
/// from a typed `DraftEdit` in `listing_core`); this is the wire shape the
/// browser's `client.ts` sends instead, translated 1:1 into the real enum
/// below.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
enum EditInput {
    ClearGeneratedContent,
    // The enum-level `rename_all` only cases the `kind` tag's variant names
    // ("draft"), not a struct variant's own fields — those need their own
    // `rename_all` or they decode by their literal Rust name (`store_moved`,
    // not `storeMoved`). Without this, `storeMoved` from the wire silently
    // defaults to `false` instead of erroring, which is exactly the kind of
    // bug this crate's own `web/tests/listing-core-wasm.test.ts` caught: a
    // JSON key mismatch here is `#[serde(default)]`-swallowed, not rejected.
    #[serde(rename_all = "camelCase")]
    Draft {
        #[serde(default)]
        changes: JsonValue,
        draft: WorkflowCategoryDraft,
        #[serde(default)]
        light: bool,
        #[serde(default)]
        store_moved: bool,
    },
}

pub(crate) fn edit_row(schema: &SchemaMaterial, bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        #[serde(default)]
        card: Option<CardPayload>,
        now_ms: u64,
        row: LeanRow,
        edit: EditInput,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let row_edit = match input.edit {
        EditInput::ClearGeneratedContent => RowEdit::ClearGeneratedContent,
        EditInput::Draft {
            changes,
            draft,
            light,
            store_moved,
        } => RowEdit::Draft(DraftEdit {
            changes,
            draft,
            light,
            store_moved,
        }),
    };
    let mut ids = new_id_source();
    let mut ctx = ops::Ctx {
        schema,
        card: input.card.as_ref(),
        now_ms: input.now_ms,
        ids: &mut ids,
    };
    let outcome = ops::edit_row(&mut ctx, input.row, row_edit).map_err(CoreError::refused)?;
    let value = serde_json::json!({
        "row": &outcome.edited.row,
        "fact": format!("{:?}", outcome.edited.verdict.fact),
        "issues": &outcome.edited.verdict.issues,
        "invalidation": {
            "contentState": outcome.invalidation.content_state,
            "mediaState": outcome.invalidation.media_state,
            "submissionState": outcome.invalidation.submission_state,
        },
        "stored": &outcome.stored,
    });
    serde_json::to_vec(&value).map_err(CoreError::decode)
}

pub(crate) fn settle_recognition(
    schema: &SchemaMaterial,
    bytes: &[u8],
) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        #[serde(default)]
        card: Option<CardPayload>,
        now_ms: u64,
        row: LeanRow,
        ru: String,
        description: String,
        tags: Vec<String>,
        #[serde(default)]
        candidates: Vec<WorkflowAiCandidate>,
        model: String,
        cost_microfen: i64,
        request_id: String,
        prompt_sha256: String,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let mut ids = new_id_source();
    let ctx = ops::Ctx {
        schema,
        card: input.card.as_ref(),
        now_ms: input.now_ms,
        ids: &mut ids,
    };
    let answer = RecognitionAnswer {
        ru: input.ru,
        description: input.description,
        tags: input.tags,
        candidates: input.candidates,
        model: input.model,
        cost_microfen: input.cost_microfen,
        request_id: input.request_id,
        prompt_sha256: input.prompt_sha256,
    };
    let edited = ops::settle_recognition(&ctx, input.row, answer).map_err(CoreError::refused)?;
    serde_json::to_vec(&edited_json(&edited)).map_err(CoreError::decode)
}

pub(crate) fn decide_candidates(
    schema: &SchemaMaterial,
    bytes: &[u8],
) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    struct DecisionInput {
        index: usize,
        accept: bool,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        #[serde(default)]
        card: Option<CardPayload>,
        now_ms: u64,
        row: LeanRow,
        decisions: Vec<DecisionInput>,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let decisions: Vec<CandidateDecision> = input
        .decisions
        .into_iter()
        .map(|decision| CandidateDecision {
            index: decision.index,
            accept: decision.accept,
        })
        .collect();
    let mut ids = new_id_source();
    let ctx = ops::Ctx {
        schema,
        card: input.card.as_ref(),
        now_ms: input.now_ms,
        ids: &mut ids,
    };
    let edited = ops::decide_candidates(&ctx, input.row, &decisions).map_err(CoreError::refused)?;
    serde_json::to_vec(&edited_json(&edited)).map_err(CoreError::decode)
}

/// Shared by op 7 (`revalidate`) and op 6 (`recordUpload`) — see
/// `dispatch.rs`'s module docs for why they are the same function.
pub(crate) fn revalidate(schema: &SchemaMaterial, bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        #[serde(default)]
        card: Option<CardPayload>,
        now_ms: u64,
        row: LeanRow,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let mut ids = new_id_source();
    let ctx = ops::Ctx {
        schema,
        card: input.card.as_ref(),
        now_ms: input.now_ms,
        ids: &mut ids,
    };
    let edited = ops::revalidate(&ctx, input.row);
    serde_json::to_vec(&edited_json(&edited)).map_err(CoreError::decode)
}

/// Op 11, `freezeListing`. Both outcomes are a successful `call()`: a refusal
/// is a business answer carrying `FieldIssue`s the operator acts on, which
/// `CORE_REFUSED`'s bare `{code, message}` could not hold. A refusal also
/// names the stage that produced its issues (`issueStage`, from
/// `FreezeRefusal::issue_stage`), so callers classify `(platform, stage,
/// code)` without re-deriving a stage from `reason`. `reason` is the typed
/// `FreezeRefusal` itself, so its string is the native closed set (the same
/// literals `as_str` names), never a separately spelled copy. No `Ctx`:
/// freezing reads no clock and mints no ids.
pub(crate) fn freeze_listing(schema: &SchemaMaterial, bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        card: CardPayload,
        row: LeanRow,
        row_id: String,
    }
    // A blank/untrimmed `rowId` decodes fine and comes back as the native
    // `row_id_invalid` refusal, so the rule lives in one place.
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let value = match ops::freeze_listing(schema, &input.card, input.row, &input.row_id) {
        FreezeOutcome::Frozen { frozen, evidence } => serde_json::json!({
            "status": "frozen",
            "import": frozen.import,
            "digest": frozen.digest,
            "offerId": frozen.offer_id,
            "clientOperationId": frozen.client_operation_id,
            "evidence": evidence,
        }),
        FreezeOutcome::Refused {
            reason,
            issues,
            evidence,
        } => serde_json::json!({
            "status": "refused",
            "reason": reason,
            "issueStage": reason.issue_stage().as_str(),
            "issues": issues,
            "evidence": evidence,
        }),
    };
    serde_json::to_vec(&value).map_err(CoreError::decode)
}

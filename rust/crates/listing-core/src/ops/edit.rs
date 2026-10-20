//! Edit an existing row: a Draft write (field edits, a new source image, a
//! store move riding the same edit) or clearing its generated content.
//! Called from `src/listing/api/rows/draft.rs`'s `write_draft_lean` and
//! `clear_generated_content`; the invalidation graph's pure half
//! ([`super::invalidation`]) is folded in here.
//!
//! A full Draft write is also this crate's one system media decider for a
//! row: system media the row's stored Draft already holds — a row saved
//! before the write guard — may ride along unchanged or be dropped, and is
//! cleaned out of the Draft, its origins and its hand-edited keys before the
//! write is recorded; anything new or changed is refused by field and group.

use op_workflow::ValidationFact;
use serde_json::Value as JsonValue;

use crate::content_policy::{
    ensure_complex_item_ids, field_key, invalidate_source, record_manual_changes,
};
use crate::field_pack::strip_empty_placeholders;
use crate::projections::{SystemMediaFields, system_media_row_refusal};
use crate::records::{ExecutionPlan, FieldValueOriginKind};
use crate::service::execution_plan;
use crate::{WorkflowCategoryDraft, source_identity_keys, without_non_identity_values};

use super::invalidation::{
    InvalidationPatch, InvalidationTrigger, source_changed, triggers_for_changes,
};
use super::verdict::{Edited, Verdict, revalidate};
use super::{Ctx, LeanRow};

/// The Draft half of a PATCH: `changes` is the raw top-level JSON patch for
/// keys the typed Draft itself does not model (today, only `source`);
/// `draft` fully replaces the row's Draft, exactly like the HTTP handler's
/// `body.draft` field already does.
pub struct DraftEdit {
    pub changes: JsonValue,
    pub draft: WorkflowCategoryDraft,
    /// db-write-amp 06 / D-04: a light save writes facts only — no schema
    /// refresh, no validator, no execution plan.
    pub light: bool,
    /// The row's Target Store rides this same edit's invalidation triggers;
    /// the store binding itself is a DB column outside this op's concern.
    pub store_moved: bool,
}

pub enum RowEdit {
    Draft(DraftEdit),
    ClearGeneratedContent,
}

/// Everything a caller persists after one edit: the edited row and its
/// verdict, the column overlay to fold into the same CAS write, the ready-
/// to-store JSON (already carrying forward any top-level key `changes`
/// introduced that this crate's Draft model does not know — the same
/// forward-compatibility the JSON-merge write path has today), and the
/// Execution Plan a `Passed`, non-light write earns.
pub struct EditOutcome {
    pub edited: Edited,
    pub invalidation: InvalidationPatch,
    pub plan: Option<ExecutionPlan>,
    pub stored: JsonValue,
}

pub fn edit_row(ctx: &mut Ctx<'_>, row: LeanRow, edit: RowEdit) -> Result<EditOutcome, String> {
    match edit {
        RowEdit::ClearGeneratedContent => Ok(clear_generated_content(ctx, row)),
        RowEdit::Draft(draft_edit) => edit_draft(ctx, row, draft_edit),
    }
}

fn edit_draft(ctx: &mut Ctx<'_>, row: LeanRow, edit: DraftEdit) -> Result<EditOutcome, String> {
    let DraftEdit {
        changes,
        mut draft,
        light,
        store_moved,
    } = edit;

    let mut previous_draft = row.draft.clone();
    let previous_value = row
        .to_value()
        .map_err(|_| "商品行载荷不是可校验的上架文档".to_owned())?;
    let mut merged_value = previous_value.clone();
    if let (Some(target), Some(patch)) = (merged_value.as_object_mut(), changes.as_object()) {
        for (key, value) in patch {
            target.insert(key.clone(), value.clone());
        }
    }
    let source_moved = source_changed(&previous_value, &merged_value);
    let next = LeanRow::from_value(&merged_value)
        .map_err(|_| "商品行载荷不是可校验的上架文档".to_owned())?;

    // A full save is judged against the row's own stored Draft; a light save
    // keeps its facts-only contract and is not judged here.
    let system_media = if light {
        None
    } else {
        let system_media = SystemMediaFields::of_fields(&ctx.schema.snapshot().fields);
        system_media
            .admit(Some(&previous_draft), &mut draft)
            .map_err(|entries| system_media_row_refusal(&entries))?;
        // The stored side loses it too, so the legacy system media this save
        // drops is not recorded below as a Manual change or clear.
        system_media.strip(&mut previous_draft);
        Some(system_media)
    };

    let mut full = next.into_row(ctx.schema.snapshot().clone());
    full.draft = draft;
    strip_empty_placeholders(&mut full.draft);
    if let Some(system_media) = &system_media {
        let (keys, origins) = (&mut full.hand_edited_keys, &mut full.field_origins);
        keys.retain(|key| !system_media.names(key));
        origins.retain(|origin| !system_media.owns(&origin.address));
    }
    ensure_complex_item_ids(&mut full.draft, ctx.ids);
    record_manual_changes(&mut full, &previous_draft, ctx.now_ms);
    if source_moved {
        let schema_view = ctx.schema.view(full.language);
        let had_source = previous_value
            .pointer("/source/sha256")
            .and_then(JsonValue::as_str)
            .is_some_and(|sha| !sha.is_empty());
        invalidate_source(&mut full, had_source, &schema_view);
    }

    let mut triggers = triggers_for_changes(&changes, false);
    if !source_moved {
        triggers.retain(|trigger| *trigger != InvalidationTrigger::Source);
    }
    if store_moved && !triggers.contains(&InvalidationTrigger::Store) {
        triggers.push(InvalidationTrigger::Store);
    }
    if !triggers.contains(&InvalidationTrigger::ManualField) {
        triggers.push(InvalidationTrigger::ManualField);
    }
    let mut invalidation = InvalidationPatch::from_triggers(&triggers);

    if light {
        let stored = full.to_value().map_err(|_| "上架文档无法写回".to_owned())?;
        let (lean, _snapshot) = LeanRow::from_row(full);
        return Ok(EditOutcome {
            edited: Edited {
                row: lean,
                verdict: Verdict {
                    fact: ValidationFact::Stale,
                    issues: Vec::new(),
                    evidence: None,
                    content_ready: false,
                },
            },
            invalidation,
            plan: None,
            stored,
        });
    }

    let (lean, _snapshot) = LeanRow::from_row(full);
    let edited = revalidate(ctx, lean);
    if edited.verdict.content_ready && invalidation.content_state.is_none() {
        invalidation.content_state = Some("ready");
    }
    let plan = match edited.verdict.fact {
        ValidationFact::Passed => {
            execution_plan(&edited.row.clone().into_row(ctx.schema.snapshot().clone())).ok()
        }
        _ => None,
    };
    // The stored document keeps `merged`'s raw JSON as its base (any
    // top-level key `changes` introduced that this crate's typed Draft does
    // not model survives), then overlays every key the validated row wrote —
    // a two-step merge, so the stored payload stays byte for byte what the
    // `edit_row` golden fixtures pin.
    let mut stored = merged_value;
    let typed = edited
        .row
        .clone()
        .into_row(ctx.schema.snapshot().clone())
        .to_value()
        .map_err(|_| "上架文档无法写回".to_owned())?;
    if let (Some(target), Some(overlay)) = (stored.as_object_mut(), typed.as_object()) {
        target.extend(overlay.clone());
    }

    Ok(EditOutcome {
        edited,
        invalidation,
        plan,
        stored,
    })
}

fn clear_generated_content(ctx: &Ctx<'_>, row: LeanRow) -> EditOutcome {
    let schema_view = ctx.schema.view(row.language);
    let identity = source_identity_keys(&schema_view);
    let mut full = row.into_row(ctx.schema.snapshot().clone());

    let draft = std::mem::take(&mut full.draft);
    full.draft = without_non_identity_values(&schema_view, draft);
    full.hand_edited_keys.retain(|key| identity.contains(key));
    full.field_origins.retain(|origin| {
        identity.contains(field_key(&origin.address))
            && !matches!(
                origin.kind,
                FieldValueOriginKind::AiConfirmed | FieldValueOriginKind::SystemMedia
            )
    });
    full.ai = Default::default();
    full.media.images.clear();
    full.render_evidence = None;
    full.normalized_snapshot = None;
    full.validation_issues.clear();
    full.failure_log.clear();

    let stored = full
        .to_value()
        .expect("a row built from a decoded row must re-encode");
    let (lean, _snapshot) = LeanRow::from_row(full);
    EditOutcome {
        edited: Edited {
            row: lean,
            verdict: Verdict {
                fact: ValidationFact::Stale,
                issues: Vec::new(),
                evidence: None,
                content_ready: false,
            },
        },
        invalidation: InvalidationPatch {
            content_state: Some("draft"),
            media_state: Some("pending"),
            submission_state: None,
        },
        plan: None,
        stored,
    }
}

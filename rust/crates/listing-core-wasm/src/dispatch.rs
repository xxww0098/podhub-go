//! `call(op, h, ptr, len)`'s op table (slice 03 "契约与缝").
//!
//! Op numbers 1–8 and 10 forward to a real `listing_core::ops` function — see
//! `ops_row.rs` for the five that need a schema/card `Ctx`
//! (`seedRow`/`editRow`/`settleRecognition`/`decideCandidates`/`revalidate`)
//! and this file for the three that do not (`recordRender`/`valuesEqual`) plus
//! `recordUpload` and `schemaRevision`. Op 11, `freezeListing`, is
//! `ops_row::freeze_listing` (`listing_core::ops::freeze_listing`).
//!
//! **Op 6, `recordUpload`, has no function of its own.** Slice 02's "完成"
//! §偏离 7 already decided this at the native layer: `apply_confirm_row_images`
//! only needs "revalidate the row once every image is confirmed", and
//! `revalidate` already is that primitive — inventing a second one would just
//! be `revalidate` under a different name. The WASM boundary repeats the same
//! composition rather than the same decision a second time: op 6 and op 7
//! share `ops_row::revalidate` byte for byte.
//!
//! **Op 9, `submitDraft`** forwards to `listing_core::ops::SubmitDraft`
//! (landed by slice 07). It takes no schema handle — `SubmitDraft::into_row`
//! deliberately only needs the Card (see that method's own doc: the returned
//! `LeanRow` never embeds a schema, and the staleness check its
//! `schemaRevision` feeds is the caller's own comparison against
//! `SchemaMaterial::revision()`), so it is dispatched like `recordRender`/
//! `valuesEqual` — ignoring `schema` entirely rather than requiring a handle
//! it has no use for.
//!
//! **Op 12, `projectSubmitDraft`** is the opposite direction of op 9:
//! `SubmitDraft::from_row`, projecting a local `LeanRow` into the exact item a
//! `POST /api/listing/submit` request carries, so the browser never assembles
//! a Draft by hand. Like op 9 it needs no schema handle. Op 9 stays Draft →
//! LeanRow and op 11 stays the freeze preview; neither changes meaning.
//!
//! **Op 13, `issueManifest`** answers `listing_core::issue_keys`' runtime
//! manifest — every known `(platform, stage, code)` in declaration order —
//! so the browser can check its presentation table against the same
//! declaration the Rust producers compile against. No schema handle.
//!
//! **Op 16, `planStage`** is `listing_core::stage_gate`. It plans a storage
//! confirm and an OCR display step from bytes the browser already holds. It
//! does not admit a lease, read object storage, or write to a Seller. No
//! schema handle.
//!
//! **Op 17, `parseOcrAnswer`** is `listing_core::ocr_contract::parse_completion`.
//! It checks one already-settled completion. It does not call a provider,
//! touch a quota, or write a row. No schema handle.
//!
//! **Op 18, `validateVariantGroup`** is `listing_core::variants::validate_group`:
//! the exact function Cloud refuses a grouping with. It takes the *current
//! category material* in its body rather than a resident handle, because the
//! rule is about what the category says today, not about the Card's pinned
//! snapshot — see `variants.rs`. No schema handle.

use listing_core::envelope::CardPayload;
use listing_core::ops::{self, LeanRow, RenderManifest, SchemaMaterial, SubmitDraft};
use listing_core::records::ListingFieldEditor;
use listing_core::{WorkflowDraftValue, WorkflowImageLifecycle};
use serde::Deserialize;
use serde_json::Value as JsonValue;

use crate::error::CoreError;
use crate::materials::Material;
use crate::ocr_answer::{self, OP_PARSE_OCR_ANSWER};
use crate::ops_row;
use crate::stage_gate::{self, OP_PLAN_STAGE};
use crate::variants::{self, OP_VALIDATE_VARIANT_GROUP};
use crate::wb::{self, OP_WB_BUILD_PREVIEW, OP_WB_METADATA_ISSUES};

pub(crate) const OP_SEED_ROW: u32 = 1;
pub(crate) const OP_EDIT_ROW: u32 = 2;
pub(crate) const OP_SETTLE_RECOGNITION: u32 = 3;
pub(crate) const OP_DECIDE_CANDIDATES: u32 = 4;
pub(crate) const OP_RECORD_RENDER: u32 = 5;
pub(crate) const OP_RECORD_UPLOAD: u32 = 6;
pub(crate) const OP_REVALIDATE: u32 = 7;
pub(crate) const OP_VALUES_EQUAL: u32 = 8;
pub(crate) const OP_SUBMIT_DRAFT: u32 = 9;
pub(crate) const OP_SCHEMA_REVISION: u32 = 10;
/// Op 11 — `ops_row::freeze_listing`.
pub(crate) const OP_FREEZE_LISTING: u32 = 11;
/// Op 12 — [`project_submit_draft`] (`SubmitDraft::from_row`).
pub(crate) const OP_PROJECT_SUBMIT_DRAFT: u32 = 12;
/// Op 13 — [`issue_manifest`].
pub(crate) const OP_ISSUE_MANIFEST: u32 = 13;

pub(crate) fn require_schema(schema: Option<&Material>) -> Result<&SchemaMaterial, CoreError> {
    match schema {
        Some(Material::Ozon(schema)) => Ok(schema),
        Some(Material::Wb(_)) => Err(CoreError::schema_handle(
            "Ozon operation requires an Ozon material handle",
        )),
        None => Err(CoreError::schema_handle("unknown or dropped schema handle")),
    }
}

/// Dispatches one `call()` to the op it names. `schema` is `None` when `h`
/// names no resident handle (already `schema_drop`ped, or never loaded) —
/// only an error for the ops that need one; `recordRender` and `valuesEqual`
/// take no `Ctx` at all and ignore it.
pub(crate) fn dispatch(
    op: u32,
    schema: Option<&Material>,
    bytes: &[u8],
) -> Result<Vec<u8>, CoreError> {
    match op {
        OP_SEED_ROW => ops_row::seed_row(require_schema(schema)?, bytes),
        OP_EDIT_ROW => ops_row::edit_row(require_schema(schema)?, bytes),
        OP_SETTLE_RECOGNITION => ops_row::settle_recognition(require_schema(schema)?, bytes),
        OP_DECIDE_CANDIDATES => ops_row::decide_candidates(require_schema(schema)?, bytes),
        OP_RECORD_RENDER => record_render(bytes),
        OP_RECORD_UPLOAD | OP_REVALIDATE => ops_row::revalidate(require_schema(schema)?, bytes),
        OP_VALUES_EQUAL => values_equal(bytes),
        OP_SUBMIT_DRAFT => submit_draft(bytes),
        OP_SCHEMA_REVISION => schema_revision(require_schema(schema)?),
        OP_FREEZE_LISTING => ops_row::freeze_listing(require_schema(schema)?, bytes),
        OP_PROJECT_SUBMIT_DRAFT => project_submit_draft(bytes),
        OP_ISSUE_MANIFEST => issue_manifest(),
        OP_WB_BUILD_PREVIEW => wb::ops::build_preview(schema, bytes),
        OP_WB_METADATA_ISSUES => wb::ops::metadata_issues(schema),
        OP_PLAN_STAGE => stage_gate::plan_from_bytes(bytes),
        OP_PARSE_OCR_ANSWER => ocr_answer::parse_answer(bytes),
        OP_VALIDATE_VARIANT_GROUP => variants::validate_variant_group(bytes),
        other => Err(CoreError::decode(format!("unknown op {other}"))),
    }
}

fn record_render(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        images: Vec<WorkflowImageLifecycle>,
        renderer_manifest: JsonValue,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let record = ops::record_render(RenderManifest {
        images: input.images,
        renderer_manifest: input.renderer_manifest,
    })
    .map_err(CoreError::refused)?;
    let value = serde_json::json!({
        "images": &record.images,
        "manifest": &record.manifest,
        "manifestDigest": &record.manifest_digest,
    });
    serde_json::to_vec(&value).map_err(CoreError::decode)
}

fn values_equal(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        editor: ListingFieldEditor,
        #[serde(default)]
        left: Option<WorkflowDraftValue>,
        #[serde(default)]
        right: Option<WorkflowDraftValue>,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let equal = ops::values_equal(input.editor, input.left.as_ref(), input.right.as_ref());
    serde_json::to_vec(&equal).map_err(CoreError::decode)
}

fn schema_revision(schema: &SchemaMaterial) -> Result<Vec<u8>, CoreError> {
    serde_json::to_vec(schema.revision()).map_err(CoreError::decode)
}

/// Reconstructs the `LeanRow` a submit request's Draft rebuilds into — same
/// shape a real `POST /api/listing/submit` would freeze via `build →
/// validate → freeze`, minus that pipeline itself: this op only replays the
/// projection step, matching what `client.ts`'s browser-side "is my Draft
/// still valid" preview needs, never the authoritative decision (README I7:
/// the server always rebuilds and validates again).
fn submit_draft(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        draft: SubmitDraft,
        card: CardPayload,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let row = input.draft.into_row(&input.card);
    serde_json::to_vec(&row).map_err(CoreError::decode)
}

/// Projects one local row into the `SubmitDraft` item a submit request sends
/// — the same `SubmitDraft::from_row` a native caller runs, byte for byte.
/// `rowId` is taken as given (the browser-minted row identity); the server
/// re-validates it, rebuilds the body and mints the `clientOperationId`
/// itself, so nothing here is authoritative.
fn project_submit_draft(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Input {
        row_id: String,
        row: LeanRow,
    }
    let input: Input = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let draft = SubmitDraft::from_row(input.row_id, &input.row);
    serde_json::to_vec(&draft).map_err(CoreError::decode)
}

/// `[{platform, stage, code}, …]` in declaration order.
fn issue_manifest() -> Result<Vec<u8>, CoreError> {
    serde_json::to_vec(listing_core::issue_keys::known_issue_manifest()).map_err(CoreError::decode)
}

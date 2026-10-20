//! Use-case-level pure functions: the single entry point for every Listing
//! row write (browser-owned-listing slice 02,
//! `specs/browser-owned-listing/slices/02-core-ops.md`).
//!
//! Cloud's DB handlers (`api/cards.rs`'s `seed_row_payload`,
//! `api/rows.rs`'s `write_draft_lean`, `api/candidates.rs`,
//! `api/recognition.rs`'s settlement, `api/media.rs`'s manifest/receipt
//! writeback) and the browser (through `rust/crates/listing-core-wasm`, no SQL
//! engine) must run the exact same rules, so every one of those computations
//! is a function here: it takes
//! already-fetched data in, returns the row (and whatever else the caller
//! must persist) out, and touches nothing else. DB reads and writes,
//! transactions, job leasing and locking all stay in Cloud's handlers, which
//! call through here instead of computing inline.
//!
//! Two rules every function in this module (and everything it calls
//! elsewhere in this crate) keeps, because the WASM boundary depends on both:
//!
//! 1. **No clock, no RNG.** `Ctx::now_ms` and `Ctx::ids` carry in what a
//!    handler already owns; nothing here calls `chrono::Utc::now()` or
//!    `Uuid::new_v4()`. A native and a WASM caller passing the same inputs
//!    get the same output, byte for byte — that identity is what the
//!    native↔WASM golden comparison checks.
//! 2. **No embedded schema.** `RowPayload::schema_snapshot` is the full
//!    Category Schema repeated on every row; an op takes it once, as
//!    [`SchemaMaterial`] on [`Ctx`], never per row (see [`LeanRow`]'s module
//!    docs for why that matters once rows cross the WASM boundary).

mod association;
mod candidates;
mod edit;
mod equality;
mod freeze;
/// Exposed under `test-support` (same precedent as `compose::compose_tests`
/// and this crate's own `ListingError` re-export in `lib.rs`): the
/// `listing-core-wasm` crate replays these exact golden cases through the
/// WASM ABI to prove native↔WASM byte-exact parity, and needs the same
/// ambient schema/card they were pinned against (`golden_schema_material`,
/// `golden_card`) — reconstructing that fixture data a second time in
/// TypeScript would be a drift-prone copy, the same reasoning that put
/// `compose_tests` behind this feature. Nothing here is production surface;
/// the feature is off by default and only `listing-core-wasm` and Cloud enable
/// it (as a dev-dependency).
#[cfg(any(test, feature = "test-support"))]
pub mod golden_tests;
mod invalidation;
mod lean_row;
mod media;
mod recognition;
mod seed;
mod submit;
mod verdict;

pub use association::{
    ASSOCIATED_MODEL_PREFIX, ASSOCIATED_OFFER_ID_PREFIX, ASSOCIATION_CLOSURE_MAX,
    AssociationIdentity, AssociationRefusal, CreateRequestContent, associated_offer_id,
    association_identity, create_request_fingerprint, model_value, normalized_sha256,
    stamp_association_identity,
};
pub use candidates::{CandidateDecision, decide_candidates};
pub use edit::{DraftEdit, EditOutcome, RowEdit, edit_row};
pub use equality::values_equal;
pub use freeze::{FreezeOutcome, FreezeRefusal, freeze_listing};
pub use invalidation::{
    InvalidationPatch, InvalidationTrigger, source_changed, triggers_for_changes,
};
pub use lean_row::LeanRow;
pub use media::{RenderManifest, RenderRecord, record_render};
pub use recognition::{RecognitionAnswer, settle_recognition};
pub use seed::seed_row;
pub use submit::SubmitDraft;
pub use verdict::{Edited, Verdict, revalidate};

use std::sync::Arc;

use crate::envelope::CardPayload;
use crate::projections::category_schema_view;
use crate::records::CategorySchemaSnapshot;
use crate::validate::DictionaryMaterials;
use crate::{CategorySchemaView, WorkflowLanguage};

/// The Category Schema material a row's Draft is checked against: the pinned
/// snapshot (revision + field definitions) plus the truncated dictionary
/// search rows the schema cache resolved for it.
///
/// A handler fetches both by DB (`cached_schema_snapshot`,
/// `dictionary_search_materials`) once per call and hands them here — never
/// once per row. That is the whole point of [`LeanRow`]: seeding, editing,
/// settling recognition and revalidating 1000 rows against the same schema
/// must not carry 1000 copies of it.
#[derive(Debug, Clone)]
pub struct SchemaMaterial {
    snapshot: Arc<CategorySchemaSnapshot>,
    materials: DictionaryMaterials,
}

impl SchemaMaterial {
    pub fn new(snapshot: Arc<CategorySchemaSnapshot>, materials: DictionaryMaterials) -> Self {
        Self {
            snapshot,
            materials,
        }
    }

    pub fn snapshot(&self) -> &Arc<CategorySchemaSnapshot> {
        &self.snapshot
    }

    pub fn materials(&self) -> &DictionaryMaterials {
        &self.materials
    }

    /// The Schema Revision this material was pinned at — the identity a
    /// row's `schemaRevision` column is checked against.
    pub fn revision(&self) -> &str {
        &self.snapshot.schema_revision
    }

    /// The renderer-safe view ops validate and build against. Reprojected on
    /// every call (it borrows nothing back) because it is cheap relative to
    /// the snapshot it is built from and a language switch must not require
    /// re-fetching the schema.
    pub fn view(&self, language: WorkflowLanguage) -> CategorySchemaView {
        category_schema_view(&self.snapshot, Some(language))
    }
}

/// Everything an op needs beyond the row (or rows) it operates on: the
/// pinned Category Schema, the Card the row belongs to, and the two effects
/// a pure function must never reach for itself.
///
/// `card` is `Option`, not mandatory, even though "no Card, no row" holds for
/// every row's creation (`seed_row` requires one and panics without it — see
/// its docs). A handful of edit-time branches in Cloud today tolerate a Card
/// that was concurrently deleted or fails to decode
/// (`write_draft_lean`'s `Ok(None)` / `Err(_)` arms over `listing_card`,
/// `rebuild_one`'s `parsed` lookup) by falling back to a card-less
/// validation instead of failing the whole request. `Ctx::card` stays
/// `Option` so [`edit_row`] and [`revalidate`] can reproduce that fallback
/// exactly, instead of forcing every caller through an error path production
/// does not take today.
pub struct Ctx<'a> {
    pub schema: &'a SchemaMaterial,
    pub card: Option<&'a CardPayload>,
    pub now_ms: u64,
    /// `+ Send`: Cloud constructs a `Ctx` inside `async fn` handlers and
    /// holds it (unused) across a later `.await` on the same stack frame —
    /// without this bound the trait object erases the closure's own
    /// Send-ness and the handler's future stops being `Send`, which axum and
    /// this repo's MCP tool trait both require.
    pub ids: &'a mut (dyn FnMut() -> [u8; 16] + Send),
}

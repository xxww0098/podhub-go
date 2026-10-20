//! `LeanRow`: `RowPayload` without its embedded `schema_snapshot`.
//!
//! `RowPayload::schema_snapshot` (`envelope.rs:97`) is the full Category
//! Schema — every field definition, every dictionary option, complex group
//! layout — repeated verbatim on every row that shares it. Cloud stores it
//! per row because Postgres has no per-workspace snapshot table to point at
//! instead; an in-memory op does not need that justification and must not
//! pay its cost: 1000 rows crossing the WASM boundary each carrying their own
//! copy would parse hundreds of MB of duplicate JSON for one open plan.
//! `LeanRow` is `RowPayload` with that one field pulled out; the schema
//! travels once per call, as [`super::SchemaMaterial`], not once per row.

use std::collections::BTreeSet;
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::envelope::{RowAi, RowMedia, RowPayload, RowRenderEvidence, RowSource};
use crate::error::ListingError;
use crate::records::{CategorySchemaSnapshot, FieldValueOrigin, NormalizedListingSnapshot};
use crate::validate::FieldIssue;
use crate::{WorkflowCategoryDraft, WorkflowFailureLogEntry, WorkflowLanguage};

fn default_language() -> WorkflowLanguage {
    WorkflowLanguage::Default
}

/// `RowPayload` minus `schema_snapshot`. Field names and JSON shape are
/// otherwise identical (same `#[serde(rename_all = "camelCase")]`), so a
/// caller can merge a raw top-level JSON patch onto `to_value()` and decode
/// the result back with `from_value()` exactly the way handlers already do
/// with `RowPayload` today (`schemaRevision` stays — it is a cheap string
/// identity check; only the fat `schemaSnapshot` object is gone).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeanRow {
    pub category_key: String,
    pub description_category_id: i64,
    pub type_id: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplier_product_id: Option<String>,
    #[serde(default = "default_language")]
    pub language: WorkflowLanguage,
    pub schema_revision: String,
    #[serde(default)]
    pub draft: WorkflowCategoryDraft,
    #[serde(default)]
    pub hand_edited_keys: BTreeSet<String>,
    #[serde(default)]
    pub field_origins: Vec<FieldValueOrigin>,
    #[serde(default)]
    pub normalized_snapshot: Option<NormalizedListingSnapshot>,
    #[serde(default)]
    pub validation_issues: Vec<FieldIssue>,
    #[serde(default)]
    pub source: RowSource,
    #[serde(default)]
    pub render_evidence: Option<RowRenderEvidence>,
    #[serde(default)]
    pub media: RowMedia,
    #[serde(default)]
    pub ai: RowAi,
    #[serde(default)]
    pub failure_log: Vec<WorkflowFailureLogEntry>,
}

impl LeanRow {
    /// Split a full `RowPayload` into its lean fields and the snapshot it
    /// embedded. The caller keeps the snapshot (usually as part of the
    /// [`super::SchemaMaterial`] it already fetched) to pass back to
    /// [`LeanRow::into_row`].
    pub fn from_row(row: RowPayload) -> (LeanRow, Arc<CategorySchemaSnapshot>) {
        (
            LeanRow {
                category_key: row.category_key,
                description_category_id: row.description_category_id,
                type_id: row.type_id,
                supplier_product_id: row.supplier_product_id,
                language: row.language,
                schema_revision: row.schema_revision,
                draft: row.draft,
                hand_edited_keys: row.hand_edited_keys,
                field_origins: row.field_origins,
                normalized_snapshot: row.normalized_snapshot,
                validation_issues: row.validation_issues,
                source: row.source,
                render_evidence: row.render_evidence,
                media: row.media,
                ai: row.ai,
                failure_log: row.failure_log,
            },
            row.schema_snapshot,
        )
    }

    /// Reattach a schema snapshot to rebuild the full `RowPayload` a caller
    /// stores. `schema_snapshot` is whatever [`super::SchemaMaterial`] the
    /// caller ran this edit against — usually the same one, but a caller is
    /// free to attach a different one.
    ///
    /// `schema_revision` is always taken from `schema_snapshot.schema_revision`,
    /// never from `self.schema_revision`: a `LeanRow` decoded straight from a
    /// stored row still carries whatever revision it was saved under, and an
    /// op that reattaches a freshly-refreshed snapshot (`ops::edit_row`'s
    /// non-light path, via `refresh_row_schema`) must not leave that stale
    /// string paired with the new snapshot's field material — the pair would
    /// no longer agree, and `ensure_revision_registered`'s registry check
    /// (`kernel/schema_revisions.rs`) fails closed on exactly that
    /// disagreement. `self.schema_revision` still reads back correctly on a
    /// caller that reattaches the same snapshot it split off (the common
    /// case), since a `CategorySchemaSnapshot`'s own `schema_revision` field
    /// is definitionally what that string was computed from.
    pub fn into_row(self, schema_snapshot: Arc<CategorySchemaSnapshot>) -> RowPayload {
        RowPayload {
            category_key: self.category_key,
            description_category_id: self.description_category_id,
            type_id: self.type_id,
            supplier_product_id: self.supplier_product_id,
            language: self.language,
            schema_revision: schema_snapshot.schema_revision.clone(),
            schema_snapshot,
            draft: self.draft,
            hand_edited_keys: self.hand_edited_keys,
            field_origins: self.field_origins,
            normalized_snapshot: self.normalized_snapshot,
            validation_issues: self.validation_issues,
            source: self.source,
            render_evidence: self.render_evidence,
            media: self.media,
            ai: self.ai,
            failure_log: self.failure_log,
        }
    }

    pub fn to_value(&self) -> Result<serde_json::Value, ListingError> {
        serde_json::to_value(self)
            .map_err(|error| ListingError::CloudSsot(format!("lean row encode: {error}")))
    }

    pub fn from_value(value: &serde_json::Value) -> Result<Self, ListingError> {
        serde_json::from_value(value.clone())
            .map_err(|error| ListingError::CloudSsot(format!("lean row decode: {error}")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;

    fn full_row() -> RowPayload {
        let schema = decorative_wall_art::local_schema_snapshot();
        RowPayload {
            category_key: schema.category_key.clone(),
            description_category_id: schema.description_category_id,
            type_id: schema.type_id,
            supplier_product_id: Some("sp-1".to_owned()),
            language: WorkflowLanguage::ZhHans,
            schema_revision: schema.schema_revision.clone(),
            schema_snapshot: Arc::new(schema),
            draft: WorkflowCategoryDraft::default(),
            hand_edited_keys: Default::default(),
            field_origins: Vec::new(),
            normalized_snapshot: None,
            validation_issues: Vec::new(),
            source: RowSource::default(),
            render_evidence: None,
            media: RowMedia::default(),
            ai: RowAi::default(),
            failure_log: Vec::new(),
        }
    }

    /// The split-then-rejoin round trip must reproduce the original row
    /// byte-for-byte: every op in this module relies on that to reattach a
    /// caller's [`super::SchemaMaterial`] snapshot without silently losing
    /// or reordering a field.
    #[test]
    fn from_row_into_row_round_trips() {
        let row = full_row();
        let (lean, snapshot) = LeanRow::from_row(row.clone());
        assert_eq!(lean.into_row(snapshot), row);
    }

    /// `LeanRow`'s JSON shape must be `RowPayload`'s minus `schemaSnapshot`:
    /// `edit_row` merges raw top-level JSON patches onto `to_value()` the
    /// same way handlers merge them onto a stored `listing_rows.payload`
    /// today, so a key rename here would silently stop matching client
    /// patches aimed at the real column.
    #[test]
    fn to_value_matches_row_payload_shape_minus_schema_snapshot() {
        let row = full_row();
        let mut expected = row
            .to_value()
            .expect("encode row")
            .as_object()
            .cloned()
            .expect("object");
        expected.remove("schemaSnapshot");
        let (lean, _snapshot) = LeanRow::from_row(row);
        let actual = lean
            .to_value()
            .expect("encode lean")
            .as_object()
            .cloned()
            .expect("object");
        assert_eq!(actual, expected);
    }
}

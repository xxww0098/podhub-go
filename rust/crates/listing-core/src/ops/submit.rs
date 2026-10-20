//! `SubmitDraft`: the wire shape of one item in a browser Draft submission
//! (`POST /api/listing/submit`,
//! `specs/browser-owned-listing/slices/07-submit-drafts.md`).
//!
//! A browser-owned row has no server-side `listing_rows` record to read back
//! (README S2/S3): the only thing that ever crosses the wire for it is the
//! Draft itself, at the moment of submit. `SubmitDraft` is that shape — the
//! subset of [`LeanRow`] a Draft actually carries, plus the two facts a
//! server-side row would otherwise have supplied (`row_id`, minted by the
//! browser's `crypto.randomUUID()` per README's single-owner table, and
//! `source_file_name`, since a Draft has no `RowSource.assetId`/`sha256` for
//! the server to check — the source image never leaves the browser's OPFS).
//!
//! What a Draft does **not** carry, on purpose: `normalizedSnapshot`,
//! `validationIssues`, `renderEvidence`, `ai` and `failureLog` are all
//! server-computed facts a stored row accumulates over its prepare pipeline.
//! A submitted Draft has none of that history — [`SubmitDraft::into_row`]
//! starts every one of those fields empty, and the server pipeline
//! (build → dictionary materials → validate → freeze) fills
//! `normalizedSnapshot`/`validationIssues` back in from scratch, exactly as
//! README's invariant I7 requires ("最终提交由服务端用同一内核重建并校验；
//! 浏览器结论只是建议").

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

use crate::envelope::{CardPayload, RowAi, RowMedia, RowSource};
use crate::records::FieldValueOrigin;
use crate::{WorkflowCategoryDraft, WorkflowLanguage};

use super::LeanRow;

fn default_language() -> WorkflowLanguage {
    WorkflowLanguage::Default
}

/// One Draft, as the browser sends it and as `SubmitDraft::from_row` reads it
/// back out of a local row (slice 16's job; not called from Cloud). Field
/// names and JSON shape mirror [`LeanRow`]'s own `#[serde(rename_all =
/// "camelCase")]` convention, so a browser that already holds a `LeanRow` in
/// memory (slice 12+) can build one of these by projection, not by hand.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitDraft {
    /// Browser-minted `crypto.randomUUID()` — the row identity that becomes
    /// `submission_intents.listing_row_id` (README 单一所有者: "行 id").
    pub row_id: String,
    /// The Category Schema revision this Draft was authored against. Compared
    /// against the server's own cached revision for the Card's coordinate; a
    /// mismatch is `schema_stale`, never silently accepted (README S2).
    pub schema_revision: String,
    #[serde(default = "default_language")]
    pub language: WorkflowLanguage,
    #[serde(default)]
    pub draft: WorkflowCategoryDraft,
    #[serde(default)]
    pub hand_edited_keys: BTreeSet<String>,
    #[serde(default)]
    pub field_origins: Vec<FieldValueOrigin>,
    /// The source PSD/photo's file name (`RowSource.fileName`) — used by the
    /// `SourceFile` build layer (`build.rs`) to derive blank `offer_id` /
    /// Ozon attributes 9024/9048. The source's `assetId`/`sha256` stay
    /// browser-only (OPFS, never uploaded): the server has no use for them,
    /// build reads only the file name.
    #[serde(default)]
    pub source_file_name: String,
    /// The row's uploaded/lifecycle media — images with their `publicUrl`
    /// pointing at this submission's own presigned batch, plus any adopted
    /// supplier videos. Checked at submit time against `parse_upload_key`
    /// (README S5); never trusted for its `phase` alone.
    #[serde(default)]
    pub media: RowMedia,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplier_product_id: Option<String>,
}

impl SubmitDraft {
    /// Project a local row into the shape a submit request sends. Not called
    /// from Cloud — slice 16's browser send queue is the real caller, through
    /// `listing-core-wasm` op 12 (`projectSubmitDraft`), so the browser never
    /// assembles a Draft by hand — kept here because the shape has exactly one
    /// owner (README S2/07's "决定": "SubmitDraft 的形状归 listing-core").
    pub fn from_row(row_id: String, row: &LeanRow) -> SubmitDraft {
        SubmitDraft {
            row_id,
            schema_revision: row.schema_revision.clone(),
            language: row.language,
            draft: row.draft.clone(),
            hand_edited_keys: row.hand_edited_keys.clone(),
            field_origins: row.field_origins.clone(),
            source_file_name: row.source.file_name.clone(),
            media: row.media.clone(),
            supplier_product_id: row.supplier_product_id.clone(),
        }
    }

    /// Reconstruct the [`LeanRow`] the server rebuilds and validates from.
    ///
    /// `card` supplies `categoryKey`/`descriptionCategoryId`/`typeId`: a Draft
    /// never carries its own category — exactly like a stored row's, which is
    /// minted from its Card at creation and never revised by a client
    /// (`envelope.rs`'s `CardPayload` doc). Every field a stored row
    /// accumulates from its own prepare history (`normalizedSnapshot`,
    /// `validationIssues`, `renderEvidence`, `ai`, `failureLog`) starts empty:
    /// the server's `build → validate → freeze` pipeline fills
    /// `normalizedSnapshot`/`validationIssues` back in itself, and the other
    /// three have no submit-time meaning for a row the server never prepared.
    ///
    /// Deliberately takes only `card`, not a `&SchemaMaterial`: the returned
    /// `LeanRow` does not embed a schema (that is the entire reason `LeanRow`
    /// exists), and the schema-revision staleness check this Draft's
    /// `schemaRevision` feeds is the caller's own comparison against
    /// `SchemaMaterial::revision()` — `into_row` would have nothing left to do
    /// with the material.
    pub fn into_row(self, card: &CardPayload) -> LeanRow {
        LeanRow {
            category_key: card.category_key.clone(),
            description_category_id: card.description_category_id,
            type_id: card.type_id,
            supplier_product_id: self.supplier_product_id,
            language: self.language,
            schema_revision: self.schema_revision,
            draft: self.draft,
            hand_edited_keys: self.hand_edited_keys,
            field_origins: self.field_origins,
            normalized_snapshot: None,
            validation_issues: Vec::new(),
            source: RowSource {
                asset_id: String::new(),
                sha256: String::new(),
                file_name: self.source_file_name,
            },
            render_evidence: None,
            media: self.media,
            ai: RowAi::default(),
            failure_log: Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;
    use crate::envelope::RowPayload;

    fn card() -> CardPayload {
        let schema = decorative_wall_art::local_schema_snapshot();
        CardPayload {
            category_key: schema.category_key.clone(),
            description_category_id: schema.description_category_id,
            type_id: schema.type_id,
            language: WorkflowLanguage::Default,
            defaults: WorkflowCategoryDraft::default(),
            ai_prompt_id: String::new(),
            ai_prompt_sha256: String::new(),
            supplier_product_id: None,
            psd_template_asset_id: String::new(),
            psd_template_sha256: String::new(),
            psd_template_file_name: String::new(),
            ai_field_policy: crate::WorkflowAiFieldPolicy {
                allowed_field_keys: Vec::new(),
                protected_field_keys: Vec::new(),
            },
            videos: Vec::new(),
            video_cover: None,
            queue: Default::default(),
        }
    }

    fn full_row() -> RowPayload {
        let schema = decorative_wall_art::local_schema_snapshot();
        RowPayload {
            category_key: schema.category_key.clone(),
            description_category_id: schema.description_category_id,
            type_id: schema.type_id,
            supplier_product_id: Some("sp-1".to_owned()),
            language: WorkflowLanguage::ZhHans,
            schema_revision: schema.schema_revision.clone(),
            schema_snapshot: std::sync::Arc::new(schema),
            draft: WorkflowCategoryDraft::default(),
            hand_edited_keys: Default::default(),
            field_origins: Vec::new(),
            normalized_snapshot: None,
            validation_issues: Vec::new(),
            source: RowSource {
                asset_id: "asset-1".to_owned(),
                sha256: "sha256:deadbeef".to_owned(),
                file_name: "ART-001.psd".to_owned(),
            },
            render_evidence: None,
            media: RowMedia::default(),
            ai: RowAi::default(),
            failure_log: Vec::new(),
        }
    }

    /// `from_row` then `into_row` against the row's own Card reproduces every
    /// field a Draft is allowed to carry; the four server-only fields
    /// (`normalizedSnapshot`, `validationIssues`, `renderEvidence`, `ai`,
    /// `failureLog`) reset, and the source identity fields the browser never
    /// uploads (`assetId`, `sha256`) drop to empty.
    #[test]
    fn from_row_into_row_keeps_the_draft_and_drops_server_only_history() {
        let row = full_row();
        let card = CardPayload {
            category_key: row.category_key.clone(),
            description_category_id: row.description_category_id,
            type_id: row.type_id,
            ..card()
        };
        let (lean, _snapshot) = LeanRow::from_row(row.clone());
        let submitted = SubmitDraft::from_row("row-1".to_owned(), &lean);
        assert_eq!(submitted.row_id, "row-1");
        assert_eq!(submitted.source_file_name, "ART-001.psd");
        assert_eq!(submitted.supplier_product_id.as_deref(), Some("sp-1"));

        let rebuilt = submitted.into_row(&card);
        assert_eq!(rebuilt.category_key, row.category_key);
        assert_eq!(rebuilt.description_category_id, row.description_category_id);
        assert_eq!(rebuilt.type_id, row.type_id);
        assert_eq!(rebuilt.language, row.language);
        assert_eq!(rebuilt.schema_revision, row.schema_revision);
        assert_eq!(rebuilt.draft, row.draft);
        assert_eq!(rebuilt.supplier_product_id, row.supplier_product_id);
        assert_eq!(rebuilt.source.file_name, row.source.file_name);
        assert_eq!(rebuilt.source.asset_id, "", "OPFS identity never uploads");
        assert_eq!(rebuilt.source.sha256, "", "OPFS identity never uploads");
        assert!(rebuilt.normalized_snapshot.is_none());
        assert!(rebuilt.validation_issues.is_empty());
        assert!(rebuilt.render_evidence.is_none());
        assert_eq!(rebuilt.ai, RowAi::default());
        assert!(rebuilt.failure_log.is_empty());
    }

    /// `into_row` takes the Card's coordinate, not any coordinate the Draft
    /// might (incorrectly) carry — a Draft has no coordinate fields at all,
    /// so this is really asserting the Card is the only source.
    #[test]
    fn into_row_anchors_the_coordinate_on_the_card() {
        let card = card();
        let submitted = SubmitDraft {
            row_id: "row-2".to_owned(),
            schema_revision: "rev-1".to_owned(),
            language: WorkflowLanguage::Default,
            draft: WorkflowCategoryDraft::default(),
            hand_edited_keys: Default::default(),
            field_origins: Vec::new(),
            source_file_name: "photo.jpg".to_owned(),
            media: RowMedia::default(),
            supplier_product_id: None,
        };
        let row = submitted.into_row(&card);
        assert_eq!(row.category_key, card.category_key);
        assert_eq!(row.description_category_id, card.description_category_id);
        assert_eq!(row.type_id, card.type_id);
    }

    /// A browser may keep its own preview `clientOperationId` / digest next to
    /// a Draft. They are not part of the shape: decoding drops them, and the
    /// frozen identity comes only from freezing the rebuilt row — the same
    /// `freeze_validated` the server's `POST /api/listing/submit` runs.
    #[test]
    fn a_browser_preview_identity_never_reaches_the_frozen_operation_id() {
        use crate::compose::compose_tests::{golden_card, golden_row};
        use crate::ops::{FreezeOutcome, SchemaMaterial, freeze_listing};
        use crate::validate::DictionaryMaterials;

        let (lean, snapshot) = LeanRow::from_row(golden_row());
        let material = SchemaMaterial::new(snapshot, DictionaryMaterials::default());
        let honest =
            serde_json::to_value(SubmitDraft::from_row("draft-ozon-golden".to_owned(), &lean))
                .expect("draft json");
        let mut forged = honest.clone();
        forged["clientOperationId"] =
            serde_json::json!("workflow:draft-ozon-golden:OTHER:sha256:forged");
        forged["digest"] = serde_json::json!("sha256:forged");
        let freeze = |value: serde_json::Value| {
            let draft: SubmitDraft = serde_json::from_value(value).expect("draft decodes");
            let card = golden_card();
            freeze_listing(&material, &card, draft.into_row(&card), "draft-ozon-golden")
        };
        let honest_outcome = freeze(honest);
        assert_eq!(
            freeze(forged),
            honest_outcome,
            "the preview fields change nothing the server computes"
        );
        if let FreezeOutcome::Frozen { frozen, .. } = honest_outcome {
            assert!(
                frozen
                    .client_operation_id
                    .starts_with("workflow:draft-ozon-golden:")
            );
            assert!(!frozen.client_operation_id.contains("forged"));
            assert_ne!(frozen.digest, "sha256:forged");
        }
    }
}

//! The one persisted shape of `listing_rows.payload` and
//! `listing_cards.payload`.
//!
//! Derived fields are not persisted: `fieldValues` / `rawValues` /
//! `complexValues` are re-derived from `draft` at validation time,
//! `lifecycleState` is the `validation_state` column, and `executionPlan` is
//! recomputed on read.
//!
//! `categoryKey`, `schemaRevision` and `schemaSnapshot` stay at the top level:
//! `listing_rows.category_key` is generated from the first and the lean write
//! path reads the other two.

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::{
    WorkflowAiCandidate, WorkflowAiFieldPolicy, WorkflowAiSummary, WorkflowCategoryDraft,
    WorkflowFailureLogEntry, WorkflowImageLifecycle, WorkflowLanguage, WorkflowVideoMetadata,
};
use op_workflow::RenderEvidence;
use serde::{Deserialize, Serialize};

use super::error::ListingError;
use super::records::{CategorySchemaSnapshot, FieldValueOrigin, NormalizedListingSnapshot};
use super::validate::FieldIssue;

fn default_language() -> WorkflowLanguage {
    WorkflowLanguage::Default
}

/// PSD / photo the row was created from.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowSource {
    #[serde(default)]
    pub asset_id: String,
    #[serde(default)]
    pub sha256: String,
    #[serde(default)]
    pub file_name: String,
}

/// Committed render evidence plus what the renderer degraded to get it. The
/// kernel reads the flattened [`RenderEvidence`] straight out of this object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowRenderEvidence {
    #[serde(flatten)]
    pub evidence: RenderEvidence,
    #[serde(default)]
    pub slice_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub manifest: Option<serde_json::Value>,
    #[serde(default)]
    pub degradations: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowMedia {
    #[serde(default)]
    pub images: Vec<WorkflowImageLifecycle>,
    #[serde(default)]
    pub videos: Vec<WorkflowVideoMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_cover: Option<WorkflowVideoMetadata>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowAi {
    #[serde(default)]
    pub request_id: String,
    #[serde(default)]
    pub candidates: Vec<WorkflowAiCandidate>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<WorkflowAiSummary>,
    #[serde(default)]
    pub prompt_sha256: String,
    #[serde(default)]
    pub model_version: String,
}

/// `listing_rows.payload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowPayload {
    pub category_key: String,
    pub description_category_id: i64,
    pub type_id: i64,
    /// Snapshot of the supplier specification selected when this row was created.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplier_product_id: Option<String>,
    #[serde(default = "default_language")]
    pub language: WorkflowLanguage,
    pub schema_revision: String,
    pub schema_snapshot: Arc<CategorySchemaSnapshot>,
    #[serde(default)]
    pub draft: WorkflowCategoryDraft,
    /// Fields the operator owns; neither the card overlay nor AI settlement
    /// may write them. Cloud records them via `content_policy::record_manual_changes`.
    #[serde(default)]
    pub hand_edited_keys: BTreeSet<String>,
    #[serde(default)]
    pub field_origins: Vec<FieldValueOrigin>,
    // Typed writes merge into the raw row; explicit null clears stale facts.
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

impl RowPayload {
    pub fn from_value(value: &serde_json::Value) -> Result<Self, ListingError> {
        serde_json::from_value(value.clone()).map_err(|error| {
            ListingError::CloudSsot(format!("listing row payload decode: {error}"))
        })
    }

    pub fn to_value(&self) -> Result<serde_json::Value, ListingError> {
        serde_json::to_value(self).map_err(|error| {
            ListingError::CloudSsot(format!("listing row payload encode: {error}"))
        })
    }
}

/// Card-owned queue cursor. `running` and the claim token are derived from the
/// unfinished `listing.submit.batch` job; the card `revision` CAS is the fence.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardQueue {
    #[serde(default)]
    pub paused: bool,
    #[serde(default)]
    pub stop_after_current: bool,
    #[serde(default)]
    pub next_position: u32,
    #[serde(default)]
    pub frozen_row_ids: Vec<String>,
}

/// `listing_cards.payload`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardPayload {
    pub category_key: String,
    pub description_category_id: i64,
    pub type_id: i64,
    #[serde(default = "default_language")]
    pub language: WorkflowLanguage,
    #[serde(default)]
    pub defaults: WorkflowCategoryDraft,
    #[serde(default)]
    pub ai_prompt_id: String,
    #[serde(default)]
    pub ai_prompt_sha256: String,
    /// Stable supplier product identity; when present recognition resolves the
    /// live prompt from that product instead of the category prompt table.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub supplier_product_id: Option<String>,
    #[serde(default)]
    pub psd_template_asset_id: String,
    #[serde(default)]
    pub psd_template_sha256: String,
    #[serde(default)]
    pub psd_template_file_name: String,
    pub ai_field_policy: WorkflowAiFieldPolicy,
    /// Reusable product videos every Product Instance of this cohort starts
    /// with. Same `op_workflow` types as [`RowMedia`]: a Card video and a row
    /// video are the same thing, bound at a different level. A new row copies
    /// these into `payload.media` at creation and owns them from then on
    /// (fill-blank) — the Card is a recipe, not a live overlay.
    #[serde(default)]
    pub videos: Vec<WorkflowVideoMetadata>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_cover: Option<WorkflowVideoMetadata>,
    #[serde(default)]
    pub queue: CardQueue,
}

impl CardPayload {
    pub fn from_value(value: &serde_json::Value) -> Result<Self, ListingError> {
        serde_json::from_value(value.clone()).map_err(|error| {
            ListingError::CloudSsot(format!("listing card payload decode: {error}"))
        })
    }

    pub fn to_value(&self) -> Result<serde_json::Value, ListingError> {
        serde_json::to_value(self).map_err(|error| {
            ListingError::CloudSsot(format!("listing card payload encode: {error}"))
        })
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{
        WorkflowDraftValue, WorkflowFailureStage, WorkflowImagePhase, WorkflowVideoOrigin,
        WorkflowVideoRole,
    };
    use serde_json::json;

    use super::*;
    use crate::categories::decorative_wall_art;

    fn populated_row() -> RowPayload {
        let schema = decorative_wall_art::local_schema_snapshot();
        RowPayload {
            category_key: schema.category_key.clone(),
            description_category_id: schema.description_category_id,
            type_id: schema.type_id,
            supplier_product_id: None,
            language: WorkflowLanguage::ZhHans,
            schema_revision: schema.schema_revision.clone(),
            schema_snapshot: Arc::new(schema),
            draft: WorkflowCategoryDraft {
                values: BTreeMap::from([(
                    "offer_id".to_owned(),
                    WorkflowDraftValue::Text("ART-001".to_owned()),
                )]),
                complex_values: Vec::new(),
                ..Default::default()
            },
            hand_edited_keys: BTreeSet::from(["offer_id".to_owned()]),
            field_origins: Vec::new(),
            normalized_snapshot: None,
            validation_issues: Vec::new(),
            source: RowSource {
                asset_id: "asset_01".to_owned(),
                sha256: "sha256:aa".to_owned(),
                file_name: "ART-001.psd".to_owned(),
            },
            render_evidence: Some(RowRenderEvidence {
                evidence: RenderEvidence {
                    source_sha256: "sha256:src".to_owned(),
                    template_sha256: "sha256:tpl".to_owned(),
                    renderer_contract_version: "1".to_owned(),
                    manifest_digest: "sha256:man".to_owned(),
                },
                slice_count: 3,
                manifest: None,
                degradations: vec!["downscaled".to_owned()],
            }),
            media: RowMedia {
                images: vec![WorkflowImageLifecycle {
                    account_id: None,
                    index: 0,
                    file_name: "ART-001-1.jpg".to_owned(),
                    content_hash: "sha256:img".to_owned(),
                    group_name: String::new(),
                    width: 900,
                    height: 1200,
                    byte_size: Some(1024),
                    phase: WorkflowImagePhase::PublicReady,
                    public_url: Some("https://media.example.invalid/hero.jpg".to_owned()),
                    object_key: None,
                    error_code: None,
                }],
                videos: vec![WorkflowVideoMetadata {
                    role: WorkflowVideoRole::Product,
                    origin: WorkflowVideoOrigin::PublicUrl,
                    file_name: "clip.mp4".to_owned(),
                    content_type: "video/mp4".to_owned(),
                    size_bytes: 10,
                    duration_ms: 1000,
                    public_url: Some("https://media.example.invalid/clip.mp4".to_owned()),
                    object_key: None,
                    content_hash: None,
                }],
                video_cover: None,
            },
            ai: RowAi {
                request_id: String::new(),
                candidates: Vec::new(),
                summary: Some(WorkflowAiSummary {
                    tags: vec!["#море".to_owned()],
                    model: "qwen".to_owned(),
                }),
                prompt_sha256: "sha256:prompt".to_owned(),
                model_version: "qwen-vl".to_owned(),
            },
            failure_log: vec![WorkflowFailureLogEntry {
                stage: WorkflowFailureStage::Media,
                code: "render_failed".to_owned(),
                message: "boom".to_owned(),
                remediation: None,
                image_index: Some(0),
                occurred_at_ms: 7,
            }],
        }
    }

    #[test]
    fn row_payload_round_trips_through_json() {
        let payload = populated_row();
        let value = payload.to_value().expect("encode");
        assert_eq!(
            RowPayload::from_value(&value).expect("decode"),
            payload,
            "listing_rows.payload must survive a Postgres round trip unchanged"
        );
    }

    #[test]
    fn row_payload_normalizes_legacy_numeric_failure_code() {
        let mut value = populated_row().to_value().expect("encode");
        value["failureLog"][0]["code"] = json!(7);

        let payload = RowPayload::from_value(&value).expect("legacy numeric code decodes");
        assert_eq!(payload.failure_log[0].code, "7");

        let rewritten = payload.to_value().expect("rewrite");
        assert_eq!(rewritten["failureLog"][0]["code"], json!("7"));

        for invalid_code in [json!(7.5), json!(true), json!(null)] {
            value["failureLog"][0]["code"] = invalid_code;
            assert!(
                RowPayload::from_value(&value).is_err(),
                "only legacy integer failure codes are accepted"
            );
        }
    }

    /// The generated `listing_rows.category_key` column and the lean write path
    /// read these keys directly, so they must stay top-level and camelCase.
    #[test]
    fn row_payload_keeps_the_generated_column_keys_at_the_top_level() {
        let value = populated_row().to_value().expect("encode");
        let object = value.as_object().expect("object");
        for key in [
            "categoryKey",
            "descriptionCategoryId",
            "typeId",
            "language",
            "schemaRevision",
            "schemaSnapshot",
            "handEditedKeys",
            "fieldOrigins",
            "validationIssues",
            "renderEvidence",
            "media",
            "ai",
            "failureLog",
        ] {
            assert!(object.contains_key(key), "missing payload key {key}");
        }
        assert_eq!(value["language"], json!("zh_hans"));
        assert_eq!(value["renderEvidence"]["sourceSha256"], json!(null));
        assert_eq!(
            value["renderEvidence"]["source_sha256"],
            json!("sha256:src"),
            "the flattened RenderEvidence keeps op-workflow's own field names"
        );
        assert_eq!(value["renderEvidence"]["sliceCount"], json!(3));
    }

    /// A minimal document — everything the writer left out — must still decode,
    /// because the first PATCH on a fresh row carries only the coordinates.
    #[test]
    fn row_payload_decodes_a_minimal_document() {
        let schema = decorative_wall_art::local_schema_snapshot();
        let value = json!({
            "categoryKey": schema.category_key,
            "descriptionCategoryId": schema.description_category_id,
            "typeId": schema.type_id,
            "schemaRevision": schema.schema_revision,
            "schemaSnapshot": schema,
        });
        let payload = RowPayload::from_value(&value).expect("decode minimal");
        assert_eq!(payload.language, WorkflowLanguage::Default);
        assert!(payload.draft.values.is_empty());
        assert!(payload.normalized_snapshot.is_none());
        assert!(payload.media.images.is_empty());
    }

    #[test]
    fn card_payload_round_trips_through_json() {
        let card = CardPayload {
            category_key: "workflow:17027906:91976".to_owned(),
            description_category_id: 17027906,
            type_id: 91976,
            language: WorkflowLanguage::Default,
            defaults: WorkflowCategoryDraft::default(),
            ai_prompt_id: "prompt_01".to_owned(),
            ai_prompt_sha256: "sha256:prompt".to_owned(),
            supplier_product_id: None,
            psd_template_asset_id: "asset_02".to_owned(),
            psd_template_sha256: "sha256:tpl".to_owned(),
            psd_template_file_name: "template.psd".to_owned(),
            ai_field_policy: WorkflowAiFieldPolicy {
                allowed_field_keys: vec!["name".to_owned()],
                protected_field_keys: vec!["price".to_owned()],
            },
            videos: vec![card_video()],
            video_cover: Some(WorkflowVideoMetadata {
                role: WorkflowVideoRole::Cover,
                ..card_video()
            }),
            queue: CardQueue {
                paused: true,
                stop_after_current: false,
                next_position: 2,
                frozen_row_ids: vec!["row_a".to_owned(), "row_b".to_owned()],
            },
        };
        let value = card.to_value().expect("encode");
        assert_eq!(value["queue"]["frozenRowIds"][1], json!("row_b"));
        assert_eq!(
            value["aiFieldPolicy"]["allowed_field_keys"][0],
            json!("name")
        );
        assert_eq!(
            value["videos"][0]["file_name"],
            json!("card.mp4"),
            "a Card's reusable videos are the same op-workflow shape a row's are"
        );
        assert_eq!(value["videoCover"]["role"], json!("cover"));
        assert_eq!(CardPayload::from_value(&value).expect("decode"), card);
    }

    /// A Card written before videos existed must still decode: the SPA's live
    /// cards were all stored without the two keys.
    #[test]
    fn card_payload_decodes_a_document_without_videos() {
        let value = json!({
            "categoryKey": "workflow:17027906:91976",
            "descriptionCategoryId": 17027906,
            "typeId": 91976,
            "schemaRevision": "workflow:sha256:aa",
            "aiFieldPolicy": {"allowed_field_keys": [], "protected_field_keys": []},
        });
        let card = CardPayload::from_value(&value).expect("decode");
        assert!(card.videos.is_empty());
        assert!(card.video_cover.is_none());
    }

    fn card_video() -> WorkflowVideoMetadata {
        WorkflowVideoMetadata {
            role: WorkflowVideoRole::Product,
            origin: WorkflowVideoOrigin::PublicUrl,
            file_name: "card.mp4".to_owned(),
            content_type: "video/mp4".to_owned(),
            size_bytes: 42,
            duration_ms: 4200,
            public_url: Some("https://media.example.invalid/card.mp4".to_owned()),
            object_key: None,
            content_hash: Some("sha256:card-video".to_owned()),
        }
    }
}

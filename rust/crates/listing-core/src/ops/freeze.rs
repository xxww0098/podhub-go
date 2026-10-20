//! `freeze_listing`: one row's Ozon `/v3/product/import` body, frozen the way
//! `POST /api/listing/submit` freezes it (`src/listing/api/submit_drafts_pipeline.rs`:
//! revision check → adopt supplier videos → build → validate → freeze), so a
//! browser can show the exact body, digest and `clientOperationId` before it
//! asks the server to send.
//!
//! The result is a local preview, never an authorization: the server still
//! checks auth/tenant/store/draft revision, rebuilds the body from its own
//! Card and schema, and owns intent idempotency (README I7). What this op adds
//! over the server path is refusing, up front, rows the server would never be
//! shown in that state: a Draft still holding unconfirmed AI candidates, or
//! one whose coordinate disagrees with its Card or the resident schema.
//! Every refusal carries [`FieldIssue`]s so the operator sees what to fix.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::WorkflowAiCandidateState;
use crate::build::{BuildEvidence, build_listing};
use crate::compose::{FrozenImport, adopt_supplier_videos, freeze_validated, validate_built};
use crate::envelope::CardPayload;
use crate::issue_keys::{IssueStage, OzonFreezeCode as Code};
use crate::records::FieldAddress;
use crate::validate::{FieldIssue, IssueParameter, IssueSeverity};

use super::{LeanRow, SchemaMaterial};

/// Why a row did not freeze. Stable wire names (`snake_case` in the WASM
/// projection); the issues attached to the refusal carry the details.
///
/// A closed set with one owner: the serde names, [`Self::as_str`], the
/// `FreezeRefusal` OpenAPI component (feature `openapi`, registered by
/// Cloud's publish doc) and the WASM op 11 `reason` are the same six
/// literals, enumerated by [`Self::ALL`]. Decoding is strict — there is no
/// catch-all variant, so an unknown reason fails instead of turning into a
/// known one. These are *reasons*, not issue codes: the freeze-stage
/// `FieldIssue` codes are [`crate::issue_keys::OzonFreezeCode`]
/// (`language_mismatch` rides under `coordinate_mismatch`,
/// `ai_candidate_unresolved` under `candidates_unresolved`), and
/// `validation_failed` carries validate codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "openapi", derive(utoipa::ToSchema))]
#[serde(rename_all = "snake_case")]
pub enum FreezeRefusal {
    /// `row_id` is blank or carries surrounding whitespace: it keys the
    /// `clientOperationId`, so an ambiguous id would mint a divergent identity.
    RowIdInvalid,
    /// The Draft was authored against another Schema Revision.
    SchemaStale,
    /// Row, Card and resident schema do not name the same Ozon category/type,
    /// or row and Card disagree on language. Languages are compared exactly —
    /// `default` and `ru` are distinct cache coordinates natively, never
    /// mapped onto each other. The snapshot carries no language of its own;
    /// its Schema Revision check above is what pins its field material.
    CoordinateMismatch,
    /// AI candidates are still `proposed`/`unresolved`.
    CandidatesUnresolved,
    /// The built Draft failed validation.
    ValidationFailed,
    /// Validated, but the Seller body could not be serialized.
    FreezeFailed,
}

impl FreezeRefusal {
    /// Every refusal, in declaration order.
    pub const ALL: &'static [Self] = &[
        Self::RowIdInvalid,
        Self::SchemaStale,
        Self::CoordinateMismatch,
        Self::CandidatesUnresolved,
        Self::ValidationFailed,
        Self::FreezeFailed,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::RowIdInvalid => "row_id_invalid",
            Self::SchemaStale => "schema_stale",
            Self::CoordinateMismatch => "coordinate_mismatch",
            Self::CandidatesUnresolved => "candidates_unresolved",
            Self::ValidationFailed => "validation_failed",
            Self::FreezeFailed => "freeze_failed",
        }
    }

    /// The stage of the issues this refusal carries. `validation_failed`
    /// forwards validate's own issues unchanged; every other refusal is
    /// freeze's own finding. This is operation evidence, so a consumer never
    /// has to guess a stage from an issue code.
    pub fn issue_stage(self) -> IssueStage {
        match self {
            Self::ValidationFailed => IssueStage::Validate,
            Self::RowIdInvalid
            | Self::SchemaStale
            | Self::CoordinateMismatch
            | Self::CandidatesUnresolved
            | Self::FreezeFailed => IssueStage::Freeze,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum FreezeOutcome {
    Frozen {
        frozen: FrozenImport,
        evidence: BuildEvidence,
    },
    Refused {
        reason: FreezeRefusal,
        issues: Vec<FieldIssue>,
        /// `None` when the refusal happened before build ran.
        evidence: Option<BuildEvidence>,
    },
}

pub fn freeze_listing(
    schema: &SchemaMaterial,
    card: &CardPayload,
    row: LeanRow,
    row_id: &str,
) -> FreezeOutcome {
    let refuse = |reason, issues, evidence| FreezeOutcome::Refused {
        reason,
        issues,
        evidence,
    };
    if row_id.is_empty() || row_id.trim() != row_id {
        let issue = issue(
            "row_id",
            Code::RowIdInvalid,
            "商品标识为空或含首尾空格，无法生成唯一的提交标识",
            "刷新页面重新载入该商品后再发送",
        );
        return refuse(FreezeRefusal::RowIdInvalid, vec![issue], None);
    }
    if row.schema_revision != schema.revision() {
        let mut issue = issue(
            "schema_revision",
            Code::SchemaStale,
            "类目字段已更新，这个商品仍是按旧版字段填写的",
            "重新打开上架方案同步类目字段，检查该商品后再发送",
        );
        issue.parameters.insert(
            "row_revision".to_owned(),
            IssueParameter::Text(row.schema_revision.clone()),
        );
        issue.parameters.insert(
            "schema_revision".to_owned(),
            IssueParameter::Text(schema.revision().to_owned()),
        );
        return refuse(FreezeRefusal::SchemaStale, vec![issue], None);
    }
    let snapshot = schema.snapshot();
    let coordinate = (
        row.category_key.as_str(),
        row.description_category_id,
        row.type_id,
    );
    let card_coordinate = (
        card.category_key.as_str(),
        card.description_category_id,
        card.type_id,
    );
    let snapshot_coordinate = (
        snapshot.category_key.as_str(),
        snapshot.description_category_id,
        snapshot.type_id,
    );
    if coordinate != card_coordinate || snapshot_coordinate != card_coordinate {
        let issue = issue(
            "category",
            Code::CoordinateMismatch,
            "商品的 Ozon 类目与上架方案或已加载的类目字段不一致",
            "在正确的上架方案下重新生成该商品，或重新打开方案加载其类目字段",
        );
        return refuse(FreezeRefusal::CoordinateMismatch, vec![issue], None);
    }
    if row.language != card.language {
        let issue = issue(
            "language",
            Code::LanguageMismatch,
            "商品的类目语言与上架方案不一致",
            "在上架方案当前语言下重新生成该商品后再发送",
        );
        return refuse(FreezeRefusal::CoordinateMismatch, vec![issue], None);
    }
    let unresolved: Vec<FieldIssue> = row
        .ai
        .candidates
        .iter()
        .filter(|candidate| {
            matches!(
                candidate.state,
                WorkflowAiCandidateState::Proposed | WorkflowAiCandidateState::Unresolved
            )
        })
        .map(|candidate| {
            let field_key = match &candidate.address {
                FieldAddress::Plain { field_key } | FieldAddress::Complex { field_key, .. } => {
                    field_key.clone()
                }
            };
            FieldIssue {
                address: candidate.address.clone(),
                ..issue(
                    &field_key,
                    Code::AiCandidateUnresolved,
                    &format!("字段「{field_key}」仍有未确认的 AI 候选值"),
                    "在候选审阅中确认或拒绝该值后再发送",
                )
            }
        })
        .collect();
    if !unresolved.is_empty() {
        return refuse(FreezeRefusal::CandidatesUnresolved, unresolved, None);
    }

    let mut payload = row.into_row(snapshot.clone());
    adopt_supplier_videos(&mut payload, card);
    let built = build_listing(&payload, card);
    let evidence = built.evidence(card);
    let validated = match validate_built(&payload, &built.draft, schema.materials()) {
        Ok(validated) => validated,
        Err(issues) => return refuse(FreezeRefusal::ValidationFailed, issues, Some(evidence)),
    };
    match freeze_validated(row_id, &validated, &built.media) {
        Ok(frozen) => FreezeOutcome::Frozen { frozen, evidence },
        Err(error) => {
            // The error text is diagnostic (it may quote serializer internals),
            // so it rides as a parameter; the message stays a fixed sentence.
            let mut issue = issue(
                "import",
                Code::FreezeFailed,
                "商品已通过校验，但无法生成 Ozon 提交内容",
                "检查商品名称与媒体后重试；仍失败请联系管理员并提供诊断信息",
            );
            issue
                .parameters
                .insert("detail".to_owned(), IssueParameter::Text(error.to_string()));
            refuse(FreezeRefusal::FreezeFailed, vec![issue], Some(evidence))
        }
    }
}

/// A blocking freeze-stage issue. The only way this op mints a `FieldIssue`:
/// it accepts a declared [`Code`], never a free string.
fn issue(field_key: &str, code: Code, message: &str, remediation: &str) -> FieldIssue {
    FieldIssue {
        field_key: field_key.to_owned(),
        code: code.as_str().to_owned(),
        parameters: BTreeMap::new(),
        severity: IssueSeverity::Blocking,
        address: FieldAddress::Plain {
            field_key: field_key.to_owned(),
        },
        message: message.to_owned(),
        remediation: Some(remediation.to_owned()),
    }
}

#[cfg(test)]
#[path = "freeze_tests.rs"]
mod freeze_tests;

//! Local stage plans for work the browser already has.
//!
//! A complete-batch request spends the caller's media-upload slot on an origin
//! read. Objects the browser can already see are inconsistent — wrong digest,
//! key, length, ticket, or workspace — must not be sent. A 429 or 503 on the
//! batch means this user is over the slot; splitting that batch into one
//! `/complete` per object spends the same slot again.
//!
//! This module does not grant a lease, check a session, read object storage,
//! or write to a Seller. Those stay on the server. The server still re-checks
//! every object that this plan admits.

use serde::{Deserialize, Serialize};

/// Same ceiling as `src/media/upload.rs`. A larger body is refused there.
pub const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// One complete-batch body. [`plan_confirm`] lists every admitted index; the
/// caller slices that list into chunks of this size.
pub const MAX_CONFIRM_BATCH: usize = 32;

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmCandidate {
    pub index: u32,
    pub digest: String,
    pub extension: String,
    #[serde(default)]
    pub object_key: String,
    #[serde(default)]
    pub byte_length: u64,
    #[serde(default)]
    pub storage_revision: i64,
    #[serde(default)]
    pub upload_ticket: String,
    #[serde(default)]
    pub account_id: String,
    #[serde(default)]
    pub workspace_uuid: String,
    #[serde(default)]
    pub pending_confirm: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ConfirmItem {
    Skip {
        index: u32,
    },
    Reject {
        index: u32,
        code: &'static str,
        message: &'static str,
    },
    Admit {
        index: u32,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfirmPlan {
    pub items: Vec<ConfirmItem>,
    /// Every admitted index, in input order. The caller sends them
    /// [`MAX_CONFIRM_BATCH`] at a time.
    pub batch: Vec<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConfirmAfterBatch {
    /// The batch already waited out admission. Do not open N single completes.
    KeepBatch,
    /// The batch shape failed. One object at a time may still confirm.
    SplitOnes,
}

#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OcrFacts {
    #[serde(default)]
    pub has_recovery: bool,
    #[serde(default)]
    pub has_display_text: bool,
    #[serde(default)]
    pub original_status: String,
    #[serde(default)]
    pub original_usable: Option<bool>,
    #[serde(default)]
    pub original_request_id: String,
    #[serde(default)]
    pub retry_status: String,
    #[serde(default)]
    pub retry_usable: Option<bool>,
    #[serde(default)]
    pub retry_request_id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrStep {
    Wait,
    Settle,
    Unusable,
    SimpleRetry,
    Pause,
    PurchaseOriginal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OcrDisplay {
    /// The row already carries recognition text. Showing it needs no GET.
    ShowLocal,
    /// The purchase ledger is still the server's. One lookup or settle remains.
    Server,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrPlan {
    pub step: OcrStep,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub display: OcrDisplay,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum StageRequest {
    // The enum-level `rename_all` above cases only the `kind` tag's variant
    // names (`confirmRetry`), never a struct variant's own fields: those keep
    // their literal Rust spelling unless the variant itself carries
    // `rename_all`. Without the per-variant attribute `outcomeUnknown` from
    // the wire falls into `#[serde(default)]` and silently becomes `false` —
    // the same silent-defaulting trap `listing-core-wasm`'s `EditInput` had,
    // and here it would quietly demote every uncertain retry to a certain one.
    #[serde(rename_all = "camelCase")]
    Confirm { candidates: Vec<ConfirmCandidate> },
    #[serde(rename_all = "camelCase")]
    ConfirmRetry {
        status: u16,
        #[serde(default)]
        code: String,
        #[serde(default)]
        outcome_unknown: bool,
    },
    #[serde(rename_all = "camelCase")]
    Ocr { facts: OcrFacts },
}

pub fn plan_stage(request: StageRequest) -> Result<serde_json::Value, serde_json::Error> {
    match request {
        StageRequest::Confirm { candidates } => serde_json::to_value(plan_confirm(&candidates)),
        StageRequest::ConfirmRetry {
            status,
            code,
            outcome_unknown,
        } => Ok(serde_json::json!({
            "after": confirm_after_batch(status, &code, outcome_unknown)
        })),
        StageRequest::Ocr { facts } => serde_json::to_value(plan_ocr(&facts)),
    }
}

pub fn plan_confirm(candidates: &[ConfirmCandidate]) -> ConfirmPlan {
    let mut items = Vec::with_capacity(candidates.len());
    let mut seen = Vec::<(String, String)>::new();
    let mut batch = Vec::new();
    for candidate in candidates {
        if !candidate.pending_confirm {
            items.push(ConfirmItem::Skip {
                index: candidate.index,
            });
            continue;
        }
        if let Some((code, message)) = reject_reason(candidate) {
            items.push(ConfirmItem::Reject {
                index: candidate.index,
                code,
                message,
            });
            continue;
        }
        let digest = candidate.digest.trim().to_ascii_lowercase();
        let extension = normalize_ext(candidate.extension.trim()).expect("reject_reason checked");
        if seen
            .iter()
            .any(|(seen_digest, seen_ext)| seen_digest == &digest && seen_ext == extension)
        {
            items.push(ConfirmItem::Reject {
                index: candidate.index,
                code: "media_confirm_duplicate",
                message: "同一张切片不能确认两次",
            });
            continue;
        }
        seen.push((digest, extension.to_owned()));
        items.push(ConfirmItem::Admit {
            index: candidate.index,
        });
        batch.push(candidate.index);
    }
    ConfirmPlan { items, batch }
}

pub fn confirm_after_batch(status: u16, code: &str, outcome_unknown: bool) -> ConfirmAfterBatch {
    if matches!(
        code,
        "media_batch_mismatch"
            | "media_complete_missing"
            | "media_complete_mismatch"
            | "cloud_media_complete_missing"
    ) {
        return ConfirmAfterBatch::SplitOnes;
    }
    if outcome_unknown {
        return ConfirmAfterBatch::SplitOnes;
    }
    match status {
        401 | 403 | 409 | 429 | 503 => ConfirmAfterBatch::KeepBatch,
        _ => ConfirmAfterBatch::SplitOnes,
    }
}

/// An answer that arrived and failed the contract. Settled is the shipped
/// paid refusal; `unbilled_unknown` with an explicit `false` is a guarded
/// refusal whose hold was released (Cloud reports `false` only for its own
/// `ocr_contract_refused:*` class; a genuinely uncertain call stays `None`
/// and keeps pausing).
fn rejected_answer(status: &str, usable: Option<bool>) -> bool {
    usable == Some(false) && (status == "settled" || status == "unbilled_unknown")
}

pub fn plan_ocr(facts: &OcrFacts) -> OcrPlan {
    let display = if facts.has_display_text {
        OcrDisplay::ShowLocal
    } else {
        OcrDisplay::Server
    };
    if !facts.has_recovery {
        return OcrPlan {
            step: OcrStep::Wait,
            request_id: None,
            display,
        };
    }
    let retry_present = !facts.retry_status.is_empty() && facts.retry_status != "absent";
    let (status, usable, request_id) = if retry_present {
        (
            facts.retry_status.as_str(),
            facts.retry_usable,
            facts.retry_request_id.as_str(),
        )
    } else {
        (
            facts.original_status.as_str(),
            facts.original_usable,
            facts.original_request_id.as_str(),
        )
    };
    if status == "settled" && usable == Some(true) && !request_id.is_empty() {
        return OcrPlan {
            step: OcrStep::Settle,
            request_id: Some(request_id.to_owned()),
            display,
        };
    }
    let original_rejected = rejected_answer(&facts.original_status, facts.original_usable);
    if original_rejected && rejected_answer(&facts.retry_status, facts.retry_usable) {
        return OcrPlan {
            step: OcrStep::Unusable,
            request_id: None,
            display,
        };
    }
    if original_rejected && !retry_present {
        return OcrPlan {
            step: OcrStep::SimpleRetry,
            request_id: None,
            display,
        };
    }
    if status == "held" || status == "dispatching" {
        return OcrPlan {
            step: OcrStep::Wait,
            request_id: None,
            display,
        };
    }
    if status == "failed" || status == "unbilled_unknown" {
        return OcrPlan {
            step: OcrStep::Pause,
            request_id: None,
            display,
        };
    }
    if status.is_empty() || status == "absent" {
        return OcrPlan {
            step: OcrStep::PurchaseOriginal,
            request_id: None,
            display,
        };
    }
    OcrPlan {
        step: OcrStep::Wait,
        request_id: None,
        display,
    }
}

fn reject_reason(candidate: &ConfirmCandidate) -> Option<(&'static str, &'static str)> {
    let digest = candidate.digest.trim().to_ascii_lowercase();
    if !is_digest(&digest) {
        return Some(("media_confirm_digest", "切片摘要无效，未请求确认"));
    }
    let Some(extension) = normalize_ext(candidate.extension.trim()) else {
        return Some(("media_confirm_extension", "切片格式无效，未请求确认"));
    };
    if candidate.byte_length == 0 || candidate.byte_length > MAX_OBJECT_BYTES {
        return Some(("media_confirm_bytes", "切片字节数无效，未请求确认"));
    }
    if candidate.storage_revision < 0 {
        return Some(("media_confirm_revision", "存储版本无效，未请求确认"));
    }
    if candidate.upload_ticket.trim().is_empty() {
        return Some(("media_confirm_ticket", "缺少上传回执，未请求确认"));
    }
    if candidate.account_id.trim().is_empty() {
        return Some(("media_confirm_account", "缺少存储账号，未请求确认"));
    }
    let workspace = candidate.workspace_uuid.trim();
    if workspace.is_empty() || workspace.contains('/') {
        return Some(("media_confirm_workspace", "工作空间无效，未请求确认"));
    }
    let suffix = format!("{digest}.{extension}");
    let marker = format!("/teams/{workspace}/");
    if !candidate.object_key.ends_with(&suffix) || !candidate.object_key.contains(&marker) {
        return Some(("media_confirm_key", "对象键与切片不一致，未请求确认"));
    }
    None
}

fn normalize_ext(value: &str) -> Option<&'static str> {
    match value.to_ascii_lowercase().as_str() {
        "jpg" | "jpeg" => Some("jpg"),
        "png" => Some("png"),
        "mp4" => Some("mp4"),
        "mov" => Some("mov"),
        _ => None,
    }
}

fn is_digest(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
#[path = "stage_gate_tests.rs"]
mod tests;

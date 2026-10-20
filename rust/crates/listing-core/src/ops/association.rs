//! Same-design association: the fixed 货号 and the derived common 型号 an
//! opt-in 同源多规格 import gives its new rows, plus the model value
//! listing_rows.model_value projects.
//!
//! Pure: no I/O, no clock, no RNG. Cloud mints the row UUID *before* seeding
//! (write_new_row) and hands it here, so every value below is a deterministic
//! function of that UUID plus the request content — a retry, a page refresh or
//! an answer that arrived after a timeout re-derives the same identity instead
//! of minting a second one.
//!
//! Three identities, and the difference between them is the whole point:
//!
//! - 货号 = offer_id (+ its 9024 Seller code): the definite **instance**
//!   identity, fixed at creation as PH-<row_id> (spec slice 02 item 5).
//! - 型号 = plain attribute **9048**: the **design** identity, a short digest
//!   of Workspace + supplier database + non-empty variant group + source image
//!   SHA-256. It is shared by every size of one design and differs for a
//!   different design, so a bare variant group can never merge two designs.
//! - association_id: the batch key those member rows share, derived from the
//!   same canonical structure so every Card in one import derives the same one
//!   without a round trip (and a retry derives it again, not a new one).
//!
//! The canonical inputs are versioned together. Changing
//! ASSOCIATION_CANONICAL_VERSION, or the content fed to it, re-keys every
//! association: that is a migration decision, never a refactor.

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::envelope::RowPayload;
use crate::error::ListingError;
use crate::projections::{
    OZON_MODEL_NAME_ATTRIBUTE_ID, OZON_SELLER_CODE_ATTRIBUTE_ID, plain_attribute_field_key,
};
use crate::records::FieldAddress;
use crate::{CategorySchemaView, WorkflowCategoryDraft, WorkflowDraftValue};

/// The versioned canonical structure every association identity is derived
/// from: version NUL workspace NUL supplier database NUL variant group NUL
/// source image sha256.
const ASSOCIATION_CANONICAL_VERSION: &str = "podhub-listing-association-v1";

/// The versioned canonical structure a create request's fingerprint is derived
/// from — the create-key half of the idempotency contract.
const CREATE_FINGERPRINT_VERSION: &str = "podhub-listing-row-create-v1";

/// PH- + a minted row UUID: 39 characters, inside Ozon's 50-character
/// Seller-code limit, and unique by construction because the row UUID is.
pub const ASSOCIATED_OFFER_ID_PREFIX: &str = "PH-";

/// PHM- + 16 hex characters of the design digest: short enough for a model
/// name and wide enough that two designs in one Workspace do not collide.
pub const ASSOCIATED_MODEL_PREFIX: &str = "PHM-";
const MODEL_DIGEST_HEX_CHARS: usize = 16;

/// The first version's cap on one association's member closure (spec slice 02:
/// 首版关联闭包最多 100 个规格). The cross-card reads take it as their limit.
pub const ASSOCIATION_CLOSURE_MAX: usize = 100;

/// Refusals that belong to the opt-in association import alone. An ordinary
/// import keeps today's rules exactly and never reaches them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum AssociationRefusal {
    #[error("source.sha256 必须是 64 位十六进制摘要")]
    SourceDigestInvalid,
    #[error("同款关联需要非空的货源库编号与款号")]
    SourceIdentityEmpty,
    #[error("该类目没有可用的共同型号字段（plain 9048），暂不支持同款关联")]
    ModelFieldUnsupported,
}

/// One association's derived identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssociationIdentity {
    /// listing_rows.association_id: the batch key every member row shares.
    pub association_id: String,
    /// The common 型号 value (plain 9048) every member row carries.
    pub model_value: String,
}

/// Strict SHA-256: the opt-in path refuses a name or a short digest, because a
/// guessed source identity would silently merge two designs.
pub fn normalized_sha256(value: &str) -> Result<String, AssociationRefusal> {
    let trimmed = value.trim();
    let hex = trimmed.strip_prefix("sha256:").unwrap_or(trimmed);
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AssociationRefusal::SourceDigestInvalid);
    }
    Ok(hex.to_ascii_lowercase())
}

/// The canonical text one design's identity is derived from.
fn canonical_design_text(
    org_id: i64,
    supplier_source_id: &str,
    variant_group: &str,
    source_sha256: &str,
) -> Result<String, AssociationRefusal> {
    let source = supplier_source_id.trim();
    let group = variant_group.trim();
    // 空款号不自动关联: no variant group means there is no same-design claim to
    // record, so the opt-in request is refused rather than guessed.
    if source.is_empty() || group.is_empty() {
        return Err(AssociationRefusal::SourceIdentityEmpty);
    }
    let sha256 = normalized_sha256(source_sha256)?;
    Ok(format!(
        "{ASSOCIATION_CANONICAL_VERSION}\u{0}{org_id}\u{0}{source}\u{0}{group}\u{0}{sha256}"
    ))
}

/// Derive one design's association batch key and common 型号.
///
/// The Workspace is in the canonical text, so two Workspaces never share an
/// association even for the same supplier row; the source image digest is in
/// it, so one supplier variant group holding several designs does not merge.
pub fn association_identity(
    org_id: i64,
    supplier_source_id: &str,
    variant_group: &str,
    source_sha256: &str,
) -> Result<AssociationIdentity, AssociationRefusal> {
    let canonical =
        canonical_design_text(org_id, supplier_source_id, variant_group, source_sha256)?;
    Ok(AssociationIdentity {
        association_id: derived_uuid(&canonical, "association"),
        model_value: derived_model(&canonical),
    })
}

/// A name-derived UUID (RFC 4122 variant, version 8: this crate's own formula).
///
/// The bare uuid dependency has no v5 feature and this crate must not add one
/// (getrandom cannot build for wasm32-unknown-unknown), so the digest is folded
/// into the RFC-shaped bytes here instead.
fn derived_uuid(canonical: &str, purpose: &str) -> String {
    let digest = Sha256::digest(format!("{canonical}\u{0}{purpose}").as_bytes());
    let mut bytes = [0_u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn derived_model(canonical: &str) -> String {
    let digest = Sha256::digest(format!("{canonical}\u{0}model").as_bytes());
    let hex = format!("{digest:x}");
    format!(
        "{ASSOCIATED_MODEL_PREFIX}{}",
        &hex[..MODEL_DIGEST_HEX_CHARS]
    )
}

/// The fixed 货号 of a row created by the association import.
pub fn associated_offer_id(row_id: &str) -> String {
    format!("{ASSOCIATED_OFFER_ID_PREFIX}{row_id}")
}

/// Stamp 货号 (offer_id + its 9024 Seller code) and the common 型号 (9048) onto
/// a freshly seeded row.
///
/// A category with no plain 9048 — missing, or only inside a complex group —
/// cannot carry a common model, and this slice refuses it here instead of
/// inventing one (spec README: 没有该字段或只有未支持的复杂分组时，入口说明该类目暂不支持).
///
/// The stamped values carry no FieldValueOrigin: the draft origin vocabulary
/// has no "server pipeline" kind, and recording these as CardDefault or Manual
/// would be a lie. Their provenance is the build layer the source-identity
/// injection already uses (build::FieldLayer::SourceFile) plus
/// listing_rows.association_id. Any origin or hand_edited mark the caller's own
/// draft carried for these keys is dropped with the value it described.
pub fn stamp_association_identity(
    row: &mut RowPayload,
    schema: &CategorySchemaView,
    row_id: &str,
    identity: &AssociationIdentity,
) -> Result<(), AssociationRefusal> {
    let Some(model_key) = plain_attribute_field_key(schema, OZON_MODEL_NAME_ATTRIBUTE_ID) else {
        return Err(AssociationRefusal::ModelFieldUnsupported);
    };
    let seller_code_key = plain_attribute_field_key(schema, OZON_SELLER_CODE_ATTRIBUTE_ID);
    let offer_id = associated_offer_id(row_id);
    let mut stamped = vec![
        ("offer_id", offer_id.clone()),
        (model_key, identity.model_value.clone()),
    ];
    if let Some(key) = seller_code_key {
        stamped.push((key, offer_id));
    }
    for (key, value) in stamped {
        row.draft
            .values
            .insert(key.to_owned(), WorkflowDraftValue::Text(value));
        row.draft.cleared.remove(key);
        row.hand_edited_keys.remove(key);
    }
    row.field_origins.retain(|origin| match &origin.address {
        FieldAddress::Plain { field_key } => {
            field_key != "offer_id"
                && field_key != model_key
                && Some(field_key.as_str()) != seller_code_key
        }
        FieldAddress::Complex { .. } => true,
    });
    Ok(())
}

/// The value listing_rows.model_value projects: the Draft's plain 9048 text,
/// trimmed, empty when this Schema names no such field or the row's value is
/// not text (a complex-group model is not supported by this slice).
///
/// The projection is what the cross-card closure and the group guards query by
/// value; it is maintained in the same statement as the Draft write that can
/// change it, and it is never a second fact source.
pub fn model_value(schema: &CategorySchemaView, draft: &WorkflowCategoryDraft) -> String {
    let Some(key) = plain_attribute_field_key(schema, OZON_MODEL_NAME_ATTRIBUTE_ID) else {
        return String::new();
    };
    match draft.values.get(key) {
        Some(WorkflowDraftValue::Text(text) | WorkflowDraftValue::Url(text)) => {
            text.trim().to_owned()
        }
        _ => String::new(),
    }
}

/// Everything a create request's fingerprint is taken over. Every
/// client-controlled field that changes what gets created is here: leaving one
/// out would let "same key, different content" pass as a replay.
pub struct CreateRequestContent<'a> {
    pub card_id: &'a str,
    pub store_id: Option<&'a str>,
    pub source_sha256: &'a str,
    pub source_file_name: &'a str,
    pub association: Option<&'a AssociationIdentity>,
    pub draft: Option<&'a WorkflowCategoryDraft>,
    /// The client's own content fingerprint. It is *input*, never authority:
    /// it is folded into the digest the server stores, so a client that keeps
    /// its key but changes what it believes the content to be is refused too.
    pub client_fingerprint: &'a str,
}

/// sha256: + hex over the versioned canonical form of one create request.
///
/// Two requests with different JSON key order but the same parsed content
/// fingerprint identically (the Draft's maps are ordered), so a retry after a
/// serialization round trip is a replay and not a conflict.
pub fn create_request_fingerprint(
    content: &CreateRequestContent<'_>,
) -> Result<String, ListingError> {
    let (association_id, model_value) = content
        .association
        .map(|identity| {
            (
                identity.association_id.as_str(),
                identity.model_value.as_str(),
            )
        })
        .unwrap_or(("", ""));
    let draft = match content.draft {
        Some(draft) => serde_json::to_string(draft)
            .map_err(|error| ListingError::CloudSsot(format!("create draft encode: {error}")))?,
        None => String::new(),
    };
    let canonical = format!(
        "{CREATE_FINGERPRINT_VERSION}\u{0}{card_id}\u{0}{store}\u{0}{sha256}\u{0}{file}\u{0}{association_id}\u{0}{model_value}\u{0}{client}\u{0}{draft}",
        card_id = content.card_id,
        store = content.store_id.unwrap_or(""),
        sha256 = content.source_sha256,
        file = content.source_file_name,
        client = content.client_fingerprint,
    );
    Ok(format!("sha256:{:x}", Sha256::digest(canonical.as_bytes())))
}

#[cfg(test)]
mod tests;

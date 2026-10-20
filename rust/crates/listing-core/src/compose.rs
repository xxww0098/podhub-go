//! Freeze one row into the `/v3/product/import` body Ozon will see, and derive
//! the identities every dedupe downstream keys on.
//!
//! Three identities, and they are the whole contract:
//!
//! - `request_hash` = `sha256:` + hex(sha256(`serde_json::to_vec(request)`))
//! - `clientOperationId` = `workflow:{row_id}:{offer_id}:{digest}`
//! - batch id = `workflow-batch:{store_id}:{sha256(digests.join(","))}`
//!
//! Changing any of them makes an already-dispatched listing look new and risks
//! a second Ozon submit, so `compose_tests.rs` pins them against the shared
//! wire golden.

use sha2::{Digest, Sha256};

use crate::{
    MediaRole, WorkflowCategoryDraft, WorkflowDraftValue, WorkflowImageLifecycle,
    WorkflowImagePhase, WorkflowVideoMetadata, media_role_of,
};

use super::envelope::{CardPayload, RowPayload};
use super::error::ListingError;
use super::product_import::{
    ProductImportMedia, ProductImportRequest, ProductImportVideo, build_product_import_request,
};
use super::records::NormalizedListingSnapshot;
use super::validate::{DictionaryMaterials, FieldIssue, normalize_and_validate_with};

/// Ozon `/v3/product/import` accepts at most this many items per call.
pub const IMPORT_V3_MAX_ITEMS: usize = 100;

/// One row, frozen: the exact JSON body plus the identities it is deduped by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrozenImport {
    pub import: serde_json::Value,
    pub digest: String,
    pub offer_id: String,
    pub client_operation_id: String,
}

/// `sha256:` + hex(sha256(serde_json::to_vec)) over the exact serialized body.
pub fn request_hash(request: &ProductImportRequest) -> Result<String, ListingError> {
    let json = serde_json::to_vec(request).map_err(|error| {
        ListingError::CloudSsot(format!("encode product import request: {error}"))
    })?;
    Ok(format!("sha256:{:x}", Sha256::digest(json)))
}

/// Defend the final Seller body against invalid names before dispatch.
pub fn validate_product_name(name: &str) -> Result<(), ListingError> {
    if name.chars().count() > super::validate::PRODUCT_NAME_MAX_CHARS {
        return Err(ListingError::CloudSsot(format!(
            "商品名称不能超过 {} 个字符",
            super::validate::PRODUCT_NAME_MAX_CHARS
        )));
    }
    if super::validate::contains_han(name) {
        return Err(ListingError::CloudSsot(
            "商品名称不能包含中文字符".to_owned(),
        ));
    }
    Ok(())
}

/// Adopt verified supplier video metadata without changing rendered image evidence.
pub fn adopt_supplier_videos(row: &mut RowPayload, card: &CardPayload) -> bool {
    if row.supplier_product_id.is_none()
        || (row.media.videos == card.videos && row.media.video_cover == card.video_cover)
    {
        return false;
    }
    row.media.videos = card.videos.clone();
    row.media.video_cover = card.video_cover.clone();
    true
}

/// A built Draft that passed validation. Serialization reads this snapshot
/// and does not interpret the draft again.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidatedListing {
    pub snapshot: NormalizedListingSnapshot,
}

/// Built → Validated, or the Field Issues that keep the row a Draft.
pub fn validate_built(
    row: &RowPayload,
    draft: &WorkflowCategoryDraft,
    materials: &DictionaryMaterials,
) -> Result<ValidatedListing, Vec<FieldIssue>> {
    let record = super::bridge::listing_record_for_validation(row.schema_snapshot.clone(), draft);
    match normalize_and_validate_with(&record, materials) {
        super::validate::ValidationOutcome::Accepted { snapshot, .. } => {
            Ok(ValidatedListing { snapshot })
        }
        super::validate::ValidationOutcome::Rejected { issues } => Err(issues),
    }
}

pub fn serialize_validated(
    validated: &ValidatedListing,
    media: &ProductImportMedia,
) -> Result<ProductImportRequest, ListingError> {
    build_product_import_request(&validated.snapshot, media).map_err(ListingError::Serialize)
}

pub fn freeze_validated(
    row_id: &str,
    validated: &ValidatedListing,
    media: &ProductImportMedia,
) -> Result<FrozenImport, ListingError> {
    let request = serialize_validated(validated, media)?;
    let offer_id = request
        .items
        .first()
        .map(|item| item.offer_id.clone())
        .ok_or(ListingError::MissingNormalizedSnapshot)?;
    validate_product_name(&request.items[0].name)?;
    let import = serde_json::to_value(&request)
        .map_err(|error| ListingError::CloudSsot(format!("encode frozen import: {error}")))?;
    let digest = request_hash(&request)?;
    Ok(FrozenImport {
        client_operation_id: format!("workflow:{row_id}:{offer_id}:{digest}"),
        import,
        digest,
        offer_id,
    })
}

/// Freeze `row` for `card`: build, validate, freeze — the same three states
/// the send route walks, without persisting the verdict.
///
/// `row_id` is `listing_rows.id`: the payload does not carry it (Postgres owns
/// row identity) and the `clientOperationId` is keyed on it.
///
/// `test-support`, not plain `test`: Cloud's own `submit_reconcile_tests`
/// suite calls this cross-crate.
#[cfg(any(test, feature = "test-support"))]
pub fn compose_frozen_import(
    row_id: &str,
    row: &RowPayload,
    card: &CardPayload,
) -> Result<FrozenImport, ListingError> {
    let built = super::build::build_listing(row, card);
    let validated = validate_built(row, &built.draft, &DictionaryMaterials::default())
        .map_err(|_| ListingError::NotValidated)?;
    freeze_validated(row_id, &validated, &built.media)
}

/// Batch identity: one job per store per exact set of frozen bodies.
///
/// Joining ~72 B item digests overflowed the jobs btree (~2704 B) around 38
/// rows, so the set is hashed rather than listed.
pub fn batch_client_operation_id(store_id: &str, digests: &[String]) -> String {
    format!(
        "workflow-batch:{store_id}:{:x}",
        Sha256::digest(digests.join(",").as_bytes())
    )
}

/// Reject a batch the Seller endpoint could not accept before any of it is
/// dispatched.
pub fn check_batch_size(rows: usize) -> Result<(), ListingError> {
    if rows == 0 {
        return Err(ListingError::CloudSsot(
            "workflow publish batch requires at least one product item".to_owned(),
        ));
    }
    if rows > IMPORT_V3_MAX_ITEMS {
        return Err(ListingError::CloudSsot(format!(
            "workflow publish batch exceeds Seller limit of {IMPORT_V3_MAX_ITEMS}"
        )));
    }
    Ok(())
}

pub(super) fn media_slot_open(draft: &WorkflowCategoryDraft, key: &str) -> bool {
    !super::field_pack::occupies(draft.values.contains_key(key), draft.cleared.contains(key))
}

/// Compose the Seller media payload from delivered lifecycle media and any
/// operator-supplied manual URLs (which win over generated media).
pub fn lifecycle_media(
    images: &[WorkflowImageLifecycle],
    videos: &[WorkflowVideoMetadata],
    video_cover: Option<&WorkflowVideoMetadata>,
    draft: &WorkflowCategoryDraft,
) -> ProductImportMedia {
    let mut delivered = images
        .iter()
        .filter(|image| {
            image.phase == WorkflowImagePhase::PublicReady
                && image
                    .public_url
                    .as_deref()
                    .is_some_and(|url| !url.trim().is_empty())
        })
        .collect::<Vec<_>>();
    // Lifecycle persistence is not an ordering contract. The renderer index is:
    // index 0 => filename suffix `-1` => the generated primary image.
    delivered.sort_by_key(|image| image.index);
    // Every delivered slice is an ordinary product image; Ozon allows `images`
    // to overlap `images360`, so the 360° set is not subtracted here.
    let delivered_images = delivered
        .iter()
        .filter_map(|image| image.public_url.clone())
        .collect::<Vec<_>>();
    // Operator-supplied media wins, but a Workflow category DTO never carries
    // renderer-owned media, so without these lifecycle fallbacks the 360° set
    // and the color swatch would be dropped from every queue-composed payload.
    let delivered_role_urls = |role: MediaRole| {
        delivered
            .iter()
            .filter(|image| media_role_of(&image.group_name) == Some(role))
            .filter_map(|image| image.public_url.clone())
            .collect::<Vec<_>>()
    };
    let images = if media_slot_open(draft, "images") {
        delivered_images
    } else {
        draft_urls(draft, "images")
    };
    let primary_image = if media_slot_open(draft, "primary_image") {
        images.first().cloned().unwrap_or_default()
    } else {
        draft_url(draft, "primary_image").unwrap_or_default()
    };
    let images360 = if media_slot_open(draft, "images360") {
        delivered_role_urls(MediaRole::Images360)
    } else {
        draft_urls(draft, "images360")
    };
    let color_image = if media_slot_open(draft, "color_image") {
        delivered_role_urls(MediaRole::ColorImage)
            .into_iter()
            .next()
            .or_else(|| images.first().cloned())
    } else {
        draft_url(draft, "color_image")
    };
    ProductImportMedia {
        primary_image,
        color_image,
        color_present: draft.values.contains_key("color_image"),
        color_cleared: draft.cleared.contains("color_image"),
        images360,
        images,
        product_videos: videos
            .iter()
            .filter_map(|video| {
                video
                    .public_url
                    .clone()
                    .map(|public_url| ProductImportVideo {
                        title: video.file_name.clone(),
                        public_url,
                    })
            })
            .collect(),
        video_cover_url: video_cover.and_then(|video| video.public_url.clone()),
    }
}

fn draft_url(draft: &WorkflowCategoryDraft, key: &str) -> Option<String> {
    match draft.values.get(key) {
        Some(WorkflowDraftValue::Url(value)) | Some(WorkflowDraftValue::Text(value)) => {
            let value = value.trim();
            (!value.is_empty()).then(|| value.to_owned())
        }
        _ => None,
    }
}

fn draft_urls(draft: &WorkflowCategoryDraft, key: &str) -> Vec<String> {
    match draft.values.get(key) {
        Some(WorkflowDraftValue::UrlList(values)) | Some(WorkflowDraftValue::TextList(values)) => {
            values
                .iter()
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect()
        }
        Some(WorkflowDraftValue::Url(value)) | Some(WorkflowDraftValue::Text(value)) => {
            let value = value.trim();
            if value.is_empty() {
                Vec::new()
            } else {
                vec![value.to_owned()]
            }
        }
        _ => Vec::new(),
    }
}

// `test-support`: Cloud's own test suite builds golden fixtures from this
// module cross-crate (e.g. `kernel/supplier_projection.rs`'s tests), which a
// plain `#[cfg(test)]` cannot reach — that only compiles under
// `cargo test -p listing-core`, not when listing-core is a normal dependency
// of podhub-cloud's test binary.
#[cfg(any(test, feature = "test-support"))]
#[path = "compose_tests.rs"]
pub mod compose_tests;

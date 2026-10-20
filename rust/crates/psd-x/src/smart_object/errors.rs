/*
File: rust/crates/psd-x/src/smart_object/errors.rs

Purpose:
Error type for the psdx-owned smart-object replace API.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

//! Errors returned by [`crate::smart_object::replace_smart_object`].

use thiserror::Error;

/// Failure from smart-object targeting, validation, or replace.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SmartObjectError {
    /// No layer matched the target.
    #[error("no layer matched the smart-object target")]
    TargetNotFound,
    /// More than one layer matched a non-unique target (e.g. name).
    #[error("smart-object target is ambiguous ({count} matches)")]
    AmbiguousTarget { count: usize },
    /// The resolved layer has no `placedLayer`.
    #[error("resolved layer is not a smart object")]
    NotASmartObject,
    /// A GUID-shaped target (or linked-file id) failed format checks at the API boundary.
    #[error(
        "invalid GUID (expected lowercase hyphenated hex like \
         20953ddb-9391-11ec-b4f1-c15674f50bc4): {id}"
    )]
    InvalidGuid { id: String },
    /// Document colour mode is missing or not RGB (v1 limit).
    #[error("smart-object replace requires an RGB document")]
    NonRgbDocument,
    /// Linked-file payload was skipped on read (`ReadOptions::skip_linked_files_data`).
    /// Writing such a document would turn an embedded object into a broken alias.
    #[error(
        "linked-file data was skipped on read; refusing to replace \
         (write would corrupt the embedded object)"
    )]
    LinkedDataSkipped,
    /// Target points at an external (`lnkE` / `linkedFile`) record — unsupported in v1.
    #[error("replacing external linked files is not supported")]
    ExternalLinkNotSupported,
    /// The linked file is shared by multiple placed layers and scope is
    /// [`crate::smart_object::ReplaceScope::RequireExclusive`].
    #[error(
        "linked file is shared by {layer_count} placed layers; \
         set ReplaceScope::InPlace or ReplaceScope::ThisLayerOnly"
    )]
    SharedResource { layer_count: usize },
    /// Replacement size was not provided and could not be sniffed from the bytes.
    #[error(
        "could not determine replacement pixel size \
         (provide Replacement.size or use a sniffable format)"
    )]
    SizeUnknown,
    /// Current placed-layer width/height is missing or not a positive integer size.
    #[error("placed layer is missing a usable width/height")]
    CurrentSizeUnknown,
    /// `PlacedLayer.transform` (or similar) does not have exactly 8 floats.
    #[error("placed-layer frame must have exactly 8 floats (4 corners), got {length}")]
    InvalidFrame { length: usize },
    /// Linked-file list is missing the id referenced by the placed layer.
    #[error("no linked file with id {id}")]
    LinkedFileNotFound { id: String },
    /// [`crate::smart_object::PreviewPolicy::Provide`] buffer length or size is invalid.
    #[error(
        "preview RGBA buffer length {got} does not match width*height*4 \
         (expected {expected})"
    )]
    InvalidPreviewBuffer { expected: usize, got: usize },
    /// Failed while applying a preview policy (e.g. materializing `raw_data`).
    #[error("failed to apply preview policy: {0}")]
    PreviewApplyFailed(String),
    /// Warp bounds use modern Photoshop `classFloatRect`; v1 treats that warp as read-only.
    #[error(
        "warp bounds use classFloatRect (modern Photoshop document-space                  bounds); v1 treats this warp as read-only — use WarpPolicy::Keep                  or replace without changing size / without Reset"
    )]
    WarpFloatRectReadOnly,
    /// Non-identity warp whose bounds descriptor class was not preserved — refuse mutate.
    #[error(
        "non-identity warp has unknown bounds descriptor class;                  refusing to mutate warp (v1 cannot prove coordinate space)"
    )]
    WarpBoundsClassUnknown,
}

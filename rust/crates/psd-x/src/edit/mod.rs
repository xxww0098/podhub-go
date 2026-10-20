/*
File: rust/crates/psd-x/src/edit/mod.rs

Purpose:
psdx-owned document editing helpers with no upstream ag-psd counterpart.
Used by smart-object replace and text edit.

Source compatibility:
- no-upstream-counterpart
*/

//! Editing helpers that mutate an in-memory [`crate::psd::Psd`] / [`crate::psd::Layer`]
//! before a subsequent [`crate::write_psd`] call.
//!
//! These APIs are **psdx-owned** — they have no upstream TypeScript mirror.

pub mod layer_preview;

pub use layer_preview::{DropLayerPreviewError, drop_layer_preview};
pub(crate) use layer_preview::{
    PreparedLayerPreview, prepare_layer_preview_change, prepare_layer_preview_drop,
};

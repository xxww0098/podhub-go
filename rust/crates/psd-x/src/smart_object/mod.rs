/*
File: rust/crates/psd-x/src/smart_object/mod.rs

Purpose:
psdx-owned smart-object editing API. No upstream ag-psd counterpart —
quarterly upstream-diff audits should skip this module.

Source compatibility:
- psdx-owned; no-upstream-counterpart.
*/

//! Smart-object replace and discovery.
//!
//! These helpers mutate an in-memory [`crate::psd::Psd`] before a subsequent
//! [`crate::write_psd`] call. They do **not** change the serialization model,
//! the writer, or the additional-info key handlers.
//!
//! # Error contract
//!
//! If [`replace_smart_object`] returns [`Err`], the attempted replacement is
//! unapplied: the in-memory [`crate::psd::Psd`] is observably unchanged from
//! immediately before that call. Earlier successful edits remain intact.
//!
//! [`SmartObjectBatch`] extends that guarantee across multiple placements: if
//! any queued replacement fails, every earlier replacement from that batch is
//! rolled back with a sparse journal.
//!
//! This is an in-memory editing guarantee, not a filesystem transaction or an
//! undo/redo history. It does not cover callers that bypass this module and
//! directly mutate the low-level serialization model.
//!
//! **psdx does not re-rasterize** after replace. Layer preview handling is an
//! explicit [`PreviewPolicy`]; document composite and thumbnail are left in
//! place and always reported stale. Smart-object cache redraw on open is
//! **UNVERIFIED in Photoshop**.

mod batch;
mod errors;
mod frame;
mod guid;
mod replace;
mod target;
mod types;
mod warp;

pub use batch::{BatchError, BatchItem, BatchReport, BatchState, SmartObjectBatch};
pub use errors::SmartObjectError;
pub use frame::{FramePolicyResult, FrameQuad, apply_frame_policy, frame_quad_from_slice};
pub use guid::{check_guid, generate_linked_file_guid, is_guid};
pub use replace::replace_smart_object;
pub use target::{find_smart_objects, guid_associations_hold};
pub use types::{
    FramePolicy, LayerTarget, PreviewPolicy, ReplaceReport, ReplaceScope, Replacement,
    SmartObjectInfo, WarpPolicy,
};
pub use warp::{
    BOUNDS_CLASS_FLOAT_RECT, ensure_warp_mutable, identity_third_grid_points,
    is_identity_warp_mesh, warp_bounds_is_float_rect,
};

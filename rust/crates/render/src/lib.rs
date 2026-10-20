//! PSD template → product slice compute core.
//!
//! Bytes in, bytes out. No filesystem, threads or process; a host clock is used
//! only for diagnostics. The
//! same crate composites a listing's slices inside a browser Web Worker on
//! `wasm32-unknown-unknown`. Cloud does not execute render; the browser is the
//! only AI/media preparation executor. The `media.prepare` pin and the row
//! media writeback stay Cloud-owned.
//!
//! ```text
//! ParsedTemplate::parse(template_bytes, &policy)   // once per template
//!     └── render_product(&template, design, name, &intent, &policy)
//!             └── RenderOutcome { slices[JPEG bytes], manifest_json, .. }
//! ```

#![forbid(unsafe_code)]
// Every `RenderError` carries its own remediation sentence, which puts it at
// 144 bytes against clippy's 128-byte `Result` threshold. Boxing would put an
// allocation on paths that have already failed, and none of them is hot — an
// error here ends the render. A second, thinner error type for the inner loops
// would be two vocabularies for one failure.
#![allow(clippy::result_large_err)]

mod ai_image;
mod media;
mod psd;

pub use ai_image::prepare_ai_image;
pub use media::{
    ExportBounds, FitMode, MediaError as RenderError, MediaErrorCode as RenderErrorCode,
    ParsedTemplate, RenderIntent, RenderOutcome, RenderSlice, ResourceObservations, StaticGroups,
    render_product, take_stage_timings,
};
pub use psd::ProductResourcePolicy;

/// Supplies the browser monotonic clock used by wasm stage diagnostics.
#[cfg(target_family = "wasm")]
pub use media::set_stage_clock;

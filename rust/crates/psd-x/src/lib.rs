/*
File: rust/crates/psd-x/src/lib.rs

Purpose:
Root of the `psdx` crate (fork/continuation of the Rust port of the ag-psd TypeScript library).
Mirrors `index.ts`: declares all modules and gathers public re-exports.

Main responsibilities:
- declare `pub mod ...;` for each ported upstream file (1:1 split);
- gather the crate public API into a single entry point (like `index.ts`);
- be the only place that sets outward module visibility.

Source compatibility:
- mirror of ag-psd `src/index.ts` (upstream TypeScript layout).

PORT STATUS: reader/writer/model ported; optional composite/render features gated.
*/

//! # psdx
//!
//! Read and write Adobe Photoshop (`.psd` / `.psb`) files in pure Rust.
//!
//! This crate is a fork of the crates.io `ag-psd` 0.1.0 Rust port of the
//! [`ag-psd`](https://github.com/Agamnentzar/ag-psd) TypeScript library. The
//! data model mirrors the upstream structures, so anyone familiar with the JS
//! API will recognize [`psd::Psd`], [`psd::Layer`], [`psd::ReadOptions`] and
//! [`psd::WriteOptions`].
//!
//! ## Quick start
//!
//! ```no_run
//! use psdx::{read_psd, write_psd};
//! use psdx::psd::{ReadOptions, WriteOptions};
//!
//! // Read
//! let bytes = std::fs::read("input.psd").unwrap();
//! let psd = read_psd(&bytes, &ReadOptions::default()).unwrap();
//! println!("{}x{}, {} top-level layers", psd.width, psd.height,
//!          psd.children.as_ref().map_or(0, |c| c.len()));
//!
//! // Write
//! let out = write_psd(&psd, &WriteOptions::default()).unwrap();
//! std::fs::write("output.psd", out).unwrap();
//! ```
//!
//! The most important entry points are [`read_psd`] and [`write_psd`]; the
//! document/layer types live in the [`psd`] module. See the `README.md` and
//! crate README Credits and `LICENSE` for status and lineage.
//!
//! ## Lineage
//!
//! The 0.1.0 Rust port was written almost entirely by **Claude** (Anthropic).
//! This crate continues that work under the name `psdx`. See the README Credits
//! section for the full three-project relationship.

// dead_code is expected: not every ported symbol is wired into the public API.
#![forbid(unsafe_code)]

pub mod abr;
pub mod additional_info;
pub mod ase;
mod canvas;
/// Document/layer compositing (positioned RGBA; no image codecs).
#[cfg(feature = "composite")]
pub mod composite;
/// Explicit document-composite rebuild (uses `composite`; does not live in edit modules).
#[cfg(feature = "composite")]
pub mod composite_refresh;
pub mod csh;
pub mod descriptor;
pub mod descriptor_enums;
/// psdx-owned editing helpers (no upstream counterpart).
pub mod edit;
pub mod effects_helpers;
pub mod engine_data;
pub mod engine_data2;
/// Shared Photoshop-style GUID shape check (write path + editing API).
pub mod guid;
pub mod helpers;
pub mod image_resources;
pub mod image_sniff;
/// Placed-layer geometry + warp rasterization (no codecs, no compositor).
#[cfg(feature = "placed")]
pub mod placed;
pub mod psd;
pub mod reader;
/// Photoshop-style "Export As" adapter (encode + export policy).
#[cfg(feature = "render")]
pub mod render;
#[cfg(feature = "serde")]
mod serde_bytes;
#[cfg(feature = "serde")]
mod serde_bytes_opt;
/// psdx-owned smart-object editing API (no upstream counterpart).
pub mod smart_object;
/// Corpus resolution for the fixture-gated tests.
///
/// `cfg(test)` alone cannot work here: the integration tests under `tests/`
/// link the crate as an external dependency, so the module must be visible to
/// them — but only behind the `test-support` feature, so default builds and
/// production consumers stay free of test code. The crate's own unit tests
/// see it through `cfg(test)`.
#[cfg(any(test, feature = "test-support"))]
#[doc(hidden)]
pub mod test_corpus;
pub mod text;
/// psdx-owned text edit session (no upstream counterpart).
pub mod text_edit;
pub mod thumbnail;
pub mod utf8;
pub mod writer;

// Public re-exports (mirror of index.ts) are added as porting progresses,
// e.g. `pub use psd::*;`, `pub use abr::*;`, `pub use csh::*;`.
pub use abr::{Abr, Brush, BrushShape, ReadAbrOptions, SampleInfo, read_abr};
#[cfg(feature = "experimental-write")]
pub use ase::write_ase;
pub use ase::{Ase, AseColor, AseColorValue, AseEntry, AseGroup, read_ase};
#[cfg(feature = "composite")]
pub use composite_refresh::{CompositeRefresh, RefreshCompositeError, refresh_document_composite};
#[cfg(feature = "experimental-write")]
pub use csh::write_csh;
pub use csh::{Csh, CshShape, read_csh};
pub use edit::{DropLayerPreviewError, drop_layer_preview};
pub use engine_data::{EngineDataError, EngineValue, parse_engine_data, serialize_engine_data};
pub use engine_data2::decode_engine_data2;
pub use guid::is_guid;
pub use image_sniff::{Dpi, ImageFormat, ImageSniff, sniff_image};
pub use reader::{read_psd, read_psd_with_observations};
pub use smart_object::{
    BOUNDS_CLASS_FLOAT_RECT, FramePolicy, FramePolicyResult, FrameQuad, LayerTarget, PreviewPolicy,
    ReplaceReport, ReplaceScope, Replacement, SmartObjectError, SmartObjectInfo, WarpPolicy,
    apply_frame_policy, ensure_warp_mutable, find_smart_objects, frame_quad_from_slice,
    generate_linked_file_guid, identity_third_grid_points, is_identity_warp_mesh,
    replace_smart_object, warp_bounds_is_float_rect,
};
pub use text_edit::{
    ClearedTextGeometryField, FontResolution, RasterPolicy, TextEdit, TextEditError,
    TextEditReport, TextGeometryHonestyReport, TextLayer,
};
pub use writer::{WriteError, WriteResult, write_psd, write_psd_to_writer};

/// Degrade a requested export worker count when the host cannot spawn threads.
///
/// Call with `cfg!(target_family = "wasm")`. On native hosts this is a no-op.
#[doc(hidden)]
pub fn degrade_export_workers(requested: usize, is_wasm: bool) -> (usize, Option<String>) {
    if is_wasm && requested > 1 {
        (
            1,
            Some(format!(
                "fixed export concurrency {requested} is unavailable on WebAssembly; using 1 worker"
            )),
        )
    } else {
        (requested, None)
    }
}

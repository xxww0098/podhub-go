/*
File: rust/crates/psd-x/src/smart_object/types.rs

Purpose:
Public types for smart-object targeting, replacement options, and reports.
psdx-owned editing surface; no serialization-model fields.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.
*/

//! Inputs / outputs for [`crate::smart_object::replace_smart_object`] and
//! [`crate::smart_object::find_smart_objects`].

/// How to locate one or more smart-object layers in the document tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LayerTarget {
    /// Index path from the document root (`children[path[0]].children[path[1]]…`).
    /// An empty path means “search the whole document” for [`super::find_smart_objects`].
    Path(Vec<usize>),
    /// Layer id (`LayerAdditionalInfo.id`).
    LayerId(u32),
    /// Placed-layer instance GUID (`PlacedLayer.placed`).
    PlacedId(String),
    /// Linked-file GUID (`PlacedLayer.id` / `LinkedFile.id`).
    LinkedId(String),
    /// Layer name (`LayerAdditionalInfo.name`). Ambiguous when not unique.
    Name(String),
}

/// What to do with the placed-layer frame when pixel size changes.
///
/// The frame is four corners in document pixel space. Basis vectors `e_x` /
/// `e_y` run from the first corner to the second and fourth corners (valid
/// under rotation and shear).
///
/// Same-size replace leaves geometry untouched for every policy except
/// [`FramePolicy::Exact`], which always applies the supplied corners.
///
/// Changing the frame does **not** re-rasterize the layer: frame corners and
/// layer rect / preview pixels are independent and may diverge.
#[derive(Debug, Clone, PartialEq)]
pub enum FramePolicy {
    /// Keep content scale; grow/shrink the frame with pixel count, anchoring
    /// the first corner (default). Same-size is a geometry byte no-op.
    KeepScale,
    /// Keep the frame; stretch content to fill. Aspect-ratio changes set
    /// [`ReplaceReport::content_stretched`].
    KeepFrame,
    /// Uniform scale so the new content fits inside the original frame.
    FitInFrame,
    /// Caller-supplied four corners as `[x0,y0, x1,y1, x2,y2, x3,y3]`.
    Exact([f64; 8]),
}

impl Default for FramePolicy {
    fn default() -> Self {
        Self::KeepScale
    }
}

/// Warp handling for smart-object replace.
///
/// Warp mesh coordinates are in linked-image space, so a size change invalidates
/// the domain. v1 does **not** rescale meshes.
///
/// # Reset is not a byte no-op
///
/// [`WarpPolicy::Reset`] clears `PlacedLayer.warp`; the writer then synthesises a
/// fresh identity third-grid. Even when the source mesh was already identity,
/// re-synthesis changes trailing float bits and descriptor layout — a corpus
/// fixture grew by ~808 bytes after clear. Callers that need byte-stable output
/// must use [`WarpPolicy::Keep`] (or same-size [`WarpPolicy::Auto`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum WarpPolicy {
    /// Keep when size unchanged; reset when size changes (default).
    #[default]
    Auto,
    /// Clear warp; writer synthesises identity (not a byte no-op).
    Reset,
    /// Leave warp bytes alone (caller accepts risk).
    Keep,
}

/// Layer raster preview handling after content replace.
///
/// **psdx does not re-rasterize** smart-object content. Smart-object cache
/// redraw on open is **UNVERIFIED in Photoshop**.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum PreviewPolicy {
    /// Keep existing layer pixels and bounds byte-for-byte; report stale (default).
    ///
    /// The only option that does not destroy preview information — yields a
    /// self-consistent file plus an outdated layer cache.
    #[default]
    Leave,
    /// Install a fully transparent raster at the layer's real bounds via
    /// [`crate::drop_layer_preview`] (never collapses to a zero-size rect).
    Drop,
    /// Caller-provided RGBA8 preview (`width * height * 4` bytes).
    ///
    /// Layer `right`/`bottom` are set so the rect size matches `width`×`height`
    /// (anchored at current `left`/`top`). Still reported stale: the library
    /// cannot verify the buffer matches the new embedded content.
    Provide {
        width: u32,
        height: u32,
        rgba: Vec<u8>,
    },
}

/// Whether a shared linked file may be mutated in place or forked.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ReplaceScope {
    /// Refuse if more than one placed layer references the linked file (default).
    #[default]
    RequireExclusive,
    /// Patch the shared linked-file record in place; every placement that
    /// references it sees the new content. Linked-file GUIDs stay unchanged.
    InPlace,
    /// Fork a new linked-file record + GUID for the target layer only; other
    /// placements keep the old record byte-identical.
    ThisLayerOnly,
}

/// Replacement payload and policy knobs (all policies default to same-size-safe values).
#[derive(Debug, Clone)]
pub struct Replacement<'a> {
    /// New embedded file bytes.
    pub data: &'a [u8],
    /// Linked-file display name (Layers panel / linked-files list).
    pub name: String,
    /// Pixel size; `None` → sniff via [`crate::image_sniff::sniff_image`].
    pub size: Option<(u32, u32)>,
    /// File-type tag policy:
    /// - `None` — keep the existing tag (or leave absent);
    /// - `Some(None)` — force absent;
    /// - `Some(Some(tag))` — set tag (stored as trimmed model string; writer pads to 4 bytes).
    pub file_type: Option<Option<String>>,
    /// Optional resolution (Density) to write onto the placed layer; `None` keeps current.
    pub resolution: Option<f64>,
    pub frame: FramePolicy,
    pub warp: WarpPolicy,
    pub preview: PreviewPolicy,
    pub scope: ReplaceScope,
}

impl<'a> Replacement<'a> {
    /// Same-size-safe defaults: keep scale / auto warp / leave preview / require exclusive.
    pub fn new(data: &'a [u8], name: impl Into<String>) -> Self {
        Self {
            data,
            name: name.into(),
            size: None,
            file_type: None,
            resolution: None,
            frame: FramePolicy::default(),
            warp: WarpPolicy::default(),
            preview: PreviewPolicy::default(),
            scope: ReplaceScope::default(),
        }
    }
}

/// Read-only description of a smart-object placement.
#[derive(Debug, Clone, PartialEq)]
pub struct SmartObjectInfo {
    pub path: Vec<usize>,
    pub layer_name: Option<String>,
    pub layer_id: Option<u32>,
    /// Instance GUID (`PlacedLayer.placed`), when present.
    pub placed_id: Option<String>,
    /// Linked-file GUID (`PlacedLayer.id`).
    pub linked_id: String,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub file_name: Option<String>,
    /// `true` when more than one placed layer references `linked_id`.
    pub shared: bool,
    pub has_embedded_data: bool,
    pub is_external: bool,
}

/// Outcome of a successful [`crate::smart_object::replace_smart_object`].
///
/// After replace, derived rasters are stale because **psdx does not
/// re-rasterize**. The three `*_stale` flags are always `true` on success —
/// including under [`PreviewPolicy::Provide`] (caller pixels are not verified
/// against the embedded payload). Document composite and thumbnail are never
/// cleared by replace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaceReport {
    pub path: Vec<usize>,
    pub linked_id: String,
    pub old_size: (u32, u32),
    pub new_size: (u32, u32),
    /// Set when content will be stretched to a frame of a different aspect ratio.
    pub content_stretched: bool,
    /// Layer raster preview is not known to match the new embedded content.
    pub preview_stale: bool,
    /// Document composite (`Psd::image_data` / `canvas`) was not regenerated.
    pub composite_stale: bool,
    /// Document thumbnail (`ImageResources::thumbnail`) was not regenerated.
    pub thumbnail_stale: bool,
}

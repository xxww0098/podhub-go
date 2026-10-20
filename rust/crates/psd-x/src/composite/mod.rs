//! Document and layer compositing — produce positioned RGBA pixels without encoding.
//!
//! This module is **not** a Photoshop-equivalent renderer. It evaluates z-order, clipping
//! groups, layer masks, opacity, and a subset of blend modes against cached rasters. It does
//! not evaluate layer effects, adjustment layers, vector fills/strokes, fonts, or color
//! management. Gaps are reported as typed [`CompositeWarning`] values on the result.
//!
//! The compositor is single-threaded by construction (no `std::thread`), allocates only from
//! the PSD model and standard collections, and links no image codecs. It builds and runs on
//! `wasm32-unknown-unknown` the same as on native hosts; output does not vary with host
//! parallelism. Isolated groups stay in the float backdrop — they are not quantized to RGBA8
//! and converted back before the parent blend. Encoding, crop/scale export policy, and
//! optional parallel workers live in [`crate::render`] (feature `render`).

mod blend;
mod engine;
mod features;
mod raster;
pub(crate) mod report;

use thiserror::Error;

use crate::psd::{Layer, PixelData, Psd};

pub use raster::{PixelRect, PositionedRaster};
pub use report::{
    CompositeFidelity, CompositeWarning, CompositeWarningReport, MaskIgnoredReason,
    UnrenderedFeature, fidelity,
};

/// What to composite.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositeTarget<'a> {
    /// All top-level children, bottom-up — a whole-document flatten.
    Document,
    /// Child-index path from the document root. Any layer, any depth.
    ///
    /// An empty path is **not** a document flatten; it is an error.
    Layer(&'a [usize]),
}

/// Which document rows to allocate and fill.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CompositeRegion {
    Full,
    /// Half-open row range in document coordinates; clamped to the canvas.
    Rows {
        top: i32,
        bottom: i32,
    },
}

/// A single compositing query.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompositeRequest<'a> {
    pub target: CompositeTarget<'a>,
    pub region: CompositeRegion,
    /// Cap on compositor allocation: canvas width × region height (in pixels).
    pub max_pixels: u64,
}

/// Positioned RGBA result plus a typed, deduplicated fidelity report.
#[derive(Debug, Clone)]
pub struct CompositeResult {
    pub raster: PositionedRaster,
    pub warnings: Vec<CompositeWarningReport>,
}

/// Failures that prevent producing a raster.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum CompositeError {
    #[error("invalid PSD canvas dimensions: {width}x{height}")]
    InvalidCanvas { width: f64, height: f64 },
    #[error("composite target not found at path {0:?}")]
    TargetNotFound(Vec<usize>),
    #[error("composite region is empty after clamping")]
    EmptyRegion,
    #[error("composite region is {pixels} pixels; max allowed is {max}")]
    RegionTooLarge { pixels: u64, max: u64 },
}

impl CompositeRequest<'_> {
    /// Estimated peak bytes the compositor may allocate for this request
    /// (float backdrop + RGBA band; intentionally overestimates).
    pub fn estimated_peak_bytes(&self, psd: &Psd) -> Result<u64, CompositeError> {
        let (width, height) = resolved_region_size(psd, &self.region)?;
        Ok((width as u64)
            .saturating_mul(height as u64)
            .saturating_mul(20))
    }
}

/// Composite `request.target` over `request.region` into a positioned RGBA raster.
///
/// A fully transparent result is success (`content_bounds()` is `None`).
pub fn composite(
    psd: &Psd,
    request: &CompositeRequest<'_>,
) -> Result<CompositeResult, CompositeError> {
    let (width, top, bottom) = resolve_canvas_and_region(psd, &request.region)?;
    let height = (bottom - top) as u32;
    let pixels = width as u64 * height as u64;
    if pixels > request.max_pixels {
        return Err(CompositeError::RegionTooLarge {
            pixels,
            max: request.max_pixels,
        });
    }

    let viewport = engine::Viewport { top, bottom };
    let (backdrop, warnings) = match &request.target {
        CompositeTarget::Document => engine::composite_layers(
            psd,
            psd.children.as_deref().unwrap_or_default(),
            viewport,
            Vec::new(),
            false,
        ),
        CompositeTarget::Layer(path) => {
            let layer = resolve_layer(psd, path)?;
            engine::composite_layers(
                psd,
                std::slice::from_ref(layer),
                viewport,
                path.to_vec(),
                true,
            )
        }
    };

    let rgba = backdrop.to_rgba8();
    Ok(CompositeResult {
        raster: PositionedRaster {
            left: 0,
            top,
            pixels: PixelData::rgba8(width, height, rgba),
        },
        warnings,
    })
}

fn canvas_size(psd: &Psd) -> Result<(u32, i32), CompositeError> {
    if !psd.width.is_finite()
        || !psd.height.is_finite()
        || psd.width <= 0.0
        || psd.height <= 0.0
        || psd.width > u32::MAX as f64
        || psd.height > u32::MAX as f64
    {
        return Err(CompositeError::InvalidCanvas {
            width: psd.width,
            height: psd.height,
        });
    }
    Ok((psd.width as u32, psd.height as i32))
}

fn resolve_canvas_and_region(
    psd: &Psd,
    region: &CompositeRegion,
) -> Result<(u32, i32, i32), CompositeError> {
    let (width, canvas_height) = canvas_size(psd)?;
    let (top, bottom) = match *region {
        CompositeRegion::Full => (0, canvas_height),
        CompositeRegion::Rows { top, bottom } => (top, bottom),
    };
    let top = top.clamp(0, canvas_height);
    let bottom = bottom.clamp(0, canvas_height);
    if bottom <= top {
        return Err(CompositeError::EmptyRegion);
    }
    Ok((width, top, bottom))
}

fn resolved_region_size(psd: &Psd, region: &CompositeRegion) -> Result<(u32, u32), CompositeError> {
    let (width, top, bottom) = resolve_canvas_and_region(psd, region)?;
    Ok((width, (bottom - top) as u32))
}

fn resolve_layer<'a>(psd: &'a Psd, path: &[usize]) -> Result<&'a Layer, CompositeError> {
    if path.is_empty() {
        return Err(CompositeError::TargetNotFound(Vec::new()));
    }
    let mut layers = psd.children.as_deref().unwrap_or_default();
    let mut current: Option<&Layer> = None;
    for (depth, &index) in path.iter().enumerate() {
        let Some(layer) = layers.get(index) else {
            return Err(CompositeError::TargetNotFound(path[..=depth].to_vec()));
        };
        current = Some(layer);
        if depth + 1 < path.len() {
            layers = layer.children.as_deref().unwrap_or_default();
        }
    }
    Ok(current.expect("non-empty path yields a layer"))
}

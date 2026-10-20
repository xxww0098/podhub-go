//! Placed-layer geometry projection and bounded warp rasterization.
//!
//! No image codecs and no document compositor. Callers supply replacement
//! pixels and consume positioned RGBA.

use crate::psd::{PlacedLayer, Warp};
use std::borrow::Cow;
use std::mem::size_of;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlacedRenderErrorKind {
    InvalidBitmap,
    InvalidGeometry,
    ExtentLimit,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct PlacedRenderError {
    pub kind: PlacedRenderErrorKind,
    message: String,
}

impl PlacedRenderError {
    fn new(kind: PlacedRenderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Bitmap {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelSource {
    pub data: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub left: i64,
    pub top: i64,
}

/// The allocation peak of one placed-layer rasterization, excluding the
/// caller-owned source bitmap. It lets callers refuse an optional full-view
/// cache before asking the rasterizer to allocate it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlacedRenderFootprint {
    pub output_bytes: u64,
    pub peak_bytes: u64,
}

#[derive(Debug, Clone, Copy)]
struct PlacedOutputBounds {
    left: i64,
    top: i64,
    width: u32,
    height: u32,
}

#[derive(Debug, Clone)]
pub struct MeshGrid {
    pub cols: usize,
    pub rows: usize,
    pub xs: Vec<f64>,
    pub ys: Vec<f64>,
    pub slices_x: Vec<f64>,
    pub slices_y: Vec<f64>,
}

#[derive(Debug, Clone)]
pub struct PlacedGeom {
    pub src_w: f64,
    pub src_h: f64,
    pub quad: Vec<f64>,
    pub mesh: Option<MeshGrid>,
}

impl PlacedGeom {
    /// Project Photoshop placed-layer geometry into the source-pixel domain
    /// consumed by the rasterizer.
    pub fn from_placed(placed: &PlacedLayer) -> Self {
        let src_w = placed.width.unwrap_or_default();
        let src_h = placed.height.unwrap_or_default();
        let quad = placed
            .non_affine_transform
            .clone()
            .filter(|value| value.len() == 8)
            .unwrap_or_else(|| placed.transform.clone());
        Self {
            src_w,
            src_h,
            quad,
            mesh: placed
                .warp
                .as_ref()
                .and_then(|warp| mesh_from_warp(warp, src_w, src_h)),
        }
    }
}

fn mesh_from_warp(warp: &Warp, src_w: f64, src_h: f64) -> Option<MeshGrid> {
    let envelope = warp.custom_envelope_warp.as_ref()?;
    let points = &envelope.mesh_points;
    if points.len() < 16 {
        return None;
    }
    let point_span_x = points
        .iter()
        .map(|point| point.x)
        .fold(f64::NEG_INFINITY, f64::max)
        - points
            .iter()
            .map(|point| point.x)
            .fold(f64::INFINITY, f64::min);
    let cols = detect_cols(points, point_span_x);
    let rows = points.len() / cols;
    if cols < 4 || rows < 4 || cols * rows != points.len() {
        return None;
    }
    let patches_x = (cols - 1) / 3;
    let patches_y = (rows - 1) / 3;
    Some(MeshGrid {
        cols,
        rows,
        xs: points.iter().map(|point| point.x).collect(),
        ys: points.iter().map(|point| point.y).collect(),
        // Photoshop may store quilt breakpoints in an absolute document-space
        // domain while the replacement sampler consumes source pixels. Only
        // their relative spacing is semantic here, so normalize both axes to
        // the placed layer's own pixel dimensions.
        slices_x: source_domain_slices(envelope.quilt_slice_x.as_deref(), patches_x, src_w),
        slices_y: source_domain_slices(envelope.quilt_slice_y.as_deref(), patches_y, src_h),
    })
}

fn source_domain_slices(raw: Option<&[f64]>, patches: usize, source_size: f64) -> Vec<f64> {
    if patches == 0 {
        return vec![0.0];
    }
    let uniform = || {
        (0..=patches)
            .map(|index| index as f64 * source_size / patches as f64)
            .collect()
    };
    let Some(raw) = raw.filter(|values| values.len() == patches + 1) else {
        return uniform();
    };
    let Some((&first, &last)) = raw.first().zip(raw.last()) else {
        return uniform();
    };
    let span = last - first;
    if !source_size.is_finite()
        || source_size <= 0.0
        || !span.is_finite()
        || span <= 0.0
        || !raw
            .windows(2)
            .all(|pair| pair[0].is_finite() && pair[1].is_finite() && pair[0] < pair[1])
    {
        return uniform();
    }
    raw.iter()
        .map(|value| (value - first) / span * source_size)
        .collect()
}

fn detect_cols(points: &[crate::psd::PointF], source_span: f64) -> usize {
    for index in 1..points.len() {
        if points[index].x < points[index - 1].x - source_span / 2.0 {
            return index;
        }
    }
    points.len()
}

const BYTE_TO_UNIT: [f64; 256] = {
    let mut table = [0.0; 256];
    let mut index = 0;
    while index < 256 {
        table[index] = index as f64 / 255.0;
        index += 1;
    }
    table
};

pub fn render_placed(
    source: &Bitmap,
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
    viewport_top: i64,
    viewport_bottom: i64,
) -> Result<Option<PixelSource>, PlacedRenderError> {
    validate_bitmap(source)?;
    preflight_geometry(geom, doc_w, doc_h)?;
    let Some(bounds) = placed_output_bounds(geom, doc_w, doc_h, viewport_top, viewport_bottom)
    else {
        return Ok(None);
    };
    if geom.mesh.is_some() {
        render_mesh_forward(source, geom, bounds)
    } else {
        render_no_mesh(source, geom, bounds)
    }
}

/// Returns the allocation peak for the same raster call as [`render_placed`].
/// The source is caller-owned and intentionally excluded: a shared replacement
/// is charged by the document scheduler, while this value prices only bytes
/// created by the rasterizer itself.
pub fn placed_render_footprint(
    source: &Bitmap,
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
    viewport_top: i64,
    viewport_bottom: i64,
) -> Result<Option<PlacedRenderFootprint>, PlacedRenderError> {
    validate_bitmap(source)?;
    preflight_geometry(geom, doc_w, doc_h)?;
    let Some(bounds) = placed_output_bounds(geom, doc_w, doc_h, viewport_top, viewport_bottom)
    else {
        return Ok(None);
    };
    let output_bytes = raster_byte_len(bounds.width, bounds.height)?;
    let mut peak_bytes = output_bytes.saturating_add(prefilter_workspace_bytes(source, geom)?);
    if geom.mesh.is_some() {
        let pixels = pixel_len(bounds.width, bounds.height)?;
        let grid_len = mesh_grid_len(geom)?;
        let mesh_bytes = u64::try_from(grid_len)
            .ok()
            .and_then(|len| len.checked_mul((size_of::<f64>() * 2) as u64))
            .and_then(|bytes| bytes.checked_add(u64::try_from(pixels).ok()?))
            .ok_or_else(|| {
                PlacedRenderError::new(
                    PlacedRenderErrorKind::ExtentLimit,
                    "mesh raster workspace exceeds addressable memory",
                )
            })?;
        peak_bytes = peak_bytes.checked_add(mesh_bytes).ok_or_else(|| {
            PlacedRenderError::new(
                PlacedRenderErrorKind::ExtentLimit,
                "placed raster workspace exceeds addressable memory",
            )
        })?;
    }
    Ok(Some(PlacedRenderFootprint {
        output_bytes,
        peak_bytes,
    }))
}

fn validate_bitmap(source: &Bitmap) -> Result<(), PlacedRenderError> {
    let expected_len = usize::try_from(source.width)
        .ok()
        .and_then(|width| {
            usize::try_from(source.height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .and_then(|pixels| pixels.checked_mul(4));
    if source.width == 0 || source.height == 0 || expected_len != Some(source.data.len()) {
        return Err(PlacedRenderError::new(
            PlacedRenderErrorKind::InvalidBitmap,
            "replacement bitmap dimensions do not match its RGBA buffer",
        ));
    }
    Ok(())
}

fn placed_output_bounds(
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
    viewport_top: i64,
    viewport_bottom: i64,
) -> Option<PlacedOutputBounds> {
    let viewport_top = viewport_top.clamp(0, i64::from(doc_h));
    let viewport_bottom = viewport_bottom.clamp(viewport_top, i64::from(doc_h));
    let min_x = geom
        .quad
        .iter()
        .step_by(2)
        .copied()
        .fold(f64::INFINITY, f64::min);
    let max_x = geom
        .quad
        .iter()
        .step_by(2)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = geom
        .quad
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .fold(f64::INFINITY, f64::min);
    let max_y = geom
        .quad
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let left = 0_i64.max((min_x.floor() as i64) - 1);
    let top = viewport_top.max((min_y.floor() as i64) - 1);
    let right = i64::from(doc_w).min((max_x.ceil() as i64) + 1);
    let bottom = viewport_bottom
        .min(i64::from(doc_h))
        .min((max_y.ceil() as i64) + 1);
    if right <= left || bottom <= top {
        return None;
    }
    Some(PlacedOutputBounds {
        left,
        top,
        width: u32::try_from(right - left).ok()?,
        height: u32::try_from(bottom - top).ok()?,
    })
}

fn pixel_len(width: u32, height: u32) -> Result<usize, PlacedRenderError> {
    usize::try_from(width)
        .ok()
        .and_then(|width| {
            usize::try_from(height)
                .ok()
                .and_then(|height| width.checked_mul(height))
        })
        .ok_or_else(|| {
            PlacedRenderError::new(
                PlacedRenderErrorKind::ExtentLimit,
                "placed raster exceeds addressable memory",
            )
        })
}

fn raster_byte_len(width: u32, height: u32) -> Result<u64, PlacedRenderError> {
    let pixels = u64::try_from(pixel_len(width, height)?).map_err(|_| {
        PlacedRenderError::new(
            PlacedRenderErrorKind::ExtentLimit,
            "placed raster exceeds addressable memory",
        )
    })?;
    pixels.checked_mul(4).ok_or_else(|| {
        PlacedRenderError::new(
            PlacedRenderErrorKind::ExtentLimit,
            "placed raster exceeds addressable memory",
        )
    })
}

fn allocation_len(width: u32, height: u32) -> Result<usize, PlacedRenderError> {
    pixel_len(width, height).and_then(|pixels| {
        pixels.checked_mul(4).ok_or_else(|| {
            PlacedRenderError::new(
                PlacedRenderErrorKind::ExtentLimit,
                "placed raster exceeds addressable memory",
            )
        })
    })
}

fn mesh_grid_len(geom: &PlacedGeom) -> Result<usize, PlacedRenderError> {
    let min_x = geom
        .quad
        .iter()
        .step_by(2)
        .copied()
        .fold(f64::INFINITY, f64::min);
    let max_x = geom
        .quad
        .iter()
        .step_by(2)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = geom
        .quad
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .fold(f64::INFINITY, f64::min);
    let max_y = geom
        .quad
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let cells_x = (((max_x - min_x).max(1.0) / 1.3).ceil() as usize).clamp(16, 2048);
    let cells_y = (((max_y - min_y).max(1.0) / 1.3).ceil() as usize).clamp(16, 2048);
    (cells_x + 1).checked_mul(cells_y + 1).ok_or_else(|| {
        PlacedRenderError::new(
            PlacedRenderErrorKind::ExtentLimit,
            "mesh raster grid exceeds addressable memory",
        )
    })
}

/// Validates every dependency needed by a placed-layer transform before any
/// replacement bitmap or slab buffer is allocated.
pub fn preflight_geometry(
    geom: &PlacedGeom,
    doc_w: u32,
    doc_h: u32,
) -> Result<(), PlacedRenderError> {
    if geom.quad.len() != 8
        || !geom.quad.iter().all(|value| value.is_finite())
        || !geom.src_w.is_finite()
        || !geom.src_h.is_finite()
        || geom.src_w <= 0.0
        || geom.src_h <= 0.0
    {
        return Err(PlacedRenderError::new(
            PlacedRenderErrorKind::InvalidGeometry,
            "placed-layer geometry is incomplete or non-finite",
        ));
    }

    let xs = geom.quad.iter().step_by(2).copied();
    let ys = geom.quad.iter().skip(1).step_by(2).copied();
    let min_x = xs.clone().fold(f64::INFINITY, f64::min);
    let max_x = xs.fold(f64::NEG_INFINITY, f64::max);
    let min_y = ys.clone().fold(f64::INFINITY, f64::min);
    let max_y = ys.fold(f64::NEG_INFINITY, f64::max);
    let x_budget = f64::from(doc_w.max(1)) * 8.0;
    let y_budget = f64::from(doc_h.max(1)) * 8.0;
    if max_x - min_x > x_budget
        || max_y - min_y > y_budget
        || min_x < -x_budget
        || max_x > f64::from(doc_w) + x_budget
        || min_y < -y_budget
        || max_y > f64::from(doc_h) + y_budget
    {
        return Err(PlacedRenderError::new(
            PlacedRenderErrorKind::ExtentLimit,
            "placed-layer transformed extent exceeds the bounded document dependency envelope",
        ));
    }

    let area_twice = geom
        .quad
        .chunks_exact(2)
        .zip(geom.quad.chunks_exact(2).cycle().skip(1))
        .take(4)
        .map(|(current, next)| current[0] * next[1] - next[0] * current[1])
        .sum::<f64>()
        .abs();
    if area_twice <= f64::EPSILON {
        return Err(PlacedRenderError::new(
            PlacedRenderErrorKind::InvalidGeometry,
            "placed-layer transform is singular",
        ));
    }

    if let Some(mesh) = &geom.mesh {
        preflight_mesh(mesh)?;
    }
    Ok(())
}

fn preflight_mesh(mesh: &MeshGrid) -> Result<(), PlacedRenderError> {
    let point_count = mesh.cols.checked_mul(mesh.rows);
    let patches_x = mesh.cols.checked_sub(1).map(|value| value / 3);
    let patches_y = mesh.rows.checked_sub(1).map(|value| value / 3);
    let slices_are_strict = |slices: &[f64]| {
        slices
            .windows(2)
            .all(|pair| pair[0].is_finite() && pair[1].is_finite() && pair[0] < pair[1])
    };
    if mesh.cols < 4
        || mesh.rows < 4
        || point_count != Some(mesh.xs.len())
        || mesh.xs.len() != mesh.ys.len()
        || patches_x.and_then(|value| value.checked_add(1)) != Some(mesh.slices_x.len())
        || patches_y.and_then(|value| value.checked_add(1)) != Some(mesh.slices_y.len())
        || !mesh.xs.iter().all(|value| value.is_finite())
        || !mesh.ys.iter().all(|value| value.is_finite())
        || !slices_are_strict(&mesh.slices_x)
        || !slices_are_strict(&mesh.slices_y)
    {
        return Err(PlacedRenderError::new(
            PlacedRenderErrorKind::InvalidGeometry,
            "placed-layer mesh geometry is malformed or non-finite",
        ));
    }
    Ok(())
}

struct Homography {
    a: f64,
    b: f64,
    c: f64,
    d: f64,
    e: f64,
    f: f64,
    g: f64,
    h: f64,
}

fn square_to_quad(quad: &[f64]) -> Homography {
    let x0 = quad[0];
    let y0 = quad[1];
    let x1 = quad[2];
    let y1 = quad[3];
    let x2 = quad[4];
    let y2 = quad[5];
    let x3 = quad[6];
    let y3 = quad[7];
    let dx3 = x0 - x1 + x2 - x3;
    let dy3 = y0 - y1 + y2 - y3;
    if dx3.abs() < 1e-9 && dy3.abs() < 1e-9 {
        return Homography {
            a: x1 - x0,
            b: x2 - x1,
            c: x0,
            d: y1 - y0,
            e: y2 - y1,
            f: y0,
            g: 0.0,
            h: 0.0,
        };
    }
    let dx1 = x1 - x2;
    let dx2 = x3 - x2;
    let dy1 = y1 - y2;
    let dy2 = y3 - y2;
    let den = dx1 * dy2 - dx2 * dy1;
    let g = (dx3 * dy2 - dx2 * dy3) / den;
    let h = (dx1 * dy3 - dx3 * dy1) / den;
    Homography {
        a: x1 - x0 + g * x1,
        b: x3 - x0 + h * x3,
        c: x0,
        d: y1 - y0 + g * y1,
        e: y3 - y0 + h * y3,
        f: y0,
        g,
        h,
    }
}

fn apply_h(m: &Homography, u: f64, v: f64) -> (f64, f64) {
    let w = m.g * u + m.h * v + 1.0;
    ((m.a * u + m.b * v + m.c) / w, (m.d * u + m.e * v + m.f) / w)
}

fn invert_h(m: &Homography) -> [f64; 9] {
    [
        m.e - m.f * m.h,
        m.c * m.h - m.b,
        m.b * m.f - m.c * m.e,
        m.f * m.g - m.d,
        m.a - m.c * m.g,
        m.c * m.d - m.a * m.f,
        m.d * m.h - m.e * m.g,
        m.b * m.g - m.a * m.h,
        m.a * m.e - m.b * m.d,
    ]
}

fn clamp01(value: f64) -> f64 {
    value.clamp(0.0, 1.0)
}

// JavaScript's Uint8ClampedArray uses round-to-nearest with ties-to-even.
// The retired renderer wrote every raster intermediate through that type, so
// parity-sensitive paths must preserve the same conversion instead of relying
// on Rust's saturating float cast (which truncates).
fn to_uint8_clamp(value: f64) -> u8 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    if value >= 255.0 {
        return 255;
    }
    let floor = value.floor();
    let fraction = value - floor;
    if fraction > 0.5 || (fraction == 0.5 && floor as u64 % 2 == 1) {
        (floor as u8).saturating_add(1)
    } else {
        floor as u8
    }
}

fn halve(source: &Bitmap) -> Bitmap {
    let width = (source.width >> 1).max(1);
    let height = (source.height >> 1).max(1);
    let mut data = vec![0_u8; (width * height * 4) as usize];
    for y in 0..height {
        for x in 0..width {
            let mut premultiplied_red = 0.0;
            let mut premultiplied_green = 0.0;
            let mut premultiplied_blue = 0.0;
            let mut alpha = 0.0;
            for sample in 0..4 {
                let source_x = (x * 2 + (sample & 1)).min(source.width - 1);
                let source_y = (y * 2 + (sample >> 1)).min(source.height - 1);
                let index = ((source_y * source.width + source_x) * 4) as usize;
                let sample_alpha = source.data[index + 3] as f64 / 255.0;
                premultiplied_red += source.data[index] as f64 * sample_alpha;
                premultiplied_green += source.data[index + 1] as f64 * sample_alpha;
                premultiplied_blue += source.data[index + 2] as f64 * sample_alpha;
                alpha += sample_alpha;
            }
            let output = ((y * width + x) * 4) as usize;
            data[output] = to_uint8_clamp(if alpha > 0.0 {
                premultiplied_red / alpha
            } else {
                0.0
            });
            data[output + 1] = to_uint8_clamp(if alpha > 0.0 {
                premultiplied_green / alpha
            } else {
                0.0
            });
            data[output + 2] = to_uint8_clamp(if alpha > 0.0 {
                premultiplied_blue / alpha
            } else {
                0.0
            });
            data[output + 3] = to_uint8_clamp(alpha / 4.0 * 255.0);
        }
    }
    Bitmap {
        data,
        width,
        height,
    }
}

fn minification_levels(source: &Bitmap, geom: &PlacedGeom) -> u32 {
    let edge = |from: usize, to: usize| {
        (geom.quad[to * 2] - geom.quad[from * 2])
            .hypot(geom.quad[to * 2 + 1] - geom.quad[from * 2 + 1])
    };
    let destination_width = edge(0, 1).max(edge(3, 2));
    let destination_height = edge(0, 3).max(edge(1, 2));
    if destination_width <= 0.0 || destination_height <= 0.0 {
        return 0;
    }
    let scale =
        (source.width as f64 / destination_width).min(source.height as f64 / destination_height);
    if scale > 1.0 {
        scale.log2().floor().min(4.0) as u32
    } else {
        0
    }
}

fn prefilter_workspace_bytes(source: &Bitmap, geom: &PlacedGeom) -> Result<u64, PlacedRenderError> {
    let levels = minification_levels(source, geom);
    if levels == 0 || source.width <= 1 || source.height <= 1 {
        return Ok(0);
    }
    raster_byte_len((source.width >> 1).max(1), (source.height >> 1).max(1))
}

fn prefilter_for_minification<'a>(source: &'a Bitmap, geom: &PlacedGeom) -> Cow<'a, Bitmap> {
    let mut levels = minification_levels(source, geom);
    if levels == 0 {
        return Cow::Borrowed(source);
    }
    let mut filtered = Cow::Borrowed(source);
    while levels > 0 && filtered.width > 1 && filtered.height > 1 {
        filtered = Cow::Owned(halve(&filtered));
        levels -= 1;
    }
    filtered
}

fn catmull_rom_weights(fraction: f64) -> [f64; 4] {
    let squared = fraction * fraction;
    let cubed = squared * fraction;
    [
        -0.5 * cubed + squared - 0.5 * fraction,
        1.5 * cubed - 2.5 * squared + 1.0,
        -1.5 * cubed + 2.0 * squared + 0.5 * fraction,
        0.5 * cubed - 0.5 * squared,
    ]
}

struct CatmullRomSampler<'a> {
    source: Cow<'a, Bitmap>,
    source_scale_x: f64,
    source_scale_y: f64,
}

impl<'a> CatmullRomSampler<'a> {
    fn new(source: &'a Bitmap, geom: &PlacedGeom) -> Self {
        let source = prefilter_for_minification(source, geom);
        Self {
            source_scale_x: source.width as f64 / geom.src_w,
            source_scale_y: source.height as f64 / geom.src_h,
            source,
        }
    }

    fn sample(&self, source_x: f64, source_y: f64) -> [f64; 4] {
        let max_x = self.source.width.saturating_sub(1) as f64;
        let max_y = self.source.height.saturating_sub(1) as f64;
        let x = (source_x * self.source_scale_x - 0.5).clamp(0.0, max_x);
        let y = (source_y * self.source_scale_y - 0.5).clamp(0.0, max_y);
        let x0 = x.floor() as i64;
        let y0 = y.floor() as i64;
        let weights_x = catmull_rom_weights(x - x0 as f64);
        let weights_y = catmull_rom_weights(y - y0 as f64);
        let mut red = 0.0;
        let mut green = 0.0;
        let mut blue = 0.0;
        let mut alpha = 0.0;
        for kernel_y in 0..4 {
            let sample_y =
                (y0 - 1 + kernel_y as i64).clamp(0, self.source.height as i64 - 1) as u32;
            for kernel_x in 0..4 {
                let sample_x =
                    (x0 - 1 + kernel_x as i64).clamp(0, self.source.width as i64 - 1) as u32;
                let weight = weights_y[kernel_y] * weights_x[kernel_x];
                let index = ((sample_y * self.source.width + sample_x) * 4) as usize;
                let sample_alpha = BYTE_TO_UNIT[self.source.data[index + 3] as usize];
                red += weight * BYTE_TO_UNIT[self.source.data[index] as usize] * sample_alpha;
                green += weight * BYTE_TO_UNIT[self.source.data[index + 1] as usize] * sample_alpha;
                blue += weight * BYTE_TO_UNIT[self.source.data[index + 2] as usize] * sample_alpha;
                alpha += weight * sample_alpha;
            }
        }
        [red, green, blue, clamp01(alpha)]
    }
}

fn sample_bilinear_transparent(
    source: &Bitmap,
    geom: &PlacedGeom,
    source_x: f64,
    source_y: f64,
) -> [f64; 4] {
    let x = source_x * source.width as f64 / geom.src_w - 0.5;
    let y = source_y * source.height as f64 / geom.src_h - 0.5;
    let x0 = x.floor() as i64;
    let y0 = y.floor() as i64;
    let fraction_x = x - x0 as f64;
    let fraction_y = y - y0 as f64;
    let mut output = [0.0; 4];
    for sample in 0..4 {
        let sample_x = x0 + (sample & 1) as i64;
        let sample_y = y0 + (sample >> 1) as i64;
        if sample_x < 0
            || sample_y < 0
            || sample_x >= source.width as i64
            || sample_y >= source.height as i64
        {
            continue;
        }
        let weight = (if sample & 1 == 1 {
            fraction_x
        } else {
            1.0 - fraction_x
        }) * (if sample & 2 == 2 {
            fraction_y
        } else {
            1.0 - fraction_y
        });
        if weight == 0.0 {
            continue;
        }
        let index = (((sample_y as u32) * source.width + sample_x as u32) * 4) as usize;
        let alpha = BYTE_TO_UNIT[source.data[index + 3] as usize];
        output[0] += weight * BYTE_TO_UNIT[source.data[index] as usize] * alpha;
        output[1] += weight * BYTE_TO_UNIT[source.data[index + 1] as usize] * alpha;
        output[2] += weight * BYTE_TO_UNIT[source.data[index + 2] as usize] * alpha;
        output[3] += weight * alpha;
    }
    output
}

fn render_no_mesh(
    source: &Bitmap,
    geom: &PlacedGeom,
    bounds: PlacedOutputBounds,
) -> Result<Option<PixelSource>, PlacedRenderError> {
    let homography = square_to_quad(&geom.quad);
    let inverse = invert_h(&homography);
    let out_left = bounds.left;
    let out_top = bounds.top;
    let out_w = bounds.width;
    let out_h = bounds.height;
    let sampler = CatmullRomSampler::new(source, geom);
    let mut out = vec![0_u8; allocation_len(out_w, out_h)?];
    for yy in 0..out_h {
        let py = out_top as f64 + yy as f64 + 0.5;
        for xx in 0..out_w {
            let pxc = out_left as f64 + xx as f64 + 0.5;
            let inverse_at = |x: f64, y: f64| {
                let weight = inverse[6] * x + inverse[7] * y + inverse[8];
                (
                    (inverse[0] * x + inverse[1] * y + inverse[2]) / weight,
                    (inverse[3] * x + inverse[4] * y + inverse[5]) / weight,
                )
            };
            let (u, v) = inverse_at(pxc, py);
            let (next_x_u, next_x_v) = inverse_at(pxc + 1.0, py);
            let (next_y_u, next_y_v) = inverse_at(pxc, py + 1.0);
            let gradient_u = (next_x_u - u).hypot(next_y_u - u).max(1e-12);
            let gradient_v = (next_x_v - v).hypot(next_y_v - v).max(1e-12);
            if u < -gradient_u || u > 1.0 + gradient_u || v < -gradient_v || v > 1.0 + gradient_v {
                continue;
            }
            let di = ((yy * out_w + xx) * 4) as usize;
            let source_x = u * geom.src_w;
            let source_y = v * geom.src_h;
            let interior = u / gradient_u > 1.0
                && (1.0 - u) / gradient_u > 1.0
                && v / gradient_v > 1.0
                && (1.0 - v) / gradient_v > 1.0
                && source_x > 3.0
                && source_y > 3.0
                && source_x < geom.src_w - 3.0
                && source_y < geom.src_h - 3.0;
            if interior {
                let sample = sampler.sample(source_x, source_y);
                if sample[3] > 0.0 {
                    out[di] = to_uint8_clamp(clamp01(sample[0] / sample[3]) * 255.0 + 0.5);
                    out[di + 1] = to_uint8_clamp(clamp01(sample[1] / sample[3]) * 255.0 + 0.5);
                    out[di + 2] = to_uint8_clamp(clamp01(sample[2] / sample[3]) * 255.0 + 0.5);
                    out[di + 3] = to_uint8_clamp(sample[3] * 255.0 + 0.5);
                }
                continue;
            }
            let mut accumulated = [0.0; 4];
            for sample_index in 0..4 {
                let offset_x = if sample_index & 1 == 1 { 0.25 } else { -0.25 };
                let offset_y = if sample_index & 2 == 2 { 0.25 } else { -0.25 };
                let (sample_u, sample_v) = inverse_at(pxc + offset_x, py + offset_y);
                if !(0.0..=1.0).contains(&sample_u) || !(0.0..=1.0).contains(&sample_v) {
                    continue;
                }
                let sample = sample_bilinear_transparent(
                    source,
                    geom,
                    sample_u * geom.src_w,
                    sample_v * geom.src_h,
                );
                for channel in 0..4 {
                    accumulated[channel] += sample[channel];
                }
            }
            let alpha = accumulated[3] / 4.0;
            if alpha > 0.0 {
                out[di] = to_uint8_clamp(clamp01(accumulated[0] / 4.0 / alpha) * 255.0 + 0.5);
                out[di + 1] = to_uint8_clamp(clamp01(accumulated[1] / 4.0 / alpha) * 255.0 + 0.5);
                out[di + 2] = to_uint8_clamp(clamp01(accumulated[2] / 4.0 / alpha) * 255.0 + 0.5);
                out[di + 3] = to_uint8_clamp(alpha * 255.0 + 0.5);
            }
        }
    }
    Ok(Some(PixelSource {
        data: out,
        width: out_w,
        height: out_h,
        left: out_left,
        top: out_top,
    }))
}

fn bezier_weights(t: f64) -> [f64; 4] {
    let mt = 1.0 - t;
    [mt * mt * mt, 3.0 * mt * mt * t, 3.0 * mt * t * t, t * t * t]
}

fn locate_patch(slices: &[f64], pos: f64) -> (usize, f64) {
    let n = slices.len().saturating_sub(1);
    let mut index = 0;
    while index < n.saturating_sub(1) && pos > slices[index + 1] {
        index += 1;
    }
    let span = slices[index + 1] - slices[index];
    (
        index,
        if span > 0.0 {
            (pos - slices[index]) / span
        } else {
            0.0
        },
    )
}

fn eval_mesh(mesh: &MeshGrid, sx: f64, sy: f64) -> (f64, f64) {
    let (iu, tu) = locate_patch(&mesh.slices_x, sx);
    let (iv, tv) = locate_patch(&mesh.slices_y, sy);
    let bu = bezier_weights(tu);
    let bv = bezier_weights(tv);
    let c0 = iu * 3;
    let r0 = iv * 3;
    let mut x = 0.0;
    let mut y = 0.0;
    for row in 0..4 {
        let row_base = (r0 + row) * mesh.cols + c0;
        let wv = bv[row];
        for col in 0..4 {
            let weight = wv * bu[col];
            x += weight * mesh.xs[row_base + col];
            y += weight * mesh.ys[row_base + col];
        }
    }
    (x, y)
}

fn render_mesh_forward(
    source: &Bitmap,
    geom: &PlacedGeom,
    bounds: PlacedOutputBounds,
) -> Result<Option<PixelSource>, PlacedRenderError> {
    let mesh = geom.mesh.as_ref().ok_or_else(|| {
        PlacedRenderError::new(
            PlacedRenderErrorKind::InvalidGeometry,
            "missing mesh geometry",
        )
    })?;
    let point_count = mesh.cols.checked_mul(mesh.rows);
    let required_cols = mesh
        .slices_x
        .len()
        .checked_sub(1)
        .and_then(|patches| patches.checked_mul(3))
        .and_then(|columns| columns.checked_add(1));
    let required_rows = mesh
        .slices_y
        .len()
        .checked_sub(1)
        .and_then(|patches| patches.checked_mul(3))
        .and_then(|rows| rows.checked_add(1));
    if mesh.cols < 4
        || mesh.rows < 4
        || mesh.slices_x.len() < 2
        || mesh.slices_y.len() < 2
        || point_count.is_none_or(|count| mesh.xs.len() < count || mesh.ys.len() < count)
        || required_cols.is_none_or(|columns| columns > mesh.cols)
        || required_rows.is_none_or(|rows| rows > mesh.rows)
        || !mesh.xs.iter().all(|value| value.is_finite())
        || !mesh.ys.iter().all(|value| value.is_finite())
        || !mesh.slices_x.iter().all(|value| value.is_finite())
        || !mesh.slices_y.iter().all(|value| value.is_finite())
    {
        return Err(PlacedRenderError::new(
            PlacedRenderErrorKind::InvalidGeometry,
            "placed-layer mesh geometry is incomplete",
        ));
    }
    let homography = square_to_quad(&geom.quad);
    let mut wbx0 = f64::INFINITY;
    let mut wby0 = f64::INFINITY;
    let mut wbx1 = f64::NEG_INFINITY;
    let mut wby1 = f64::NEG_INFINITY;
    for index in 0..mesh.xs.len() {
        wbx0 = wbx0.min(mesh.xs[index]);
        wbx1 = wbx1.max(mesh.xs[index]);
        wby0 = wby0.min(mesh.ys[index]);
        wby1 = wby1.max(mesh.ys[index]);
    }
    let wbw = if wbx1 == wbx0 { 1.0 } else { wbx1 - wbx0 };
    let wbh = if wby1 == wby0 { 1.0 } else { wby1 - wby0 };
    let dx0 = mesh.slices_x[0];
    let dx1 = *mesh.slices_x.last().unwrap_or(&dx0);
    let dy0 = mesh.slices_y[0];
    let dy1 = *mesh.slices_y.last().unwrap_or(&dy0);
    let q = &geom.quad;
    let min_x = q.iter().step_by(2).copied().fold(f64::INFINITY, f64::min);
    let max_x = q
        .iter()
        .step_by(2)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let min_y = q
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .fold(f64::INFINITY, f64::min);
    let max_y = q
        .iter()
        .skip(1)
        .step_by(2)
        .copied()
        .fold(f64::NEG_INFINITY, f64::max);
    let out_left = bounds.left;
    let out_top = bounds.top;
    let out_w = bounds.width;
    let out_h = bounds.height;
    let cells_x = (((max_x - min_x).max(1.0) / 1.3).ceil() as usize).clamp(16, 2048);
    let cells_y = (((max_y - min_y).max(1.0) / 1.3).ceil() as usize).clamp(16, 2048);
    let grid_width = cells_x + 1;
    let grid_len = grid_width.checked_mul(cells_y + 1).ok_or_else(|| {
        PlacedRenderError::new(
            PlacedRenderErrorKind::ExtentLimit,
            "mesh raster grid exceeds addressable memory",
        )
    })?;
    let map_source_to_document = |source_x: f64, source_y: f64| {
        let (warped_x, warped_y) = eval_mesh(mesh, source_x, source_y);
        apply_h(
            &homography,
            (warped_x - wbx0) / wbw,
            (warped_y - wby0) / wbh,
        )
    };
    let mut grid_x = vec![0.0; grid_len];
    let mut grid_y = vec![0.0; grid_len];
    for row in 0..=cells_y {
        for column in 0..=cells_x {
            let (document_x, document_y) = map_source_to_document(
                dx0 + column as f64 / cells_x as f64 * (dx1 - dx0),
                dy0 + row as f64 / cells_y as f64 * (dy1 - dy0),
            );
            let index = row * grid_width + column;
            grid_x[index] = document_x - out_left as f64;
            grid_y[index] = document_y - out_top as f64;
        }
    }

    let sampler = CatmullRomSampler::new(source, geom);
    let mut out = vec![0_u8; allocation_len(out_w, out_h)?];
    let mut written = vec![0_u8; pixel_len(out_w, out_h)?];
    for cell_y in 0..cells_y {
        for cell_x in 0..cells_x {
            let grid_index = cell_y * grid_width + cell_x;
            let x00 = grid_x[grid_index];
            let y00 = grid_y[grid_index];
            let x10 = grid_x[grid_index + 1];
            let y10 = grid_y[grid_index + 1];
            let x01 = grid_x[grid_index + grid_width];
            let y01 = grid_y[grid_index + grid_width];
            let x11 = grid_x[grid_index + grid_width + 1];
            let y11 = grid_y[grid_index + grid_width + 1];
            let box_left =
                ((x00.min(x10).min(x01).min(x11)).floor() as i64 - 1).clamp(0, out_w as i64) as u32;
            let box_top =
                ((y00.min(y10).min(y01).min(y11)).floor() as i64 - 1).clamp(0, out_h as i64) as u32;
            let box_right =
                ((x00.max(x10).max(x01).max(x11)).ceil() as i64 + 1).clamp(0, out_w as i64) as u32;
            let box_bottom =
                ((y00.max(y10).max(y01).max(y11)).ceil() as i64 + 1).clamp(0, out_h as i64) as u32;
            let axis_x_x = x10 - x00;
            let axis_x_y = y10 - y00;
            let axis_y_x = x01 - x00;
            let axis_y_y = y01 - y00;
            let curve_x = x11 - x10 - x01 + x00;
            let curve_y = y11 - y10 - y01 + y00;
            for y in box_top..box_bottom {
                for x in box_left..box_right {
                    let pixel_index = (y * out_w + x) as usize;
                    if written[pixel_index] != 0 {
                        continue;
                    }
                    let pixel_x = x as f64 + 0.5 - x00;
                    let pixel_y = y as f64 + 0.5 - y00;
                    let mut s = 0.5;
                    let mut t = 0.5;
                    let mut jacobian_00 = axis_x_x;
                    let mut jacobian_01 = axis_y_x;
                    let mut jacobian_10 = axis_x_y;
                    let mut jacobian_11 = axis_y_y;
                    for _ in 0..5 {
                        let function_x = axis_x_x * s + axis_y_x * t + curve_x * s * t - pixel_x;
                        let function_y = axis_x_y * s + axis_y_y * t + curve_y * s * t - pixel_y;
                        jacobian_00 = axis_x_x + curve_x * t;
                        jacobian_01 = axis_y_x + curve_x * s;
                        jacobian_10 = axis_x_y + curve_y * t;
                        jacobian_11 = axis_y_y + curve_y * s;
                        let determinant = jacobian_00 * jacobian_11 - jacobian_01 * jacobian_10;
                        if determinant.abs() < 1e-12 {
                            break;
                        }
                        s -= (function_x * jacobian_11 - function_y * jacobian_01) / determinant;
                        t -= (function_y * jacobian_00 - function_x * jacobian_10) / determinant;
                    }
                    if !(-0.08..=1.08).contains(&s) || !(-0.08..=1.08).contains(&t) {
                        continue;
                    }
                    let determinant = jacobian_00 * jacobian_11 - jacobian_01 * jacobian_10;
                    if determinant.abs() < 1e-12 {
                        continue;
                    }
                    let source_x_gradient = jacobian_11 / determinant;
                    let source_y_gradient = -jacobian_01 / determinant;
                    let target_x_gradient = -jacobian_10 / determinant;
                    let target_y_gradient = jacobian_00 / determinant;
                    let gradient_u = source_x_gradient.hypot(source_y_gradient) / cells_x as f64;
                    let gradient_v = target_x_gradient.hypot(target_y_gradient) / cells_y as f64;
                    let global_u = (cell_x as f64 + s) / cells_x as f64;
                    let global_v = (cell_y as f64 + t) / cells_y as f64;
                    let distance_u = global_u.min(1.0 - global_u) / gradient_u.max(1e-12);
                    let distance_v = global_v.min(1.0 - global_v) / gradient_v.max(1e-12);
                    let coverage = clamp01(0.5 + distance_u) * clamp01(0.5 + distance_v);
                    written[pixel_index] = 1;
                    if coverage <= 0.0 {
                        continue;
                    }
                    let sample = sampler.sample(
                        dx0 + (cell_x as f64 + clamp01(s)) / cells_x as f64 * (dx1 - dx0),
                        dy0 + (cell_y as f64 + clamp01(t)) / cells_y as f64 * (dy1 - dy0),
                    );
                    let alpha = sample[3];
                    if alpha <= 0.0 {
                        continue;
                    }
                    let output = pixel_index * 4;
                    out[output] = to_uint8_clamp(clamp01(sample[0] / alpha) * 255.0 + 0.5);
                    out[output + 1] = to_uint8_clamp(clamp01(sample[1] / alpha) * 255.0 + 0.5);
                    out[output + 2] = to_uint8_clamp(clamp01(sample[2] / alpha) * 255.0 + 0.5);
                    out[output + 3] = to_uint8_clamp(alpha * coverage * 255.0 + 0.5);
                }
            }
        }
    }
    Ok(Some(PixelSource {
        data: out,
        width: out_w,
        height: out_h,
        left: out_left,
        top: out_top,
    }))
}

#[cfg(test)]
mod tests;

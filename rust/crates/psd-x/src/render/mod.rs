//! Photoshop-style "Export As" adapter: plan groups, crop/scale, and encode image bytes.
//!
//! Pixel production lives in [`crate::composite`]. This module keeps export policy —
//! group selection, trim vs canvas, resampling, codecs, filenames, and concurrency.
//!
//! Parallel workers use standard-library threads on native targets only
//! (`#[cfg(not(target_family = "wasm"))]`). On WebAssembly, `ExportConcurrency::Fixed(n ≥ 2)`
//! degrades to one worker with a warning instead of spawning threads. Prefer the `composite`
//! feature alone when a wasm host needs pixels without image codecs.

mod document;
mod encode;

use std::collections::HashSet;
#[cfg(not(target_family = "wasm"))]
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use thiserror::Error;

use crate::composite::{
    CompositeError, CompositeRegion, CompositeRequest, CompositeTarget, PixelRect, composite,
};
use crate::psd::Psd;
pub use document::{ExportPlan, SkipReason, SkippedGroup, plan_top_level_groups};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Png,
    Jpeg,
    Gif,
}

impl ExportFormat {
    pub const fn extension(self) -> &'static str {
        match self {
            Self::Png => "png",
            Self::Jpeg => "jpg",
            Self::Gif => "gif",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportBounds {
    /// Crop each exported group to its rendered non-transparent pixels.
    Trim,
    /// Preserve the PSD document canvas.
    Canvas,
}

/// Runtime parallelism policy for independent top-level group exports.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ExportConcurrency {
    /// Render and encode every group on the calling thread.
    Off,
    /// Use the host's available parallelism, capped by the configured memory budget.
    #[default]
    Auto,
    /// Request an explicit worker count, still capped by the configured memory budget.
    Fixed(usize),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResampleMethod {
    Bicubic,
    Automatic,
    BicubicSharper,
    BicubicSmoother,
    Bilinear,
    Nearest,
    PreserveDetails,
}

impl ResampleMethod {
    fn resolve(self, width: u32, height: u32, target_width: u32, target_height: u32) -> Self {
        if self != Self::Automatic {
            return self;
        }
        if target_width < width || target_height < height {
            Self::BicubicSharper
        } else {
            Self::BicubicSmoother
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ExportScale {
    pub factor: f64,
    pub suffix: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CanvasAnchor {
    TopLeft,
    Top,
    TopRight,
    Left,
    Center,
    Right,
    BottomLeft,
    Bottom,
    BottomRight,
}

impl CanvasAnchor {
    fn factors(self) -> (f64, f64) {
        match self {
            Self::TopLeft => (0.0, 0.0),
            Self::Top => (0.5, 0.0),
            Self::TopRight => (1.0, 0.0),
            Self::Left => (0.0, 0.5),
            Self::Center => (0.5, 0.5),
            Self::Right => (1.0, 0.5),
            Self::BottomLeft => (0.0, 1.0),
            Self::Bottom => (0.5, 1.0),
            Self::BottomRight => (1.0, 1.0),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CanvasSize {
    pub width: u32,
    pub height: u32,
    pub anchor: CanvasAnchor,
}

impl Default for ExportScale {
    fn default() -> Self {
        Self {
            factor: 1.0,
            suffix: String::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub format: ExportFormat,
    pub bounds: ExportBounds,
    /// `None` exports every eligible top-level group. Values are indices in `Psd::children`.
    pub selected_top_level_groups: Option<Vec<usize>>,
    /// One source render may be encoded at several scales, each with its own filename suffix.
    pub scales: Vec<ExportScale>,
    /// Optional base image size, corresponding to Photoshop's Image Size controls.
    pub image_size: Option<ImageSize>,
    /// Optional transparent crop/pad after resizing, corresponding to Canvas Size.
    pub canvas_size: Option<CanvasSize>,
    pub resample: ResampleMethod,
    /// Photoshop's JPEG quality scale (`0..=7`). Ignored by PNG and GIF.
    pub jpeg_quality: u8,
    /// Preserve alpha in PNG output. When false, pixels are flattened onto `matte_color`.
    pub png_transparency: bool,
    /// Prefer smaller, 8-bit PNG output. psd-x's export raster is RGBA8 in either mode.
    pub png_smaller_8_bit: bool,
    /// Background used for JPEG and for PNG when transparency is disabled.
    pub matte_color: [u8; 3],
    /// Optional visible filename stem. If absent, a sanitized group name is used.
    pub base_name: Option<String>,
    /// Refuse unexpectedly large individual outputs before allocation/encoding.
    pub max_output_pixels: u64,
    /// Parallelize independent top-level groups. `Auto` is the default.
    pub concurrency: ExportConcurrency,
    /// Approximate aggregate peak-memory guard for parallel workers. `None` disables the cap.
    pub parallel_memory_limit_bytes: Option<u64>,
}

impl Default for ExportOptions {
    fn default() -> Self {
        Self {
            format: ExportFormat::Png,
            bounds: ExportBounds::Trim,
            selected_top_level_groups: None,
            scales: vec![ExportScale::default()],
            image_size: None,
            canvas_size: None,
            resample: ResampleMethod::Automatic,
            jpeg_quality: 7,
            png_transparency: true,
            png_smaller_8_bit: false,
            matte_color: [255, 255, 255],
            base_name: None,
            max_output_pixels: 100_000_000,
            concurrency: ExportConcurrency::Auto,
            parallel_memory_limit_bytes: Some(512 * 1024 * 1024),
        }
    }
}

#[derive(Debug, Clone)]
pub struct ExportedAsset {
    pub top_level_index: usize,
    pub group_name: String,
    pub file_name: String,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub format: ExportFormat,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone)]
pub struct ExportResult {
    pub assets: Vec<ExportedAsset>,
    pub skipped: Vec<SkippedGroup>,
    pub warnings: Vec<String>,
    /// Effective worker count after CPU/group/memory caps.
    pub workers_used: usize,
}

#[derive(Debug, Error)]
pub enum ExportError {
    #[error("invalid PSD document dimensions")]
    InvalidDocumentDimensions,
    #[error("invalid export scale: {0}")]
    InvalidScale(f64),
    #[error("image and canvas dimensions must be greater than zero")]
    InvalidOutputDimensions,
    #[error("JPEG quality must be in Photoshop's 0..=7 range, got {0}")]
    InvalidJpegQuality(u8),
    #[error("fixed export concurrency must be at least 1, got {0}")]
    InvalidConcurrency(usize),
    #[error("invalid RGBA8 pixel buffer")]
    InvalidPixelBuffer,
    #[error("export dimensions exceed the configured limit: {width}x{height}")]
    DimensionLimit { width: u32, height: u32 },
    #[error("PSD has no exportable top-level groups")]
    NoExportableGroups,
    #[error("all selected groups rendered fully transparent")]
    NoRenderedAssets,
    #[error("an export worker thread panicked")]
    WorkerPanicked,
    #[error("image encoding failed: {0}")]
    Image(#[from] image::ImageError),
}

impl From<CompositeError> for ExportError {
    fn from(value: CompositeError) -> Self {
        match value {
            CompositeError::InvalidCanvas { .. } => Self::InvalidDocumentDimensions,
            CompositeError::RegionTooLarge { pixels, .. } => {
                // Best-effort dimensions when the export path lacks a planned group height.
                let width = (pixels.min(u64::from(u32::MAX))) as u32;
                Self::DimensionLimit {
                    width: width.max(1),
                    height: 1,
                }
            }
            CompositeError::TargetNotFound(_) | CompositeError::EmptyRegion => {
                Self::NoExportableGroups
            }
        }
    }
}

fn jpeg_encoder_quality(photoshop_quality: u8) -> u8 {
    const QUALITY: [u8; 8] = [10, 30, 50, 65, 75, 85, 92, 100];
    QUALITY[photoshop_quality as usize]
}

fn safe_stem(value: &str, fallback: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for character in value.trim().chars() {
        if character.is_alphanumeric() || matches!(character, '-' | '_' | ' ' | '.') {
            out.push(character);
        } else {
            out.push('_');
        }
    }
    let out = out.trim_matches([' ', '.']).trim();
    if out.is_empty() {
        fallback.to_owned()
    } else {
        out.to_owned()
    }
}

fn scaled_dimension(value: u32, factor: f64) -> Result<u32, ExportError> {
    let scaled = (value as f64 * factor).round();
    if !(1.0..=u32::MAX as f64).contains(&scaled) {
        return Err(ExportError::InvalidScale(factor));
    }
    Ok(scaled as u32)
}

struct GroupExport {
    export_index: usize,
    assets: Vec<ExportedAsset>,
    warnings: Vec<String>,
}

fn estimate_group_peak_bytes(
    psd: &Psd,
    options: &ExportOptions,
    group: &document::PlannedGroup<'_>,
) -> Result<u64, ExportError> {
    let source = match options.bounds {
        ExportBounds::Trim => ImageSize {
            width: group.bounds.width,
            height: group.bounds.height,
        },
        ExportBounds::Canvas => ImageSize {
            width: psd.width as u32,
            height: psd.height as u32,
        },
    };
    let base_image = options.image_size.unwrap_or(source);
    let base_canvas = options.canvas_size.unwrap_or(CanvasSize {
        width: base_image.width,
        height: base_image.height,
        anchor: CanvasAnchor::Center,
    });
    let mut largest_output_pixels = 0u64;
    for scale in &options.scales {
        let image_width = scaled_dimension(base_image.width, scale.factor)?;
        let image_height = scaled_dimension(base_image.height, scale.factor)?;
        let canvas_width = scaled_dimension(base_canvas.width, scale.factor)?;
        let canvas_height = scaled_dimension(base_canvas.height, scale.factor)?;
        largest_output_pixels = largest_output_pixels.max(
            (image_width as u64 * image_height as u64)
                .max(canvas_width as u64 * canvas_height as u64),
        );
    }
    let path = [group.top_level_index];
    let request = CompositeRequest {
        target: CompositeTarget::Layer(&path),
        region: CompositeRegion::Rows {
            top: group.bounds.top,
            bottom: group.bounds.top + group.bounds.height as i32,
        },
        max_pixels: options.max_output_pixels,
    };
    // Compositor peak + resized/canvas buffers for encoding.
    Ok(request
        .estimated_peak_bytes(psd)?
        .saturating_add(largest_output_pixels.saturating_mul(8)))
}

fn memory_worker_cap(
    requested: usize,
    limit: Option<u64>,
    peak_bytes: u64,
) -> (usize, Option<String>) {
    let Some(limit) = limit else {
        return (requested.max(1), None);
    };
    let peak = peak_bytes.max(1);
    let memory_workers = usize::try_from((limit / peak).max(1)).unwrap_or(usize::MAX);
    let effective = requested.min(memory_workers).max(1);
    // Report for Auto and Fixed alike — a silent cap makes peak-memory tuning opaque.
    let warning = (effective < requested).then(|| {
        format!(
            "parallel export workers reduced from {requested} to {effective} by the {} MiB memory limit",
            limit / (1024 * 1024)
        )
    });
    (effective, warning)
}

fn worker_count(
    psd: &Psd,
    options: &ExportOptions,
    groups: &[document::PlannedGroup<'_>],
) -> Result<(usize, Option<String>), ExportError> {
    let requested = match options.concurrency {
        ExportConcurrency::Off => 1,
        ExportConcurrency::Auto => thread::available_parallelism().map_or(1, usize::from),
        ExportConcurrency::Fixed(0) => return Err(ExportError::InvalidConcurrency(0)),
        ExportConcurrency::Fixed(workers) => workers,
    }
    .min(groups.len())
    .max(1);

    let (requested, wasm_warning) =
        crate::degrade_export_workers(requested, cfg!(target_family = "wasm"));

    let peak = if options.parallel_memory_limit_bytes.is_some() {
        groups
            .iter()
            .map(|group| estimate_group_peak_bytes(psd, options, group))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .max()
            .unwrap_or(1)
    } else {
        1
    };
    let (effective, memory_warning) =
        memory_worker_cap(requested, options.parallel_memory_limit_bytes, peak);
    Ok((effective, wasm_warning.or(memory_warning)))
}

fn export_group(
    psd: &Psd,
    options: &ExportOptions,
    group: &document::PlannedGroup<'_>,
    export_index: usize,
    document_rect: PixelRect,
) -> Result<GroupExport, ExportError> {
    let path = [group.top_level_index];
    let request = CompositeRequest {
        target: CompositeTarget::Layer(&path),
        region: CompositeRegion::Rows {
            top: group.bounds.top,
            bottom: group.bounds.top + group.bounds.height as i32,
        },
        max_pixels: options.max_output_pixels,
    };
    let composed = match composite(psd, &request) {
        Ok(result) => result,
        Err(CompositeError::RegionTooLarge { .. }) => {
            return Err(ExportError::DimensionLimit {
                width: psd.width as u32,
                height: group.bounds.height,
            });
        }
        Err(error) => return Err(error.into()),
    };
    let mut warnings = crate::composite::report::warning_strings(&composed.warnings);
    let Some(content_bounds) = composed.raster.content_bounds() else {
        warnings.push(format!("group {:?} rendered fully transparent", group.name));
        return Ok(GroupExport {
            export_index,
            assets: Vec::new(),
            warnings,
        });
    };
    let output_rect = match options.bounds {
        ExportBounds::Trim => content_bounds,
        ExportBounds::Canvas => document_rect,
    };
    let original = composed.raster.cropped(output_rect).into_pixels().data;
    let mut assets = Vec::with_capacity(options.scales.len());
    for scale in &options.scales {
        let base_image = options.image_size.unwrap_or(ImageSize {
            width: output_rect.width,
            height: output_rect.height,
        });
        let image_width = scaled_dimension(base_image.width, scale.factor)?;
        let image_height = scaled_dimension(base_image.height, scale.factor)?;
        let base_canvas = options.canvas_size.unwrap_or(CanvasSize {
            width: base_image.width,
            height: base_image.height,
            anchor: CanvasAnchor::Center,
        });
        let width = scaled_dimension(base_canvas.width, scale.factor)?;
        let height = scaled_dimension(base_canvas.height, scale.factor)?;
        if width as u64 * height as u64 > options.max_output_pixels
            || image_width as u64 * image_height as u64 > options.max_output_pixels
        {
            return Err(ExportError::DimensionLimit { width, height });
        }
        let resized = encode::resize_rgba(
            &original,
            output_rect.width,
            output_rect.height,
            image_width,
            image_height,
            options.resample,
        )?;
        let canvas = (image_width != width || image_height != height).then(|| {
            encode::place_on_canvas(
                resized.as_ref(),
                image_width,
                image_height,
                width,
                height,
                base_canvas.anchor,
            )
        });
        let rgba = canvas.as_deref().unwrap_or(resized.as_ref());
        let bytes = encode::encode(
            rgba,
            width,
            height,
            encode::EncodeSettings {
                format: options.format,
                jpeg_quality: jpeg_encoder_quality(options.jpeg_quality),
                png_transparency: options.png_transparency,
                png_smaller_8_bit: options.png_smaller_8_bit,
                background: options.matte_color,
            },
        )?;
        let stem = options
            .base_name
            .as_deref()
            .map(|base| format!("{}-{}", safe_stem(base, "export"), export_index + 1))
            .unwrap_or_else(|| safe_stem(&group.name, &format!("group-{}", export_index + 1)));
        let suffix = safe_stem(&scale.suffix, "");
        assets.push(ExportedAsset {
            top_level_index: group.top_level_index,
            group_name: group.name.clone(),
            file_name: format!("{stem}{suffix}.{}", options.format.extension()),
            width,
            height,
            scale: scale.factor,
            format: options.format,
            bytes,
        });
    }
    Ok(GroupExport {
        export_index,
        assets,
        warnings,
    })
}

#[cfg(not(target_family = "wasm"))]
fn export_groups_parallel(
    psd: &Psd,
    options: &ExportOptions,
    groups: &[document::PlannedGroup<'_>],
    document_rect: PixelRect,
    workers: usize,
) -> Result<Vec<GroupExport>, ExportError> {
    let next = AtomicUsize::new(0);
    thread::scope(|scope| {
        let handles = (0..workers)
            .map(|_| {
                scope.spawn(|| {
                    let mut local = Vec::new();
                    loop {
                        let index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(group) = groups.get(index) else {
                            break;
                        };
                        local.push(export_group(psd, options, group, index, document_rect)?);
                    }
                    Ok::<_, ExportError>(local)
                })
            })
            .collect::<Vec<_>>();
        let mut all = Vec::with_capacity(groups.len());
        for handle in handles {
            let mut local = handle.join().map_err(|_| ExportError::WorkerPanicked)??;
            all.append(&mut local);
        }
        Ok(all)
    })
}

fn deduplicate_file_names(assets: &mut [ExportedAsset], warnings: &mut Vec<String>) {
    let mut used = HashSet::new();
    for asset in assets {
        let requested = asset.file_name.clone();
        let (stem, extension) = requested.rsplit_once('.').unwrap_or((&requested, ""));
        let mut duplicate = 2;
        while !used.insert(asset.file_name.clone()) {
            asset.file_name = format!("{stem}-{duplicate}.{extension}");
            duplicate += 1;
        }
        if asset.file_name != requested {
            warnings.push(format!(
                "duplicate output name {:?} was renamed to {:?}",
                requested, asset.file_name
            ));
        }
    }
}

/// Render selected top-level groups and encode all requested scale variants in memory.
pub fn export_groups(psd: &Psd, options: &ExportOptions) -> Result<ExportResult, ExportError> {
    if !psd.width.is_finite()
        || !psd.height.is_finite()
        || psd.width <= 0.0
        || psd.height <= 0.0
        || psd.width > u32::MAX as f64
        || psd.height > u32::MAX as f64
    {
        return Err(ExportError::InvalidDocumentDimensions);
    }
    if options.jpeg_quality > 7 {
        return Err(ExportError::InvalidJpegQuality(options.jpeg_quality));
    }
    if options.scales.is_empty()
        || options
            .scales
            .iter()
            .any(|scale| !scale.factor.is_finite() || scale.factor <= 0.0)
    {
        return Err(ExportError::InvalidScale(
            options.scales.first().map_or(0.0, |scale| scale.factor),
        ));
    }
    if options
        .image_size
        .is_some_and(|size| size.width == 0 || size.height == 0)
        || options
            .canvas_size
            .is_some_and(|size| size.width == 0 || size.height == 0)
    {
        return Err(ExportError::InvalidOutputDimensions);
    }
    let plan = plan_top_level_groups(psd, options.selected_top_level_groups.as_deref());
    if plan.groups.is_empty() {
        return Err(ExportError::NoExportableGroups);
    }
    let document_rect = PixelRect {
        left: 0,
        top: 0,
        width: psd.width as u32,
        height: psd.height as u32,
    };
    let (workers, concurrency_warning) = worker_count(psd, options, &plan.groups)?;
    let mut rendered = if workers == 1 {
        plan.groups
            .iter()
            .enumerate()
            .map(|(index, group)| export_group(psd, options, group, index, document_rect))
            .collect::<Result<Vec<_>, _>>()?
    } else {
        #[cfg(target_family = "wasm")]
        {
            // `worker_count` must already have degraded to 1 on wasm.
            plan.groups
                .iter()
                .enumerate()
                .map(|(index, group)| export_group(psd, options, group, index, document_rect))
                .collect::<Result<Vec<_>, _>>()?
        }
        #[cfg(not(target_family = "wasm"))]
        {
            export_groups_parallel(psd, options, &plan.groups, document_rect, workers)?
        }
    };
    rendered.sort_by_key(|group| group.export_index);
    let mut assets = Vec::new();
    let mut warnings = concurrency_warning.into_iter().collect::<Vec<_>>();
    for group in rendered {
        assets.extend(group.assets);
        warnings.extend(group.warnings);
    }
    if assets.is_empty() {
        return Err(ExportError::NoRenderedAssets);
    }
    deduplicate_file_names(&mut assets, &mut warnings);
    Ok(ExportResult {
        assets,
        skipped: plan.skipped,
        warnings,
        workers_used: workers,
    })
}

#[cfg(test)]
mod tests;

use crate::psd::{BlendMode, Layer, LayerMaskData, Psd};

use super::blend;
use super::features;
use super::raster::{Backdrop, PixelSource, U8_TO_UNIT};
use super::report::{CompositeWarning, CompositeWarningReport, MaskIgnoredReason, WarningLog};

#[derive(Debug, Clone, Copy)]
pub(crate) struct Viewport {
    pub top: i32,
    pub bottom: i32,
}

struct Context {
    width: u32,
    canvas_height: i32,
    /// Path length of units whose blend is against this composite's backdrop root
    /// (1 for document top-level; the target path length when rooted).
    root_path_len: usize,
    viewport: Viewport,
    path: Vec<usize>,
    warnings: WarningLog,
}

fn layer_has_decoded_pixels(layer: &Layer) -> bool {
    layer.image_data.is_some() || layer.canvas.is_some()
}

fn layer_missing_geometry(layer: &Layer) -> bool {
    layer.left.is_none() || layer.top.is_none()
}

fn layer_name(layer: &Layer) -> Option<String> {
    layer.additional_info.name.clone()
}

fn warn_missing_geometry(ctx: &mut Context, layer: &Layer) {
    ctx.warnings.push(CompositeWarning::MissingGeometry {
        path: ctx.path.clone(),
        name: layer_name(layer),
    });
}

fn source_for<'a>(ctx: &mut Context, layer: &'a Layer) -> Option<PixelSource<'a>> {
    let pixels = layer.image_data.as_ref().or(layer.canvas.as_ref())?;
    let left = layer.left?.round() as i32;
    let top = layer.top?.round() as i32;
    match PixelSource::from_pixels(pixels, left, top) {
        Some(source) => Some(source),
        None => {
            if pixels.width > 0 && pixels.height > 0 {
                if !matches!(pixels.depth, 8 | 16 | 32) {
                    ctx.warnings.push(CompositeWarning::UnsupportedDepth {
                        path: ctx.path.clone(),
                        depth: pixels.depth,
                    });
                } else {
                    let bytes_per_sample = pixels.bytes_per_sample();
                    let expected =
                        pixels.width as usize * pixels.height as usize * 4 * bytes_per_sample;
                    ctx.warnings.push(CompositeWarning::MalformedRaster {
                        path: ctx.path.clone(),
                        name: layer_name(layer),
                        expected,
                        found: pixels.data.len(),
                    });
                }
            }
            None
        }
    }
}

/// Resolve a mask once per layer. Unsupported depth / missing pixels are ignored
/// (fully visible) with a single warning — never applied as an opaque black mask.
fn usable_mask<'a>(
    ctx: &mut Context,
    mask: Option<&'a LayerMaskData>,
) -> Option<&'a LayerMaskData> {
    let mask = mask?;
    if mask.disabled.unwrap_or(false) {
        return None;
    }
    let Some(pixels) = mask.image_data.as_ref().or(mask.canvas.as_ref()) else {
        ctx.warnings.push(CompositeWarning::MaskIgnored {
            path: ctx.path.clone(),
            reason: MaskIgnoredReason::NoPixelData,
        });
        return None;
    };
    if pixels.depth != 8 {
        ctx.warnings.push(CompositeWarning::MaskIgnored {
            path: ctx.path.clone(),
            reason: MaskIgnoredReason::UnsupportedDepth {
                depth: pixels.depth,
            },
        });
        return None;
    }
    features::report_mask_approximations(&mut ctx.warnings, &ctx.path, mask);
    Some(mask)
}

fn sample_mask(mask: &LayerMaskData, x: i32, y: i32) -> f32 {
    if mask.disabled.unwrap_or(false) {
        return 1.0;
    }
    let default = (mask.default_color.unwrap_or(0.0) / 255.0).clamp(0.0, 1.0) as f32;
    let Some(pixels) = mask.image_data.as_ref().or(mask.canvas.as_ref()) else {
        // Missing pixels: treat as fully visible (do not apply default_color black).
        return 1.0;
    };
    if pixels.depth != 8 {
        // Unsupported depth: ignore mask rather than applying default_color.
        return 1.0;
    }
    let left = mask.left.unwrap_or_default().round() as i32;
    let top = mask.top.unwrap_or_default().round() as i32;
    let right = mask
        .right
        .unwrap_or(left as f64 + pixels.width as f64)
        .round() as i32;
    let bottom = mask
        .bottom
        .unwrap_or(top as f64 + pixels.height as f64)
        .round() as i32;
    if x < left || x >= right || y < top || y >= bottom {
        return default;
    }
    let index = (((y - top) as u32 * pixels.width + (x - left) as u32) * 4) as usize;
    pixels
        .data
        .get(index)
        .copied()
        .unwrap_or((default * 255.0) as u8) as f32
        / 255.0
}

fn source_bounds(layer: &Layer) -> Option<(i32, i32)> {
    if let Some(children) = &layer.children {
        let mut top = i32::MAX;
        let mut bottom = i32::MIN;
        for child in children {
            if child.hidden.unwrap_or(false) {
                continue;
            }
            if let Some((child_top, child_bottom)) = source_bounds(child) {
                top = top.min(child_top);
                bottom = bottom.max(child_bottom);
            }
        }
        return (bottom > top).then_some((top, bottom));
    }
    let pixels = layer.image_data.as_ref().or(layer.canvas.as_ref())?;
    if pixels.width == 0 || pixels.height == 0 {
        return None;
    }
    // Bounds are a rectangle question — bit depth must not gate them.
    // Refuse to invent an origin for layers with pixels but no position.
    let top = layer.top?.round() as i32;
    Some((top, top + pixels.height as i32))
}

fn outside_viewport(ctx: &Context, layer: &Layer) -> bool {
    // Always enter groups so children with pixels-but-no-geometry can warn
    // instead of being culled when `source_bounds` returns `None`.
    if layer.children.is_some() {
        return false;
    }
    source_bounds(layer)
        .is_none_or(|(top, bottom)| bottom <= ctx.viewport.top || top >= ctx.viewport.bottom)
}

fn warn_unsupported_blend(ctx: &mut Context, mode: BlendMode) {
    ctx.warnings.push(CompositeWarning::UnsupportedBlendMode {
        path: ctx.path.clone(),
        mode,
    });
}

fn effective_blend_mode(ctx: &mut Context, mode: BlendMode) -> BlendMode {
    if mode == BlendMode::Dissolve {
        features::report_dissolve(&mut ctx.warnings, &ctx.path, mode);
        return BlendMode::Normal;
    }
    if blend::supported(mode) {
        mode
    } else {
        warn_unsupported_blend(ctx, mode);
        BlendMode::Normal
    }
}

fn backdrop_is_empty(backdrop: &Backdrop) -> bool {
    backdrop.data.chunks_exact(4).all(|pixel| pixel[3] <= 0.0)
}

fn source_extends_outside_canvas(ctx: &Context, source: &PixelSource<'_>) -> bool {
    source.left < 0
        || source.top < 0
        || source.left + source.width as i32 > ctx.width as i32
        || source.top + source.height as i32 > ctx.canvas_height
}

/// Porter-Duff "over" plus optional blend-mode result. Algebra is unchanged:
/// `out = ((1-ba)*sa*src + (1-sa)*ba*dst + sa*ba*blended) / (sa + ba*(1-sa))`.
/// Normal/PassThrough/Dissolve use `blended == src`, which simplifies to
/// `(sa*src + ba*(1-sa)*dst) / out_a`.
#[inline]
fn write_blended_pixel(
    dest: &mut [f32],
    source_rgb: [f32; 3],
    source_alpha: f32,
    mode: BlendMode,
    source_is_normal: bool,
) {
    let backdrop_alpha = dest[3];
    if backdrop_alpha <= 0.0 || (source_alpha >= 1.0 && source_is_normal) {
        dest[0] = source_rgb[0];
        dest[1] = source_rgb[1];
        dest[2] = source_rgb[2];
        dest[3] = source_alpha;
        return;
    }
    let output_alpha = source_alpha + backdrop_alpha * (1.0 - source_alpha);
    if source_is_normal {
        let keep = backdrop_alpha * (1.0 - source_alpha);
        dest[0] = (source_alpha * source_rgb[0] + keep * dest[0]) / output_alpha;
        dest[1] = (source_alpha * source_rgb[1] + keep * dest[1]) / output_alpha;
        dest[2] = (source_alpha * source_rgb[2] + keep * dest[2]) / output_alpha;
        dest[3] = output_alpha;
        return;
    }
    let backdrop_rgb = [dest[0], dest[1], dest[2]];
    let blended = blend::apply(mode, backdrop_rgb, source_rgb);
    let source_weight = (1.0 - backdrop_alpha) * source_alpha;
    let backdrop_weight = (1.0 - source_alpha) * backdrop_alpha;
    let blend_weight = source_alpha * backdrop_alpha;
    dest[0] = (source_weight * source_rgb[0]
        + backdrop_weight * backdrop_rgb[0]
        + blend_weight * blended[0])
        / output_alpha;
    dest[1] = (source_weight * source_rgb[1]
        + backdrop_weight * backdrop_rgb[1]
        + blend_weight * blended[1])
        / output_alpha;
    dest[2] = (source_weight * source_rgb[2]
        + backdrop_weight * backdrop_rgb[2]
        + blend_weight * blended[2])
        / output_alpha;
    dest[3] = output_alpha;
}

fn is_source_copy_mode(mode: BlendMode) -> bool {
    matches!(
        mode,
        BlendMode::Normal | BlendMode::PassThrough | BlendMode::Dissolve
    )
}

fn blend_onto(
    ctx: &mut Context,
    backdrop: &mut Backdrop,
    source: &PixelSource<'_>,
    mode: BlendMode,
    opacity: f32,
    mask: Option<&LayerMaskData>,
) {
    if opacity <= 0.0 {
        return;
    }
    let effective_mode = effective_blend_mode(ctx, mode);
    if source_extends_outside_canvas(ctx, source) {
        features::report_clipped_to_canvas(&mut ctx.warnings, &ctx.path);
    }
    let mask = usable_mask(ctx, mask);
    let source_is_normal = is_source_copy_mode(effective_mode);
    let x0 = source.left.max(0);
    let y0 = source.top.max(ctx.viewport.top);
    let x1 = (source.left + source.width as i32).min(ctx.width as i32);
    let y1 = (source.top + source.height as i32).min(ctx.viewport.bottom);
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let src = source.data.as_ref();
    for y in y0..y1 {
        let src_row = ((y - source.top) as u32 * source.width) as usize * 4;
        let dst_row = ((y - ctx.viewport.top) as u32 * backdrop.width) as usize * 4;
        for x in x0..x1 {
            let si = src_row + (x - source.left) as usize * 4;
            let mut source_alpha = U8_TO_UNIT[src[si + 3] as usize] * opacity;
            if let Some(mask) = mask {
                source_alpha *= sample_mask(mask, x, y);
            }
            if source_alpha <= 0.0 {
                continue;
            }
            let bi = dst_row + x as usize * 4;
            let source_rgb = [
                U8_TO_UNIT[src[si] as usize],
                U8_TO_UNIT[src[si + 1] as usize],
                U8_TO_UNIT[src[si + 2] as usize],
            ];
            write_blended_pixel(
                &mut backdrop.data[bi..bi + 4],
                source_rgb,
                source_alpha,
                effective_mode,
                source_is_normal,
            );
        }
    }
}

fn blend_onto_f32(
    ctx: &mut Context,
    backdrop: &mut Backdrop,
    source: &Backdrop,
    source_left: i32,
    source_top: i32,
    mode: BlendMode,
    opacity: f32,
    mask: Option<&LayerMaskData>,
) {
    if opacity <= 0.0 {
        return;
    }
    let effective_mode = effective_blend_mode(ctx, mode);
    if source_left < 0
        || source_top < 0
        || source_left + source.width as i32 > ctx.width as i32
        || source_top + source.height as i32 > ctx.canvas_height
    {
        features::report_clipped_to_canvas(&mut ctx.warnings, &ctx.path);
    }
    let mask = usable_mask(ctx, mask);
    let source_is_normal = is_source_copy_mode(effective_mode);
    let x0 = source_left.max(0);
    let y0 = source_top.max(ctx.viewport.top);
    let x1 = (source_left + source.width as i32).min(ctx.width as i32);
    let y1 = (source_top + source.height as i32).min(ctx.viewport.bottom);
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    for y in y0..y1 {
        let src_row = ((y - source_top) as u32 * source.width) as usize * 4;
        let dst_row = ((y - ctx.viewport.top) as u32 * backdrop.width) as usize * 4;
        for x in x0..x1 {
            let si = src_row + (x - source_left) as usize * 4;
            let mut source_alpha = source.data[si + 3] * opacity;
            if let Some(mask) = mask {
                source_alpha *= sample_mask(mask, x, y);
            }
            if source_alpha <= 0.0 {
                continue;
            }
            let bi = dst_row + x as usize * 4;
            let source_rgb = [source.data[si], source.data[si + 1], source.data[si + 2]];
            write_blended_pixel(
                &mut backdrop.data[bi..bi + 4],
                source_rgb,
                source_alpha,
                effective_mode,
                source_is_normal,
            );
        }
    }
}

fn clip_color_lerp(
    ctx: &mut Context,
    region: &mut Backdrop,
    region_origin: (i32, i32),
    source: &PixelSource<'_>,
    mode: BlendMode,
    opacity: f32,
    mask: Option<&LayerMaskData>,
) {
    if opacity <= 0.0 {
        return;
    }
    let effective_mode = effective_blend_mode(ctx, mode);
    let mask = usable_mask(ctx, mask);
    let (region_left, region_top) = region_origin;
    let x0 = region_left.max(source.left);
    let y0 = region_top.max(source.top);
    let x1 = (region_left + region.width as i32).min(source.left + source.width as i32);
    let y1 = (region_top + region.height as i32).min(source.top + source.height as i32);
    for y in y0..y1 {
        for x in x0..x1 {
            let ri =
                (((y - region_top) as u32 * region.width + (x - region_left) as u32) * 4) as usize;
            if region.data[ri + 3] <= 0.0 {
                continue;
            }
            let si =
                (((y - source.top) as u32 * source.width + (x - source.left) as u32) * 4) as usize;
            let mut alpha = U8_TO_UNIT[source.data[si + 3] as usize] * opacity;
            if let Some(mask) = mask {
                alpha *= sample_mask(mask, x, y);
            }
            if alpha <= 0.0 {
                continue;
            }
            let source_rgb = [
                U8_TO_UNIT[source.data[si] as usize],
                U8_TO_UNIT[source.data[si + 1] as usize],
                U8_TO_UNIT[source.data[si + 2] as usize],
            ];
            let blended = if is_source_copy_mode(effective_mode) {
                source_rgb
            } else {
                let backdrop_rgb = [region.data[ri], region.data[ri + 1], region.data[ri + 2]];
                blend::apply(effective_mode, backdrop_rgb, source_rgb)
            };
            for channel in 0..3 {
                region.data[ri + channel] += alpha * (blended[channel] - region.data[ri + channel]);
            }
        }
    }
}

enum PreparedSource<'a> {
    Raster(PixelSource<'a>),
    Isolated {
        backdrop: Backdrop,
        left: i32,
        top: i32,
    },
}

impl PreparedSource<'_> {
    fn into_raster(self) -> PixelSource<'static> {
        match self {
            Self::Raster(source) => PixelSource {
                data: std::borrow::Cow::Owned(source.data.into_owned()),
                width: source.width,
                height: source.height,
                left: source.left,
                top: source.top,
            },
            Self::Isolated {
                backdrop,
                left,
                top,
            } => PixelSource {
                data: backdrop.to_rgba8().into(),
                width: backdrop.width,
                height: backdrop.height,
                left,
                top,
            },
        }
    }
}

fn layer_as_source<'a>(ctx: &mut Context, layer: &'a Layer) -> Option<PreparedSource<'a>> {
    if let Some(children) = &layer.children {
        let mut isolated =
            Backdrop::new(ctx.width, (ctx.viewport.bottom - ctx.viewport.top) as u32);
        render_layers(ctx, &mut isolated, children);
        return Some(PreparedSource::Isolated {
            backdrop: isolated,
            left: 0,
            top: ctx.viewport.top,
        });
    }
    if layer_has_decoded_pixels(layer) && layer_missing_geometry(layer) {
        warn_missing_geometry(ctx, layer);
        return None;
    }
    source_for(ctx, layer).map(PreparedSource::Raster)
}

fn render_unit(ctx: &mut Context, backdrop: &mut Backdrop, base: &Layer, clips: &[Layer]) {
    let opacity = (base.opacity.unwrap_or(1.0) * base.additional_info.fill_opacity.unwrap_or(1.0))
        .clamp(0.0, 1.0) as f32;
    let mode = base.blend_mode.unwrap_or(BlendMode::Normal);
    if base.children.is_some() && mode == BlendMode::PassThrough {
        if opacity == 1.0 && base.additional_info.mask.is_none() && clips.is_empty() {
            render_layers(ctx, backdrop, base.children.as_deref().unwrap_or_default());
            return;
        }
        features::report_pass_through_downgrade(&mut ctx.warnings, &ctx.path);
    }
    let Some(source) = layer_as_source(ctx, base) else {
        if base.additional_info.placed_layer.is_some() {
            ctx.warnings
                .push(CompositeWarning::SmartObjectWithoutRaster {
                    path: ctx.path.clone(),
                    name: layer_name(base),
                });
        }
        return;
    };
    let effective_mode = if mode == BlendMode::PassThrough {
        BlendMode::Normal
    } else {
        mode
    };
    if base.children.is_some()
        && ctx.path.len() == ctx.root_path_len
        && backdrop_is_empty(backdrop)
        && !matches!(
            mode,
            BlendMode::Normal | BlendMode::PassThrough | BlendMode::Dissolve
        )
    {
        features::report_top_level_blend_ineffective(&mut ctx.warnings, &ctx.path);
    }
    if clips.is_empty() {
        match source {
            PreparedSource::Raster(source) => blend_onto(
                ctx,
                backdrop,
                &source,
                effective_mode,
                opacity,
                base.additional_info.mask.as_ref(),
            ),
            PreparedSource::Isolated {
                backdrop: isolated,
                left,
                top,
            } => blend_onto_f32(
                ctx,
                backdrop,
                &isolated,
                left,
                top,
                effective_mode,
                opacity,
                base.additional_info.mask.as_ref(),
            ),
        }
        return;
    }
    let source = source.into_raster();
    let base_mask = usable_mask(ctx, base.additional_info.mask.as_ref());
    let mut region = Backdrop::new(source.width, source.height);
    for y in 0..source.height {
        for x in 0..source.width {
            let i = ((y * source.width + x) * 4) as usize;
            let doc_x = source.left + x as i32;
            let doc_y = source.top + y as i32;
            let mut alpha = U8_TO_UNIT[source.data[i + 3] as usize];
            if let Some(mask) = base_mask {
                alpha *= sample_mask(mask, doc_x, doc_y);
            }
            if alpha <= 0.0 {
                continue;
            }
            region.data[i] = U8_TO_UNIT[source.data[i] as usize];
            region.data[i + 1] = U8_TO_UNIT[source.data[i + 1] as usize];
            region.data[i + 2] = U8_TO_UNIT[source.data[i + 2] as usize];
            region.data[i + 3] = alpha;
        }
    }
    let base_path = ctx.path.clone();
    for (clip_offset, clip) in clips.iter().enumerate() {
        if clip.hidden.unwrap_or(false) {
            continue;
        }
        // Clipping siblings share the base's parent; replace the last index.
        ctx.path = base_path.clone();
        if let Some(last) = ctx.path.last_mut() {
            *last += 1 + clip_offset;
        } else {
            ctx.path.push(1 + clip_offset);
        }
        if outside_viewport(ctx, clip) {
            continue;
        }
        let Some(clip_source) = layer_as_source(ctx, clip) else {
            continue;
        };
        let clip_mode = match clip.blend_mode.unwrap_or(BlendMode::Normal) {
            BlendMode::PassThrough => BlendMode::Normal,
            value => value,
        };
        let clip_opacity = (clip.opacity.unwrap_or(1.0)
            * clip.additional_info.fill_opacity.unwrap_or(1.0))
        .clamp(0.0, 1.0) as f32;
        clip_color_lerp(
            ctx,
            &mut region,
            (source.left, source.top),
            &clip_source.into_raster(),
            clip_mode,
            clip_opacity,
            clip.additional_info.mask.as_ref(),
        );
    }
    ctx.path = base_path;
    blend_onto_f32(
        ctx,
        backdrop,
        &region,
        source.left,
        source.top,
        effective_mode,
        opacity,
        None,
    );
}

fn report_visible_features(ctx: &mut Context, layer: &Layer) {
    features::report_layer_features(&mut ctx.warnings, &ctx.path, layer);
}

fn process_layer(ctx: &mut Context, backdrop: &mut Backdrop, layers: &[Layer], base_index: usize) {
    let base = &layers[base_index];
    let mut index = base_index + 1;
    while index < layers.len() && layers[index].clipping.unwrap_or(false) {
        index += 1;
    }
    let clips = &layers[base_index + 1..index];
    if base.hidden.unwrap_or(false) || base.clipping.unwrap_or(false) {
        return;
    }
    report_visible_features(ctx, base);
    let base_path = ctx.path.clone();
    for (clip_offset, clip) in clips.iter().enumerate() {
        if clip.hidden.unwrap_or(false) {
            continue;
        }
        ctx.path = base_path.clone();
        if let Some(last) = ctx.path.last_mut() {
            *last += 1 + clip_offset;
        } else {
            ctx.path.push(1 + clip_offset);
        }
        report_visible_features(ctx, clip);
    }
    ctx.path = base_path;
    // Missing geometry is not "outside the viewport" — report it rather than
    // skipping silently via `source_bounds` returning `None`.
    if base.children.is_none() && layer_has_decoded_pixels(base) && layer_missing_geometry(base) {
        warn_missing_geometry(ctx, base);
        return;
    }
    if outside_viewport(ctx, base) {
        return;
    }
    render_unit(ctx, backdrop, base, clips);
}

fn render_layers(ctx: &mut Context, backdrop: &mut Backdrop, layers: &[Layer]) {
    let mut index = 0;
    while index < layers.len() {
        let base_index = index;
        index += 1;
        while index < layers.len() && layers[index].clipping.unwrap_or(false) {
            index += 1;
        }
        ctx.path.push(base_index);
        process_layer(ctx, backdrop, layers, base_index);
        ctx.path.pop();
    }
}

fn render_rooted_layer(ctx: &mut Context, backdrop: &mut Backdrop, layer: &Layer) {
    // Single target layer: `ctx.path` is already the document path. No clip siblings.
    if layer.hidden.unwrap_or(false) || layer.clipping.unwrap_or(false) {
        return;
    }
    report_visible_features(ctx, layer);
    if layer.children.is_none() && layer_has_decoded_pixels(layer) && layer_missing_geometry(layer)
    {
        warn_missing_geometry(ctx, layer);
        return;
    }
    if outside_viewport(ctx, layer) {
        return;
    }
    render_unit(ctx, backdrop, layer, &[]);
}

pub(crate) fn composite_layers(
    psd: &Psd,
    layers: &[Layer],
    viewport: Viewport,
    path: Vec<usize>,
    rooted: bool,
) -> (Backdrop, Vec<CompositeWarningReport>) {
    let mut backdrop = Backdrop::new(psd.width as u32, (viewport.bottom - viewport.top) as u32);
    let root_path_len = if rooted { path.len() } else { 1 };
    let mut ctx = Context {
        width: psd.width as u32,
        canvas_height: psd.height as i32,
        root_path_len,
        viewport,
        path,
        warnings: WarningLog::default(),
    };
    features::report_document_color_space(&mut ctx.warnings, psd);
    if rooted {
        if let Some(layer) = layers.first() {
            render_rooted_layer(&mut ctx, &mut backdrop, layer);
        }
    } else {
        render_layers(&mut ctx, &mut backdrop, layers);
    }
    (backdrop, ctx.warnings.into_reports())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{LayerAdditionalInfo, LayerTextData, PixelData, TextShapeType, TextStyle};
    use crate::{FontResolution, RasterPolicy, TextEdit};

    #[test]
    fn source_bounds_ignores_bit_depth() {
        let layer = Layer {
            top: Some(10.0),
            left: Some(0.0),
            image_data: Some(PixelData {
                width: 4,
                height: 6,
                data: vec![0u8; 4 * 6 * 4 * 2],
                depth: 16,
            }),
            ..Layer::default()
        };
        assert_eq!(source_bounds(&layer), Some((10, 16)));
    }

    #[test]
    fn sample_mask_without_pixels_or_unsupported_depth_is_fully_visible() {
        let empty = LayerMaskData {
            default_color: Some(0.0),
            ..LayerMaskData::default()
        };
        assert_eq!(sample_mask(&empty, 0, 0), 1.0);

        let deep = LayerMaskData {
            default_color: Some(0.0),
            image_data: Some(PixelData {
                width: 1,
                height: 1,
                data: vec![0u8; 8],
                depth: 16,
            }),
            left: Some(0.0),
            top: Some(0.0),
            right: Some(1.0),
            bottom: Some(1.0),
            ..LayerMaskData::default()
        };
        assert_eq!(sample_mask(&deep, 0, 0), 1.0);
    }

    #[test]
    fn usable_mask_warns_once_for_unsupported_depth_and_missing_pixels() {
        let deep = LayerMaskData {
            default_color: Some(0.0),
            image_data: Some(PixelData {
                width: 1,
                height: 1,
                data: vec![0u8; 8],
                depth: 16,
            }),
            ..LayerMaskData::default()
        };
        let empty = LayerMaskData {
            default_color: Some(0.0),
            ..LayerMaskData::default()
        };

        let mut ctx = Context {
            width: 2,
            canvas_height: 2,
            root_path_len: 1,
            viewport: Viewport { top: 0, bottom: 2 },
            path: vec![0, 1],
            warnings: WarningLog::default(),
        };
        assert!(usable_mask(&mut ctx, Some(&deep)).is_none());
        assert!(usable_mask(&mut ctx, Some(&empty)).is_none());
        let reports = ctx.warnings.into_reports();
        assert_eq!(reports.len(), 2);
        assert!(matches!(
            &reports[0].warning,
            CompositeWarning::MaskIgnored {
                path,
                reason: MaskIgnoredReason::UnsupportedDepth { depth: 16 }
            } if path == &[0, 1]
        ));
        assert!(matches!(
            &reports[1].warning,
            CompositeWarning::MaskIgnored {
                path,
                reason: MaskIgnoredReason::NoPixelData
            } if path == &[0, 1]
        ));
    }

    #[test]
    fn short_buffer_is_reported() {
        let mut ctx = Context {
            width: 2,
            canvas_height: 2,
            root_path_len: 1,
            viewport: Viewport { top: 0, bottom: 2 },
            path: vec![0],
            warnings: WarningLog::default(),
        };
        let layer = Layer {
            additional_info: LayerAdditionalInfo {
                name: Some("Short".into()),
                ..LayerAdditionalInfo::default()
            },
            left: Some(0.0),
            top: Some(0.0),
            image_data: Some(PixelData::rgba8(2, 2, vec![255, 0, 0, 255])),
            ..Layer::default()
        };
        assert!(source_for(&mut ctx, &layer).is_none());
        let reports = ctx.warnings.into_reports();
        assert!(matches!(
            &reports[0].warning,
            CompositeWarning::MalformedRaster {
                path,
                expected: 16,
                found: 4,
                ..
            } if path == &[0]
        ));
    }

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
        PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
    }

    fn point_text_group_psd() -> Psd {
        let text_layer = Layer {
            left: Some(40.0),
            top: Some(30.0),
            right: Some(48.0),
            bottom: Some(38.0),
            image_data: Some(solid(8, 8, [255, 0, 0, 255])),
            additional_info: LayerAdditionalInfo {
                name: Some("Point".into()),
                text: Some(LayerTextData {
                    text: "hi".into(),
                    shape_type: Some(TextShapeType::Point),
                    top: Some(1.0),
                    left: Some(2.0),
                    bottom: Some(3.0),
                    right: Some(4.0),
                    point_base: Some(vec![0.0, 0.0]),
                    transform: Some(vec![1.0, 0.0, 0.0, 1.0, 40.0, 30.0]),
                    style: Some(TextStyle::default()),
                    ..Default::default()
                }),
                ..LayerAdditionalInfo::default()
            },
            ..Layer::default()
        };
        let group = Layer {
            additional_info: LayerAdditionalInfo {
                name: Some("Group".into()),
                ..LayerAdditionalInfo::default()
            },
            children: Some(vec![text_layer]),
            ..Layer::default()
        };
        Psd {
            width: 64.0,
            height: 64.0,
            color_mode: Some(crate::psd::ColorMode::Rgb),
            children: Some(vec![group]),
            ..Psd::default()
        }
    }

    fn sample_rgba(backdrop: &Backdrop, x: i32, y: i32) -> [u8; 4] {
        let rgba = backdrop.to_rgba8();
        let i = ((y as u32 * backdrop.width + x as u32) * 4) as usize;
        [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]]
    }

    #[test]
    fn point_text_leave_does_not_composite_stale_raster_at_origin() {
        let mut psd = point_text_group_psd();
        {
            let mut session =
                TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).unwrap();
            session
                .layer_at(&[0, 0])
                .unwrap()
                .set_text("edited")
                .unwrap();
            let _ = session.finish();
        }
        let (backdrop, _) = composite_layers(
            &psd,
            std::slice::from_ref(&psd.children.as_ref().unwrap()[0]),
            Viewport { top: 0, bottom: 64 },
            vec![0],
            true,
        );
        assert_ne!(
            sample_rgba(&backdrop, 0, 0),
            [255, 0, 0, 255],
            "stale point-text raster was composited at document origin"
        );
        assert!(
            !backdrop
                .to_rgba8()
                .chunks_exact(4)
                .any(|px| px == [255, 0, 0, 255]),
            "stale red raster still present in the composite"
        );
    }

    #[test]
    fn missing_geometry_skips_draw_and_warns() {
        let mut psd = point_text_group_psd();
        {
            let layer = &mut psd.children.as_mut().unwrap()[0].children.as_mut().unwrap()[0];
            layer.left = None;
            layer.top = None;
            layer.right = None;
            layer.bottom = None;
        }
        let (backdrop, warnings) = composite_layers(
            &psd,
            std::slice::from_ref(&psd.children.as_ref().unwrap()[0]),
            Viewport { top: 0, bottom: 64 },
            vec![0],
            true,
        );
        assert!(
            warnings.iter().any(|r| matches!(
                &r.warning,
                CompositeWarning::MissingGeometry { path, .. } if path == &[0, 0]
            )),
            "expected MissingGeometry at [0,0], got {warnings:?}"
        );
        assert_ne!(sample_rgba(&backdrop, 0, 0), [255, 0, 0, 255]);
        assert!(
            !backdrop
                .to_rgba8()
                .chunks_exact(4)
                .any(|px| px == [255, 0, 0, 255])
        );
    }
}

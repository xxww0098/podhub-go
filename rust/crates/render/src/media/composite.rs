use crate::media::blend::{blend_channel, composite_straight, is_supported};
use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::model::RenderDocument;
use crate::media::raster::{Backdrop, PixelSource, backdrop_to_bytes, new_backdrop};
use crate::psd::LayerNode;
use std::borrow::Cow;

const BYTE_TO_UNIT: [f64; 256] = {
    let mut table = [0.0; 256];
    let mut index = 0;
    while index < 256 {
        table[index] = index as f64 / 255.0;
        index += 1;
    }
    table
};

/// How a layer's pixels are fetched: the slab hands back the band it holds
/// rather than a whole frame, so resolution is a callback, not a buffer.
type ResolvePixels<'a> = Box<dyn Fn(&LayerNode) -> Option<PixelSource<'a>> + 'a>;

pub(super) struct CompositeOptions<'a> {
    pub resolve_pixels: Option<ResolvePixels<'a>>,
    pub viewport_top: i64,
    pub viewport_bottom: i64,
}

struct CompositeContext<'a> {
    resolve: ResolvePixels<'a>,
    viewport_top: i64,
    viewport_bottom: i64,
}

type MaskSampler = Box<dyn Fn(i64, i64) -> f64>;

pub(super) fn composite_document<'a>(
    doc: &'a RenderDocument,
    options: CompositeOptions<'a>,
) -> Result<Backdrop, MediaError> {
    composite_layers(doc, &doc.children, options)
}

pub(super) fn composite_group<'a>(
    doc: &'a RenderDocument,
    group: &'a LayerNode,
    options: CompositeOptions<'a>,
) -> Result<Backdrop, MediaError> {
    composite_layers(doc, std::slice::from_ref(group), options)
}

fn composite_layers<'a>(
    doc: &RenderDocument,
    layers: &'a [LayerNode],
    options: CompositeOptions<'a>,
) -> Result<Backdrop, MediaError> {
    let resolve = options.resolve_pixels.unwrap_or_else(|| Box::new(|_| None));
    let mut ctx = CompositeContext {
        resolve,
        viewport_top: options.viewport_top,
        viewport_bottom: options.viewport_bottom,
    };
    let height = (ctx.viewport_bottom - ctx.viewport_top).max(0) as u32;
    let mut backdrop = new_backdrop(doc.width, height)?;
    render_layers(&mut ctx, &mut backdrop, layers, doc.width, doc.height)?;
    Ok(backdrop)
}

fn default_resolve<'l>(layer: &'l LayerNode) -> Option<PixelSource<'l>> {
    let image = layer.image_data.as_ref()?;
    if image.width == 0 || image.height == 0 {
        return None;
    }
    Some(PixelSource {
        data: Cow::Borrowed(image.data.as_slice()),
        width: image.width,
        height: image.height,
        left: layer.left,
        top: layer.top,
    })
}

fn mask_sampler(layer: &LayerNode) -> Option<MaskSampler> {
    let mask = layer.mask.as_ref()?;
    if mask.disabled {
        return None;
    }
    let default_color = mask.default_color as f64 / 255.0;
    let left = mask.left;
    let top = mask.top;
    let right = mask.right;
    let bottom = mask.bottom;
    let image = mask.image_data.clone();
    Some(Box::new(move |x, y| {
        if x < left || x >= right || y < top || y >= bottom {
            return default_color;
        }
        let Some(image) = &image else {
            return default_color;
        };
        let local_x = (x - left) as u32;
        let local_y = (y - top) as u32;
        if local_x >= image.width || local_y >= image.height {
            return default_color;
        }
        image.data[((local_y * image.width + local_x) * 4) as usize] as f64 / 255.0
    }))
}

fn blend_mode_name(mode: &str) -> &str {
    if mode == "pass through" {
        "normal"
    } else {
        mode
    }
}

fn blend_onto(
    ctx: &mut CompositeContext<'_>,
    backdrop: &mut Backdrop,
    source: &PixelSource<'_>,
    mode: &str,
    opacity: f64,
    mask: Option<&MaskSampler>,
) -> Result<(), MediaError> {
    if opacity <= 0.0 {
        return Ok(());
    }
    let mode = blend_mode_name(mode);
    if !is_supported(mode) {
        return Err(MediaError::new(
            MediaErrorCode::UnsupportedCapability,
            "compositing",
            format!("unsupported blend mode \"{mode}\""),
        ));
    }
    let x0 = 0_i64.max(source.left);
    let y0 = ctx.viewport_top.max(source.top);
    let x1 = (backdrop.width as i64).min(source.left + source.width as i64);
    let y1 = ctx.viewport_bottom.min(source.top + source.height as i64);
    for y in y0..y1 {
        let srow = ((y - source.top) * source.width as i64) as usize;
        let brow = ((y - ctx.viewport_top) * backdrop.width as i64) as usize;
        for x in x0..x1 {
            let si = (srow + (x - source.left) as usize) * 4;
            let mut source_alpha = BYTE_TO_UNIT[source.data[si + 3] as usize] * opacity;
            if let Some(mask) = mask {
                source_alpha *= mask(x, y);
            }
            if source_alpha <= 0.0 {
                continue;
            }
            let bi = (brow + x as usize) * 4;
            let backdrop_alpha = f64::from(backdrop.data[bi + 3]);
            let source_r = BYTE_TO_UNIT[source.data[si] as usize];
            let source_g = BYTE_TO_UNIT[source.data[si + 1] as usize];
            let source_b = BYTE_TO_UNIT[source.data[si + 2] as usize];
            let backdrop_r = f64::from(backdrop.data[bi]);
            let backdrop_g = f64::from(backdrop.data[bi + 1]);
            let backdrop_b = f64::from(backdrop.data[bi + 2]);
            let blended_r = blend_channel(mode, backdrop_r, source_r);
            let blended_g = blend_channel(mode, backdrop_g, source_g);
            let blended_b = blend_channel(mode, backdrop_b, source_b);
            let (red, alpha) = composite_straight(
                backdrop_r,
                source_r,
                source_alpha,
                blended_r,
                backdrop_alpha,
            );
            let (green, _) = composite_straight(
                backdrop_g,
                source_g,
                source_alpha,
                blended_g,
                backdrop_alpha,
            );
            let (blue, _) = composite_straight(
                backdrop_b,
                source_b,
                source_alpha,
                blended_b,
                backdrop_alpha,
            );
            backdrop.data[bi] = red as f32;
            backdrop.data[bi + 1] = green as f32;
            backdrop.data[bi + 2] = blue as f32;
            backdrop.data[bi + 3] = alpha as f32;
        }
    }
    Ok(())
}

fn layer_as_source<'a>(
    ctx: &mut CompositeContext<'a>,
    layer: &'a LayerNode,
    doc_width: u32,
) -> Result<Option<PixelSource<'a>>, MediaError> {
    if layer.is_group() {
        let height = (ctx.viewport_bottom - ctx.viewport_top).max(0) as u32;
        let mut temp = new_backdrop(doc_width, height)?;
        render_layers(ctx, &mut temp, &layer.children, doc_width, 0)?;
        return Ok(Some(PixelSource {
            data: Cow::Owned(backdrop_to_bytes(&temp)),
            width: temp.width,
            height: temp.height,
            left: 0,
            top: ctx.viewport_top,
        }));
    }
    Ok((ctx.resolve)(layer).or_else(|| default_resolve(layer)))
}

fn render_unit<'a>(
    ctx: &mut CompositeContext<'a>,
    backdrop: &mut Backdrop,
    base: &'a LayerNode,
    clips: &[&'a LayerNode],
    doc_width: u32,
) -> Result<(), MediaError> {
    let opacity = base.opacity * base.fill_opacity;
    let mode = base.blend_mode.as_str();
    // Groups always go through `layer_as_source`, which composites the children
    // into their own full-width backdrop before blending that result down. A
    // "pass through" group with unit opacity, no mask and no clipping layers used
    // to skip that and render its children straight into the parent backdrop;
    // that shortcut made the peak live bytes of a nested template depend on the
    // blend mode the exporter happened to write, so a group's cost could not be
    // priced from the layer tree alone. It is gone on purpose: every group level
    // now costs one backdrop allocation, and the depth of that cost is what
    // `slab::group_saturating_live_bytes` prices.
    let Some(source) = layer_as_source(ctx, base, doc_width)? else {
        return Ok(());
    };
    let effective_mode = if mode == "pass through" {
        "normal"
    } else {
        mode
    };
    if clips.is_empty() {
        blend_onto(
            ctx,
            backdrop,
            &source,
            effective_mode,
            opacity,
            mask_sampler(base).as_ref(),
        )?;
        return Ok(());
    }
    let region_left = source.left.max(0);
    let region_top = source.top.max(ctx.viewport_top);
    let region_right = (source.left + i64::from(source.width)).min(i64::from(doc_width));
    let region_bottom = (source.top + i64::from(source.height)).min(ctx.viewport_bottom);
    if region_right <= region_left || region_bottom <= region_top {
        return Ok(());
    }
    let mut region = new_backdrop(
        (region_right - region_left) as u32,
        (region_bottom - region_top) as u32,
    )?;
    let base_mask = mask_sampler(base);
    for y in region_top..region_bottom {
        for x in region_left..region_right {
            let source_index =
                (((y - source.top) * i64::from(source.width) + (x - source.left)) * 4) as usize;
            let region_index =
                (((y - region_top) * i64::from(region.width) + (x - region_left)) * 4) as usize;
            let mut alpha = BYTE_TO_UNIT[source.data[source_index + 3] as usize];
            if let Some(mask) = &base_mask {
                alpha *= mask(x, y);
            }
            if alpha <= 0.0 {
                continue;
            }
            region.data[region_index] = BYTE_TO_UNIT[source.data[source_index] as usize] as f32;
            region.data[region_index + 1] =
                BYTE_TO_UNIT[source.data[source_index + 1] as usize] as f32;
            region.data[region_index + 2] =
                BYTE_TO_UNIT[source.data[source_index + 2] as usize] as f32;
            region.data[region_index + 3] = alpha as f32;
        }
    }
    for clip in clips {
        if clip.hidden {
            continue;
        }
        let Some(clip_source) = layer_as_source(ctx, clip, doc_width)? else {
            continue;
        };
        clip_color_lerp(
            ctx,
            &mut region,
            region_left,
            region_top,
            &clip_source,
            blend_mode_name(&clip.blend_mode),
            clip.opacity * clip.fill_opacity,
            mask_sampler(clip).as_ref(),
        )?;
    }
    let merged = PixelSource {
        data: Cow::Owned(backdrop_to_bytes(&region)),
        width: region.width,
        height: region.height,
        left: region_left,
        top: region_top,
    };
    blend_onto(ctx, backdrop, &merged, effective_mode, opacity, None)?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn clip_color_lerp(
    _ctx: &mut CompositeContext<'_>,
    region: &mut Backdrop,
    region_left: i64,
    region_top: i64,
    source: &PixelSource<'_>,
    mode: &str,
    opacity: f64,
    mask: Option<&MaskSampler>,
) -> Result<(), MediaError> {
    if opacity <= 0.0 {
        return Ok(());
    }
    if !is_supported(mode) {
        return Err(MediaError::new(
            MediaErrorCode::UnsupportedCapability,
            "compositing",
            format!("unsupported blend mode \"{mode}\""),
        ));
    }
    let x0 = region_left.max(source.left);
    let y0 = region_top.max(source.top);
    let x1 = (region_left + region.width as i64).min(source.left + source.width as i64);
    let y1 = (region_top + region.height as i64).min(source.top + source.height as i64);
    for y in y0..y1 {
        let srow = ((y - source.top) * source.width as i64) as usize;
        let rrow = ((y - region_top) * region.width as i64) as usize;
        for x in x0..x1 {
            let ri = (rrow + (x - region_left) as usize) * 4;
            if region.data[ri + 3] <= 0.0 {
                continue;
            }
            let si = (srow + (x - source.left) as usize) * 4;
            let mut source_alpha = BYTE_TO_UNIT[source.data[si + 3] as usize] * opacity;
            if let Some(mask) = mask {
                source_alpha *= mask(x, y);
            }
            if source_alpha <= 0.0 {
                continue;
            }
            let cb_r = f64::from(region.data[ri]);
            let cb_g = f64::from(region.data[ri + 1]);
            let cb_b = f64::from(region.data[ri + 2]);
            let cs_r = BYTE_TO_UNIT[source.data[si] as usize];
            let cs_g = BYTE_TO_UNIT[source.data[si + 1] as usize];
            let cs_b = BYTE_TO_UNIT[source.data[si + 2] as usize];
            let b_r = blend_channel(mode, cb_r, cs_r);
            let b_g = blend_channel(mode, cb_g, cs_g);
            let b_b = blend_channel(mode, cb_b, cs_b);
            region.data[ri] = (cb_r + source_alpha * (b_r - cb_r)) as f32;
            region.data[ri + 1] = (cb_g + source_alpha * (b_g - cb_g)) as f32;
            region.data[ri + 2] = (cb_b + source_alpha * (b_b - cb_b)) as f32;
        }
    }
    Ok(())
}

fn render_layers<'a>(
    ctx: &mut CompositeContext<'a>,
    backdrop: &mut Backdrop,
    layers: &'a [LayerNode],
    doc_width: u32,
    _doc_height: u32,
) -> Result<(), MediaError> {
    let mut index = 0;
    while index < layers.len() {
        let base = &layers[index];
        index += 1;
        let mut clips = Vec::new();
        while index < layers.len() && layers[index].clipping {
            clips.push(&layers[index]);
            index += 1;
        }
        if base.hidden || base.clipping {
            continue;
        }
        render_unit(ctx, backdrop, base, &clips, doc_width)?;
    }
    Ok(())
}

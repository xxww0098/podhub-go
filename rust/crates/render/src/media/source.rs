use crate::media::error::{MediaError, MediaErrorCode};
use crate::media::intent::FitMode;
use crate::media::model::SourceContent;
use crate::psd::RenderDocument;
use image::{ImageError, ImageReader};
use std::io::{BufReader, Cursor};

pub(super) fn is_psd_bytes(bytes: &[u8]) -> bool {
    bytes.len() >= 4 && &bytes[..4] == b"8BPS"
}

fn decode_png(
    bytes: &[u8],
    policy: crate::psd::ProductResourcePolicy,
) -> Result<SourceContent, MediaError> {
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > policy.max_input_bytes {
        return Err(MediaError::resource_limit(
            MediaErrorCode::InputTooLarge,
            "png-decode",
            bytes.len() as u128,
            u128::from(policy.max_input_bytes),
            policy,
        ));
    }
    let mut decoder = png::Decoder::new(BufReader::new(Cursor::new(bytes)));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|error| {
        MediaError::new(MediaErrorCode::ParseFailed, "png-decode", error.to_string())
    })?;
    let (color_type, bit_depth) = reader.output_color_type();
    if bit_depth != png::BitDepth::Eight {
        return Err(MediaError::new(
            MediaErrorCode::UnsupportedCapability,
            "png-decode",
            format!("unsupported PNG output format: {color_type:?} {bit_depth:?}"),
        ));
    }
    let (width, height) = reader.info().size();
    let (decode_len, rgba_len) = admit_png_allocation(width, height, color_type, policy)?;
    let mut buffer = Vec::new();
    buffer.try_reserve_exact(decode_len).map_err(|_| {
        MediaError::new(
            MediaErrorCode::Io,
            "png-decode",
            "unable to reserve bounded PNG decode buffer",
        )
    })?;
    buffer.resize(decode_len, 0);
    let info = reader.next_frame(&mut buffer).map_err(|error| {
        MediaError::new(MediaErrorCode::ParseFailed, "png-decode", error.to_string())
    })?;
    buffer.truncate(info.buffer_size());
    let rgba = match info.color_type {
        png::ColorType::Rgba => buffer,
        color_type => {
            let mut rgba = Vec::new();
            rgba.try_reserve_exact(rgba_len).map_err(|_| {
                MediaError::new(
                    MediaErrorCode::Io,
                    "png-decode",
                    "unable to reserve bounded PNG RGBA buffer",
                )
            })?;
            match color_type {
                png::ColorType::Rgb => {
                    for chunk in buffer.chunks_exact(3) {
                        rgba.extend_from_slice(chunk);
                        rgba.push(255);
                    }
                }
                png::ColorType::Grayscale => {
                    for &gray in &buffer {
                        rgba.extend_from_slice(&[gray, gray, gray, 255]);
                    }
                }
                png::ColorType::GrayscaleAlpha => {
                    for chunk in buffer.chunks_exact(2) {
                        rgba.extend_from_slice(&[chunk[0], chunk[0], chunk[0], chunk[1]]);
                    }
                }
                other => {
                    return Err(MediaError::new(
                        MediaErrorCode::UnsupportedCapability,
                        "png-decode",
                        format!("unsupported PNG color type: {other:?}"),
                    ));
                }
            }
            rgba
        }
    };
    Ok(SourceContent {
        data: rgba,
        width,
        height,
    })
}

fn admit_png_allocation(
    width: u32,
    height: u32,
    color_type: png::ColorType,
    policy: crate::psd::ProductResourcePolicy,
) -> Result<(usize, usize), MediaError> {
    let pixels = u128::from(width).saturating_mul(u128::from(height));
    if width > policy.max_psb_side
        || height > policy.max_psb_side
        || pixels > u128::from(policy.max_canvas_pixels)
    {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "png-decode",
            pixels.max(u128::from(width.max(height))),
            u128::from(policy.max_canvas_pixels),
            policy,
        ));
    }
    let decode_channels = match color_type {
        png::ColorType::Grayscale => 1_u128,
        png::ColorType::GrayscaleAlpha => 2_u128,
        png::ColorType::Rgb => 3_u128,
        png::ColorType::Rgba => 4_u128,
        _ => {
            return Err(MediaError::new(
                MediaErrorCode::UnsupportedCapability,
                "png-decode",
                "unsupported PNG color type",
            ));
        }
    };
    let decode_bytes = pixels.saturating_mul(decode_channels);
    let rgba_bytes = pixels.saturating_mul(4);
    let live_bytes = if color_type == png::ColorType::Rgba {
        decode_bytes
    } else {
        decode_bytes.saturating_add(rgba_bytes)
    };
    if live_bytes > policy.max_parser_live_bytes as u128 {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "png-decode",
            live_bytes,
            policy.max_parser_live_bytes as u128,
            policy,
        ));
    }
    let decode_len = usize::try_from(decode_bytes).map_err(|_| {
        MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "png-decode",
            decode_bytes,
            policy.max_parser_live_bytes as u128,
            policy,
        )
    })?;
    let rgba_len = usize::try_from(rgba_bytes).map_err(|_| {
        MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "png-decode",
            rgba_bytes,
            policy.max_parser_live_bytes as u128,
            policy,
        )
    })?;
    Ok((decode_len, rgba_len))
}

fn decode_raster_with_policy(
    bytes: &[u8],
    policy: crate::psd::ProductResourcePolicy,
) -> Result<SourceContent, MediaError> {
    let limits = policy.parser_limits();
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|error| {
            MediaError::new(
                MediaErrorCode::ParseFailed,
                "raster-decode",
                error.to_string(),
            )
        })?;
    if reader.format().is_none() {
        return Err(MediaError::new(
            MediaErrorCode::ParseFailed,
            "raster-decode",
            "source image format is not PNG, JPEG, or WebP",
        ));
    }
    if reader.format() == Some(image::ImageFormat::Png) {
        // Preserve the certified PNG parity path byte-for-byte; JPEG/WebP
        // (design sources and template-linked rasters) use the generic decoder.
        return decode_png(bytes, policy);
    }
    let mut decode_limits = image::Limits::default();
    decode_limits.max_image_width = Some(limits.max_psb_side);
    decode_limits.max_image_height = Some(limits.max_psb_side);
    decode_limits.max_alloc = Some(limits.max_decode_memory_bytes as u64);
    reader.limits(decode_limits);
    let decoded = reader.decode().map_err(map_image_error)?;
    let width = decoded.width();
    let height = decoded.height();
    if u64::from(width) * u64::from(height) > limits.max_pixels {
        return Err(MediaError::new(
            MediaErrorCode::DimensionLimit,
            "raster-decode",
            "source image pixel count exceeds the workflow limit",
        ));
    }
    let rgba = decoded.into_rgba8().into_raw();
    Ok(SourceContent {
        data: rgba,
        width,
        height,
    })
}

fn map_image_error(error: ImageError) -> MediaError {
    let code = match error {
        ImageError::Limits(_) => MediaErrorCode::DimensionLimit,
        ImageError::Unsupported(_) => MediaErrorCode::UnsupportedCapability,
        _ => MediaErrorCode::ParseFailed,
    };
    MediaError::new(code, "raster-decode", error.to_string())
}

#[derive(Debug, Clone)]
pub(super) enum LinkedSource {
    Bitmap(SourceContent),
    Document(RenderDocument),
}

pub(super) fn decode_linked_bytes(
    bytes: &[u8],
    policy: crate::psd::ProductResourcePolicy,
) -> Result<LinkedSource, MediaError> {
    if is_psd_bytes(bytes) {
        let document = crate::psd::render::load_render_document(bytes, policy.parser_limits())
            .map_err(MediaError::from)?;
        return Ok(LinkedSource::Document(document));
    }
    Ok(LinkedSource::Bitmap(decode_raster_with_policy(
        bytes, policy,
    )?))
}

/// Decodes the design raster and resizes it onto the slot the template reserved.
///
/// `policy` is the same resource policy the rest of the render was admitted
/// against, and it is the only source of the byte and pixel ceilings used here.
/// Hardcoding the defaults would let a deployment that lowered its limits still
/// allocate the default allowance while resizing.
pub(super) fn design_source(
    bytes: &[u8],
    slot_w: u32,
    slot_h: u32,
    fit: FitMode,
    policy: crate::psd::ProductResourcePolicy,
) -> Result<SourceContent, MediaError> {
    let decoded = decode_raster_with_policy(bytes, policy)?;
    resize_source(&decoded, slot_w, slot_h, fit, policy)
}

fn resize_source(
    source: &SourceContent,
    target_w: u32,
    target_h: u32,
    fit: FitMode,
    policy: crate::psd::ProductResourcePolicy,
) -> Result<SourceContent, MediaError> {
    let (draw_w, draw_h, offset_x, offset_y) = match fit {
        FitMode::Fill => (target_w, target_h, 0, 0),
        FitMode::Cover => {
            let scale =
                (target_w as f64 / source.width as f64).max(target_h as f64 / source.height as f64);
            let draw_w = checked_scaled_dimension(source.width, scale, "width")?;
            let draw_h = checked_scaled_dimension(source.height, scale, "height")?;
            (
                draw_w,
                draw_h,
                ((target_w as i64 - draw_w as i64) / 2).max(0),
                ((target_h as i64 - draw_h as i64) / 2).max(0),
            )
        }
        FitMode::Contain => {
            let scale =
                (target_w as f64 / source.width as f64).min(target_h as f64 / source.height as f64);
            let draw_w = checked_scaled_dimension(source.width, scale, "width")?;
            let draw_h = checked_scaled_dimension(source.height, scale, "height")?;
            (
                draw_w,
                draw_h,
                ((target_w as i64 - draw_w as i64) / 2).max(0),
                ((target_h as i64 - draw_h as i64) / 2).max(0),
            )
        }
    };
    let reuse_resized = draw_w == target_w && draw_h == target_h && offset_x == 0 && offset_y == 0;
    admit_resize_allocation(
        source.data.len(),
        draw_w,
        draw_h,
        target_w,
        target_h,
        reuse_resized,
        policy,
    )?;
    let resized = crate::media::raster::resize_rgba(
        &source.data,
        source.width,
        source.height,
        draw_w,
        draw_h,
    )?;
    if reuse_resized {
        return Ok(SourceContent {
            data: resized,
            width: target_w,
            height: target_h,
        });
    }
    let canvas_len = usize::try_from(
        u64::from(target_w)
            .checked_mul(u64::from(target_h))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| {
                MediaError::new(
                    MediaErrorCode::DimensionLimit,
                    "source-resize",
                    "canvas dimensions overflow",
                )
            })?,
    )
    .map_err(|_| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "source-resize",
            "canvas is too large",
        )
    })?;
    let mut canvas = vec![0_u8; canvas_len];
    for y in 0..draw_h {
        for x in 0..draw_w {
            let dst_x = x as i64 + offset_x;
            let dst_y = y as i64 + offset_y;
            if dst_x < 0 || dst_y < 0 || dst_x >= target_w as i64 || dst_y >= target_h as i64 {
                continue;
            }
            let si = ((y * draw_w + x) * 4) as usize;
            let di = (((dst_y as u32) * target_w + (dst_x as u32)) * 4) as usize;
            canvas[di..di + 4].copy_from_slice(&resized[si..si + 4]);
        }
    }
    Ok(SourceContent {
        data: canvas,
        width: target_w,
        height: target_h,
    })
}

fn checked_scaled_dimension(value: u32, scale: f64, axis: &'static str) -> Result<u32, MediaError> {
    let scaled = f64::from(value) * scale;
    if !scaled.is_finite() || scaled < 0.0 || scaled > f64::from(u32::MAX) {
        return Err(MediaError::new(
            MediaErrorCode::DimensionLimit,
            "source-resize",
            format!("scaled {axis} exceeds u32"),
        ));
    }
    Ok(scaled.round() as u32)
}

fn admit_resize_allocation(
    source_bytes: usize,
    draw_width: u32,
    draw_height: u32,
    target_width: u32,
    target_height: u32,
    reuse_resized: bool,
    policy: crate::psd::ProductResourcePolicy,
) -> Result<(), MediaError> {
    let pixels = |width: u32, height: u32| u128::from(width).saturating_mul(u128::from(height));
    let draw_pixels = pixels(draw_width, draw_height);
    let target_pixels = pixels(target_width, target_height);
    if draw_width > policy.max_psb_side
        || draw_height > policy.max_psb_side
        || target_width > policy.max_psb_side
        || target_height > policy.max_psb_side
        || draw_pixels > u128::from(policy.max_canvas_pixels)
        || target_pixels > u128::from(policy.max_canvas_pixels)
    {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "source-resize",
            draw_pixels
                .max(target_pixels)
                .max(u128::from(draw_width.max(draw_height)))
                .max(u128::from(target_width.max(target_height))),
            u128::from(policy.max_canvas_pixels),
            policy,
        ));
    }
    let resized_bytes = draw_pixels.saturating_mul(4);
    let canvas_bytes = if reuse_resized {
        0
    } else {
        target_pixels.saturating_mul(4)
    };
    let live_bytes = (source_bytes as u128)
        .checked_add(resized_bytes)
        .and_then(|bytes| bytes.checked_add(canvas_bytes))
        .unwrap_or(u128::MAX);
    if live_bytes > policy.max_parser_live_bytes as u128 {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            "source-resize",
            live_bytes,
            policy.max_parser_live_bytes as u128,
            policy,
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{decode_raster_with_policy, design_source};
    use crate::media::error::MediaErrorCode;
    use crate::media::intent::FitMode;
    use crate::psd::ProductResourcePolicy;

    fn png_bytes(
        color_type: png::ColorType,
        bit_depth: png::BitDepth,
        data: &[u8],
        palette: Option<&[u8]>,
        trns: Option<&[u8]>,
    ) -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, 2, 1);
        encoder.set_color(color_type);
        encoder.set_depth(bit_depth);
        if let Some(palette) = palette {
            encoder.set_palette(palette);
        }
        if let Some(trns) = trns {
            encoder.set_trns(trns);
        }
        let mut writer = encoder.write_header().expect("PNG header");
        writer.write_image_data(data).expect("PNG pixels");
        drop(writer);
        bytes
    }

    /// One RGB PNG of the requested size, filled with a single colour.
    fn solid_rgb_png(width: u32, height: u32) -> Vec<u8> {
        let data: Vec<u8> = (0..width * height).flat_map(|_| [10_u8, 20, 30]).collect();
        let mut bytes = Vec::new();
        let mut encoder = png::Encoder::new(&mut bytes, width, height);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().expect("PNG header");
        writer.write_image_data(&data).expect("PNG pixels");
        drop(writer);
        bytes
    }

    #[test]
    fn design_source_holds_the_resize_to_the_ceiling_it_was_given() {
        let png = solid_rgb_png(8, 8);
        let admitted = design_source(
            &png,
            16,
            16,
            FitMode::Fill,
            ProductResourcePolicy::default(),
        )
        .expect("design decode and resize under the default policy");
        assert_eq!((admitted.width, admitted.height), (16, 16));
        assert_eq!(admitted.data.len(), 16 * 16 * 4);

        // Decoding an 8x8 RGB PNG costs 8*8*3 bytes of samples plus 8*8*4 bytes
        // of RGBA, so this ceiling admits the decode and leaves the resize to
        // enforce the same ceiling: 256 source bytes plus a 16x16 RGBA result.
        let lowered = ProductResourcePolicy {
            max_parser_live_bytes: 1024,
            ..ProductResourcePolicy::default()
        };
        let error = design_source(&png, 16, 16, FitMode::Fill, lowered)
            .expect_err("the resize must honour the configured ceiling");
        assert_eq!(error.code, MediaErrorCode::DimensionLimit);
        assert_eq!(error.phase, "source-resize");
        assert!(error.detail.contains("1280"), "{}", error.detail);
        assert!(error.detail.contains("1024"), "{}", error.detail);
    }

    #[test]
    fn decodes_grayscale_and_16_bit_png_as_rgba() {
        let grayscale = png_bytes(
            png::ColorType::Grayscale,
            png::BitDepth::Eight,
            &[0, 255],
            None,
            None,
        );
        let decoded = decode_raster_with_policy(&grayscale, ProductResourcePolicy::default())
            .expect("grayscale PNG");
        assert_eq!(decoded.data, [0, 0, 0, 255, 255, 255, 255, 255]);

        let grayscale_16 = png_bytes(
            png::ColorType::Grayscale,
            png::BitDepth::Sixteen,
            &[0, 0, 255, 255],
            None,
            None,
        );
        let decoded = decode_raster_with_policy(&grayscale_16, ProductResourcePolicy::default())
            .expect("16-bit grayscale PNG");
        assert_eq!(decoded.data, [0, 0, 0, 255, 255, 255, 255, 255]);

        let constrained = ProductResourcePolicy {
            max_parser_live_bytes: 9,
            ..ProductResourcePolicy::default()
        };
        let error = decode_raster_with_policy(&grayscale, constrained).expect_err("RGBA admission");
        assert_eq!(error.code, MediaErrorCode::DimensionLimit);
    }

    #[test]
    fn decodes_indexed_png_as_rgba() {
        let indexed = png_bytes(
            png::ColorType::Indexed,
            png::BitDepth::Eight,
            &[0, 1],
            Some(&[255, 0, 0, 0, 255, 0]),
            None,
        );
        let decoded = decode_raster_with_policy(&indexed, ProductResourcePolicy::default())
            .expect("indexed PNG");
        assert_eq!(decoded.data, [255, 0, 0, 255, 0, 255, 0, 255]);

        let indexed_transparent = png_bytes(
            png::ColorType::Indexed,
            png::BitDepth::Eight,
            &[0, 1],
            Some(&[255, 0, 0, 0, 255, 0]),
            Some(&[0, 255]),
        );
        let decoded =
            decode_raster_with_policy(&indexed_transparent, ProductResourcePolicy::default())
                .expect("transparent indexed PNG");
        assert_eq!(decoded.data, [255, 0, 0, 0, 0, 255, 0, 255]);

        let rgb_transparent = png_bytes(
            png::ColorType::Rgb,
            png::BitDepth::Eight,
            &[255, 0, 0, 0, 0, 255],
            None,
            Some(&[0, 255, 0, 0, 0, 0]),
        );
        let decoded = decode_raster_with_policy(&rgb_transparent, ProductResourcePolicy::default())
            .expect("transparent RGB PNG");
        assert_eq!(decoded.data, [255, 0, 0, 0, 0, 0, 255, 255]);
    }
}

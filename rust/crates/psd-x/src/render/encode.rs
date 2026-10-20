use image::codecs::gif::GifEncoder;
use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::imageops::{self, FilterType as ResizeFilter};
use image::{ExtendedColorType, ImageBuffer, ImageEncoder, Rgba};

use super::{ExportError, ExportFormat, ResampleMethod};

pub(crate) struct EncodeSettings {
    pub format: ExportFormat,
    pub jpeg_quality: u8,
    pub png_transparency: bool,
    pub png_smaller_8_bit: bool,
    pub background: [u8; 3],
}

pub(crate) fn resize_rgba<'a>(
    rgba: &'a [u8],
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
    method: ResampleMethod,
) -> Result<Cow<'a, [u8]>, ExportError> {
    if width == target_width && height == target_height {
        return Ok(Cow::Borrowed(rgba));
    }
    let filter = match method.resolve(width, height, target_width, target_height) {
        ResampleMethod::Nearest => ResizeFilter::Nearest,
        ResampleMethod::Bilinear => ResizeFilter::Triangle,
        ResampleMethod::Bicubic => ResizeFilter::CatmullRom,
        ResampleMethod::BicubicSharper | ResampleMethod::PreserveDetails => ResizeFilter::Lanczos3,
        ResampleMethod::BicubicSmoother => ResizeFilter::Gaussian,
        ResampleMethod::Automatic => unreachable!("automatic is resolved above"),
    };
    let image = ImageBuffer::<Rgba<u8>, &[u8]>::from_raw(width, height, rgba)
        .ok_or(ExportError::InvalidPixelBuffer)?;
    Ok(Cow::Owned(
        imageops::resize(&image, target_width, target_height, filter).into_raw(),
    ))
}

pub(crate) fn flatten_rgba(rgba: &[u8], background: [u8; 3]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        let alpha = pixel[3] as u16;
        let inverse = 255 - alpha;
        for channel in 0..3 {
            rgb.push(
                ((pixel[channel] as u16 * alpha + background[channel] as u16 * inverse + 127) / 255)
                    as u8,
            );
        }
    }
    rgb
}

pub(crate) fn place_on_canvas(
    rgba: &[u8],
    width: u32,
    height: u32,
    canvas_width: u32,
    canvas_height: u32,
    anchor: super::CanvasAnchor,
) -> Vec<u8> {
    let (horizontal, vertical) = anchor.factors();
    let offset_x = ((canvas_width as i64 - width as i64) as f64 * horizontal).round() as i64;
    let offset_y = ((canvas_height as i64 - height as i64) as f64 * vertical).round() as i64;
    let mut canvas = vec![0; canvas_width as usize * canvas_height as usize * 4];
    let source_x = (-offset_x).max(0) as u32;
    let source_y = (-offset_y).max(0) as u32;
    let destination_x = offset_x.max(0) as u32;
    let destination_y = offset_y.max(0) as u32;
    let copy_width = width
        .saturating_sub(source_x)
        .min(canvas_width.saturating_sub(destination_x));
    let copy_height = height
        .saturating_sub(source_y)
        .min(canvas_height.saturating_sub(destination_y));
    for row in 0..copy_height {
        let source_start = (((source_y + row) * width + source_x) * 4) as usize;
        let destination_start =
            (((destination_y + row) * canvas_width + destination_x) * 4) as usize;
        let byte_width = copy_width as usize * 4;
        canvas[destination_start..destination_start + byte_width]
            .copy_from_slice(&rgba[source_start..source_start + byte_width]);
    }
    canvas
}

pub(crate) fn encode(
    rgba: &[u8],
    width: u32,
    height: u32,
    settings: EncodeSettings,
) -> Result<Vec<u8>, ExportError> {
    let mut output = Vec::new();
    match settings.format {
        ExportFormat::Png => {
            return encode_png(
                rgba,
                width,
                height,
                settings.png_transparency,
                settings.png_smaller_8_bit,
                settings.background,
            );
        }
        ExportFormat::Jpeg => {
            let rgb = flatten_rgba(rgba, settings.background);
            JpegEncoder::new_with_quality(&mut output, settings.jpeg_quality).write_image(
                &rgb,
                width,
                height,
                ExtendedColorType::Rgb8,
            )?;
        }
        ExportFormat::Gif => {
            // Speed 1 is prohibitively slow for multi-megapixel exports. Speed 10 keeps useful
            // palette quality while making a desktop "Export As" operation responsive.
            GifEncoder::new_with_speed(&mut output, 10).encode(
                rgba,
                width,
                height,
                ExtendedColorType::Rgba8,
            )?;
        }
    }
    Ok(output)
}

pub(crate) fn encode_png(
    rgba: &[u8],
    width: u32,
    height: u32,
    transparency: bool,
    smaller_8_bit: bool,
    background: [u8; 3],
) -> Result<Vec<u8>, ExportError> {
    let mut bytes = Vec::new();
    let encoder = PngEncoder::new_with_quality(
        &mut bytes,
        if smaller_8_bit {
            CompressionType::Best
        } else {
            CompressionType::Fast
        },
        FilterType::Adaptive,
    );
    if transparency {
        encoder.write_image(rgba, width, height, ExtendedColorType::Rgba8)?;
    } else {
        let rgb = flatten_rgba(rgba, background);
        encoder.write_image(&rgb, width, height, ExtendedColorType::Rgb8)?;
    }
    Ok(bytes)
}
use std::borrow::Cow;

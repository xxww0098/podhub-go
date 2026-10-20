//! Safe single-threaded SIMD adapter. Flatten before Triangle so hidden RGB in
//! transparent pixels cannot bleed into the white-background OCR image.
use crate::media::{MediaError, MediaErrorCode};
use crate::psd::ProductResourcePolicy;
use fast_image_resize::{
    FilterType, ResizeAlg, ResizeOptions, Resizer,
    images::{TypedImage, TypedImageRef},
    pixels::U8x3,
};
use image::{DynamicImage, RgbImage};
const STAGE: &str = "ai-image-resize";

pub(super) fn prepare_rgb(
    image: DynamicImage,
    side: u32,
    policy: ProductResourcePolicy,
) -> Result<RgbImage, MediaError> {
    let (width, height) = target_dimensions(image.width(), image.height(), side);
    admit_working_set(&image, width, height, policy)?;
    let source = flatten_onto_white(image);
    if (source.width(), source.height()) == (width, height) {
        return Ok(source);
    }
    let len = usize::try_from(u64::from(width) * u64::from(height) * 3)
        .map_err(|_| resize_error("target byte size exceeds platform"))?;
    let mut buffer = Vec::new();
    buffer
        .try_reserve_exact(len)
        .map_err(|_| resize_error("unable to reserve bounded resize output"))?;
    buffer.resize(len, 0);
    let src = TypedImageRef::<U8x3>::from_buffer(source.width(), source.height(), source.as_raw())
        .map_err(|e| resize_error(e.to_string()))?;
    let mut dst = TypedImage::<U8x3>::from_buffer(width, height, &mut buffer)
        .map_err(|e| resize_error(e.to_string()))?;
    let options = ResizeOptions::new()
        .resize_alg(ResizeAlg::Convolution(FilterType::Bilinear))
        .use_alpha(false);
    // One resizer per job: no retained scratch, shared mutable state, nested
    // thread pool, or unsafe CPU override. The crate selects supported SIMD.
    // Typed U8x3 views keep unused pixel kernels out of the WASM bundle.
    Resizer::new()
        .resize_typed(&src, &mut dst, &options)
        .map_err(|e| resize_error(e.to_string()))?;
    RgbImage::from_raw(width, height, buffer)
        .ok_or_else(|| resize_error("resized RGB dimensions disagree with output"))
}
fn resize_error(detail: impl Into<String>) -> MediaError {
    MediaError::new(MediaErrorCode::Io, STAGE, detail)
}
fn target_dimensions(width: u32, height: u32, side: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= side {
        return (width, height);
    }
    let scale = |value: u32| {
        ((u64::from(value) * u64::from(side) + u64::from(longest) / 2) / u64::from(longest)).max(1)
            as u32
    };
    (scale(width), scale(height))
}
fn admit_working_set(
    image: &DynamicImage,
    width: u32,
    height: u32,
    policy: ProductResourcePolicy,
) -> Result<(), MediaError> {
    let pixels = u128::from(image.width()) * u128::from(image.height());
    // Conservative: decoded storage + possible RGBA8 conversion + RGB flatten.
    let conversion = if image.color().has_alpha() { 7_u128 } else { 3 };
    let mut live = pixels * (u128::from(image.color().bytes_per_pixel()) + conversion);
    if (width, height) != (image.width(), image.height()) {
        live += u128::from(width) * u128::from(height) * 3;
        // FIR 6.1 U8 convolution is vertical-first: at most source_width ×
        // target_height RGB scratch, plus alignment, f64/normalized Triangle
        // coefficients and bounds/chunk metadata. Re-vet with crate upgrades.
        live += u128::from(image.width()) * u128::from(height) * 3 + 64;
        live += (u128::from(image.width())
            + u128::from(image.height())
            + u128::from(width)
            + u128::from(height))
            * 256;
    }
    if live > policy.max_parser_live_bytes as u128 {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            STAGE,
            live,
            policy.max_parser_live_bytes as u128,
            policy,
        ));
    }
    Ok(())
}
pub(super) fn flatten_onto_white(image: DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.into_rgb8();
    }
    let source = image.into_rgba8();
    let mut flattened = RgbImage::new(source.width(), source.height());
    for (target, pixel) in flattened.pixels_mut().zip(source.pixels()) {
        let alpha = u32::from(pixel.0[3]);
        let background = 255 - alpha;
        for channel in 0..3 {
            target.0[channel] =
                ((u32::from(pixel.0[channel]) * alpha + 255 * background) / 255) as u8;
        }
    }
    flattened
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};
    #[test]
    fn aspect_ratio_caps_both_orientations_without_rounding_to_zero() {
        assert_eq!(target_dimensions(1700, 400, 1024), (1024, 241));
        assert_eq!(target_dimensions(400, 1700, 1024), (241, 1024));
        assert_eq!(target_dimensions(1, 30000, 1024), (1, 1024));
        assert_eq!(target_dimensions(30000, 1, 1024), (1024, 1));
    }
    #[test]
    fn transparent_hidden_color_cannot_bleed_into_white_after_downsampling() {
        let source = RgbaImage::from_fn(48, 48, |x, _| {
            if x < 24 {
                Rgba([255, 0, 0, 0])
            } else {
                Rgba([255, 255, 255, 255])
            }
        });
        let rgb = prepare_rgb(source.into(), 16, ProductResourcePolicy::default()).unwrap();
        assert!(rgb.pixels().all(|p| p.0 == [255, 255, 255]));
    }
    #[test]
    fn conversion_and_resizer_scratch_are_admitted_before_allocation() {
        let source = RgbaImage::new(48, 48);
        let policy = ProductResourcePolicy {
            max_parser_live_bytes: 48 * 48 * 4,
            ..ProductResourcePolicy::default()
        };
        assert_eq!(
            prepare_rgb(source.into(), 16, policy).unwrap_err().code,
            MediaErrorCode::DimensionLimit
        );
    }
}

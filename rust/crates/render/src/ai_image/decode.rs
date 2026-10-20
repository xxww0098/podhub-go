//! Image-crate codecs with pre-allocation header and pixel admission.
use crate::media::{MediaError, MediaErrorCode};
use crate::psd::ProductResourcePolicy;
use image::{DynamicImage, ImageError, ImageReader};
use std::io::Cursor;
const STAGE: &str = "ai-image-preparation";
fn reader(
    source: &[u8],
    policy: ProductResourcePolicy,
) -> Result<ImageReader<Cursor<&[u8]>>, MediaError> {
    let mut reader = ImageReader::new(Cursor::new(source))
        .with_guessed_format()
        .map_err(|e| failure(e.into()))?;
    if reader.format().is_none() {
        return Err(MediaError::new(
            MediaErrorCode::ParseFailed,
            STAGE,
            "image format is unsupported or undecodable",
        ));
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(policy.max_psd_side);
    limits.max_image_height = Some(policy.max_psd_side);
    limits.max_alloc = Some(policy.max_parser_live_bytes as u64);
    reader.limits(limits);
    Ok(reader)
}
pub(super) fn dimensions(
    source: &[u8],
    policy: ProductResourcePolicy,
) -> Result<(u32, u32), MediaError> {
    if source.len() as u128 > u128::from(policy.max_input_bytes) {
        return Err(MediaError::resource_limit(
            MediaErrorCode::InputTooLarge,
            STAGE,
            source.len() as u128,
            u128::from(policy.max_input_bytes),
            policy,
        ));
    }
    let (width, height) = reader(source, policy)?.into_dimensions().map_err(failure)?;
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > policy.max_psd_side
        || height > policy.max_psd_side
        || pixels > policy.max_canvas_pixels
    {
        return Err(MediaError::resource_limit(
            MediaErrorCode::DimensionLimit,
            STAGE,
            u128::from(pixels.max(u64::from(width.max(height)))),
            u128::from(policy.max_canvas_pixels),
            policy,
        ));
    }
    Ok((width, height))
}
pub(super) fn image(
    source: &[u8],
    policy: ProductResourcePolicy,
) -> Result<DynamicImage, MediaError> {
    dimensions(source, policy)?;
    reader(source, policy)?.decode().map_err(failure)
}
fn failure(error: ImageError) -> MediaError {
    let code = match error {
        ImageError::Limits(_) => MediaErrorCode::DimensionLimit,
        ImageError::Unsupported(_) => MediaErrorCode::UnsupportedCapability,
        _ => MediaErrorCode::ParseFailed,
    };
    MediaError::new(code, STAGE, error.to_string())
}

//! Bounded source-image preparation for the AI relay, separate from product pixels.
//! The OCR contract remains 1024 px / JPEG q75 / 1.4 MB; product JPEGs stay q82.
use crate::media::{MediaError, MediaErrorCode};
use crate::psd::ProductResourcePolicy;
use image::RgbImage;
mod decode;
mod resize;
const MAX_UPLOAD_SIDE: u32 = 1024;
const PASSTHROUGH_BYTES: usize = 128 * 1024;
// Base64 plus the prompt must fit Cloud's 2 MiB Chat Completions body.
const MAX_PREPARED_IMAGE_BYTES: usize = 1_400_000;
const JPEG_QUALITY: u8 = 75;

/// Preserves small valid images verbatim, or prepares a white-background JPEG.
/// Header admission always runs, including on the byte-passthrough path.
pub fn prepare_ai_image(bytes: &[u8]) -> Result<Vec<u8>, MediaError> {
    let policy = ProductResourcePolicy::default();
    let (width, height) = decode::dimensions(bytes, policy)?;
    let over_side = width.max(height) > MAX_UPLOAD_SIDE;
    if bytes.len() <= PASSTHROUGH_BYTES && !over_side {
        return Ok(bytes.to_vec());
    }
    let decoded = decode::image(bytes, policy)?;
    let decoded_over_side = decoded.width().max(decoded.height()) > MAX_UPLOAD_SIDE;
    let rgb = resize::prepare_rgb(decoded, MAX_UPLOAD_SIDE, policy)?;
    let encoded = encode_jpeg(&rgb)?;
    if over_side || decoded_over_side {
        return admit(encoded);
    }
    admit_smaller_of(bytes, encoded)
}
fn encode_jpeg(rgb: &RgbImage) -> Result<Vec<u8>, MediaError> {
    let failure = |detail| MediaError::new(MediaErrorCode::Io, "ai-image-preparation", detail);
    let width = u16::try_from(rgb.width()).map_err(|_| failure("JPEG width exceeds u16"))?;
    let height = u16::try_from(rgb.height()).map_err(|_| failure("JPEG height exceeds u16"))?;
    let mut encoded = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut encoded, JPEG_QUALITY);
    // Preserve the existing AI q75 / 4:4:4 contract, not the product q82 / 4:2:0.
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    encoder
        .encode(rgb.as_raw(), width, height, jpeg_encoder::ColorType::Rgb)
        .map_err(|_| failure("image encode failed"))?;
    Ok(encoded)
}
fn admit(encoded: Vec<u8>) -> Result<Vec<u8>, MediaError> {
    if encoded.len() <= MAX_PREPARED_IMAGE_BYTES {
        return Ok(encoded);
    }
    Err(too_large())
}
fn admit_smaller_of(source: &[u8], encoded: Vec<u8>) -> Result<Vec<u8>, MediaError> {
    if encoded.len() <= MAX_PREPARED_IMAGE_BYTES && encoded.len() < source.len() {
        return Ok(encoded);
    }
    if source.len() <= MAX_PREPARED_IMAGE_BYTES {
        return Ok(source.to_vec());
    }
    admit(encoded)
}
fn too_large() -> MediaError {
    MediaError::new(
        MediaErrorCode::EncodedLimit,
        "ai-image-preparation",
        "prepared image exceeds the relay body limit",
    )
}
#[cfg(test)]
mod tests;

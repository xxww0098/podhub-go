//! Canvas construction and sample-buffer normalization.
//!
//! Leaf module shared by `helpers` and `thumbnail`: both need these, and
//! neither may depend on the other (keeps the module graph cycle-free).

use crate::psd::PixelData;

/// upstream `imageDataToCanvas(pixelData)`.
///
/// Converts 16/32-bit sample buffers to RGBA8 the same way as upstream helpers.ts:
/// - Float32 RGB: `round(pow(v, 1/2.2) * 255)`, alpha: `round(v * 255)`
/// - Uint16: high byte (`>>> 8`)
/// - Uint8: passthrough clone
pub fn image_data_to_canvas(pixel_data: &PixelData) -> PixelData {
    try_image_data_to_canvas(pixel_data).expect("pixel conversion allocation failed")
}

/// Fallible variant of [`image_data_to_canvas`].
pub fn try_image_data_to_canvas(
    pixel_data: &PixelData,
) -> Result<PixelData, std::collections::TryReserveError> {
    let w = pixel_data.width as usize;
    let h = pixel_data.height as usize;
    let n = w.saturating_mul(h).saturating_mul(4);
    match pixel_data.depth {
        32 => {
            let mut out = Vec::new();
            out.try_reserve_exact(n)?;
            out.resize(n, 0);
            let src = &pixel_data.data;
            for i in 0..n {
                let off = i * 4;
                if off + 3 >= src.len() {
                    break;
                }
                let v = f32::from_ne_bytes([src[off], src[off + 1], src[off + 2], src[off + 3]]);
                if i % 4 == 3 {
                    out[i] = (v * 255.0).round().clamp(0.0, 255.0) as u8;
                } else {
                    let g = v.clamp(0.0, f32::MAX).powf(1.0 / 2.2);
                    out[i] = (g * 255.0).round().clamp(0.0, 255.0) as u8;
                }
            }
            Ok(PixelData::rgba8(pixel_data.width, pixel_data.height, out))
        }
        16 => {
            let mut out = Vec::new();
            out.try_reserve_exact(n)?;
            out.resize(n, 0);
            let src = &pixel_data.data;
            for i in 0..n {
                let off = i * 2;
                if off + 1 >= src.len() {
                    break;
                }
                let v = u16::from_ne_bytes([src[off], src[off + 1]]);
                out[i] = (v >> 8) as u8;
            }
            Ok(PixelData::rgba8(pixel_data.width, pixel_data.height, out))
        }
        _ => {
            let mut out = Vec::new();
            out.try_reserve_exact(pixel_data.data.len())?;
            out.extend_from_slice(&pixel_data.data);
            Ok(PixelData::rgba8(pixel_data.width, pixel_data.height, out))
        }
    }
}

/// upstream `createCanvas(width, height)` — zeroed RGBA8 buffer.
pub fn create_canvas(width: u32, height: u32) -> PixelData {
    PixelData::rgba8(
        width,
        height,
        vec![0u8; (width as usize) * (height as usize) * 4],
    )
}

/// upstream `createImageData(width, height)`.
pub fn create_image_data(width: u32, height: u32) -> PixelData {
    create_canvas(width, height)
}

/// Fallible production image allocation.
pub fn try_create_image_data(
    width: u32,
    height: u32,
) -> Result<PixelData, std::collections::TryReserveError> {
    let length = (width as usize)
        .saturating_mul(height as usize)
        .saturating_mul(4);
    let mut data = Vec::new();
    data.try_reserve_exact(length)?;
    data.resize(length, 0);
    Ok(PixelData::rgba8(width, height, data))
}

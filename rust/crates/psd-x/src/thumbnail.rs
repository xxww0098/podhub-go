//! JPEG thumbnail helpers for image resource 1036.
//!
//! Encode/decode are gated on the `thumbnail` feature (`zune-jpeg` +
//! `jpeg-encoder`). Raw byte passthrough (`thumbnail_raw`) is unconditional
//! and lives in [`crate::image_resources`].

use crate::canvas::{create_canvas, image_data_to_canvas};
use crate::psd::{PixelData, Psd};

/// Decode a JPEG payload into RGBA8 [`PixelData`].
///
/// Without the `thumbnail` feature this always returns an empty 100×100
/// placeholder (upstream `createCanvasFromData` failure path).
#[cfg(feature = "thumbnail")]
pub fn decode_thumbnail_jpeg(data: &[u8]) -> PixelData {
    use zune_jpeg::JpegDecoder;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;

    if data.is_empty() {
        return create_canvas(100, 100);
    }

    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = JpegDecoder::new_with_options(data, options);
    match decoder.decode() {
        Ok(rgba) => {
            let (w, h) = decoder.dimensions().unwrap_or((0, 0));
            if w == 0 || h == 0 || rgba.len() < w * h * 4 {
                create_canvas(100, 100)
            } else {
                PixelData::rgba8(w as u32, h as u32, rgba)
            }
        }
        Err(_) => create_canvas(100, 100),
    }
}

#[cfg(not(feature = "thumbnail"))]
pub fn decode_thumbnail_jpeg(_data: &[u8]) -> PixelData {
    create_canvas(100, 100)
}

/// Encode RGBA8 (or RGB) [`PixelData`] to a JPEG byte buffer (quality 100).
///
/// Returns `None` when the `thumbnail` feature is off or encoding fails.
#[cfg(feature = "thumbnail")]
pub fn encode_thumbnail_jpeg(pixels: &PixelData) -> Option<Vec<u8>> {
    use jpeg_encoder::{ColorType, Encoder};

    if pixels.width == 0 || pixels.height == 0 {
        return Some(Vec::new());
    }
    let rgba = if pixels.depth != 8 {
        image_data_to_canvas(pixels)
    } else {
        pixels.clone()
    };
    let mut out = Vec::new();
    let encoder = Encoder::new(&mut out, 100);
    // Prefer RGBA so alpha is discarded by the encoder; fall back to RGB length.
    let px = (rgba.width as usize).saturating_mul(rgba.height as usize);
    let color = if rgba.data.len() >= px * 4 {
        ColorType::Rgba
    } else if rgba.data.len() >= px * 3 {
        ColorType::Rgb
    } else {
        return None;
    };
    let w = u16::try_from(rgba.width).ok()?;
    let h = u16::try_from(rgba.height).ok()?;
    encoder.encode(&rgba.data, w, h, color).ok()?;
    Some(out)
}

#[cfg(not(feature = "thumbnail"))]
pub fn encode_thumbnail_jpeg(_pixels: &PixelData) -> Option<Vec<u8>> {
    None
}

/// Mirror upstream `createThumbnail(psd)` — scale composite to max 160px on
/// the longest side (nearest-neighbor).
pub fn create_thumbnail(psd: &Psd) -> Option<PixelData> {
    let src = psd.image_data.as_ref().or(psd.canvas.as_ref())?;
    let src = if src.depth != 8 {
        image_data_to_canvas(src)
    } else {
        src.clone()
    };

    let doc_w = psd.width.max(1.0);
    let doc_h = psd.height.max(1.0);
    let (tw, th) = if doc_w > doc_h {
        let tw = 160u32;
        let th = ((doc_h * (tw as f64) / doc_w).floor() as u32).max(1);
        (tw, th)
    } else {
        let th = 160u32;
        let tw = ((doc_w * (th as f64) / doc_h).floor() as u32).max(1);
        (tw, th)
    };

    Some(scale_rgba_nearest(&src, tw, th))
}

fn scale_rgba_nearest(src: &PixelData, tw: u32, th: u32) -> PixelData {
    let sw = src.width.max(1) as usize;
    let sh = src.height.max(1) as usize;
    let tw_usize = tw as usize;
    let th_usize = th as usize;
    let mut out = vec![0u8; tw_usize * th_usize * 4];
    let src_buf = &src.data;
    for y in 0..th_usize {
        let sy = (y * sh) / th_usize;
        for x in 0..tw_usize {
            let sx = (x * sw) / tw_usize;
            let si = (sy * sw + sx) * 4;
            let di = (y * tw_usize + x) * 4;
            if si + 3 < src_buf.len() {
                out[di..di + 4].copy_from_slice(&src_buf[si..si + 4]);
            } else {
                out[di + 3] = 255;
            }
        }
    }
    PixelData::rgba8(tw, th, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_thumbnail_scales_landscape() {
        let mut data = vec![0u8; 200 * 100 * 4];
        for px in data.chunks_mut(4) {
            px.copy_from_slice(&[10, 20, 30, 255]);
        }
        let psd = Psd {
            width: 200.0,
            height: 100.0,
            image_data: Some(PixelData::rgba8(200, 100, data)),
            ..Psd::default()
        };
        let thumb = create_thumbnail(&psd).expect("thumb");
        assert_eq!(thumb.width, 160);
        assert_eq!(thumb.height, 80);
    }

    #[cfg(feature = "thumbnail")]
    #[test]
    fn jpeg_round_trip_dimensions() {
        let mut buf = vec![0u8; 8 * 8 * 4];
        for px in buf.chunks_mut(4) {
            px.copy_from_slice(&[40, 80, 120, 255]);
        }
        let px = PixelData::rgba8(8, 8, buf);
        let jpeg = encode_thumbnail_jpeg(&px).expect("encode");
        assert!(!jpeg.is_empty());
        assert_eq!(&jpeg[..2], &[0xff, 0xd8]);
        let decoded = decode_thumbnail_jpeg(&jpeg);
        assert_eq!(decoded.width, 8);
        assert_eq!(decoded.height, 8);
    }
}

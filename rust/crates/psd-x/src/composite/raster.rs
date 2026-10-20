use std::borrow::Cow;

use crate::psd::PixelData;

/// `v as f32 / 255.0` for every byte. Built once so the blend inner loop does not divide.
pub(crate) const U8_TO_UNIT: [f32; 256] = {
    let mut table = [0.0f32; 256];
    let mut i = 0;
    while i < 256 {
        table[i] = (i as f32) / 255.0;
        i += 1;
    }
    table
};

/// Integer half-open rectangle used for raster indexing (document coordinates).
///
/// Distinct from serialization-model geometry (`f64` bounds on layers).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PixelRect {
    pub left: i32,
    pub top: i32,
    pub width: u32,
    pub height: u32,
}

/// RGBA8 pixels with a document-space origin.
#[derive(Debug, Clone)]
pub struct PositionedRaster {
    pub left: i32,
    pub top: i32,
    pub pixels: PixelData,
}

impl PositionedRaster {
    pub fn rect(&self) -> PixelRect {
        PixelRect {
            left: self.left,
            top: self.top,
            width: self.pixels.width,
            height: self.pixels.height,
        }
    }

    /// Tight bounds of non-transparent pixels, or `None` if fully transparent.
    pub fn content_bounds(&self) -> Option<PixelRect> {
        let width = self.pixels.width;
        let height = self.pixels.height;
        let data = &self.pixels.data;
        let mut min_x = width as i32;
        let mut min_y = height as i32;
        let mut max_x = -1i32;
        let mut max_y = -1i32;
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let alpha = data[((y as u32 * width + x as u32) * 4 + 3) as usize];
                if alpha == 0 {
                    continue;
                }
                min_x = min_x.min(x);
                min_y = min_y.min(y);
                max_x = max_x.max(x);
                max_y = max_y.max(y);
            }
        }
        (max_x >= 0 && max_y >= 0).then_some(PixelRect {
            left: self.left + min_x,
            top: self.top + min_y,
            width: (max_x - min_x + 1) as u32,
            height: (max_y - min_y + 1) as u32,
        })
    }

    /// Crop (and pad with zeros) to `rect` in document coordinates.
    pub fn cropped(&self, rect: PixelRect) -> PositionedRaster {
        let mut out = vec![0u8; rect.width as usize * rect.height as usize * 4];
        let x0 = rect.left.max(self.left);
        let y0 = rect.top.max(self.top);
        let x1 = (rect.left + rect.width as i32).min(self.left + self.pixels.width as i32);
        let y1 = (rect.top + rect.height as i32).min(self.top + self.pixels.height as i32);
        let src = &self.pixels.data;
        for y in y0..y1 {
            for x in x0..x1 {
                let source = (((y - self.top) as u32 * self.pixels.width + (x - self.left) as u32)
                    * 4) as usize;
                let output =
                    (((y - rect.top) as u32 * rect.width + (x - rect.left) as u32) * 4) as usize;
                out[output..output + 4].copy_from_slice(&src[source..source + 4]);
            }
        }
        PositionedRaster {
            left: rect.left,
            top: rect.top,
            pixels: PixelData::rgba8(rect.width, rect.height, out),
        }
    }

    pub fn sample(&self, x: i32, y: i32) -> Option<[u8; 4]> {
        let local_x = x.checked_sub(self.left)?;
        let local_y = y.checked_sub(self.top)?;
        if local_x < 0
            || local_y < 0
            || local_x as u32 >= self.pixels.width
            || local_y as u32 >= self.pixels.height
        {
            return None;
        }
        let i = ((local_y as u32 * self.pixels.width + local_x as u32) * 4) as usize;
        let d = &self.pixels.data;
        Some([d[i], d[i + 1], d[i + 2], d[i + 3]])
    }

    pub fn into_pixels(self) -> PixelData {
        self.pixels
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PixelSource<'a> {
    pub data: Cow<'a, [u8]>,
    pub width: u32,
    pub height: u32,
    pub left: i32,
    pub top: i32,
}

impl<'a> PixelSource<'a> {
    pub(crate) fn from_pixels(pixels: &'a PixelData, left: i32, top: i32) -> Option<Self> {
        if pixels.width == 0 || pixels.height == 0 {
            return None;
        }
        let needed = pixels.width as usize * pixels.height as usize * 4;
        if pixels.depth == 8 {
            if pixels.data.len() < needed {
                return None;
            }
            return Some(Self {
                data: Cow::Borrowed(&pixels.data[..needed]),
                width: pixels.width,
                height: pixels.height,
                left,
                top,
            });
        }

        // Non-8-bit layers: reuse crate depth rules (16-bit high byte, 32-bit gamma).
        // Refuse short native buffers before conversion so we do not silently pad zeros.
        let bytes_per_sample = match pixels.depth {
            16 => 2usize,
            32 => 4usize,
            _ => pixels.bytes_per_sample(),
        };
        let needed_native = needed.saturating_mul(bytes_per_sample);
        if pixels.data.len() < needed_native {
            return None;
        }

        let normalized = crate::helpers::image_data_to_canvas(pixels);
        if normalized.depth != 8 || normalized.data.len() < needed {
            return None;
        }
        let mut rgba = normalized.data;
        rgba.truncate(needed);
        Some(Self {
            data: Cow::Owned(rgba),
            width: pixels.width,
            height: pixels.height,
            left,
            top,
        })
    }
}

#[derive(Debug, Clone)]
pub(crate) struct Backdrop {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

impl Backdrop {
    pub(crate) fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0.0; width as usize * height as usize * 4],
        }
    }

    pub(crate) fn to_rgba8(&self) -> Vec<u8> {
        // Half-up via `+ 0.5` matches `f32::round` on the non-negative
        // `[0, 255]` range and avoids a libm `roundf` per sample.
        let mut out = vec![0u8; self.data.len()];
        for (dst, &value) in out.iter_mut().zip(self.data.iter()) {
            *dst = value.clamp(0.0, 1.0).mul_add(255.0, 0.5) as u8;
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::PixelData;

    #[test]
    fn to_rgba8_matches_half_up_of_clamped_unit() {
        let samples = [-0.1f32, 0.0, 0.5, 1.0, 1.2];
        let rgba = Backdrop {
            width: 1,
            height: 1,
            data: samples.to_vec(),
        }
        .to_rgba8();
        let expected: Vec<u8> = samples
            .into_iter()
            .map(|value| (value.clamp(0.0, 1.0) * 255.0).round() as u8)
            .collect();
        assert_eq!(rgba, expected);
        assert_eq!(U8_TO_UNIT[0], 0.0);
        assert_eq!(U8_TO_UNIT[255], 1.0);
        assert!((U8_TO_UNIT[128] - 128.0 / 255.0).abs() < f32::EPSILON);
    }

    #[test]
    fn depth8_borrows_without_allocation() {
        let pixels = PixelData::rgba8(2, 1, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        let source = PixelSource::from_pixels(&pixels, 0, 0).unwrap();
        assert!(matches!(source.data, Cow::Borrowed(_)));
        assert_eq!(source.data.as_ref(), &[1, 2, 3, 4, 5, 6, 7, 8]);
    }

    #[test]
    fn depth16_normalizes_to_owned_high_byte() {
        // One pixel: R=0xABCD → high byte 0xAB, G=0, B=0, A=0xFFFF → 0xFF.
        let mut data = Vec::new();
        for sample in [0xABCDu16, 0, 0, 0xFFFF] {
            data.extend_from_slice(&sample.to_ne_bytes());
        }
        let pixels = PixelData {
            width: 1,
            height: 1,
            data,
            depth: 16,
        };
        let source = PixelSource::from_pixels(&pixels, 3, 4).unwrap();
        assert!(matches!(source.data, Cow::Owned(_)));
        assert_eq!(source.data.as_ref(), &[0xAB, 0, 0, 0xFF]);
        assert_eq!((source.left, source.top), (3, 4));
    }

    #[test]
    fn short_buffer_returns_none_for_depth8_and_16() {
        let short8 = PixelData::rgba8(2, 2, vec![0; 4]);
        assert!(PixelSource::from_pixels(&short8, 0, 0).is_none());

        let short16 = PixelData {
            width: 1,
            height: 1,
            data: vec![0u8; 2], // one u16 sample, need four
            depth: 16,
        };
        assert!(PixelSource::from_pixels(&short16, 0, 0).is_none());

        let short32 = PixelData {
            width: 1,
            height: 1,
            data: vec![0u8; 8], // two f32 samples, need four
            depth: 32,
        };
        assert!(PixelSource::from_pixels(&short32, 0, 0).is_none());
    }

    fn f32_rgba(samples: [f32; 4]) -> PixelData {
        let mut data = Vec::with_capacity(16);
        for sample in samples {
            data.extend_from_slice(&sample.to_ne_bytes());
        }
        PixelData {
            width: 1,
            height: 1,
            data,
            depth: 32,
        }
    }

    #[test]
    fn depth32_nan_normalizes_to_zero_bytes() {
        // NaN survives clamp as NaN; the final `as u8` cast yields 0.
        let pixels = f32_rgba([f32::NAN, f32::NAN, f32::NAN, f32::NAN]);
        let source = PixelSource::from_pixels(&pixels, 0, 0).unwrap();
        assert_eq!(source.data.as_ref(), &[0, 0, 0, 0]);
    }

    #[test]
    fn depth32_hdr_and_negative_are_clamped() {
        // Linear > 1 and < 0 are clamped before the 1/2.2 gamma encode.
        let pixels = f32_rgba([2.0, -1.0, 1.0, 1.5]);
        let hot = PixelSource::from_pixels(&pixels, 0, 0).unwrap();
        assert_eq!(hot.data.as_ref(), &[255, 0, 255, 255]);
    }

    #[test]
    fn content_bounds_and_crop_round_trip_opaque_corner() {
        let mut data = vec![0u8; 4 * 4 * 4];
        // Opaque red at (1, 2) in local space.
        let i = ((2u32 * 4 + 1) * 4) as usize;
        data[i..i + 4].copy_from_slice(&[255, 0, 0, 255]);
        let raster = PositionedRaster {
            left: 10,
            top: 20,
            pixels: PixelData::rgba8(4, 4, data),
        };
        assert_eq!(
            raster.content_bounds(),
            Some(PixelRect {
                left: 11,
                top: 22,
                width: 1,
                height: 1,
            })
        );
        assert_eq!(raster.sample(11, 22), Some([255, 0, 0, 255]));
        let cropped = raster.cropped(PixelRect {
            left: 11,
            top: 22,
            width: 1,
            height: 1,
        });
        assert_eq!(cropped.pixels.data, vec![255, 0, 0, 255]);
    }
}

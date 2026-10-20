#[derive(Debug, Clone)]
pub(super) struct PixelSource<'a> {
    pub data: Cow<'a, [u8]>,
    pub width: u32,
    pub height: u32,
    pub left: i64,
    pub top: i64,
}

#[derive(Debug, Clone)]
pub(super) struct Backdrop {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct Rect {
    pub left: i64,
    pub top: i64,
    pub width: u32,
    pub height: u32,
}

pub(super) fn new_backdrop(width: u32, height: u32) -> Result<Backdrop, MediaError> {
    let len = usize::try_from(
        u64::from(width)
            .checked_mul(u64::from(height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| {
                MediaError::new(
                    MediaErrorCode::DimensionLimit,
                    "composite",
                    "backdrop dimensions overflow",
                )
            })?,
    )
    .map_err(|_| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "composite",
            "backdrop is too large",
        )
    })?;
    Ok(Backdrop {
        width,
        height,
        data: vec![0.0; len],
    })
}

pub(super) fn backdrop_to_bytes(bd: &Backdrop) -> Vec<u8> {
    let mut out = vec![0_u8; bd.data.len()];
    for (index, value) in bd.data.iter().enumerate() {
        out[index] = (value * 255.0 + 0.5) as u8;
    }
    out
}

/// Appends exactly the bytes [`backdrop_to_bytes`] would produce, without the
/// intermediate allocation. Both conversions must stay bit-identical: the
/// reuse window filled through this function replaces a second composite whose
/// rows would otherwise pass through [`backdrop_to_bytes`].
pub(super) fn append_backdrop_bytes(out: &mut Vec<u8>, bd: &Backdrop) {
    out.extend(bd.data.iter().map(|value| (value * 255.0 + 0.5) as u8));
}

pub(super) fn resize_rgba(
    rgba: &[u8],
    width: u32,
    height: u32,
    target_width: u32,
    target_height: u32,
) -> Result<Vec<u8>, MediaError> {
    if width == target_width && height == target_height {
        return Ok(rgba.to_vec());
    }
    let len = usize::try_from(
        u64::from(target_width)
            .checked_mul(u64::from(target_height))
            .and_then(|pixels| pixels.checked_mul(4))
            .ok_or_else(|| {
                MediaError::new(
                    MediaErrorCode::DimensionLimit,
                    "source-resize",
                    "resize dimensions overflow",
                )
            })?,
    )
    .map_err(|_| {
        MediaError::new(
            MediaErrorCode::DimensionLimit,
            "source-resize",
            "resize is too large",
        )
    })?;
    let mut out = vec![0_u8; len];
    for ty in 0..target_height {
        let sy = ((ty as f64 + 0.5) * height as f64 / target_height as f64 - 0.5)
            .clamp(0.0, height as f64 - 1.0);
        let y0 = sy.floor() as u32;
        let y1 = (y0 + 1).min(height - 1);
        let fy = sy - y0 as f64;
        for tx in 0..target_width {
            let sx = ((tx as f64 + 0.5) * width as f64 / target_width as f64 - 0.5)
                .clamp(0.0, width as f64 - 1.0);
            let x0 = sx.floor() as u32;
            let x1 = (x0 + 1).min(width - 1);
            let fx = sx - x0 as f64;
            for channel in 0..4 {
                let sample = |x: u32, y: u32| rgba[((y * width + x) * 4 + channel) as usize] as f64;
                let top = sample(x0, y0) * (1.0 - fx) + sample(x1, y0) * fx;
                let bottom = sample(x0, y1) * (1.0 - fx) + sample(x1, y1) * fx;
                out[((ty * target_width + tx) * 4 + channel) as usize] =
                    (top * (1.0 - fy) + bottom * fy + 0.5) as u8;
            }
        }
    }
    Ok(out)
}
use crate::media::error::{MediaError, MediaErrorCode};
use std::borrow::Cow;

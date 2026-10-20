/*
File: rust/crates/psd-x/src/edit/layer_preview.rs

Purpose:
Invalidate a layer's raster preview while preserving its geometry.

The writer collapses a layer rect to zero when decoded pixels are absent (or
zero-sized) and `raw_data` is not set. Clearing only `image_data`/`canvas` is
also insufficient when the document was read with `use_raw_data`: the writer
short-circuits and passthroughs the original channel bytes. The correct shape
is to install a fully transparent raster at the layer's real bounds and clear
`raw_data`.

Source compatibility:
- no-upstream-counterpart
*/

use crate::psd::{ColorMode, Layer, LayerMaskData, LayerRawData, PixelData};
use crate::reader::{self, ReadError};
use thiserror::Error;

pub(crate) struct PreparedLayerPreview {
    top: Option<f64>,
    left: Option<f64>,
    bottom: Option<f64>,
    right: Option<f64>,
    canvas: Option<PixelData>,
    image_data: Option<PixelData>,
    raw_data: Option<LayerRawData>,
    mask: Option<LayerMaskData>,
    real_mask: Option<LayerMaskData>,
}

impl PreparedLayerPreview {
    pub(crate) fn apply(self, layer: &mut Layer) {
        layer.top = self.top;
        layer.left = self.left;
        layer.bottom = self.bottom;
        layer.right = self.right;
        layer.canvas = self.canvas;
        layer.image_data = self.image_data;
        layer.raw_data = self.raw_data;
        layer.additional_info.mask = self.mask;
        layer.additional_info.real_mask = self.real_mask;
    }
}

/// Errors from [`drop_layer_preview`].
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum DropLayerPreviewError {
    /// Capability is limited to RGB documents (channel layout differs otherwise).
    #[error("{}", match .0 {
        Some(mode) => format!("drop_layer_preview requires an RGB document, got color mode {mode:?}"),
        None => "drop_layer_preview requires an RGB document, but color mode is unset".to_owned(),
    })]
    UnsupportedColorMode(Option<ColorMode>),
    /// Failed to materialize mask/pixels from `raw_data` before replacement.
    #[error("drop_layer_preview failed to materialize layer pixels: {0}")]
    Materialize(String),
}

impl From<ReadError> for DropLayerPreviewError {
    fn from(err: ReadError) -> Self {
        DropLayerPreviewError::Materialize(err.to_string())
    }
}

/// Invalidate `layer`'s raster preview while keeping its geometry.
///
/// - Requires `color_mode == Some(ColorMode::Rgb)` (non-RGB → error; never
///   auto-collapses the layer rect).
/// - Clears `raw_data` so the writer cannot short-circuit with stale channel
///   bytes (documents read with `ReadOptions::use_raw_data`).
/// - Installs a fully transparent 8-bit RGBA buffer sized to the layer's
///   existing `left`/`top`/`right`/`bottom` bounds.
/// - Leaves layer masks, and all document-level fields (composite, thumbnail,
///   engine-data text blob), untouched. Callers pass only `&mut Layer` plus the
///   document color mode so those document fields are not reachable here.
///
/// Zero-size layers are legal: a 0×0 transparent buffer is installed and the
/// existing bounds are left as-is (the writer already emits a zero rect for
/// empty pixels without inventing new coordinates).
pub fn drop_layer_preview(
    layer: &mut Layer,
    color_mode: Option<ColorMode>,
) -> Result<(), DropLayerPreviewError> {
    prepare_layer_preview_drop(layer, color_mode)?.apply(layer);
    Ok(())
}

pub(crate) fn prepare_layer_preview_change<E>(
    layer: &Layer,
    prepare: impl FnOnce(&mut Layer) -> Result<(), E>,
) -> Result<PreparedLayerPreview, E> {
    let mut prepared = layer.clone();
    prepare(&mut prepared)?;
    Ok(PreparedLayerPreview {
        top: prepared.top,
        left: prepared.left,
        bottom: prepared.bottom,
        right: prepared.right,
        canvas: prepared.canvas,
        image_data: prepared.image_data,
        raw_data: prepared.raw_data,
        mask: prepared.additional_info.mask,
        real_mask: prepared.additional_info.real_mask,
    })
}

pub(crate) fn prepare_layer_preview_drop(
    layer: &Layer,
    color_mode: Option<ColorMode>,
) -> Result<PreparedLayerPreview, DropLayerPreviewError> {
    if color_mode != Some(ColorMode::Rgb) {
        return Err(DropLayerPreviewError::UnsupportedColorMode(color_mode));
    }

    // Materialize first so user/real mask pixels that only lived in raw channel
    // bytes survive after we clear the short-circuit path. Preparation happens
    // on a clone so any decode failure leaves the caller's layer untouched.
    prepare_layer_preview_change(layer, |prepared| {
        reader::materialize_layer_raw_data(prepared)?;

        let left = prepared.left.unwrap_or(0.0);
        let top = prepared.top.unwrap_or(0.0);
        let right = prepared.right.unwrap_or(0.0);
        let bottom = prepared.bottom.unwrap_or(0.0);

        let width = ((right - left).max(0.0)).round() as u32;
        let height = ((bottom - top).max(0.0)).round() as u32;
        let pixel_count = (width as usize).saturating_mul(height as usize);
        let data = vec![0u8; pixel_count.saturating_mul(4)];

        prepared.raw_data = None;
        prepared.canvas = None;
        prepared.image_data = Some(PixelData::rgba8(width, height, data));
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::LayerRawData;

    fn rgb_layer(w: u32, h: u32, fill: u8) -> Layer {
        let mut layer = Layer::default();
        layer.top = Some(0.0);
        layer.left = Some(0.0);
        layer.bottom = Some(h as f64);
        layer.right = Some(w as f64);
        layer.image_data = Some(PixelData::rgba8(
            w,
            h,
            vec![fill; (w as usize) * (h as usize) * 4],
        ));
        layer
    }

    #[test]
    fn rejects_non_rgb() {
        let mut layer = rgb_layer(2, 2, 0xff);
        let err = drop_layer_preview(&mut layer, Some(ColorMode::Grayscale))
            .expect_err("grayscale must fail");
        assert!(matches!(
            err,
            DropLayerPreviewError::UnsupportedColorMode(Some(ColorMode::Grayscale))
        ));
        // Geometry and pixels must be untouched on error.
        assert_eq!(layer.right, Some(2.0));
        assert_eq!(layer.bottom, Some(2.0));
        assert!(
            layer
                .image_data
                .as_ref()
                .unwrap()
                .data
                .iter()
                .all(|&b| b == 0xff)
        );
    }

    #[test]
    fn installs_transparent_pixels_keeps_bounds() {
        let mut layer = rgb_layer(3, 2, 0xab);
        layer.left = Some(10.0);
        layer.top = Some(20.0);
        layer.right = Some(13.0);
        layer.bottom = Some(22.0);

        drop_layer_preview(&mut layer, Some(ColorMode::Rgb)).unwrap();

        assert_eq!(layer.left, Some(10.0));
        assert_eq!(layer.top, Some(20.0));
        assert_eq!(layer.right, Some(13.0));
        assert_eq!(layer.bottom, Some(22.0));
        assert!(layer.raw_data.is_none());
        assert!(layer.canvas.is_none());
        let img = layer.image_data.as_ref().unwrap();
        assert_eq!((img.width, img.height), (3, 2));
        assert!(img.data.iter().all(|&b| b == 0));
    }

    #[test]
    fn clears_raw_data_short_circuit() {
        let mut layer = Layer::default();
        layer.top = Some(0.0);
        layer.left = Some(0.0);
        layer.bottom = Some(1.0);
        layer.right = Some(1.0);
        layer.raw_data = Some(LayerRawData {
            color_mode: ColorMode::Rgb,
            bits_per_channel: 8.0,
            large: false,
            channels: vec![],
        });

        drop_layer_preview(&mut layer, Some(ColorMode::Rgb)).unwrap();
        assert!(layer.raw_data.is_none());
        assert!(layer.image_data.is_some());
    }
}

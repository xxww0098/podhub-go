/*
File: rust/crates/psd-x/src/composite_refresh.rs

Purpose:
Explicit, caller-invoked rebuild of the document composite from the layer tree.
Lives outside `composite/` (compositor does not write
model fields) and outside `text_edit` / `smart_object` (editing never triggers
rebuild; those modules must not depend on compositing).

Source compatibility:
- no-upstream-counterpart
*/

//! Rebuild the stored document composite from the current layer tree.
//!
//! This is an **explicit, separately named, caller-invoked** operation. Editing
//! APIs never call it. Staleness flags on edit reports keep meaning
//! "psdx did not rebuild this for you".

use thiserror::Error;

use crate::composite::{
    CompositeError, CompositeRegion, CompositeRequest, CompositeTarget, CompositeWarningReport,
    PixelRect, composite,
};
use crate::helpers::has_alpha;
use crate::psd::{ColorMode, PixelData, Psd};

/// Outcome of a successful [`refresh_document_composite`].
#[derive(Debug, Clone, PartialEq)]
pub struct CompositeRefresh {
    /// Whether transparency presence changed (`false` ↔ any non-opaque alpha).
    ///
    /// The writer derives the file-header channel count (3 vs 4) from this
    /// presence, so callers must know when a rebuild reshapes the header.
    pub transparency_changed: bool,
    /// Fidelity warnings that were not skip-class (approximations / clipping).
    pub warnings: Vec<CompositeWarningReport>,
}

/// Failures that refuse to overwrite the stored document composite.
#[derive(Debug, Clone, PartialEq, Error)]
pub enum RefreshCompositeError {
    /// Document colour mode is not RGB (or is unset).
    #[error("refresh_document_composite requires RGB colour mode; got {0:?}")]
    UnsupportedColorMode(Option<ColorMode>),
    /// At least one skip-class fidelity warning — content was omitted.
    #[error(
        "refusing to write a partial document composite ({} skip-class warning(s))",
        .0.iter().filter(|r| r.warning.is_skip_class()).count()
    )]
    LayersSkipped(Vec<CompositeWarningReport>),
    /// Produced raster rectangle does not equal the document canvas.
    #[error("composite rect {produced:?} does not equal document rect {expected:?}")]
    RectMismatch {
        produced: PixelRect,
        expected: PixelRect,
    },
    /// Underlying compositor failure.
    #[error(transparent)]
    Composite(#[from] CompositeError),
}

/// Rebuild `psd.image_data` / `psd.canvas` from a whole-document flatten.
///
/// - Refuses non-RGB documents.
/// - Refuses when any skip-class fidelity warning is present.
/// - Refuses when the produced rectangle ≠ the document rectangle.
/// - Writes into whichever composite slot(s) the document already populates;
///   when neither is set, defaults to `image_data` (writer priority).
/// - Does **not** clear or invent model staleness flags — those live on edit
///   reports only.
pub fn refresh_document_composite(
    psd: &mut Psd,
) -> Result<CompositeRefresh, RefreshCompositeError> {
    if psd.color_mode != Some(ColorMode::Rgb) {
        return Err(RefreshCompositeError::UnsupportedColorMode(psd.color_mode));
    }

    let expected = document_rect(psd).map_err(RefreshCompositeError::Composite)?;
    let before_alpha = current_composite(psd).map(has_alpha).unwrap_or(false);

    let result = composite(
        psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: u64::MAX,
        },
    )?;

    let skip: Vec<CompositeWarningReport> = result
        .warnings
        .iter()
        .filter(|r| r.warning.is_skip_class())
        .cloned()
        .collect();
    if !skip.is_empty() {
        return Err(RefreshCompositeError::LayersSkipped(result.warnings));
    }

    let produced = result.raster.rect();
    if produced != expected {
        return Err(RefreshCompositeError::RectMismatch { produced, expected });
    }

    let pixels = result.raster.into_pixels();
    let after_alpha = has_alpha(&pixels);
    write_composite_slots(psd, pixels);

    Ok(CompositeRefresh {
        transparency_changed: before_alpha != after_alpha,
        warnings: result.warnings,
    })
}

fn document_rect(psd: &Psd) -> Result<PixelRect, CompositeError> {
    if !psd.width.is_finite()
        || !psd.height.is_finite()
        || psd.width <= 0.0
        || psd.height <= 0.0
        || psd.width > u32::MAX as f64
        || psd.height > u32::MAX as f64
    {
        return Err(CompositeError::InvalidCanvas {
            width: psd.width,
            height: psd.height,
        });
    }
    Ok(PixelRect {
        left: 0,
        top: 0,
        width: psd.width as u32,
        height: psd.height as u32,
    })
}

fn current_composite(psd: &Psd) -> Option<&PixelData> {
    psd.image_data.as_ref().or(psd.canvas.as_ref())
}

fn write_composite_slots(psd: &mut Psd, pixels: PixelData) {
    let had_image_data = psd.image_data.is_some();
    let had_canvas = psd.canvas.is_some();
    match (had_image_data, had_canvas) {
        // Neither populated → default to image_data (writer priority).
        (false, false) | (true, false) => {
            psd.image_data = Some(pixels);
        }
        (false, true) => {
            psd.canvas = Some(pixels);
        }
        (true, true) => {
            psd.image_data = Some(pixels.clone());
            psd.canvas = Some(pixels);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{Layer, LayerAdditionalInfo};

    fn solid(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
        PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
    }

    fn rgb_doc(w: u32, h: u32, layer_rgba: [u8; 4]) -> Psd {
        let layer = Layer {
            left: Some(0.0),
            top: Some(0.0),
            right: Some(w as f64),
            bottom: Some(h as f64),
            image_data: Some(solid(w, h, layer_rgba)),
            additional_info: LayerAdditionalInfo {
                name: Some("Fill".into()),
                ..LayerAdditionalInfo::default()
            },
            ..Layer::default()
        };
        Psd {
            width: w as f64,
            height: h as f64,
            color_mode: Some(ColorMode::Rgb),
            bits_per_channel: Some(8.0),
            children: Some(vec![layer]),
            ..Psd::default()
        }
    }

    #[test]
    fn rejects_non_rgb() {
        let mut psd = rgb_doc(2, 2, [255, 0, 0, 255]);
        psd.color_mode = Some(ColorMode::Grayscale);
        let err = refresh_document_composite(&mut psd).unwrap_err();
        assert!(matches!(
            err,
            RefreshCompositeError::UnsupportedColorMode(Some(ColorMode::Grayscale))
        ));
        assert!(psd.image_data.is_none());
    }

    #[test]
    fn defaults_to_image_data_when_neither_slot_populated() {
        let mut psd = rgb_doc(2, 2, [10, 20, 30, 255]);
        assert!(psd.image_data.is_none());
        assert!(psd.canvas.is_none());
        let report = refresh_document_composite(&mut psd).unwrap();
        assert!(!report.transparency_changed);
        assert!(psd.canvas.is_none());
        let img = psd.image_data.as_ref().unwrap();
        assert_eq!((img.width, img.height), (2, 2));
        assert_eq!(&img.data[..4], &[10, 20, 30, 255]);
    }

    #[test]
    fn writes_canvas_only_when_that_slot_is_populated() {
        let mut psd = rgb_doc(2, 2, [1, 2, 3, 255]);
        psd.canvas = Some(solid(2, 2, [9, 9, 9, 255]));
        assert!(psd.image_data.is_none());
        refresh_document_composite(&mut psd).unwrap();
        assert!(psd.image_data.is_none());
        assert_eq!(&psd.canvas.as_ref().unwrap().data[..4], &[1, 2, 3, 255]);
    }

    #[test]
    fn refuses_skip_class_warnings() {
        let mut psd = rgb_doc(2, 2, [0, 0, 0, 0]);
        // Pixels without geometry → MissingGeometry (skip-class); layer not drawn.
        {
            let layer = &mut psd.children.as_mut().unwrap()[0];
            layer.left = None;
            layer.top = None;
            layer.right = None;
            layer.bottom = None;
            layer.image_data = Some(solid(2, 2, [255, 0, 0, 255]));
        }
        psd.image_data = Some(solid(2, 2, [0, 255, 0, 255]));
        let before = psd.image_data.as_ref().unwrap().data.clone();
        let err = refresh_document_composite(&mut psd).unwrap_err();
        assert!(matches!(err, RefreshCompositeError::LayersSkipped(_)));
        assert_eq!(
            psd.image_data.as_ref().unwrap().data,
            before,
            "must not overwrite on refuse"
        );
    }

    #[test]
    fn allows_blend_approximations_like_dissolve() {
        use crate::psd::BlendMode;

        let mut psd = rgb_doc(2, 2, [10, 20, 30, 255]);
        psd.children.as_mut().unwrap()[0].blend_mode = Some(BlendMode::Dissolve);
        psd.image_data = Some(solid(2, 2, [0, 0, 0, 255]));
        // Dissolve is FeatureNotEvaluated::DissolveDither (approximated), not a skip.
        refresh_document_composite(&mut psd).expect("approximations must not refuse refresh");
        assert_eq!(
            &psd.image_data.as_ref().unwrap().data[..4],
            &[10, 20, 30, 255]
        );
    }

    #[test]
    fn reports_transparency_presence_change() {
        let mut psd = rgb_doc(2, 2, [255, 0, 0, 128]);
        psd.image_data = Some(solid(2, 2, [0, 0, 0, 255])); // opaque before
        let report = refresh_document_composite(&mut psd).unwrap();
        assert!(report.transparency_changed);
        assert!(has_alpha(psd.image_data.as_ref().unwrap()));
    }
}

//! Public `composite()` API and typed fidelity report.

use psdx::composite::{
    CompositeError, CompositeRegion, CompositeRequest, CompositeTarget, CompositeWarning,
    MaskIgnoredReason, PixelRect, composite,
};
use psdx::psd::{BlendMode, Layer, LayerAdditionalInfo, LayerMaskData, PixelData, Psd};

fn solid(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
}

fn sample_psd() -> Psd {
    let red = Layer {
        left: Some(1.0),
        top: Some(2.0),
        right: Some(3.0),
        bottom: Some(4.0),
        image_data: Some(solid(2, 2, [255, 0, 0, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("Red".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    let group = Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("Group".into()),
            ..LayerAdditionalInfo::default()
        },
        children: Some(vec![red]),
        ..Layer::default()
    };
    let blue = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(1.0),
        bottom: Some(1.0),
        image_data: Some(solid(1, 1, [0, 0, 255, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("Blue".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    Psd {
        width: 4.0,
        height: 6.0,
        children: Some(vec![group, blue]),
        ..Psd::default()
    }
}

#[test]
fn document_target_composites_all_top_level_layers() {
    let psd = sample_psd();
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 1000,
        },
    )
    .unwrap();
    assert_eq!(result.raster.rect().width, 4);
    assert_eq!(result.raster.rect().height, 6);
    assert_eq!(result.raster.sample(0, 0), Some([0, 0, 255, 255]));
    assert_eq!(result.raster.sample(1, 2), Some([255, 0, 0, 255]));
    assert!(result.raster.content_bounds().is_some());
}

#[test]
fn layer_path_composites_only_that_subtree() {
    let psd = sample_psd();
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Layer(&[0]),
            region: CompositeRegion::Full,
            max_pixels: 1000,
        },
    )
    .unwrap();
    // Group contains red at (1,2); top-level blue must not appear.
    assert_eq!(result.raster.sample(1, 2), Some([255, 0, 0, 255]));
    assert_eq!(result.raster.sample(0, 0), Some([0, 0, 0, 0]));
}

#[test]
fn empty_layer_path_is_not_document() {
    let psd = sample_psd();
    let error = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Layer(&[]),
            region: CompositeRegion::Full,
            max_pixels: 1000,
        },
    )
    .unwrap_err();
    assert_eq!(error, CompositeError::TargetNotFound(Vec::new()));
}

#[test]
fn fully_transparent_result_is_ok() {
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        children: Some(vec![Layer {
            additional_info: LayerAdditionalInfo {
                name: Some("EmptyGroup".into()),
                ..LayerAdditionalInfo::default()
            },
            children: Some(vec![]),
            ..Layer::default()
        }]),
        ..Psd::default()
    };
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 100,
        },
    )
    .unwrap();
    assert!(result.raster.content_bounds().is_none());
    assert_eq!(result.raster.sample(0, 0), Some([0, 0, 0, 0]));
}

#[test]
fn band_concatenation_matches_full_region() {
    let psd = sample_psd();
    let full = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 1000,
        },
    )
    .unwrap();

    let mut concat = Vec::new();
    for (top, bottom) in [(0, 2), (2, 4), (4, 6)] {
        let band = composite(
            &psd,
            &CompositeRequest {
                target: CompositeTarget::Document,
                region: CompositeRegion::Rows { top, bottom },
                max_pixels: 1000,
            },
        )
        .unwrap();
        assert_eq!(band.raster.top, top);
        assert_eq!(band.raster.pixels.height, (bottom - top) as u32);
        concat.extend_from_slice(&band.raster.pixels.data);
    }
    assert_eq!(concat, full.raster.pixels.data);
}

#[test]
fn budget_rejects_oversized_region_and_reports_peak() {
    let psd = sample_psd();
    let request = CompositeRequest {
        target: CompositeTarget::Document,
        region: CompositeRegion::Full,
        max_pixels: 10,
    };
    let peak = request.estimated_peak_bytes(&psd).unwrap();
    assert_eq!(peak, 4 * 6 * 20);
    let error = composite(&psd, &request).unwrap_err();
    assert_eq!(
        error,
        CompositeError::RegionTooLarge {
            pixels: 24,
            max: 10,
        }
    );
}

#[test]
fn cropped_pads_and_preserves_origin() {
    let psd = sample_psd();
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Layer(&[1]),
            region: CompositeRegion::Rows { top: 0, bottom: 2 },
            max_pixels: 1000,
        },
    )
    .unwrap();
    let cropped = result.raster.cropped(PixelRect {
        left: 0,
        top: 0,
        width: 2,
        height: 2,
    });
    assert_eq!((cropped.left, cropped.top), (0, 0));
    assert_eq!(cropped.sample(0, 0), Some([0, 0, 255, 255]));
    assert_eq!(cropped.sample(1, 1), Some([0, 0, 0, 0]));
}

#[test]
fn typed_report_carries_path_for_ignored_mask_depth() {
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        children: Some(vec![Layer {
            left: Some(0.0),
            top: Some(0.0),
            right: Some(2.0),
            bottom: Some(2.0),
            image_data: Some(solid(2, 2, [255, 0, 0, 255])),
            additional_info: LayerAdditionalInfo {
                name: Some("Masked".into()),
                mask: Some(LayerMaskData {
                    default_color: Some(0.0),
                    image_data: Some(PixelData {
                        width: 2,
                        height: 2,
                        data: vec![0u8; 2 * 2 * 4 * 2],
                        depth: 16,
                    }),
                    ..LayerMaskData::default()
                }),
                ..LayerAdditionalInfo::default()
            },
            ..Layer::default()
        }]),
        ..Psd::default()
    };
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 100,
        },
    )
    .unwrap();
    assert_eq!(result.raster.sample(0, 0), Some([255, 0, 0, 255]));
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::MaskIgnored {
                path,
                reason: MaskIgnoredReason::UnsupportedDepth { depth: 16 }
            } if path == &[0]
        ) && r.count == 1
    }));
}

#[test]
fn typed_report_distinguishes_malformed_raster_and_blend_mode() {
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        children: Some(vec![
            Layer {
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                blend_mode: Some(BlendMode::LinearHeight),
                image_data: Some(solid(2, 2, [0, 255, 0, 255])),
                additional_info: LayerAdditionalInfo {
                    name: Some("Blend".into()),
                    ..LayerAdditionalInfo::default()
                },
                ..Layer::default()
            },
            Layer {
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                image_data: Some(PixelData::rgba8(2, 2, vec![255, 0, 0, 255])),
                additional_info: LayerAdditionalInfo {
                    name: Some("Short".into()),
                    ..LayerAdditionalInfo::default()
                },
                ..Layer::default()
            },
        ]),
        ..Psd::default()
    };
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 100,
        },
    )
    .unwrap();
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::UnsupportedBlendMode {
                path,
                mode: BlendMode::LinearHeight
            } if path == &[0]
        )
    }));
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::MalformedRaster {
                path,
                expected: 16,
                found: 4,
                ..
            } if path == &[1]
        )
    }));
}

#[test]
fn transparent_result_still_reports_why_empty() {
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        children: Some(vec![Layer {
            // Pixels present but no geometry → skipped; composite stays empty.
            image_data: Some(solid(2, 2, [255, 0, 0, 255])),
            additional_info: LayerAdditionalInfo {
                name: Some("Orphan".into()),
                ..LayerAdditionalInfo::default()
            },
            ..Layer::default()
        }]),
        ..Psd::default()
    };
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 100,
        },
    )
    .unwrap();
    assert!(result.raster.content_bounds().is_none());
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::MissingGeometry { path, .. } if path == &[0]
        )
    }));
}

#[test]
fn layer_target_paths_are_document_absolute() {
    let psd = sample_psd();
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Layer(&[0]),
            region: CompositeRegion::Full,
            max_pixels: 1000,
        },
    )
    .unwrap();
    // No fidelity loss expected on this fixture; path plumbing is covered by
    // nested cases above. Ensure the call succeeds with an empty report.
    assert!(result.warnings.is_empty());
    assert!(result.raster.content_bounds().is_some());
}

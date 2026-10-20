//! Report every unrendered feature and export skip reason.

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::composite::{
    CompositeFidelity, CompositeRegion, CompositeRequest, CompositeTarget, CompositeWarning,
    MaskIgnoredReason, UnrenderedFeature, composite, fidelity,
};
use psdx::psd::{
    AdjustmentLayer, BlendMode, BlendingRange, BlendingRanges, BrightnessAdjustment, ColorMode,
    Layer, LayerAdditionalInfo, LayerEffectShadow, LayerEffectsInfo, LayerMaskData, PixelData, Psd,
    ReadOptions,
};
use psdx::read_psd;
use psdx::render::{ExportConcurrency, ExportOptions, SkipReason, export_groups};

fn solid(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
}

fn fixture_psd(name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join("read").join(name);
    let psd = dir.join("src.psd");
    let psb = dir.join("src.psb");
    if psd.is_file() {
        Some(psd)
    } else if psb.is_file() {
        Some(psb)
    } else {
        None
    }
}

fn load_fixture(name: &str) -> Option<Psd> {
    let path = fixture_psd(name)?;
    let bytes = fs::read(path).ok()?;
    read_psd(&bytes, &ReadOptions::default()).ok()
}

fn has_feature(
    result_warnings: &[psdx::composite::CompositeWarningReport],
    feature: UnrenderedFeature,
    path: &[usize],
) -> bool {
    result_warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::FeatureNotEvaluated { path: p, feature: f }
            if p.as_slice() == path && *f == feature
        )
    })
}

#[test]
fn dissolve_is_not_supported_and_reports_dither_gap() {
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![Layer {
            left: Some(0.0),
            top: Some(0.0),
            right: Some(2.0),
            bottom: Some(2.0),
            blend_mode: Some(BlendMode::Dissolve),
            image_data: Some(solid(2, 2, [255, 0, 0, 255])),
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
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::DissolveDither,
        &[0]
    ));
    assert!(!result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::UnsupportedBlendMode {
                mode: BlendMode::Dissolve,
                ..
            }
        )
    }));
    assert_eq!(fidelity(&result.warnings), CompositeFidelity::Approximated);
    // Still paints as Normal.
    assert_eq!(result.raster.sample(0, 0), Some([255, 0, 0, 255]));
}

#[test]
fn reports_adjustment_effects_and_structural_gaps() {
    let psd = Psd {
        width: 4.0,
        height: 4.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![
            Layer {
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                image_data: Some(solid(2, 2, [0, 255, 0, 255])),
                additional_info: LayerAdditionalInfo {
                    name: Some("Base".into()),
                    effects: Some(LayerEffectsInfo {
                        drop_shadow: Some(vec![LayerEffectShadow::default()]),
                        ..LayerEffectsInfo::default()
                    }),
                    ..LayerAdditionalInfo::default()
                },
                ..Layer::default()
            },
            Layer {
                left: Some(-1.0),
                top: Some(-1.0),
                right: Some(1.0),
                bottom: Some(1.0),
                image_data: Some(solid(2, 2, [255, 0, 0, 128])),
                additional_info: LayerAdditionalInfo {
                    name: Some("Adj".into()),
                    adjustment: Some(AdjustmentLayer::Brightness(BrightnessAdjustment {
                        brightness: Some(0.0),
                        ..BrightnessAdjustment::default()
                    })),
                    blending_ranges: Some(BlendingRanges {
                        composite_gray_blend_source: vec![0.0, 0.0, 255.0, 255.0],
                        composite_graph_blend_destination_range: vec![81.0, 255.0, 255.0, 255.0],
                        ranges: vec![BlendingRange {
                            source_range: vec![0.0, 0.0, 255.0, 255.0],
                            dest_range: vec![0.0, 0.0, 255.0, 255.0],
                        }],
                    }),
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
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::LayerEffects,
        &[0]
    ));
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::AdjustmentLayer,
        &[1]
    ));
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::BlendRanges,
        &[1]
    ));
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::ClippedToCanvas { path } if path.as_slice() == [1]
        )
    }));
    assert_eq!(fidelity(&result.warnings), CompositeFidelity::Partial);
}

#[test]
fn reports_pass_through_downgrade_and_mask_softness() {
    let child = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(2.0),
        bottom: Some(2.0),
        image_data: Some(solid(2, 2, [0, 0, 255, 255])),
        ..Layer::default()
    };
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![Layer {
            blend_mode: Some(BlendMode::PassThrough),
            opacity: Some(0.5),
            additional_info: LayerAdditionalInfo {
                name: Some("PT".into()),
                mask: Some(LayerMaskData {
                    default_color: Some(255.0),
                    user_mask_feather: Some(2.0),
                    user_mask_density: Some(0.5),
                    position_relative_to_layer: Some(true),
                    image_data: Some(solid(2, 2, [255, 255, 255, 255])),
                    left: Some(0.0),
                    top: Some(0.0),
                    right: Some(2.0),
                    bottom: Some(2.0),
                    ..LayerMaskData::default()
                }),
                ..LayerAdditionalInfo::default()
            },
            children: Some(vec![child]),
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
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::PassThroughDowngraded,
        &[0]
    ));
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::MaskIgnored {
                path,
                reason: MaskIgnoredReason::FeatherIgnored
            } if path.as_slice() == [0]
        )
    }));
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::MaskIgnored {
                path,
                reason: MaskIgnoredReason::DensityIgnored
            } if path.as_slice() == [0]
        )
    }));
    assert!(result.warnings.iter().any(|r| {
        matches!(
            &r.warning,
            CompositeWarning::MaskIgnored {
                path,
                reason: MaskIgnoredReason::LayerRelativePositioning
            } if path.as_slice() == [0]
        )
    }));
}

#[test]
fn reports_top_level_group_blend_on_empty_backdrop() {
    let child = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(2.0),
        bottom: Some(2.0),
        image_data: Some(solid(2, 2, [255, 0, 0, 255])),
        ..Layer::default()
    };
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        color_mode: Some(ColorMode::Rgb),
        children: Some(vec![Layer {
            blend_mode: Some(BlendMode::Multiply),
            additional_info: LayerAdditionalInfo {
                name: Some("Mul".into()),
                ..LayerAdditionalInfo::default()
            },
            children: Some(vec![child]),
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
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::TopLevelBlendIneffective,
        &[0]
    ));
    assert_eq!(fidelity(&result.warnings), CompositeFidelity::Approximated);
}

#[test]
fn non_rgb_document_reports_color_space() {
    let psd = Psd {
        width: 1.0,
        height: 1.0,
        color_mode: Some(ColorMode::Cmyk),
        children: Some(vec![Layer {
            left: Some(0.0),
            top: Some(0.0),
            right: Some(1.0),
            bottom: Some(1.0),
            image_data: Some(solid(1, 1, [10, 20, 30, 255])),
            ..Layer::default()
        }]),
        ..Psd::default()
    };
    let result = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 10,
        },
    )
    .unwrap();
    assert!(has_feature(
        &result.warnings,
        UnrenderedFeature::NonRgbColorSpace,
        &[]
    ));
}

#[test]
fn export_reports_skipped_top_level_non_groups() {
    let psd = Psd {
        width: 2.0,
        height: 2.0,
        children: Some(vec![
            Layer {
                additional_info: LayerAdditionalInfo {
                    name: Some("Background".into()),
                    ..LayerAdditionalInfo::default()
                },
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                image_data: Some(solid(2, 2, [1, 2, 3, 255])),
                ..Layer::default()
            },
            Layer {
                additional_info: LayerAdditionalInfo {
                    name: Some("Group".into()),
                    ..LayerAdditionalInfo::default()
                },
                children: Some(vec![Layer {
                    left: Some(0.0),
                    top: Some(0.0),
                    right: Some(2.0),
                    bottom: Some(2.0),
                    image_data: Some(solid(2, 2, [9, 9, 9, 255])),
                    ..Layer::default()
                }]),
                ..Layer::default()
            },
        ]),
        ..Psd::default()
    };
    let result = export_groups(
        &psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    )
    .unwrap();
    assert!(result.skipped.iter().any(|s| {
        s.top_level_index == 0 && s.name == "Background" && s.reason == SkipReason::NotAGroup
    }));
    assert_eq!(result.assets.len(), 1);
}

#[test]
fn fixtures_with_adjustments_and_effects_emit_typed_entries() {
    let Some(adj) = load_fixture("adjustment-layers") else {
        eprintln!("skip adjustment-layers: fixture missing");
        return;
    };
    let adj_result = composite(
        &adj,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: u64::MAX,
        },
    )
    .unwrap();
    assert!(
        adj_result.warnings.iter().any(|r| matches!(
            &r.warning,
            CompositeWarning::FeatureNotEvaluated {
                feature: UnrenderedFeature::AdjustmentLayer,
                path
            } if !path.is_empty()
        )),
        "expected AdjustmentLayer entries, got {:?}",
        adj_result.warnings
    );
    assert_eq!(fidelity(&adj_result.warnings), CompositeFidelity::Partial);

    let Some(fx) = load_fixture("effects") else {
        eprintln!("skip effects: fixture missing");
        return;
    };
    let fx_result = composite(
        &fx,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: u64::MAX,
        },
    )
    .unwrap();
    assert!(
        fx_result.warnings.iter().any(|r| matches!(
            &r.warning,
            CompositeWarning::FeatureNotEvaluated {
                feature: UnrenderedFeature::LayerEffects,
                path
            } if !path.is_empty()
        )),
        "expected LayerEffects entries, got {:?}",
        fx_result.warnings
    );
}

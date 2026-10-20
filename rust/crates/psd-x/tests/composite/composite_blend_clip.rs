//! Clipping groups, pass-through paths, and depth edges
//! through the public `psdx::composite` surface (no fixture corpus has clips).

use psdx::composite::{CompositeRegion, CompositeRequest, CompositeTarget, composite};
use psdx::psd::{BlendMode, Layer, LayerAdditionalInfo, LayerMaskData, PixelData, Psd};

fn solid(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
}

fn pixel_layer(name: &str, rgba: [u8; 4], clipping: bool) -> Layer {
    Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(1.0),
        bottom: Some(1.0),
        clipping: Some(clipping),
        image_data: Some(solid(1, 1, rgba)),
        additional_info: LayerAdditionalInfo {
            name: Some(name.into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    }
}

fn doc(children: Vec<Layer>) -> Psd {
    Psd {
        width: 1.0,
        height: 1.0,
        children: Some(children),
        ..Psd::default()
    }
}

fn flatten(psd: &Psd) -> [u8; 4] {
    let result = composite(
        psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 16,
        },
    )
    .unwrap();
    result.raster.sample(0, 0).unwrap()
}

#[test]
fn base_with_several_clipped_layers() {
    // Bottom → top: cyan base, then yellow clip, then magenta clip.
    // Each clip_color_lerp replaces the region colour at full clip alpha.
    let psd = doc(vec![
        pixel_layer("base", [0, 255, 255, 255], false),
        pixel_layer("clip-a", [255, 255, 0, 255], true),
        pixel_layer("clip-b", [255, 0, 255, 255], true),
    ]);
    assert_eq!(flatten(&psd), [255, 0, 255, 255]);
}

#[test]
fn clip_over_partially_transparent_base() {
    let mut base = pixel_layer("base", [255, 255, 255, 128], false);
    base.opacity = Some(1.0);
    let psd = doc(vec![base, pixel_layer("clip", [255, 0, 0, 255], true)]);
    // Region keeps the base alpha (128); colour becomes fully red.
    assert_eq!(flatten(&psd), [255, 0, 0, 128]);
}

#[test]
fn clip_carrying_its_own_mask() {
    let mut clip = pixel_layer("clip", [0, 0, 255, 255], true);
    // Mask R=0 → clip alpha becomes 0 → base green must remain.
    clip.additional_info.mask = Some(LayerMaskData {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(1.0),
        bottom: Some(1.0),
        default_color: Some(0.0),
        image_data: Some(solid(1, 1, [0, 0, 0, 255])),
        ..LayerMaskData::default()
    });
    let psd = doc(vec![pixel_layer("base", [0, 255, 0, 255], false), clip]);
    assert_eq!(flatten(&psd), [0, 255, 0, 255]);

    let mut clip_open = pixel_layer("clip-open", [0, 0, 255, 255], true);
    clip_open.additional_info.mask = Some(LayerMaskData {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(1.0),
        bottom: Some(1.0),
        default_color: Some(0.0),
        image_data: Some(solid(1, 1, [255, 0, 0, 255])),
        ..LayerMaskData::default()
    });
    let psd_open = doc(vec![
        pixel_layer("base", [0, 255, 0, 255], false),
        clip_open,
    ]);
    assert_eq!(flatten(&psd_open), [0, 0, 255, 255]);
}

#[test]
fn clipping_run_whose_base_is_itself_a_clipping_layer() {
    // A run that opens on a clipping layer is dropped entirely (orphaned clips).
    // Only the later non-clipping blue layer must be visible.
    let psd = doc(vec![
        pixel_layer("orphan-base", [255, 0, 0, 255], true),
        pixel_layer("orphan-clip", [0, 255, 0, 255], true),
        pixel_layer("visible", [0, 0, 255, 255], false),
    ]);
    assert_eq!(flatten(&psd), [0, 0, 255, 255]);
}

/// Clipping uses the clip's own alpha as the lerp weight:
/// `C = C_base + α_clip · (B − C_base)`.
///
/// It is deliberately **not** multiplied by the base layer's alpha. Multiplying
/// by base alpha would under-apply the clip on a semi-transparent base (a 50%
/// base would only pull halfway toward the clip colour), which is not
/// Photoshop's clipping model — the clip fully replaces colour inside the
/// base's coverage; coverage itself stays the base alpha.
#[test]
fn clip_lerp_weight_is_clip_alpha_not_base_alpha() {
    let base = pixel_layer("base", [255, 255, 255, 128], false); // 50% coverage
    let clip = pixel_layer("clip", [255, 0, 0, 255], true); // opaque red clip
    let psd = doc(vec![base, clip]);
    let pixel = flatten(&psd);

    // Correct model: full replace → pure red at the base's alpha.
    assert_eq!(pixel, [255, 0, 0, 128]);

    // Wrong model (α_clip * α_base = 0.5): white + 0.5·(red−white) = (255,128,128).
    assert_ne!(
        pixel,
        [255, 128, 128, 128],
        "clip must not be modulated by base alpha"
    );
}

#[test]
fn pass_through_fast_path_multiplies_with_backdrop() {
    // Fast path: PassThrough + opacity 1 + no mask + no clips → children blend
    // directly onto the document backdrop.
    let below = pixel_layer("below", [255, 0, 0, 255], false); // red
    let mut child = pixel_layer("mul", [0, 0, 255, 255], false); // blue
    child.blend_mode = Some(BlendMode::Multiply);
    let group = Layer {
        blend_mode: Some(BlendMode::PassThrough),
        opacity: Some(1.0),
        children: Some(vec![child]),
        additional_info: LayerAdditionalInfo {
            name: Some("pass".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    // Multiply(red, blue) = black.
    assert_eq!(flatten(&doc(vec![below, group])), [0, 0, 0, 255]);
}

#[test]
fn pass_through_fallback_isolates_then_blends_as_normal() {
    // Fallback: any of (opacity < 1, mask present, clips) isolates children
    // onto an empty buffer (blend modes see no backdrop), then composites the
    // group as Normal.
    let below = pixel_layer("below", [255, 0, 0, 255], false);
    let mut child = pixel_layer("mul", [0, 0, 255, 255], false);
    child.blend_mode = Some(BlendMode::Multiply);
    let group = Layer {
        blend_mode: Some(BlendMode::PassThrough),
        opacity: Some(0.5), // forces fallback
        children: Some(vec![child]),
        additional_info: LayerAdditionalInfo {
            name: Some("pass".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    // Isolated Multiply against empty backdrop yields the source blue; Normal
    // at 50% over red → (128, 0, 128).
    assert_eq!(
        flatten(&doc(vec![below.clone(), group])),
        [128, 0, 128, 255]
    );

    // Mask presence also forces the fallback even at opacity 1.
    let mut child2 = pixel_layer("mul", [0, 0, 255, 255], false);
    child2.blend_mode = Some(BlendMode::Multiply);
    let group_masked = Layer {
        blend_mode: Some(BlendMode::PassThrough),
        opacity: Some(1.0),
        children: Some(vec![child2]),
        additional_info: LayerAdditionalInfo {
            name: Some("pass-masked".into()),
            mask: Some(LayerMaskData {
                left: Some(0.0),
                top: Some(0.0),
                right: Some(1.0),
                bottom: Some(1.0),
                default_color: Some(255.0),
                image_data: Some(solid(1, 1, [255, 0, 0, 255])),
                ..LayerMaskData::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    // Isolated blue, then Normal over red at full opacity → blue.
    assert_eq!(flatten(&doc(vec![below, group_masked])), [0, 0, 255, 255]);
}

fn f32_layer(name: &str, samples: [f32; 4]) -> Layer {
    let mut data = Vec::with_capacity(16);
    for sample in samples {
        data.extend_from_slice(&sample.to_ne_bytes());
    }
    Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(1.0),
        bottom: Some(1.0),
        image_data: Some(PixelData {
            width: 1,
            height: 1,
            data,
            depth: 32,
        }),
        additional_info: LayerAdditionalInfo {
            name: Some(name.into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    }
}

#[test]
fn depth_normalization_short_nan_and_hdr_via_composite() {
    // Short native buffer → layer skipped (transparent result).
    let short = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(1.0),
        bottom: Some(1.0),
        image_data: Some(PixelData {
            width: 1,
            height: 1,
            data: vec![0u8; 8],
            depth: 32,
        }),
        additional_info: LayerAdditionalInfo {
            name: Some("short".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    let short_result = composite(
        &doc(vec![short]),
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: 16,
        },
    )
    .unwrap();
    assert_eq!(short_result.raster.sample(0, 0), Some([0, 0, 0, 0]));
    assert!(
        short_result.warnings.iter().any(|w| {
            matches!(
                &w.warning,
                psdx::composite::CompositeWarning::MalformedRaster { .. }
            )
        }),
        "expected MalformedRaster, got {:?}",
        short_result.warnings
    );

    // NaN → zero bytes after normalisation.
    assert_eq!(
        flatten(&doc(vec![f32_layer(
            "nan",
            [f32::NAN, f32::NAN, f32::NAN, f32::NAN]
        )])),
        [0, 0, 0, 0]
    );

    // HDR (>1) and negative samples clamp before gamma encode.
    assert_eq!(
        flatten(&doc(vec![f32_layer("hdr", [2.0, -1.0, 1.0, 1.0])])),
        [255, 0, 255, 255]
    );
}

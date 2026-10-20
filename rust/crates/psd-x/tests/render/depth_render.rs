//! 16/32-bit documents render; masks with bad depth do not hide layers.

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{Layer, LayerAdditionalInfo, LayerMaskData, PixelData, Psd, ReadOptions};
use psdx::read_psd;
use psdx::render::{ExportConcurrency, ExportError, ExportOptions, ExportResult, export_groups};

const FETCH_FIXTURES: &str = "set PSDX_FIXTURES_DIR";

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

fn skip_missing(name: &str) -> bool {
    if fixture_psd(name).is_some() {
        return false;
    }
    eprintln!("skip {name}: fixture missing (run {FETCH_FIXTURES})");
    true
}

/// Flat 16/32-bit fixtures have top-level layers, not groups. Wrap for Export As.
fn wrap_flat_children_as_group(mut psd: Psd) -> Psd {
    let children = psd.children.take().unwrap_or_default();
    psd.children = Some(vec![Layer {
        additional_info: LayerAdditionalInfo {
            name: Some("ExportRoot".into()),
            ..LayerAdditionalInfo::default()
        },
        children: Some(children),
        ..Layer::default()
    }]);
    psd
}

fn load_wrapped(name: &str, options: &ReadOptions) -> Psd {
    let path = fixture_psd(name).expect("fixture present");
    let bytes = fs::read(path).expect("read fixture");
    wrap_flat_children_as_group(read_psd(&bytes, options).expect("read_psd"))
}

fn off_export(psd: &Psd) -> Result<ExportResult, ExportError> {
    export_groups(
        psd,
        &ExportOptions {
            concurrency: ExportConcurrency::Off,
            ..ExportOptions::default()
        },
    )
}

fn solid(width: u32, height: u32, color: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, color.repeat((width * height) as usize))
}

fn group_with_layer(layer: Layer) -> Psd {
    Psd {
        width: 4.0,
        height: 4.0,
        children: Some(vec![Layer {
            additional_info: LayerAdditionalInfo {
                name: Some("Artwork".into()),
                ..LayerAdditionalInfo::default()
            },
            children: Some(vec![layer]),
            ..Layer::default()
        }]),
        ..Psd::default()
    }
}

#[test]
fn fixtures_16_and_32_bit_render_non_empty() {
    for name in ["16bits", "32bits"] {
        if skip_missing(name) {
            continue;
        }
        let psd = load_wrapped(name, &ReadOptions::default());
        let result = off_export(&psd).expect("export should render");
        assert!(
            !result.assets.is_empty(),
            "{name}: expected non-empty assets"
        );
        assert!(result.assets[0].bytes.len() > 8);
    }
}

#[test]
fn default_read_and_use_image_data_produce_identical_export() {
    for name in ["16bits", "32bits"] {
        if skip_missing(name) {
            continue;
        }
        let default_psd = load_wrapped(name, &ReadOptions::default());
        let native_psd = load_wrapped(
            name,
            &ReadOptions {
                use_image_data: Some(true),
                ..ReadOptions::default()
            },
        );
        let a = off_export(&default_psd).expect("default export");
        let b = off_export(&native_psd).expect("native-depth export");
        assert_eq!(a.assets.len(), b.assets.len(), "{name} asset count");
        for (left, right) in a.assets.iter().zip(&b.assets) {
            assert_eq!(left.width, right.width, "{name} width");
            assert_eq!(left.height, right.height, "{name} height");
            assert_eq!(left.bytes, right.bytes, "{name} encoded bytes differ");
        }
    }
}

#[test]
fn unsupported_depth_mask_keeps_layer_visible_and_warns() {
    let layer = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(2.0),
        bottom: Some(2.0),
        image_data: Some(solid(2, 2, [255, 0, 0, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("Masked".into()),
            mask: Some(LayerMaskData {
                default_color: Some(0.0),
                left: Some(0.0),
                top: Some(0.0),
                right: Some(2.0),
                bottom: Some(2.0),
                image_data: Some(PixelData {
                    width: 2,
                    height: 2,
                    // All-zero 16-bit samples would hide the layer if applied.
                    data: vec![0u8; 2 * 2 * 4 * 2],
                    depth: 16,
                }),
                ..LayerMaskData::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    let result = off_export(&group_with_layer(layer)).expect("layer remains visible");
    assert!(!result.assets.is_empty());
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("unsupported depth 16") && w.contains("ignored")),
        "warnings: {:?}",
        result.warnings
    );
}

#[test]
fn mask_without_pixel_data_keeps_layer_visible() {
    let layer = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(2.0),
        bottom: Some(2.0),
        image_data: Some(solid(2, 2, [0, 255, 0, 255])),
        additional_info: LayerAdditionalInfo {
            name: Some("EmptyMask".into()),
            mask: Some(LayerMaskData {
                default_color: Some(0.0),
                ..LayerMaskData::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    let result = off_export(&group_with_layer(layer)).expect("layer remains visible");
    assert!(!result.assets.is_empty());
    assert!(
        result
            .warnings
            .iter()
            .any(|w| w.contains("no pixel data") && w.contains("ignored")),
        "warnings: {:?}",
        result.warnings
    );
}

#[test]
fn short_pixel_buffer_is_reported_not_silently_short_rendered() {
    let layer = Layer {
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
    };
    let err = off_export(&group_with_layer(layer)).expect_err("no opaque content");
    assert!(matches!(err, ExportError::NoRenderedAssets));
}

#[test]
fn depth16_layer_bounds_are_not_dropped() {
    // One opaque 16-bit pixel — if source_bounds gated on depth, export would be empty.
    let mut data = Vec::new();
    for sample in [0xFFFFu16, 0, 0, 0xFFFF] {
        data.extend_from_slice(&sample.to_ne_bytes());
    }
    let layer = Layer {
        left: Some(1.0),
        top: Some(1.0),
        right: Some(2.0),
        bottom: Some(2.0),
        image_data: Some(PixelData {
            width: 1,
            height: 1,
            data,
            depth: 16,
        }),
        ..Layer::default()
    };
    let result = off_export(&group_with_layer(layer)).expect("16-bit layer renders");
    assert_eq!(result.assets.len(), 1);
    assert!(result.assets[0].width >= 1 && result.assets[0].height >= 1);
}

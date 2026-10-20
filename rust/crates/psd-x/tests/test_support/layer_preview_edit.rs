//! Drop layer preview, keep geometry.
//!
//! Self-loop tests (read → edit → write → read). Skip cleanly when the
//! ag-psd fixture corpus is not present.

use psdx::edit::{DropLayerPreviewError, drop_layer_preview};
use psdx::psd::{
    ChannelId, ColorMode, Compression, Layer, LayerRawData, LayerRawDataChannel, PixelData, Psd,
    ReadOptions, WriteOptions,
};
use psdx::test_corpus;
use psdx::{read_psd, write_psd};
use std::path::PathBuf;

fn fixtures_root() -> PathBuf {
    test_corpus::corpus_root()
}

fn fixture_psd(kind: &str, name: &str) -> Option<PathBuf> {
    let path = fixtures_root().join(kind).join(name).join("src.psd");
    path.is_file().then_some(path)
}

fn first_leaf_with_pixels(layers: &mut [Layer]) -> Option<&mut Layer> {
    for layer in layers {
        if layer.children.is_some() {
            if let Some(found) = layer
                .children
                .as_mut()
                .and_then(|c| first_leaf_with_pixels(c))
            {
                return Some(found);
            }
            continue;
        }
        let has_pixels =
            layer.image_data.is_some() || layer.canvas.is_some() || layer.raw_data.is_some();
        if has_pixels {
            return Some(layer);
        }
    }
    None
}

fn layer_rect(layer: &Layer) -> (f64, f64, f64, f64) {
    (
        layer.top.unwrap_or(0.0),
        layer.left.unwrap_or(0.0),
        layer.bottom.unwrap_or(0.0),
        layer.right.unwrap_or(0.0),
    )
}

fn assert_fully_transparent(img: &PixelData) {
    assert!(
        img.data.chunks_exact(4).all(|px| px[3] == 0),
        "expected fully transparent alpha; sample={:?}",
        &img.data[..img.data.len().min(16)]
    );
}

/// Fixture layer: after drop, write+reread keeps rect and yields transparent pixels.
#[test]
fn fixture_drop_keeps_geometry_and_clears_pixels() {
    let Some(src) = fixture_psd("read", "layers") else {
        eprintln!("skip: vendor/agpsd-fixtures/read/layers missing");
        return;
    };
    let bytes = std::fs::read(&src).expect("read fixture");
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("read_psd");

    let composite_before = psd.image_data.clone();
    let thumb_before = psd
        .image_resources
        .as_ref()
        .and_then(|r| r.thumbnail.as_ref())
        .cloned();
    let engine_before = psd.additional_info.engine_data.clone();

    let layer = first_leaf_with_pixels(psd.children.as_mut().expect("children"))
        .expect("fixture should have a pixel layer");
    let rect_before = layer_rect(layer);
    assert!(rect_before.2 > rect_before.0 || rect_before.3 > rect_before.1);

    drop_layer_preview(layer, psd.color_mode).expect("drop");

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(
        &written,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("reread");

    let layer2 = find_matching_leaf(reread.children.as_ref().expect("children"), rect_before)
        .expect("matching leaf");

    assert_eq!(layer_rect(layer2), rect_before);
    let img = layer2.image_data.as_ref().expect("image_data after reread");
    assert_eq!(
        (img.width, img.height),
        (
            (rect_before.3 - rect_before.1) as u32,
            (rect_before.2 - rect_before.0) as u32
        )
    );
    assert_fully_transparent(img);

    // Document composite / thumbnail / doc-level text blob untouched by the edit.
    assert_same_pixels(psd.image_data.as_ref(), composite_before.as_ref());
    assert_same_pixels(
        psd.image_resources
            .as_ref()
            .and_then(|r| r.thumbnail.as_ref()),
        thumb_before.as_ref(),
    );
    assert_eq!(psd.additional_info.engine_data, engine_before);
}

fn assert_same_pixels(a: Option<&PixelData>, b: Option<&PixelData>) {
    match (a, b) {
        (None, None) => {}
        (Some(a), Some(b)) => {
            assert_eq!((a.width, a.height, a.depth), (b.width, b.height, b.depth));
            assert_eq!(a.data, b.data);
        }
        _ => panic!(
            "pixel presence mismatch: {} vs {}",
            a.is_some(),
            b.is_some()
        ),
    }
}

fn find_matching_leaf(layers: &[Layer], rect: (f64, f64, f64, f64)) -> Option<&Layer> {
    for layer in layers {
        if let Some(children) = layer.children.as_ref() {
            if let Some(found) = find_matching_leaf(children, rect) {
                return Some(found);
            }
            continue;
        }
        if layer_rect(layer) == rect {
            return Some(layer);
        }
    }
    None
}

/// Layer mask still round-trips after dropping the layer preview.
#[test]
fn fixture_layer_mask_round_trips() {
    let Some(src) = fixture_psd("read", "layer-mask") else {
        eprintln!("skip: vendor/agpsd-fixtures/read/layer-mask missing");
        return;
    };
    let bytes = std::fs::read(&src).expect("read fixture");
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("read_psd");

    let layer =
        first_leaf_with_pixels(psd.children.as_mut().expect("children")).expect("layer-mask leaf");
    let mask_before = layer
        .additional_info
        .mask
        .as_ref()
        .expect("fixture mask")
        .clone();
    let mask_pixels_before = mask_before
        .image_data
        .as_ref()
        .expect("decoded mask pixels")
        .data
        .clone();
    let rect_before = layer_rect(layer);

    drop_layer_preview(layer, psd.color_mode).expect("drop");

    // Mask must still be present on the in-memory layer after the edit.
    let mask_after_edit = layer.additional_info.mask.as_ref().expect("mask kept");
    assert_eq!(mask_after_edit.top, mask_before.top);
    assert_eq!(mask_after_edit.left, mask_before.left);
    assert_eq!(mask_after_edit.bottom, mask_before.bottom);
    assert_eq!(mask_after_edit.right, mask_before.right);
    assert_eq!(
        mask_after_edit.image_data.as_ref().map(|p| &p.data),
        Some(&mask_pixels_before)
    );

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(
        &written,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("reread");

    let layer2 = find_matching_leaf(reread.children.as_ref().expect("children"), rect_before)
        .expect("layer after reread");
    assert_eq!(layer_rect(layer2), rect_before);
    assert_fully_transparent(layer2.image_data.as_ref().expect("pixels"));

    let mask2 = layer2.additional_info.mask.as_ref().expect("mask reread");
    assert_eq!(mask2.top, mask_before.top);
    assert_eq!(mask2.left, mask_before.left);
    assert_eq!(mask2.bottom, mask_before.bottom);
    assert_eq!(mask2.right, mask_before.right);
    assert_eq!(
        mask2.image_data.as_ref().map(|p| &p.data),
        Some(&mask_pixels_before)
    );
}

/// Documents read with `use_raw_data` still drop preview (raw short-circuit cleared).
#[test]
fn fixture_use_raw_data_path() {
    let Some(src) = fixture_psd("read", "layer-mask") else {
        eprintln!("skip: vendor/agpsd-fixtures/read/layer-mask missing");
        return;
    };
    let bytes = std::fs::read(&src).expect("read fixture");
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_raw_data: Some(true),
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("read_psd");

    let layer = first_leaf_with_pixels(psd.children.as_mut().expect("children")).expect("leaf");
    assert!(
        layer.raw_data.is_some(),
        "use_raw_data must populate raw_data"
    );
    assert!(layer.image_data.is_none());
    let rect_before = layer_rect(layer);
    let had_mask = layer.additional_info.mask.is_some();

    drop_layer_preview(layer, psd.color_mode).expect("drop");
    assert!(layer.raw_data.is_none(), "raw_data must be cleared");
    assert!(layer.image_data.is_some());
    if had_mask {
        assert!(
            layer
                .additional_info
                .mask
                .as_ref()
                .and_then(|m| m.image_data.as_ref())
                .is_some(),
            "mask pixels must be materialized from raw before clear"
        );
    }

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(
        &written,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("reread");

    let layer2 = find_matching_leaf(reread.children.as_ref().expect("children"), rect_before)
        .expect("layer");
    assert_eq!(layer_rect(layer2), rect_before);
    assert_fully_transparent(layer2.image_data.as_ref().expect("pixels"));
    if had_mask {
        assert!(layer2.additional_info.mask.is_some());
    }
}

/// Non-RGB documents get a clear error; layer is not collapsed.
#[test]
fn non_rgb_errors_without_collapse() {
    let Some(src) = fixture_psd("read", "grayscale") else {
        // Synthetic fallback when fixture missing.
        let mut layer = Layer::default();
        layer.top = Some(0.0);
        layer.left = Some(0.0);
        layer.bottom = Some(4.0);
        layer.right = Some(4.0);
        layer.image_data = Some(PixelData::rgba8(4, 4, vec![0xff; 4 * 4 * 4]));
        let err =
            drop_layer_preview(&mut layer, Some(ColorMode::Grayscale)).expect_err("grayscale");
        assert!(matches!(
            err,
            DropLayerPreviewError::UnsupportedColorMode(Some(ColorMode::Grayscale))
        ));
        assert_eq!(layer_rect(&layer), (0.0, 0.0, 4.0, 4.0));
        assert!(
            layer
                .image_data
                .as_ref()
                .unwrap()
                .data
                .iter()
                .all(|&b| b == 0xff)
        );
        return;
    };

    let bytes = std::fs::read(&src).expect("read fixture");
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("read_psd");
    assert_eq!(psd.color_mode, Some(ColorMode::Grayscale));

    let layer =
        first_leaf_with_pixels(psd.children.as_mut().expect("children")).expect("grayscale leaf");
    let rect_before = layer_rect(layer);
    let pixels_before = layer.image_data.clone();

    let err = drop_layer_preview(layer, psd.color_mode).expect_err("must reject");
    assert!(matches!(
        err,
        DropLayerPreviewError::UnsupportedColorMode(Some(ColorMode::Grayscale))
    ));
    assert_eq!(layer_rect(layer), rect_before);
    assert_same_pixels(layer.image_data.as_ref(), pixels_before.as_ref());
}

/// Synthetic: clearing image_data alone would collapse; drop_layer_preview must not.
#[test]
fn synthetic_does_not_collapse_like_clearing_pixels() {
    let mut layer = Layer::default();
    layer.top = Some(5.0);
    layer.left = Some(7.0);
    layer.bottom = Some(15.0);
    layer.right = Some(17.0);
    layer.image_data = Some(PixelData::rgba8(10, 10, vec![0x11; 10 * 10 * 4]));

    let mut collapsed = layer.clone();
    collapsed.image_data = None;
    collapsed.canvas = None;
    let collapsed_psd = Psd {
        width: 32.0,
        height: 32.0,
        color_mode: Some(ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        children: Some(vec![collapsed]),
        image_data: Some(PixelData::rgba8(32, 32, vec![0u8; 32 * 32 * 4])),
        ..Default::default()
    };
    let collapsed_bytes = write_psd(&collapsed_psd, &WriteOptions::default()).unwrap();
    let collapsed_reread = read_psd(
        &collapsed_bytes,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let collapsed_layer = &collapsed_reread.children.as_ref().unwrap()[0];
    // Writer collapses empty pixel layers to a zero-size rect at top/left.
    assert_eq!(collapsed_layer.top, Some(5.0));
    assert_eq!(collapsed_layer.left, Some(7.0));
    assert_eq!(collapsed_layer.bottom, Some(5.0));
    assert_eq!(collapsed_layer.right, Some(7.0));

    drop_layer_preview(&mut layer, Some(ColorMode::Rgb)).unwrap();
    let psd = Psd {
        width: 32.0,
        height: 32.0,
        color_mode: Some(ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        children: Some(vec![layer]),
        image_data: Some(PixelData::rgba8(32, 32, vec![0u8; 32 * 32 * 4])),
        ..Default::default()
    };
    let bytes = write_psd(&psd, &WriteOptions::default()).unwrap();
    let reread = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .unwrap();
    let layer2 = &reread.children.as_ref().unwrap()[0];
    assert_eq!(layer_rect(layer2), (5.0, 7.0, 15.0, 17.0));
    assert_fully_transparent(layer2.image_data.as_ref().unwrap());
}

#[test]
fn materialization_failure_leaves_layer_observably_unchanged() {
    let mut layer = Layer {
        top: Some(3.0),
        left: Some(5.0),
        bottom: Some(5.0),
        right: Some(7.0),
        image_data: Some(PixelData::rgba8(2, 2, vec![0x7a; 2 * 2 * 4])),
        raw_data: Some(LayerRawData {
            color_mode: ColorMode::Rgb,
            bits_per_channel: 8.0,
            large: false,
            channels: vec![LayerRawDataChannel {
                id: ChannelId::UserMask as i16,
                compression: Compression::RawData,
                data: Some(vec![0, 0, 0, 0]),
            }],
        }),
        ..Layer::default()
    };
    let before = serde_json::to_value(&layer).expect("serialize layer snapshot");

    let err = drop_layer_preview(&mut layer, Some(ColorMode::Rgb))
        .expect_err("missing mask metadata must fail materialization");

    assert!(matches!(err, DropLayerPreviewError::Materialize(_)));
    assert_eq!(
        serde_json::to_value(&layer).expect("serialize layer after failure"),
        before,
        "materialization failure must not change any observable layer field"
    );
}

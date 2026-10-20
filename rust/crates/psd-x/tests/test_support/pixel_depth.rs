//! Acceptance: 16/32-bit composite + layer pixels match golden `.bin`
//! dumps, and `rawData` pass-through round-trips channel bytes.
//!
//! Skips cleanly when fixtures or goldens are absent (gitignored corpora).

use psdx::helpers::offset_for_channel;
use psdx::psd::{
    ChannelId, Compression, Layer, LayerRawData, LayerRawDataChannel, PixelData, Psd, ReadOptions,
    WriteOptions,
};
use psdx::test_corpus;
use psdx::{read_psd, write_psd};
use std::fs;
use std::path::PathBuf;

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

fn golden_dir(name: &str) -> PathBuf {
    test_corpus::golden_root().join("read").join(name)
}

fn golden_composite(name: &str) -> Option<PathBuf> {
    let p = golden_dir(name).join("composite.bin");
    if p.is_file() { Some(p) } else { None }
}

fn golden_layer_bin(name: &str, path: &str) -> Option<PathBuf> {
    let p = golden_dir(name).join(format!("{path}.bin"));
    if p.is_file() { Some(p) } else { None }
}

fn read_opts_image_data() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        throw_for_missing_features: Some(true),
        log_missing_features: Some(true),
        strict: Some(false),
        debug: Some(true),
        ..Default::default()
    }
}

fn assert_composite_matches(name: &str) {
    let Some(src) = fixture_psd(name) else {
        eprintln!("skip {name}: fixture missing (set PSDX_FIXTURES_DIR)");
        return;
    };
    let Some(golden_path) = golden_composite(name) else {
        eprintln!("skip {name}: golden missing (set PSDX_GOLDENS_DIR)");
        return;
    };

    let bytes = fs::read(&src).expect("read fixture");
    let psd = read_psd(&bytes, &read_opts_image_data()).expect("read_psd");
    let image = psd
        .image_data
        .as_ref()
        .unwrap_or_else(|| panic!("{name}: expected image_data"));
    let golden = fs::read(&golden_path).expect("read golden");

    assert_eq!(
        image.data.len(),
        golden.len(),
        "{name}: composite byte length {} != golden {}",
        image.data.len(),
        golden.len()
    );
    assert_eq!(
        image.data, golden,
        "{name}: composite pixels differ from golden .bin"
    );

    let expected_depth = if name.starts_with("16") {
        16
    } else if name.starts_with("32") {
        32
    } else {
        8
    };
    assert_eq!(
        image.depth, expected_depth,
        "{name}: depth {} != {expected_depth}",
        image.depth
    );
}

#[test]
fn composite_16bits_matches_golden_bin() {
    assert_composite_matches("16bits");
}

#[test]
fn composite_32bits_matches_golden_bin() {
    assert_composite_matches("32bits");
}

/// Walk top-level (and nested) layers; compare leaf `image_data` / masks to
/// structure-path goldens (`0.bin`, `1.bin`, `0.mask.bin`, …).
fn assert_layer_pixels_match(name: &str, expected_top_level: usize) {
    let Some(src) = fixture_psd(name) else {
        eprintln!("skip {name} layers: fixture missing (set PSDX_FIXTURES_DIR)");
        return;
    };
    // Require at least the first layer golden so a missing corpus skips cleanly.
    if golden_layer_bin(name, "0").is_none() {
        eprintln!("skip {name} layers: golden 0.bin missing (set PSDX_GOLDENS_DIR)");
        return;
    }

    let bytes = fs::read(&src).expect("read fixture");
    let psd = read_psd(&bytes, &read_opts_image_data()).expect("read_psd");
    let children = psd
        .children
        .as_ref()
        .unwrap_or_else(|| panic!("{name}: expected children from Lr16/Lr32"));
    assert_eq!(
        children.len(),
        expected_top_level,
        "{name}: top-level layer count {} != {expected_top_level}",
        children.len()
    );

    fn walk(name: &str, layers: &[Layer], prefix: &str) {
        for (i, layer) in layers.iter().enumerate() {
            let path = if prefix.is_empty() {
                i.to_string()
            } else {
                format!("{prefix}.{i}")
            };
            if let Some(kids) = layer.children.as_ref() {
                walk(name, kids, &path);
            } else if let Some(golden_path) = golden_layer_bin(name, &path) {
                let image = layer
                    .image_data
                    .as_ref()
                    .unwrap_or_else(|| panic!("{name}: layer {path} missing image_data"));
                let golden = fs::read(&golden_path).expect("read layer golden");
                assert_eq!(
                    image.data.len(),
                    golden.len(),
                    "{name}: layer {path} byte length {} != golden {}",
                    image.data.len(),
                    golden.len()
                );
                assert_eq!(
                    image.data, golden,
                    "{name}: layer {path} pixels differ from golden .bin"
                );
            }
            if let Some(mask) = layer.additional_info.mask.as_ref() {
                let mask_path = format!("{path}.mask");
                if let Some(golden_path) = golden_layer_bin(name, &mask_path) {
                    let image = mask
                        .image_data
                        .as_ref()
                        .unwrap_or_else(|| panic!("{name}: layer {mask_path} missing image_data"));
                    let golden = fs::read(&golden_path).expect("read mask golden");
                    assert_eq!(image.data, golden, "{name}: {mask_path} pixels differ");
                }
            }
            if let Some(mask) = layer.additional_info.real_mask.as_ref() {
                let mask_path = format!("{path}.real-mask");
                if let Some(golden_path) = golden_layer_bin(name, &mask_path) {
                    let image = mask
                        .image_data
                        .as_ref()
                        .unwrap_or_else(|| panic!("{name}: layer {mask_path} missing image_data"));
                    let golden = fs::read(&golden_path).expect("read real-mask golden");
                    assert_eq!(image.data, golden, "{name}: {mask_path} pixels differ");
                }
            }
        }
    }

    walk(name, children, "");
}

#[test]
fn layers_16bits_match_golden_bins() {
    assert_layer_pixels_match("16bits", 1);
}

#[test]
fn layers_32bits_match_golden_bins() {
    assert_layer_pixels_match("32bits", 2);
}

#[test]
fn extra_channel_id_not_aliased_to_transparency() {
    // Upstream helpers.spec: offsetForChannel(10, false) === 11
    assert_eq!(offset_for_channel(10, false), 11);
    assert_eq!(offset_for_channel(4, false), 5);
    assert_eq!(offset_for_channel(ChannelId::Transparency as i16, false), 3);
}

#[test]
fn raw_data_passthrough_round_trip_bytes() {
    // Synthetic 8-bit layer with pre-encoded rawData — writer emits those bytes
    // unchanged (upstream psdWriter.ts:661-664); reader with use_raw_data keeps them.
    let channel_bytes = vec![0u8, 1, 2, 3, 4, 5, 6, 7];
    let mut layer = Layer::default();
    layer.top = Some(0.0);
    layer.left = Some(0.0);
    layer.bottom = Some(2.0);
    layer.right = Some(2.0);
    layer.opacity = Some(1.0);
    layer.raw_data = Some(LayerRawData {
        color_mode: psdx::psd::ColorMode::Rgb,
        bits_per_channel: 8.0,
        large: false,
        channels: vec![
            LayerRawDataChannel {
                id: ChannelId::Transparency as i16,
                compression: Compression::RawData,
                data: Some(channel_bytes.clone()),
            },
            LayerRawDataChannel {
                id: ChannelId::Color0 as i16,
                compression: Compression::RawData,
                data: Some(channel_bytes.clone()),
            },
            LayerRawDataChannel {
                id: ChannelId::Color1 as i16,
                compression: Compression::RawData,
                data: Some(channel_bytes.clone()),
            },
            LayerRawDataChannel {
                id: ChannelId::Color2 as i16,
                compression: Compression::RawData,
                data: Some(channel_bytes.clone()),
            },
        ],
    });

    let psd = Psd {
        width: 2.0,
        height: 2.0,
        color_mode: Some(psdx::psd::ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        children: Some(vec![layer]),
        image_data: Some(PixelData::rgba8(2, 2, vec![0u8; 2 * 2 * 4])),
        ..Default::default()
    };
    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(
        &written,
        &ReadOptions {
            use_raw_data: Some(true),
            use_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("reread");

    assert!(reread.raw_composite_data.is_some());
    let kids = reread.children.as_ref().expect("children");
    let raw = kids[0].raw_data.as_ref().expect("raw_data preserved");
    assert_eq!(raw.channels.len(), 4);
    for c in &raw.channels {
        assert_eq!(
            c.data.as_deref(),
            Some(channel_bytes.as_slice()),
            "rawData channel bytes must round-trip unchanged"
        );
    }
}

/// Smoke: reading with use_raw_data populates raw_composite_data from a fixture.
#[test]
fn raw_composite_data_from_fixture() {
    let Some(src) = fixture_psd("layers") else {
        eprintln!("skip raw_composite: layers fixture missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let psd = read_psd(
        &bytes,
        &ReadOptions {
            use_raw_data: Some(true),
            skip_layer_image_data: Some(true),
            ..Default::default()
        },
    )
    .expect("read");
    let raw = psd.raw_composite_data.expect("raw_composite_data");
    assert!(!raw.is_empty());
    assert!(psd.image_data.is_none());
    assert!(psd.canvas.is_none());
}

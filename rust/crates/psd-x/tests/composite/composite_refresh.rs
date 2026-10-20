//! Explicit document-composite rebuild.

use std::fs;
use std::path::PathBuf;

use psdx::composite::CompositeWarning;
use psdx::psd::{ColorMode, Layer, LayerAdditionalInfo, PixelData, Psd, ReadOptions, WriteOptions};
use psdx::{RefreshCompositeError, read_psd, refresh_document_composite, write_psd};

fn solid(width: u32, height: u32, rgba: [u8; 4]) -> PixelData {
    PixelData::rgba8(width, height, rgba.repeat((width * height) as usize))
}

fn rgb_doc(w: u32, h: u32, layer_rgba: [u8; 4], composite: Option<[u8; 4]>) -> Psd {
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
        image_data: composite.map(|c| solid(w, h, c)),
        ..Psd::default()
    }
}

#[test]
fn refresh_writes_and_reads_back_consistently() {
    let mut psd = rgb_doc(4, 3, [40, 50, 60, 255], Some([1, 2, 3, 255]));
    let report = refresh_document_composite(&mut psd).unwrap();
    assert!(!report.transparency_changed);
    assert_eq!(
        &psd.image_data.as_ref().unwrap().data[..4],
        &[40, 50, 60, 255]
    );

    let bytes = write_psd(&psd, &WriteOptions::default()).unwrap();
    let again = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            ..ReadOptions::default()
        },
    )
    .unwrap();
    let img = again.image_data.as_ref().expect("composite after read");
    assert_eq!((img.width, img.height), (4, 3));
    assert_eq!(&img.data[..4], &[40, 50, 60, 255]);
}

#[test]
fn refresh_is_expected_to_change_bytes() {
    // Rebuild must never run inside a byte-identity round-trip path: replacing
    // the stored composite changes the image-data section by construction.
    let mut psd = rgb_doc(3, 2, [200, 100, 50, 255], Some([0, 0, 0, 255]));
    let before = write_psd(&psd, &WriteOptions::default()).unwrap();
    refresh_document_composite(&mut psd).unwrap();
    let after = write_psd(&psd, &WriteOptions::default()).unwrap();
    assert_ne!(
        before, after,
        "rebuilding the document composite is expected to change PSD bytes"
    );
}

#[test]
fn refuses_non_rgb_documents() {
    let mut psd = rgb_doc(2, 2, [1, 2, 3, 255], None);
    psd.color_mode = None;
    assert!(matches!(
        refresh_document_composite(&mut psd),
        Err(RefreshCompositeError::UnsupportedColorMode(None))
    ));
}

#[test]
fn refuses_when_a_layer_is_skipped() {
    let mut psd = rgb_doc(2, 2, [0, 0, 0, 0], Some([9, 9, 9, 255]));
    {
        let layer = &mut psd.children.as_mut().unwrap()[0];
        layer.left = None;
        layer.top = None;
        layer.right = None;
        layer.bottom = None;
        layer.image_data = Some(solid(2, 2, [255, 0, 0, 255]));
    }
    let err = refresh_document_composite(&mut psd).unwrap_err();
    match err {
        RefreshCompositeError::LayersSkipped(reports) => {
            assert!(reports.iter().any(|r| {
                r.warning.is_skip_class()
                    && matches!(r.warning, CompositeWarning::MissingGeometry { .. })
            }));
        }
        other => panic!("expected LayersSkipped, got {other:?}"),
    }
    assert_eq!(&psd.image_data.as_ref().unwrap().data[..4], &[9, 9, 9, 255]);
}

#[test]
fn writes_both_slots_when_both_populated() {
    let mut psd = rgb_doc(2, 2, [7, 8, 9, 255], Some([1, 1, 1, 255]));
    psd.canvas = Some(solid(2, 2, [2, 2, 2, 255]));
    refresh_document_composite(&mut psd).unwrap();
    assert_eq!(&psd.image_data.as_ref().unwrap().data[..4], &[7, 8, 9, 255]);
    assert_eq!(&psd.canvas.as_ref().unwrap().data[..4], &[7, 8, 9, 255]);
}

#[test]
fn editing_modules_do_not_import_composite_or_refresh() {
    // Rebuild is caller-invoked and must not live inside
    // text_edit / smart_object; those modules must not pull compositing in.
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src");
    for dir in ["text_edit", "smart_object", "edit"] {
        let dir_path = root.join(dir);
        for entry in fs::read_dir(&dir_path).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let text = fs::read_to_string(&path).unwrap();
            assert!(
                !text.contains("crate::composite")
                    && !text.contains("crate::composite_refresh")
                    && !text.contains("refresh_document_composite"),
                "{} must not import compositing/refresh",
                path.display()
            );
        }
    }
}

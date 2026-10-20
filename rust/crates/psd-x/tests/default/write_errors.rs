//! Write-side failures must reach the caller of `write_psd`.
//!
//! `write_additional_info` delegates each section body to a group-module, and
//! several of those bodies validate as they write (`lnk2`'s `check_guid`,
//! `Txt2`'s base64 decode). A failing body has already emitted a partial record
//! into the buffer, so dropping its error yields a file that is corrupt at the
//! byte level but reported as `Ok`. These tests pin that the error escapes
//! instead.

use psdx::psd::{ColorMode, LinkedFile, PixelData, Psd, WriteOptions};
use psdx::write_psd;

fn document_with_linked_file(id: &str) -> Psd {
    Psd {
        width: 1.0,
        height: 1.0,
        color_mode: Some(ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        image_data: Some(PixelData::rgba8(1, 1, vec![0u8; 4])),
        linked_files: Some(vec![LinkedFile {
            id: id.to_string(),
            name: "image.png".into(),
            data: Some(vec![1, 2, 3, 4]),
            file_type: Some("8BPS".into()),
            creator: Some("8BIM".into()),
            ..LinkedFile::default()
        }]),
        ..Psd::default()
    }
}

/// A linked-file id that is not a lowercase hyphenated GUID makes
/// `write_linked_files` bail out mid-record, after the `lnk2` length
/// placeholder and part of the `liFD` record are already in the buffer.
#[test]
fn non_guid_linked_file_id_fails_the_write() {
    let psd = document_with_linked_file("not-a-guid");

    let result = write_psd(&psd, &WriteOptions::default());

    let err = result.expect_err(
        "write_psd returned Ok for a non-GUID linked file id — the lnk2 section \
         in those bytes is truncated mid-record",
    );
    let message = err.to_string();
    assert!(
        message.contains("GUID format"),
        "expected the group-module's own message to survive, got: {message}"
    );
    assert!(
        message.contains("lnk2"),
        "expected the failing key in the message, got: {message}"
    );
}

/// The same document with a well-formed id writes normally — the check above
/// is rejecting the id, not linked files as such.
#[test]
fn guid_linked_file_id_writes() {
    let psd = document_with_linked_file("20953ddb-9391-11ec-b4f1-c15674f50bc4");

    write_psd(&psd, &WriteOptions::default()).expect("valid GUID must write");
}

/// SoLd validates the `PlacedLayer.placed` instance GUID on write.
#[test]
fn non_guid_placed_instance_id_fails_the_write() {
    use psdx::psd::{Layer, LayerAdditionalInfo, PlacedLayer, PlacedLayerType};

    let linked = "20953ddb-9391-11ec-b4f1-c15674f50bc4";
    let mut layer = Layer {
        additional_info: LayerAdditionalInfo {
            placed_layer: Some(PlacedLayer {
                id: linked.into(),
                placed: Some("not-a-guid".into()),
                layer_type: Some(PlacedLayerType::Raster),
                width: Some(1.0),
                height: Some(1.0),
                transform: vec![0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0],
                ..PlacedLayer::default()
            }),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    layer.top = Some(0.0);
    layer.left = Some(0.0);
    layer.bottom = Some(1.0);
    layer.right = Some(1.0);

    let mut psd = document_with_linked_file(linked);
    psd.children = Some(vec![layer]);

    let err = write_psd(&psd, &WriteOptions::default())
        .expect_err("write_psd returned Ok for a non-GUID placed instance id");
    let message = err.to_string();
    assert!(
        message.contains("GUID format"),
        "expected GUID format message, got: {message}"
    );
}

/// `Txt2` is byte-opaque: `info.engine_data` is base64 that the writer decodes
/// straight back. Invalid base64 fails inside the section body, on the
/// per-layer `write_additional_info` call rather than the document-level one.
#[test]
fn invalid_txt2_base64_fails_the_write() {
    use psdx::psd::Layer;

    let mut layer = Layer::default();
    layer.additional_info.engine_data = Some("not valid base64 !!!".into());

    let psd = Psd {
        width: 1.0,
        height: 1.0,
        color_mode: Some(ColorMode::Rgb),
        bits_per_channel: Some(8.0),
        children: Some(vec![layer]),
        image_data: Some(PixelData::rgba8(1, 1, vec![0u8; 4])),
        ..Psd::default()
    };

    let err = write_psd(&psd, &WriteOptions::default())
        .expect_err("write_psd returned Ok for undecodable Txt2 engine data");
    assert!(
        err.to_string().contains("Txt2"),
        "expected the failing key in the message, got: {err}"
    );
}

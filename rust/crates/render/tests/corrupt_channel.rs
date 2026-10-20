//! An undecodable layer channel must refuse the document instead of rendering
//! an opaque black layer.
//!
//! `psdx` keeps a recover-and-zero policy for damage it cannot interpret: a ZIP
//! plane that fails to inflate leaves the samples at zero and still reports
//! success. That is the right trade-off for an editor, where the layer has to
//! round-trip, but the compositor *consumes* those samples — so the same
//! document used to render a flat black layer that looked like a valid
//! template, and the user got a wrong image instead of an error. The renderer
//! therefore opts in to `ReadOptions::corrupt_channel_is_fatal`; this test pins
//! the resulting refusal out to the public error code.

use render::{ParsedTemplate, ProductResourcePolicy, RenderErrorCode};

/// Phase reported by `crate::psd::map_read_error` for `ReadError::CorruptChannel`.
const CHANNEL_DECODE: &str = "channel-decode";

fn be16(bytes: &mut Vec<u8>, value: u16) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

fn be32(bytes: &mut Vec<u8>, value: u32) {
    bytes.extend_from_slice(&value.to_be_bytes());
}

/// One 2×2 RGB layer carrying a single red channel.
///
/// `channel.length` includes the 2-byte compression tag, which is what the
/// reader uses to skip to the next channel (`reader.offset = start + length`).
fn layer_record(payload: &[u8]) -> Vec<u8> {
    let mut record = Vec::new();
    for edge in [0_i32, 0, 2, 2] {
        // top, left, bottom, right
        record.extend_from_slice(&edge.to_be_bytes());
    }
    be16(&mut record, 1); // channel count
    be16(&mut record, 0); // channel id 0 = red
    be32(&mut record, 2 + payload.len() as u32);

    record.extend_from_slice(b"8BIM");
    record.extend_from_slice(b"norm");
    record.push(0xff); // opacity
    record.push(0x00); // clipping
    record.push(0x00); // flags
    record.push(0x00); // filler

    // Extra data: layer mask data, blending ranges, pascal name. The name is
    // padded so that (length + 1) is a multiple of the requested alignment.
    be32(&mut record, 9);
    be32(&mut record, 0); // no layer mask data
    be32(&mut record, 0); // no blending ranges
    record.push(0x00); // empty name, already aligned to 1

    record
}

/// A 2×2 RGB8 PSD holding one layer whose only colour channel is
/// `compression`-encoded and carries `payload`.
fn one_layer_psd(compression: u16, payload: &[u8]) -> Vec<u8> {
    let record = layer_record(payload);
    let mut layer_info = Vec::new();
    be16(&mut layer_info, 1); // one layer record
    layer_info.extend_from_slice(&record);
    be16(&mut layer_info, compression);
    layer_info.extend_from_slice(payload);

    let mut layer_and_mask = Vec::new();
    be32(&mut layer_and_mask, layer_info.len() as u32);
    layer_and_mask.extend_from_slice(&layer_info);
    // The layer-info section is read with round = 2.
    if layer_info.len() % 2 != 0 {
        layer_and_mask.push(0);
    }
    be32(&mut layer_and_mask, 0); // no global layer mask info

    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"8BPS");
    be16(&mut bytes, 1); // version 1 (PSD, not PSB)
    bytes.extend_from_slice(&[0; 6]); // reserved
    be16(&mut bytes, 3); // channels
    be32(&mut bytes, 2); // height
    be32(&mut bytes, 2); // width
    be16(&mut bytes, 8); // bits per channel
    be16(&mut bytes, 3); // RGB
    be32(&mut bytes, 0); // colour mode data
    be32(&mut bytes, 0); // image resources
    be32(&mut bytes, layer_and_mask.len() as u32);
    bytes.extend_from_slice(&layer_and_mask);
    bytes
}

/// The control: the same document with an uncompressed channel is admitted, so
/// the refusal below is attributable to the payload and not to the fixture.
#[test]
fn the_same_document_with_a_decodable_channel_is_admitted() {
    let bytes = one_layer_psd(0, &[0x40; 4]);
    ParsedTemplate::parse(&bytes, &ProductResourcePolicy::default())
        .expect("a 2x2 raw RGB channel is renderable");
}

#[test]
fn an_undecodable_layer_channel_refuses_the_template() {
    // 0x41 is not a zlib header (its compression method nibble is 1), so the
    // stream cannot be inflated into the 4-byte plane the layer declares.
    let bytes = one_layer_psd(2, &[0x41; 3]);
    let error = match ParsedTemplate::parse(&bytes, &ProductResourcePolicy::default()) {
        Ok(_) => panic!("an undecodable layer channel was admitted and would render black"),
        Err(error) => error,
    };

    assert_eq!(error.code, RenderErrorCode::CorruptDocument, "{error}");
    assert_eq!(error.code.as_str(), "PSD_RENDER_CORRUPT_DOCUMENT");
    assert_eq!(error.phase, CHANNEL_DECODE);
    assert!(
        error.detail.contains("channel 0"),
        "the parser reports which plane is damaged: {error}"
    );
    assert!(!error.retryable, "content failures are never retryable");
    assert!(!error.code.retryable());
    assert!(
        error
            .to_string()
            .starts_with("PSD_RENDER_CORRUPT_DOCUMENT during "),
        "the wasm glue parses the code ahead of ` during `: {error}"
    );
    assert!(!error.remediation.contains("重试"), "{}", error.remediation);
}

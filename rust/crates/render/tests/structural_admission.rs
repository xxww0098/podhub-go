//! Wave-0 structural admission: documents the RGBA8 compositor cannot render
//! faithfully are refused with stable, non-retryable codes instead of being
//! rendered as garbage (multibyte samples read as RGBA8, non-RGB channels
//! projected as RGB) or as a transparent canvas (composite-only documents).

use render::{ParsedTemplate, ProductResourcePolicy, RenderErrorCode};

const TEMPLATE: &[u8] =
    include_bytes!("../../../../fixtures/psd/synthetic/tiny-smart-mask-warp-groups.psd");

/// Header offsets (Adobe PSD spec): bits per channel at 22..24, mode at 24..26.
fn with_header(depth: u16, mode: u16) -> Vec<u8> {
    let mut bytes = TEMPLATE.to_vec();
    bytes[22..24].copy_from_slice(&depth.to_be_bytes());
    bytes[24..26].copy_from_slice(&mode.to_be_bytes());
    bytes
}

/// A valid 2×2 RGB8 PSD with empty layer-and-mask information: only the
/// merged image is present.
fn composite_only_psd() -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"8BPS");
    bytes.extend_from_slice(&1_u16.to_be_bytes()); // version
    bytes.extend_from_slice(&[0; 6]); // reserved
    bytes.extend_from_slice(&3_u16.to_be_bytes()); // channels
    bytes.extend_from_slice(&2_u32.to_be_bytes()); // height
    bytes.extend_from_slice(&2_u32.to_be_bytes()); // width
    bytes.extend_from_slice(&8_u16.to_be_bytes()); // depth
    bytes.extend_from_slice(&3_u16.to_be_bytes()); // RGB
    bytes.extend_from_slice(&0_u32.to_be_bytes()); // colour mode data
    bytes.extend_from_slice(&0_u32.to_be_bytes()); // image resources
    bytes.extend_from_slice(&0_u32.to_be_bytes()); // layer and mask info
    bytes.extend_from_slice(&0_u16.to_be_bytes()); // raw image data
    bytes.extend_from_slice(&[200; 12]); // 3 planes × 2×2
    bytes
}

fn refusal(bytes: &[u8]) -> render::RenderError {
    match ParsedTemplate::parse(bytes, &ProductResourcePolicy::default()) {
        Ok(_) => panic!("structurally unsupported template was admitted"),
        Err(error) => error,
    }
}

fn assert_content_refusal(error: &render::RenderError, code: RenderErrorCode, wire: &str) {
    assert_eq!(error.code, code, "{error}");
    assert_eq!(error.code.as_str(), wire);
    assert!(!error.retryable, "content failures are never retryable");
    assert!(!error.code.retryable());
    assert!(
        error.to_string().starts_with(&format!("{wire} during ")),
        "the wasm glue parses the code ahead of ` during `: {error}"
    );
    assert!(!error.remediation.contains("重试"), "{}", error.remediation);
}

#[test]
fn the_rgb8_template_is_still_admitted() {
    ParsedTemplate::parse(TEMPLATE, &ProductResourcePolicy::default())
        .expect("RGB8 layered template");
}

#[test]
fn non_8_bit_depths_are_refused_before_decoding() {
    for depth in [1_u16, 16, 32] {
        let error = refusal(&with_header(depth, 3));
        assert_content_refusal(
            &error,
            RenderErrorCode::UnsupportedDepth,
            "PSD_RENDER_UNSUPPORTED_DEPTH",
        );
        assert!(error.remediation.contains("8 位/通道"));
        assert_eq!(error.phase, "header-admission");
    }
}

#[test]
fn non_rgb_colour_modes_are_refused_before_decoding() {
    // Bitmap, Grayscale, Indexed, CMYK, Multichannel, Duotone, Lab.
    for mode in [0_u16, 1, 2, 4, 7, 8, 9] {
        let error = refusal(&with_header(8, mode));
        assert_content_refusal(
            &error,
            RenderErrorCode::UnsupportedColorMode,
            "PSD_RENDER_UNSUPPORTED_COLOR_MODE",
        );
        assert!(error.remediation.contains("RGB"));
    }
}

#[test]
fn depth_is_reported_ahead_of_colour_mode() {
    // A 16-bit CMYK document needs both fixes; depth is the first gate.
    assert_eq!(
        refusal(&with_header(16, 4)).code,
        RenderErrorCode::UnsupportedDepth
    );
}

#[test]
fn composite_only_documents_are_refused_rather_than_rendered_transparent() {
    let error = refusal(&composite_only_psd());
    assert_content_refusal(
        &error,
        RenderErrorCode::CompositeOnly,
        "PSD_RENDER_COMPOSITE_ONLY",
    );
    assert_eq!(error.phase, "layer-admission");
    assert!(error.remediation.contains("分层"));
}

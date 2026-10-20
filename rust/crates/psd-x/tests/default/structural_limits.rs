use psdx::descriptor::read_descriptor_structure;
use psdx::psd::ReadOptions;
use psdx::reader::{
    PsdReader, ReadError, checked_platform_size, read_psd, read_section, read_uint8,
};
use std::path::{Path, PathBuf};

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures/psd/synthetic")
        .join(name)
}

fn structural_options() -> ReadOptions {
    ReadOptions {
        skip_layer_image_data: Some(true),
        skip_composite_image_data: Some(true),
        skip_thumbnail: Some(true),
        skip_linked_files_data: Some(true),
        throw_for_missing_features: Some(false),
        strict: Some(false),
        ..ReadOptions::default()
    }
}

fn minimal_psd(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"8BPS");
    bytes.extend_from_slice(&1_u16.to_be_bytes());
    bytes.extend_from_slice(&[0; 6]);
    bytes.extend_from_slice(&4_u16.to_be_bytes());
    bytes.extend_from_slice(&height.to_be_bytes());
    bytes.extend_from_slice(&width.to_be_bytes());
    bytes.extend_from_slice(&8_u16.to_be_bytes());
    bytes.extend_from_slice(&3_u16.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes
}

#[test]
fn document_side_and_pixel_limits_are_enforced_at_the_parser_header() {
    let mut exact = structural_options();
    exact.max_psd_side = Some(2);
    exact.max_canvas_pixels = Some(4);
    assert!(read_psd(&minimal_psd(2, 2), &exact).is_ok());

    let mut side_over = exact.clone();
    side_over.max_psd_side = Some(1);
    assert!(matches!(
        read_psd(&minimal_psd(2, 1), &side_over).unwrap_err(),
        ReadError::DocumentLimitExceeded {
            width: 2,
            height: 1,
            limit: 1
        }
    ));

    let mut pixels_over = exact;
    pixels_over.max_canvas_pixels = Some(3);
    assert!(matches!(
        read_psd(&minimal_psd(2, 2), &pixels_over).unwrap_err(),
        ReadError::PixelLimitExceeded {
            pixels: 4,
            limit: 3
        }
    ));
}

#[test]
fn exact_layer_limit_passes_and_one_over_fails() {
    let bytes = std::fs::read(fixture("tiny-smart-mask-warp-groups.psd")).expect("fixture");
    let mut exact = structural_options();
    exact.max_layer_records = Some(12);
    let exact_result = read_psd(&bytes, &exact);
    assert!(exact_result.is_ok(), "exact limit failed: {exact_result:?}");

    let mut one_over = exact;
    one_over.max_layer_records = Some(11);
    assert!(matches!(
        read_psd(&bytes, &one_over).unwrap_err(),
        ReadError::LayerLimitExceeded {
            observed: 12,
            limit: 11
        }
    ));
}

#[test]
fn configured_group_depth_is_behavioral() {
    let bytes = std::fs::read(fixture("tiny-smart-mask-warp-groups.psd")).expect("fixture");
    let mut options = structural_options();
    options.max_layer_depth = Some(0);
    assert!(matches!(
        read_psd(&bytes, &options).unwrap_err(),
        ReadError::RecursionLimitExceeded {
            observed: 1,
            limit: 0
        }
    ));
}

#[test]
fn configured_descriptor_depth_is_exact_and_behavioral() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(&0_u32.to_be_bytes());
    bytes.extend_from_slice(b"null");
    bytes.extend_from_slice(&0_u32.to_be_bytes());

    let mut exact = PsdReader::new(&bytes, None, None);
    exact.options.max_recursion_depth = Some(1);
    assert!(read_descriptor_structure(&mut exact).is_ok());

    let mut one_over = PsdReader::new(&bytes, None, None);
    one_over.options.max_recursion_depth = Some(0);
    assert!(matches!(
        read_descriptor_structure(&mut one_over).unwrap_err(),
        ReadError::RecursionLimitExceeded {
            observed: 1,
            limit: 0
        }
    ));
}

#[test]
fn hostile_offsets_alignment_and_platform_sizes_fail_without_panicking() {
    let bytes = [0_u8; 8];
    let invalid_window = std::panic::catch_unwind(|| {
        let mut reader = PsdReader::new(&bytes, Some(usize::MAX), Some(2));
        read_uint8(&mut reader)
    });
    assert!(invalid_window.is_ok());
    assert_eq!(
        invalid_window.unwrap(),
        Err(ReadError::UnexpectedEndOfBuffer)
    );

    let mut overflowed_offset = PsdReader::new(&bytes, None, None);
    overflowed_offset.offset = usize::MAX;
    assert_eq!(
        read_uint8(&mut overflowed_offset),
        Err(ReadError::SizeTooLarge)
    );

    let mut invalid_alignment = PsdReader::new(&[0, 0, 0, 0], None, None);
    let section = read_section(
        &mut invalid_alignment,
        0,
        |_reader, _left| Ok(()),
        false,
        false,
    );
    assert!(matches!(section, Err(ReadError::InvalidInput(_))));

    assert_eq!(
        checked_platform_size(u128::MAX),
        Err(ReadError::SizeTooLarge)
    );
}

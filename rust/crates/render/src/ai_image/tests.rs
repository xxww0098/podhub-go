use super::resize::flatten_onto_white;
use super::*;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::{DynamicImage, ExtendedColorType, ImageEncoder, ImageFormat, RgbaImage};
use std::io::Cursor;

fn noisy_rgba(width: u32, height: u32) -> RgbaImage {
    let mut image = RgbaImage::new(width, height);
    let mut state: u32 = 0x9e37_79b9;
    for pixel in image.pixels_mut() {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let bytes = state.to_le_bytes();
        pixel.0 = [bytes[0], bytes[1], bytes[2], 255];
    }
    image
}

fn png_bytes(image: &RgbaImage) -> Vec<u8> {
    let mut encoded = Vec::new();
    PngEncoder::new_with_quality(&mut encoded, CompressionType::Fast, PngFilter::NoFilter)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .expect("encode PNG fixture");
    encoded
}

fn compact_png(width: u32, height: u32) -> Vec<u8> {
    let image = RgbaImage::from_pixel(width, height, image::Rgba([240, 240, 240, 255]));
    let mut encoded = Vec::new();
    PngEncoder::new_with_quality(&mut encoded, CompressionType::Best, PngFilter::NoFilter)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ExtendedColorType::Rgba8,
        )
        .expect("encode compact PNG");
    encoded
}

#[test]
fn small_payloads_travel_untouched() {
    let source = png_bytes(&noisy_rgba(48, 48));
    assert!(source.len() <= PASSTHROUGH_BYTES);
    let prepared = prepare_ai_image(&source).expect("prepare");
    assert_eq!(prepared, source, "small images must not be re-encoded");
}

#[test]
fn the_side_cap_is_the_handbook_1024() {
    assert_eq!(MAX_UPLOAD_SIDE, 1024, "docs/ocr.md §1 states this number");
    assert_eq!(JPEG_QUALITY, 75, "docs/ocr.md §1 states this number");
    // A 1200 px source sat under the retired 1568 px cap and travelled
    // untouched; under 1024 it must be downsampled.
    let source = compact_png(1200, 1200);
    assert!(source.len() <= PASSTHROUGH_BYTES);
    let prepared = prepare_ai_image(&source).expect("prepare");
    let decoded = image::load_from_memory_with_format(&prepared, ImageFormat::Jpeg)
        .expect("decode prepared payload");
    assert_eq!((decoded.width(), decoded.height()), (1024, 1024));
}

#[test]
fn compact_oversized_images_still_respect_the_side_cap() {
    let source = compact_png(1700, 400);
    assert!(
        source.len() <= PASSTHROUGH_BYTES,
        "the fixture must sit under the byte passthrough so only the side cap applies"
    );
    let prepared = prepare_ai_image(&source).expect("prepare");
    let decoded = image::load_from_memory_with_format(&prepared, ImageFormat::Jpeg)
        .expect("decode prepared payload");
    assert_eq!(decoded.width(), MAX_UPLOAD_SIDE);
    assert_eq!(decoded.height(), 241, "the aspect ratio must survive");
}

#[test]
fn oversized_images_are_downsampled_to_jpeg() {
    let source = png_bytes(&noisy_rgba(1700, 400));
    assert!(source.len() > PASSTHROUGH_BYTES);
    let prepared = prepare_ai_image(&source).expect("prepare");
    assert!(
        prepared.len() < source.len(),
        "the prepared payload must be smaller than the source"
    );
    let decoded = image::load_from_memory_with_format(&prepared, ImageFormat::Jpeg)
        .expect("decode prepared payload");
    assert_eq!(decoded.width(), MAX_UPLOAD_SIDE);
    assert_eq!(decoded.height(), 241, "the aspect ratio must survive");
}

#[test]
fn images_within_the_cap_and_under_the_byte_passthrough_are_untouched() {
    let source = compact_png(1024, 700);
    assert!(source.len() <= PASSTHROUGH_BYTES);
    assert_eq!(prepare_ai_image(&source).expect("prepare"), source);
}

#[test]
fn transparent_pixels_flatten_onto_white() {
    let mut image = RgbaImage::new(16, 16);
    for pixel in image.pixels_mut() {
        pixel.0 = [0, 0, 0, 0];
    }
    let flattened = flatten_onto_white(DynamicImage::ImageRgba8(image));
    assert!(
        flattened.pixels().all(|pixel| pixel.0 == [255, 255, 255]),
        "transparent regions must composite to white, never to black"
    );
}

#[test]
fn large_undecodable_payloads_fail_closed() {
    let source = vec![7_u8; PASSTHROUGH_BYTES + 1];
    assert_eq!(
        prepare_ai_image(&source).unwrap_err().code,
        MediaErrorCode::ParseFailed
    );
}

#[test]
fn prepared_jpeg_stays_444_at_the_handbook_quality() {
    let source = png_bytes(&noisy_rgba(1200, 800));
    let prepared = prepare_ai_image(&source).expect("prepare");
    assert_eq!(jpeg_sampling(&prepared), [0x11, 0x11, 0x11]);
}

fn jpeg_sampling(jpeg: &[u8]) -> [u8; 3] {
    assert_eq!(&jpeg[..2], &[0xFF, 0xD8]);
    let mut index = 2;
    while index + 4 < jpeg.len() {
        assert_eq!(jpeg[index], 0xFF);
        index += 1;
        while jpeg[index] == 0xFF {
            index += 1;
        }
        let kind = jpeg[index];
        index += 1;
        if kind == 0xD8 || kind == 0xD9 || (0xD0..=0xD7).contains(&kind) {
            continue;
        }
        let length = u16::from_be_bytes([jpeg[index], jpeg[index + 1]]) as usize;
        if kind == 0xC0 {
            let sof = &jpeg[index..index + length];
            assert_eq!(sof[7], 3);
            return [sof[9], sof[12], sof[15]];
        }
        if kind == 0xDA {
            break;
        }
        index += length;
    }
    panic!("baseline SOF missing");
}

/// Release timing for the 2400×1800 product-like frame in D-045.
/// `cargo test -p render --release --lib time_prepare_ai_image -- --ignored --nocapture`
#[test]
#[ignore]
fn time_prepare_ai_image() {
    use std::time::Instant;
    let rgba = {
        let mut image = RgbaImage::new(2400, 1800);
        for (index, pixel) in image.pixels_mut().enumerate() {
            let x = (index as u32) % 2400;
            let y = (index as u32) / 2400;
            let nx = x as f64 / 2400.0;
            let ny = y as f64 / 1800.0;
            let in_product = (nx - 0.5).powi(2) / 0.16 + (ny - 0.45).powi(2) / 0.22 < 1.0;
            pixel.0 = if in_product {
                [(40.0 + ny * 90.0) as u8, 90 + (x / 17) as u8 % 40, 140, 255]
            } else {
                [245, 245, 246, 255]
            };
        }
        image
    };
    let image = DynamicImage::ImageRgba8(rgba);
    let mut png = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
        .expect("png");
    let rgb = image.into_rgb8();
    let mut jpeg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90)
        .write_image(
            rgb.as_raw(),
            rgb.width(),
            rgb.height(),
            ExtendedColorType::Rgb8,
        )
        .expect("jpeg");
    for (name, bytes) in [("png", png.as_slice()), ("jpeg", jpeg.as_slice())] {
        let started = Instant::now();
        let prepared = prepare_ai_image(bytes).expect("prepare");
        eprintln!(
            "prepare {name}: {:.1} ms -> {} bytes (source {})",
            started.elapsed().as_secs_f64() * 1000.0,
            prepared.len(),
            bytes.len()
        );
    }
}

#[test]
fn a_payload_over_the_relay_ceiling_is_refused_rather_than_posted() {
    let source = vec![7_u8; MAX_PREPARED_IMAGE_BYTES + 1];
    let encoded = vec![9_u8; MAX_PREPARED_IMAGE_BYTES + 1];
    assert_eq!(
        admit_smaller_of(&source, encoded).unwrap_err().code,
        MediaErrorCode::EncodedLimit
    );
    let source = vec![7_u8; MAX_PREPARED_IMAGE_BYTES + 50];
    let encoded = vec![9_u8; 64];
    let prepared = admit_smaller_of(&source, encoded).expect("jpeg under the ceiling");
    assert_eq!(prepared.len(), 64);
}

#[test]
fn small_invalid_images_are_rejected_instead_of_passed_to_the_relay() {
    for source in [&[][..], &[7_u8; 16][..], &b"not an image"[..]] {
        assert_eq!(
            prepare_ai_image(source).unwrap_err().code,
            MediaErrorCode::ParseFailed
        );
    }
}
#[test]
fn header_admission_checks_bytes_and_pixel_count_before_decode() {
    let source = compact_png(2, 2);
    let policy = ProductResourcePolicy {
        max_canvas_pixels: 3,
        ..ProductResourcePolicy::default()
    };
    assert_eq!(
        super::decode::dimensions(&source, policy).unwrap_err().code,
        MediaErrorCode::DimensionLimit
    );
    let policy = ProductResourcePolicy {
        max_input_bytes: source.len() as u64 - 1,
        ..ProductResourcePolicy::default()
    };
    assert_eq!(
        super::decode::dimensions(&source, policy).unwrap_err().code,
        MediaErrorCode::InputTooLarge
    );
}

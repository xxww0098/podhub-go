//! Product-slice JPEG contract: 3:4 canvas, quality 82, 4:2:0, white flatten.
//!
//! The scene is synthetic (no third-party artwork): a white field, a noisy
//! product, a soft shadow, and thin dark bars standing in for label type.
//! Numbers printed when `PODHUB_SLICE_PREVIEW` is a directory are the ones
//! `docs/pricing.md` §3.1 cites for this encoder.

use super::encode::encode_jpeg_flatten_white;
use super::intent::DEFAULT_PRESENTATION_QUALITY;
use image::RgbImage;
use jpeg_decoder::PixelFormat;
use std::fs;
use std::path::Path;

const WIDTH: u32 = 1086;
const HEIGHT: u32 = 1448;

#[test]
fn default_presentation_quality_is_the_subsampled_contract() {
    assert_eq!(DEFAULT_PRESENTATION_QUALITY, 82);
}

#[test]
fn product_scene_q82_is_smaller_and_still_a_white_background_jpeg() {
    let rgba = product_scene(WIDTH, HEIGHT);
    let current = encode_jpeg_flatten_white(&rgba, WIDTH, HEIGHT, 90).expect("q90");
    let next =
        encode_jpeg_flatten_white(&rgba, WIDTH, HEIGHT, DEFAULT_PRESENTATION_QUALITY).expect("q82");

    let (w90, h90, rgb90) = decode(&current);
    let (w82, h82, rgb82) = decode(&next);
    assert_eq!((w90, h90), (WIDTH, HEIGHT));
    assert_eq!((w82, h82), (WIDTH, HEIGHT));
    assert_eq!(sampling(&current), Sampling::Y444, "q90 stays 4:4:4");
    assert_eq!(sampling(&next), Sampling::Y420, "q82 is 4:2:0");
    assert!(is_baseline_jpeg(&current) && is_baseline_jpeg(&next));

    let source = flattened_rgb(&rgba);
    let ratio = next.len() as f64 / current.len() as f64;
    let against_source = psnr(&source, &rgb82);
    // Measured 2026-10-08 on this scene: q90 4:4:4 = 390_659 B (PSNR 37.03),
    // q82 4:2:0 = 242_105 B (ratio 0.620, PSNR 33.36). Open-field white stayed
    // 255; the minimum under 250 was edge ringing, not a gray cast.
    assert!(
        ratio < 0.70,
        "q82 should stay well under q90 4:4:4, got ratio {ratio:.3} ({} -> {})",
        current.len(),
        next.len(),
    );
    assert!(
        against_source >= 32.0,
        "q82 vs source PSNR {against_source:.2} dB is below the product-photo floor"
    );
    assert!(
        corner_min(&rgb82) >= 250 && corner_min(&rgb90) >= 250,
        "the open white corner drifted"
    );
    if let Ok(dir) = std::env::var("PODHUB_SLICE_PREVIEW") {
        write_preview(Path::new(&dir), &rgb90, &rgb82);
    }
}

#[test]
fn partial_alpha_still_flattens_onto_white() {
    let mut rgba = Vec::with_capacity(32 * 32 * 4);
    for _ in 0..(32 * 32) {
        rgba.extend_from_slice(&[255, 0, 0, 128]);
    }
    let encoded =
        encode_jpeg_flatten_white(&rgba, 32, 32, DEFAULT_PRESENTATION_QUALITY).expect("encode");
    let (_w, _h, rgb) = decode(&encoded);
    let pixel = &rgb[16 * 32 * 3 + 16 * 3..16 * 32 * 3 + 16 * 3 + 3];
    assert!(pixel[0] > 220, "red was crushed: {pixel:?}");
    assert!(
        pixel[1] > 90 && pixel[1] < 170,
        "green left the white flatten: {pixel:?}"
    );
    assert!(
        pixel[2] > 90 && pixel[2] < 170,
        "blue left the white flatten: {pixel:?}"
    );
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Sampling {
    Y444,
    Y420,
}

fn decode(jpeg: &[u8]) -> (u32, u32, Vec<u8>) {
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    let pixels = decoder.decode().expect("decode sequential Huffman JPEG");
    let info = decoder.info().expect("jpeg info");
    assert_eq!(info.pixel_format, PixelFormat::RGB24);
    (u32::from(info.width), u32::from(info.height), pixels)
}

fn is_baseline_jpeg(jpeg: &[u8]) -> bool {
    jpeg.len() > 4
        && jpeg[0] == 0xFF
        && jpeg[1] == 0xD8
        && find_marker(jpeg, 0xC0).is_some()
        && find_marker(jpeg, 0xC2).is_none()
}

fn sampling(jpeg: &[u8]) -> Sampling {
    let sof = find_marker(jpeg, 0xC0).expect("baseline SOF");
    let components = sof[7] as usize;
    assert_eq!(components, 3, "product JPEG is YCbCr");
    let factors: Vec<u8> = (0..components)
        .map(|index| sof[8 + index * 3 + 1])
        .collect();
    match factors.as_slice() {
        [0x11, 0x11, 0x11] => Sampling::Y444,
        [0x22, 0x11, 0x11] => Sampling::Y420,
        other => panic!("unexpected sampling {other:?}"),
    }
}

fn find_marker(jpeg: &[u8], marker: u8) -> Option<&[u8]> {
    let mut index = 2;
    while index + 4 < jpeg.len() {
        if jpeg[index] != 0xFF {
            return None;
        }
        while index < jpeg.len() && jpeg[index] == 0xFF {
            index += 1;
        }
        if index >= jpeg.len() {
            return None;
        }
        let kind = jpeg[index];
        index += 1;
        if kind == 0xD8 || kind == 0xD9 || (0xD0..=0xD7).contains(&kind) {
            continue;
        }
        if index + 2 > jpeg.len() {
            return None;
        }
        let length = u16::from_be_bytes([jpeg[index], jpeg[index + 1]]) as usize;
        if length < 2 || index + length > jpeg.len() {
            return None;
        }
        if kind == marker {
            return Some(&jpeg[index..index + length]);
        }
        if kind == 0xDA {
            return None;
        }
        index += length;
    }
    None
}

fn psnr(reference: &[u8], candidate: &[u8]) -> f64 {
    let mut sse = 0.0_f64;
    for (left, right) in reference.iter().zip(candidate) {
        let delta = f64::from(left.abs_diff(*right));
        sse += delta * delta;
    }
    let mse = sse / reference.len() as f64;
    if mse == 0.0 {
        return 99.0;
    }
    10.0 * (255.0 * 255.0 / mse).log10()
}

fn flattened_rgb(rgba: &[u8]) -> Vec<u8> {
    let mut rgb = Vec::with_capacity(rgba.len() / 4 * 3);
    for pixel in rgba.chunks_exact(4) {
        if pixel[3] == 255 {
            rgb.extend_from_slice(&pixel[..3]);
            continue;
        }
        let alpha = u16::from(pixel[3]);
        let inverse = 255 - alpha;
        for channel in &pixel[..3] {
            rgb.push(((u16::from(*channel) * alpha + 255 * inverse + 127) / 255) as u8);
        }
    }
    rgb
}

fn corner_min(rgb: &[u8]) -> u8 {
    let mut floor = 255_u8;
    for y in 16..80 {
        for x in 16..80 {
            let offset = ((y * WIDTH + x) * 3) as usize;
            floor = floor
                .min(rgb[offset])
                .min(rgb[offset + 1])
                .min(rgb[offset + 2]);
        }
    }
    floor
}

fn product_scene(width: u32, height: u32) -> Vec<u8> {
    let mut rgba = vec![255_u8; width as usize * height as usize * 4];
    for y in 0..height {
        for x in 0..width {
            let offset = ((y * width + x) * 4) as usize;
            let nx = x as f64 / width as f64;
            let ny = y as f64 / height as f64;
            let in_product = (nx - 0.5).powi(2) / 0.12 + (ny - 0.46).powi(2) / 0.18 < 1.0;
            let in_shadow = (nx - 0.52).powi(2) / 0.14 + (ny - 0.50).powi(2) / 0.20 < 1.0;
            if in_shadow && !in_product {
                rgba[offset] = 236;
                rgba[offset + 1] = 236;
                rgba[offset + 2] = 238;
            }
            if in_product {
                let noise = hash_byte(x, y);
                let shade = 40 + (ny * 80.0) as u8;
                rgba[offset] = shade.saturating_add(noise / 8);
                rgba[offset + 1] = 70 + noise / 5;
                rgba[offset + 2] = 120 + noise / 4;
            }
            if (y / 6) % 18 == 0 && x > width / 5 && x < width * 4 / 5 && y > height / 3 {
                rgba[offset] = 20;
                rgba[offset + 1] = 20;
                rgba[offset + 2] = 24;
            }
            if nx > 0.62 && nx < 0.78 && ny > 0.30 && ny < 0.42 {
                rgba[offset + 3] = 140;
                rgba[offset] = 210;
                rgba[offset + 1] = 40;
                rgba[offset + 2] = 40;
            }
        }
    }
    rgba
}

fn hash_byte(x: u32, y: u32) -> u8 {
    let mut value = x
        .wrapping_mul(374761393)
        .wrapping_add(y.wrapping_mul(668265263));
    value = (value ^ (value >> 13)).wrapping_mul(1274126177);
    (value ^ (value >> 16)) as u8
}

fn write_preview(dir: &Path, q90: &[u8], q82: &[u8]) {
    fs::create_dir_all(dir).expect("preview dir");
    let width = WIDTH;
    let height = HEIGHT;
    save_rgb(dir.join("q90.png"), width, height, q90);
    save_rgb(dir.join("q82.png"), width, height, q82);
    let mut board = vec![255_u8; (width as usize * 2) * (height as usize * 2) * 3];
    blit(&mut board, width * 2, 0, 0, width, height, q90);
    blit(&mut board, width * 2, width, 0, width, height, q82);
    let mut diff = vec![0_u8; q90.len()];
    for (index, (left, right)) in q90.iter().zip(q82).enumerate() {
        diff[index] = left.abs_diff(*right).saturating_mul(8);
    }
    blit(&mut board, width * 2, 0, height, width, height, &diff);
    let crop = 280_u32;
    let crop_x = width / 2 - crop / 2;
    let crop_y = height / 3;
    let zoom_width = crop * 4;
    let mut zoom = vec![255_u8; zoom_width as usize * (crop as usize * 2) * 3];
    scale_crop(&mut zoom, zoom_width, q90, width, crop_x, crop_y, crop, 0);
    scale_crop(
        &mut zoom,
        zoom_width,
        q82,
        width,
        crop_x,
        crop_y,
        crop,
        crop * 2,
    );
    save_rgb(dir.join("compare.png"), width * 2, height * 2, &board);
    save_rgb(dir.join("crop.png"), zoom_width, crop * 2, &zoom);
}

fn save_rgb(path: impl AsRef<Path>, width: u32, height: u32, rgb: &[u8]) {
    RgbImage::from_raw(width, height, rgb.to_vec())
        .expect("rgb buffer")
        .save(path)
        .expect("write preview");
}

fn blit(
    dest: &mut [u8],
    dest_width: u32,
    origin_x: u32,
    origin_y: u32,
    width: u32,
    height: u32,
    src: &[u8],
) {
    for y in 0..height {
        for x in 0..width {
            let from = ((y * width + x) * 3) as usize;
            let to = (((origin_y + y) * dest_width + origin_x + x) * 3) as usize;
            dest[to..to + 3].copy_from_slice(&src[from..from + 3]);
        }
    }
}

fn scale_crop(
    dest: &mut [u8],
    dest_width: u32,
    src: &[u8],
    src_width: u32,
    x0: u32,
    y0: u32,
    side: u32,
    origin_x: u32,
) {
    for y in 0..side * 2 {
        for x in 0..side * 2 {
            let sx = x0 + x / 2;
            let sy = y0 + y / 2;
            let from = ((sy * src_width + sx) * 3) as usize;
            let to = ((y * dest_width + origin_x + x) * 3) as usize;
            dest[to..to + 3].copy_from_slice(&src[from..from + 3]);
        }
    }
}

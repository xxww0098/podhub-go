//! Local, non-gating comparison with the previous image::Triangle pipeline.
//! cargo run --locked -p render --release --example ai_image_prepare_bench
//! Synthetic opaque source only; timings do not certify browser/OCR throughput.
use image::{DynamicImage, ExtendedColorType, ImageEncoder, RgbImage, Rgba, RgbaImage};
use std::{hint::black_box, io::Cursor, time::Instant};
const N: usize = 7;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let source = DynamicImage::ImageRgba8(RgbaImage::from_fn(2400, 1800, |x, y| {
        let nx = x as f64 / 2400.0;
        let ny = y as f64 / 1800.0;
        if (nx - 0.5).powi(2) / 0.16 + (ny - 0.45).powi(2) / 0.22 < 1.0 {
            Rgba([(40.0 + ny * 90.0) as u8, 90 + (x / 17) as u8 % 40, 140, 255])
        } else {
            Rgba([245, 245, 246, 255])
        }
    }));
    let mut png = Vec::new();
    source.write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)?;
    let mut jpeg = Vec::new();
    let rgb = source.to_rgb8();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 90).write_image(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        ExtendedColorType::Rgb8,
    )?;
    let mut reports = Vec::new();
    for (format, bytes) in [("png", png.as_slice()), ("jpeg", jpeg.as_slice())] {
        black_box(reference(bytes)?);
        black_box(render::prepare_ai_image(bytes)?);
        let (mut before, mut after) = (Vec::new(), Vec::new());
        for iteration in 0..N {
            // Alternate order rather than consistently giving one path warm caches.
            if iteration % 2 == 0 {
                before.push(time(|| reference(bytes).unwrap()));
                after.push(time(|| render::prepare_ai_image(bytes).unwrap()));
            } else {
                after.push(time(|| render::prepare_ai_image(bytes).unwrap()));
                before.push(time(|| reference(bytes).unwrap()));
            }
        }
        let baseline = reference(bytes)?;
        let prepared = render::prepare_ai_image(bytes)?;
        let baseline_rgb = image::load_from_memory(&baseline)?.into_rgb8();
        let prepared_rgb = image::load_from_memory(&prepared)?.into_rgb8();
        assert_eq!(baseline_rgb.dimensions(), prepared_rgb.dimensions());
        assert!(prepared_rgb.width().max(prepared_rgb.height()) <= 1024);
        assert!(prepared.len() <= 1_400_000);
        let mse = baseline_rgb
            .as_raw()
            .iter()
            .zip(prepared_rgb.as_raw())
            .map(|(a, b)| (f64::from(*a) - f64::from(*b)).powi(2))
            .sum::<f64>()
            / baseline_rgb.as_raw().len() as f64;
        reports.push(serde_json::json!({"format":format,"sourceBytes":bytes.len(),"samples":N,
            "referenceMedianMs":median(before),"simdMedianMs":median(after),
            "referenceBytes":baseline.len(),"preparedBytes":prepared.len(),
            "jpegPsnrDb":if mse == 0.0 { None } else { Some(10.0 * (255.0_f64.powi(2) / mse).log10()) }}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &serde_json::json!({"sourceWidth":2400,"sourceHeight":1800,"reports":reports})
        )?
    );
    Ok(())
}
fn time(task: impl FnOnce() -> Vec<u8>) -> f64 {
    let started = Instant::now();
    black_box(task());
    started.elapsed().as_secs_f64() * 1000.0
}
fn median(mut values: Vec<f64>) -> f64 {
    values.sort_by(f64::total_cmp);
    values[values.len() / 2]
}
/// Benchmark reference only, not a second production implementation. All pixels
/// in this fixture are opaque, so into_rgb8 matches the previous white flatten.
fn reference(bytes: &[u8]) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let source = image::load_from_memory(bytes)?;
    let rgb: RgbImage = source
        .resize(1024, 1024, image::imageops::FilterType::Triangle)
        .into_rgb8();
    let mut output = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut output, 75);
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::R_4_4_4);
    encoder.encode(
        rgb.as_raw(),
        rgb.width() as u16,
        rgb.height() as u16,
        jpeg_encoder::ColorType::Rgb,
    )?;
    Ok(output)
}

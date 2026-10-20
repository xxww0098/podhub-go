/*
File: rust/crates/psd-x/src/image_sniff.rs

Purpose:
Pure image-header sniffing for smart-object replacement: detect format,
pixel width/height, and DPI when the container declares it. No pixel decode.

Source compatibility:
- psdx-owned; no upstream ag-psd counterpart.

Main responsibilities:
- identify PNG / JPEG / PSD / PSB / GIF / BMP from magic + minimal headers;
- read pixel size without decoding image data;
- read PNG pHYs and JPEG JFIF density as DPI when units are absolute;
- never guess size for unknown or truncated input (no panics).
*/

//! Image header sniffing for smart-object replace (psdx-owned).
//!
//! Given raw image bytes, detect the container format and (when the header is
//! complete enough) its pixel size and optional DPI. This module does **not**
//! decode pixels and introduces no image-decoding dependencies.

/// Detected image container format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ImageFormat {
    Png,
    Jpeg,
    /// Photoshop Document (file version 1).
    Psd,
    /// Large Document Format (file version 2).
    Psb,
    Gif,
    Bmp,
    /// Unrecognized or empty input. Size/DPI are never populated.
    Unknown,
}

impl ImageFormat {
    /// `true` when the format was recognized (even if size could not be read).
    pub fn is_known(self) -> bool {
        !matches!(self, Self::Unknown)
    }
}

/// Horizontal / vertical resolution in dots per inch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Dpi {
    pub x: f64,
    pub y: f64,
}

/// Result of sniffing an image header.
///
/// When [`format`](ImageSniff::format) is [`ImageFormat::Unknown`], `width`,
/// `height`, and `dpi` are always `None`. A known format may still have
/// `None` size/DPI when the buffer is truncated before those fields.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ImageSniff {
    pub format: ImageFormat,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub dpi: Option<Dpi>,
}

impl ImageSniff {
    const UNKNOWN: Self = Self {
        format: ImageFormat::Unknown,
        width: None,
        height: None,
        dpi: None,
    };

    fn known(format: ImageFormat) -> Self {
        Self {
            format,
            width: None,
            height: None,
            dpi: None,
        }
    }
}

/// Sniff format, pixel size, and optional DPI from image bytes.
///
/// Never panics. Empty, truncated, and malformed inputs return a best-effort
/// result (often [`ImageFormat::Unknown`] with no size).
pub fn sniff_image(bytes: &[u8]) -> ImageSniff {
    if bytes.is_empty() {
        return ImageSniff::UNKNOWN;
    }
    if looks_like_png(bytes) {
        return sniff_png(bytes);
    }
    if looks_like_jpeg(bytes) {
        return sniff_jpeg(bytes);
    }
    if looks_like_psd(bytes) {
        return sniff_psd(bytes);
    }
    if looks_like_gif(bytes) {
        return sniff_gif(bytes);
    }
    if looks_like_bmp(bytes) {
        return sniff_bmp(bytes);
    }
    ImageSniff::UNKNOWN
}

// ---------------------------------------------------------------------------
// PNG
// ---------------------------------------------------------------------------

const PNG_SIG: &[u8; 8] = b"\x89PNG\r\n\x1a\n";

fn looks_like_png(bytes: &[u8]) -> bool {
    bytes.starts_with(PNG_SIG)
}

fn sniff_png(bytes: &[u8]) -> ImageSniff {
    let mut info = ImageSniff::known(ImageFormat::Png);
    // Signature (8) + length (4) + type (4) + IHDR data (13) + CRC (4) = 33
    if bytes.len() < 24 {
        return info;
    }
    let chunk_len = read_u32_be(bytes, 8);
    let chunk_ty = get_slice(bytes, 12, 4);
    if chunk_len != 13 || chunk_ty != Some(b"IHDR") {
        return info;
    }
    info.width = Some(read_u32_be(bytes, 16));
    info.height = Some(read_u32_be(bytes, 20));
    info.dpi = png_phys_dpi(bytes);
    info
}

/// Walk PNG chunks for `pHYs` (pixels per unit). Unit 1 = meter → DPI.
fn png_phys_dpi(bytes: &[u8]) -> Option<Dpi> {
    let mut offset = 8usize; // after signature
    while offset.saturating_add(8) <= bytes.len() {
        let len = read_u32_be(bytes, offset) as usize;
        let ty = get_slice(bytes, offset + 4, 4)?;
        let data_start = offset + 8;
        let data_end = data_start.checked_add(len)?;
        if data_end > bytes.len() {
            return None; // truncated chunk
        }
        if ty == b"pHYs" {
            if len < 9 {
                return None;
            }
            let ppx = read_u32_be(bytes, data_start) as f64;
            let ppy = read_u32_be(bytes, data_start + 4) as f64;
            let unit = bytes[data_start + 8];
            return match unit {
                // 1 = meter
                1 => Some(Dpi {
                    x: ppm_to_dpi(ppx),
                    y: ppm_to_dpi(ppy),
                }),
                // 0 = unknown unit — aspect only; not absolute DPI
                _ => None,
            };
        }
        if ty == b"IEND" {
            break;
        }
        // length + type + data + CRC
        offset = data_end.checked_add(4)?;
    }
    None
}

fn ppm_to_dpi(ppm: f64) -> f64 {
    // dots/inch = (pixels/meter) * (meters/inch)
    ppm * 0.0254
}

// ---------------------------------------------------------------------------
// JPEG
// ---------------------------------------------------------------------------

fn looks_like_jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0xff && bytes[1] == 0xd8
}

fn sniff_jpeg(bytes: &[u8]) -> ImageSniff {
    let mut info = ImageSniff::known(ImageFormat::Jpeg);
    let mut i = 2usize;
    let mut dpi = None;
    while i + 1 < bytes.len() {
        // Skip fill bytes (0xFF padding before a marker).
        if bytes[i] != 0xff {
            i += 1;
            continue;
        }
        while i < bytes.len() && bytes[i] == 0xff {
            i += 1;
        }
        if i >= bytes.len() {
            break;
        }
        let marker = bytes[i];
        i += 1;

        // Standalone markers (no length): TEM, RST0–RST7, SOI, EOI.
        match marker {
            0x00 | 0x01 | 0xd0..=0xd9 => continue,
            _ => {}
        }

        if i + 2 > bytes.len() {
            break;
        }
        let seg_len = read_u16_be(bytes, i) as usize;
        if seg_len < 2 {
            break;
        }
        let Some(seg_end) = i.checked_add(seg_len) else {
            break;
        };
        if seg_end > bytes.len() {
            break; // truncated segment
        }
        let payload = &bytes[i + 2..seg_end];

        // APP0 JFIF density
        if marker == 0xe0 && dpi.is_none() {
            if let Some(d) = jfif_dpi(payload) {
                dpi = Some(d);
            }
        }

        // SOF0..SOF3, SOF5..SOF7, SOF9..SOF11, SOF13..SOF15 (not DHT/DAC/…)
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if payload.len() >= 5 {
                // precision (1), height (2), width (2)
                info.height = Some(read_u16_be(payload, 1) as u32);
                info.width = Some(read_u16_be(payload, 3) as u32);
            }
            info.dpi = dpi;
            return info;
        }

        // Start of scan — dimensions must have appeared in a SOF already.
        if marker == 0xda {
            break;
        }

        i = seg_end;
    }
    info.dpi = dpi;
    info
}

/// Parse JFIF APP0 payload (bytes after the 2-byte length field).
fn jfif_dpi(payload: &[u8]) -> Option<Dpi> {
    // "JFIF\0" + ver(2) + units(1) + Xdensity(2) + Ydensity(2)
    if payload.len() < 12 || &payload[0..5] != b"JFIF\0" {
        return None;
    }
    let units = payload[7];
    let x = read_u16_be(payload, 8) as f64;
    let y = read_u16_be(payload, 10) as f64;
    match units {
        1 => Some(Dpi { x, y }), // dots per inch
        2 => Some(Dpi {
            x: x * 2.54,
            y: y * 2.54,
        }), // dots per cm → dpi
        _ => None,               // 0 = aspect ratio only
    }
}

// ---------------------------------------------------------------------------
// PSD / PSB
// ---------------------------------------------------------------------------

fn looks_like_psd(bytes: &[u8]) -> bool {
    bytes.starts_with(b"8BPS")
}

fn sniff_psd(bytes: &[u8]) -> ImageSniff {
    // signature(4) + version(2) + reserved(6) + channels(2) + height(4) + width(4)
    // + depth(2) + mode(2)  → 26 bytes minimum
    if bytes.len() < 26 {
        // Magic matched; version may still be readable.
        let format = if bytes.len() >= 6 {
            match read_u16_be(bytes, 4) {
                1 => ImageFormat::Psd,
                2 => ImageFormat::Psb,
                _ => ImageFormat::Unknown,
            }
        } else {
            ImageFormat::Unknown
        };
        return if format == ImageFormat::Unknown {
            ImageSniff::UNKNOWN
        } else {
            ImageSniff::known(format)
        };
    }
    let version = read_u16_be(bytes, 4);
    let format = match version {
        1 => ImageFormat::Psd,
        2 => ImageFormat::Psb,
        _ => return ImageSniff::UNKNOWN,
    };
    let height = read_u32_be(bytes, 14);
    let width = read_u32_be(bytes, 18);
    ImageSniff {
        format,
        width: Some(width),
        height: Some(height),
        dpi: None,
    }
}

// ---------------------------------------------------------------------------
// GIF
// ---------------------------------------------------------------------------

fn looks_like_gif(bytes: &[u8]) -> bool {
    bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a")
}

fn sniff_gif(bytes: &[u8]) -> ImageSniff {
    let mut info = ImageSniff::known(ImageFormat::Gif);
    // header(6) + logical screen width(2) + height(2)
    if bytes.len() >= 10 {
        info.width = Some(read_u16_le(bytes, 6) as u32);
        info.height = Some(read_u16_le(bytes, 8) as u32);
    }
    info
}

// ---------------------------------------------------------------------------
// BMP
// ---------------------------------------------------------------------------

fn looks_like_bmp(bytes: &[u8]) -> bool {
    bytes.starts_with(b"BM")
}

fn sniff_bmp(bytes: &[u8]) -> ImageSniff {
    let mut info = ImageSniff::known(ImageFormat::Bmp);
    // BITMAPFILEHEADER is 14 bytes; DIB header size at offset 14.
    if bytes.len() < 26 {
        return info;
    }
    let dib_size = read_u32_le(bytes, 14) as usize;
    // BITMAPCOREHEADER (12): width/height are u16 at 18/20
    if dib_size == 12 {
        if bytes.len() >= 22 {
            info.width = Some(read_u16_le(bytes, 18) as u32);
            info.height = Some(read_u16_le(bytes, 20) as u32);
        }
        return info;
    }
    // BITMAPINFOHEADER (40+) and later: width i32 @18, height i32 @22
    if bytes.len() >= 26 {
        let w = read_i32_le(bytes, 18);
        let h = read_i32_le(bytes, 22);
        if w > 0 {
            info.width = Some(w as u32);
        }
        if h != 0 {
            info.height = Some(h.unsigned_abs());
        }
    }
    // Optional pixels-per-meter at offsets 38/42 (BITMAPINFOHEADER+)
    if dib_size >= 40 && bytes.len() >= 46 {
        let ppm_x = read_i32_le(bytes, 38);
        let ppm_y = read_i32_le(bytes, 42);
        if ppm_x > 0 && ppm_y > 0 {
            info.dpi = Some(Dpi {
                x: ppm_to_dpi(ppm_x as f64),
                y: ppm_to_dpi(ppm_y as f64),
            });
        }
    }
    info
}

// ---------------------------------------------------------------------------
// Byte helpers (never panic on short slices — callers bound-check first)
// ---------------------------------------------------------------------------

fn get_slice(bytes: &[u8], offset: usize, len: usize) -> Option<&[u8]> {
    let end = offset.checked_add(len)?;
    bytes.get(offset..end)
}

fn read_u16_be(bytes: &[u8], offset: usize) -> u16 {
    u16::from_be_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u16_le(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes([bytes[offset], bytes[offset + 1]])
}

fn read_u32_be(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_u32_le(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

fn read_i32_le(bytes: &[u8], offset: usize) -> i32 {
    i32::from_le_bytes([
        bytes[offset],
        bytes[offset + 1],
        bytes[offset + 2],
        bytes[offset + 3],
    ])
}

// ===========================================================================
// Unit tests (crafted headers; no document model)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn png_ihdr(w: u32, h: u32) -> Vec<u8> {
        let mut v = Vec::new();
        v.extend_from_slice(PNG_SIG);
        v.extend_from_slice(&13u32.to_be_bytes()); // IHDR length
        v.extend_from_slice(b"IHDR");
        v.extend_from_slice(&w.to_be_bytes());
        v.extend_from_slice(&h.to_be_bytes());
        v.extend_from_slice(&[8, 2, 0, 0, 0]); // bit depth, color type, …
        v.extend_from_slice(&[0, 0, 0, 0]); // fake CRC
        v
    }

    fn png_with_phys(w: u32, h: u32, ppm_x: u32, ppm_y: u32, unit: u8) -> Vec<u8> {
        let mut v = png_ihdr(w, h);
        v.extend_from_slice(&9u32.to_be_bytes());
        v.extend_from_slice(b"pHYs");
        v.extend_from_slice(&ppm_x.to_be_bytes());
        v.extend_from_slice(&ppm_y.to_be_bytes());
        v.push(unit);
        v.extend_from_slice(&[0, 0, 0, 0]); // fake CRC
        v.extend_from_slice(&0u32.to_be_bytes());
        v.extend_from_slice(b"IEND");
        v.extend_from_slice(&[0, 0, 0, 0]);
        v
    }

    #[test]
    fn empty_and_garbage_are_unknown() {
        assert_eq!(sniff_image(&[]).format, ImageFormat::Unknown);
        assert_eq!(sniff_image(b"not-an-image").format, ImageFormat::Unknown);
        assert_eq!(sniff_image(&[0, 1, 2, 3]).width, None);
        assert_eq!(sniff_image(&[0xff]).format, ImageFormat::Unknown);
    }

    #[test]
    fn truncated_headers_do_not_panic() {
        let cases: &[&[u8]] = &[
            b"\x89PNG\r\n\x1a\n",
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIH",
            b"\xff\xd8\xff",
            b"\xff\xd8\xff\xe0\x00\x10",
            b"8BPS\x00\x01",
            b"GIF89a\x01",
            b"BM\x00\x00",
        ];
        for c in cases {
            let _ = sniff_image(c); // must not panic
        }
    }

    #[test]
    fn png_size_and_phys_dpi() {
        let bytes = png_with_phys(32, 32, 11811, 11811, 1);
        let s = sniff_image(&bytes);
        assert_eq!(s.format, ImageFormat::Png);
        assert_eq!(s.width, Some(32));
        assert_eq!(s.height, Some(32));
        let dpi = s.dpi.expect("pHYs dpi");
        assert!((dpi.x - 299.9994).abs() < 0.01);
        assert!((dpi.y - 299.9994).abs() < 0.01);

        // unit 0 → no absolute DPI
        let no_dpi = png_with_phys(10, 20, 100, 100, 0);
        assert!(sniff_image(&no_dpi).dpi.is_none());
    }

    #[test]
    fn jpeg_sof_and_jfif_dpi() {
        // Minimal SOI + APP0 JFIF (72 dpi) + SOF0 100x80 + EOI
        let mut v = vec![0xff, 0xd8]; // SOI
        // APP0
        v.extend_from_slice(&[0xff, 0xe0]);
        v.extend_from_slice(&16u16.to_be_bytes()); // length
        v.extend_from_slice(b"JFIF\0");
        v.extend_from_slice(&[1, 1]); // version
        v.push(1); // units = dpi
        v.extend_from_slice(&72u16.to_be_bytes());
        v.extend_from_slice(&72u16.to_be_bytes());
        v.extend_from_slice(&[0, 0]); // thumbnail 0x0
        // SOF0 (length = 2 + precision + h + w + nf + 3 bytes/component)
        v.extend_from_slice(&[0xff, 0xc0]);
        v.extend_from_slice(&11u16.to_be_bytes());
        v.push(8); // precision
        v.extend_from_slice(&80u16.to_be_bytes()); // height
        v.extend_from_slice(&100u16.to_be_bytes()); // width
        v.push(1); // components
        v.extend_from_slice(&[1, 0x11, 0]); // component id, sampling, quant
        v.extend_from_slice(&[0xff, 0xd9]); // EOI

        let s = sniff_image(&v);
        assert_eq!(s.format, ImageFormat::Jpeg);
        assert_eq!((s.width, s.height), (Some(100), Some(80)));
        assert_eq!(s.dpi, Some(Dpi { x: 72.0, y: 72.0 }));
    }

    #[test]
    fn jpeg_jfif_dpcm_converts_to_dpi() {
        let mut v = vec![0xff, 0xd8, 0xff, 0xe0];
        v.extend_from_slice(&16u16.to_be_bytes());
        v.extend_from_slice(b"JFIF\0");
        v.extend_from_slice(&[1, 1]);
        v.push(2); // dpcm
        v.extend_from_slice(&100u16.to_be_bytes());
        v.extend_from_slice(&100u16.to_be_bytes());
        v.extend_from_slice(&[0, 0]);
        v.extend_from_slice(&[0xff, 0xc0]);
        v.extend_from_slice(&11u16.to_be_bytes());
        v.push(8);
        v.extend_from_slice(&1u16.to_be_bytes());
        v.extend_from_slice(&1u16.to_be_bytes());
        v.push(1);
        v.extend_from_slice(&[1, 0x11, 0]);

        let s = sniff_image(&v);
        let dpi = s.dpi.expect("dpcm");
        assert!((dpi.x - 254.0).abs() < 1e-9);
        assert!((dpi.y - 254.0).abs() < 1e-9);
    }

    #[test]
    fn psd_and_psb_sizes() {
        let mut psd = vec![0u8; 26];
        psd[0..4].copy_from_slice(b"8BPS");
        psd[5] = 1; // version 1
        psd[14..18].copy_from_slice(&435u32.to_be_bytes()); // height
        psd[18..22].copy_from_slice(&259u32.to_be_bytes()); // width
        let s = sniff_image(&psd);
        assert_eq!(s.format, ImageFormat::Psd);
        assert_eq!((s.width, s.height), (Some(259), Some(435)));

        let mut psb = psd.clone();
        psb[5] = 2;
        psb[14..18].copy_from_slice(&70u32.to_be_bytes());
        psb[18..22].copy_from_slice(&70u32.to_be_bytes());
        let s = sniff_image(&psb);
        assert_eq!(s.format, ImageFormat::Psb);
        assert_eq!((s.width, s.height), (Some(70), Some(70)));
    }

    #[test]
    fn gif_and_bmp_sizes() {
        let mut gif = b"GIF89a".to_vec();
        gif.extend_from_slice(&320u16.to_le_bytes());
        gif.extend_from_slice(&240u16.to_le_bytes());
        let s = sniff_image(&gif);
        assert_eq!(s.format, ImageFormat::Gif);
        assert_eq!((s.width, s.height), (Some(320), Some(240)));

        // BITMAPINFOHEADER
        let mut bmp = vec![0u8; 54];
        bmp[0..2].copy_from_slice(b"BM");
        bmp[14..18].copy_from_slice(&40u32.to_le_bytes()); // dib size
        bmp[18..22].copy_from_slice(&64i32.to_le_bytes());
        bmp[22..26].copy_from_slice(&(-48i32).to_le_bytes()); // top-down
        bmp[38..42].copy_from_slice(&2835i32.to_le_bytes()); // ~72 dpi
        bmp[42..46].copy_from_slice(&2835i32.to_le_bytes());
        let s = sniff_image(&bmp);
        assert_eq!(s.format, ImageFormat::Bmp);
        assert_eq!((s.width, s.height), (Some(64), Some(48)));
        let dpi = s.dpi.expect("bmp ppm");
        assert!((dpi.x - 72.009).abs() < 0.05);
    }

    #[test]
    fn unknown_never_guesses_size() {
        // TIFF magic — deferred; must not be guessed as a known size.
        let tiff_le = b"II*\0\x08\x00\x00\x00";
        let s = sniff_image(tiff_le);
        assert_eq!(s.format, ImageFormat::Unknown);
        assert_eq!(s.width, None);
        assert_eq!(s.height, None);

        let webp = b"RIFF\x00\x00\x00\x00WEBP";
        let s = sniff_image(webp);
        assert_eq!(s.format, ImageFormat::Unknown);
        assert_eq!(s.width, None);
    }

    #[test]
    fn table_driven_sizes() {
        let cases: Vec<(&str, Vec<u8>, ImageFormat, u32, u32)> = vec![
            ("png", png_ihdr(1, 2), ImageFormat::Png, 1, 2),
            (
                "gif87",
                {
                    let mut v = b"GIF87a".to_vec();
                    v.extend_from_slice(&8u16.to_le_bytes());
                    v.extend_from_slice(&9u16.to_le_bytes());
                    v
                },
                ImageFormat::Gif,
                8,
                9,
            ),
        ];
        for (label, bytes, fmt, w, h) in cases {
            let s = sniff_image(&bytes);
            assert_eq!(s.format, fmt, "{label}");
            assert_eq!(s.width, Some(w), "{label}");
            assert_eq!(s.height, Some(h), "{label}");
        }
    }
}

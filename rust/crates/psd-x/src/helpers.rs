/*
File: rust/crates/psd-x/src/helpers.rs

Purpose:
shared crate helpers: numeric/color utilities, blend-mode lookup tables
<-> 4-char key, layerColors, channel data pack/unpack
(raw / RLE / zip-without-prediction), and canvas-level stubs.

Source compatibility:
- port of upstream ag-psd `src/helpers.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module while porting;
- keep this area's public contract in one place.

PORT STATUS: ported except browser-canvas concerns
  (create_canvas / create_image_data / image_data_to_canvas / create_canvas_from_data
   are stabilized on the PixelData model).
*/

use std::collections::HashMap;

use flate2::{Compression as FlateCompression, write::ZlibEncoder};
use std::io::Write as _;

#[cfg(test)]
use crate::psd::ChannelId;
use crate::psd::{BlendMode, Compression, Layer, LayerColor, PixelData};

// ===========================================================================
// Blend mode <-> 4-char key mapping tables
// ===========================================================================

/// upstream `toBlendMode`: 4-char key -> BlendMode.
/// ALL entries and exact keys are preserved (including spaces); this is format-critical.
pub fn to_blend_mode(key: &str) -> Option<BlendMode> {
    Some(match key {
        "pass" => BlendMode::PassThrough,
        "norm" => BlendMode::Normal,
        "diss" => BlendMode::Dissolve,
        "dark" => BlendMode::Darken,
        "mul " => BlendMode::Multiply,
        "idiv" => BlendMode::ColorBurn,
        "lbrn" => BlendMode::LinearBurn,
        "dkCl" => BlendMode::DarkerColor,
        "lite" => BlendMode::Lighten,
        "scrn" => BlendMode::Screen,
        "div " => BlendMode::ColorDodge,
        "lddg" => BlendMode::LinearDodge,
        "lgCl" => BlendMode::LighterColor,
        "over" => BlendMode::Overlay,
        "sLit" => BlendMode::SoftLight,
        "hLit" => BlendMode::HardLight,
        "vLit" => BlendMode::VividLight,
        "lLit" => BlendMode::LinearLight,
        "pLit" => BlendMode::PinLight,
        "hMix" => BlendMode::HardMix,
        "diff" => BlendMode::Difference,
        "smud" => BlendMode::Exclusion,
        "fsub" => BlendMode::Subtract,
        "fdiv" => BlendMode::Divide,
        "hue " => BlendMode::Hue,
        "sat " => BlendMode::Saturation,
        "colr" => BlendMode::Color,
        "lum " => BlendMode::Luminosity,
        _ => return None,
    })
}

/// upstream `fromBlendMode` (built via
/// `Object.keys(toBlendMode).forEach(key => fromBlendMode[toBlendMode[key]] = key)`):
/// BlendMode -> 4-char key. Inverse mapping of `to_blend_mode`.
pub fn from_blend_mode(mode: BlendMode) -> &'static str {
    match mode {
        BlendMode::PassThrough => "pass",
        BlendMode::Normal => "norm",
        BlendMode::Dissolve => "diss",
        BlendMode::Darken => "dark",
        BlendMode::Multiply => "mul ",
        BlendMode::ColorBurn => "idiv",
        BlendMode::LinearBurn => "lbrn",
        BlendMode::DarkerColor => "dkCl",
        BlendMode::Lighten => "lite",
        BlendMode::Screen => "scrn",
        BlendMode::ColorDodge => "div ",
        BlendMode::LinearDodge => "lddg",
        BlendMode::LighterColor => "lgCl",
        BlendMode::Overlay => "over",
        BlendMode::SoftLight => "sLit",
        BlendMode::HardLight => "hLit",
        BlendMode::VividLight => "vLit",
        BlendMode::LinearLight => "lLit",
        BlendMode::PinLight => "pLit",
        BlendMode::HardMix => "hMix",
        BlendMode::Difference => "diff",
        BlendMode::Exclusion => "smud",
        BlendMode::Subtract => "fsub",
        BlendMode::Divide => "fdiv",
        BlendMode::Hue => "hue ",
        BlendMode::Saturation => "sat ",
        BlendMode::Color => "colr",
        BlendMode::Luminosity => "lum ",
        // ABR-only modes are not in the layer 4-char table (helpers.ts:9-38).
        // Layer writers should not emit them; fall back like a missing key.
        BlendMode::LinearHeight | BlendMode::Height | BlendMode::Subtraction => "norm",
    }
}

/// upstream `layerColors`.
pub const LAYER_COLORS: [LayerColor; 8] = [
    LayerColor::None,
    LayerColor::Red,
    LayerColor::Orange,
    LayerColor::Yellow,
    LayerColor::Green,
    LayerColor::Blue,
    LayerColor::Violet,
    LayerColor::Gray,
];

/// upstream `largeAdditionalInfoKeys`.
pub const LARGE_ADDITIONAL_INFO_KEYS: [&str; 14] = [
    // from documentation
    "LMsk", "Lr16", "Lr32", "Layr", "Mt16", "Mt32", "Mtrn", "Alph", "FMsk", "lnk2", "FEid", "FXid",
    "PxSD", // from guessing
    "cinf",
];

// ===========================================================================
// Dict / enum descriptor helpers
// ===========================================================================

/// upstream `Dict` = `{ [key: string]: string }`.
pub type Dict = HashMap<String, String>;

/// upstream `revMap`: swaps dictionary keys and values.
pub fn rev_map(map: &Dict) -> Dict {
    let mut result = Dict::new();
    for (key, value) in map {
        result.insert(value.clone(), key.clone());
    }
    result
}

/// Build a [`Dict`] from `(key, value)` string pairs (createEnum tables).
pub fn dict(pairs: &[(&str, &str)]) -> Dict {
    pairs
        .iter()
        .map(|(k, v)| ((*k).to_string(), (*v).to_string()))
        .collect()
}

/// upstream `createEnum<T>`: returns a (decode, encode) pair for a descriptor
/// enum of the form `prefix.value`. Since returning a closure pair is awkward in Rust,
/// we expose a struct with the same decode/encode.
pub struct EnumCodec {
    prefix: String,
    def: String,
    map: Dict,
    rev: Dict,
}

impl EnumCodec {
    /// upstream `createEnum(prefix, def, map)`.
    pub fn new(prefix: &str, def: &str, map: Dict) -> Self {
        let rev = rev_map(&map);
        EnumCodec {
            prefix: prefix.to_string(),
            def: def.to_string(),
            map,
            rev,
        }
    }

    /// upstream `decode(val)` (helpers.ts:66-79).
    ///
    /// Classic path: `prefix.CODE` → reverse-lookup → map key.
    /// Photoshop 2026 long-form fallback when CODE is missing from the reverse
    /// map: accept the map KEY verbatim (`BlnM.normal`) or a camelCase id whose
    /// spaced lowercase form is a map key (`BlnM.colorBurn` → `color burn`).
    pub fn decode(&self, val: &str) -> Result<String, String> {
        let value = val.split('.').nth(1).unwrap_or("");
        if !value.is_empty() && !self.rev.contains_key(value) {
            // Photoshop 2026 long-form enum value (helpers.ts:69-76).
            if self.map.contains_key(value) {
                return Ok(value.to_string());
            }
            let spaced = camel_to_spaced_lower(value);
            if self.map.contains_key(&spaced) {
                return Ok(spaced);
            }
            return Err(format!("Unrecognized value for enum: '{val}'"));
        }
        Ok(self
            .rev
            .get(value)
            .cloned()
            .unwrap_or_else(|| self.def.clone()))
    }

    /// upstream `encode(val)`: `${prefix}.${map[val] || map[def]}`.
    /// `val == None` mirrors `undefined` in TS.
    /// Returns Err on an invalid non-empty value.
    pub fn encode(&self, val: Option<&str>) -> Result<String, String> {
        if let Some(v) = val {
            if !self.map.contains_key(v) {
                return Err(format!("Invalid value for enum: '{v}'"));
            }
        }
        let mapped = val
            .and_then(|v| self.map.get(v))
            .or_else(|| self.map.get(&self.def))
            .cloned()
            .unwrap_or_default();
        Ok(format!("{}.{}", self.prefix, mapped))
    }
}

/// `colorBurn` → `color burn` (helpers.ts:75).
fn camel_to_spaced_lower(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 4);
    for (i, ch) in value.chars().enumerate() {
        if ch.is_ascii_uppercase() {
            if i > 0 {
                out.push(' ');
            }
            out.push(ch.to_ascii_lowercase());
        } else {
            out.push(ch);
        }
    }
    out
}

// ===========================================================================
// Numeric const enums (port of TS `const enum`)
// ===========================================================================

/// upstream `const enum ColorSpace`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorSpace {
    Rgb = 0,
    Hsb = 1,
    Cmyk = 2,
    Lab = 7,
    Grayscale = 8,
}

/// upstream `const enum LayerMaskFlags`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LayerMaskFlags {
    PositionRelativeToLayer = 1,
    LayerMaskDisabled = 2,
    /// obsolete
    InvertLayerMaskWhenBlending = 4,
    LayerMaskFromRenderingOtherData = 8,
    MaskHasParametersAppliedToIt = 16,
}

/// upstream `const enum MaskParams`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MaskParams {
    UserMaskDensity = 1,
    UserMaskFeather = 2,
    VectorMaskDensity = 4,
    VectorMaskFeather = 8,
}

// ===========================================================================
// Channel / bounds data shapes
// ===========================================================================

/// upstream `ChannelData`.
///
/// `channel_id` is the raw PSD channel id (`i16`), matching upstream's numeric
/// `ChannelID` (including spot/extra channels with `id >= 4`).
#[derive(Debug, Clone)]
pub struct ChannelData {
    pub channel_id: i16,
    pub compression: Compression,
    pub buffer: Option<Vec<u8>>,
    pub length: usize,
}

/// upstream `Bounds`.
#[derive(Debug, Clone, Copy, Default)]
pub struct Bounds {
    pub top: i32,
    pub left: i32,
    pub right: i32,
    pub bottom: i32,
}

/// upstream `LayerChannelData`.
pub struct LayerChannelData {
    pub layer: Layer,
    pub channels: Vec<ChannelData>,
    pub top: i32,
    pub left: i32,
    pub right: i32,
    pub bottom: i32,
    pub mask: Option<Bounds>,
    pub real_mask: Option<Bounds>,
}

// ===========================================================================
// Pure numeric helpers
// ===========================================================================

/// upstream `offsetForChannel(channelId, cmyk)`.
///
/// Takes the raw PSD channel id (`i16`). Extra/spot channels (`id >= 4`) map to
/// `id + 1`, matching upstream — they must not be aliased to Transparency.
pub fn offset_for_channel(channel_id: i16, cmyk: bool) -> i32 {
    match channel_id {
        0 => 0,
        1 => 1,
        2 => 2,
        3 => {
            if cmyk {
                3
            } else {
                4
            }
        }
        -1 => {
            if cmyk {
                4
            } else {
                3
            }
        }
        id => (id as i32) + 1,
    }
}

/// upstream `clamp(value, min, max)`.
pub fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

/// upstream `hasAlpha(data)`: true if any pixel has non-opaque alpha.
///
/// For 8-bit buffers this matches upstream (`!= 255`). Higher depths are
/// treated as opaque-only for the write-side 8-bit path.
pub fn has_alpha(data: &PixelData) -> bool {
    if data.depth != 8 {
        return false;
    }
    let size = (data.width as usize) * (data.height as usize) * 4;
    let mut i = 3usize;
    while i < size {
        if data.data[i] != 255 {
            return true;
        }
        i += 4;
    }
    false
}

/// upstream `resetImageData({ data })`.
///
/// Alpha depends on sample depth: `0xff` / `0xffff` / `1.0f32`.
pub fn reset_image_data(data: &mut PixelData) {
    let bps = data.bytes_per_sample();
    let channels = 4usize;
    let pixels = (data.width as usize).saturating_mul(data.height as usize);
    let buf = &mut data.data;
    match data.depth {
        16 => {
            let opaque = 0xffffu16.to_ne_bytes();
            let zero = 0u16.to_ne_bytes();
            for i in 0..pixels {
                let base = i * channels * bps;
                for c in 0..3 {
                    let o = base + c * bps;
                    if o + 1 < buf.len() {
                        buf[o] = zero[0];
                        buf[o + 1] = zero[1];
                    }
                }
                let a = base + 3 * bps;
                if a + 1 < buf.len() {
                    buf[a] = opaque[0];
                    buf[a + 1] = opaque[1];
                }
            }
        }
        32 => {
            let opaque = 1.0f32.to_ne_bytes();
            let zero = 0.0f32.to_ne_bytes();
            for i in 0..pixels {
                let base = i * channels * bps;
                for c in 0..3 {
                    let o = base + c * bps;
                    if o + 3 < buf.len() {
                        buf[o..o + 4].copy_from_slice(&zero);
                    }
                }
                let a = base + 3 * bps;
                if a + 3 < buf.len() {
                    buf[a..a + 4].copy_from_slice(&opaque);
                }
            }
        }
        _ => {
            let size = buf.len();
            let mut p = 0usize;
            while p + 3 < size {
                buf[p] = 0;
                buf[p + 1] = 0;
                buf[p + 2] = 0;
                buf[p + 3] = 0xff;
                p += 4;
            }
        }
    }
}

/// upstream `decodeBitmap(input, output, width, height)`.
/// Unpack a 1-bit image to RGBA8: bit=1 -> black (0), bit=0 -> white (255).
pub fn decode_bitmap(input: &[u8], output: &mut [u8], width: usize, height: usize) {
    let mut p = 0usize;
    let mut o = 0usize;
    for _y in 0..height {
        let mut x = 0usize;
        while x < width {
            let mut b = input[o];
            o += 1;
            let mut i = 0;
            while i < 8 && x < width {
                let v: u8 = if b & 0x80 != 0 { 0 } else { 255 };
                b <<= 1;
                output[p] = v;
                output[p + 1] = v;
                output[p + 2] = v;
                output[p + 3] = 255;
                i += 1;
                x += 1;
                p += 4;
            }
        }
    }
}

// ===========================================================================
// Channel data writers (raw / RLE / zip)
// ===========================================================================

/// upstream `writeDataRaw(data, offset, width, height)`.
/// Extract one channel (by offset) into a dense array of length width*height.
pub fn write_data_raw(
    data: &PixelData,
    offset: usize,
    width: usize,
    height: usize,
) -> Option<Vec<u8>> {
    if width == 0 || height == 0 {
        return None;
    }
    let mut array = vec![0u8; width * height];
    for (i, slot) in array.iter_mut().enumerate() {
        *slot = data.data[i * 4 + offset];
    }
    Some(array)
}

/// upstream `writeDataRLE(buffer, { data, width, height }, offsets, large)`.
/// Compress channels with PackBits as in the original (including the length table
/// at the start of the buffer). Returns a slice of the used portion of the buffer.
pub fn write_data_rle(
    buffer: &mut [u8],
    data_pixels: &PixelData,
    offsets: &[usize],
    large: bool,
) -> Option<Vec<u8>> {
    let width = data_pixels.width as i64;
    let height = data_pixels.height as i64;
    if width == 0 || height == 0 {
        return None;
    }
    let data = &data_pixels.data;
    let stride = 4 * width;

    let mut ol: i64 = 0;
    let mut o: i64 = (offsets.len() as i64) * (if large { 4 } else { 2 }) * height;

    let get = |idx: i64| -> i64 { data[idx as usize] as i64 };

    // upstream writes into a `Uint8Array`; writing past its end is a silent
    // no-op in JS (the value is simply dropped), and `buffer.slice(0, o)` later
    // returns only the bytes that fit. The buffer is sized by an estimate that
    // can be too small for tiny images (e.g. 1x1 with alpha), so faithfully
    // mirror the TypedArray semantics by ignoring out-of-bounds writes instead
    // of panicking. `o`/`ol` still advance so the returned length matches TS.
    macro_rules! set {
        ($buf:expr, $idx:expr, $val:expr) => {{
            let idx = $idx as usize;
            if idx < $buf.len() {
                $buf[idx] = $val;
            }
        }};
    }

    for &offset in offsets {
        let offset = offset as i64;
        for y in 0..height {
            let stride_start = y * stride;
            let stride_end = stride_start + stride;
            let last_index = stride_end + offset - 4;
            let last_index2 = last_index - 4;
            let start_offset = o;

            let mut p = stride_start + offset;
            while p < stride_end {
                if p < last_index2 {
                    let mut value1 = get(p);
                    p += 4;
                    let mut value2 = get(p);
                    p += 4;
                    let mut value3 = get(p);

                    if value1 == value2 && value1 == value3 {
                        let mut count: i64 = 3;
                        while count < 128 && p < last_index && get(p + 4) == value1 {
                            count += 1;
                            p += 4;
                        }
                        set!(buffer, o, (1 - count) as u8);
                        o += 1;
                        set!(buffer, o, value1 as u8);
                        o += 1;
                    } else {
                        let count_index = o;
                        let mut write_last = true;
                        let mut count: i64 = 1;
                        set!(buffer, o, 0);
                        o += 1;
                        set!(buffer, o, value1 as u8);
                        o += 1;

                        while p < last_index && count < 128 {
                            p += 4;
                            value1 = value2;
                            value2 = value3;
                            value3 = get(p);

                            if value1 == value2 && value1 == value3 {
                                p -= 12;
                                write_last = false;
                                break;
                            } else {
                                count += 1;
                                set!(buffer, o, value1 as u8);
                                o += 1;
                            }
                        }

                        if write_last {
                            if count < 127 {
                                set!(buffer, o, value2 as u8);
                                o += 1;
                                set!(buffer, o, value3 as u8);
                                o += 1;
                                count += 2;
                            } else if count < 128 {
                                set!(buffer, o, value2 as u8);
                                o += 1;
                                count += 1;
                                p -= 4;
                            } else {
                                p -= 8;
                            }
                        }

                        set!(buffer, count_index, (count - 1) as u8);
                    }
                } else if p == last_index {
                    set!(buffer, o, 0);
                    o += 1;
                    set!(buffer, o, get(p) as u8);
                    o += 1;
                } else {
                    // p === lastIndex2
                    set!(buffer, o, 1);
                    o += 1;
                    set!(buffer, o, get(p) as u8);
                    o += 1;
                    p += 4;
                    set!(buffer, o, get(p) as u8);
                    o += 1;
                }

                p += 4;
            }

            let length = o - start_offset;

            if large {
                set!(buffer, ol, ((length >> 24) & 0xff) as u8);
                ol += 1;
                set!(buffer, ol, ((length >> 16) & 0xff) as u8);
                ol += 1;
            }

            set!(buffer, ol, ((length >> 8) & 0xff) as u8);
            ol += 1;
            set!(buffer, ol, (length & 0xff) as u8);
            ol += 1;
        }
    }

    // mirror `buffer.slice(0, o)`: clamp to the buffer length so we never read
    // past the end when the size estimate fell short (out-of-bounds writes above
    // were dropped, so those positions hold zero/stale bytes which TS omits too).
    let end = (o as usize).min(buffer.len());
    Some(buffer[..end].to_vec())
}

/// upstream `writeDataZipWithoutPrediction({ data, width, height }, offsets)`.
/// Extract each channel and zlib/deflate-compress, concatenating the results.
pub fn write_data_zip_without_prediction(
    data_pixels: &PixelData,
    offsets: &[usize],
) -> Option<Vec<u8>> {
    let size = (data_pixels.width as usize) * (data_pixels.height as usize);
    let data = &data_pixels.data;
    let mut channel = vec![0u8; size];
    let mut buffers: Vec<Vec<u8>> = Vec::new();
    let mut total_length = 0usize;

    for &offset in offsets {
        let mut o = offset;
        for slot in channel.iter_mut().take(size) {
            *slot = data[o];
            o += 4;
        }

        let buffer = deflate_sync(&channel);
        total_length += buffer.len();
        buffers.push(buffer);
    }

    if !buffers.is_empty() {
        let mut buffer = Vec::with_capacity(total_length);
        for b in &buffers {
            buffer.extend_from_slice(b);
        }
        Some(buffer)
    } else {
        // upstream returns buffers[0] (undefined for an empty list).
        None
    }
}

/// Equivalent of `deflate` from `pako` (zlib-wrapped deflate).
fn deflate_sync(input: &[u8]) -> Vec<u8> {
    let mut encoder = ZlibEncoder::new(Vec::new(), FlateCompression::default());
    encoder.write_all(input).expect("zlib write");
    encoder.finish().expect("zlib finish")
}

// ===========================================================================
// Canvas level — stubs for the PixelData model
// ===========================================================================

/// upstream `imageDataToCanvas(pixelData)`.
///
/// Converts 16/32-bit sample buffers to RGBA8 the same way as upstream helpers.ts:
/// - Float32 RGB: `round(pow(v, 1/2.2) * 255)`, alpha: `round(v * 255)`
/// - Uint16: high byte (`>>> 8`)
/// - Uint8: passthrough clone
/// Canvas construction and sample normalization moved to the `canvas` leaf
/// so `helpers` and `thumbnail` never depend on each other. Re-exported here to
/// keep the upstream-shaped helpers API unchanged.
pub use crate::canvas::{
    create_canvas, create_image_data, image_data_to_canvas, try_create_image_data,
    try_image_data_to_canvas,
};

/// upstream `createCanvasFromData(data)` — JPEG decode into a canvas.
///
/// With the `thumbnail` feature this decodes via `zune-jpeg`; without it,
/// returns an empty 100×100 placeholder (raw passthrough is preferred for
/// round-trips).
pub fn create_canvas_from_data(data: &[u8]) -> PixelData {
    crate::thumbnail::decode_thumbnail_jpeg(data)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::BLEND_MODE_JSON;

    #[test]
    fn blend_mode_round_trip_all_entries() {
        // Layer 4-char table only — ABR-only modes are intentionally excluded.
        let all = BLEND_MODE_JSON
            .iter()
            .map(|&(_, m)| m)
            .filter(|m| m.is_layer_table());
        for mode in all {
            let key = from_blend_mode(mode);
            assert_eq!(key.len(), 4, "key must be 4 chars: {key:?}");
            assert_eq!(
                to_blend_mode(key),
                Some(mode),
                "round trip failed for {key:?}"
            );
        }
    }

    #[test]
    fn blend_mode_spacey_keys() {
        assert_eq!(to_blend_mode("mul "), Some(BlendMode::Multiply));
        assert_eq!(to_blend_mode("div "), Some(BlendMode::ColorDodge));
        assert_eq!(from_blend_mode(BlendMode::Luminosity), "lum ");
        assert_eq!(to_blend_mode("nope"), None);
    }

    #[test]
    fn clamp_edges() {
        assert_eq!(clamp(-1.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp(11.0, 0.0, 10.0), 10.0);
        assert_eq!(clamp(5.0, 0.0, 10.0), 5.0);
        assert_eq!(clamp(0.0, 0.0, 10.0), 0.0);
        assert_eq!(clamp(10.0, 0.0, 10.0), 10.0);
    }

    #[test]
    fn offset_for_channel_rgb_and_cmyk() {
        assert_eq!(offset_for_channel(ChannelId::Color0 as i16, false), 0);
        assert_eq!(offset_for_channel(ChannelId::Color1 as i16, false), 1);
        assert_eq!(offset_for_channel(ChannelId::Color2 as i16, false), 2);
        // Color3 == 3: rgb branch -> id+1 == 4; cmyk -> 3.
        assert_eq!(offset_for_channel(ChannelId::Color3 as i16, false), 4);
        assert_eq!(offset_for_channel(ChannelId::Color3 as i16, true), 3);
        // Transparency == -1.
        assert_eq!(offset_for_channel(ChannelId::Transparency as i16, false), 3);
        assert_eq!(offset_for_channel(ChannelId::Transparency as i16, true), 4);
        // default: UserMask == -2 -> id+1 == -1.
        assert_eq!(offset_for_channel(ChannelId::UserMask as i16, false), -1);
        assert_eq!(offset_for_channel(ChannelId::RealUserMask as i16, true), -2);
        // Extra/spot channel id >= 4 (upstream helpers.spec.ts).
        assert_eq!(offset_for_channel(10, false), 11);
    }

    #[test]
    fn has_alpha_detects_non_opaque() {
        let opaque = PixelData::rgba8(2, 1, vec![1, 2, 3, 255, 4, 5, 6, 255]);
        assert!(!has_alpha(&opaque));

        let translucent = PixelData::rgba8(2, 1, vec![1, 2, 3, 255, 4, 5, 6, 128]);
        assert!(has_alpha(&translucent));
    }

    #[test]
    fn reset_image_data_sets_black_opaque() {
        let mut pd = PixelData::rgba8(2, 1, vec![9, 9, 9, 9, 9, 9, 9, 9]);
        reset_image_data(&mut pd);
        assert_eq!(pd.data, vec![0, 0, 0, 255, 0, 0, 0, 255]);
    }

    #[test]
    fn image_data_to_canvas_applies_32bit_gamma() {
        // linear 1.0 → pow(1/2.2)*255 ≈ 255; alpha 1.0 → 255
        let mut data = Vec::new();
        for v in [1.0f32, 1.0, 1.0, 1.0] {
            data.extend_from_slice(&v.to_ne_bytes());
        }
        let pd = PixelData {
            width: 1,
            height: 1,
            data,
            depth: 32,
        };
        let canvas = image_data_to_canvas(&pd);
        assert_eq!(canvas.depth, 8);
        assert_eq!(canvas.data, vec![255, 255, 255, 255]);
    }

    #[test]
    fn decode_bitmap_packs_bits() {
        // One byte 0b10100000 over width 8: bits -> black,white,black,white,...
        let input = [0b1010_0000u8];
        let mut output = vec![0u8; 8 * 4];
        decode_bitmap(&input, &mut output, 8, 1);
        // pixel0 bit set -> 0; pixel1 bit clear -> 255; pixel2 -> 0; pixel3 -> 255 ...
        assert_eq!(output[0], 0);
        assert_eq!(output[4], 255);
        assert_eq!(output[8], 0);
        assert_eq!(output[12], 255);
        // alpha always 255
        assert_eq!(output[3], 255);
    }

    #[test]
    fn write_data_raw_extracts_channel() {
        // 2x1 RGBA: [r0 g0 b0 a0, r1 g1 b1 a1]
        let pd = PixelData::rgba8(2, 1, vec![10, 20, 30, 40, 50, 60, 70, 80]);
        assert_eq!(write_data_raw(&pd, 0, 2, 1), Some(vec![10, 50])); // red
        assert_eq!(write_data_raw(&pd, 3, 2, 1), Some(vec![40, 80])); // alpha
        assert_eq!(write_data_raw(&pd, 0, 0, 1), None);
    }

    #[test]
    fn zip_without_prediction_round_trips() {
        use flate2::read::ZlibDecoder;
        use std::io::Read;

        let pd = PixelData::rgba8(4, 1, vec![1, 0, 0, 0, 2, 0, 0, 0, 3, 0, 0, 0, 4, 0, 0, 0]);
        let out = write_data_zip_without_prediction(&pd, &[0]).unwrap();
        let mut decoder = ZlibDecoder::new(&out[..]);
        let mut decoded = Vec::new();
        decoder.read_to_end(&mut decoded).unwrap();
        assert_eq!(decoded, vec![1, 2, 3, 4]);
    }

    #[test]
    fn rev_map_swaps() {
        let mut m = Dict::new();
        m.insert("a".into(), "1".into());
        m.insert("b".into(), "2".into());
        let r = rev_map(&m);
        assert_eq!(r.get("1"), Some(&"a".to_string()));
        assert_eq!(r.get("2"), Some(&"b".to_string()));
    }

    #[test]
    fn enum_codec_encode_decode() {
        let mut map = Dict::new();
        map.insert("alpha".into(), "Alph".into());
        map.insert("beta".into(), "Beta".into());
        let codec = EnumCodec::new("Enum", "alpha", map);

        assert_eq!(codec.encode(Some("beta")).unwrap(), "Enum.Beta");
        assert_eq!(codec.encode(None).unwrap(), "Enum.Alph"); // falls back to def
        assert!(codec.encode(Some("gamma")).is_err());

        assert_eq!(codec.decode("Enum.Beta").unwrap(), "beta");
        assert_eq!(codec.decode("Enum.Alph").unwrap(), "alpha");
        // empty second segment -> default
        assert_eq!(codec.decode("Enum").unwrap(), "alpha");
        assert!(codec.decode("Enum.Zzzz").is_err());
    }

    #[test]
    fn enum_codec_photoshop_2026_long_form() {
        // Mirrors upstream ag-psd `src/test/helpers.spec.ts` createEnum().
        let codec = EnumCodec::new(
            "BlnM",
            "normal",
            dict(&[
                ("normal", "Nrml"),
                ("multiply", "Mltp"),
                ("color burn", "CBrn"),
            ]),
        );
        assert_eq!(codec.decode("BlnM.Nrml").unwrap(), "normal");
        assert_eq!(codec.decode("BlnM.Mltp").unwrap(), "multiply");
        assert_eq!(codec.decode("BlnM.normal").unwrap(), "normal");
        assert_eq!(codec.decode("BlnM.multiply").unwrap(), "multiply");
        assert_eq!(codec.decode("BlnM.colorBurn").unwrap(), "color burn");
        assert_eq!(
            codec
                .encode(Some(&codec.decode("BlnM.normal").unwrap()))
                .unwrap(),
            "BlnM.Nrml"
        );
        assert!(codec.decode("BlnM.bogus").is_err());
    }
}

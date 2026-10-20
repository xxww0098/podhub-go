/*
File: rust/crates/psd-x/src/psd.rs

Purpose:
main Psd document types (shared data model), read/write options.
This is the central shared model referenced by all other port modules.

Source compatibility:
- port of upstream ag-psd `src/psd.ts` (1:1 split).
- This file holds the shared data model (interface/type/enum/union ports).
  The read/write orchestration lives in `reader.rs` / `writer.rs` /
  `lib.rs`, not here.

Port conventions (become project conventions):
- TS optional `field?: T`  -> `field: Option<T>`.
- TS string-union (BlendMode = 'normal' | ...) -> Rust `enum`
  with `#[derive(Debug, Clone, Copy, PartialEq, Eq)]`; exact string values
  are kept in doc comments for the serde layer (`feature = "serde"`).
- TS numeric enum -> Rust enum with explicit discriminants matching TS.
- camelCase -> snake_case. For 4-char PSD keys and non-obvious names,
  doc comments record the original TS name.
- structs derive `Debug, Clone` (+ `Default` where a meaningful default exists).
- arrays -> `Vec<T>`; `Option<Box<T>>` only to break recursion.

canvas / imageData mapping:
- In TS the fields are `canvas: HTMLCanvasElement` and `imageData: PixelData` (where PixelData
  wraps a typed array). Here both are modeled by a single
  `PixelData { width, height, data: Vec<u8> /* RGBA8 */ }` type. Fields that
  were `canvas?: HTMLCanvasElement` become `canvas: Option<PixelData>`,
  to keep the original fields separate. The `image` crate is not used.
- TS `Uint8Array` / `PixelArray` -> `Vec<u8>` (for PixelArray we drop bit-depth
  info as requested — a raw byte buffer).

Type placement:
- All document types are defined here (this is the shared model). Types that in TS
  would live in other modules but are part of the public document shape
  are also defined here.
*/

// PORT STATUS: types ported; read/write orchestration ported.

// ===========================================================================
// Canvas / pixel data mapping
// ===========================================================================
/// Replacement for TS `HTMLCanvasElement` / `PixelData`.
///
/// `data` holds interleaved channel samples as a **native-endian** byte buffer
/// (matching JS `Uint8ClampedArray` / `Uint16Array` / `Float32Array` dumps):
/// - `depth == 8`:  `u8` samples (RGBA8 → `width * height * 4` bytes)
/// - `depth == 16`: `u16` samples (→ `width * height * 4 * 2` bytes)
/// - `depth == 32`: `f32` samples (→ `width * height * 4 * 4` bytes)
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PixelData {
    pub width: u32,
    pub height: u32,
    /// Native-endian interleaved sample bytes (see struct docs).
    #[cfg_attr(
        feature = "serde",
        serde(
            default,
            skip_serializing_if = "Vec::is_empty",
            with = "crate::serde_bytes"
        )
    )]
    pub data: Vec<u8>,
    /// Bits per sample: 8, 16, or 32. Omitted from JSON when 8.
    #[cfg_attr(
        feature = "serde",
        serde(
            default = "default_pixel_depth",
            skip_serializing_if = "is_default_pixel_depth"
        )
    )]
    pub depth: u8,
}

fn default_pixel_depth() -> u8 {
    8
}

fn is_default_pixel_depth(d: &u8) -> bool {
    *d == 8
}

impl Default for PixelData {
    fn default() -> Self {
        Self {
            width: 0,
            height: 0,
            data: Vec::new(),
            depth: 8,
        }
    }
}

impl PixelData {
    /// RGBA8 buffer (`depth = 8`).
    pub fn rgba8(width: u32, height: u32, data: Vec<u8>) -> Self {
        Self {
            width,
            height,
            data,
            depth: 8,
        }
    }

    /// Bytes per sample for this buffer's depth.
    pub fn bytes_per_sample(&self) -> usize {
        match self.depth {
            16 => 2,
            32 => 4,
            _ => 1,
        }
    }
}

// ===========================================================================
// Blend mode (string union)
// ===========================================================================

/// TS `BlendMode` string-union. See doc comments for string values.
///
/// Includes three ABR-only variants (`linear height` / `height` / `subtraction`)
/// that exist in upstream `psd.ts` but are absent from the layer 4-char table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlendMode {
    /// "pass through"
    PassThrough,
    /// "normal"
    Normal,
    /// "dissolve"
    Dissolve,
    /// "darken"
    Darken,
    /// "multiply"
    Multiply,
    /// "color burn"
    ColorBurn,
    /// "linear burn"
    LinearBurn,
    /// "darker color"
    DarkerColor,
    /// "lighten"
    Lighten,
    /// "screen"
    Screen,
    /// "color dodge"
    ColorDodge,
    /// "linear dodge"
    LinearDodge,
    /// "lighter color"
    LighterColor,
    /// "overlay"
    Overlay,
    /// "soft light"
    SoftLight,
    /// "hard light"
    HardLight,
    /// "vivid light"
    VividLight,
    /// "linear light"
    LinearLight,
    /// "pin light"
    PinLight,
    /// "hard mix"
    HardMix,
    /// "difference"
    Difference,
    /// "exclusion"
    Exclusion,
    /// "subtract"
    Subtract,
    /// "divide"
    Divide,
    /// "hue"
    Hue,
    /// "saturation"
    Saturation,
    /// "color"
    Color,
    /// "luminosity"
    Luminosity,
    /// "linear height" — ABR only (BlnM `linearHeight`)
    LinearHeight,
    /// "height" — ABR only (BlnM `Hght`)
    Height,
    /// "subtraction" — ABR only (BlnM `Sbtr`; distinct from `"subtract"`)
    Subtraction,
}

/// JSON / human-readable strings for [`BlendMode`] (ag-psd API surface).
pub const BLEND_MODE_JSON: &[(&str, BlendMode)] = &[
    ("pass through", BlendMode::PassThrough),
    ("normal", BlendMode::Normal),
    ("dissolve", BlendMode::Dissolve),
    ("darken", BlendMode::Darken),
    ("multiply", BlendMode::Multiply),
    ("color burn", BlendMode::ColorBurn),
    ("linear burn", BlendMode::LinearBurn),
    ("darker color", BlendMode::DarkerColor),
    ("lighten", BlendMode::Lighten),
    ("screen", BlendMode::Screen),
    ("color dodge", BlendMode::ColorDodge),
    ("linear dodge", BlendMode::LinearDodge),
    ("lighter color", BlendMode::LighterColor),
    ("overlay", BlendMode::Overlay),
    ("soft light", BlendMode::SoftLight),
    ("hard light", BlendMode::HardLight),
    ("vivid light", BlendMode::VividLight),
    ("linear light", BlendMode::LinearLight),
    ("pin light", BlendMode::PinLight),
    ("hard mix", BlendMode::HardMix),
    ("difference", BlendMode::Difference),
    ("exclusion", BlendMode::Exclusion),
    ("subtract", BlendMode::Subtract),
    ("divide", BlendMode::Divide),
    ("hue", BlendMode::Hue),
    ("saturation", BlendMode::Saturation),
    ("color", BlendMode::Color),
    ("luminosity", BlendMode::Luminosity),
    ("linear height", BlendMode::LinearHeight),
    ("height", BlendMode::Height),
    ("subtraction", BlendMode::Subtraction),
];

impl BlendMode {
    /// Parse an ag-psd JSON blend-mode string.
    pub fn from_json_str(s: &str) -> Option<Self> {
        BLEND_MODE_JSON
            .iter()
            .find_map(|&(name, mode)| (name == s).then_some(mode))
    }

    /// ag-psd JSON blend-mode string.
    pub const fn as_json_str(self) -> &'static str {
        match self {
            Self::PassThrough => "pass through",
            Self::Normal => "normal",
            Self::Dissolve => "dissolve",
            Self::Darken => "darken",
            Self::Multiply => "multiply",
            Self::ColorBurn => "color burn",
            Self::LinearBurn => "linear burn",
            Self::DarkerColor => "darker color",
            Self::Lighten => "lighten",
            Self::Screen => "screen",
            Self::ColorDodge => "color dodge",
            Self::LinearDodge => "linear dodge",
            Self::LighterColor => "lighter color",
            Self::Overlay => "overlay",
            Self::SoftLight => "soft light",
            Self::HardLight => "hard light",
            Self::VividLight => "vivid light",
            Self::LinearLight => "linear light",
            Self::PinLight => "pin light",
            Self::HardMix => "hard mix",
            Self::Difference => "difference",
            Self::Exclusion => "exclusion",
            Self::Subtract => "subtract",
            Self::Divide => "divide",
            Self::Hue => "hue",
            Self::Saturation => "saturation",
            Self::Color => "color",
            Self::Luminosity => "luminosity",
            Self::LinearHeight => "linear height",
            Self::Height => "height",
            Self::Subtraction => "subtraction",
        }
    }

    /// Variants that appear in the layer-record 4-char table (28 entries).
    pub const fn is_layer_table(self) -> bool {
        !matches!(self, Self::LinearHeight | Self::Height | Self::Subtraction)
    }
}

#[cfg(feature = "serde")]
impl serde::Serialize for BlendMode {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_json_str())
    }
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for BlendMode {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let s = <String as serde::Deserialize>::deserialize(deserializer)?;
        Self::from_json_str(&s).ok_or_else(|| {
            const NAMES: &[&str] = &[
                "pass through",
                "normal",
                "dissolve",
                "darken",
                "multiply",
                "color burn",
                "linear burn",
                "darker color",
                "lighten",
                "screen",
                "color dodge",
                "linear dodge",
                "lighter color",
                "overlay",
                "soft light",
                "hard light",
                "vivid light",
                "linear light",
                "pin light",
                "hard mix",
                "difference",
                "exclusion",
                "subtract",
                "divide",
                "hue",
                "saturation",
                "color",
                "luminosity",
                "linear height",
                "height",
                "subtraction",
            ];
            serde::de::Error::unknown_variant(&s, NAMES)
        })
    }
}

// ===========================================================================
// Numeric enums
// ===========================================================================
/// TS `const enum ColorMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde_repr::Serialize_repr, serde_repr::Deserialize_repr)
)]
#[repr(u8)]
pub enum ColorMode {
    Bitmap = 0,
    Grayscale = 1,
    Indexed = 2,
    Rgb = 3,
    Cmyk = 4,
    Multichannel = 7,
    Duotone = 8,
    Lab = 9,
}
/// TS `const enum SectionDividerType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde_repr::Serialize_repr, serde_repr::Deserialize_repr)
)]
#[repr(u8)]
pub enum SectionDividerType {
    Other = 0,
    OpenFolder = 1,
    ClosedFolder = 2,
    BoundingSectionDivider = 3,
}
/// TS `enum LayerCompCapturedInfo`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde_repr::Serialize_repr, serde_repr::Deserialize_repr)
)]
#[repr(u8)]
pub enum LayerCompCapturedInfo {
    None = 0,
    Visibility = 1,
    Position = 2,
    Appearance = 4,
}
/// TS `const enum ChannelID`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde_repr::Serialize_repr, serde_repr::Deserialize_repr)
)]
#[repr(i16)]
pub enum ChannelId {
    /// red (rgb) / cyan (cmyk)
    Color0 = 0,
    /// green (rgb) / magenta (cmyk)
    Color1 = 1,
    /// blue (rgb) / yellow (cmyk)
    Color2 = 2,
    /// - (rgb) / black (cmyk)
    Color3 = 3,
    Transparency = -1,
    UserMask = -2,
    RealUserMask = -3,
}
/// TS `const enum Compression`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde_repr::Serialize_repr, serde_repr::Deserialize_repr)
)]
#[repr(u8)]
pub enum Compression {
    RawData = 0,
    RleCompressed = 1,
    ZipWithoutPrediction = 2,
    ZipWithPrediction = 3,
}

// ===========================================================================
// Color variants
// ===========================================================================
/// TS `RGBA` — values from 0 to 255.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Rgba {
    pub r: f64,
    pub g: f64,
    pub b: f64,
    pub a: f64,
}
/// TS `RGB` — values from 0 to 255.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Rgb {
    pub r: f64,
    pub g: f64,
    pub b: f64,
}
/// TS `FRGB` — values from 0 to 1 (can be above 1, can be negative).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Frgb {
    pub fr: f64,
    pub fg: f64,
    pub fb: f64,
}
/// TS `HSB` — values from 0 to 1.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Hsb {
    pub h: f64,
    pub s: f64,
    pub b: f64,
}
/// TS `CMYK` — values from 0 to 255.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Cmyk {
    pub c: f64,
    pub m: f64,
    pub y: f64,
    pub k: f64,
}
/// TS `LAB` — `l` from 0 to 1; `a` and `b` from -1 to 1.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Lab {
    pub l: f64,
    pub a: f64,
    pub b: f64,
}
/// TS `Grayscale` — values from 0 to 255.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Grayscale {
    pub k: f64,
}

/// TS `Color = RGBA | RGB | FRGB | HSB | CMYK | LAB | Grayscale`.
///
/// JSON is a flat object union. Serde must **not** use `untagged` (RGB would
/// swallow RGBA). Probe order matches ag-psd `serializeColor` key detection:
/// `r` → `fr` → `h` → `c` → `l` → `k`, with `a` distinguishing RGBA vs RGB.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Color {
    Rgba(Rgba),
    Rgb(Rgb),
    Frgb(Frgb),
    Hsb(Hsb),
    Cmyk(Cmyk),
    Lab(Lab),
    Grayscale(Grayscale),
}

#[cfg(feature = "serde")]
impl serde::Serialize for Color {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match *self {
            Color::Rgba(v) => {
                let mut map = serializer.serialize_map(Some(4))?;
                map.serialize_entry("r", &v.r)?;
                map.serialize_entry("g", &v.g)?;
                map.serialize_entry("b", &v.b)?;
                map.serialize_entry("a", &v.a)?;
                map.end()
            }
            Color::Rgb(v) => {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("r", &v.r)?;
                map.serialize_entry("g", &v.g)?;
                map.serialize_entry("b", &v.b)?;
                map.end()
            }
            Color::Frgb(v) => {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("fr", &v.fr)?;
                map.serialize_entry("fg", &v.fg)?;
                map.serialize_entry("fb", &v.fb)?;
                map.end()
            }
            Color::Hsb(v) => {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("h", &v.h)?;
                map.serialize_entry("s", &v.s)?;
                map.serialize_entry("b", &v.b)?;
                map.end()
            }
            Color::Cmyk(v) => {
                let mut map = serializer.serialize_map(Some(4))?;
                map.serialize_entry("c", &v.c)?;
                map.serialize_entry("m", &v.m)?;
                map.serialize_entry("y", &v.y)?;
                map.serialize_entry("k", &v.k)?;
                map.end()
            }
            Color::Lab(v) => {
                let mut map = serializer.serialize_map(Some(3))?;
                map.serialize_entry("l", &v.l)?;
                map.serialize_entry("a", &v.a)?;
                map.serialize_entry("b", &v.b)?;
                map.end()
            }
            Color::Grayscale(v) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("k", &v.k)?;
                map.end()
            }
        }
    }
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for Color {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{Error, MapAccess, Visitor};
        use std::fmt;

        #[derive(Default)]
        struct Keys {
            r: Option<f64>,
            g: Option<f64>,
            b: Option<f64>,
            a: Option<f64>,
            fr: Option<f64>,
            fg: Option<f64>,
            fb: Option<f64>,
            h: Option<f64>,
            s: Option<f64>,
            c: Option<f64>,
            m: Option<f64>,
            y: Option<f64>,
            k: Option<f64>,
            l: Option<f64>,
            // Lab `a`/`b` share names with RGBA — track presence via dedicated slots
            // filled only when we see them after deciding? No: Lab uses a/b too.
            // Distinguish by probe: if `l` present → Lab; if `r` → RGB(A).
            lab_a: Option<f64>,
            lab_b: Option<f64>,
            has_a_key: bool,
            has_l: bool,
            has_r: bool,
            has_fr: bool,
            has_h: bool,
            has_c: bool,
            has_k: bool,
        }

        struct ColorVisitor;

        impl<'de> Visitor<'de> for ColorVisitor {
            type Value = Color;

            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a flat ag-psd Color object")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Color, M::Error> {
                let mut k = Keys::default();
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "r" => {
                            k.has_r = true;
                            k.r = map.next_value()?;
                        }
                        "g" => k.g = map.next_value()?,
                        "b" => {
                            let v = map.next_value()?;
                            k.b = v;
                            k.lab_b = v;
                        }
                        "a" => {
                            k.has_a_key = true;
                            let v = map.next_value()?;
                            k.a = v;
                            k.lab_a = v;
                        }
                        "fr" => {
                            k.has_fr = true;
                            k.fr = map.next_value()?;
                        }
                        "fg" => k.fg = map.next_value()?,
                        "fb" => k.fb = map.next_value()?,
                        "h" => {
                            k.has_h = true;
                            k.h = map.next_value()?;
                        }
                        "s" => k.s = map.next_value()?,
                        "c" => {
                            k.has_c = true;
                            k.c = map.next_value()?;
                        }
                        "m" => k.m = map.next_value()?,
                        "y" => k.y = map.next_value()?,
                        "k" => {
                            k.has_k = true;
                            k.k = map.next_value()?;
                        }
                        "l" => {
                            k.has_l = true;
                            k.l = map.next_value()?;
                        }
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }

                // Probe order: r → fr → h → c → l → k.
                if k.has_r {
                    let r = k.r.unwrap_or(0.0);
                    let g = k.g.unwrap_or(0.0);
                    let b = k.b.unwrap_or(0.0);
                    return if k.has_a_key {
                        Ok(Color::Rgba(Rgba {
                            r,
                            g,
                            b,
                            a: k.a.unwrap_or(0.0),
                        }))
                    } else {
                        Ok(Color::Rgb(Rgb { r, g, b }))
                    };
                }
                if k.has_fr {
                    return Ok(Color::Frgb(Frgb {
                        fr: k.fr.unwrap_or(0.0),
                        fg: k.fg.unwrap_or(0.0),
                        fb: k.fb.unwrap_or(0.0),
                    }));
                }
                if k.has_h {
                    return Ok(Color::Hsb(Hsb {
                        h: k.h.unwrap_or(0.0),
                        s: k.s.unwrap_or(0.0),
                        b: k.b.unwrap_or(0.0),
                    }));
                }
                if k.has_c {
                    return Ok(Color::Cmyk(Cmyk {
                        c: k.c.unwrap_or(0.0),
                        m: k.m.unwrap_or(0.0),
                        y: k.y.unwrap_or(0.0),
                        k: k.k.unwrap_or(0.0),
                    }));
                }
                if k.has_l {
                    return Ok(Color::Lab(Lab {
                        l: k.l.unwrap_or(0.0),
                        a: k.lab_a.unwrap_or(0.0),
                        b: k.lab_b.unwrap_or(0.0),
                    }));
                }
                if k.has_k {
                    return Ok(Color::Grayscale(Grayscale {
                        k: k.k.unwrap_or(0.0),
                    }));
                }
                Err(M::Error::custom("unrecognized Color object"))
            }
        }

        deserializer.deserialize_map(ColorVisitor)
    }
}

// ===========================================================================
// Units / generic small shapes
// ===========================================================================
/// TS `Units` string-union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Units {
    /// "Pixels"
    #[cfg_attr(feature = "serde", serde(rename = "Pixels"))]
    Pixels,
    /// "Points"
    #[cfg_attr(feature = "serde", serde(rename = "Points"))]
    Points,
    /// "Picas"
    #[cfg_attr(feature = "serde", serde(rename = "Picas"))]
    Picas,
    /// "Millimeters"
    #[cfg_attr(feature = "serde", serde(rename = "Millimeters"))]
    Millimeters,
    /// "Centimeters"
    #[cfg_attr(feature = "serde", serde(rename = "Centimeters"))]
    Centimeters,
    /// "Inches"
    #[cfg_attr(feature = "serde", serde(rename = "Inches"))]
    Inches,
    /// "None"
    #[cfg_attr(feature = "serde", serde(rename = "None"))]
    None,
    /// "Density"
    #[cfg_attr(feature = "serde", serde(rename = "Density"))]
    Density,
}
/// TS `UnitsValue`.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct UnitsValue {
    pub units: Units,
    pub value: f64,
}
/// TS `UnitsBounds`.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct UnitsBounds {
    pub top: UnitsValue,
    pub left: UnitsValue,
    pub right: UnitsValue,
    pub bottom: UnitsValue,
}
/// Generic `{ x: number; y: number; }` point.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PointF {
    pub x: f64,
    pub y: f64,
}
/// Generic `{ x: UnitsValue; y: UnitsValue; }`.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct UnitsPoint {
    pub x: UnitsValue,
    pub y: UnitsValue,
}
/// Generic `{ horizontal: number; vertical: number; }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct HorizontalVertical {
    pub horizontal: f64,
    pub vertical: f64,
}
/// Generic integer rect `{ top; left; bottom; right; }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Bounds {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
}
/// Generic `{ left; top; right; bottom; }` (order as it appears in slices).
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LtrbBounds {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}
/// TS `Fraction`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Fraction {
    pub numerator: f64,
    pub denominator: f64,
}

// ===========================================================================
// String-union helper enums
// ===========================================================================
/// TS `TextGridding = 'none' | 'round'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum TextGridding {
    /// "none"
    #[cfg_attr(feature = "serde", serde(rename = "none"))]
    None,
    /// "round"
    #[cfg_attr(feature = "serde", serde(rename = "round"))]
    Round,
}
/// TS `Orientation = 'horizontal' | 'vertical'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Orientation {
    /// "horizontal"
    #[cfg_attr(feature = "serde", serde(rename = "horizontal"))]
    Horizontal,
    /// "vertical"
    #[cfg_attr(feature = "serde", serde(rename = "vertical"))]
    Vertical,
}
/// TS `AntiAlias`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum AntiAlias {
    /// "none"
    #[cfg_attr(feature = "serde", serde(rename = "none"))]
    None,
    /// "sharp"
    #[cfg_attr(feature = "serde", serde(rename = "sharp"))]
    Sharp,
    /// "crisp"
    #[cfg_attr(feature = "serde", serde(rename = "crisp"))]
    Crisp,
    /// "strong"
    #[cfg_attr(feature = "serde", serde(rename = "strong"))]
    Strong,
    /// "smooth"
    #[cfg_attr(feature = "serde", serde(rename = "smooth"))]
    Smooth,
    /// "platform"
    #[cfg_attr(feature = "serde", serde(rename = "platform"))]
    Platform,
    /// "platformLCD"
    #[cfg_attr(feature = "serde", serde(rename = "platformLCD"))]
    PlatformLcd,
}
/// TS `WarpStyle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum WarpStyle {
    /// "none"
    #[cfg_attr(feature = "serde", serde(rename = "none"))]
    None,
    /// "arc"
    #[cfg_attr(feature = "serde", serde(rename = "arc"))]
    Arc,
    /// "arcLower"
    #[cfg_attr(feature = "serde", serde(rename = "arcLower"))]
    ArcLower,
    /// "arcUpper"
    #[cfg_attr(feature = "serde", serde(rename = "arcUpper"))]
    ArcUpper,
    /// "arch"
    #[cfg_attr(feature = "serde", serde(rename = "arch"))]
    Arch,
    /// "bulge"
    #[cfg_attr(feature = "serde", serde(rename = "bulge"))]
    Bulge,
    /// "shellLower"
    #[cfg_attr(feature = "serde", serde(rename = "shellLower"))]
    ShellLower,
    /// "shellUpper"
    #[cfg_attr(feature = "serde", serde(rename = "shellUpper"))]
    ShellUpper,
    /// "flag"
    #[cfg_attr(feature = "serde", serde(rename = "flag"))]
    Flag,
    /// "wave"
    #[cfg_attr(feature = "serde", serde(rename = "wave"))]
    Wave,
    /// "fish"
    #[cfg_attr(feature = "serde", serde(rename = "fish"))]
    Fish,
    /// "rise"
    #[cfg_attr(feature = "serde", serde(rename = "rise"))]
    Rise,
    /// "fisheye"
    #[cfg_attr(feature = "serde", serde(rename = "fisheye"))]
    Fisheye,
    /// "inflate"
    #[cfg_attr(feature = "serde", serde(rename = "inflate"))]
    Inflate,
    /// "squeeze"
    #[cfg_attr(feature = "serde", serde(rename = "squeeze"))]
    Squeeze,
    /// "twist"
    #[cfg_attr(feature = "serde", serde(rename = "twist"))]
    Twist,
    /// "custom"
    #[cfg_attr(feature = "serde", serde(rename = "custom"))]
    Custom,
    /// "cylinder"
    #[cfg_attr(feature = "serde", serde(rename = "cylinder"))]
    Cylinder,
}
/// TS `BevelStyle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BevelStyle {
    /// "outer bevel"
    #[cfg_attr(feature = "serde", serde(rename = "outer bevel"))]
    OuterBevel,
    /// "inner bevel"
    #[cfg_attr(feature = "serde", serde(rename = "inner bevel"))]
    InnerBevel,
    /// "emboss"
    #[cfg_attr(feature = "serde", serde(rename = "emboss"))]
    Emboss,
    /// "pillow emboss"
    #[cfg_attr(feature = "serde", serde(rename = "pillow emboss"))]
    PillowEmboss,
    /// "stroke emboss"
    #[cfg_attr(feature = "serde", serde(rename = "stroke emboss"))]
    StrokeEmboss,
}
/// TS `BevelTechnique`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BevelTechnique {
    /// "smooth"
    #[cfg_attr(feature = "serde", serde(rename = "smooth"))]
    Smooth,
    /// "chisel hard"
    #[cfg_attr(feature = "serde", serde(rename = "chisel hard"))]
    ChiselHard,
    /// "chisel soft"
    #[cfg_attr(feature = "serde", serde(rename = "chisel soft"))]
    ChiselSoft,
}
/// TS `BevelDirection`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BevelDirection {
    /// "up"
    #[cfg_attr(feature = "serde", serde(rename = "up"))]
    Up,
    /// "down"
    #[cfg_attr(feature = "serde", serde(rename = "down"))]
    Down,
}
/// TS `GlowTechnique`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GlowTechnique {
    /// "softer"
    #[cfg_attr(feature = "serde", serde(rename = "softer"))]
    Softer,
    /// "precise"
    #[cfg_attr(feature = "serde", serde(rename = "precise"))]
    Precise,
}
/// TS `GlowSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GlowSource {
    /// "edge"
    #[cfg_attr(feature = "serde", serde(rename = "edge"))]
    Edge,
    /// "center"
    #[cfg_attr(feature = "serde", serde(rename = "center"))]
    Center,
}
/// TS `GradientStyle`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GradientStyle {
    /// "linear"
    #[cfg_attr(feature = "serde", serde(rename = "linear"))]
    Linear,
    /// "radial"
    #[cfg_attr(feature = "serde", serde(rename = "radial"))]
    Radial,
    /// "angle"
    #[cfg_attr(feature = "serde", serde(rename = "angle"))]
    Angle,
    /// "reflected"
    #[cfg_attr(feature = "serde", serde(rename = "reflected"))]
    Reflected,
    /// "diamond"
    #[cfg_attr(feature = "serde", serde(rename = "diamond"))]
    Diamond,
}
/// TS `Justification`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum Justification {
    /// "left"
    #[cfg_attr(feature = "serde", serde(rename = "left"))]
    Left,
    /// "right"
    #[cfg_attr(feature = "serde", serde(rename = "right"))]
    Right,
    /// "center"
    #[cfg_attr(feature = "serde", serde(rename = "center"))]
    Center,
    /// "justify-left"
    #[cfg_attr(feature = "serde", serde(rename = "justify-left"))]
    JustifyLeft,
    /// "justify-right"
    #[cfg_attr(feature = "serde", serde(rename = "justify-right"))]
    JustifyRight,
    /// "justify-center"
    #[cfg_attr(feature = "serde", serde(rename = "justify-center"))]
    JustifyCenter,
    /// "justify-all"
    #[cfg_attr(feature = "serde", serde(rename = "justify-all"))]
    JustifyAll,
}
/// TS `LineCapType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LineCapType {
    /// "butt"
    #[cfg_attr(feature = "serde", serde(rename = "butt"))]
    Butt,
    /// "round"
    #[cfg_attr(feature = "serde", serde(rename = "round"))]
    Round,
    /// "square"
    #[cfg_attr(feature = "serde", serde(rename = "square"))]
    Square,
}
/// TS `LineJoinType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LineJoinType {
    /// "miter"
    #[cfg_attr(feature = "serde", serde(rename = "miter"))]
    Miter,
    /// "round"
    #[cfg_attr(feature = "serde", serde(rename = "round"))]
    Round,
    /// "bevel"
    #[cfg_attr(feature = "serde", serde(rename = "bevel"))]
    Bevel,
}
/// TS `LineAlignment`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LineAlignment {
    /// "inside"
    #[cfg_attr(feature = "serde", serde(rename = "inside"))]
    Inside,
    /// "center"
    #[cfg_attr(feature = "serde", serde(rename = "center"))]
    Center,
    /// "outside"
    #[cfg_attr(feature = "serde", serde(rename = "outside"))]
    Outside,
}
/// TS `InterpolationMethod`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum InterpolationMethod {
    /// "classic"
    #[cfg_attr(feature = "serde", serde(rename = "classic"))]
    Classic,
    /// "perceptual"
    #[cfg_attr(feature = "serde", serde(rename = "perceptual"))]
    Perceptual,
    /// "linear"
    #[cfg_attr(feature = "serde", serde(rename = "linear"))]
    Linear,
    /// "smooth"
    #[cfg_attr(feature = "serde", serde(rename = "smooth"))]
    Smooth,
}
/// TS `RenderingIntent`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum RenderingIntent {
    /// "perceptual"
    #[cfg_attr(feature = "serde", serde(rename = "perceptual"))]
    Perceptual,
    /// "saturation"
    #[cfg_attr(feature = "serde", serde(rename = "saturation"))]
    Saturation,
    /// "relative colorimetric"
    #[cfg_attr(feature = "serde", serde(rename = "relative colorimetric"))]
    RelativeColorimetric,
    /// "absolute colorimetric"
    #[cfg_attr(feature = "serde", serde(rename = "absolute colorimetric"))]
    AbsoluteColorimetric,
}
/// TS `BooleanOperation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum BooleanOperation {
    /// "exclude"
    #[cfg_attr(feature = "serde", serde(rename = "exclude"))]
    Exclude,
    /// "combine"
    #[cfg_attr(feature = "serde", serde(rename = "combine"))]
    Combine,
    /// "subtract"
    #[cfg_attr(feature = "serde", serde(rename = "subtract"))]
    Subtract,
    /// "intersect"
    #[cfg_attr(feature = "serde", serde(rename = "intersect"))]
    Intersect,
}
/// TS `LayerColor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LayerColor {
    /// "none"
    #[cfg_attr(feature = "serde", serde(rename = "none"))]
    None,
    /// "red"
    #[cfg_attr(feature = "serde", serde(rename = "red"))]
    Red,
    /// "orange"
    #[cfg_attr(feature = "serde", serde(rename = "orange"))]
    Orange,
    /// "yellow"
    #[cfg_attr(feature = "serde", serde(rename = "yellow"))]
    Yellow,
    /// "green"
    #[cfg_attr(feature = "serde", serde(rename = "green"))]
    Green,
    /// "blue"
    #[cfg_attr(feature = "serde", serde(rename = "blue"))]
    Blue,
    /// "violet"
    #[cfg_attr(feature = "serde", serde(rename = "violet"))]
    Violet,
    /// "gray"
    #[cfg_attr(feature = "serde", serde(rename = "gray"))]
    Gray,
}
/// TS `PlacedLayerType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum PlacedLayerType {
    /// "unknown"
    #[cfg_attr(feature = "serde", serde(rename = "unknown"))]
    Unknown,
    /// "vector"
    #[cfg_attr(feature = "serde", serde(rename = "vector"))]
    Vector,
    /// "raster"
    #[cfg_attr(feature = "serde", serde(rename = "raster"))]
    Raster,
    /// "image stack"
    #[cfg_attr(feature = "serde", serde(rename = "image stack"))]
    ImageStack,
}
/// TS `TimelineKeyInterpolation`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum TimelineKeyInterpolation {
    /// "linear"
    #[cfg_attr(feature = "serde", serde(rename = "linear"))]
    Linear,
    /// "hold"
    #[cfg_attr(feature = "serde", serde(rename = "hold"))]
    Hold,
}
/// TS `TimelineTrackType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum TimelineTrackType {
    /// "opacity"
    #[cfg_attr(feature = "serde", serde(rename = "opacity"))]
    Opacity,
    /// "style"
    #[cfg_attr(feature = "serde", serde(rename = "style"))]
    Style,
    /// "sheetTransform"
    #[cfg_attr(feature = "serde", serde(rename = "sheetTransform"))]
    SheetTransform,
    /// "sheetPosition"
    #[cfg_attr(feature = "serde", serde(rename = "sheetPosition"))]
    SheetPosition,
    /// "globalLighting"
    #[cfg_attr(feature = "serde", serde(rename = "globalLighting"))]
    GlobalLighting,
}
/// TS `LayerEffectStroke.position`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum StrokePosition {
    /// "inside"
    #[cfg_attr(feature = "serde", serde(rename = "inside"))]
    Inside,
    /// "center"
    #[cfg_attr(feature = "serde", serde(rename = "center"))]
    Center,
    /// "outside"
    #[cfg_attr(feature = "serde", serde(rename = "outside"))]
    Outside,
}
/// TS `LayerEffectStroke.fillType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum StrokeFillType {
    /// "color"
    #[cfg_attr(feature = "serde", serde(rename = "color"))]
    Color,
    /// "gradient"
    #[cfg_attr(feature = "serde", serde(rename = "gradient"))]
    Gradient,
    /// "pattern"
    #[cfg_attr(feature = "serde", serde(rename = "pattern"))]
    Pattern,
}
/// TS `EffectNoiseGradient.colorModel` and similar `'rgb' | 'hsb' | 'lab'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GradientColorModel {
    /// "rgb"
    #[cfg_attr(feature = "serde", serde(rename = "rgb"))]
    Rgb,
    /// "hsb"
    #[cfg_attr(feature = "serde", serde(rename = "hsb"))]
    Hsb,
    /// "lab"
    #[cfg_attr(feature = "serde", serde(rename = "lab"))]
    Lab,
}
/// TS `BezierPath.fillRule = 'even-odd' | 'non-zero'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum FillRule {
    /// "even-odd"
    #[cfg_attr(feature = "serde", serde(rename = "even-odd"))]
    EvenOdd,
    /// "non-zero"
    #[cfg_attr(feature = "serde", serde(rename = "non-zero"))]
    NonZero,
}

// ===========================================================================
// Effects
// ===========================================================================
/// TS `EffectContour`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct EffectContour {
    pub name: String,
    /// curve points `{ x; y; }[]`
    pub curve: Vec<PointF>,
}
/// TS `EffectPattern` (TODO: add fields upstream).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct EffectPattern {
    pub name: String,
    pub id: String,
}
/// TS `ColorStop`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ColorStop {
    pub color: Color,
    pub location: f64,
    pub midpoint: f64,
}
/// TS `OpacityStop`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct OpacityStop {
    pub opacity: f64,
    pub location: f64,
    pub midpoint: f64,
}
/// TS `EffectSolidGradient` (`type: 'solid'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct EffectSolidGradient {
    pub name: String,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub smoothness: Option<f64>,
    pub color_stops: Vec<ColorStop>,
    pub opacity_stops: Vec<OpacityStop>,
}
/// TS `EffectNoiseGradient` (`type: 'noise'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct EffectNoiseGradient {
    pub name: String,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub roughness: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color_model: Option<GradientColorModel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub random_seed: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub restrict_colors: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub add_transparency: Option<bool>,
    pub min: Vec<f64>,
    pub max: Vec<f64>,
}
/// TS union `EffectSolidGradient | EffectNoiseGradient`.
///
/// JSON is a flat object with discriminator `type: "solid" | "noise"` (not an
/// externally-tagged `{Solid: …}` / `{Noise: …}` enum).
#[derive(Debug, Clone)]
pub enum EffectGradient {
    Solid(EffectSolidGradient),
    Noise(EffectNoiseGradient),
}

#[cfg(feature = "serde")]
impl serde::Serialize for EffectGradient {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            EffectGradient::Solid(g) => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "solid")?;
                map.serialize_entry("name", &g.name)?;
                if let Some(s) = g.smoothness {
                    map.serialize_entry("smoothness", &s)?;
                }
                map.serialize_entry("colorStops", &g.color_stops)?;
                map.serialize_entry("opacityStops", &g.opacity_stops)?;
                map.end()
            }
            EffectGradient::Noise(g) => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "noise")?;
                map.serialize_entry("name", &g.name)?;
                if let Some(v) = g.roughness {
                    map.serialize_entry("roughness", &v)?;
                }
                if let Some(v) = g.color_model {
                    map.serialize_entry("colorModel", &v)?;
                }
                if let Some(v) = g.random_seed {
                    map.serialize_entry("randomSeed", &v)?;
                }
                if let Some(v) = g.restrict_colors {
                    map.serialize_entry("restrictColors", &v)?;
                }
                if let Some(v) = g.add_transparency {
                    map.serialize_entry("addTransparency", &v)?;
                }
                map.serialize_entry("min", &g.min)?;
                map.serialize_entry("max", &g.max)?;
                map.end()
            }
        }
    }
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for EffectGradient {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{MapAccess, Visitor};
        use std::fmt;

        struct GradVisitor;
        impl<'de> Visitor<'de> for GradVisitor {
            type Value = EffectGradient;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("EffectGradient with type solid|noise")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<EffectGradient, M::Error> {
                let mut typ: Option<String> = None;
                let mut name = String::new();
                let mut smoothness: Option<f64> = None;
                let mut color_stops: Option<Vec<ColorStop>> = None;
                let mut opacity_stops: Option<Vec<OpacityStop>> = None;
                let mut roughness: Option<f64> = None;
                let mut color_model: Option<GradientColorModel> = None;
                let mut random_seed: Option<f64> = None;
                let mut restrict_colors: Option<bool> = None;
                let mut add_transparency: Option<bool> = None;
                let mut min: Option<Vec<f64>> = None;
                let mut max: Option<Vec<f64>> = None;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "type" => typ = Some(map.next_value()?),
                        "name" => name = map.next_value()?,
                        "smoothness" => smoothness = Some(map.next_value()?),
                        "colorStops" => color_stops = Some(map.next_value()?),
                        "opacityStops" => opacity_stops = Some(map.next_value()?),
                        "roughness" => roughness = Some(map.next_value()?),
                        "colorModel" => color_model = Some(map.next_value()?),
                        "randomSeed" => random_seed = Some(map.next_value()?),
                        "restrictColors" => restrict_colors = Some(map.next_value()?),
                        "addTransparency" => add_transparency = Some(map.next_value()?),
                        "min" => min = Some(map.next_value()?),
                        "max" => max = Some(map.next_value()?),
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                match typ.as_deref() {
                    Some("noise") => Ok(EffectGradient::Noise(EffectNoiseGradient {
                        name,
                        roughness,
                        color_model,
                        random_seed,
                        restrict_colors,
                        add_transparency,
                        min: min.unwrap_or_default(),
                        max: max.unwrap_or_default(),
                    })),
                    _ => Ok(EffectGradient::Solid(EffectSolidGradient {
                        name,
                        smoothness,
                        color_stops: color_stops.unwrap_or_default(),
                        opacity_stops: opacity_stops.unwrap_or_default(),
                    })),
                }
            }
        }
        deserializer.deserialize_map(GradVisitor)
    }
}
/// TS `ExtraGradientInfo` (intersected with gradient unions in several places).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ExtraGradientInfo {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style: Option<GradientStyle>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub scale: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub angle: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub dither: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub interpolation_method: Option<InterpolationMethod>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reverse: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub align: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub offset: Option<PointF>,
}
/// TS `ExtraPatternInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ExtraPatternInfo {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub linked: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub phase: Option<PointF>,
}
/// TS `(EffectSolidGradient | EffectNoiseGradient) & ExtraGradientInfo`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GradientWithExtra {
    pub gradient: EffectGradient,
    pub extra: ExtraGradientInfo,
}
/// TS `LayerEffectShadow` (drop & inner shadow).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectShadow {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub angle: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub distance: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_global_light: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub antialiased: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub contour: Option<EffectContour>,
    /// spread
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub choke: Option<UnitsValue>,
    /// only drop shadow
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_conceals: Option<bool>,
    /// Upstream `parseEffectObject` sets `noise` from `Nose` on shadows too.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub noise: Option<f64>,
}
/// TS `LayerEffectsOuterGlow` (+ `technique` from generic `parseEffectObject`/`GlwT`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectsOuterGlow {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub source: Option<GlowSource>,
    /// Present in real OrGl descriptors via `GlwT` (generic effect parser).
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub technique: Option<GlowTechnique>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub antialiased: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub noise: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub range: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub choke: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub jitter: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub contour: Option<EffectContour>,
}
/// TS `LayerEffectInnerGlow`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectInnerGlow {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub source: Option<GlowSource>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub technique: Option<GlowTechnique>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub antialiased: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub noise: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub range: Option<f64>,
    /// spread
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub choke: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub jitter: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub contour: Option<EffectContour>,
}
/// TS `LayerEffectBevel`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectBevel {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub angle: Option<f64>,
    /// depth
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub strength: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub highlight_blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub shadow_blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub highlight_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub shadow_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style: Option<BevelStyle>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub highlight_opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub shadow_opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub soften: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_global_light: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub altitude: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub technique: Option<BevelTechnique>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub direction: Option<BevelDirection>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_texture: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_shape: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub antialias_gloss: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub contour: Option<EffectContour>,
}
/// TS `LayerEffectSolidFill`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectSolidFill {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
}
/// TS `LayerEffectStroke`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectStroke {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub overprint: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub position: Option<StrokePosition>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_type: Option<StrokeFillType>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    /// `(EffectSolidGradient | EffectNoiseGradient) & ExtraGradientInfo`
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub gradient: Option<GradientWithExtra>,
    /// `EffectPattern & {}` (TODO: additional pattern info upstream)
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub pattern: Option<EffectPattern>,
}
/// TS `LayerEffectSatin`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectSatin {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub antialiased: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub distance: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub invert: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub angle: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub contour: Option<EffectContour>,
}
/// TS `LayerEffectPatternOverlay` (not supported yet upstream — `Patt` section).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectPatternOverlay {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub scale: Option<f64>,
    /// From `lagl` / `Angl` via generic effect parser (objName `patternOverlay` → `lagl`).
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub angle: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub pattern: Option<EffectPattern>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub phase: Option<PointF>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub align: Option<bool>,
}
/// TS `LayerEffectGradientOverlay`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectGradientOverlay {
    /// Descriptor field order from the source file (ag-psd `Object.keys` parity).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub key_order: Vec<String>,
    /// NOTE: in TS this is `string`, not `BlendMode`.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub present: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show_in_dialog: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub align: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub scale: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub dither: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reverse: Option<bool>,
    /// TS field `type`
    #[cfg_attr(
        feature = "serde",
        serde(rename = "type", default, skip_serializing_if = "Option::is_none")
    )]
    pub gradient_type: Option<GradientStyle>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub offset: Option<PointF>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub gradient: Option<EffectGradient>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub interpolation_method: Option<InterpolationMethod>,
    /// degrees
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub angle: Option<f64>,
}
/// TS `LayerEffectsInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerEffectsInfo {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub disabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub scale: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub drop_shadow: Option<Vec<LayerEffectShadow>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub inner_shadow: Option<Vec<LayerEffectShadow>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub outer_glow: Option<LayerEffectsOuterGlow>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub inner_glow: Option<LayerEffectInnerGlow>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bevel: Option<LayerEffectBevel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub solid_fill: Option<Vec<LayerEffectSolidFill>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub satin: Option<LayerEffectSatin>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub stroke: Option<Vec<LayerEffectStroke>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub gradient_overlay: Option<Vec<LayerEffectGradientOverlay>>,
    /// not supported yet upstream because of `Patt` section
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub pattern_overlay: Option<LayerEffectPatternOverlay>,
}

// ===========================================================================
// Mask data
// ===========================================================================
/// TS `LayerMaskData`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerMaskData {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub top: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub left: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bottom: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub right: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub default_color: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub disabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub position_relative_to_layer: Option<bool>,
    /// true if mask is generated from vector data, false if bitmap from user.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub from_vector_data: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub user_mask_density: Option<f64>,
    /// px
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub user_mask_feather: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vector_mask_density: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vector_mask_feather: Option<f64>,
    /// TS `canvas?: HTMLCanvasElement` -> raw pixels.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub canvas: Option<PixelData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub image_data: Option<PixelData>,
}

// ===========================================================================
// Warp / animations / fonts / text
// ===========================================================================
/// TS `Warp.customEnvelopeWarp`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CustomEnvelopeWarp {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub quilt_slice_x: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub quilt_slice_y: Option<Vec<f64>>,
    /// 16 points top-left to bottom-right, rows first, relative to first point.
    pub mesh_points: Vec<PointF>,
}
/// TS `Warp`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Warp {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style: Option<WarpStyle>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub value: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub values: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub perspective: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub perspective_other: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub rotate: Option<Orientation>,
    /// for custom warps
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bounds: Option<UnitsBounds>,
    /// Descriptor class of `bounds` (`Rctn` vs `classFloatRect`). Not a JSON
    /// key — serde-skipped so goldens stay stable. Writer encode still picks
    /// class via quilt vs non-quilt (existing degradation).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub bounds_class_id: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub u_order: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub v_order: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub deform_num_rows: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub deform_num_cols: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub custom_envelope_warp: Option<CustomEnvelopeWarp>,
}
/// TS `Animations.frames[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AnimationFrameInfo {
    pub id: f64,
    pub delay: f64,
    /// 'auto' | 'none' | 'dispose'
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub dispose: Option<AnimationDispose>,
}
/// TS `Animations.frames[].dispose` string-union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum AnimationDispose {
    /// "auto"
    #[cfg_attr(feature = "serde", serde(rename = "auto"))]
    Auto,
    /// "none"
    #[cfg_attr(feature = "serde", serde(rename = "none"))]
    None,
    /// "dispose"
    #[cfg_attr(feature = "serde", serde(rename = "dispose"))]
    Dispose,
}
/// TS `Animations.animations[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AnimationInfo {
    pub id: f64,
    pub frames: Vec<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub repeats: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub active_frame: Option<f64>,
}
/// TS `Animations`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Animations {
    pub frames: Vec<AnimationFrameInfo>,
    pub animations: Vec<AnimationInfo>,
}
/// TS `Font`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Font {
    pub name: String,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub script: Option<f64>,
    /// TS field `type`
    #[cfg_attr(
        feature = "serde",
        serde(rename = "type", default, skip_serializing_if = "Option::is_none")
    )]
    pub font_type: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub synthetic: Option<f64>,
}
/// TS `ParagraphStyle`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ParagraphStyle {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub justification: Option<Justification>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub first_line_indent: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub start_indent: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub end_indent: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub space_before: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub space_after: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_hyphenate: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub hyphenated_word_size: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub pre_hyphen: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub post_hyphen: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub consecutive_hyphens: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub zone: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub word_spacing: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub letter_spacing: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub glyph_spacing: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_leading: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub leading_type: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub hanging: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub burasagari: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub kinsoku_order: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub every_line_composer: Option<bool>,
}
/// TS `ParagraphStyleRun`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ParagraphStyleRun {
    pub length: f64,
    pub style: ParagraphStyle,
}
/// TS `TextStyle`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextStyle {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub font: Option<Font>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub font_size: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub faux_bold: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub faux_italic: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_leading: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub leading: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub horizontal_scale: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vertical_scale: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub tracking: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_kerning: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub kerning: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub baseline_shift: Option<f64>,
    /// 0 - none, 1 - small caps, 2 - all caps
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub font_caps: Option<f64>,
    /// 0 - normal, 1 - superscript, 2 - subscript
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub font_baseline: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub underline: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub strikethrough: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub ligatures: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub d_ligatures: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub baseline_direction: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub tsume: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style_run_alignment: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub language: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub no_break: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub stroke_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_flag: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub stroke_flag: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_first: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub y_underline: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub outline_width: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub character_direction: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub hindi_numbers: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub kashida: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub diacritic_pos: Option<f64>,
}
/// TS `TextStyleRun`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextStyleRun {
    pub length: f64,
    pub style: TextStyle,
}
/// TS `TextGridInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextGridInfo {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub is_on: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub show: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub size: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub leading: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub leading_fill_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub align_line_height_to_grid_flags: Option<bool>,
}
/// TS `TextPath.bezierCurve`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextPathBezierCurve {
    /// 8 values per bezier curve
    pub control_points: Vec<f64>,
}
/// TS `TextPath.data.BaselineAlignment`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextPathBaselineAlignment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub flag: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub min: Option<f64>,
}
/// Scalar / small-array values carried under numeric EngineData2 pathData keys.
#[derive(Debug, Clone, PartialEq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum TextPathAtom {
    Bool(bool),
    Number(f64),
    Str(String),
    Numbers(Vec<f64>),
}
/// TS `TextPath.data.pathData` (plus undecoded numeric keys from EngineData2).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextPathPathData {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reversed: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub spacing: Option<f64>,
    /// Keys left as digit names by `decode_engine_data2` (`"3"`, `"5"`, `"7"`, …).
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub extra: std::collections::BTreeMap<String, TextPathAtom>,
}
/// TS `TextPath.data`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextPathData {
    /// TS field `type`
    #[cfg_attr(
        feature = "serde",
        serde(rename = "type", default, skip_serializing_if = "Option::is_none")
    )]
    pub path_type: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub orientation: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Vec::is_empty")
    )]
    pub frame_matrix: Vec<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Vec::is_empty")
    )]
    pub text_range: Vec<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub row_gutter: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub column_gutter: Option<f64>,
    /// Upstream JSON keeps PascalCase `BaselineAlignment`.
    #[cfg_attr(
        feature = "serde",
        serde(
            rename = "BaselineAlignment",
            default,
            skip_serializing_if = "Option::is_none"
        )
    )]
    pub baseline_alignment: Option<TextPathBaselineAlignment>,
    pub path_data: TextPathPathData,
}
/// TS `TextPath`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TextPath {
    /// TODO: this is probably not a name (upstream note)
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub name: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bezier_curve: Option<TextPathBezierCurve>,
    pub data: TextPathData,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub uuid: Option<String>,
}
/// TS `LayerTextData.shapeType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum TextShapeType {
    /// "point"
    #[cfg_attr(feature = "serde", serde(rename = "point"))]
    Point,
    /// "box"
    #[cfg_attr(feature = "serde", serde(rename = "box"))]
    Box,
}
/// TS `LayerTextData`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerTextData {
    pub text: String,
    /// 2d transform matrix [xx, xy, yx, yy, tx, ty]
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub transform: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub anti_alias: Option<AntiAlias>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub gridding: Option<TextGridding>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub orientation: Option<Orientation>,
    /// index of Editor in extra editor data related to this layer
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub index: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub warp: Option<Warp>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub top: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub left: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bottom: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub right: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub grid_info: Option<TextGridInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_fractional_glyph_widths: Option<bool>,
    /// base style
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style: Option<TextStyle>,
    /// spans of different style
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style_runs: Option<Vec<TextStyleRun>>,
    /// base paragraph style
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub paragraph_style: Option<ParagraphStyle>,
    /// style for each line
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub paragraph_style_runs: Option<Vec<ParagraphStyleRun>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub superscript_size: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub superscript_position: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub subscript_size: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub subscript_position: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub small_cap_size: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub shape_type: Option<TextShapeType>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub point_base: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub box_bounds: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bounds: Option<UnitsBounds>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bounding_box: Option<UnitsBounds>,
    /// This is a read-only field; any changes will not be saved.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub text_path: Option<TextPath>,
}

// ===========================================================================
// Patterns / paths / vector content
// ===========================================================================
/// TS `PatternInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PatternInfo {
    pub name: String,
    pub id: String,
    pub x: f64,
    pub y: f64,
    /// `{ x; y; w; h; }`
    pub bounds: PatternBounds,
    pub data: Vec<u8>,
}
/// TS `PatternInfo.bounds` shape `{ x; y; w; h; }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PatternBounds {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
/// TS `BezierKnot`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BezierKnot {
    pub linked: bool,
    /// x0, y0, x1, y1, x2, y2
    pub points: Vec<f64>,
}
/// TS `BezierPath`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BezierPath {
    pub open: bool,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub operation: Option<BooleanOperation>,
    pub knots: Vec<BezierKnot>,
    pub fill_rule: FillRule,
}
/// TS `VectorContent` union.
///
/// JSON uses a flat `{ type: "color", color: … }` shape (not externally tagged).
#[derive(Debug, Clone)]
pub enum VectorContent {
    /// `{ type: 'color'; color: Color; }`
    Color(Color),
    /// `EffectSolidGradient & ExtraGradientInfo`
    SolidGradient {
        gradient: EffectSolidGradient,
        extra: ExtraGradientInfo,
    },
    /// `EffectNoiseGradient & ExtraGradientInfo`
    NoiseGradient {
        gradient: EffectNoiseGradient,
        extra: ExtraGradientInfo,
    },
    /// `EffectPattern & { type: 'pattern'; } & ExtraPatternInfo`
    Pattern {
        pattern: EffectPattern,
        extra: ExtraPatternInfo,
    },
}

#[cfg(feature = "serde")]
impl serde::Serialize for VectorContent {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            VectorContent::Color(c) => {
                let mut map = serializer.serialize_map(Some(2))?;
                map.serialize_entry("type", "color")?;
                map.serialize_entry("color", c)?;
                map.end()
            }
            VectorContent::SolidGradient { gradient, extra } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "solid")?;
                map.serialize_entry("name", &gradient.name)?;
                if let Some(s) = gradient.smoothness {
                    map.serialize_entry("smoothness", &s)?;
                }
                map.serialize_entry("colorStops", &gradient.color_stops)?;
                map.serialize_entry("opacityStops", &gradient.opacity_stops)?;
                // Flatten ExtraGradientInfo fields when present.
                if let Some(v) = &extra.style {
                    map.serialize_entry("style", v)?;
                }
                if let Some(v) = extra.scale {
                    map.serialize_entry("scale", &v)?;
                }
                if let Some(v) = extra.angle {
                    map.serialize_entry("angle", &v)?;
                }
                if let Some(v) = extra.dither {
                    map.serialize_entry("dither", &v)?;
                }
                if let Some(v) = &extra.interpolation_method {
                    map.serialize_entry("interpolationMethod", v)?;
                }
                if let Some(v) = extra.reverse {
                    map.serialize_entry("reverse", &v)?;
                }
                if let Some(v) = extra.align {
                    map.serialize_entry("align", &v)?;
                }
                if let Some(v) = &extra.offset {
                    map.serialize_entry("offset", v)?;
                }
                map.end()
            }
            VectorContent::NoiseGradient { gradient, extra } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "noise")?;
                map.serialize_entry("name", &gradient.name)?;
                if let Some(v) = gradient.roughness {
                    map.serialize_entry("roughness", &v)?;
                }
                if let Some(v) = gradient.color_model {
                    map.serialize_entry("colorModel", &v)?;
                }
                if let Some(v) = gradient.random_seed {
                    map.serialize_entry("randomSeed", &v)?;
                }
                if let Some(v) = gradient.restrict_colors {
                    map.serialize_entry("restrictColors", &v)?;
                }
                if let Some(v) = gradient.add_transparency {
                    map.serialize_entry("addTransparency", &v)?;
                }
                map.serialize_entry("min", &gradient.min)?;
                map.serialize_entry("max", &gradient.max)?;
                if let Some(v) = &extra.style {
                    map.serialize_entry("style", v)?;
                }
                if let Some(v) = extra.scale {
                    map.serialize_entry("scale", &v)?;
                }
                if let Some(v) = extra.angle {
                    map.serialize_entry("angle", &v)?;
                }
                if let Some(v) = extra.dither {
                    map.serialize_entry("dither", &v)?;
                }
                if let Some(v) = &extra.interpolation_method {
                    map.serialize_entry("interpolationMethod", v)?;
                }
                if let Some(v) = extra.reverse {
                    map.serialize_entry("reverse", &v)?;
                }
                if let Some(v) = extra.align {
                    map.serialize_entry("align", &v)?;
                }
                if let Some(v) = &extra.offset {
                    map.serialize_entry("offset", v)?;
                }
                map.end()
            }
            VectorContent::Pattern { pattern, extra } => {
                let mut map = serializer.serialize_map(None)?;
                map.serialize_entry("type", "pattern")?;
                map.serialize_entry("pattern", pattern)?;
                if let Some(v) = extra.linked {
                    map.serialize_entry("linked", &v)?;
                }
                if let Some(v) = &extra.phase {
                    map.serialize_entry("phase", v)?;
                }
                map.end()
            }
        }
    }
}

#[cfg(feature = "serde")]
impl<'de> serde::Deserialize<'de> for VectorContent {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        use serde::de::{Error, MapAccess, Visitor};
        use std::fmt;

        struct VcVisitor;
        impl<'de> Visitor<'de> for VcVisitor {
            type Value = VectorContent;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("VectorContent object with type discriminator")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<VectorContent, M::Error> {
                let mut typ: Option<String> = None;
                let mut color: Option<Color> = None;
                // Collect remaining into a serde_json-less buffer via ignored + re-parse
                // is awkward without Value; only color is required by the goldens.
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "type" => typ = Some(map.next_value()?),
                        "color" => color = Some(map.next_value()?),
                        _ => {
                            let _: serde::de::IgnoredAny = map.next_value()?;
                        }
                    }
                }
                match typ.as_deref() {
                    Some("color") | None => {
                        Ok(VectorContent::Color(color.ok_or_else(|| {
                            M::Error::custom("VectorContent.color missing")
                        })?))
                    }
                    other => Err(M::Error::custom(format!(
                        "unsupported VectorContent type {other:?} in deserialize"
                    ))),
                }
            }
        }
        deserializer.deserialize_map(VcVisitor)
    }
}

// ===========================================================================
// Adjustments
// ===========================================================================
/// TS `PresetInfo` (mixed into several adjustments).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PresetInfo {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub preset_kind: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub preset_file_name: Option<String>,
}
/// TS `BrightnessAdjustment` (`type: 'brightness/contrast'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BrightnessAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub brightness: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub contrast: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub mean_value: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_legacy: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub lab_color_only: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto: Option<bool>,
}
/// TS `LevelsAdjustmentChannel`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LevelsAdjustmentChannel {
    pub shadow_input: f64,
    pub highlight_input: f64,
    pub shadow_output: f64,
    pub highlight_output: f64,
    pub midtone_input: f64,
}
/// TS `LevelsAdjustment extends PresetInfo` (`type: 'levels'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LevelsAdjustment {
    pub preset: PresetInfo,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub rgb: Option<LevelsAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub red: Option<LevelsAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub green: Option<LevelsAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blue: Option<LevelsAdjustmentChannel>,
}

/// TS `CurvesAdjustmentChannel = { input; output; }[]`.
pub type CurvesAdjustmentChannel = Vec<CurvesPoint>;
/// Element of `CurvesAdjustmentChannel`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CurvesPoint {
    pub input: f64,
    pub output: f64,
}
/// TS `CurvesAdjustment extends PresetInfo` (`type: 'curves'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CurvesAdjustment {
    pub preset: PresetInfo,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub rgb: Option<CurvesAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub red: Option<CurvesAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub green: Option<CurvesAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blue: Option<CurvesAdjustmentChannel>,
}
/// TS `ExposureAdjustment extends PresetInfo` (`type: 'exposure'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ExposureAdjustment {
    pub preset: PresetInfo,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub exposure: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub offset: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub gamma: Option<f64>,
}
/// TS `VibranceAdjustment` (`type: 'vibrance'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VibranceAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vibrance: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub saturation: Option<f64>,
}
/// TS `HueSaturationAdjustmentChannel`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct HueSaturationAdjustmentChannel {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub hue: f64,
    pub saturation: f64,
    pub lightness: f64,
}
/// TS `HueSaturationAdjustment extends PresetInfo` (`type: 'hue/saturation'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct HueSaturationAdjustment {
    pub preset: PresetInfo,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub master: Option<HueSaturationAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reds: Option<HueSaturationAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub yellows: Option<HueSaturationAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub greens: Option<HueSaturationAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub cyans: Option<HueSaturationAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blues: Option<HueSaturationAdjustmentChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub magentas: Option<HueSaturationAdjustmentChannel>,
}
/// TS `ColorBalanceValues`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ColorBalanceValues {
    pub cyan_red: f64,
    pub magenta_green: f64,
    pub yellow_blue: f64,
}
/// TS `ColorBalanceAdjustment` (`type: 'color balance'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ColorBalanceAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub shadows: Option<ColorBalanceValues>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub midtones: Option<ColorBalanceValues>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub highlights: Option<ColorBalanceValues>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub preserve_luminosity: Option<bool>,
}
/// TS `BlackAndWhiteAdjustment extends PresetInfo` (`type: 'black & white'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BlackAndWhiteAdjustment {
    pub preset: PresetInfo,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reds: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub yellows: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub greens: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub cyans: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blues: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub magentas: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_tint: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub tint_color: Option<Color>,
}
/// TS `PhotoFilterAdjustment` (`type: 'photo filter'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PhotoFilterAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub density: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub preserve_luminosity: Option<bool>,
}
/// TS `ChannelMixerChannel`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ChannelMixerChannel {
    pub red: f64,
    pub green: f64,
    pub blue: f64,
    pub constant: f64,
}
/// TS `ChannelMixerAdjustment extends PresetInfo` (`type: 'channel mixer'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ChannelMixerAdjustment {
    pub preset: PresetInfo,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub monochrome: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub red: Option<ChannelMixerChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub green: Option<ChannelMixerChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blue: Option<ChannelMixerChannel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub gray: Option<ChannelMixerChannel>,
}
/// TS `ColorLookupAdjustment.lookupType`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ColorLookupType {
    /// "3dlut"
    #[cfg_attr(feature = "serde", serde(rename = "3dlut"))]
    Lut3D,
    /// "abstractProfile"
    #[cfg_attr(feature = "serde", serde(rename = "abstractProfile"))]
    AbstractProfile,
    /// "deviceLinkProfile"
    #[cfg_attr(feature = "serde", serde(rename = "deviceLinkProfile"))]
    DeviceLinkProfile,
}
/// TS `ColorLookupAdjustment.lutFormat`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LutFormat {
    /// "look"
    #[cfg_attr(feature = "serde", serde(rename = "look"))]
    Look,
    /// "cube"
    #[cfg_attr(feature = "serde", serde(rename = "cube"))]
    Cube,
    /// "3dl"
    #[cfg_attr(feature = "serde", serde(rename = "3dl"))]
    ThreeDl,
}
/// TS `'rgb' | 'bgr'` (data/table order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum RgbBgrOrder {
    /// "rgb"
    #[cfg_attr(feature = "serde", serde(rename = "rgb"))]
    Rgb,
    /// "bgr"
    #[cfg_attr(feature = "serde", serde(rename = "bgr"))]
    Bgr,
}
/// TS `ColorLookupAdjustment` (`type: 'color lookup'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ColorLookupAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub lookup_type: Option<ColorLookupType>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub name: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub dither: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub profile: Option<Vec<u8>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub lut_format: Option<LutFormat>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub data_order: Option<RgbBgrOrder>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub table_order: Option<RgbBgrOrder>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub lut3d_file_data: Option<Vec<u8>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub lut3d_file_name: Option<String>,
}
/// TS `InvertAdjustment` (`type: 'invert'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct InvertAdjustment;

/// TS `PosterizeAdjustment` (`type: 'posterize'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PosterizeAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub levels: Option<f64>,
}
/// TS `ThresholdAdjustment` (`type: 'threshold'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ThresholdAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub level: Option<f64>,
}
/// TS `GradientMapAdjustment.gradientType = 'solid' | 'noise'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GradientMapType {
    /// "solid"
    #[cfg_attr(feature = "serde", serde(rename = "solid"))]
    Solid,
    /// "noise"
    #[cfg_attr(feature = "serde", serde(rename = "noise"))]
    Noise,
}
/// TS `GradientMapAdjustment` (`type: 'gradient map'`).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GradientMapAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub name: Option<String>,
    pub gradient_type: GradientMapType,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub dither: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reverse: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub method: Option<InterpolationMethod>,
    // solid
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub smoothness: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color_stops: Option<Vec<ColorStop>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity_stops: Option<Vec<OpacityStop>>,
    // noise
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub roughness: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color_model: Option<GradientColorModel>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub random_seed: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub restrict_colors: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub add_transparency: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub min: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max: Option<Vec<f64>>,
}
/// TS `SelectiveColorAdjustment.mode = 'relative' | 'absolute'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SelectiveColorMode {
    /// "relative"
    #[cfg_attr(feature = "serde", serde(rename = "relative"))]
    Relative,
    /// "absolute"
    #[cfg_attr(feature = "serde", serde(rename = "absolute"))]
    Absolute,
}
/// TS `SelectiveColorAdjustment` (`type: 'selective color'`).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SelectiveColorAdjustment {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub mode: Option<SelectiveColorMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reds: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub yellows: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub greens: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub cyans: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blues: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub magentas: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub whites: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub neutrals: Option<Cmyk>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blacks: Option<Cmyk>,
}
/// TS `AdjustmentLayer` union (the `type` tag is encoded by the variant).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum AdjustmentLayer {
    /// "brightness/contrast"
    #[cfg_attr(feature = "serde", serde(rename = "brightness/contrast"))]
    Brightness(BrightnessAdjustment),
    /// "levels"
    #[cfg_attr(feature = "serde", serde(rename = "levels"))]
    Levels(LevelsAdjustment),
    /// "curves"
    #[cfg_attr(feature = "serde", serde(rename = "curves"))]
    Curves(CurvesAdjustment),
    /// "exposure"
    #[cfg_attr(feature = "serde", serde(rename = "exposure"))]
    Exposure(ExposureAdjustment),
    /// "vibrance"
    #[cfg_attr(feature = "serde", serde(rename = "vibrance"))]
    Vibrance(VibranceAdjustment),
    /// "hue/saturation"
    #[cfg_attr(feature = "serde", serde(rename = "hue/saturation"))]
    HueSaturation(HueSaturationAdjustment),
    /// "color balance"
    #[cfg_attr(feature = "serde", serde(rename = "color balance"))]
    ColorBalance(ColorBalanceAdjustment),
    /// "black & white"
    #[cfg_attr(feature = "serde", serde(rename = "black & white"))]
    BlackAndWhite(BlackAndWhiteAdjustment),
    /// "photo filter"
    #[cfg_attr(feature = "serde", serde(rename = "photo filter"))]
    PhotoFilter(PhotoFilterAdjustment),
    /// "channel mixer"
    #[cfg_attr(feature = "serde", serde(rename = "channel mixer"))]
    ChannelMixer(ChannelMixerAdjustment),
    /// "color lookup"
    #[cfg_attr(feature = "serde", serde(rename = "color lookup"))]
    ColorLookup(ColorLookupAdjustment),
    /// "invert"
    #[cfg_attr(feature = "serde", serde(rename = "invert"))]
    Invert(InvertAdjustment),
    /// "posterize"
    #[cfg_attr(feature = "serde", serde(rename = "posterize"))]
    Posterize(PosterizeAdjustment),
    /// "threshold"
    #[cfg_attr(feature = "serde", serde(rename = "threshold"))]
    Threshold(ThresholdAdjustment),
    /// "gradient map"
    #[cfg_attr(feature = "serde", serde(rename = "gradient map"))]
    GradientMap(GradientMapAdjustment),
    /// "selective color"
    #[cfg_attr(feature = "serde", serde(rename = "selective color"))]
    SelectiveColor(SelectiveColorAdjustment),
}

// ===========================================================================
// Linked files
// ===========================================================================
/// TS `LinkedFile.descriptor.compInfo` and `PlacedLayer.compInfo`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CompInfo {
    #[cfg_attr(feature = "serde", serde(rename = "compID"))]
    pub comp_id: f64,
    #[cfg_attr(feature = "serde", serde(rename = "originalCompID"))]
    pub original_comp_id: f64,
}
/// TS `LinkedFile.descriptor`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LinkedFileDescriptor {
    pub comp_info: CompInfo,
}
/// TS `LinkedFile.linkedFile` (external files).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ExternalLinkedFile {
    pub file_size: f64,
    pub name: String,
    pub full_path: String,
    pub original_path: String,
    pub relative_path: String,
}
/// TS `LinkedFile`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LinkedFile {
    /// GUID format, e.g. 20953ddb-9391-11ec-b4f1-c15674f50bc4
    pub id: String,
    pub name: String,
    /// TS field `type`
    #[cfg_attr(
        feature = "serde",
        serde(rename = "type", default, skip_serializing_if = "Option::is_none")
    )]
    pub file_type: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub creator: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub data: Option<Vec<u8>>,
    /// for external files
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub time: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub descriptor: Option<LinkedFileDescriptor>,
    #[cfg_attr(
        feature = "serde",
        serde(
            rename = "childDocumentID",
            default,
            skip_serializing_if = "Option::is_none"
        )
    )]
    pub child_document_id: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub asset_mod_time: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub asset_locked_state: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub linked_file: Option<ExternalLinkedFile>,
}

// ===========================================================================
// Smart filters (FilterVariant + Filter)
// ===========================================================================
/// Generic `{ radius: UnitsValue }` filter parameter set.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct RadiusFilter {
    pub radius: UnitsValue,
}
/// TS `FilterVariant` union. Each variant carries the TS `type` tag and its
/// `filter` payload (where present). The exact string tags are in doc-comments.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(
    feature = "serde",
    serde(tag = "type", content = "filter", rename_all = "camelCase")
)]
pub enum FilterVariant {
    /// "average"
    #[cfg_attr(feature = "serde", serde(rename = "average"))]
    Average,
    /// "blur"
    #[cfg_attr(feature = "serde", serde(rename = "blur"))]
    Blur,
    /// "blur more"
    #[cfg_attr(feature = "serde", serde(rename = "blur more"))]
    BlurMore,
    /// "box blur"
    #[cfg_attr(feature = "serde", serde(rename = "box blur"))]
    BoxBlur(RadiusFilter),
    /// "gaussian blur"
    #[cfg_attr(feature = "serde", serde(rename = "gaussian blur"))]
    GaussianBlur(RadiusFilter),
    /// "motion blur"
    #[cfg_attr(feature = "serde", serde(rename = "motion blur"))]
    MotionBlur {
        /// in degrees
        angle: f64,
        distance: UnitsValue,
    },
    /// "radial blur"
    #[cfg_attr(feature = "serde", serde(rename = "radial blur"))]
    RadialBlur {
        amount: f64,
        method: RadialBlurMethod,
        quality: RadialBlurQuality,
    },
    /// "shape blur"
    #[cfg_attr(feature = "serde", serde(rename = "shape blur"))]
    ShapeBlur {
        radius: UnitsValue,
        #[cfg_attr(feature = "serde", serde(rename = "customShape"))]
        custom_shape: NamedId,
    },
    /// "smart blur"
    #[cfg_attr(feature = "serde", serde(rename = "smart blur"))]
    SmartBlur {
        radius: f64,
        threshold: f64,
        quality: LowMediumHigh,
        mode: SmartBlurMode,
    },
    /// "surface blur"
    #[cfg_attr(feature = "serde", serde(rename = "surface blur"))]
    SurfaceBlur { radius: UnitsValue, threshold: f64 },
    /// "displace"
    #[cfg_attr(feature = "serde", serde(rename = "displace"))]
    Displace {
        #[cfg_attr(feature = "serde", serde(rename = "horizontalScale"))]
        horizontal_scale: f64,
        #[cfg_attr(feature = "serde", serde(rename = "verticalScale"))]
        vertical_scale: f64,
        #[cfg_attr(feature = "serde", serde(rename = "displacementMap"))]
        displacement_map: DisplacementMap,
        #[cfg_attr(feature = "serde", serde(rename = "undefinedAreas"))]
        undefined_areas: WrapOrRepeat,
        #[cfg_attr(feature = "serde", serde(rename = "displacementFile"))]
        displacement_file: DisplacementFile,
    },
    /// "pinch"
    #[cfg_attr(feature = "serde", serde(rename = "pinch"))]
    Pinch { amount: f64 },
    /// "polar coordinates"
    #[cfg_attr(feature = "serde", serde(rename = "polar coordinates"))]
    PolarCoordinates { conversion: PolarConversion },
    /// "ripple"
    #[cfg_attr(feature = "serde", serde(rename = "ripple"))]
    Ripple { amount: f64, size: SmallMediumLarge },
    /// "shear"
    #[cfg_attr(feature = "serde", serde(rename = "shear"))]
    Shear {
        #[cfg_attr(feature = "serde", serde(rename = "shearPoints"))]
        shear_points: Vec<PointF>,
        #[cfg_attr(feature = "serde", serde(rename = "shearStart"))]
        shear_start: f64,
        #[cfg_attr(feature = "serde", serde(rename = "shearEnd"))]
        shear_end: f64,
        #[cfg_attr(feature = "serde", serde(rename = "undefinedAreas"))]
        undefined_areas: WrapOrRepeat,
    },
    /// "spherize"
    #[cfg_attr(feature = "serde", serde(rename = "spherize"))]
    Spherize { amount: f64, mode: SpherizeMode },
    /// "twirl"
    #[cfg_attr(feature = "serde", serde(rename = "twirl"))]
    Twirl {
        /// degrees
        angle: f64,
    },
    /// "wave"
    #[cfg_attr(feature = "serde", serde(rename = "wave"))]
    Wave {
        #[cfg_attr(feature = "serde", serde(rename = "numberOfGenerators"))]
        number_of_generators: f64,
        /// TS field `type`
        #[cfg_attr(feature = "serde", serde(rename = "type"))]
        wave_type: WaveType,
        wavelength: MinMax,
        amplitude: MinMax,
        scale: PointF,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
        #[cfg_attr(feature = "serde", serde(rename = "undefinedAreas"))]
        undefined_areas: WrapOrRepeat,
    },
    /// "zigzag"
    #[cfg_attr(feature = "serde", serde(rename = "zigzag"))]
    ZigZag {
        amount: f64,
        ridges: f64,
        style: ZigZagStyle,
    },
    /// "add noise"
    #[cfg_attr(feature = "serde", serde(rename = "add noise"))]
    AddNoise {
        /// 0..1
        amount: f64,
        distribution: NoiseDistribution,
        monochromatic: bool,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "despeckle"
    #[cfg_attr(feature = "serde", serde(rename = "despeckle"))]
    Despeckle,
    /// "dust and scratches"
    #[cfg_attr(feature = "serde", serde(rename = "dust and scratches"))]
    DustAndScratches {
        /// pixels
        radius: f64,
        /// levels
        threshold: f64,
    },
    /// "median"
    #[cfg_attr(feature = "serde", serde(rename = "median"))]
    Median(RadiusFilter),
    /// "reduce noise"
    #[cfg_attr(feature = "serde", serde(rename = "reduce noise"))]
    ReduceNoise {
        preset: String,
        #[cfg_attr(feature = "serde", serde(rename = "removeJpegArtifact"))]
        remove_jpeg_artifact: bool,
        /// 0..1
        #[cfg_attr(feature = "serde", serde(rename = "reduceColorNoise"))]
        reduce_color_noise: f64,
        /// 0..1
        #[cfg_attr(feature = "serde", serde(rename = "sharpenDetails"))]
        sharpen_details: f64,
        #[cfg_attr(feature = "serde", serde(rename = "channelDenoise"))]
        channel_denoise: Vec<ChannelDenoise>,
    },
    /// "color halftone"
    #[cfg_attr(feature = "serde", serde(rename = "color halftone"))]
    ColorHalftone {
        /// pixels
        radius: f64,
        /// degrees
        angle1: f64,
        angle2: f64,
        angle3: f64,
        angle4: f64,
    },
    /// "crystallize"
    #[cfg_attr(feature = "serde", serde(rename = "crystallize"))]
    Crystallize {
        #[cfg_attr(feature = "serde", serde(rename = "cellSize"))]
        cell_size: f64,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "facet"
    #[cfg_attr(feature = "serde", serde(rename = "facet"))]
    Facet,
    /// "fragment"
    #[cfg_attr(feature = "serde", serde(rename = "fragment"))]
    Fragment,
    /// "mezzotint"
    #[cfg_attr(feature = "serde", serde(rename = "mezzotint"))]
    Mezzotint {
        /// TS field `type`
        #[cfg_attr(feature = "serde", serde(rename = "type"))]
        mezzotint_type: MezzotintType,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "mosaic"
    #[cfg_attr(feature = "serde", serde(rename = "mosaic"))]
    Mosaic {
        #[cfg_attr(feature = "serde", serde(rename = "cellSize"))]
        cell_size: UnitsValue,
    },
    /// "pointillize"
    #[cfg_attr(feature = "serde", serde(rename = "pointillize"))]
    Pointillize {
        #[cfg_attr(feature = "serde", serde(rename = "cellSize"))]
        cell_size: f64,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "clouds"
    #[cfg_attr(feature = "serde", serde(rename = "clouds"))]
    Clouds {
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "difference clouds"
    #[cfg_attr(feature = "serde", serde(rename = "difference clouds"))]
    DifferenceClouds {
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "fibers"
    #[cfg_attr(feature = "serde", serde(rename = "fibers"))]
    Fibers {
        variance: f64,
        strength: f64,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "lens flare"
    #[cfg_attr(feature = "serde", serde(rename = "lens flare"))]
    LensFlare {
        /// percent
        brightness: f64,
        position: PointF,
        #[cfg_attr(feature = "serde", serde(rename = "lensType"))]
        lens_type: LensType,
    },
    /// "sharpen"
    #[cfg_attr(feature = "serde", serde(rename = "sharpen"))]
    Sharpen,
    /// "sharpen edges"
    #[cfg_attr(feature = "serde", serde(rename = "sharpen edges"))]
    SharpenEdges,
    /// "sharpen more"
    #[cfg_attr(feature = "serde", serde(rename = "sharpen more"))]
    SharpenMore,
    /// "smart sharpen"
    #[cfg_attr(feature = "serde", serde(rename = "smart sharpen"))]
    SmartSharpen {
        /// 0..1
        amount: f64,
        radius: UnitsValue,
        threshold: f64,
        /// degrees
        angle: f64,
        #[cfg_attr(feature = "serde", serde(rename = "moreAccurate"))]
        more_accurate: bool,
        blur: SmartSharpenBlur,
        preset: String,
        shadow: SmartSharpenTone,
        highlight: SmartSharpenTone,
    },
    /// "unsharp mask"
    #[cfg_attr(feature = "serde", serde(rename = "unsharp mask"))]
    UnsharpMask {
        /// 0..1
        amount: f64,
        radius: UnitsValue,
        /// levels
        threshold: f64,
    },
    /// "diffuse"
    #[cfg_attr(feature = "serde", serde(rename = "diffuse"))]
    Diffuse {
        mode: DiffuseMode,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "emboss"
    #[cfg_attr(feature = "serde", serde(rename = "emboss"))]
    Emboss {
        /// degrees
        angle: f64,
        /// pixels
        height: f64,
        /// percent
        amount: f64,
    },
    /// "extrude"
    #[cfg_attr(feature = "serde", serde(rename = "extrude"))]
    Extrude {
        /// TS field `type`
        #[cfg_attr(feature = "serde", serde(rename = "type"))]
        extrude_type: ExtrudeType,
        /// pixels
        size: f64,
        depth: f64,
        #[cfg_attr(feature = "serde", serde(rename = "depthMode"))]
        depth_mode: ExtrudeDepthMode,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
        #[cfg_attr(feature = "serde", serde(rename = "solidFrontFaces"))]
        solid_front_faces: bool,
        #[cfg_attr(feature = "serde", serde(rename = "maskIncompleteBlocks"))]
        mask_incomplete_blocks: bool,
    },
    /// "find edges"
    #[cfg_attr(feature = "serde", serde(rename = "find edges"))]
    FindEdges,
    /// "solarize"
    #[cfg_attr(feature = "serde", serde(rename = "solarize"))]
    Solarize,
    /// "tiles"
    #[cfg_attr(feature = "serde", serde(rename = "tiles"))]
    Tiles {
        #[cfg_attr(feature = "serde", serde(rename = "numberOfTiles"))]
        number_of_tiles: f64,
        /// percent
        #[cfg_attr(feature = "serde", serde(rename = "maximumOffset"))]
        maximum_offset: f64,
        #[cfg_attr(feature = "serde", serde(rename = "fillEmptyAreaWith"))]
        fill_empty_area_with: TilesFill,
        #[cfg_attr(feature = "serde", serde(rename = "randomSeed"))]
        random_seed: f64,
    },
    /// "trace contour"
    #[cfg_attr(feature = "serde", serde(rename = "trace contour"))]
    TraceContour { level: f64, edge: LowerUpper },
    /// "wind"
    #[cfg_attr(feature = "serde", serde(rename = "wind"))]
    Wind {
        method: WindMethod,
        direction: LeftRight,
    },
    /// "de-interlace"
    #[cfg_attr(feature = "serde", serde(rename = "de-interlace"))]
    DeInterlace {
        eliminate: DeInterlaceEliminate,
        #[cfg_attr(feature = "serde", serde(rename = "newFieldsBy"))]
        new_fields_by: DeInterlaceNewFields,
    },
    /// "ntsc colors"
    #[cfg_attr(feature = "serde", serde(rename = "ntsc colors"))]
    NtscColors,
    /// "custom"
    #[cfg_attr(feature = "serde", serde(rename = "custom"))]
    Custom {
        scale: f64,
        offset: f64,
        matrix: Vec<f64>,
    },
    /// "high pass"
    #[cfg_attr(feature = "serde", serde(rename = "high pass"))]
    HighPass(RadiusFilter),
    /// "maximum"
    #[cfg_attr(feature = "serde", serde(rename = "maximum"))]
    Maximum(RadiusFilter),
    /// "minimum"
    #[cfg_attr(feature = "serde", serde(rename = "minimum"))]
    Minimum(RadiusFilter),
    /// "offset"
    #[cfg_attr(feature = "serde", serde(rename = "offset"))]
    Offset {
        /// pixels
        horizontal: f64,
        /// pixels
        vertical: f64,
        #[cfg_attr(feature = "serde", serde(rename = "undefinedAreas"))]
        undefined_areas: OffsetUndefinedAreas,
    },
    /// "puppet"
    #[cfg_attr(feature = "serde", serde(rename = "puppet"))]
    Puppet {
        #[cfg_attr(feature = "serde", serde(rename = "rigidType"))]
        rigid_type: bool,
        bounds: Vec<PointF>,
        #[cfg_attr(feature = "serde", serde(rename = "puppetShapeList"))]
        puppet_shape_list: Vec<PuppetShape>,
    },
    /// "oil paint plugin"
    #[cfg_attr(feature = "serde", serde(rename = "oil paint plugin"))]
    OilPaintPlugin {
        name: String,
        gpu: bool,
        lighting: bool,
        parameters: Vec<NamedValue>,
    },
    /// "hsb/hsl"
    #[cfg_attr(feature = "serde", serde(rename = "hsb/hsl"))]
    HsbHsl {
        #[cfg_attr(feature = "serde", serde(rename = "inputMode"))]
        input_mode: RgbHsbHsl,
        #[cfg_attr(feature = "serde", serde(rename = "rowOrder"))]
        row_order: RgbHsbHsl,
    },
    /// "oil paint"
    #[cfg_attr(feature = "serde", serde(rename = "oil paint"))]
    OilPaint {
        #[cfg_attr(feature = "serde", serde(rename = "lightingOn"))]
        lighting_on: bool,
        stylization: f64,
        cleanliness: f64,
        #[cfg_attr(feature = "serde", serde(rename = "brushScale"))]
        brush_scale: f64,
        #[cfg_attr(feature = "serde", serde(rename = "microBrush"))]
        micro_brush: f64,
        /// degrees
        #[cfg_attr(feature = "serde", serde(rename = "lightDirection"))]
        light_direction: f64,
        specularity: f64,
    },
    /// "liquify"
    #[cfg_attr(feature = "serde", serde(rename = "liquify"))]
    Liquify {
        #[cfg_attr(feature = "serde", serde(rename = "liquifyMesh"))]
        liquify_mesh: Vec<u8>,
    },
    /// "perspective warp"
    #[cfg_attr(feature = "serde", serde(rename = "perspective warp"))]
    PerspectiveWarp {
        /// quad indices
        quads: Vec<Vec<f64>>,
        vertices: Vec<UnitsPoint>,
        #[cfg_attr(feature = "serde", serde(rename = "warpedVertices"))]
        warped_vertices: Vec<UnitsPoint>,
    },
    /// "curves"
    #[cfg_attr(feature = "serde", serde(rename = "curves"))]
    Curves {
        #[cfg_attr(feature = "serde", serde(rename = "presetKind"))]
        preset_kind: CurvesPresetKind,
        #[cfg_attr(
            feature = "serde",
            serde(default, skip_serializing_if = "Option::is_none")
        )]
        adjustments: Option<Vec<CurvesFilterAdjustment>>,
    },
    /// "invert"
    #[cfg_attr(feature = "serde", serde(rename = "invert"))]
    Invert,
    /// "brightness/contrast"
    #[cfg_attr(feature = "serde", serde(rename = "brightness/contrast"))]
    BrightnessContrast {
        brightness: f64,
        contrast: f64,
        #[cfg_attr(feature = "serde", serde(rename = "useLegacy"))]
        use_legacy: bool,
    },
}
/// `{ name: string; id: string }` (filter custom shape).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct NamedId {
    pub name: String,
    pub id: String,
}
/// `{ name: string; value: number }` (oil paint plugin parameter).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct NamedValue {
    pub name: String,
    pub value: f64,
}
/// `{ min: number; max: number }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct MinMax {
    pub min: f64,
    pub max: f64,
}
/// "spin" | "zoom"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum RadialBlurMethod {
    /// "spin"
    #[cfg_attr(feature = "serde", serde(rename = "spin"))]
    Spin,
    /// "zoom"
    #[cfg_attr(feature = "serde", serde(rename = "zoom"))]
    Zoom,
}
/// "draft" | "good" | "best"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum RadialBlurQuality {
    /// "draft"
    #[cfg_attr(feature = "serde", serde(rename = "draft"))]
    Draft,
    /// "good"
    #[cfg_attr(feature = "serde", serde(rename = "good"))]
    Good,
    /// "best"
    #[cfg_attr(feature = "serde", serde(rename = "best"))]
    Best,
}
/// "low" | "medium" | "high"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LowMediumHigh {
    /// "low"
    #[cfg_attr(feature = "serde", serde(rename = "low"))]
    Low,
    /// "medium"
    #[cfg_attr(feature = "serde", serde(rename = "medium"))]
    Medium,
    /// "high"
    #[cfg_attr(feature = "serde", serde(rename = "high"))]
    High,
}
/// smart blur mode: "normal" | "edge only" | "overlay edge"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SmartBlurMode {
    /// "normal"
    #[cfg_attr(feature = "serde", serde(rename = "normal"))]
    Normal,
    /// "edge only"
    #[cfg_attr(feature = "serde", serde(rename = "edge only"))]
    EdgeOnly,
    /// "overlay edge"
    #[cfg_attr(feature = "serde", serde(rename = "overlay edge"))]
    OverlayEdge,
}
/// displace displacementMap: "stretch to fit" | "tile"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DisplacementMap {
    /// "stretch to fit"
    #[cfg_attr(feature = "serde", serde(rename = "stretch to fit"))]
    StretchToFit,
    /// "tile"
    #[cfg_attr(feature = "serde", serde(rename = "tile"))]
    Tile,
}
/// "wrap around" | "repeat edge pixels"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum WrapOrRepeat {
    /// "wrap around"
    #[cfg_attr(feature = "serde", serde(rename = "wrap around"))]
    WrapAround,
    /// "repeat edge pixels"
    #[cfg_attr(feature = "serde", serde(rename = "repeat edge pixels"))]
    RepeatEdgePixels,
}
/// displace displacementFile `{ signature; path; }`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct DisplacementFile {
    pub signature: String,
    pub path: String,
}
/// "rectangular to polar" | "polar to rectangular"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum PolarConversion {
    /// "rectangular to polar"
    #[cfg_attr(feature = "serde", serde(rename = "rectangular to polar"))]
    RectangularToPolar,
    /// "polar to rectangular"
    #[cfg_attr(feature = "serde", serde(rename = "polar to rectangular"))]
    PolarToRectangular,
}
/// "small" | "medium" | "large"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SmallMediumLarge {
    /// "small"
    #[cfg_attr(feature = "serde", serde(rename = "small"))]
    Small,
    /// "medium"
    #[cfg_attr(feature = "serde", serde(rename = "medium"))]
    Medium,
    /// "large"
    #[cfg_attr(feature = "serde", serde(rename = "large"))]
    Large,
}
/// spherize mode: "normal" | "horizontal only" | "vertical only"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SpherizeMode {
    /// "normal"
    #[cfg_attr(feature = "serde", serde(rename = "normal"))]
    Normal,
    /// "horizontal only"
    #[cfg_attr(feature = "serde", serde(rename = "horizontal only"))]
    HorizontalOnly,
    /// "vertical only"
    #[cfg_attr(feature = "serde", serde(rename = "vertical only"))]
    VerticalOnly,
}
/// wave type: "sine" | "triangle" | "square"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum WaveType {
    /// "sine"
    #[cfg_attr(feature = "serde", serde(rename = "sine"))]
    Sine,
    /// "triangle"
    #[cfg_attr(feature = "serde", serde(rename = "triangle"))]
    Triangle,
    /// "square"
    #[cfg_attr(feature = "serde", serde(rename = "square"))]
    Square,
}
/// zigzag style: "around center" | "out from center" | "pond ripples"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ZigZagStyle {
    /// "around center"
    #[cfg_attr(feature = "serde", serde(rename = "around center"))]
    AroundCenter,
    /// "out from center"
    #[cfg_attr(feature = "serde", serde(rename = "out from center"))]
    OutFromCenter,
    /// "pond ripples"
    #[cfg_attr(feature = "serde", serde(rename = "pond ripples"))]
    PondRipples,
}
/// "uniform" | "gaussian"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum NoiseDistribution {
    /// "uniform"
    #[cfg_attr(feature = "serde", serde(rename = "uniform"))]
    Uniform,
    /// "gaussian"
    #[cfg_attr(feature = "serde", serde(rename = "gaussian"))]
    Gaussian,
}
/// reduce noise channelDenoise channel: "red" | "green" | "blue" | "composite"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DenoiseChannel {
    /// "red"
    #[cfg_attr(feature = "serde", serde(rename = "red"))]
    Red,
    /// "green"
    #[cfg_attr(feature = "serde", serde(rename = "green"))]
    Green,
    /// "blue"
    #[cfg_attr(feature = "serde", serde(rename = "blue"))]
    Blue,
    /// "composite"
    #[cfg_attr(feature = "serde", serde(rename = "composite"))]
    Composite,
}
/// reduce noise `channelDenoise[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ChannelDenoise {
    pub channels: Vec<DenoiseChannel>,
    pub amount: f64,
    /// percent
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub preserve_details: Option<f64>,
}
/// mezzotint type union.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum MezzotintType {
    /// "fine dots"
    #[cfg_attr(feature = "serde", serde(rename = "fine dots"))]
    FineDots,
    /// "medium dots"
    #[cfg_attr(feature = "serde", serde(rename = "medium dots"))]
    MediumDots,
    /// "grainy dots"
    #[cfg_attr(feature = "serde", serde(rename = "grainy dots"))]
    GrainyDots,
    /// "coarse dots"
    #[cfg_attr(feature = "serde", serde(rename = "coarse dots"))]
    CoarseDots,
    /// "short lines"
    #[cfg_attr(feature = "serde", serde(rename = "short lines"))]
    ShortLines,
    /// "medium lines"
    #[cfg_attr(feature = "serde", serde(rename = "medium lines"))]
    MediumLines,
    /// "long lines"
    #[cfg_attr(feature = "serde", serde(rename = "long lines"))]
    LongLines,
    /// "short strokes"
    #[cfg_attr(feature = "serde", serde(rename = "short strokes"))]
    ShortStrokes,
    /// "medium strokes"
    #[cfg_attr(feature = "serde", serde(rename = "medium strokes"))]
    MediumStrokes,
    /// "long strokes"
    #[cfg_attr(feature = "serde", serde(rename = "long strokes"))]
    LongStrokes,
}
/// lens flare lensType.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LensType {
    /// "50-300mm zoom"
    #[cfg_attr(feature = "serde", serde(rename = "50-300mm zoom"))]
    Zoom50To300,
    /// "32mm prime"
    #[cfg_attr(feature = "serde", serde(rename = "32mm prime"))]
    Prime32,
    /// "105mm prime"
    #[cfg_attr(feature = "serde", serde(rename = "105mm prime"))]
    Prime105,
    /// "movie prime"
    #[cfg_attr(feature = "serde", serde(rename = "movie prime"))]
    MoviePrime,
}
/// smart sharpen blur: "gaussian blur" | "lens blur" | "motion blur"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SmartSharpenBlur {
    /// "gaussian blur"
    #[cfg_attr(feature = "serde", serde(rename = "gaussian blur"))]
    GaussianBlur,
    /// "lens blur"
    #[cfg_attr(feature = "serde", serde(rename = "lens blur"))]
    LensBlur,
    /// "motion blur"
    #[cfg_attr(feature = "serde", serde(rename = "motion blur"))]
    MotionBlur,
}
/// smart sharpen shadow/highlight tone.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SmartSharpenTone {
    /// 0..1
    pub fade_amount: f64,
    /// 0..1
    pub tonal_width: f64,
    /// px
    pub radius: f64,
}
/// diffuse mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DiffuseMode {
    /// "normal"
    #[cfg_attr(feature = "serde", serde(rename = "normal"))]
    Normal,
    /// "darken only"
    #[cfg_attr(feature = "serde", serde(rename = "darken only"))]
    DarkenOnly,
    /// "lighten only"
    #[cfg_attr(feature = "serde", serde(rename = "lighten only"))]
    LightenOnly,
    /// "anisotropic"
    #[cfg_attr(feature = "serde", serde(rename = "anisotropic"))]
    Anisotropic,
}
/// extrude type: "blocks" | "pyramids"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ExtrudeType {
    /// "blocks"
    #[cfg_attr(feature = "serde", serde(rename = "blocks"))]
    Blocks,
    /// "pyramids"
    #[cfg_attr(feature = "serde", serde(rename = "pyramids"))]
    Pyramids,
}
/// extrude depthMode: "random" | "level-based"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ExtrudeDepthMode {
    /// "random"
    #[cfg_attr(feature = "serde", serde(rename = "random"))]
    Random,
    /// "level-based"
    #[cfg_attr(feature = "serde", serde(rename = "level-based"))]
    LevelBased,
}
/// tiles fill: "background color" | "foreground color" | "inverse image" | "unaltered image"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum TilesFill {
    /// "background color"
    #[cfg_attr(feature = "serde", serde(rename = "background color"))]
    BackgroundColor,
    /// "foreground color"
    #[cfg_attr(feature = "serde", serde(rename = "foreground color"))]
    ForegroundColor,
    /// "inverse image"
    #[cfg_attr(feature = "serde", serde(rename = "inverse image"))]
    InverseImage,
    /// "unaltered image"
    #[cfg_attr(feature = "serde", serde(rename = "unaltered image"))]
    UnalteredImage,
}
/// trace contour edge: "lower" | "upper"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LowerUpper {
    /// "lower"
    #[cfg_attr(feature = "serde", serde(rename = "lower"))]
    Lower,
    /// "upper"
    #[cfg_attr(feature = "serde", serde(rename = "upper"))]
    Upper,
}
/// wind method: "wind" | "blast" | "stagger"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum WindMethod {
    /// "wind"
    #[cfg_attr(feature = "serde", serde(rename = "wind"))]
    Wind,
    /// "blast"
    #[cfg_attr(feature = "serde", serde(rename = "blast"))]
    Blast,
    /// "stagger"
    #[cfg_attr(feature = "serde", serde(rename = "stagger"))]
    Stagger,
}
/// "left" | "right"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum LeftRight {
    /// "left"
    #[cfg_attr(feature = "serde", serde(rename = "left"))]
    Left,
    /// "right"
    #[cfg_attr(feature = "serde", serde(rename = "right"))]
    Right,
}
/// de-interlace eliminate: "odd lines" | "even lines"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DeInterlaceEliminate {
    /// "odd lines"
    #[cfg_attr(feature = "serde", serde(rename = "odd lines"))]
    OddLines,
    /// "even lines"
    #[cfg_attr(feature = "serde", serde(rename = "even lines"))]
    EvenLines,
}
/// de-interlace newFieldsBy: "duplication" | "interpolation"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DeInterlaceNewFields {
    /// "duplication"
    #[cfg_attr(feature = "serde", serde(rename = "duplication"))]
    Duplication,
    /// "interpolation"
    #[cfg_attr(feature = "serde", serde(rename = "interpolation"))]
    Interpolation,
}
/// offset undefinedAreas: "set to transparent" | "repeat edge pixels" | "wrap around"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum OffsetUndefinedAreas {
    /// "set to transparent"
    #[cfg_attr(feature = "serde", serde(rename = "set to transparent"))]
    SetToTransparent,
    /// "repeat edge pixels"
    #[cfg_attr(feature = "serde", serde(rename = "repeat edge pixels"))]
    RepeatEdgePixels,
    /// "wrap around"
    #[cfg_attr(feature = "serde", serde(rename = "wrap around"))]
    WrapAround,
}
/// "rgb" | "hsb" | "hsl"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum RgbHsbHsl {
    /// "rgb"
    #[cfg_attr(feature = "serde", serde(rename = "rgb"))]
    Rgb,
    /// "hsb"
    #[cfg_attr(feature = "serde", serde(rename = "hsb"))]
    Hsb,
    /// "hsl"
    #[cfg_attr(feature = "serde", serde(rename = "hsl"))]
    Hsl,
}
/// curves filter presetKind: "custom" | "default"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CurvesPresetKind {
    /// "custom"
    #[cfg_attr(feature = "serde", serde(rename = "custom"))]
    Custom,
    /// "default"
    #[cfg_attr(feature = "serde", serde(rename = "default"))]
    Default,
}
/// curves filter channel: "composite" | "red" | "green" | "blue"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum CurvesFilterChannel {
    /// "composite"
    #[cfg_attr(feature = "serde", serde(rename = "composite"))]
    Composite,
    /// "red"
    #[cfg_attr(feature = "serde", serde(rename = "red"))]
    Red,
    /// "green"
    #[cfg_attr(feature = "serde", serde(rename = "green"))]
    Green,
    /// "blue"
    #[cfg_attr(feature = "serde", serde(rename = "blue"))]
    Blue,
}
/// curves filter point `{ x; y; curved?; }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CurvesFilterPoint {
    pub x: f64,
    pub y: f64,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub curved: Option<bool>,
}
/// curves filter adjustment (union of curve-points vs raw values forms).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum CurvesFilterAdjustment {
    Curve {
        channels: Vec<CurvesFilterChannel>,
        curve: Vec<CurvesFilterPoint>,
    },
    Values {
        channels: Vec<CurvesFilterChannel>,
        values: Vec<f64>,
    },
}
/// puppet shape mesh boundary point.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PuppetMeshPoint {
    pub anchor: UnitsPoint,
    pub forward: UnitsPoint,
    pub backward: UnitsPoint,
    pub smooth: bool,
}
/// puppet mesh boundary path.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PuppetMeshPath {
    pub closed: bool,
    pub points: Vec<PuppetMeshPoint>,
}
/// puppet mesh boundary path component.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PuppetPathComponent {
    pub shape_operation: String,
    pub paths: Vec<PuppetMeshPath>,
}
/// puppet shape entry.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PuppetShape {
    pub rigid_type: bool,
    pub original_vertex_array: Vec<PointF>,
    pub deformed_vertex_array: Vec<PointF>,
    pub index_array: Vec<f64>,
    pub pin_offsets: Vec<PointF>,
    pub pos_final_pins: Vec<PointF>,
    pub pin_vertex_indices: Vec<f64>,
    pub selected_pin: Vec<f64>,
    pub pin_position: Vec<PointF>,
    /// in degrees
    pub pin_rotation: Vec<f64>,
    pub pin_overlay: Vec<bool>,
    pub pin_depth: Vec<f64>,
    pub mesh_quality: f64,
    pub mesh_expansion: f64,
    pub mesh_rigidity: f64,
    pub image_resolution: f64,
    /// `{ pathComponents: [...] }`
    pub mesh_boundary_path: Vec<PuppetPathComponent>,
}
/// TS `Filter = FilterVariant & { ...common fields... }`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Filter {
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub variant: FilterVariant,
    pub name: String,
    pub opacity: f64,
    pub blend_mode: BlendMode,
    pub enabled: bool,
    pub has_options: bool,
    pub foreground_color: Color,
    pub background_color: Color,
}
/// TS `PlacedLayerFilter`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PlacedLayerFilter {
    pub enabled: bool,
    pub valid_at_position: bool,
    pub mask_enabled: bool,
    pub mask_linked: bool,
    pub mask_extend_with_white: bool,
    pub list: Vec<Filter>,
}
/// TS `PlacedLayer.frameStep` / `duration` `{ numerator; denominator; }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct NumDenom {
    pub numerator: f64,
    pub denominator: f64,
}
/// TS `PlacedLayer`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PlacedLayer {
    /// id of linked image file (psd.linkedFiles), GUID format
    pub id: String,
    /// unique id
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub placed: Option<String>,
    /// TS field `type`
    #[cfg_attr(
        feature = "serde",
        serde(rename = "type", default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_type: Option<PlacedLayerType>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub page_number: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub total_pages: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub frame_step: Option<NumDenom>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub duration: Option<NumDenom>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub frame_count: Option<f64>,
    /// x, y of 4 corners of the transform
    pub transform: Vec<f64>,
    /// x, y of 4 corners of the transform
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub non_affine_transform: Option<Vec<f64>>,
    /// width of the linked image
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub width: Option<f64>,
    /// height of the linked image
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub height: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub resolution: Option<UnitsValue>,
    /// warp coordinates are relative to the linked image size
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub warp: Option<Warp>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub crop: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub comp: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub comp_info: Option<CompInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub filter: Option<PlacedLayerFilter>,
}

// ===========================================================================
// Vector origination / vector mask / timeline / animation
// ===========================================================================
/// TS `KeyDescriptorItem.keyOriginRRectRadii`.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct RRectRadii {
    pub top_right: UnitsValue,
    pub top_left: UnitsValue,
    pub bottom_left: UnitsValue,
    pub bottom_right: UnitsValue,
}
/// TS `KeyDescriptorItem`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct KeyDescriptorItem {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key_shape_invalidated: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key_origin_type: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key_origin_resolution: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key_origin_r_rect_radii: Option<RRectRadii>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key_origin_shape_bounding_box: Option<UnitsBounds>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key_origin_box_corners: Option<Vec<PointF>>,
    /// 2d transform matrix [xx, xy, yx, yy, tx, ty]
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub transform: Option<Vec<f64>>,
}
/// TS `LayerVectorMask.clipboard`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VectorMaskClipboard {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub resolution: f64,
}
/// TS `LayerVectorMask`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerVectorMask {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub invert: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub not_link: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub disable: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_starts_with_all_pixels: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub clipboard: Option<VectorMaskClipboard>,
    pub paths: Vec<BezierPath>,
}
/// TS `AnimationFrame`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AnimationFrame {
    /// IDs of frames that this modifier applies to
    pub frames: Vec<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enable: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub offset: Option<PointF>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reference_point: Option<PointF>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub effects: Option<LayerEffectsInfo>,
}
/// TS `TimelineKey` payload (the `type`-tagged second half of the union).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(tag = "type", rename_all = "camelCase"))]
pub enum TimelineKeyData {
    /// "opacity"
    Opacity { value: f64 },
    /// "position"
    Position { x: f64, y: f64 },
    /// "transform"
    Transform {
        scale: PointF,
        skew: PointF,
        rotation: f64,
        translation: PointF,
    },
    /// "style"
    Style {
        #[cfg_attr(
            feature = "serde",
            serde(default, skip_serializing_if = "Option::is_none")
        )]
        style: Option<LayerEffectsInfo>,
    },
    /// "globalLighting"
    GlobalLighting {
        global_angle: f64,
        global_altitude: f64,
    },
}
/// TS `TimelineKey` (common fields intersected with the tagged union).
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TimelineKey {
    pub interpolation: TimelineKeyInterpolation,
    pub time: Fraction,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub selected: Option<bool>,
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub data: TimelineKeyData,
}
/// TS `TimelineTrack.effectParams`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TimelineEffectParams {
    pub keys: Vec<TimelineKey>,
    pub fill_canvas: bool,
    pub zoom_origin: f64,
}
/// TS `TimelineTrack`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TimelineTrack {
    /// TS field `type`
    #[cfg_attr(feature = "serde", serde(rename = "type"))]
    pub track_type: TimelineTrackType,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub effect_params: Option<TimelineEffectParams>,
    pub keys: Vec<TimelineKey>,
}
/// TS `Timeline`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Timeline {
    pub start: Fraction,
    pub duration: Fraction,
    pub in_time: Fraction,
    pub out_time: Fraction,
    pub auto_scope: bool,
    pub audio_level: f64,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub tracks: Option<Vec<TimelineTrack>>,
}

// ===========================================================================
// LayerAdditionalInfo sub-shapes
// ===========================================================================
/// TS `LayerAdditionalInfo.protected`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ProtectedInfo {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub transparency: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub composite: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub position: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub artboards: Option<bool>,
}
/// TS `LayerAdditionalInfo.sectionDivider`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SectionDivider {
    /// TS field `type`
    #[cfg_attr(feature = "serde", serde(rename = "type"))]
    pub divider_type: SectionDividerType,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub key: Option<String>,
    /// 0 = normal, 1 = scene group, affects animation timeline.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub sub_type: Option<f64>,
}
/// TS `LayerAdditionalInfo.filterMask` and `.userMask`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ColorSpaceMask {
    pub color_space: Color,
    pub opacity: f64,
}
/// TS `LayerAdditionalInfo.vectorStroke`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VectorStroke {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub stroke_enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub line_width: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub line_dash_offset: Option<UnitsValue>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub miter_limit: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub line_cap_type: Option<LineCapType>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub line_join_type: Option<LineJoinType>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub line_alignment: Option<LineAlignment>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub scale_lock: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub stroke_adjust: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub line_dash_set: Option<Vec<UnitsValue>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub content: Option<VectorContent>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub resolution: Option<f64>,
}
/// TS `LayerAdditionalInfo.vectorOrigination`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VectorOrigination {
    pub key_descriptor_list: Vec<KeyDescriptorItem>,
}
/// TS version triple `{ major; minor; fix; }`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VersionTriple {
    pub major: f64,
    pub minor: f64,
    pub fix: f64,
}
/// TS `LayerAdditionalInfo.compositorUsed`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CompositorUsed {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub version: Option<VersionTriple>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub photoshop_version: Option<VersionTriple>,
    pub description: String,
    pub reason: String,
    pub engine: String,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enable_comp_core: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(
            rename = "enableCompCoreGPU",
            default,
            skip_serializing_if = "Option::is_none"
        )
    )]
    pub enable_comp_core_gpu: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enable_comp_core_threads: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub comp_core_support: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(
            rename = "compCoreGPUSupport",
            default,
            skip_serializing_if = "Option::is_none"
        )
    )]
    pub comp_core_gpu_support: Option<String>,
}
/// TS `LayerAdditionalInfo.artboard`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerArtboard {
    pub rect: Bounds,
    /// TS `any[]` — kept as opaque count of entries is not modeled; raw f64s.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub guide_indices: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub preset_name: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub background_type: Option<f64>,
}
/// TS `LayerAdditionalInfo.animationFrameFlags`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AnimationFrameFlags {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub propagate_frame_one: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub unify_layer_position: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub unify_layer_style: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub unify_layer_visibility: Option<bool>,
}
/// TS `filterEffectsMasks[].channels[]` element (may be `undefined` in TS).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct FilterEffectsChannel {
    pub compression_mode: f64,
    pub data: Vec<u8>,
}
/// TS `filterEffectsMasks[].extra`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct FilterEffectsExtra {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub compression_mode: f64,
    pub data: Vec<u8>,
}
/// TS `LayerAdditionalInfo.filterEffectsMasks[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct FilterEffectsMask {
    pub id: String,
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
    pub depth: f64,
    /// `(channel | undefined)[]`
    pub channels: Vec<Option<FilterEffectsChannel>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub extra: Option<FilterEffectsExtra>,
}
/// TS `comps.settings[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerCompSettings {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub enabled: Option<bool>,
    pub comp_list: Vec<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub offset: Option<PointF>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub effects_reference_point: Option<PointF>,
}
/// TS `LayerAdditionalInfo.comps`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerComps {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub original_effects_reference_point: Option<PointF>,
    pub settings: Vec<LayerCompSettings>,
}
/// TS `blendingRanges.ranges[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BlendingRange {
    pub source_range: Vec<f64>,
    pub dest_range: Vec<f64>,
}
/// TS `LayerAdditionalInfo.blendingRanges`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct BlendingRanges {
    pub composite_gray_blend_source: Vec<f64>,
    pub composite_graph_blend_destination_range: Vec<f64>,
    pub ranges: Vec<BlendingRange>,
}
/// TS `pixelSource.interpretation`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PixelSourceInterpretation {
    /// 'straight' | ...
    pub interpret_alpha: String,
    pub profile: Vec<u8>,
}
/// TS `pixelSource.frameReader.link`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PixelSourceFrameReaderLink {
    pub name: String,
    pub full_path: String,
    pub original_path: String,
    pub relative_path: String,
    pub alias: String,
}
/// TS `pixelSource.frameReader`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PixelSourceFrameReader {
    /// TS field `type` = 'QTFR'
    pub reader_type: String,
    pub link: PixelSourceFrameReaderLink,
    pub media_descriptor: String,
}
/// TS `LayerAdditionalInfo.pixelSource`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PixelSource {
    /// TS field `type` = 'vdPS'
    pub source_type: String,
    pub origin: PointF,
    pub interpretation: PixelSourceInterpretation,
    pub frame_reader: PixelSourceFrameReader,
    pub show_altered_video: bool,
}
/// TS `LayerAdditionalInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerAdditionalInfo {
    /// layer name
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub name: Option<String>,
    /// layer name source
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub name_source: Option<String>,
    /// layer id
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub id: Option<f64>,
    /// layer version
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub version: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub mask: Option<LayerMaskData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub real_mask: Option<LayerMaskData>,
    /// must be `true` when using `color burn` blend mode.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_clippend_elements: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_interior_elements: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub knockout: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_mask_as_global_mask: Option<bool>,
    /// Upstream TS spells this field `protected` (not `protectedInfo`); hence the serde rename.
    #[cfg_attr(
        feature = "serde",
        serde(rename = "protected", default, skip_serializing_if = "Option::is_none")
    )]
    pub protected_info: Option<ProtectedInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_color: Option<LayerColor>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub reference_point: Option<PointF>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub section_divider: Option<SectionDivider>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub filter_mask: Option<ColorSpaceMask>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub effects: Option<LayerEffectsInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub text: Option<LayerTextData>,
    /// not supported yet upstream
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub patterns: Option<Vec<PatternInfo>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vector_fill: Option<VectorContent>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vector_stroke: Option<VectorStroke>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vector_mask: Option<LayerVectorMask>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub using_aligned_rendering: Option<bool>,
    /// seconds
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub timestamp: Option<f64>,
    /// TS `pathList?: {}[]` — opaque entries; count preserved as empty structs.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub path_list: Option<Vec<PathListItem>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub adjustment: Option<AdjustmentLayer>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub placed_layer: Option<PlacedLayer>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vector_origination: Option<VectorOrigination>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub compositor_used: Option<CompositorUsed>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub artboard: Option<LayerArtboard>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub fill_opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub transparency_shapes_layer: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub channel_blending_restrictions: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub animation_frames: Option<Vec<AnimationFrame>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub animation_frame_flags: Option<AnimationFrameFlags>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub timeline: Option<Timeline>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub filter_effects_masks: Option<Vec<FilterEffectsMask>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub comps: Option<LayerComps>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub user_mask: Option<ColorSpaceMask>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blending_ranges: Option<BlendingRanges>,
    /// ??? (upstream comment)
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vowv: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub pixel_source: Option<PixelSource>,
    /// Base64 encoded raw EngineData, kept in original state.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub engine_data: Option<String>,
}
/// TS `pathList[]` element (`{}` with TODO upstream).
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PathListItem;

// ===========================================================================
// Image resources
// ===========================================================================

/// TS `ImageResources.versionInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct VersionInfo {
    pub has_real_merged_data: bool,
    pub writer_name: String,
    pub reader_name: String,
    pub file_version: f64,
}
/// TS `ImageResources.urlsList[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct UrlListItem {
    pub id: f64,
    /// 'slice'
    pub r#ref: String,
    pub url: String,
}
/// TS `gridAndGuidesInformation.grid`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GridInfo {
    pub horizontal: f64,
    pub vertical: f64,
}
/// guide direction: "horizontal" | "vertical"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum GuideDirection {
    /// "horizontal"
    #[cfg_attr(feature = "serde", serde(rename = "horizontal"))]
    Horizontal,
    /// "vertical"
    #[cfg_attr(feature = "serde", serde(rename = "vertical"))]
    Vertical,
}
/// TS `gridAndGuidesInformation.guides[]` element.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GuideInfo {
    pub location: f64,
    pub direction: GuideDirection,
}
/// TS `ImageResources.gridAndGuidesInformation`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GridAndGuidesInformation {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub grid: Option<GridInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub guides: Option<Vec<GuideInfo>>,
}
/// "PPI" | "PPCM"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum ResolutionUnit {
    /// "PPI"
    #[cfg_attr(feature = "serde", serde(rename = "PPI"))]
    Ppi,
    /// "PPCM"
    #[cfg_attr(feature = "serde", serde(rename = "PPCM"))]
    Ppcm,
}
/// width/height unit: "Inches" | "Centimeters" | "Points" | "Picas" | "Columns"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum DimensionUnit {
    /// "Inches"
    #[cfg_attr(feature = "serde", serde(rename = "Inches"))]
    Inches,
    /// "Centimeters"
    #[cfg_attr(feature = "serde", serde(rename = "Centimeters"))]
    Centimeters,
    /// "Points"
    #[cfg_attr(feature = "serde", serde(rename = "Points"))]
    Points,
    /// "Picas"
    #[cfg_attr(feature = "serde", serde(rename = "Picas"))]
    Picas,
    /// "Columns"
    #[cfg_attr(feature = "serde", serde(rename = "Columns"))]
    Columns,
}
/// TS `ImageResources.resolutionInfo`.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ResolutionInfo {
    pub horizontal_resolution: f64,
    pub horizontal_resolution_unit: ResolutionUnit,
    pub width_unit: DimensionUnit,
    pub vertical_resolution: f64,
    pub vertical_resolution_unit: ResolutionUnit,
    pub height_unit: DimensionUnit,
}
/// TS `ImageResources.thumbnailRaw`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ThumbnailRaw {
    pub width: f64,
    pub height: f64,
    pub data: Vec<u8>,
}
/// print scale style: "centered" | "size to fit" | "user defined"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum PrintScaleStyle {
    /// "centered"
    #[cfg_attr(feature = "serde", serde(rename = "centered"))]
    Centered,
    /// "size to fit"
    #[cfg_attr(feature = "serde", serde(rename = "size to fit"))]
    SizeToFit,
    /// "user defined"
    #[cfg_attr(feature = "serde", serde(rename = "user defined"))]
    UserDefined,
}
/// TS `ImageResources.printScale`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PrintScale {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub style: Option<PrintScaleStyle>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub x: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub y: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub scale: Option<f64>,
}
/// TS `printInformation.proofSetup` union.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum ProofSetup {
    /// `{ builtin: string; }`
    Builtin { builtin: String },
    /// `{ profile; renderingIntent?; blackPointCompensation?; paperWhite?; }`
    #[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
    Profile {
        profile: String,
        #[cfg_attr(
            feature = "serde",
            serde(default, skip_serializing_if = "Option::is_none")
        )]
        rendering_intent: Option<RenderingIntent>,
        #[cfg_attr(
            feature = "serde",
            serde(default, skip_serializing_if = "Option::is_none")
        )]
        black_point_compensation: Option<bool>,
        #[cfg_attr(
            feature = "serde",
            serde(default, skip_serializing_if = "Option::is_none")
        )]
        paper_white: Option<bool>,
    },
}
/// TS `ImageResources.printInformation`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PrintInformation {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub printer_manages_colors: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub printer_name: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub printer_profile: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub print_sixteen_bit: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub rendering_intent: Option<RenderingIntent>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub hard_proof: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub black_point_compensation: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub proof_setup: Option<ProofSetup>,
}
/// TS `ImageResources.printFlags`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PrintFlags {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub labels: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub crop_marks: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color_bars: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub registration_marks: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub negative: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub flip: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub interpolate: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub caption: Option<bool>,
    /// nested field also named `printFlags`
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub print_flags: Option<bool>,
}
/// TS `ImageResources.onionSkins`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct OnionSkins {
    pub enabled: bool,
    pub frames_before: f64,
    pub frames_after: f64,
    pub frame_spacing: f64,
    pub min_opacity: f64,
    pub max_opacity: f64,
    pub blend_mode: BlendMode,
}
/// TS `timelineInformation.audioClipGroups[].audioClips[].frameReader.link`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioClipFrameReaderLink {
    pub name: String,
    pub full_path: String,
    pub relative_path: String,
}
/// TS `timelineInformation.audioClipGroups[].audioClips[].frameReader`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioClipFrameReader {
    /// TS field `type`
    pub reader_type: f64,
    pub media_descriptor: String,
    pub link: AudioClipFrameReaderLink,
}
/// TS `timelineInformation.audioClipGroups[].audioClips[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioClip {
    pub id: String,
    pub start: Fraction,
    pub duration: Fraction,
    pub in_time: Fraction,
    pub out_time: Fraction,
    pub muted: bool,
    pub audio_level: f64,
    pub frame_reader: AudioClipFrameReader,
}
/// TS `timelineInformation.audioClipGroups[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct AudioClipGroup {
    pub id: String,
    pub muted: bool,
    pub audio_clips: Vec<AudioClip>,
}
/// TS `ImageResources.timelineInformation`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct TimelineInformation {
    pub enabled: bool,
    pub frame_step: Fraction,
    pub frame_rate: f64,
    pub time: Fraction,
    pub duration: Fraction,
    pub work_in_time: Fraction,
    pub work_out_time: Fraction,
    pub repeats: f64,
    pub has_motion: bool,
    pub global_tracks: Vec<TimelineTrack>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub audio_clip_groups: Option<Vec<AudioClipGroup>>,
}
/// TS `sheetDisclosure.sheetTimelineOptions[]` element.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SheetTimelineOption {
    pub sheet_id: f64,
    pub sheet_disclosed: bool,
    pub lights_disclosed: bool,
    pub meshes_disclosed: bool,
    pub materials_disclosed: bool,
}
/// TS `ImageResources.sheetDisclosure`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SheetDisclosure {
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub sheet_timeline_options: Option<Vec<SheetTimelineOption>>,
}
/// TS `ImageResources.countInformation[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct CountInformation {
    pub color: Rgb,
    pub name: String,
    pub size: f64,
    pub font_size: f64,
    pub visible: bool,
    pub points: Vec<PointF>,
}
/// slice origin: "userGenerated" | "autoGenerated" | "layer"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SliceOrigin {
    /// "userGenerated"
    #[cfg_attr(feature = "serde", serde(rename = "userGenerated"))]
    UserGenerated,
    /// "autoGenerated"
    #[cfg_attr(feature = "serde", serde(rename = "autoGenerated"))]
    AutoGenerated,
    /// "layer"
    #[cfg_attr(feature = "serde", serde(rename = "layer"))]
    Layer,
}
/// slice type: "image" | "noImage"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SliceType {
    /// "image"
    #[cfg_attr(feature = "serde", serde(rename = "image"))]
    Image,
    /// "noImage"
    #[cfg_attr(feature = "serde", serde(rename = "noImage"))]
    NoImage,
}
/// slice alignment (only "default" observed).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SliceAlignment {
    /// "default"
    #[cfg_attr(feature = "serde", serde(rename = "default"))]
    Default,
}
/// slice background color type: "none" | "matte" | "color"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum SliceBackgroundColorType {
    /// "none"
    #[cfg_attr(feature = "serde", serde(rename = "none"))]
    None,
    /// "matte"
    #[cfg_attr(feature = "serde", serde(rename = "matte"))]
    Matte,
    /// "color"
    #[cfg_attr(feature = "serde", serde(rename = "color"))]
    Color,
}
/// TS `slices[].slices[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Slice {
    pub id: f64,
    pub group_id: f64,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub origin: Option<SliceOrigin>,
    pub associated_layer_id: f64,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub name: Option<String>,
    /// TS field `type`
    #[cfg_attr(
        feature = "serde",
        serde(rename = "type", default, skip_serializing_if = "Option::is_none")
    )]
    pub slice_type: Option<SliceType>,
    pub bounds: LtrbBounds,
    pub url: String,
    pub target: String,
    pub message: String,
    pub alt_tag: String,
    #[cfg_attr(feature = "serde", serde(rename = "cellTextIsHTML"))]
    pub cell_text_is_html: bool,
    pub cell_text: String,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub horizontal_alignment: Option<SliceAlignment>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub vertical_alignment: Option<SliceAlignment>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub background_color_type: Option<SliceBackgroundColorType>,
    pub background_color: Rgba,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub top_outset: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub left_outset: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bottom_outset: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub right_outset: Option<f64>,
}
/// TS `ImageResources.slices[]` element.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct SliceGroup {
    pub bounds: LtrbBounds,
    pub group_name: String,
    pub slices: Vec<Slice>,
}
/// TS `layerComps.list[]` element.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerCompListItem {
    pub id: f64,
    pub name: String,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub comment: Option<String>,
    /// Bitmask of [`LayerCompCapturedInfo`] flags (combinations like 7 are valid).
    pub captured_info: f64,
}
/// TS `ImageResources.layerComps`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerCompsResource {
    pub list: Vec<LayerCompListItem>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub last_applied: Option<f64>,
}
/// TS `ImageResources.pixelAspectRatio`.
#[derive(Debug, Clone, Copy, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PixelAspectRatio {
    pub aspect: f64,
}
/// TS `ImageResources`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ImageResources {
    /// Internal write-side field (TS `InternalImageResources.layersGroup`).
    /// Regenerated by the writer from flattened layer `linkGroup` values.
    #[cfg_attr(feature = "serde", serde(skip))]
    pub layers_group: Option<Vec<f64>>,
    /// Internal write-side field (TS `InternalImageResources.layerGroupsEnabledId`).
    #[cfg_attr(feature = "serde", serde(skip))]
    pub layer_groups_enabled_id: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_state: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_selection_ids: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub version_info: Option<VersionInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub alpha_identifiers: Option<Vec<f64>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub alpha_channel_names: Option<Vec<String>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub global_angle: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub global_altitude: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub pixel_aspect_ratio: Option<PixelAspectRatio>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub urls_list: Option<Vec<UrlListItem>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub grid_and_guides_information: Option<GridAndGuidesInformation>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub resolution_info: Option<ResolutionInfo>,
    /// TS `thumbnail?: HTMLCanvasElement` -> raw pixels.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub thumbnail: Option<PixelData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub thumbnail_raw: Option<ThumbnailRaw>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub caption_digest: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub xmp_metadata: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub print_scale: Option<PrintScale>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub print_information: Option<PrintInformation>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub background_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub ids_seed_number: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub print_flags: Option<PrintFlags>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub icc_untagged_profile: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub path_selection_state: Option<Vec<String>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub image_ready_variables: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub image_ready_data_sets: Option<String>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub animations: Option<Animations>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub onion_skins: Option<OnionSkins>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub timeline_information: Option<TimelineInformation>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub sheet_disclosure: Option<SheetDisclosure>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub count_information: Option<Vec<CountInformation>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub slices: Option<Vec<SliceGroup>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub layer_comps: Option<LayerCompsResource>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub copyrighted: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub url: Option<String>,
}

// ===========================================================================
// Global mask info / annotations
// ===========================================================================
/// TS `GlobalLayerMaskInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct GlobalLayerMaskInfo {
    pub overlay_color_space: f64,
    pub color_space1: f64,
    pub color_space2: f64,
    pub color_space3: f64,
    pub color_space4: f64,
    pub opacity: f64,
    pub kind: f64,
}
/// annotation type: "text" | "sound"
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
pub enum AnnotationType {
    /// "text"
    #[cfg_attr(feature = "serde", serde(rename = "text"))]
    Text,
    /// "sound"
    #[cfg_attr(feature = "serde", serde(rename = "sound"))]
    Sound,
}
/// TS `Annotation.data = string | Uint8Array`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(untagged))]
pub enum AnnotationData {
    Text(String),
    Binary(#[cfg_attr(feature = "serde", serde(with = "crate::serde_bytes"))] Vec<u8>),
}
/// TS `Annotation`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Annotation {
    /// TS field `type`
    #[cfg_attr(feature = "serde", serde(rename = "type"))]
    pub annotation_type: AnnotationType,
    pub open: bool,
    pub icon_location: LtrbBounds,
    pub popup_location: LtrbBounds,
    pub color: Color,
    pub author: String,
    pub name: String,
    pub date: String,
    pub data: AnnotationData,
}

// ===========================================================================
// Raw channel data
// ===========================================================================
/// TS `LayerRawDataChannel`.
///
/// `id` is the raw PSD channel id (`i16`), including spot/extra channels (`id >= 4`).
/// Upstream stores these as `ChannelID` numbers and indexes extras via
/// `offsetForChannel` (`id + 1`); they must not be collapsed to Transparency.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerRawDataChannel {
    pub id: i16,
    pub compression: Compression,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub data: Option<Vec<u8>>,
}
/// TS `LayerRawData`.
#[derive(Debug, Clone)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct LayerRawData {
    pub color_mode: ColorMode,
    pub bits_per_channel: f64,
    pub channels: Vec<LayerRawDataChannel>,
    pub large: bool,
}

// ===========================================================================
// Layer / Psd
// ===========================================================================
/// TS `Layer extends LayerAdditionalInfo`.
///
/// `children` is `Vec<Layer>` (recursive); since it lives behind a `Vec`, no
/// `Box` is needed to break the recursion.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Layer {
    /// flattened `LayerAdditionalInfo` base (TS `Layer extends LayerAdditionalInfo`).
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub additional_info: LayerAdditionalInfo,

    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub top: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub left: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bottom: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub right: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub blend_mode: Option<BlendMode>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opacity: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub transparency_protected: Option<bool>,
    /// effects/filters panel is expanded
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub effects_open: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub hidden: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub clipping: Option<bool>,
    /// TS `canvas?: HTMLCanvasElement` -> raw pixels.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub canvas: Option<PixelData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub image_data: Option<PixelData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub raw_data: Option<LayerRawData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub children: Option<Vec<Layer>>,
    /// Applies only for layer groups.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub opened: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub link_group: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub link_group_enabled: Option<bool>,
}
/// TS `Psd.artboards`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct PsdArtboards {
    /// number of artboards in the document
    pub count: f64,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_expand_offset: Option<HorizontalVertical>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub origin: Option<HorizontalVertical>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_expand_enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_nest_enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub auto_position_enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub shrinkwrap_on_save_enabled: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub doc_default_new_artboard_background_color: Option<Color>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub doc_default_new_artboard_background_type: Option<f64>,
}
/// TS `Psd extends LayerAdditionalInfo`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct Psd {
    /// flattened `LayerAdditionalInfo` base (TS `Psd extends LayerAdditionalInfo`).
    #[cfg_attr(feature = "serde", serde(flatten))]
    pub additional_info: LayerAdditionalInfo,

    pub width: f64,
    pub height: f64,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub channels: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub bits_per_channel: Option<f64>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub color_mode: Option<ColorMode>,
    /// colors for indexed color mode
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub palette: Option<Vec<Rgb>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub children: Option<Vec<Layer>>,
    /// TS `canvas?: HTMLCanvasElement` -> raw pixels.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub canvas: Option<PixelData>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub image_data: Option<PixelData>,
    /// Undecoded composite image section (when `ReadOptions::use_raw_data`).
    /// Upstream: `psd.rawCompositeData`.
    #[cfg_attr(
        feature = "serde",
        serde(
            default,
            skip_serializing_if = "Option::is_none",
            with = "crate::serde_bytes_opt"
        )
    )]
    pub raw_composite_data: Option<Vec<u8>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub image_resources: Option<ImageResources>,
    /// used in smart objects
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub linked_files: Option<Vec<LinkedFile>>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub artboards: Option<PsdArtboards>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub global_layer_mask_info: Option<GlobalLayerMaskInfo>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub annotations: Option<Vec<Annotation>>,
}

// ===========================================================================
// Read / Write options
// ===========================================================================
/// TS `ReadOptions`.
///
/// The development-only `log?: (...args) => void` callback is not modeled here
/// (it is behaviour, not data); other dev flags are kept.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct ReadOptions {
    /// Does not load layer image data.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub skip_layer_image_data: Option<bool>,
    /// Does not load composite image data.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub skip_composite_image_data: Option<bool>,
    /// Does not load thumbnail.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub skip_thumbnail: Option<bool>,
    /// Does not load linked files (used in smart-objects).
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub skip_linked_files_data: Option<bool>,
    /// Throws exception if features are missing.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub throw_for_missing_features: Option<bool>,
    /// Logs if features are missing.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub log_missing_features: Option<bool>,
    /// Keep image data as byte array instead of canvas.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_image_data: Option<bool>,
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_raw_data: Option<bool>,
    /// Loads thumbnail raw data instead of decoding into canvas.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub use_raw_thumbnail: Option<bool>,
    /// Used only for development.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub log_dev_features: Option<bool>,
    /// Used only for development.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub strict: Option<bool>,
    /// Treat undecodable ZIP channel data as a hard parse error.
    ///
    /// The decoder has always recovered from a corrupt zlib stream by leaving
    /// the channel's samples at zero and returning success, because the
    /// upstream TypeScript port needed to read partially damaged documents.
    /// A renderer cannot use that recovery: a zeroed channel is opaque black,
    /// so a damaged template renders as a plausible-looking but wrong image
    /// and the damage is only visible after the product ships.
    ///
    /// When this is `Some(true)`, a ZIP-compressed channel that fails to
    /// decompress (or that decompresses past the declared geometry) and whose
    /// samples the caller is actually going to consume produces
    /// [`ReadError::CorruptChannel`](crate::reader::ReadError::CorruptChannel)
    /// instead. Channels the caller skips (raw-data-only reads, channel
    /// offsets beyond the interleaved step, empty planes) stay lenient, so the
    /// editing helpers that only round-trip bytes keep working.
    ///
    /// `None` and `Some(false)` keep the recover-and-zero behaviour.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub corrupt_channel_is_fatal: Option<bool>,
    /// Used only for development.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub debug: Option<bool>,
    /// Cap on decode allocations (bytes). `None` → default 2 GiB (upstream
    /// `totalMemoryLimit`). Pass `Some(usize::MAX)` to effectively disable.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub total_memory_limit: Option<usize>,
    /// Aggregate ceiling for metadata, descriptors, and EngineData owned by the parser.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_metadata_bytes: Option<usize>,
    /// Maximum PSD v1 document side. `None` keeps the format default (30,000).
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_psd_side: Option<u32>,
    /// Maximum PSB v2 document side. `None` keeps the format default (300,000).
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_psb_side: Option<u32>,
    /// Maximum width × height accepted before any raster allocation.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_canvas_pixels: Option<u64>,
    /// Maximum layer records in one document.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_layer_records: Option<u32>,
    /// Maximum nested Photoshop group depth.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_layer_depth: Option<u32>,
    /// Maximum descriptor and engine-data recursion depth.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_recursion_depth: Option<u32>,
    /// Maximum recursively parsed embedded Photoshop documents.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub max_embedded_document_depth: Option<u32>,
    /// When `Some(true)` or `None` (default), resolve missing per-run fonts
    /// from the resource dict's Regular (`TheNormalStyleSheet`) style sheet
    /// instead of falling back to `FontSet[0]` (often `AdobeInvisFont`).
    /// `Some(false)` restores upstream ag-psd's commented-out behavior (escape
    /// hatch for JS-oracle byte/golden parity); psdx defaults inherited-font resolution to on.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub resolve_inherited_fonts: Option<bool>,
    // TS `log?: (...args: any[]) => void;` — behavior, not data; not ported.
}
/// TS `WriteOptions`.
#[derive(Debug, Clone, Default)]
#[cfg_attr(feature = "serde", derive(serde::Serialize, serde::Deserialize))]
#[cfg_attr(feature = "serde", serde(rename_all = "camelCase"))]
pub struct WriteOptions {
    /// Automatically generates thumbnail from composite image.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub generate_thumbnail: Option<bool>,
    /// Trims transparent pixels from layer image data.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub trim_image_data: Option<bool>,
    /// Invalidates text layer data, forcing Photoshop to redraw on load.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub invalidate_text_layers: Option<bool>,
    /// Logs if features are missing.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub log_missing_features: Option<bool>,
    /// Forces bottom layer to be treated as layer and not background.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub no_background: Option<bool>,
    /// Saves document as PSB (Large Document Format) file.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub psb: Option<bool>,
    /// Uses zip compression when writing PSD file.
    #[cfg_attr(
        feature = "serde",
        serde(default, skip_serializing_if = "Option::is_none")
    )]
    pub compress: Option<bool>,
}

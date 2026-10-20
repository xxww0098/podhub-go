/*
File: rust/crates/psd-x/src/additional_info/effects_keys.rs

Purpose:
Additional-info key group-module. Group: `Group::Effects`.
Layer effects (lmfx, lrFX, lfxs, lfx2).

PORT STATUS: all four keys implemented (`lfx2`, `lrFX`, `lmfx`, `lfxs`).
- `lrFX` — legacy signature-block format: delegated to
  `crate::effects_helpers::{read_effects, write_effects}`.
- `lfx2` / `lmfx` / `lfxs` — descriptor-based format: here we ported
  `parseEffects` / `serializeEffects` (+ `parseEffectObject` /
  `serializeEffectObject`, gradient/pattern/contour/color mappers) from upstream
  ag-psd `src/descriptor.ts`, mapping descriptor <-> LayerEffectsInfo.

WHY PORTED HERE (rather than reusing `crate::effects_helpers`):
`crate::effects_helpers` carries ONLY legacy lrFX helpers (read_effects /
write_effects), and `descriptor.rs` holds the typed tree plus the shared
color / units helpers only. The effect-object mappers (`parseEffects` /
`serializeEffects` and their gradient/pattern/contour dependencies) therefore
live in this file.

GROUP-MODULE CONTRACT (see mod.rs):
- `pub fn read(key, reader, info, left, ctx) -> ReadResult<Option<()>>`
    Ok(Some(())) — key handled; Ok(None) — "not my key".
- `pub fn has(key, info) -> Option<bool>`
    Some(b) — this group-module owns the key; b = whether to write it;
    None — "not my key".
- `pub fn write(key, writer, info, ctx) -> Option<ReadResult<()>>`
    Some(Ok(())) — written; Some(Err(_)) — validation failed mid-body
    (partial bytes may already be in the writer; not rewound);
    None — "not my key". Called ONLY when has(key, info) == Some(true),
    inside an already-open writeSection. `write_additional_info` maps
    Some(Err(e)) to WriteError::Internal("<key>: <e>") and returns Err.
*/

use crate::additional_info::{ReadCtx, WriteCtx};
use crate::descriptor::{
    Descriptor, DescriptorValue, UnitDoubleValue, parse_angle, parse_percent, parse_units,
    read_version_and_descriptor, units_angle, write_version_and_descriptor,
};
use crate::descriptor_enums;
use crate::effects_helpers::{read_effects, write_effects};
use crate::psd::{
    BevelDirection, BevelStyle, BevelTechnique, BlendMode, Color, ColorStop, EffectContour,
    EffectGradient, EffectNoiseGradient, EffectPattern, EffectSolidGradient, ExtraGradientInfo,
    GlowSource, GlowTechnique, GradientColorModel, GradientStyle, GradientWithExtra,
    InterpolationMethod, LayerAdditionalInfo, LayerEffectBevel, LayerEffectGradientOverlay,
    LayerEffectInnerGlow, LayerEffectPatternOverlay, LayerEffectSatin, LayerEffectShadow,
    LayerEffectSolidFill, LayerEffectStroke, LayerEffectsInfo, LayerEffectsOuterGlow, OpacityStop,
    PointF, StrokeFillType, StrokePosition, UnitsValue,
};
use crate::reader::{PsdReader, ReadError, ReadResult, read_uint32, skip_bytes};
use crate::writer::{PsdWriter, write_uint32};
use std::collections::{HashMap, HashSet};

// ===========================================================================
// Public group-module contract entry points
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs.
pub fn read(
    key: &str,
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
    _ctx: &mut ReadCtx,
) -> ReadResult<Option<()>> {
    match key {
        "lrFX" => {
            // upstream: if (!target.effects) target.effects = readEffects(reader);
            if info.effects.is_none() {
                info.effects = Some(read_effects(reader)?);
            }
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }
        "lmfx" => {
            let version = read_uint32(reader)?;
            if version != 0 {
                return Err(ReadError::StrictViolation(
                    "Invalid lmfx version".to_string(),
                ));
            }
            let desc = read_version_and_descriptor(reader)?;
            info.effects = Some(parse_effects(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }
        "lfxs" => {
            let version = read_uint32(reader)?;
            if version != 0 {
                return Err(ReadError::StrictViolation(
                    "Invalid lfxs version".to_string(),
                ));
            }
            let desc = read_version_and_descriptor(reader)?;
            info.effects = Some(parse_effects(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }
        "lfx2" => {
            let version = read_uint32(reader)?;
            if version != 0 {
                return Err(ReadError::StrictViolation(
                    "Invalid lfx2 version".to_string(),
                ));
            }
            let desc = read_version_and_descriptor(reader)?;
            info.effects = Some(parse_effects(&desc)?);
            skip_bytes(reader, left(reader));
            Ok(Some(()))
        }
        _ => Ok(None),
    }
}

/// See GROUP-MODULE CONTRACT in mod.rs.
pub fn has(key: &str, info: &LayerAdditionalInfo) -> Option<bool> {
    match key {
        // upstream lmfx: target.effects !== undefined && hasMultiEffects(target.effects)
        "lmfx" => Some(
            info.effects
                .as_ref()
                .map(has_multi_effects)
                .unwrap_or(false),
        ),
        // upstream lrFX: hasKey('effects')
        "lrFX" => Some(info.effects.is_some()),
        // upstream lfxs: () => false
        "lfxs" => Some(false),
        // upstream lfx2: target.effects !== undefined && !hasMultiEffects(target.effects)
        "lfx2" => Some(
            info.effects
                .as_ref()
                .map(|e| !has_multi_effects(e))
                .unwrap_or(false),
        ),
        _ => None,
    }
}

/// See GROUP-MODULE CONTRACT in mod.rs.
pub fn write(
    key: &str,
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    _ctx: &mut WriteCtx,
) -> Option<ReadResult<()>> {
    match key {
        "lrFX" => {
            if let Some(effects) = info.effects.as_ref() {
                write_effects(writer, effects);
            }
            Some(Ok(()))
        }
        "lmfx" | "lfxs" | "lfx2" => {
            // upstream serializeEffects(target.effects!, log, true)
            let effects = info.effects.as_ref();
            let result = match effects {
                Some(e) => serialize_effects(e, true),
                // has() guarantees effects.is_some() for these keys, but be safe.
                None => Ok(Descriptor::new("", "null")),
            };
            match result {
                Ok(desc) => {
                    write_uint32(writer, 0); // version
                    write_version_and_descriptor(writer, &desc);
                    Some(Ok(()))
                }
                Err(e) => Some(Err(e)),
            }
        }
        _ => None,
    }
}

/// Mirror of `hasMultiEffects(effects)`: whether any effect array has length > 1.
pub fn has_multi_effects(e: &LayerEffectsInfo) -> bool {
    fn multi<T>(v: &Option<Vec<T>>) -> bool {
        v.as_ref().map(|a| a.len() > 1).unwrap_or(false)
    }
    multi(&e.drop_shadow)
        || multi(&e.inner_shadow)
        || multi(&e.solid_fill)
        || multi(&e.stroke)
        || multi(&e.gradient_overlay)
}

// ===========================================================================
// Enum codecs (mirrors createEnum<...> from descriptor.ts)
// ===========================================================================
//
// createEnum.decode(val): take the part after '.', look up in reverse-map, else def.
// Typed wrappers around descriptor_enums::createEnum tables (PS 2026 long-form
// decode lives in EnumCodec::decode).

fn codec_name(codec: &crate::helpers::EnumCodec, val: &str, default: &str) -> String {
    codec.decode(val).unwrap_or_else(|_| default.to_string())
}

pub(crate) fn bln_m_decode(val: &str) -> BlendMode {
    BlendMode::from_json_str(&codec_name(&descriptor_enums::bln_m(), val, "normal"))
        .unwrap_or(BlendMode::Normal)
}
pub(crate) fn bln_m_encode(val: BlendMode) -> String {
    descriptor_enums::bln_m()
        .encode(Some(val.as_json_str()))
        .unwrap_or_else(|_| "BlnM.Nrml".into())
}

fn f_stl_decode(val: &str) -> StrokePosition {
    match codec_name(&descriptor_enums::f_stl(), val, "outside").as_str() {
        "inside" => StrokePosition::Inside,
        "center" => StrokePosition::Center,
        _ => StrokePosition::Outside,
    }
}
fn f_stl_encode(val: StrokePosition) -> String {
    let name = match val {
        StrokePosition::Inside => "inside",
        StrokePosition::Center => "center",
        StrokePosition::Outside => "outside",
    };
    descriptor_enums::f_stl()
        .encode(Some(name))
        .unwrap_or_else(|_| "FStl.OutF".into())
}

fn fr_fl_decode(val: &str) -> StrokeFillType {
    match codec_name(&descriptor_enums::fr_fl(), val, "color").as_str() {
        "gradient" => StrokeFillType::Gradient,
        "pattern" => StrokeFillType::Pattern,
        _ => StrokeFillType::Color,
    }
}
fn fr_fl_encode(val: StrokeFillType) -> String {
    let name = match val {
        StrokeFillType::Color => "color",
        StrokeFillType::Gradient => "gradient",
        StrokeFillType::Pattern => "pattern",
    };
    descriptor_enums::fr_fl()
        .encode(Some(name))
        .unwrap_or_else(|_| "FrFl.SClr".into())
}

fn be_sl_decode(val: &str) -> BevelStyle {
    match codec_name(&descriptor_enums::be_sl(), val, "inner bevel").as_str() {
        "outer bevel" => BevelStyle::OuterBevel,
        "emboss" => BevelStyle::Emboss,
        "pillow emboss" => BevelStyle::PillowEmboss,
        "stroke emboss" => BevelStyle::StrokeEmboss,
        _ => BevelStyle::InnerBevel,
    }
}
fn be_sl_encode(val: BevelStyle) -> String {
    let name = match val {
        BevelStyle::OuterBevel => "outer bevel",
        BevelStyle::InnerBevel => "inner bevel",
        BevelStyle::Emboss => "emboss",
        BevelStyle::PillowEmboss => "pillow emboss",
        BevelStyle::StrokeEmboss => "stroke emboss",
    };
    descriptor_enums::be_sl()
        .encode(Some(name))
        .unwrap_or_else(|_| "BESl.InrB".into())
}

fn bvl_t_decode(val: &str) -> BevelTechnique {
    match codec_name(&descriptor_enums::bvl_t(), val, "smooth").as_str() {
        "chisel hard" => BevelTechnique::ChiselHard,
        "chisel soft" => BevelTechnique::ChiselSoft,
        _ => BevelTechnique::Smooth,
    }
}
fn bvl_t_encode(val: BevelTechnique) -> String {
    let name = match val {
        BevelTechnique::Smooth => "smooth",
        BevelTechnique::ChiselHard => "chisel hard",
        BevelTechnique::ChiselSoft => "chisel soft",
    };
    descriptor_enums::bvl_t()
        .encode(Some(name))
        .unwrap_or_else(|_| "bvlT.SfBL".into())
}

fn be_ss_decode(val: &str) -> BevelDirection {
    match codec_name(&descriptor_enums::be_ss(), val, "up").as_str() {
        "down" => BevelDirection::Down,
        _ => BevelDirection::Up,
    }
}
fn be_ss_encode(val: BevelDirection) -> String {
    let name = match val {
        BevelDirection::Up => "up",
        BevelDirection::Down => "down",
    };
    descriptor_enums::be_ss()
        .encode(Some(name))
        .unwrap_or_else(|_| "BESs.In  ".into())
}

fn be_te_decode(val: &str) -> GlowTechnique {
    match codec_name(&descriptor_enums::be_te(), val, "softer").as_str() {
        "precise" => GlowTechnique::Precise,
        _ => GlowTechnique::Softer,
    }
}
fn be_te_encode(val: GlowTechnique) -> String {
    let name = match val {
        GlowTechnique::Softer => "softer",
        GlowTechnique::Precise => "precise",
    };
    descriptor_enums::be_te()
        .encode(Some(name))
        .unwrap_or_else(|_| "BETE.SfBL".into())
}

fn ig_sr_decode(val: &str) -> GlowSource {
    match codec_name(&descriptor_enums::ig_sr(), val, "edge").as_str() {
        "center" => GlowSource::Center,
        _ => GlowSource::Edge,
    }
}
fn ig_sr_encode(val: GlowSource) -> String {
    let name = match val {
        GlowSource::Edge => "edge",
        GlowSource::Center => "center",
    };
    descriptor_enums::ig_sr()
        .encode(Some(name))
        .unwrap_or_else(|_| "IGSr.SrcE".into())
}

fn grd_t_decode(val: &str) -> GradientStyle {
    match codec_name(&descriptor_enums::grd_t(), val, "linear").as_str() {
        "radial" => GradientStyle::Radial,
        "angle" => GradientStyle::Angle,
        "reflected" => GradientStyle::Reflected,
        "diamond" => GradientStyle::Diamond,
        _ => GradientStyle::Linear,
    }
}
fn grd_t_encode(val: GradientStyle) -> String {
    let name = match val {
        GradientStyle::Linear => "linear",
        GradientStyle::Radial => "radial",
        GradientStyle::Angle => "angle",
        GradientStyle::Reflected => "reflected",
        GradientStyle::Diamond => "diamond",
    };
    descriptor_enums::grd_t()
        .encode(Some(name))
        .unwrap_or_else(|_| "GrdT.Lnr ".into())
}

fn gs99_decode(val: &str) -> InterpolationMethod {
    match codec_name(
        &descriptor_enums::gradient_interpolation_method_type(),
        val,
        "perceptual",
    )
    .as_str()
    {
        "linear" => InterpolationMethod::Linear,
        "classic" => InterpolationMethod::Classic,
        "smooth" => InterpolationMethod::Smooth,
        _ => InterpolationMethod::Perceptual,
    }
}
fn gs99_encode(val: InterpolationMethod) -> String {
    let name = match val {
        InterpolationMethod::Perceptual => "perceptual",
        InterpolationMethod::Linear => "linear",
        InterpolationMethod::Classic => "classic",
        InterpolationMethod::Smooth => "smooth",
    };
    descriptor_enums::gradient_interpolation_method_type()
        .encode(Some(name))
        .unwrap_or_else(|_| "gradientInterpolationMethodType.Perc".into())
}

fn clr_s_decode(val: &str) -> GradientColorModel {
    match codec_name(&descriptor_enums::clr_s(), val, "rgb").as_str() {
        "hsb" => GradientColorModel::Hsb,
        "lab" => GradientColorModel::Lab,
        _ => GradientColorModel::Rgb,
    }
}
fn clr_s_encode(val: GradientColorModel) -> String {
    let name = match val {
        GradientColorModel::Rgb => "rgb",
        GradientColorModel::Hsb => "hsb",
        GradientColorModel::Lab => "lab",
    };
    descriptor_enums::clr_s()
        .encode(Some(name))
        .unwrap_or_else(|_| "ClrS.RGBC".into())
}

// ===========================================================================
// Units helpers (mirrors descriptor.ts)
// ===========================================================================

/// `unitsPercent(value)` -> `{ units: 'Percent', value: round(value*100) }`.
pub(crate) fn units_percent(value: f64) -> DescriptorValue {
    DescriptorValue::UnitDouble(UnitDoubleValue {
        units: "Percent".to_string(),
        value: (value * 100.0).round(),
    })
}

/// `unitsPercentF(value)` -> `{ units: 'Percent', value: value*100 }` (no rounding).
fn units_percent_f(value: f64) -> DescriptorValue {
    DescriptorValue::UnitDouble(UnitDoubleValue {
        units: "Percent".to_string(),
        value: value * 100.0,
    })
}

/// `unitsValue(x, key)` (by-value adapter over `descriptor::units_value`).
fn units_value(x: Option<UnitsValue>) -> DescriptorValue {
    crate::descriptor::units_value(x.as_ref())
}

// ===========================================================================
// Color (DescriptorValue::Descriptor <-> Color); adapters over descriptor.rs
// ===========================================================================

/// Adapter over `descriptor::parse_color`: unwraps `DescriptorValue::Descriptor`.
fn parse_color(v: &DescriptorValue) -> ReadResult<Color> {
    match v {
        DescriptorValue::Descriptor(d) => crate::descriptor::parse_color(d),
        _ => Err(ReadError::StrictViolation(
            "Unsupported color descriptor".to_string(),
        )),
    }
}

/// Adapter over `descriptor::serialize_color`: wraps in `DescriptorValue::Descriptor`.
fn serialize_color(color: Option<&Color>) -> DescriptorValue {
    DescriptorValue::Descriptor(crate::descriptor::serialize_color(color))
}

// ===========================================================================
// Contour (TrnS / MpgS); mirror of parse/serialize in parseEffectObject
// ===========================================================================

fn parse_contour(v: &DescriptorValue) -> EffectContour {
    let d = match v {
        DescriptorValue::Descriptor(d) => d,
        _ => return EffectContour::default(),
    };
    let name = match d.get("Nm  ") {
        Some(DescriptorValue::Text(s)) => s.clone(),
        _ => String::new(),
    };
    let curve = match d.get("Crv ") {
        Some(DescriptorValue::List(items)) => items
            .iter()
            .filter_map(|it| match it {
                DescriptorValue::Descriptor(p) => Some(PointF {
                    x: p.number("Hrzn").unwrap_or_default(),
                    y: p.number("Vrtc").unwrap_or_default(),
                }),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    EffectContour { name, curve }
}

fn serialize_contour(c: &EffectContour) -> DescriptorValue {
    let mut d = Descriptor::new("", "ShpC");
    d.set("Nm  ", DescriptorValue::Text(c.name.clone()));
    let curve = c
        .curve
        .iter()
        .map(|p| {
            // fieldToArrayExtType Crv → CrPt (not Pnt ).
            let mut pt = Descriptor::new("", "CrPt");
            pt.set("Hrzn", DescriptorValue::Double(p.x));
            pt.set("Vrtc", DescriptorValue::Double(p.y));
            DescriptorValue::Descriptor(pt)
        })
        .collect();
    d.set("Crv ", DescriptorValue::List(curve));
    DescriptorValue::Descriptor(d)
}

/// Empty default TrnS contour for dropShadow (mirror of `{ 'Nm  ': '', 'Crv ': [] }`).
fn empty_contour() -> DescriptorValue {
    let mut d = Descriptor::new("", "ShpC");
    d.set("Nm  ", DescriptorValue::Text(String::new()));
    d.set("Crv ", DescriptorValue::List(Vec::new()));
    DescriptorValue::Descriptor(d)
}

// ===========================================================================
// Gradient (Grad descriptor); mirrors parseGradient/serializeGradient
// ===========================================================================

pub(crate) fn parse_gradient(v: &DescriptorValue) -> ReadResult<EffectGradient> {
    let d = match v {
        DescriptorValue::Descriptor(d) => d,
        _ => return Err(ReadError::StrictViolation("Invalid gradient".to_string())),
    };
    let grd_f = match d.get("GrdF") {
        Some(DescriptorValue::Enum(s)) => s.clone(),
        _ => String::new(),
    };
    let name = match d.get("Nm  ") {
        Some(DescriptorValue::Text(s)) => s.clone(),
        _ => String::new(),
    };
    if grd_f == "GrdF.CstS" {
        let intr = d.number("Intr").unwrap_or_default();
        let samples = if intr != 0.0 { intr } else { 4096.0 };
        let color_stops = match d.get("Clrs") {
            Some(DescriptorValue::List(items)) => items
                .iter()
                .map(|it| {
                    let s = match it {
                        DescriptorValue::Descriptor(s) => s,
                        _ => {
                            return Err(ReadError::StrictViolation(
                                "Invalid color stop".to_string(),
                            ));
                        }
                    };
                    Ok(ColorStop {
                        color: parse_color(s.get("Clr ").ok_or_else(|| {
                            ReadError::StrictViolation("Missing Clr".to_string())
                        })?)?,
                        location: s.number("Lctn").unwrap_or_default() / samples,
                        midpoint: s.number("Mdpn").unwrap_or_default() / 100.0,
                    })
                })
                .collect::<ReadResult<Vec<_>>>()?,
            _ => Vec::new(),
        };
        let opacity_stops = match d.get("Trns") {
            Some(DescriptorValue::List(items)) => items
                .iter()
                .map(|it| {
                    let s = match it {
                        DescriptorValue::Descriptor(s) => s,
                        _ => {
                            return Err(ReadError::StrictViolation(
                                "Invalid opacity stop".to_string(),
                            ));
                        }
                    };
                    Ok(OpacityStop {
                        opacity: s.get("Opct").map(parse_percent).transpose()?.unwrap_or(1.0),
                        location: s.number("Lctn").unwrap_or_default() / samples,
                        midpoint: s.number("Mdpn").unwrap_or_default() / 100.0,
                    })
                })
                .collect::<ReadResult<Vec<_>>>()?,
            _ => Vec::new(),
        };
        Ok(EffectGradient::Solid(EffectSolidGradient {
            name,
            smoothness: Some(intr / 4096.0),
            color_stops,
            opacity_stops,
        }))
    } else {
        let map_arr = |v: Option<&DescriptorValue>| -> Vec<f64> {
            match v {
                Some(DescriptorValue::List(items)) => items
                    .iter()
                    .map(|it| match it {
                        DescriptorValue::Double(x) => *x / 100.0,
                        DescriptorValue::Integer(x) => *x as f64 / 100.0,
                        _ => 0.0,
                    })
                    .collect(),
                _ => Vec::new(),
            }
        };
        Ok(EffectGradient::Noise(EffectNoiseGradient {
            name,
            roughness: Some(d.number("Smth").unwrap_or_default() / 4096.0),
            color_model: Some(match d.get("ClrS") {
                Some(DescriptorValue::Enum(s)) => clr_s_decode(s),
                _ => GradientColorModel::Rgb,
            }),
            random_seed: Some(d.number("RndS").unwrap_or_default()),
            restrict_colors: Some(d.bool("VctC").unwrap_or_default()),
            add_transparency: Some(d.bool("ShTr").unwrap_or_default()),
            min: map_arr(d.get("Mnm ")),
            max: map_arr(d.get("Mxm ")),
        }))
    }
}

pub(crate) fn serialize_gradient(grad: &EffectGradient) -> DescriptorValue {
    match grad {
        EffectGradient::Solid(g) => {
            let samples = ((g.smoothness.unwrap_or(1.0)) * 4096.0).round();
            // fieldToExtType Grad → name "Gradient", classID "Grdn"
            let mut d = Descriptor::new("Gradient", "Grdn");
            d.set("Nm  ", DescriptorValue::Text(g.name.clone()));
            d.set("GrdF", DescriptorValue::Enum("GrdF.CstS".to_string()));
            d.set("Intr", DescriptorValue::Double(samples));
            let clrs = g
                .color_stops
                .iter()
                .map(|s| {
                    let mut cs = Descriptor::new("", "Clrt");
                    cs.set("Clr ", serialize_color(Some(&s.color)));
                    cs.set("Type", DescriptorValue::Enum("Clry.UsrS".to_string()));
                    cs.set(
                        "Lctn",
                        DescriptorValue::Integer((s.location * samples).round() as i32),
                    );
                    cs.set(
                        "Mdpn",
                        DescriptorValue::Integer((s.midpoint * 100.0).round() as i32),
                    );
                    DescriptorValue::Descriptor(cs)
                })
                .collect();
            d.set("Clrs", DescriptorValue::List(clrs));
            let trns = g
                .opacity_stops
                .iter()
                .map(|s| {
                    let mut ts = Descriptor::new("", "TrnS");
                    ts.set("Opct", units_percent(s.opacity));
                    ts.set(
                        "Lctn",
                        DescriptorValue::Integer((s.location * samples).round() as i32),
                    );
                    ts.set(
                        "Mdpn",
                        DescriptorValue::Integer((s.midpoint * 100.0).round() as i32),
                    );
                    DescriptorValue::Descriptor(ts)
                })
                .collect();
            d.set("Trns", DescriptorValue::List(trns));
            DescriptorValue::Descriptor(d)
        }
        EffectGradient::Noise(g) => {
            // fieldToExtType Grad → name "Gradient", classID "Grdn"
            let mut d = Descriptor::new("Gradient", "Grdn");
            d.set("GrdF", DescriptorValue::Enum("GrdF.ClNs".to_string()));
            d.set("Nm  ", DescriptorValue::Text(g.name.clone()));
            d.set(
                "ShTr",
                DescriptorValue::Boolean(g.add_transparency.unwrap_or(false)),
            );
            d.set(
                "VctC",
                DescriptorValue::Boolean(g.restrict_colors.unwrap_or(false)),
            );
            d.set(
                "ClrS",
                DescriptorValue::Enum(clr_s_encode(
                    g.color_model.unwrap_or(GradientColorModel::Rgb),
                )),
            );
            // typeToField: RndS/Smth/Mnm/Mxm are long.
            d.set(
                "RndS",
                DescriptorValue::Integer(g.random_seed.unwrap_or(0.0).round() as i32),
            );
            d.set(
                "Smth",
                DescriptorValue::Integer((g.roughness.unwrap_or(1.0) * 4096.0).round() as i32),
            );
            let min = if g.min.is_empty() {
                vec![0.0, 0.0, 0.0, 0.0]
            } else {
                g.min.clone()
            };
            let max = if g.max.is_empty() {
                vec![1.0, 1.0, 1.0, 1.0]
            } else {
                g.max.clone()
            };
            d.set(
                "Mnm ",
                DescriptorValue::List(
                    min.iter()
                        .map(|x| DescriptorValue::Integer((x * 100.0).round() as i32))
                        .collect(),
                ),
            );
            d.set(
                "Mxm ",
                DescriptorValue::List(
                    max.iter()
                        .map(|x| DescriptorValue::Integer((x * 100.0).round() as i32))
                        .collect(),
                ),
            );
            DescriptorValue::Descriptor(d)
        }
    }
}

// ===========================================================================
// Small accessors
// ===========================================================================

pub(crate) fn pattern_from(d: &Descriptor) -> EffectPattern {
    let name = d.text("Nm  ").unwrap_or_default();
    let id = d.text("Idnt").unwrap_or_default();
    EffectPattern { name, id }
}

fn point_percent(d: &Descriptor) -> ReadResult<PointF> {
    let x = d.get("Hrzn").map(parse_percent).transpose()?.unwrap_or(1.0);
    let y = d.get("Vrtc").map(parse_percent).transpose()?.unwrap_or(1.0);
    Ok(PointF { x, y })
}

// ===========================================================================
// Per-effect parsers (descriptor -> struct); mirrors branches of parseEffectObject
// ===========================================================================

fn desc_key_order(d: &Descriptor) -> Vec<String> {
    d.items.iter().map(|(k, _)| k.clone()).collect()
}

fn parse_shadow(d: &Descriptor) -> ReadResult<LayerEffectShadow> {
    let mut s = LayerEffectShadow::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.use_global_light = d.bool("uglg");
    s.antialiased = d.bool("AntA");
    s.layer_conceals = d.bool("layerConceals");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(v) = d.get("Clr ") {
        s.color = Some(parse_color(v)?);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        s.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("lagl") {
        s.angle = Some(parse_angle(v)?);
    }
    if let Some(v) = d.get("blur") {
        s.size = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("Ckmt") {
        s.choke = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("Dstn") {
        s.distance = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("Nose") {
        s.noise = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("TrnS") {
        s.contour = Some(parse_contour(v));
    }
    Ok(s)
}

fn parse_outer_glow(d: &Descriptor) -> ReadResult<LayerEffectsOuterGlow> {
    let mut s = LayerEffectsOuterGlow::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.antialiased = d.bool("AntA");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(v) = d.get("Clr ") {
        s.color = Some(parse_color(v)?);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        s.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("glwS") {
        s.source = Some(ig_sr_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("GlwT") {
        s.technique = Some(be_te_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Nose") {
        s.noise = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Inpr") {
        s.range = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("ShdN") {
        s.jitter = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("blur") {
        s.size = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("Ckmt") {
        s.choke = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("TrnS") {
        s.contour = Some(parse_contour(v));
    }
    Ok(s)
}

fn parse_inner_glow(d: &Descriptor) -> ReadResult<LayerEffectInnerGlow> {
    let mut s = LayerEffectInnerGlow::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.antialiased = d.bool("AntA");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(v) = d.get("Clr ") {
        s.color = Some(parse_color(v)?);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        s.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("glwS") {
        s.source = Some(ig_sr_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("GlwT") {
        s.technique = Some(be_te_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Nose") {
        s.noise = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Inpr") {
        s.range = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("ShdN") {
        s.jitter = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("blur") {
        s.size = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("Ckmt") {
        s.choke = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("TrnS") {
        s.contour = Some(parse_contour(v));
    }
    Ok(s)
}

fn parse_bevel(d: &Descriptor) -> ReadResult<LayerEffectBevel> {
    let mut s = LayerEffectBevel::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.use_global_light = d.bool("uglg");
    s.antialias_gloss = d.bool("antialiasGloss");
    s.use_texture = d.bool("useTexture");
    s.use_shape = d.bool("useShape");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(v) = d.get("hglC") {
        s.highlight_color = Some(parse_color(v)?);
    }
    if let Some(v) = d.get("sdwC") {
        s.shadow_color = Some(parse_color(v)?);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("hglM") {
        s.highlight_blend_mode = Some(bln_m_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("sdwM") {
        s.shadow_blend_mode = Some(bln_m_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("bvlS") {
        s.style = Some(be_sl_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("bvlD") {
        s.direction = Some(be_ss_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("bvlT") {
        s.technique = Some(bvl_t_decode(v));
    }
    if let Some(v) = d.get("hglO") {
        s.highlight_opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("sdwO") {
        s.shadow_opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("lagl") {
        s.angle = Some(parse_angle(v)?);
    }
    if let Some(v) = d.get("Lald") {
        s.altitude = Some(parse_angle(v)?);
    }
    if let Some(v) = d.get("Sftn") {
        s.soften = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("srgR") {
        s.strength = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("blur") {
        s.size = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("TrnS") {
        s.contour = Some(parse_contour(v));
    }
    Ok(s)
}

fn parse_solid_fill(d: &Descriptor) -> ReadResult<LayerEffectSolidFill> {
    let mut s = LayerEffectSolidFill::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(v) = d.get("Clr ") {
        s.color = Some(parse_color(v)?);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        s.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    Ok(s)
}

fn parse_satin(d: &Descriptor) -> ReadResult<LayerEffectSatin> {
    let mut s = LayerEffectSatin::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.antialiased = d.bool("AntA");
    s.invert = d.bool("Invr");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(v) = d.get("Clr ") {
        s.color = Some(parse_color(v)?);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        s.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("lagl") {
        s.angle = Some(parse_angle(v)?);
    }
    if let Some(v) = d.get("blur") {
        s.size = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("Dstn") {
        s.distance = Some(parse_units(v)?);
    }
    if let Some(v) = d.get("MpgS") {
        s.contour = Some(parse_contour(v));
    }
    Ok(s)
}

fn parse_gradient_overlay(d: &Descriptor) -> ReadResult<LayerEffectGradientOverlay> {
    let mut s = LayerEffectGradientOverlay::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.dither = d.bool("Dthr");
    s.reverse = d.bool("Rvrs");
    s.align = d.bool("Algn");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        // gradient overlay stores blend mode as String upstream.
        s.blend_mode = Some(blend_mode_string(bln_m_decode(v)));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Type") {
        s.gradient_type = Some(grd_t_decode(v));
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("gs99") {
        s.interpolation_method = Some(gs99_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Scl ") {
        s.scale = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Angl") {
        s.angle = Some(parse_angle(v)?);
    }
    if let Some(DescriptorValue::Descriptor(p)) = d.get("Ofst") {
        s.offset = Some(point_percent(p)?);
    }
    if let Some(v) = d.get("Grad") {
        s.gradient = Some(parse_gradient(v)?);
    }
    Ok(s)
}

fn parse_pattern_overlay(d: &Descriptor) -> ReadResult<LayerEffectPatternOverlay> {
    let mut s = LayerEffectPatternOverlay::default();
    s.key_order = desc_key_order(d);
    s.enabled = d.bool("enab");
    s.align = d.bool("Algn");
    if let Some(v) = d.get("present") {
        s.present = bool_of(v);
    }
    if let Some(v) = d.get("showInDialog") {
        s.show_in_dialog = bool_of(v);
    }
    if let Some(DescriptorValue::Enum(v)) = d.get("Md  ") {
        s.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Scl ") {
        s.scale = Some(parse_percent(v)?);
    }
    // Generic parseEffectObject maps both lagl and Angl → angle.
    if let Some(v) = d.get("lagl").or_else(|| d.get("Angl")) {
        s.angle = Some(parse_angle(v)?);
    }
    if let Some(DescriptorValue::Descriptor(p)) = d.get("Ptrn") {
        s.pattern = Some(pattern_from(p));
    }
    if let Some(DescriptorValue::Descriptor(p)) = d.get("phase") {
        s.phase = Some(PointF {
            x: p.number("Hrzn").unwrap_or_default(),
            y: p.number("Vrtc").unwrap_or_default(),
        });
    }
    Ok(s)
}

/// Mirror of parseFxObject (stroke / FrFX).
fn parse_fx_object(d: &Descriptor) -> ReadResult<LayerEffectStroke> {
    let mut s = LayerEffectStroke::default();
    s.enabled = Some(d.bool("enab").unwrap_or_default());
    s.position = Some(match d.get("Styl") {
        Some(DescriptorValue::Enum(v)) => f_stl_decode(v),
        _ => StrokePosition::Outside,
    });
    s.fill_type = Some(match d.get("PntT") {
        Some(DescriptorValue::Enum(v)) => fr_fl_decode(v),
        _ => StrokeFillType::Color,
    });
    s.blend_mode = Some(match d.get("Md  ") {
        Some(DescriptorValue::Enum(v)) => bln_m_decode(v),
        _ => BlendMode::Normal,
    });
    if let Some(v) = d.get("Opct") {
        s.opacity = Some(parse_percent(v)?);
    }
    if let Some(v) = d.get("Sz  ") {
        s.size = Some(parse_units(v)?);
    }
    s.present = d.bool("present");
    s.show_in_dialog = d.bool("showInDialog");
    s.overprint = d.bool("overprint");
    if let Some(v) = d.get("Clr ") {
        s.color = Some(parse_color(v)?);
    }
    if let Some(v) = d.get("Grad") {
        s.gradient = Some(parse_gradient_content(d, v)?);
    }
    if let Some(DescriptorValue::Descriptor(p)) = d.get("Ptrn") {
        s.pattern = Some(pattern_from(p));
    }
    Ok(s)
}

/// Mirror of parseGradientContent (for stroke.gradient / vector fill).
pub(crate) fn parse_gradient_content(
    d: &Descriptor,
    grad: &DescriptorValue,
) -> ReadResult<GradientWithExtra> {
    let gradient = parse_gradient(grad)?;
    let mut extra = ExtraGradientInfo::default();
    if let Some(DescriptorValue::Enum(v)) = d.get("Type") {
        extra.style = Some(grd_t_decode(v));
    }
    extra.dither = d.bool("Dthr");
    if let Some(DescriptorValue::Enum(v)) = d.get("gradientsInterpolationMethod") {
        extra.interpolation_method = Some(gs99_decode(v));
    }
    extra.reverse = d.bool("Rvrs");
    if let Some(v) = d.get("Angl") {
        extra.angle = Some(parse_angle(v)?);
    }
    if let Some(v) = d.get("Scl ") {
        extra.scale = Some(parse_percent(v)?);
    }
    extra.align = d.bool("Algn");
    if let Some(DescriptorValue::Descriptor(p)) = d.get("Ofst") {
        extra.offset = Some(point_percent(p)?);
    }
    Ok(GradientWithExtra { gradient, extra })
}

fn bool_of(v: &DescriptorValue) -> Option<bool> {
    match v {
        DescriptorValue::Boolean(b) => Some(*b),
        _ => None,
    }
}

// ===========================================================================
// Per-effect serializers (struct -> descriptor); mirrors serializeEffectObject
// ===========================================================================

/// Emit fields in source key order (ag-psd `Object.keys` after parse).
/// `enab` is always first; optional `seed_after_enab` mirrors dropShadow's TrnS seed.
fn finish_effect(
    class_id: &str,
    key_order: &[String],
    values: Vec<(String, DescriptorValue)>,
    seed_after_enab: Option<(String, DescriptorValue)>,
) -> Descriptor {
    let fallback_order: Vec<String> = values.iter().map(|(k, _)| k.clone()).collect();
    let mut map: HashMap<String, DescriptorValue> = values.into_iter().collect();
    let mut d = Descriptor::new("", class_id);
    let enab = map
        .remove("enab")
        .unwrap_or(DescriptorValue::Boolean(false));
    d.set("enab", enab);
    let mut written = HashSet::from(["enab".to_string()]);
    if let Some((k, v)) = seed_after_enab {
        written.insert(k.clone());
        d.set(k, v);
    }
    let order = if key_order.is_empty() {
        &fallback_order
    } else {
        key_order
    };
    for key in order {
        if written.contains(key) {
            continue;
        }
        if let Some(v) = map.remove(key) {
            d.set(key.clone(), v);
            written.insert(key.clone());
        }
    }
    for key in &fallback_order {
        if let Some(v) = map.remove(key) {
            d.set(key.clone(), v);
        }
    }
    d
}

fn push_opt(values: &mut Vec<(String, DescriptorValue)>, key: &str, v: Option<DescriptorValue>) {
    if let Some(v) = v {
        values.push((key.to_string(), v));
    }
}

fn ser_shadow(s: &LayerEffectShadow, is_drop: bool) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode.map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(
        &mut values,
        "Clr ",
        s.color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    push_opt(
        &mut values,
        "uglg",
        s.use_global_light.map(DescriptorValue::Boolean),
    );
    push_opt(&mut values, "lagl", s.angle.map(units_angle));
    push_opt(
        &mut values,
        "Dstn",
        s.distance.map(|v| units_value(Some(v))),
    );
    push_opt(&mut values, "Ckmt", s.choke.map(|v| units_value(Some(v))));
    push_opt(&mut values, "blur", s.size.map(|v| units_value(Some(v))));
    push_opt(&mut values, "Nose", s.noise.map(units_percent));
    push_opt(
        &mut values,
        "AntA",
        s.antialiased.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "layerConceals",
        s.layer_conceals.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    if !is_drop {
        push_opt(
            &mut values,
            "TrnS",
            s.contour.as_ref().map(serialize_contour),
        );
    }
    let seed = if is_drop {
        Some((
            "TrnS".into(),
            s.contour
                .as_ref()
                .map(serialize_contour)
                .unwrap_or_else(empty_contour),
        ))
    } else {
        None
    };
    finish_effect(
        if is_drop { "DrSh" } else { "IrSh" },
        &s.key_order,
        values,
        seed,
    )
}

fn ser_outer_glow(s: &LayerEffectsOuterGlow) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode.map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(
        &mut values,
        "Clr ",
        s.color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    push_opt(
        &mut values,
        "GlwT",
        s.technique.map(|v| DescriptorValue::Enum(be_te_encode(v))),
    );
    push_opt(&mut values, "Ckmt", s.choke.map(|v| units_value(Some(v))));
    push_opt(&mut values, "blur", s.size.map(|v| units_value(Some(v))));
    push_opt(&mut values, "Nose", s.noise.map(units_percent));
    push_opt(&mut values, "ShdN", s.jitter.map(units_percent));
    push_opt(
        &mut values,
        "AntA",
        s.antialiased.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "glwS",
        s.source.map(|v| DescriptorValue::Enum(ig_sr_encode(v))),
    );
    push_opt(
        &mut values,
        "TrnS",
        s.contour.as_ref().map(serialize_contour),
    );
    push_opt(&mut values, "Inpr", s.range.map(units_percent));
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    finish_effect("OrGl", &s.key_order, values, None)
}

fn ser_inner_glow(s: &LayerEffectInnerGlow) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode.map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(
        &mut values,
        "Clr ",
        s.color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    push_opt(
        &mut values,
        "GlwT",
        s.technique.map(|v| DescriptorValue::Enum(be_te_encode(v))),
    );
    push_opt(&mut values, "Ckmt", s.choke.map(|v| units_value(Some(v))));
    push_opt(&mut values, "blur", s.size.map(|v| units_value(Some(v))));
    push_opt(&mut values, "ShdN", s.jitter.map(units_percent));
    push_opt(&mut values, "Nose", s.noise.map(units_percent));
    push_opt(
        &mut values,
        "AntA",
        s.antialiased.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "glwS",
        s.source.map(|v| DescriptorValue::Enum(ig_sr_encode(v))),
    );
    push_opt(
        &mut values,
        "TrnS",
        s.contour.as_ref().map(serialize_contour),
    );
    push_opt(&mut values, "Inpr", s.range.map(units_percent));
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    finish_effect("IrGl", &s.key_order, values, None)
}

fn ser_bevel(s: &LayerEffectBevel) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "hglM",
        s.highlight_blend_mode
            .map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(
        &mut values,
        "hglC",
        s.highlight_color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(&mut values, "hglO", s.highlight_opacity.map(units_percent));
    push_opt(
        &mut values,
        "sdwM",
        s.shadow_blend_mode
            .map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(
        &mut values,
        "sdwC",
        s.shadow_color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(&mut values, "sdwO", s.shadow_opacity.map(units_percent));
    push_opt(
        &mut values,
        "bvlT",
        s.technique.map(|v| DescriptorValue::Enum(bvl_t_encode(v))),
    );
    push_opt(
        &mut values,
        "bvlS",
        s.style.map(|v| DescriptorValue::Enum(be_sl_encode(v))),
    );
    push_opt(
        &mut values,
        "uglg",
        s.use_global_light.map(DescriptorValue::Boolean),
    );
    push_opt(&mut values, "lagl", s.angle.map(units_angle));
    push_opt(&mut values, "Lald", s.altitude.map(units_angle));
    push_opt(&mut values, "srgR", s.strength.map(units_percent));
    push_opt(&mut values, "blur", s.size.map(|v| units_value(Some(v))));
    push_opt(
        &mut values,
        "bvlD",
        s.direction.map(|v| DescriptorValue::Enum(be_ss_encode(v))),
    );
    push_opt(
        &mut values,
        "TrnS",
        s.contour.as_ref().map(serialize_contour),
    );
    push_opt(
        &mut values,
        "antialiasGloss",
        s.antialias_gloss.map(DescriptorValue::Boolean),
    );
    push_opt(&mut values, "Sftn", s.soften.map(|v| units_value(Some(v))));
    push_opt(
        &mut values,
        "useShape",
        s.use_shape.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "useTexture",
        s.use_texture.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    finish_effect("ebbl", &s.key_order, values, None)
}

fn ser_solid_fill(s: &LayerEffectSolidFill) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode.map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    push_opt(
        &mut values,
        "Clr ",
        s.color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    finish_effect("SoFi", &s.key_order, values, None)
}

fn ser_satin(s: &LayerEffectSatin) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode.map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(
        &mut values,
        "Clr ",
        s.color.as_ref().map(|v| serialize_color(Some(v))),
    );
    push_opt(
        &mut values,
        "AntA",
        s.antialiased.map(DescriptorValue::Boolean),
    );
    push_opt(&mut values, "Invr", s.invert.map(DescriptorValue::Boolean));
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    push_opt(&mut values, "lagl", s.angle.map(units_angle));
    push_opt(
        &mut values,
        "Dstn",
        s.distance.map(|v| units_value(Some(v))),
    );
    push_opt(&mut values, "blur", s.size.map(|v| units_value(Some(v))));
    push_opt(
        &mut values,
        "MpgS",
        s.contour.as_ref().map(serialize_contour),
    );
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    finish_effect("ChFX", &s.key_order, values, None)
}

fn ser_gradient_overlay(s: &LayerEffectGradientOverlay) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode
            .as_ref()
            .map(|v| DescriptorValue::Enum(bln_m_encode(blend_mode_from_string(v)))),
    );
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    push_opt(
        &mut values,
        "Grad",
        s.gradient.as_ref().map(serialize_gradient),
    );
    push_opt(&mut values, "Angl", s.angle.map(units_angle));
    push_opt(
        &mut values,
        "Type",
        s.gradient_type
            .map(|v| DescriptorValue::Enum(grd_t_encode(v))),
    );
    push_opt(&mut values, "Rvrs", s.reverse.map(DescriptorValue::Boolean));
    push_opt(&mut values, "Dthr", s.dither.map(DescriptorValue::Boolean));
    push_opt(
        &mut values,
        "gs99",
        s.interpolation_method
            .map(|v| DescriptorValue::Enum(gs99_encode(v))),
    );
    push_opt(&mut values, "Algn", s.align.map(DescriptorValue::Boolean));
    push_opt(&mut values, "Scl ", s.scale.map(units_percent));
    if let Some(p) = s.offset.as_ref() {
        let mut off = Descriptor::new("", "Pnt ");
        off.set("Hrzn", units_percent(p.x));
        off.set("Vrtc", units_percent(p.y));
        values.push(("Ofst".into(), DescriptorValue::Descriptor(off)));
    }
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    finish_effect("GrFl", &s.key_order, values, None)
}

fn ser_pattern_overlay(s: &LayerEffectPatternOverlay) -> Descriptor {
    let mut values = vec![(
        "enab".into(),
        DescriptorValue::Boolean(s.enabled.unwrap_or(false)),
    )];
    push_opt(
        &mut values,
        "Md  ",
        s.blend_mode.map(|v| DescriptorValue::Enum(bln_m_encode(v))),
    );
    push_opt(&mut values, "Opct", s.opacity.map(units_percent));
    if let Some(p) = s.pattern.as_ref() {
        let mut pat = Descriptor::new("", "Ptrn");
        pat.set("Nm  ", DescriptorValue::Text(p.name.clone()));
        pat.set("Idnt", DescriptorValue::Text(p.id.clone()));
        values.push(("Ptrn".into(), DescriptorValue::Descriptor(pat)));
    }
    // objName `patternOverlay` → angle always writes as lagl (even if source had Angl).
    push_opt(&mut values, "lagl", s.angle.map(units_angle));
    push_opt(&mut values, "Scl ", s.scale.map(units_percent));
    push_opt(&mut values, "Algn", s.align.map(DescriptorValue::Boolean));
    if let Some(p) = s.phase.as_ref() {
        let mut ph = Descriptor::new("", "Pnt ");
        ph.set("Hrzn", DescriptorValue::Double(p.x));
        ph.set("Vrtc", DescriptorValue::Double(p.y));
        values.push(("phase".into(), DescriptorValue::Descriptor(ph)));
    }
    push_opt(
        &mut values,
        "present",
        s.present.map(DescriptorValue::Boolean),
    );
    push_opt(
        &mut values,
        "showInDialog",
        s.show_in_dialog.map(DescriptorValue::Boolean),
    );
    // Map source Angl → lagl so key_order matches serializeEffectObject output.
    let key_order: Vec<String> = s
        .key_order
        .iter()
        .map(|k| {
            if k == "Angl" {
                "lagl".into()
            } else {
                k.clone()
            }
        })
        .collect();
    finish_effect("patternFill", &key_order, values, None)
}

/// Mirror of serializeFxObject (stroke / FrFX).
fn ser_fx_object(s: &LayerEffectStroke) -> Descriptor {
    let mut d = Descriptor::new("", "FrFX");
    d.set("enab", DescriptorValue::Boolean(s.enabled.unwrap_or(false)));
    if let Some(v) = s.present {
        d.set("present", DescriptorValue::Boolean(v));
    }
    if let Some(v) = s.show_in_dialog {
        d.set("showInDialog", DescriptorValue::Boolean(v));
    }
    d.set(
        "Styl",
        DescriptorValue::Enum(f_stl_encode(s.position.unwrap_or(StrokePosition::Outside))),
    );
    d.set(
        "PntT",
        DescriptorValue::Enum(fr_fl_encode(s.fill_type.unwrap_or(StrokeFillType::Color))),
    );
    d.set(
        "Md  ",
        DescriptorValue::Enum(bln_m_encode(s.blend_mode.unwrap_or(BlendMode::Normal))),
    );
    d.set("Opct", units_percent(s.opacity.unwrap_or(0.0)));
    d.set("Sz  ", units_value(s.size));
    if let Some(v) = s.color.as_ref() {
        d.set("Clr ", serialize_color(Some(v)));
    }
    if let Some(g) = s.gradient.as_ref() {
        // spread serializeGradientContent fields onto FrFX.
        ser_gradient_content_into(&mut d, g);
    }
    if let Some(p) = s.pattern.as_ref() {
        ser_pattern_content_into(&mut d, p, None, None);
    }
    if let Some(v) = s.overprint {
        d.set("overprint", DescriptorValue::Boolean(v));
    }
    d
}

/// Mirror of serializeGradientContent (is spread into FrFX / GdFl).
pub(crate) fn ser_gradient_content_into(d: &mut Descriptor, g: &GradientWithExtra) {
    let e = &g.extra;
    if let Some(v) = e.dither {
        d.set("Dthr", DescriptorValue::Boolean(v));
    }
    if let Some(v) = e.interpolation_method {
        d.set(
            "gradientsInterpolationMethod",
            DescriptorValue::Enum(gs99_encode(v)),
        );
    }
    if let Some(v) = e.reverse {
        d.set("Rvrs", DescriptorValue::Boolean(v));
    }
    if let Some(v) = e.angle {
        d.set("Angl", units_angle(v));
    }
    d.set(
        "Type",
        DescriptorValue::Enum(grd_t_encode(e.style.unwrap_or(GradientStyle::Linear))),
    );
    if let Some(v) = e.align {
        d.set("Algn", DescriptorValue::Boolean(v));
    }
    if let Some(v) = e.scale {
        d.set("Scl ", units_percent(v));
    }
    if let Some(p) = e.offset.as_ref() {
        let mut off = Descriptor::new("", "Pnt ");
        off.set("Hrzn", units_percent(p.x));
        off.set("Vrtc", units_percent(p.y));
        d.set("Ofst", DescriptorValue::Descriptor(off));
    }
    d.set("Grad", serialize_gradient(&g.gradient));
}

/// Mirror of serializePatternContent (is spread into FrFX / PtFl).
pub(crate) fn ser_pattern_content_into(
    d: &mut Descriptor,
    p: &EffectPattern,
    linked: Option<bool>,
    phase: Option<PointF>,
) {
    let mut pat = Descriptor::new("", "Ptrn");
    pat.set("Nm  ", DescriptorValue::Text(p.name.clone()));
    pat.set("Idnt", DescriptorValue::Text(p.id.clone()));
    d.set("Ptrn", DescriptorValue::Descriptor(pat));
    if let Some(v) = linked {
        d.set("Lnkd", DescriptorValue::Boolean(v));
    }
    if let Some(p) = phase {
        let mut ph = Descriptor::new("", "Pnt ");
        ph.set("Hrzn", DescriptorValue::Double(p.x));
        ph.set("Vrtc", DescriptorValue::Double(p.y));
        d.set("phase", DescriptorValue::Descriptor(ph));
    }
}

// ===========================================================================
// BlendMode <-> String (gradient overlay stores blend mode as String)
// ===========================================================================

fn blend_mode_string(m: BlendMode) -> String {
    blend_mode_to_str(m).to_string()
}

fn blend_mode_from_string(s: &str) -> BlendMode {
    BLEND_MODE_STR
        .iter()
        .find(|(name, _)| *name == s)
        .map(|(_, m)| *m)
        .unwrap_or(BlendMode::Normal)
}

fn blend_mode_to_str(m: BlendMode) -> &'static str {
    BLEND_MODE_STR
        .iter()
        .find(|(_, v)| *v == m)
        .map(|(name, _)| *name)
        .unwrap_or("normal")
}

const BLEND_MODE_STR: &[(&str, BlendMode)] = crate::psd::BLEND_MODE_JSON;

// ===========================================================================
// parseEffects / serializeEffects
// ===========================================================================

/// Mirror of `parseEffects(info, log)`.
pub fn parse_effects(info: &Descriptor) -> ReadResult<LayerEffectsInfo> {
    let mut e = LayerEffectsInfo::default();

    // masterFXSwitch: if (!masterFXSwitch) effects.disabled = true;
    let master = info.bool("masterFXSwitch").unwrap_or_default();
    if !master {
        e.disabled = Some(true);
    }
    if let Some(v) = info.get("Scl ") {
        e.scale = Some(parse_percent(v)?);
    }

    if let Some(d) = info.descriptor("DrSh") {
        e.drop_shadow = Some(vec![parse_shadow(d)?]);
    }
    if let Some(l) = info.list("dropShadowMulti") {
        e.drop_shadow = Some(map_desc_list(l, parse_shadow)?);
    }
    if let Some(d) = info.descriptor("IrSh") {
        e.inner_shadow = Some(vec![parse_shadow(d)?]);
    }
    if let Some(l) = info.list("innerShadowMulti") {
        e.inner_shadow = Some(map_desc_list(l, parse_shadow)?);
    }
    if let Some(d) = info.descriptor("OrGl") {
        e.outer_glow = Some(parse_outer_glow(d)?);
    }
    if let Some(d) = info.descriptor("IrGl") {
        e.inner_glow = Some(parse_inner_glow(d)?);
    }
    if let Some(d) = info.descriptor("ebbl") {
        e.bevel = Some(parse_bevel(d)?);
    }
    if let Some(d) = info.descriptor("SoFi") {
        e.solid_fill = Some(vec![parse_solid_fill(d)?]);
    }
    if let Some(l) = info.list("solidFillMulti") {
        e.solid_fill = Some(map_desc_list(l, parse_solid_fill)?);
    }
    if let Some(d) = info.descriptor("patternFill") {
        e.pattern_overlay = Some(parse_pattern_overlay(d)?);
    }
    if let Some(d) = info.descriptor("GrFl") {
        e.gradient_overlay = Some(vec![parse_gradient_overlay(d)?]);
    }
    if let Some(l) = info.list("gradientFillMulti") {
        e.gradient_overlay = Some(map_desc_list(l, parse_gradient_overlay)?);
    }
    if let Some(d) = info.descriptor("ChFX") {
        e.satin = Some(parse_satin(d)?);
    }
    if let Some(d) = info.descriptor("FrFX") {
        e.stroke = Some(vec![parse_fx_object(d)?]);
    }
    if let Some(l) = info.list("frameFXMulti") {
        e.stroke = Some(map_desc_list(l, parse_fx_object)?);
    }

    Ok(e)
}

fn map_desc_list<T>(
    list: &[DescriptorValue],
    f: impl Fn(&Descriptor) -> ReadResult<T>,
) -> ReadResult<Vec<T>> {
    list.iter()
        .map(|it| match it {
            DescriptorValue::Descriptor(d) => f(d),
            _ => Err(ReadError::StrictViolation(
                "Expected descriptor in list".to_string(),
            )),
        })
        .collect()
}

/// Mirror of `serializeEffects(e, log, multi)`.
pub fn serialize_effects(e: &LayerEffectsInfo, multi: bool) -> ReadResult<Descriptor> {
    let mut info = Descriptor::new("", "null");
    if multi {
        info.set("Scl ", units_percent_f(e.scale.unwrap_or(1.0)));
        info.set(
            "masterFXSwitch",
            DescriptorValue::Boolean(!e.disabled.unwrap_or(false)),
        );
    } else {
        info.set(
            "masterFXSwitch",
            DescriptorValue::Boolean(!e.disabled.unwrap_or(false)),
        );
        info.set("Scl ", units_percent_f(e.scale.unwrap_or(1.0)));
    }

    fn use_multi<T>(arr: &Option<Vec<T>>, multi: bool) -> bool {
        multi && arr.as_ref().map(|a| a.len() > 1).unwrap_or(false)
    }
    fn use_single<T>(arr: &Option<Vec<T>>, multi: bool) -> bool {
        arr.as_ref()
            .map(|a| !a.is_empty() && (!multi || a.len() == 1))
            .unwrap_or(false)
    }

    // dropShadow
    if use_single(&e.drop_shadow, multi) {
        let s = &e.drop_shadow.as_ref().unwrap()[0];
        info.set("DrSh", DescriptorValue::Descriptor(ser_shadow(s, true)));
    }
    if use_multi(&e.drop_shadow, multi) {
        let list = e
            .drop_shadow
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| DescriptorValue::Descriptor(ser_shadow(s, true)))
            .collect();
        info.set("dropShadowMulti", DescriptorValue::List(list));
    }
    // innerShadow
    if use_single(&e.inner_shadow, multi) {
        let s = &e.inner_shadow.as_ref().unwrap()[0];
        info.set("IrSh", DescriptorValue::Descriptor(ser_shadow(s, false)));
    }
    if use_multi(&e.inner_shadow, multi) {
        let list = e
            .inner_shadow
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| DescriptorValue::Descriptor(ser_shadow(s, false)))
            .collect();
        info.set("innerShadowMulti", DescriptorValue::List(list));
    }
    // outerGlow
    if let Some(s) = e.outer_glow.as_ref() {
        info.set("OrGl", DescriptorValue::Descriptor(ser_outer_glow(s)));
    }
    // solidFill multi
    if use_multi(&e.solid_fill, multi) {
        let list = e
            .solid_fill
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| DescriptorValue::Descriptor(ser_solid_fill(s)))
            .collect();
        info.set("solidFillMulti", DescriptorValue::List(list));
    }
    // gradientOverlay multi
    if use_multi(&e.gradient_overlay, multi) {
        let list = e
            .gradient_overlay
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| DescriptorValue::Descriptor(ser_gradient_overlay(s)))
            .collect();
        info.set("gradientFillMulti", DescriptorValue::List(list));
    }
    // stroke multi
    if use_multi(&e.stroke, multi) {
        let list = e
            .stroke
            .as_ref()
            .unwrap()
            .iter()
            .map(|s| DescriptorValue::Descriptor(ser_fx_object(s)))
            .collect();
        info.set("frameFXMulti", DescriptorValue::List(list));
    }
    // innerGlow
    if let Some(s) = e.inner_glow.as_ref() {
        info.set("IrGl", DescriptorValue::Descriptor(ser_inner_glow(s)));
    }
    // bevel
    if let Some(s) = e.bevel.as_ref() {
        info.set("ebbl", DescriptorValue::Descriptor(ser_bevel(s)));
    }
    // solidFill single
    if use_single(&e.solid_fill, multi) {
        let s = &e.solid_fill.as_ref().unwrap()[0];
        info.set("SoFi", DescriptorValue::Descriptor(ser_solid_fill(s)));
    }
    // patternOverlay
    if let Some(s) = e.pattern_overlay.as_ref() {
        info.set(
            "patternFill",
            DescriptorValue::Descriptor(ser_pattern_overlay(s)),
        );
    }
    // gradientOverlay single
    if use_single(&e.gradient_overlay, multi) {
        let s = &e.gradient_overlay.as_ref().unwrap()[0];
        info.set("GrFl", DescriptorValue::Descriptor(ser_gradient_overlay(s)));
    }
    // satin
    if let Some(s) = e.satin.as_ref() {
        info.set("ChFX", DescriptorValue::Descriptor(ser_satin(s)));
    }
    // stroke single
    if use_single(&e.stroke, multi) {
        let s = &e.stroke.as_ref().unwrap()[0];
        info.set("FrFX", DescriptorValue::Descriptor(ser_fx_object(s)));
    }

    if multi {
        let mut num: i32 = 0;
        num += count_enabled_vec(&e.drop_shadow, |s: &LayerEffectShadow| {
            s.enabled.unwrap_or(false)
        });
        num += count_enabled_vec(&e.inner_shadow, |s: &LayerEffectShadow| {
            s.enabled.unwrap_or(false)
        });
        num += count_enabled_vec(&e.solid_fill, |s: &LayerEffectSolidFill| {
            s.enabled.unwrap_or(false)
        });
        num += count_enabled_vec(&e.stroke, |s: &LayerEffectStroke| {
            s.enabled.unwrap_or(false)
        });
        num += count_enabled_vec(&e.gradient_overlay, |s: &LayerEffectGradientOverlay| {
            s.enabled.unwrap_or(false)
        });
        if e.outer_glow
            .as_ref()
            .map(|s| s.enabled.unwrap_or(false))
            .unwrap_or(false)
        {
            num += 1;
        }
        if e.inner_glow
            .as_ref()
            .map(|s| s.enabled.unwrap_or(false))
            .unwrap_or(false)
        {
            num += 1;
        }
        if e.bevel
            .as_ref()
            .map(|s| s.enabled.unwrap_or(false))
            .unwrap_or(false)
        {
            num += 1;
        }
        if e.satin
            .as_ref()
            .map(|s| s.enabled.unwrap_or(false))
            .unwrap_or(false)
        {
            num += 1;
        }
        if e.pattern_overlay
            .as_ref()
            .map(|s| s.enabled.unwrap_or(false))
            .unwrap_or(false)
        {
            num += 1;
        }
        info.set("numModifyingFX", DescriptorValue::Integer(num));
    }

    Ok(info)
}

fn count_enabled_vec<T>(v: &Option<Vec<T>>, enabled: impl Fn(&T) -> bool) -> i32 {
    v.as_ref()
        .map(|a| a.iter().filter(|x| enabled(x)).count() as i32)
        .unwrap_or(0)
}

// ===========================================================================
// Tests
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::psd::{Rgb, Units};
    use crate::reader::PsdReader;
    use crate::writer::create_writer_default;

    fn rgb(r: f64, g: f64, b: f64) -> Color {
        Color::Rgb(Rgb { r, g, b })
    }

    fn px(v: f64) -> UnitsValue {
        UnitsValue {
            units: Units::Pixels,
            value: v,
        }
    }

    fn round_trip_descriptor(e: &LayerEffectsInfo) -> LayerEffectsInfo {
        let desc = serialize_effects(e, true).expect("serialize");
        let mut w = create_writer_default();
        write_uint32(&mut w, 0);
        write_version_and_descriptor(&mut w, &desc);
        let buf = w.to_bytes();
        let mut r = PsdReader::new(&buf, None, None);
        let version = read_uint32(&mut r).unwrap();
        assert_eq!(version, 0);
        let read_desc = read_version_and_descriptor(&mut r).expect("read desc");
        parse_effects(&read_desc).expect("parse")
    }

    #[test]
    fn lfx2_drop_shadow_and_solid_fill_round_trip() {
        let e = LayerEffectsInfo {
            scale: Some(1.0),
            drop_shadow: Some(vec![LayerEffectShadow {
                enabled: Some(true),
                use_global_light: Some(true),
                size: Some(px(5.0)),
                distance: Some(px(3.0)),
                angle: Some(120.0),
                color: Some(rgb(10.0, 20.0, 30.0)),
                blend_mode: Some(BlendMode::Multiply),
                opacity: Some(0.5),
                ..LayerEffectShadow::default()
            }]),
            solid_fill: Some(vec![LayerEffectSolidFill {
                enabled: Some(true),
                blend_mode: Some(BlendMode::Normal),
                color: Some(rgb(255.0, 128.0, 0.0)),
                opacity: Some(1.0),
                ..LayerEffectSolidFill::default()
            }]),
            ..LayerEffectsInfo::default()
        };

        let out = round_trip_descriptor(&e);

        // disabled should remain unset (masterFXSwitch true).
        assert_eq!(out.disabled, None);
        assert!((out.scale.unwrap() - 1.0).abs() < 1e-9);

        let ds = &out.drop_shadow.as_ref().unwrap()[0];
        assert_eq!(ds.enabled, Some(true));
        assert_eq!(ds.use_global_light, Some(true));
        assert_eq!(ds.size.unwrap().value, 5.0);
        assert_eq!(ds.distance.unwrap().value, 3.0);
        assert_eq!(ds.angle.unwrap(), 120.0);
        assert_eq!(ds.blend_mode, Some(BlendMode::Multiply));
        // opacity 0.5 -> units_percent rounds 50 -> 0.5
        assert!((ds.opacity.unwrap() - 0.5).abs() < 1e-9);
        assert_eq!(ds.color, Some(rgb(10.0, 20.0, 30.0)));
        // default empty contour written for drop shadow.
        assert!(ds.contour.is_some());

        let sf = &out.solid_fill.as_ref().unwrap()[0];
        assert_eq!(sf.enabled, Some(true));
        assert_eq!(sf.blend_mode, Some(BlendMode::Normal));
        assert_eq!(sf.color, Some(rgb(255.0, 128.0, 0.0)));
        assert!((sf.opacity.unwrap() - 1.0).abs() < 1e-9);
    }

    #[test]
    fn lfx2_disabled_and_outer_glow() {
        let e = LayerEffectsInfo {
            disabled: Some(true),
            outer_glow: Some(LayerEffectsOuterGlow {
                enabled: Some(true),
                size: Some(px(7.0)),
                color: Some(rgb(1.0, 2.0, 3.0)),
                blend_mode: Some(BlendMode::Screen),
                opacity: Some(0.75),
                source: Some(GlowSource::Edge),
                ..LayerEffectsOuterGlow::default()
            }),
            ..LayerEffectsInfo::default()
        };

        let out = round_trip_descriptor(&e);
        assert_eq!(out.disabled, Some(true));
        let og = out.outer_glow.as_ref().unwrap();
        assert_eq!(og.enabled, Some(true));
        assert_eq!(og.size.unwrap().value, 7.0);
        assert_eq!(og.blend_mode, Some(BlendMode::Screen));
        assert!((og.opacity.unwrap() - 0.75).abs() < 1e-9);
        assert_eq!(og.source, Some(GlowSource::Edge));
        assert_eq!(og.color, Some(rgb(1.0, 2.0, 3.0)));
    }

    #[test]
    fn lr_fx_legacy_round_trip() {
        // lrFX delegates to effects_helpers::{write_effects, read_effects}.
        let mut info = LayerAdditionalInfo::default();
        info.effects = Some(LayerEffectsInfo {
            drop_shadow: Some(vec![LayerEffectShadow {
                enabled: Some(true),
                use_global_light: Some(true),
                size: Some(px(5.0)),
                distance: Some(px(3.0)),
                angle: Some(90.0),
                color: Some(rgb(10.0, 20.0, 30.0)),
                blend_mode: Some(BlendMode::Multiply),
                opacity: Some(0.5),
                ..LayerEffectShadow::default()
            }]),
            ..LayerEffectsInfo::default()
        });

        // has(lrFX) should be true.
        assert_eq!(has("lrFX", &info), Some(true));

        let mut w = create_writer_default();
        let mut wctx = WriteCtx::new(default_write_options(), false);
        let res = write("lrFX", &mut w, &info, &mut wctx);
        assert!(matches!(res, Some(Ok(()))));
        let buf = w.to_bytes();

        let mut r = PsdReader::new(&buf, None, None);
        let mut out = LayerAdditionalInfo::default();
        let len = buf.len();
        let left = move |reader: &PsdReader| len - reader.offset;
        let opts = default_read_options();
        let mut rctx = ReadCtx::new(&opts, false);
        let handled = read("lrFX", &mut r, &mut out, &left, &mut rctx).expect("read");
        assert!(handled.is_some());

        let ds = &out.effects.as_ref().unwrap().drop_shadow.as_ref().unwrap()[0];
        assert_eq!(ds.size.unwrap().value, 5.0);
        assert_eq!(ds.angle.unwrap(), 90.0);
        assert_eq!(ds.blend_mode, Some(BlendMode::Multiply));
        assert_eq!(ds.enabled, Some(true));
    }

    #[test]
    fn has_multi_effects_detection() {
        let mut e = LayerEffectsInfo::default();
        e.drop_shadow = Some(vec![LayerEffectShadow::default()]);
        assert!(!has_multi_effects(&e));
        e.drop_shadow = Some(vec![
            LayerEffectShadow::default(),
            LayerEffectShadow::default(),
        ]);
        assert!(has_multi_effects(&e));
    }

    fn default_write_options() -> &'static crate::psd::WriteOptions {
        use std::sync::OnceLock;
        static OPTS: OnceLock<crate::psd::WriteOptions> = OnceLock::new();
        OPTS.get_or_init(crate::psd::WriteOptions::default)
    }

    fn default_read_options() -> crate::psd::ReadOptions {
        crate::psd::ReadOptions::default()
    }
}

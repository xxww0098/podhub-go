//! Vector fill / stroke descriptor helpers (`parseVectorContent` / `vstk`).
//!
//! Shared by [`super::vector_keys`] so that module stays under the 1000-line cap.

use crate::additional_info::effects_keys::{
    bln_m_decode, bln_m_encode, parse_gradient_content, pattern_from, ser_gradient_content_into,
    ser_pattern_content_into, units_percent,
};
use crate::descriptor::{
    Descriptor, DescriptorValue, parse_color, parse_percent, parse_units, serialize_color,
    units_value,
};
use crate::descriptor_enums;
use crate::psd::{
    Color, EffectGradient, ExtraPatternInfo, GradientWithExtra, LineAlignment, LineCapType,
    LineJoinType, PointF, Rgb, Units, UnitsValue, VectorContent, VectorStroke,
};
use crate::reader::{ReadError, ReadResult};

fn dv_f64(v: &DescriptorValue) -> Option<f64> {
    match v {
        DescriptorValue::Double(x) => Some(*x),
        DescriptorValue::Integer(x) => Some(*x as f64),
        DescriptorValue::UnitDouble(u) => Some(u.value),
        _ => None,
    }
}

/// Upstream `parseVectorContent`.
pub(crate) fn parse_vector_content(d: &Descriptor) -> ReadResult<VectorContent> {
    if let Some(grad) = d.get("Grad") {
        let gwe = parse_gradient_content(d, grad)?;
        return Ok(match gwe.gradient {
            EffectGradient::Solid(g) => VectorContent::SolidGradient {
                gradient: g,
                extra: gwe.extra,
            },
            EffectGradient::Noise(g) => VectorContent::NoiseGradient {
                gradient: g,
                extra: gwe.extra,
            },
        });
    }
    if let Some(DescriptorValue::Descriptor(p)) = d.get("Ptrn") {
        let pattern = pattern_from(p);
        let mut extra = ExtraPatternInfo::default();
        if let Some(DescriptorValue::Boolean(b)) = d.get("Lnkd") {
            extra.linked = Some(*b);
        }
        if let Some(DescriptorValue::Descriptor(ph)) = d.get("phase") {
            extra.phase = Some(PointF {
                x: ph.get("Hrzn").and_then(dv_f64).unwrap_or(0.0),
                y: ph.get("Vrtc").and_then(dv_f64).unwrap_or(0.0),
            });
        }
        return Ok(VectorContent::Pattern { pattern, extra });
    }
    if let Some(DescriptorValue::Descriptor(clr)) = d.get("Clr ") {
        return Ok(VectorContent::Color(parse_color(clr)?));
    }
    Err(ReadError::StrictViolation(
        "Invalid vector content".to_string(),
    ))
}

/// Upstream `serializeVectorContent` → `(descriptor, section key)`.
///
/// Top-level `SoCo`/`GdFl`/`PtFl` writers use classID `null`. Callers that nest
/// the descriptor as `strokeStyleContent` should remap classID to
/// `solidColorLayer` / `gradientLayer` / `patternLayer`.
pub(crate) fn serialize_vector_content(
    content: &VectorContent,
) -> ReadResult<(Descriptor, &'static str)> {
    match content {
        VectorContent::Color(color) => {
            let mut d = Descriptor::new("", "null");
            d.set(
                "Clr ",
                DescriptorValue::Descriptor(serialize_color(Some(color))),
            );
            Ok((d, "SoCo"))
        }
        VectorContent::SolidGradient { gradient, extra } => {
            let mut d = Descriptor::new("", "null");
            ser_gradient_content_into(
                &mut d,
                &GradientWithExtra {
                    gradient: EffectGradient::Solid(gradient.clone()),
                    extra: extra.clone(),
                },
            );
            Ok((d, "GdFl"))
        }
        VectorContent::NoiseGradient { gradient, extra } => {
            let mut d = Descriptor::new("", "null");
            ser_gradient_content_into(
                &mut d,
                &GradientWithExtra {
                    gradient: EffectGradient::Noise(gradient.clone()),
                    extra: extra.clone(),
                },
            );
            Ok((d, "GdFl"))
        }
        VectorContent::Pattern { pattern, extra } => {
            let mut d = Descriptor::new("", "null");
            ser_pattern_content_into(&mut d, pattern, extra.linked, extra.phase);
            Ok((d, "PtFl"))
        }
    }
}

fn stroke_content_class(key: &str) -> &'static str {
    match key {
        "GdFl" => "gradientLayer",
        "PtFl" => "patternLayer",
        _ => "solidColorLayer",
    }
}

fn decode_line_cap(val: &str) -> LineCapType {
    match descriptor_enums::stroke_style_line_cap_type()
        .decode(val)
        .unwrap_or_else(|_| "butt".into())
        .as_str()
    {
        "round" => LineCapType::Round,
        "square" => LineCapType::Square,
        _ => LineCapType::Butt,
    }
}

fn encode_line_cap(val: Option<LineCapType>) -> String {
    let name = match val {
        Some(LineCapType::Round) => "round",
        Some(LineCapType::Square) => "square",
        _ => "butt",
    };
    descriptor_enums::stroke_style_line_cap_type()
        .encode(Some(name))
        .unwrap_or_else(|_| "strokeStyleLineCapType.strokeStyleButtCap".into())
}

fn decode_line_join(val: &str) -> LineJoinType {
    match descriptor_enums::stroke_style_line_join_type()
        .decode(val)
        .unwrap_or_else(|_| "miter".into())
        .as_str()
    {
        "round" => LineJoinType::Round,
        "bevel" => LineJoinType::Bevel,
        _ => LineJoinType::Miter,
    }
}

fn encode_line_join(val: Option<LineJoinType>) -> String {
    let name = match val {
        Some(LineJoinType::Round) => "round",
        Some(LineJoinType::Bevel) => "bevel",
        _ => "miter",
    };
    descriptor_enums::stroke_style_line_join_type()
        .encode(Some(name))
        .unwrap_or_else(|_| "strokeStyleLineJoinType.strokeStyleMiterJoin".into())
}

fn decode_line_align(val: &str) -> LineAlignment {
    match descriptor_enums::stroke_style_line_alignment()
        .decode(val)
        .unwrap_or_else(|_| "inside".into())
        .as_str()
    {
        "center" => LineAlignment::Center,
        "outside" => LineAlignment::Outside,
        _ => LineAlignment::Inside,
    }
}

fn encode_line_align(val: Option<LineAlignment>) -> String {
    let name = match val {
        Some(LineAlignment::Center) => "center",
        Some(LineAlignment::Outside) => "outside",
        _ => "inside",
    };
    descriptor_enums::stroke_style_line_alignment()
        .encode(Some(name))
        .unwrap_or_else(|_| "strokeStyleLineAlignment.strokeStyleAlignInside".into())
}

/// Upstream `vstk` read body.
pub(crate) fn parse_vector_stroke(desc: &Descriptor) -> ReadResult<VectorStroke> {
    let mut stroke = VectorStroke::default();
    if let Some(DescriptorValue::Boolean(b)) = desc.get("strokeEnabled") {
        stroke.stroke_enabled = Some(*b);
    }
    if let Some(DescriptorValue::Boolean(b)) = desc.get("fillEnabled") {
        stroke.fill_enabled = Some(*b);
    }
    if let Some(v) = desc.get("strokeStyleLineWidth") {
        stroke.line_width = Some(parse_units(v)?);
    }
    if let Some(v) = desc.get("strokeStyleLineDashOffset") {
        stroke.line_dash_offset = Some(parse_units(v)?);
    }
    if let Some(v) = desc.get("strokeStyleMiterLimit").and_then(dv_f64) {
        stroke.miter_limit = Some(v);
    }
    if let Some(DescriptorValue::Enum(v)) = desc.get("strokeStyleLineCapType") {
        stroke.line_cap_type = Some(decode_line_cap(v));
    }
    if let Some(DescriptorValue::Enum(v)) = desc.get("strokeStyleLineJoinType") {
        stroke.line_join_type = Some(decode_line_join(v));
    }
    if let Some(DescriptorValue::Enum(v)) = desc.get("strokeStyleLineAlignment") {
        stroke.line_alignment = Some(decode_line_align(v));
    }
    if let Some(DescriptorValue::Boolean(b)) = desc.get("strokeStyleScaleLock") {
        stroke.scale_lock = Some(*b);
    }
    if let Some(DescriptorValue::Boolean(b)) = desc.get("strokeStyleStrokeAdjust") {
        stroke.stroke_adjust = Some(*b);
    }
    if let Some(DescriptorValue::List(items)) = desc.get("strokeStyleLineDashSet") {
        let mut dashes = Vec::with_capacity(items.len());
        for item in items {
            dashes.push(parse_units(item)?);
        }
        stroke.line_dash_set = Some(dashes);
    }
    if let Some(DescriptorValue::Enum(v)) = desc.get("strokeStyleBlendMode") {
        stroke.blend_mode = Some(bln_m_decode(v));
    }
    if let Some(v) = desc.get("strokeStyleOpacity") {
        stroke.opacity = Some(parse_percent(v)?);
    }
    if let Some(DescriptorValue::Descriptor(content)) = desc.get("strokeStyleContent") {
        stroke.content = Some(parse_vector_content(content)?);
    }
    if let Some(v) = desc.get("strokeStyleResolution").and_then(dv_f64) {
        stroke.resolution = Some(v);
    }
    Ok(stroke)
}

/// Upstream `vstk` write body → strokeStyle descriptor.
pub(crate) fn serialize_vector_stroke(stroke: &VectorStroke) -> ReadResult<Descriptor> {
    let mut desc = Descriptor::new("", "strokeStyle");
    desc.set("strokeStyleVersion", DescriptorValue::Integer(2));
    desc.set(
        "strokeEnabled",
        DescriptorValue::Boolean(stroke.stroke_enabled.unwrap_or(false)),
    );
    desc.set(
        "fillEnabled",
        DescriptorValue::Boolean(stroke.fill_enabled.unwrap_or(false)),
    );
    desc.set(
        "strokeStyleLineWidth",
        units_value(Some(&stroke.line_width.unwrap_or(UnitsValue {
            units: Units::Points,
            value: 3.0,
        }))),
    );
    desc.set(
        "strokeStyleLineDashOffset",
        units_value(Some(&stroke.line_dash_offset.unwrap_or(UnitsValue {
            units: Units::Points,
            value: 0.0,
        }))),
    );
    desc.set(
        "strokeStyleMiterLimit",
        DescriptorValue::Double(stroke.miter_limit.unwrap_or(100.0)),
    );
    desc.set(
        "strokeStyleLineCapType",
        DescriptorValue::Enum(encode_line_cap(stroke.line_cap_type)),
    );
    desc.set(
        "strokeStyleLineJoinType",
        DescriptorValue::Enum(encode_line_join(stroke.line_join_type)),
    );
    desc.set(
        "strokeStyleLineAlignment",
        DescriptorValue::Enum(encode_line_align(stroke.line_alignment)),
    );
    desc.set(
        "strokeStyleScaleLock",
        DescriptorValue::Boolean(stroke.scale_lock.unwrap_or(false)),
    );
    desc.set(
        "strokeStyleStrokeAdjust",
        DescriptorValue::Boolean(stroke.stroke_adjust.unwrap_or(false)),
    );
    let dashes = stroke
        .line_dash_set
        .as_ref()
        .map(|v| v.iter().map(|u| units_value(Some(u))).collect::<Vec<_>>())
        .unwrap_or_default();
    desc.set("strokeStyleLineDashSet", DescriptorValue::List(dashes));
    desc.set(
        "strokeStyleBlendMode",
        DescriptorValue::Enum(bln_m_encode(
            stroke.blend_mode.unwrap_or(crate::psd::BlendMode::Normal),
        )),
    );
    desc.set(
        "strokeStyleOpacity",
        units_percent(stroke.opacity.unwrap_or(1.0)),
    );
    let content = stroke
        .content
        .clone()
        .unwrap_or(VectorContent::Color(Color::Rgb(Rgb {
            r: 0.0,
            g: 0.0,
            b: 0.0,
        })));
    let (mut content_desc, key) = serialize_vector_content(&content)?;
    content_desc.class_id = stroke_content_class(key).to_string();
    desc.set(
        "strokeStyleContent",
        DescriptorValue::Descriptor(content_desc),
    );
    desc.set(
        "strokeStyleResolution",
        DescriptorValue::Double(stroke.resolution.unwrap_or(72.0)),
    );
    Ok(desc)
}

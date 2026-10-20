//! Descriptor field accessors + binary helpers for filter FX.

use crate::descriptor::{Descriptor, DescriptorValue, UnitDoubleValue, parse_units, units_value};
use crate::psd::{PointF, UnitsPoint, UnitsValue};
use crate::reader::ReadResult;

pub(super) fn units_percent_f(value: f64) -> DescriptorValue {
    DescriptorValue::UnitDouble(UnitDoubleValue {
        units: "Percent".to_string(),
        value: value * 100.0,
    })
}
pub(super) fn uv_radius(radius: &UnitsValue) -> DescriptorValue {
    units_value(Some(radius))
}
pub(super) fn uint8_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
pub(super) fn uint8_to_u32(bytes: &[u8]) -> Vec<u32> {
    bytes
        .chunks_exact(4)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}
pub(super) fn f32_to_uint8(vals: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vals.len() * 4);
    for v in vals {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}
pub(super) fn u32_to_uint8(vals: &[u32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(vals.len() * 4);
    for v in vals {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}
pub(super) fn array_to_points(arr: &[f64]) -> Vec<PointF> {
    arr.chunks_exact(2)
        .map(|c| PointF { x: c[0], y: c[1] })
        .collect()
}
pub(super) fn points_to_array(points: &[PointF]) -> Vec<f64> {
    let mut out = Vec::with_capacity(points.len() * 2);
    for p in points {
        out.push(p.x);
        out.push(p.y);
    }
    out
}
pub(super) fn uint8_to_points(bytes: &[u8]) -> Vec<PointF> {
    let floats = uint8_to_f32(bytes);
    floats
        .chunks_exact(2)
        .map(|c| PointF {
            x: c[0] as f64,
            y: c[1] as f64,
        })
        .collect()
}
pub(super) fn hrzn_vrtc_to_point(d: &Descriptor) -> ReadResult<UnitsPoint> {
    let zero = UnitsValue {
        units: crate::psd::Units::Pixels,
        value: 0.0,
    };
    Ok(UnitsPoint {
        x: d.get("Hrzn").map(parse_units).transpose()?.unwrap_or(zero),
        y: d.get("Vrtc").map(parse_units).transpose()?.unwrap_or(zero),
    })
}
pub(super) fn point_to_hrzn_vrtc(p: &UnitsPoint) -> Descriptor {
    let mut d = Descriptor::new("", "Pnt ");
    d.set("Hrzn", units_value(Some(&p.x)));
    d.set("Vrtc", units_value(Some(&p.y)));
    d
}

pub(super) const FROM_A_TO_Z: &[u8] = b"abcdefghijklmnopqrstuvwxyz";

/// Coerce filter-descriptor Doubles to Integers where upstream `getTypeByKey` /
/// `fieldToType` would emit `long`. Walks nested descriptors and lists.
pub(super) fn coerce_filter_descriptor_types(d: &mut Descriptor) {
    let class_id = d.class_id.clone();
    for (key, value) in d.items.iter_mut() {
        match value {
            DescriptorValue::Double(x) => {
                if should_be_long(key, &class_id) {
                    *value = DescriptorValue::Integer(*x as i32);
                }
            }
            DescriptorValue::List(items) => {
                if key == "Mtrx"
                    || key == "pinOffsets"
                    || key == "posFinalPins"
                    || key == "PinP"
                    || key == "PnRt"
                    || key == "PnDp"
                {
                    for item in items.iter_mut() {
                        if let DescriptorValue::Double(x) = item {
                            *item = DescriptorValue::Integer(*x as i32);
                        }
                    }
                } else {
                    for item in items.iter_mut() {
                        if let DescriptorValue::Descriptor(inner) = item {
                            coerce_filter_descriptor_types(inner);
                        }
                    }
                }
            }
            DescriptorValue::Descriptor(inner) => coerce_filter_descriptor_types(inner),
            _ => {}
        }
    }
}

fn should_be_long(key: &str, class_id: &str) -> bool {
    // Special cases from descriptor.ts getTypeByKey (filter-relevant).
    // getTypeByKey: SmrB keeps Rds/Thsh as doub.
    if class_id == "SmrB" && (key == "Rds " || key == "Thsh") {
        return false;
    }
    // getTypeByKey: ClSz / Rds / Amnt → long when bare number (UntF stays UntF).
    if key == "ClSz" || key == "Amnt" || key == "Rds " {
        return true;
    }
    if key == "Hght" && class_id == "Embs" {
        return true;
    }
    if key == "Angl" && matches!(class_id, "Embs" | "smartSharpen" | "Twrl" | "MtnB") {
        return true;
    }
    if key == "Scl " || key == "Ofst" {
        return true;
    }
    if key == "Thsh" {
        return true;
    }
    // Ofst filter: Hrzn/Vrtc are long (not Pnt  doubles).
    if (key == "Hrzn" || key == "Vrtc") && class_id == "Ofst" {
        return true;
    }
    // Brgh: long on filters (BrgC, LnsF); doub on HSBC color.
    if key == "Brgh" {
        return class_id != "HSBC";
    }
    if key == "Cntr" {
        return true;
    }
    // fieldToType `long` filter-related keys.
    matches!(
        key,
        "Lvl "
            | "TlNm"
            | "TlOf"
            | "FlRs"
            | "ShrS"
            | "ShrE"
            | "Vrnc"
            | "Strg"
            | "ExtS"
            | "ExtD"
            | "HrzS"
            | "VrtS"
            | "NmbR"
            | "EdgF"
            | "Ang1"
            | "Ang2"
            | "Ang3"
            | "Ang4"
            | "AmMn"
            | "AmMx"
            | "SclH"
            | "SclV"
            | "NmbG"
            | "WLMn"
            | "WLMx"
            | "RndS"
            | "filterID"
    )
}

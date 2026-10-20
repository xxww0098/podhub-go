//! Descriptor timeline converters (`parseKeyList` / `parseTrackList` and serialize).
//!
//! Upstream: `descriptor.ts` ~1298-1423.

use crate::additional_info::effects_keys::{parse_effects, serialize_effects};
use crate::descriptor::{Descriptor, DescriptorValue, UnitDoubleValue, parse_percent};
use crate::descriptor_enums::{anim_interp_style, std_track_id};
use crate::psd::{
    Fraction, PointF, TimelineEffectParams, TimelineKey, TimelineKeyData, TimelineKeyInterpolation,
    TimelineTrack, TimelineTrackType,
};
use crate::reader::{ReadError, ReadResult};

fn frac_from_desc(d: &Descriptor) -> Fraction {
    Fraction {
        numerator: d.number("numerator").unwrap_or_default(),
        denominator: d.number("denominator").unwrap_or_default(),
    }
}

/// Mirror `frac({ numerator, denominator })`.
pub fn frac(v: Option<&DescriptorValue>) -> Fraction {
    match v {
        Some(DescriptorValue::Descriptor(d)) => frac_from_desc(d),
        _ => Fraction {
            numerator: 0.0,
            denominator: 600.0,
        },
    }
}

pub fn write_frac(f: &Fraction) -> DescriptorValue {
    let mut d = Descriptor::new("", "null");
    d.set("numerator", DescriptorValue::Integer(f.numerator as i32));
    d.set(
        "denominator",
        DescriptorValue::Integer(f.denominator as i32),
    );
    DescriptorValue::Descriptor(d)
}

fn horz_vrtc_to_xy(d: &Descriptor) -> PointF {
    PointF {
        x: d.number("Hrzn").unwrap_or_default(),
        y: d.number("Vrtc").unwrap_or_default(),
    }
}

fn xy_to_horz_vrtc(p: &PointF) -> DescriptorValue {
    // fieldToExtType: Scl/Skew/translation → null
    let mut d = Descriptor::new("", "null");
    d.set("Hrzn", DescriptorValue::Double(p.x));
    d.set("Vrtc", DescriptorValue::Double(p.y));
    DescriptorValue::Descriptor(d)
}

fn units_percent(value: f64) -> DescriptorValue {
    DescriptorValue::UnitDouble(UnitDoubleValue {
        units: "Percent".to_string(),
        value: (value * 100.0).round(),
    })
}

fn interp_from_str(s: &str) -> TimelineKeyInterpolation {
    match s {
        "hold" => TimelineKeyInterpolation::Hold,
        _ => TimelineKeyInterpolation::Linear,
    }
}

fn interp_to_str(i: TimelineKeyInterpolation) -> &'static str {
    match i {
        TimelineKeyInterpolation::Linear => "linear",
        TimelineKeyInterpolation::Hold => "hold",
    }
}

fn track_type_from_str(s: &str) -> TimelineTrackType {
    match s {
        "style" => TimelineTrackType::Style,
        "sheetTransform" => TimelineTrackType::SheetTransform,
        "sheetPosition" => TimelineTrackType::SheetPosition,
        "globalLighting" => TimelineTrackType::GlobalLighting,
        _ => TimelineTrackType::Opacity,
    }
}

fn track_type_to_str(t: TimelineTrackType) -> &'static str {
    match t {
        TimelineTrackType::Opacity => "opacity",
        TimelineTrackType::Style => "style",
        TimelineTrackType::SheetTransform => "sheetTransform",
        TimelineTrackType::SheetPosition => "sheetPosition",
        TimelineTrackType::GlobalLighting => "globalLighting",
    }
}

/// Mirror `parseKeyList`.
pub fn parse_key_list(key_list: &[DescriptorValue]) -> ReadResult<Vec<TimelineKey>> {
    let codec = anim_interp_style();
    let mut keys = Vec::new();
    for item in key_list {
        let DescriptorValue::Descriptor(key) = item else {
            continue;
        };
        let time = match key.descriptor("time") {
            Some(t) => frac_from_desc(t),
            None => Fraction::default(),
        };
        let selected = key.bool("selected");
        let interp_raw = key.enumeration("animInterpStyle").unwrap_or_default();
        let interpolation = interp_from_str(
            &codec
                .decode(&interp_raw)
                .unwrap_or_else(|_| "linear".to_string()),
        );
        let anim_key = key.descriptor("animKey").ok_or_else(|| {
            ReadError::StrictViolation("timeline key missing animKey".to_string())
        })?;
        let type_enum = anim_key.enumeration("Type").unwrap_or_default();
        let type_code = type_enum.split('.').nth(1).unwrap_or("");
        let data = match type_code {
            "Opct" => {
                let value = match anim_key.get("Opct") {
                    Some(v) => parse_percent(v)?,
                    None => 0.0,
                };
                TimelineKeyData::Opacity { value }
            }
            "Pstn" => TimelineKeyData::Position {
                x: anim_key.number("Hrzn").unwrap_or_default(),
                y: anim_key.number("Vrtc").unwrap_or_default(),
            },
            "Trnf" => {
                let scale = anim_key
                    .descriptor("Scl ")
                    .map(horz_vrtc_to_xy)
                    .unwrap_or(PointF { x: 1.0, y: 1.0 });
                let skew = anim_key
                    .descriptor("Skew")
                    .map(horz_vrtc_to_xy)
                    .unwrap_or(PointF { x: 0.0, y: 0.0 });
                let translation = anim_key
                    .descriptor("translation")
                    .map(horz_vrtc_to_xy)
                    .unwrap_or(PointF { x: 0.0, y: 0.0 });
                TimelineKeyData::Transform {
                    scale,
                    skew,
                    rotation: anim_key.number("rotation").unwrap_or_default(),
                    translation,
                }
            }
            "sheetStyle" => {
                let style = match anim_key
                    .descriptor("sheetStyle")
                    .and_then(|s| s.descriptor("Lefx"))
                {
                    Some(lefx) => Some(parse_effects(lefx)?),
                    None => None,
                };
                TimelineKeyData::Style { style }
            }
            "globalLighting" => TimelineKeyData::GlobalLighting {
                global_angle: anim_key.number("gblA").unwrap_or_default(),
                global_altitude: anim_key.number("globalAltitude").unwrap_or_default(),
            },
            _ => {
                return Err(ReadError::StrictViolation(format!(
                    "Unsupported keyType value: {type_enum}"
                )));
            }
        };
        keys.push(TimelineKey {
            interpolation,
            time,
            selected,
            data,
        });
    }
    Ok(keys)
}

/// Mirror `serializeKeyList`.
pub fn serialize_key_list(keys: &[TimelineKey]) -> ReadResult<Vec<DescriptorValue>> {
    let codec = anim_interp_style();
    let mut key_list = Vec::new();
    for key in keys {
        let anim_interp = codec
            .encode(Some(interp_to_str(key.interpolation)))
            .map_err(ReadError::StrictViolation)?;
        let mut anim_key = Descriptor::new("", "null");
        match &key.data {
            TimelineKeyData::Opacity { value } => {
                anim_key.set("Type", DescriptorValue::Enum("keyType.Opct".to_string()));
                anim_key.set("Opct", units_percent(*value));
            }
            TimelineKeyData::Position { x, y } => {
                anim_key.set("Type", DescriptorValue::Enum("keyType.Pstn".to_string()));
                anim_key.set("Hrzn", DescriptorValue::Integer(*x as i32));
                anim_key.set("Vrtc", DescriptorValue::Integer(*y as i32));
            }
            TimelineKeyData::Transform {
                scale,
                skew,
                rotation,
                translation,
            } => {
                anim_key.set("Type", DescriptorValue::Enum("keyType.Trnf".to_string()));
                anim_key.set("Scl ", xy_to_horz_vrtc(scale));
                anim_key.set("Skew", xy_to_horz_vrtc(skew));
                anim_key.set("rotation", DescriptorValue::Double(*rotation));
                anim_key.set("translation", xy_to_horz_vrtc(translation));
            }
            TimelineKeyData::Style { style } => {
                anim_key.set(
                    "Type",
                    DescriptorValue::Enum("keyType.sheetStyle".to_string()),
                );
                let mut sheet = Descriptor::new("", "null");
                sheet.set("Vrsn", DescriptorValue::Integer(1));
                if let Some(fx) = style {
                    sheet.set(
                        "Lefx",
                        DescriptorValue::Descriptor(serialize_effects(fx, false)?),
                    );
                }
                sheet.set(
                    "blendOptions",
                    DescriptorValue::Descriptor(Descriptor::new("", "null")),
                );
                anim_key.set("sheetStyle", DescriptorValue::Descriptor(sheet));
            }
            TimelineKeyData::GlobalLighting {
                global_angle,
                global_altitude,
            } => {
                anim_key.set(
                    "Type",
                    DescriptorValue::Enum("keyType.globalLighting".to_string()),
                );
                // fieldToType: gblA / globalAltitude → long
                anim_key.set("gblA", DescriptorValue::Integer(*global_angle as i32));
                anim_key.set(
                    "globalAltitude",
                    DescriptorValue::Integer(*global_altitude as i32),
                );
            }
        }
        let mut desc = Descriptor::new("", "null");
        desc.set("Vrsn", DescriptorValue::Integer(1));
        desc.set("animInterpStyle", DescriptorValue::Enum(anim_interp));
        desc.set("time", write_frac(&key.time));
        desc.set("animKey", DescriptorValue::Descriptor(anim_key));
        desc.set(
            "selected",
            DescriptorValue::Boolean(key.selected.unwrap_or(false)),
        );
        key_list.push(DescriptorValue::Descriptor(desc));
    }
    Ok(key_list)
}

/// Mirror `parseTrackList`.
pub fn parse_track_list(track_list: &[DescriptorValue]) -> ReadResult<Vec<TimelineTrack>> {
    let codec = std_track_id();
    let mut tracks = Vec::new();
    for item in track_list {
        let DescriptorValue::Descriptor(tr) = item else {
            continue;
        };
        let track_id = tr.enumeration("trackID").unwrap_or_default();
        let track_type = track_type_from_str(
            &codec
                .decode(&track_id)
                .unwrap_or_else(|_| "opacity".to_string()),
        );
        let keys = match tr.list("keyList") {
            Some(l) => parse_key_list(l)?,
            None => Vec::new(),
        };
        let mut track = TimelineTrack {
            track_type,
            enabled: tr.bool("enab"),
            effect_params: None,
            keys,
        };
        if let Some(ep) = tr.descriptor("effectParams") {
            let ep_keys = match ep.list("keyList") {
                Some(l) => parse_key_list(l)?,
                None => Vec::new(),
            };
            track.effect_params = Some(TimelineEffectParams {
                fill_canvas: ep.bool("fillCanvas").unwrap_or(false),
                zoom_origin: ep.number("zoomOrigin").unwrap_or_default(),
                keys: ep_keys,
            });
        }
        tracks.push(track);
    }
    Ok(tracks)
}

/// Mirror `serializeTrackList`.
pub fn serialize_track_list(tracks: &[TimelineTrack]) -> ReadResult<Vec<DescriptorValue>> {
    let codec = std_track_id();
    let mut track_list = Vec::new();
    for t in tracks {
        let track_id = codec
            .encode(Some(track_type_to_str(t.track_type)))
            .map_err(ReadError::StrictViolation)?;
        // fieldToArrayExtType trackList / globalTrackList → animationTrack
        let mut desc = Descriptor::new("", "animationTrack");
        desc.set("trackID", DescriptorValue::Enum(track_id));
        desc.set("Vrsn", DescriptorValue::Integer(1));
        desc.set("enab", DescriptorValue::Boolean(t.enabled.unwrap_or(false)));
        desc.set("Effc", DescriptorValue::Boolean(t.effect_params.is_some()));
        if let Some(ep) = &t.effect_params {
            // Upstream bug mirrored: effectParams.keyList uses t.keys, not ep.keys.
            // fieldToExtType: effectParams → motionTrackEffectParams
            let mut ep_desc = Descriptor::new("", "motionTrackEffectParams");
            ep_desc.set(
                "keyList",
                DescriptorValue::List(serialize_key_list(&t.keys)?),
            );
            ep_desc.set("fillCanvas", DescriptorValue::Boolean(ep.fill_canvas));
            // fieldToType: zoomOrigin → long
            ep_desc.set(
                "zoomOrigin",
                DescriptorValue::Integer(ep.zoom_origin as i32),
            );
            desc.set("effectParams", DescriptorValue::Descriptor(ep_desc));
        }
        desc.set(
            "keyList",
            DescriptorValue::List(serialize_key_list(&t.keys)?),
        );
        track_list.push(DescriptorValue::Descriptor(desc));
    }
    Ok(track_list)
}

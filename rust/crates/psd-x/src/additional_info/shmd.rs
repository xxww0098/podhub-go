//! Layer metadata setting (`shmd`): timestamp, animation frames/flags, timeline, comps.
//!
//! Upstream: `additionalInfo.ts` ~743-978.

use crate::additional_info::WriteCtx;
use crate::additional_info::effects_keys::{parse_effects, serialize_effects};
use crate::additional_info::timeline::{frac, parse_track_list, serialize_track_list, write_frac};
use crate::descriptor::{
    Descriptor, DescriptorValue, UnitDoubleValue, parse_percent, read_version_and_descriptor,
    write_version_and_descriptor,
};
use crate::psd::{
    AnimationFrame, AnimationFrameFlags, LayerAdditionalInfo, LayerCompSettings, LayerComps,
    PointF, Timeline,
};
use crate::reader::{
    PsdReader, ReadError, ReadResult, check_signature, read_section, read_signature, read_uint8,
    read_uint16, read_uint32, skip_bytes,
};
use crate::writer::{
    PsdWriter, write_section, write_signature, write_uint8, write_uint16, write_uint32, write_zeros,
};

fn horz_vrtc_to_xy(d: &Descriptor) -> PointF {
    PointF {
        x: d.number("Hrzn").unwrap_or_default(),
        y: d.number("Vrtc").unwrap_or_default(),
    }
}

fn xy_to_horz_vrtc(p: &PointF, class_id: &str) -> DescriptorValue {
    let mut d = Descriptor::new("", class_id);
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

pub fn has_shmd(info: &LayerAdditionalInfo) -> bool {
    info.timestamp.is_some()
        || info.animation_frames.is_some()
        || info.animation_frame_flags.is_some()
        || info.timeline.is_some()
        || info.comps.is_some()
}

pub fn read_shmd(
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
) -> ReadResult<()> {
    let count = read_uint32(reader)?;
    for _ in 0..count {
        check_signature(reader, "8BIM", None)?;
        let key = read_signature(reader)?;
        let _copy = read_uint8(reader)?;
        skip_bytes(reader, 3);

        read_section(
            reader,
            1,
            |r, left_inner| {
                match key.as_str() {
                    "cust" => {
                        let desc = read_version_and_descriptor(r)?;
                        if let Some(v) = desc.get("layerTime") {
                            info.timestamp = Some(match v {
                                DescriptorValue::Double(d) => *d,
                                DescriptorValue::Integer(i) => *i as f64,
                                _ => 0.0,
                            });
                        }
                    }
                    "mlst" => {
                        let desc = read_version_and_descriptor(r)?;
                        let mut frames = Vec::new();
                        if let Some(list) = desc.list("LaSt") {
                            for item in list {
                                let DescriptorValue::Descriptor(f) = item else {
                                    continue;
                                };
                                let mut frame = AnimationFrame {
                                    frames: f.number_list("FrLs"),
                                    ..Default::default()
                                };
                                if let Some(enab) = f.bool("enab") {
                                    frame.enable = Some(enab);
                                }
                                if let Some(ofst) = f.descriptor("Ofst") {
                                    frame.offset = Some(horz_vrtc_to_xy(ofst));
                                }
                                if let Some(fxrf) = f.descriptor("FXRf") {
                                    frame.reference_point = Some(horz_vrtc_to_xy(fxrf));
                                }
                                if let Some(lefx) = f.descriptor("Lefx") {
                                    frame.effects = Some(parse_effects(lefx)?);
                                }
                                if let Some(blend) = f.descriptor("blendOptions") {
                                    if let Some(opct) = blend.get("Opct") {
                                        frame.opacity = Some(parse_percent(opct)?);
                                    }
                                }
                                frames.push(frame);
                            }
                        }
                        info.animation_frames = Some(frames);
                    }
                    "mdyn" => {
                        let _unknown = read_uint16(r)?;
                        let propagate = read_uint8(r)?;
                        let flags = read_uint8(r)?;
                        info.animation_frame_flags = Some(AnimationFrameFlags {
                            propagate_frame_one: Some(propagate == 0),
                            unify_layer_position: Some((flags & 1) != 0),
                            unify_layer_style: Some((flags & 2) != 0),
                            unify_layer_visibility: Some((flags & 4) != 0),
                        });
                    }
                    "tmln" => {
                        let desc = read_version_and_descriptor(r)?;
                        let time_scope = desc.descriptor("timeScope").ok_or_else(|| {
                            ReadError::StrictViolation("tmln missing timeScope".to_string())
                        })?;
                        let mut timeline = Timeline {
                            start: frac(time_scope.get("Strt")),
                            duration: frac(time_scope.get("duration")),
                            in_time: frac(time_scope.get("inTime")),
                            out_time: frac(time_scope.get("outTime")),
                            auto_scope: desc.bool("autoScope").unwrap_or(false),
                            audio_level: desc.number("audioLevel").unwrap_or_default(),
                            tracks: None,
                        };
                        if let Some(list) = desc.list("trackList") {
                            timeline.tracks = Some(parse_track_list(list)?);
                        }
                        info.timeline = Some(timeline);
                    }
                    "cmls" => {
                        let desc = read_version_and_descriptor(r)?;
                        let mut comps = LayerComps {
                            settings: Vec::new(),
                            original_effects_reference_point: None,
                        };
                        if let Some(orig) = desc.descriptor("origFXRefPoint") {
                            comps.original_effects_reference_point = Some(horz_vrtc_to_xy(orig));
                        }
                        if let Some(list) = desc.list("layerSettings") {
                            for item in list {
                                let DescriptorValue::Descriptor(s) = item else {
                                    continue;
                                };
                                let mut setting = LayerCompSettings {
                                    comp_list: s.number_list("compList"),
                                    ..Default::default()
                                };
                                if let Some(enab) = s.bool("enab") {
                                    setting.enabled = Some(enab);
                                }
                                if let Some(ofst) = s.descriptor("Ofst") {
                                    setting.offset = Some(horz_vrtc_to_xy(ofst));
                                }
                                if let Some(fx) = s.descriptor("FXRefPoint") {
                                    setting.effects_reference_point = Some(horz_vrtc_to_xy(fx));
                                }
                                comps.settings.push(setting);
                            }
                        }
                        info.comps = Some(comps);
                    }
                    _ => {}
                }
                skip_bytes(r, left_inner(r));
                Ok(())
            },
            false,
            false,
        )?;
    }
    skip_bytes(reader, left(reader));
    Ok(())
}

fn layer_id(info: &LayerAdditionalInfo, ctx: &WriteCtx<'_>) -> ReadResult<u32> {
    let ptr = info as *const LayerAdditionalInfo as usize;
    if let Some(id) = ctx.layer_to_id.get(&ptr).copied() {
        return Ok(id);
    }
    info.id.map(|i| i as u32).ok_or_else(|| {
        ReadError::StrictViolation(
            "You need to provide layer.id value when writing document with animations".to_string(),
        )
    })
}

pub fn write_shmd(
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    ctx: &WriteCtx<'_>,
) -> ReadResult<()> {
    let animation_frames = info.animation_frames.as_ref();
    let animation_frame_flags = info.animation_frame_flags.as_ref();
    let timeline = info.timeline.as_ref();
    let timestamp = info.timestamp;
    let comps = info.comps.as_ref();

    let mut count = 0u32;
    if animation_frames.is_some() {
        count += 1;
    }
    if animation_frame_flags.is_some() {
        count += 1;
    }
    if timeline.is_some() {
        count += 1;
    }
    if timestamp.is_some() {
        count += 1;
    }
    if comps.is_some() {
        count += 1;
    }
    write_uint32(writer, count);

    if let Some(frames) = animation_frames {
        write_signature(writer, "8BIM").map_err(write_err)?;
        write_signature(writer, "mlst").map_err(write_err)?;
        write_uint8(writer, 0);
        write_zeros(writer, 3);
        write_section(
            writer,
            2,
            |w| {
                let mut desc = Descriptor::new("", "null");
                desc.set(
                    "LaID",
                    DescriptorValue::Integer(info.id.unwrap_or(0.0) as i32),
                );
                let mut last = Vec::new();
                for f in frames {
                    let mut frame = Descriptor::new("", "null");
                    if let Some(enab) = f.enable {
                        frame.set("enab", DescriptorValue::Boolean(enab));
                    }
                    let frls: Vec<DescriptorValue> = f
                        .frames
                        .iter()
                        .map(|n| DescriptorValue::Integer(*n as i32))
                        .collect();
                    frame.set("FrLs", DescriptorValue::List(frls));
                    if let Some(ofst) = &f.offset {
                        // fieldToExtType Ofst → Pnt
                        frame.set("Ofst", xy_to_horz_vrtc(ofst, "Pnt "));
                    }
                    if let Some(rp) = &f.reference_point {
                        // fieldToExtType FXRf → null
                        frame.set("FXRf", xy_to_horz_vrtc(rp, "null"));
                    }
                    if let Some(fx) = &f.effects {
                        frame.set(
                            "Lefx",
                            DescriptorValue::Descriptor(serialize_effects(fx, false).map_err(
                                |e| crate::writer::WriteError::Internal(format!("{e:?}")),
                            )?),
                        );
                    }
                    if let Some(op) = f.opacity {
                        let mut blend = Descriptor::new("", "null");
                        blend.set("Opct", units_percent(op));
                        frame.set("blendOptions", DescriptorValue::Descriptor(blend));
                    }
                    last.push(DescriptorValue::Descriptor(frame));
                }
                desc.set("LaSt", DescriptorValue::List(last));
                write_version_and_descriptor(w, &desc);
                Ok(())
            },
            true,
            false,
        )
        .map_err(write_err)?;
    }

    if let Some(flags) = animation_frame_flags {
        write_signature(writer, "8BIM").map_err(write_err)?;
        write_signature(writer, "mdyn").map_err(write_err)?;
        write_uint8(writer, 0);
        write_zeros(writer, 3);
        write_section(
            writer,
            2,
            |w| {
                write_uint16(w, 0);
                write_uint8(
                    w,
                    if flags.propagate_frame_one == Some(true) {
                        0x0
                    } else {
                        0xf
                    },
                );
                write_uint8(
                    w,
                    (if flags.unify_layer_position == Some(true) {
                        1
                    } else {
                        0
                    }) | (if flags.unify_layer_style == Some(true) {
                        2
                    } else {
                        0
                    }) | (if flags.unify_layer_visibility == Some(true) {
                        4
                    } else {
                        0
                    }),
                );
                Ok(())
            },
            false,
            false,
        )
        .map_err(write_err)?;
    }

    if let Some(timeline) = timeline {
        write_signature(writer, "8BIM").map_err(write_err)?;
        write_signature(writer, "tmln").map_err(write_err)?;
        write_uint8(writer, 0);
        write_zeros(writer, 3);
        let id = layer_id(info, ctx)?;
        write_section(
            writer,
            2,
            |w| {
                let mut time_scope = Descriptor::new("", "null");
                time_scope.set("Vrsn", DescriptorValue::Integer(1));
                time_scope.set("Strt", write_frac(&timeline.start));
                time_scope.set("duration", write_frac(&timeline.duration));
                time_scope.set("inTime", write_frac(&timeline.in_time));
                time_scope.set("outTime", write_frac(&timeline.out_time));

                let mut desc = Descriptor::new("", "null");
                desc.set("Vrsn", DescriptorValue::Integer(1));
                desc.set("timeScope", DescriptorValue::Descriptor(time_scope));
                desc.set("autoScope", DescriptorValue::Boolean(timeline.auto_scope));
                desc.set("audioLevel", DescriptorValue::Double(timeline.audio_level));
                if let Some(tracks) = &timeline.tracks {
                    desc.set(
                        "trackList",
                        DescriptorValue::List(
                            serialize_track_list(tracks).map_err(|e| {
                                crate::writer::WriteError::Internal(format!("{e:?}"))
                            })?,
                        ),
                    );
                }
                desc.set("LyrI", DescriptorValue::Integer(id as i32));
                // root='anim' only affects type inference in the TS writer; typed
                // DescriptorValue already carries OSTypes.
                write_version_and_descriptor(w, &desc);
                Ok(())
            },
            true,
            false,
        )
        .map_err(write_err)?;
    }

    if let Some(ts) = timestamp {
        write_signature(writer, "8BIM").map_err(write_err)?;
        write_signature(writer, "cust").map_err(write_err)?;
        write_uint8(writer, 0);
        write_zeros(writer, 3);
        write_section(
            writer,
            2,
            |w| {
                let mut desc = Descriptor::new("", "metadata");
                desc.set("layerTime", DescriptorValue::Double(ts));
                write_version_and_descriptor(w, &desc);
                Ok(())
            },
            true,
            false,
        )
        .map_err(write_err)?;
    }

    if let Some(comps) = comps {
        write_signature(writer, "8BIM").map_err(write_err)?;
        write_signature(writer, "cmls").map_err(write_err)?;
        write_uint8(writer, 0);
        write_zeros(writer, 3);
        let id = layer_id(info, ctx)?;
        write_section(
            writer,
            2,
            |w| {
                let mut desc = Descriptor::new("", "null");
                if let Some(orig) = &comps.original_effects_reference_point {
                    // fieldToExtType origFXRefPoint → null
                    desc.set("origFXRefPoint", xy_to_horz_vrtc(orig, "null"));
                }
                desc.set("LyrI", DescriptorValue::Integer(id as i32));
                let mut settings = Vec::new();
                for item in &comps.settings {
                    let mut t = Descriptor::new("", "null");
                    if let Some(enab) = item.enabled {
                        t.set("enab", DescriptorValue::Boolean(enab));
                    }
                    if let Some(ofst) = &item.offset {
                        t.set("Ofst", xy_to_horz_vrtc(ofst, "Pnt "));
                    }
                    if let Some(fx) = &item.effects_reference_point {
                        // fieldToExtType FXRefPoint → null
                        t.set("FXRefPoint", xy_to_horz_vrtc(fx, "null"));
                    }
                    let list: Vec<DescriptorValue> = item
                        .comp_list
                        .iter()
                        .map(|n| DescriptorValue::Integer(*n as i32))
                        .collect();
                    t.set("compList", DescriptorValue::List(list));
                    settings.push(DescriptorValue::Descriptor(t));
                }
                desc.set("layerSettings", DescriptorValue::List(settings));
                write_version_and_descriptor(w, &desc);
                Ok(())
            },
            true,
            false,
        )
        .map_err(write_err)?;
    }

    Ok(())
}

fn write_err(e: crate::writer::WriteError) -> ReadError {
    ReadError::StrictViolation(format!("{e:?}"))
}

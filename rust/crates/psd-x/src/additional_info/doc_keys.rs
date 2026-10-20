//! Document-level misc keys: `artd` (artboards) and `Anno` (annotations).
//!
//! Upstream: `additionalInfo.ts` ~3802-3896 (`Anno`), ~5257-5289 (`artd`).

use crate::additional_info::{ReadCtx, WriteCtx};
use crate::descriptor::{
    Descriptor, DescriptorValue, parse_color, read_version_and_descriptor, serialize_color,
    write_version_and_descriptor,
};
use crate::psd::{
    Annotation, AnnotationData, AnnotationType, Color, HorizontalVertical, LtrbBounds,
    PsdArtboards, Rgb,
};
use crate::reader::{
    PsdReader, ReadError, ReadResult, read_ascii_string, read_bytes, read_color, read_int32,
    read_pascal_string, read_signature, read_uint8, read_uint16, read_uint32,
    read_unicode_string_with_length, skip_bytes,
};
use crate::writer::{
    PsdWriter, write_bytes, write_color, write_int32, write_pascal_string, write_signature,
    write_uint8, write_uint16, write_uint32,
};

pub fn read_artd(
    reader: &mut PsdReader,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<()> {
    let Some(psd) = ctx.psd.as_mut() else {
        skip_bytes(reader, left(reader));
        return Ok(());
    };
    let desc = read_version_and_descriptor(reader)?;
    let hv = |d: &Descriptor| HorizontalVertical {
        horizontal: match d.get("Hrzn") {
            Some(DescriptorValue::Double(v)) => *v,
            Some(DescriptorValue::Integer(v)) => *v as f64,
            _ => 0.0,
        },
        vertical: match d.get("Vrtc") {
            Some(DescriptorValue::Double(v)) => *v,
            Some(DescriptorValue::Integer(v)) => *v as f64,
            _ => 0.0,
        },
    };
    let auto_expand = match desc.get("autoExpandOffset") {
        Some(DescriptorValue::Descriptor(d)) => Some(hv(d)),
        _ => None,
    };
    let origin = match desc.get("origin") {
        Some(DescriptorValue::Descriptor(d)) => Some(hv(d)),
        _ => None,
    };
    let color = match desc.get("docDefaultNewArtboardBackgroundColor") {
        Some(DescriptorValue::Descriptor(d)) => Some(parse_color(d)?),
        _ => None,
    };
    let count = match desc.get("Cnt ") {
        Some(DescriptorValue::Integer(i)) => *i as f64,
        Some(DescriptorValue::Double(v)) => *v,
        _ => 0.0,
    };
    let bool_field = |k: &str| match desc.get(k) {
        Some(DescriptorValue::Boolean(b)) => Some(*b),
        _ => None,
    };
    psd.artboards = Some(PsdArtboards {
        count,
        auto_expand_offset: auto_expand,
        origin,
        auto_expand_enabled: bool_field("autoExpandEnabled"),
        auto_nest_enabled: bool_field("autoNestEnabled"),
        auto_position_enabled: bool_field("autoPositionEnabled"),
        shrinkwrap_on_save_enabled: bool_field("shrinkwrapOnSaveEnabled"),
        doc_default_new_artboard_background_color: color,
        doc_default_new_artboard_background_type: match desc
            .get("docDefaultNewArtboardBackgroundType")
        {
            Some(DescriptorValue::Integer(i)) => Some(*i as f64),
            Some(DescriptorValue::Double(v)) => Some(*v),
            _ => None,
        },
    });
    skip_bytes(reader, left(reader));
    Ok(())
}

fn read_rect(reader: &mut PsdReader) -> ReadResult<LtrbBounds> {
    let top = read_int32(reader)? as f64;
    let left = read_int32(reader)? as f64;
    let bottom = read_int32(reader)? as f64;
    let right = read_int32(reader)? as f64;
    Ok(LtrbBounds {
        left,
        top,
        right,
        bottom,
    })
}

pub fn read_anno(
    reader: &mut PsdReader,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<()> {
    let Some(psd) = ctx.psd.as_mut() else {
        skip_bytes(reader, left(reader));
        return Ok(());
    };
    let major = read_uint16(reader)?;
    let minor = read_uint16(reader)?;
    if major != 2 || minor != 1 {
        return Err(ReadError::StrictViolation(
            "Invalid Anno version".to_string(),
        ));
    }
    let count = read_uint32(reader)?;
    let mut annotations = Vec::new();
    for _ in 0..count {
        let _length = read_uint32(reader)?;
        let typ = read_signature(reader)?;
        let open = read_uint8(reader)? != 0;
        let _flags = read_uint8(reader)?;
        let _optional_blocks = read_uint16(reader)?;
        let icon_location = read_rect(reader)?;
        let popup_location = read_rect(reader)?;
        let color = read_color(reader)?;
        let author = read_pascal_string(reader, 2)?;
        let name = read_pascal_string(reader, 2)?;
        let date = read_pascal_string(reader, 2)?;
        let _content_length = read_uint32(reader)?;
        let _data_type = read_signature(reader)?;
        let data_length = read_uint32(reader)? as usize;
        let data = if typ == "txtA" {
            let data = if data_length >= 2 {
                let marker = read_uint16(reader)?;
                if marker == 0xfeff {
                    read_unicode_string_with_length(reader, (data_length - 2) / 2)?
                } else {
                    reader.offset -= 2;
                    read_ascii_string(reader, data_length)?
                }
            } else {
                read_ascii_string(reader, data_length)?
            };
            AnnotationData::Text(data.replace('\r', "\n"))
        } else if typ == "sndA" {
            AnnotationData::Binary(read_bytes(reader, data_length)?)
        } else {
            return Err(ReadError::StrictViolation(
                "Unknown annotation type".to_string(),
            ));
        };
        annotations.push(Annotation {
            annotation_type: if typ == "txtA" {
                AnnotationType::Text
            } else {
                AnnotationType::Sound
            },
            open,
            icon_location,
            popup_location,
            color,
            author,
            name,
            date,
            data,
        });
    }
    psd.annotations = Some(annotations);
    skip_bytes(reader, left(reader));
    Ok(())
}

fn serialize_color_artd(color: Option<&Color>) -> Descriptor {
    // root='artd' forces RGB channels to `long` in the TS type-inference writer.
    match color {
        None | Some(Color::Rgb(_)) | Some(Color::Rgba(_)) => {
            let rgb = match color {
                Some(Color::Rgb(c)) => *c,
                Some(Color::Rgba(c)) => Rgb {
                    r: c.r,
                    g: c.g,
                    b: c.b,
                },
                _ => Rgb {
                    r: 0.0,
                    g: 0.0,
                    b: 0.0,
                },
            };
            let mut d = Descriptor::new("", "RGBC");
            d.set("Rd  ", DescriptorValue::Integer(rgb.r.round() as i32));
            d.set("Grn ", DescriptorValue::Integer(rgb.g.round() as i32));
            d.set("Bl  ", DescriptorValue::Integer(rgb.b.round() as i32));
            d
        }
        other => serialize_color(other),
    }
}

pub fn write_artd(writer: &mut PsdWriter, ctx: &WriteCtx<'_>) -> ReadResult<()> {
    let artb = ctx
        .artboards
        .ok_or_else(|| ReadError::StrictViolation("artd write without artboards".to_string()))?;
    let mut desc = Descriptor::new("", "null");
    desc.set("Cnt ", DescriptorValue::Integer(artb.count as i32));
    let ae = artb.auto_expand_offset.unwrap_or(HorizontalVertical {
        horizontal: 0.0,
        vertical: 0.0,
    });
    // fieldToExtType: autoExpandOffset / origin → Pnt
    let mut ae_d = Descriptor::new("", "Pnt ");
    ae_d.set("Hrzn", DescriptorValue::Double(ae.horizontal));
    ae_d.set("Vrtc", DescriptorValue::Double(ae.vertical));
    desc.set("autoExpandOffset", DescriptorValue::Descriptor(ae_d));
    let origin = artb.origin.unwrap_or(HorizontalVertical {
        horizontal: 0.0,
        vertical: 0.0,
    });
    let mut origin_d = Descriptor::new("", "Pnt ");
    origin_d.set("Hrzn", DescriptorValue::Double(origin.horizontal));
    origin_d.set("Vrtc", DescriptorValue::Double(origin.vertical));
    desc.set("origin", DescriptorValue::Descriptor(origin_d));
    desc.set(
        "autoExpandEnabled",
        DescriptorValue::Boolean(artb.auto_expand_enabled.unwrap_or(true)),
    );
    desc.set(
        "autoNestEnabled",
        DescriptorValue::Boolean(artb.auto_nest_enabled.unwrap_or(true)),
    );
    desc.set(
        "autoPositionEnabled",
        DescriptorValue::Boolean(artb.auto_position_enabled.unwrap_or(true)),
    );
    desc.set(
        "shrinkwrapOnSaveEnabled",
        DescriptorValue::Boolean(artb.shrinkwrap_on_save_enabled.unwrap_or(true)),
    );
    desc.set(
        "docDefaultNewArtboardBackgroundColor",
        DescriptorValue::Descriptor(serialize_color_artd(
            artb.doc_default_new_artboard_background_color.as_ref(),
        )),
    );
    desc.set(
        "docDefaultNewArtboardBackgroundType",
        DescriptorValue::Integer(
            artb.doc_default_new_artboard_background_type.unwrap_or(1.0) as i32
        ),
    );
    write_version_and_descriptor(writer, &desc);
    Ok(())
}

fn write_rect(writer: &mut PsdWriter, rect: &LtrbBounds) {
    write_int32(writer, rect.top as i32);
    write_int32(writer, rect.left as i32);
    write_int32(writer, rect.bottom as i32);
    write_int32(writer, rect.right as i32);
}

pub fn write_anno(writer: &mut PsdWriter, ctx: &WriteCtx<'_>) -> ReadResult<()> {
    let annotations = ctx
        .annotations
        .ok_or_else(|| ReadError::StrictViolation("Anno write without annotations".to_string()))?;
    write_uint16(writer, 2);
    write_uint16(writer, 1);
    write_uint32(writer, annotations.len() as u32);
    for annotation in annotations {
        let sound = annotation.annotation_type == AnnotationType::Sound;
        let length_offset = writer.offset;
        write_uint32(writer, 0);
        write_signature(writer, if sound { "sndA" } else { "txtA" })
            .map_err(|e| ReadError::StrictViolation(format!("{e:?}")))?;
        write_uint8(writer, if annotation.open { 1 } else { 0 });
        write_uint8(writer, 28);
        write_uint16(writer, 1);
        write_rect(writer, &annotation.icon_location);
        write_rect(writer, &annotation.popup_location);
        write_color(writer, Some(&annotation.color));
        write_pascal_string(writer, &annotation.author, 2)
            .map_err(|e| ReadError::StrictViolation(format!("{e:?}")))?;
        write_pascal_string(writer, &annotation.name, 2)
            .map_err(|e| ReadError::StrictViolation(format!("{e:?}")))?;
        write_pascal_string(writer, &annotation.date, 2)
            .map_err(|e| ReadError::StrictViolation(format!("{e:?}")))?;
        let content_offset = writer.offset;
        write_uint32(writer, 0);
        write_signature(writer, if sound { "sndM" } else { "txtC" })
            .map_err(|e| ReadError::StrictViolation(format!("{e:?}")))?;
        write_uint32(writer, 0);
        let data_offset = writer.offset;
        match &annotation.data {
            AnnotationData::Binary(data) => write_bytes(writer, Some(data)),
            AnnotationData::Text(text) => {
                write_uint16(writer, 0xfeff);
                let text = text.replace('\n', "\r");
                // UTF-16 units, not `char as u16` — astral-plane text (emoji,
                // CJK extensions) would be silently truncated per unit.
                for unit in text.encode_utf16() {
                    write_uint16(writer, unit);
                }
            }
        }
        let set_u32 = |w: &mut PsdWriter, off: usize, v: u32| {
            w.buffer[off..off + 4].copy_from_slice(&v.to_be_bytes());
        };
        set_u32(
            writer,
            length_offset,
            (writer.offset - length_offset) as u32,
        );
        set_u32(
            writer,
            content_offset,
            (writer.offset - content_offset) as u32,
        );
        set_u32(
            writer,
            data_offset - 4,
            (writer.offset - data_offset) as u32,
        );
    }
    Ok(())
}

//! Animations image resource (id 4000).

use super::*;
use crate::descriptor::{
    Descriptor, DescriptorValue, read_version_and_descriptor, write_version_and_descriptor,
};
use crate::psd::*;
use crate::reader::{
    PsdReader, ReadResult, check_signature, read_section, read_signature, skip_bytes,
};
use crate::writer::{PsdWriter, write_section, write_signature};

pub(crate) fn read_animations(
    reader: &mut PsdReader,
    target: &mut ImageResources,
    left: usize,
) -> ReadResult<()> {
    let key = read_signature(reader)?;

    if key == "mani" {
        check_signature(reader, "IRFR", None)?;
        read_section(
            reader,
            1,
            |reader, sect_left| {
                while sect_left(reader) > 0 {
                    check_signature(reader, "8BIM", None)?;
                    let sub_key = read_signature(reader)?;
                    read_section(
                        reader,
                        1,
                        |reader, inner_left| {
                            if sub_key == "AnDs" {
                                let desc = read_version_and_descriptor(reader)?;
                                target.animations = Some(parse_animations(&desc));
                            } else {
                                // 'Roll' or unhandled — skip bytes.
                                let n = inner_left(reader);
                                skip_bytes(reader, n);
                            }
                            Ok(())
                        },
                        true,
                        false,
                    )?;
                }
                Ok(())
            },
            true,
            false,
        )?;
    } else {
        // 'mopt' or unhandled — skip the remaining bytes of the block.
        let consumed = 4; // signature
        skip_bytes(reader, left.saturating_sub(consumed));
    }
    Ok(())
}

pub(crate) fn parse_animations(desc: &Descriptor) -> Animations {
    let mut frames = Vec::new();
    if let Some(list) = desc.list("FrIn") {
        for item in list {
            if let DescriptorValue::Descriptor(x) = item {
                let dispose = x
                    .enumeration("FrDs")
                    .and_then(|s| frmd_codec().decode(&s).ok())
                    .map(|d| match d.as_str() {
                        "none" => AnimationDispose::None,
                        "dispose" => AnimationDispose::Dispose,
                        _ => AnimationDispose::Auto,
                    })
                    .unwrap_or(AnimationDispose::Auto);
                frames.push(AnimationFrameInfo {
                    id: x.number("FrID").unwrap_or(0.0),
                    delay: x.number("FrDl").unwrap_or(0.0) / 100.0,
                    dispose: Some(dispose),
                });
            }
        }
    }
    let mut animations = Vec::new();
    if let Some(list) = desc.list("FSts") {
        for item in list {
            if let DescriptorValue::Descriptor(x) = item {
                let mut fr = Vec::new();
                if let Some(fslist) = x.list("FsFr") {
                    for f in fslist {
                        if let DescriptorValue::Integer(i) = f {
                            fr.push(*i as f64);
                        }
                    }
                }
                animations.push(AnimationInfo {
                    id: x.number("FsID").unwrap_or(0.0),
                    frames: fr,
                    repeats: Some(x.number("LCnt").unwrap_or(0.0)),
                    active_frame: Some(x.number("AFrm").unwrap_or(0.0)),
                });
            }
        }
    }
    Animations { frames, animations }
}

pub(crate) fn write_animations(writer: &mut PsdWriter, target: &ImageResources) {
    let Some(animations) = &target.animations else {
        return;
    };
    write_signature(writer, "mani").expect("signature");
    write_signature(writer, "IRFR").expect("signature");
    write_section(
        writer,
        1,
        |writer| {
            write_signature(writer, "8BIM").expect("signature");
            write_signature(writer, "AnDs").expect("signature");
            write_section(
                writer,
                1,
                |writer| {
                    let mut desc = Descriptor::new("", "null");
                    let mut fr_in = Vec::new();
                    for f in &animations.frames {
                        // fieldToArrayExtType FrIn → null (not AnFr)
                        let mut frame = Descriptor::new("", "null");
                        frame.set("FrID", DescriptorValue::Integer(f.id as i32));
                        if f.delay != 0.0 {
                            // Round, don't truncate: 0.29 * 100 = 28.999…
                            // would decrement the delay on every save.
                            frame.set(
                                "FrDl",
                                DescriptorValue::Integer((f.delay * 100.0).round() as i32),
                            );
                        }
                        frame.set(
                            "FrDs",
                            DescriptorValue::Enum(
                                frmd_codec()
                                    .encode(Some(
                                        match f.dispose.unwrap_or(AnimationDispose::Auto) {
                                            AnimationDispose::Auto => "auto",
                                            AnimationDispose::None => "none",
                                            AnimationDispose::Dispose => "dispose",
                                        },
                                    ))
                                    .unwrap(),
                            ),
                        );
                        fr_in.push(DescriptorValue::Descriptor(frame));
                    }
                    desc.set("FrIn", DescriptorValue::List(fr_in));

                    let mut f_sts = Vec::new();
                    for a in &animations.animations {
                        // fieldToArrayExtType FSts → null (not AnSt)
                        let mut anim = Descriptor::new("", "null");
                        anim.set("FsID", DescriptorValue::Integer(a.id as i32));
                        anim.set(
                            "AFrm",
                            DescriptorValue::Integer(a.active_frame.unwrap_or(0.0) as i32),
                        );
                        let frames = a
                            .frames
                            .iter()
                            .map(|f| DescriptorValue::Integer(*f as i32))
                            .collect();
                        anim.set("FsFr", DescriptorValue::List(frames));
                        anim.set(
                            "LCnt",
                            DescriptorValue::Integer(a.repeats.unwrap_or(0.0) as i32),
                        );
                        f_sts.push(DescriptorValue::Descriptor(anim));
                    }
                    desc.set("FSts", DescriptorValue::List(f_sts));

                    write_version_and_descriptor(writer, &desc);
                    Ok(())
                },
                false,
                false,
            )?;
            Ok(())
        },
        false,
        false,
    )
    .expect("write animation image resource");
}

// ===========================================================================

/*
File: rust/crates/psd-x/src/additional_info/misc_keys.rs

Purpose:
Additional-info key group-module. Group: `Group::Misc`.
Miscellaneous (shmd, artb, artd, sn2P, Lr16, Lr32, LMsk, FMsk, FEid, FXid, Anno, cinf,
extn, CAI , OCIO, GenI).

PORT STATUS:
- FULLY PORTED (read+has+write, exact byte layout):
    `sn2P`, `LMsk`, `FMsk`, `FEid` (+ alias `FXid`), `cinf`, `artb`,
    `shmd`, `artd`, `Anno`.
- READ WIRED (write still no-op / has=false, matching upstream `() => false`):
    `Lr16`/`Lr32` — recursively call `read_layer_info` into `ReadCtx.psd`
              when document context is present.
- SKIP/RAW-STUB (with reason — see the matching function):
    `CAI `/`OCIO`/`GenI`/`extn` — upstream registers them ONLY under
              `MOCK_HANDLERS` and stores raw bytes in `_CAI_`/`_OCIO`/`_GenI`/`_extn`
              fields that are not in the model; read skips the body, has=None.

GROUP-MODULE CONTRACT (see mod.rs):
- `pub fn read(key, reader, info, left, ctx) -> ReadResult<Option<()>>`
    Ok(Some(())) — key handled; Ok(None) — "not my key".
- `pub fn has(key, info) -> Option<bool>`
    Some(b) — this group-module owns the key; b = whether to write it;
    None — "not my key".
- `pub fn write(key, writer, info, ctx) -> Option<ReadResult<()>>`
    Some(Ok(())) / Some(Err(_)) / None — see GROUP-MODULE CONTRACT in mod.rs.
    `write_additional_info` returns WriteResult.
*/

use crate::additional_info::{ReadCtx, WriteCtx};
use crate::descriptor::{
    Descriptor, DescriptorValue, parse_color, read_version_and_descriptor, serialize_color,
    write_version_and_descriptor,
};
use crate::helpers::clamp;
use crate::psd::Bounds;
use crate::psd::{
    Color, ColorSpaceMask, CompositorUsed, FilterEffectsChannel, FilterEffectsExtra,
    FilterEffectsMask, LayerAdditionalInfo, LayerArtboard, Rgb, VersionTriple,
};
use crate::reader::{
    PsdReader, ReadError, ReadResult, read_bytes, read_color, read_int32, read_pascal_string,
    read_uint8, read_uint16, read_uint32, skip_bytes,
};
use crate::writer::{
    PsdWriter, write_bytes, write_color, write_int32, write_pascal_string, write_uint8,
    write_uint16, write_uint32,
};

// ===========================================================================
// READ
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs.
pub fn read(
    key: &str,
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<Option<()>> {
    match key {
        "sn2P" => info.using_aligned_rendering = Some(read_uint32(reader)? != 0),
        "LMsk" => read_lmsk(reader, info)?,
        "FMsk" => read_fmsk(reader, info)?,
        "FEid" | "FXid" => read_feid(reader, info, left)?,
        "cinf" => read_cinf(reader, info, left)?,
        "artb" => read_artb(reader, info, left)?,

        // Lr16/Lr32: upstream `readLayerInfo(reader, psd, imageResources)`.
        // Needs document `ReadCtx.psd` (set by document-level orchestration
        // after `mem::take` of `psd.additional_info` to split borrows).
        "Lr16" | "Lr32" => read_lr16_lr32(reader, ctx)?,

        "shmd" => crate::additional_info::shmd::read_shmd(reader, info, left)?,
        "artd" => crate::additional_info::doc_keys::read_artd(reader, left, ctx)?,
        "Anno" => crate::additional_info::doc_keys::read_anno(reader, left, ctx)?,

        // CAI / OCIO / GenI / extn: upstream registers these only under the
        // test-only `MOCK_HANDLERS` flag, storing raw bytes in `_CAI_`/`_OCIO`/
        // `_GenI`/`_extn` ad-hoc fields. Those raw fields do not exist in the
        // ported model, so there is nothing to store. Consume and drop. NOTE: gap.
        "CAI " | "OCIO" | "GenI" | "extn" => skip_bytes(reader, left(reader)),

        _ => return Ok(None),
    }
    Ok(Some(()))
}

/// Nested layer-info for 16/32-bit documents (`Lr16` / `Lr32`).
fn read_lr16_lr32(reader: &mut PsdReader, ctx: &mut ReadCtx) -> ReadResult<()> {
    let Some(psd) = ctx.psd.as_mut() else {
        // No document context (e.g. unit tests that only round-trip layer
        // extras) — consume nothing special; caller skips leftover bytes.
        return Ok(());
    };
    let layers = crate::reader::read_layer_info(reader, psd)?;
    psd.children = Some(layers);
    Ok(())
}

/// `LMsk` — user mask / layer mask as global.
fn read_lmsk(reader: &mut PsdReader, info: &mut LayerAdditionalInfo) -> ReadResult<()> {
    let color_space = read_color(reader)?;
    let opacity = read_uint16(reader)? as f64 / 0xff as f64;
    let flag = read_uint8(reader)?;
    if flag != 128 {
        return Err(ReadError::StrictViolation("Invalid flag value".to_string()));
    }
    skip_bytes(reader, 1);
    info.user_mask = Some(ColorSpaceMask {
        color_space,
        opacity,
    });
    Ok(())
}

/// `FMsk` — filter mask.
fn read_fmsk(reader: &mut PsdReader, info: &mut LayerAdditionalInfo) -> ReadResult<()> {
    let color_space = read_color(reader)?;
    let opacity = read_uint16(reader)? as f64 / 0xff as f64;
    info.filter_mask = Some(ColorSpaceMask {
        color_space,
        opacity,
    });
    Ok(())
}

/// `FEid` / alias `FXid` — filter effects masks.
fn read_feid(
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
) -> ReadResult<()> {
    let version = read_int32(reader)?;
    if !(1..=3).contains(&version) {
        return Err(ReadError::StrictViolation(format!(
            "Invalid filterEffects version {version}"
        )));
    }

    let mut masks: Vec<FilterEffectsMask> = Vec::new();

    while left(reader) > 8 {
        if read_uint32(reader)? != 0 {
            return Err(ReadError::StrictViolation(
                "filterEffects: 64 bit length is not supported".to_string(),
            ));
        }
        let length = read_uint32(reader)? as usize;
        let end = reader.offset + length;

        let id = read_pascal_string(reader, 1)?;

        let effect_version = read_int32(reader)?;
        if effect_version != 1 {
            return Err(ReadError::StrictViolation(format!(
                "Invalid filterEffect version {effect_version}"
            )));
        }

        if read_uint32(reader)? != 0 {
            return Err(ReadError::StrictViolation(
                "filterEffect: 64 bit length is not supported".to_string(),
            ));
        }
        let _effect_length = read_uint32(reader)?;

        let top = read_int32(reader)? as f64;
        let lft = read_int32(reader)? as f64;
        let bottom = read_int32(reader)? as f64;
        let right = read_int32(reader)? as f64;
        let depth = read_int32(reader)? as f64;
        let max_channels = read_int32(reader)?;

        let mut channels: Vec<Option<FilterEffectsChannel>> = Vec::new();
        // 0 -> R, 1 -> G, 2 -> B, 25 -> A; + user mask + sheet mask
        for _ in 0..(max_channels + 2) {
            let exists = read_int32(reader)?;
            if exists != 0 {
                if read_uint32(reader)? != 0 {
                    return Err(ReadError::StrictViolation(
                        "filterEffect: 64 bit length is not supported".to_string(),
                    ));
                }
                let channel_length = read_uint32(reader)? as usize;
                if channel_length == 0 {
                    return Err(ReadError::StrictViolation(
                        "filterEffect: Empty channel".to_string(),
                    ));
                }
                let compression_mode = read_uint16(reader)? as f64;
                // channel_length < 2 would underflow usize and (in release)
                // wrap into a huge read.
                if channel_length < 2 {
                    return Err(ReadError::StrictViolation(
                        "filterEffect: channel shorter than its header".to_string(),
                    ));
                }
                let data = read_bytes(reader, channel_length - 2)?;
                channels.push(Some(FilterEffectsChannel {
                    compression_mode,
                    data,
                }));
            } else {
                channels.push(None);
            }
        }

        let mut mask = FilterEffectsMask {
            id,
            top,
            left: lft,
            bottom,
            right,
            depth,
            channels,
            extra: None,
        };

        if reader.offset < end && read_uint8(reader)? != 0 {
            let top = read_int32(reader)? as f64;
            let lft = read_int32(reader)? as f64;
            let bottom = read_int32(reader)? as f64;
            let right = read_int32(reader)? as f64;
            if read_uint32(reader)? != 0 {
                return Err(ReadError::StrictViolation(
                    "filterEffect: 64 bit length is not supported".to_string(),
                ));
            }
            let extra_length = read_uint32(reader)? as usize;
            let compression_mode = read_uint16(reader)? as f64;
            if extra_length < 2 {
                return Err(ReadError::StrictViolation(
                    "filterEffect: extra shorter than its header".to_string(),
                ));
            }
            let data = read_bytes(reader, extra_length - 2)?;
            mask.extra = Some(FilterEffectsExtra {
                top,
                left: lft,
                bottom,
                right,
                compression_mode,
                data,
            });
        }

        masks.push(mask);

        reader.offset = end;
        let mut len = length;
        while len % 4 != 0 {
            reader.offset += 1;
            len += 1;
        }
    }

    info.filter_effects_masks = Some(masks);
    Ok(())
}

/// Extracts the enum value `"type.value"` -> `"value"`.
fn enum_value(s: &str) -> String {
    s.splitn(2, '.').nth(1).unwrap_or("").to_string()
}

/// `cinf` — compositor info.
fn read_cinf(
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
) -> ReadResult<()> {
    let desc = read_version_and_descriptor(reader)?;

    let str_field = |k: &str| -> String {
        match desc.get(k) {
            Some(DescriptorValue::Text(t)) => t.clone(),
            _ => String::new(),
        }
    };
    let enum_field = |k: &str| -> Option<String> {
        match desc.get(k) {
            Some(DescriptorValue::Enum(e)) => Some(enum_value(e)),
            _ => None,
        }
    };

    let mut cinf = CompositorUsed {
        description: str_field("description"),
        reason: str_field("reason"),
        engine: enum_field("Engn").unwrap_or_default(),
        ..Default::default()
    };

    cinf.version = read_version_triple(&desc, "Vrsn");
    cinf.photoshop_version = read_version_triple(&desc, "psVersion");
    cinf.enable_comp_core = enum_field("enableCompCore");
    cinf.enable_comp_core_gpu = enum_field("enableCompCoreGPU");
    cinf.enable_comp_core_threads = enum_field("enableCompCoreThreads");
    cinf.comp_core_support = enum_field("compCoreSupport");
    cinf.comp_core_gpu_support = enum_field("compCoreGPUSupport");

    info.compositor_used = Some(cinf);
    skip_bytes(reader, left(reader));
    Ok(())
}

/// Reads a `{ major; minor; fix; }` descriptor structure by key.
fn read_version_triple(desc: &Descriptor, key: &str) -> Option<VersionTriple> {
    if let Some(DescriptorValue::Descriptor(d)) = desc.get(key) {
        let g = |k: &str| match d.get(k) {
            Some(DescriptorValue::Integer(i)) => *i as f64,
            Some(DescriptorValue::Double(v)) => *v,
            _ => 0.0,
        };
        Some(VersionTriple {
            major: g("major"),
            minor: g("minor"),
            fix: g("fix"),
        })
    } else {
        None
    }
}

/// `artb` — per-layer artboard info.
fn read_artb(
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
) -> ReadResult<()> {
    let desc = read_version_and_descriptor(reader)?;

    let rect = match desc.get("artboardRect") {
        Some(DescriptorValue::Descriptor(d)) => d,
        _ => {
            return Err(ReadError::StrictViolation(
                "artb: missing artboardRect".to_string(),
            ));
        }
    };
    let rg = |k: &str| match rect.get(k) {
        Some(DescriptorValue::Integer(i)) => *i as f64,
        Some(DescriptorValue::Double(v)) => *v,
        _ => 0.0,
    };

    let guide_indices = match desc.get("guideIndeces") {
        Some(DescriptorValue::List(l)) => Some(
            l.iter()
                .map(|v| match v {
                    DescriptorValue::Integer(i) => *i as f64,
                    DescriptorValue::Double(d) => *d,
                    _ => 0.0,
                })
                .collect(),
        ),
        _ => None,
    };

    let preset_name = match desc.get("artboardPresetName") {
        Some(DescriptorValue::Text(t)) => Some(t.clone()),
        _ => None,
    };

    let color = match desc.get("Clr ") {
        Some(DescriptorValue::Descriptor(d)) => Some(parse_color(d)?),
        _ => None,
    };

    let background_type = match desc.get("artboardBackgroundType") {
        Some(DescriptorValue::Integer(i)) => Some(*i as f64),
        Some(DescriptorValue::Double(v)) => Some(*v),
        _ => None,
    };

    info.artboard = Some(LayerArtboard {
        rect: Bounds {
            top: rg("Top "),
            left: rg("Left"),
            bottom: rg("Btom"),
            right: rg("Rght"),
        },
        guide_indices,
        preset_name,
        color,
        background_type,
    });

    skip_bytes(reader, left(reader));
    Ok(())
}

// ===========================================================================
// HAS
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs.
pub fn has(key: &str, info: &LayerAdditionalInfo, ctx: &WriteCtx<'_>) -> Option<bool> {
    let present = match key {
        "sn2P" => info.using_aligned_rendering.is_some(),
        "LMsk" => info.user_mask.is_some(),
        "FMsk" => info.filter_mask.is_some(),
        "FEid" | "FXid" => info.filter_effects_masks.is_some(),
        "cinf" => info.compositor_used.is_some(),
        "artb" => info.artboard.is_some(),
        "shmd" => crate::additional_info::shmd::has_shmd(info),
        "artd" => ctx.artboards.is_some(),
        "Anno" => ctx.annotations.is_some(),

        // Lr16/Lr32: upstream predicate is `() => false` (never written
        // directly here; emitted by the document orchestration). false.
        "Lr16" | "Lr32" => false,

        // CAI/OCIO/GenI/extn: MOCK_HANDLERS-only raw fields not in the model.
        "CAI " | "OCIO" | "GenI" | "extn" => return None,

        _ => return None,
    };
    Some(present)
}

// ===========================================================================
// WRITE
// ===========================================================================

/// See GROUP-MODULE CONTRACT in mod.rs. Called only when has==Some(true),
/// inside an already-open writeSection.
pub fn write(
    key: &str,
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    ctx: &mut WriteCtx,
) -> Option<ReadResult<()>> {
    match key {
        "sn2P" => write_uint32(
            writer,
            if info.using_aligned_rendering == Some(true) {
                1
            } else {
                0
            },
        ),
        "LMsk" => write_lmsk(writer, info),
        "FMsk" => write_fmsk(writer, info),
        "FEid" | "FXid" => write_feid(writer, info),
        "cinf" => write_cinf(writer, info),
        "artb" => write_artb(writer, info),
        "shmd" => return Some(crate::additional_info::shmd::write_shmd(writer, info, ctx)),
        "artd" => return Some(crate::additional_info::doc_keys::write_artd(writer, ctx)),
        "Anno" => return Some(crate::additional_info::doc_keys::write_anno(writer, ctx)),
        _ => return None,
    }
    Some(Ok(()))
}

fn write_lmsk(writer: &mut PsdWriter, info: &LayerAdditionalInfo) {
    let user_mask = info.user_mask.as_ref().unwrap();
    write_color(writer, Some(&user_mask.color_space));
    write_uint16(
        writer,
        (clamp(user_mask.opacity, 0.0, 1.0) * 0xff as f64) as u16,
    );
    write_uint8(writer, 128);
    crate::writer::write_zeros(writer, 1);
}

fn write_fmsk(writer: &mut PsdWriter, info: &LayerAdditionalInfo) {
    let filter_mask = info.filter_mask.as_ref().unwrap();
    write_color(writer, Some(&filter_mask.color_space));
    write_uint16(
        writer,
        (clamp(filter_mask.opacity, 0.0, 1.0) * 0xff as f64) as u16,
    );
}

/// Backpatch a big-endian u32 at an earlier `offset` in the writer buffer.
/// Mirror of `writer.view.setUint32(offset, value, false)`.
fn set_u32_be(writer: &mut PsdWriter, offset: usize, value: u32) {
    writer.buffer[offset..offset + 4].copy_from_slice(&value.to_be_bytes());
}

fn write_feid(writer: &mut PsdWriter, info: &LayerAdditionalInfo) {
    write_int32(writer, 3); // version

    let masks = info.filter_effects_masks.as_ref().unwrap();
    for mask in masks {
        write_uint32(writer, 0);
        write_uint32(writer, 0);
        let length_offset = writer.offset;

        write_pascal_string(writer, &mask.id, 1).expect("pascal string");
        write_int32(writer, 1); // version

        write_uint32(writer, 0);
        write_uint32(writer, 0);
        let length2_offset = writer.offset;

        write_int32(writer, mask.top as i32);
        write_int32(writer, mask.left as i32);
        write_int32(writer, mask.bottom as i32);
        write_int32(writer, mask.right as i32);
        write_int32(writer, mask.depth as i32);
        let max_channels = (mask.channels.len() as i32 - 2).max(0);
        write_int32(writer, max_channels);

        for i in 0..(max_channels + 2) {
            let channel = mask.channels.get(i as usize).and_then(|c| c.as_ref());
            write_int32(writer, if channel.is_some() { 1 } else { 0 });
            if let Some(channel) = channel {
                write_uint32(writer, 0);
                write_uint32(writer, channel.data.len() as u32 + 2);
                write_uint16(writer, channel.compression_mode as u16);
                write_bytes(writer, Some(&channel.data));
            }
        }

        set_u32_be(
            writer,
            length2_offset - 4,
            (writer.offset - length2_offset) as u32,
        );

        if let Some(extra) = &mask.extra {
            write_uint8(writer, 1);
            write_int32(writer, extra.top as i32);
            write_int32(writer, extra.left as i32);
            write_int32(writer, extra.bottom as i32);
            write_int32(writer, extra.right as i32);
            write_uint32(writer, 0);
            write_uint32(writer, extra.data.len() as u32 + 2);
            write_uint16(writer, extra.compression_mode as u16);
            write_bytes(writer, Some(&extra.data));
        }

        let mut length = writer.offset - length_offset;
        set_u32_be(writer, length_offset - 4, length as u32);

        while length % 4 != 0 {
            crate::writer::write_zeros(writer, 1);
            length += 1;
        }
    }
}

fn write_version_triple(desc: &mut Descriptor, key: &str, v: &VersionTriple) {
    let mut t = Descriptor::new("", "null");
    t.set("major", DescriptorValue::Integer(v.major as i32));
    t.set("minor", DescriptorValue::Integer(v.minor as i32));
    t.set("fix", DescriptorValue::Integer(v.fix as i32));
    desc.set(key, DescriptorValue::Descriptor(t));
}

fn write_cinf(writer: &mut PsdWriter, info: &LayerAdditionalInfo) {
    let cinf = info.compositor_used.as_ref().unwrap();
    let mut desc = Descriptor::new("", "null");

    let version = cinf.version.unwrap_or(VersionTriple {
        major: 1.0,
        minor: 0.0,
        fix: 0.0,
    });
    write_version_triple(&mut desc, "Vrsn", &version);

    if let Some(psv) = &cinf.photoshop_version {
        write_version_triple(&mut desc, "psVersion", psv);
    }
    desc.set(
        "description",
        DescriptorValue::Text(cinf.description.clone()),
    );
    desc.set("reason", DescriptorValue::Text(cinf.reason.clone()));
    desc.set(
        "Engn",
        DescriptorValue::Enum(format!("Engn.{}", cinf.engine)),
    );
    if let Some(v) = &cinf.enable_comp_core {
        desc.set(
            "enableCompCore",
            DescriptorValue::Enum(format!("enable.{v}")),
        );
    }
    if let Some(v) = &cinf.enable_comp_core_gpu {
        desc.set(
            "enableCompCoreGPU",
            DescriptorValue::Enum(format!("enable.{v}")),
        );
    }
    if let Some(v) = &cinf.enable_comp_core_threads {
        desc.set(
            "enableCompCoreThreads",
            DescriptorValue::Enum(format!("enable.{v}")),
        );
    }
    if let Some(v) = &cinf.comp_core_support {
        desc.set(
            "compCoreSupport",
            DescriptorValue::Enum(format!("reason.{v}")),
        );
    }
    if let Some(v) = &cinf.comp_core_gpu_support {
        desc.set(
            "compCoreGPUSupport",
            DescriptorValue::Enum(format!("reason.{v}")),
        );
    }

    write_version_and_descriptor(writer, &desc);
}

fn write_artb(writer: &mut PsdWriter, info: &LayerAdditionalInfo) {
    let artboard = info.artboard.as_ref().unwrap();
    let rect = &artboard.rect;
    let mut desc = Descriptor::new("", "artboard");

    let mut rect_desc = Descriptor::new("", "classFloatRect");
    // getTypeByKey: Top/Left/Btom/Rght as number → doub (except slices root).
    rect_desc.set("Top ", DescriptorValue::Double(rect.top));
    rect_desc.set("Left", DescriptorValue::Double(rect.left));
    rect_desc.set("Btom", DescriptorValue::Double(rect.bottom));
    rect_desc.set("Rght", DescriptorValue::Double(rect.right));
    desc.set("artboardRect", DescriptorValue::Descriptor(rect_desc));

    let guides: Vec<DescriptorValue> = artboard
        .guide_indices
        .as_ref()
        .map(|gs| {
            gs.iter()
                .map(|g| DescriptorValue::Integer(*g as i32))
                .collect()
        })
        .unwrap_or_default();
    desc.set("guideIndeces", DescriptorValue::List(guides));

    desc.set(
        "artboardPresetName",
        DescriptorValue::Text(artboard.preset_name.clone().unwrap_or_default()),
    );

    let color = artboard.color.unwrap_or(Color::Rgb(Rgb {
        r: 0.0,
        g: 0.0,
        b: 0.0,
    }));
    desc.set(
        "Clr ",
        DescriptorValue::Descriptor(serialize_color(Some(&color))),
    );

    desc.set(
        "artboardBackgroundType",
        DescriptorValue::Integer(artboard.background_type.unwrap_or(1.0) as i32),
    );

    write_version_and_descriptor(writer, &desc);
}

// ===========================================================================
// TESTS
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::additional_info::test_support;
    use crate::psd::Grayscale;

    fn roundtrip(info: LayerAdditionalInfo) -> LayerAdditionalInfo {
        test_support::roundtrip(&info)
    }

    #[test]
    fn roundtrip_sn2p() {
        let mut info = LayerAdditionalInfo::default();
        info.using_aligned_rendering = Some(true);
        let out = roundtrip(info);
        assert_eq!(out.using_aligned_rendering, Some(true));
    }

    #[test]
    fn roundtrip_lmsk() {
        let mut info = LayerAdditionalInfo::default();
        info.user_mask = Some(ColorSpaceMask {
            color_space: Color::Rgb(Rgb {
                r: 255.0,
                g: 0.0,
                b: 128.0,
            }),
            opacity: 0.5,
        });
        let out = roundtrip(info);
        let m = out.user_mask.expect("user_mask");
        match m.color_space {
            Color::Rgb(c) => {
                assert!((c.r - 255.0).abs() < 1.0);
                assert!((c.b - 128.0).abs() < 1.0);
            }
            other => panic!("unexpected color {other:?}"),
        }
        assert!((m.opacity - 0.5).abs() < 0.01);
    }

    #[test]
    fn roundtrip_fmsk() {
        let mut info = LayerAdditionalInfo::default();
        info.filter_mask = Some(ColorSpaceMask {
            color_space: Color::Grayscale(Grayscale { k: 100.0 }),
            opacity: 1.0,
        });
        let out = roundtrip(info);
        let m = out.filter_mask.expect("filter_mask");
        assert!(matches!(m.color_space, Color::Grayscale(_)));
        assert!((m.opacity - 1.0).abs() < 0.01);
    }

    #[test]
    fn roundtrip_cinf() {
        let mut info = LayerAdditionalInfo::default();
        info.compositor_used = Some(CompositorUsed {
            version: Some(VersionTriple {
                major: 1.0,
                minor: 2.0,
                fix: 3.0,
            }),
            photoshop_version: Some(VersionTriple {
                major: 24.0,
                minor: 0.0,
                fix: 0.0,
            }),
            description: "desc".to_string(),
            reason: "reason text".to_string(),
            engine: "compCore".to_string(),
            enable_comp_core: Some("feature".to_string()),
            comp_core_support: Some("supported".to_string()),
            ..Default::default()
        });
        let out = roundtrip(info);
        let c = out.compositor_used.expect("compositor_used");
        assert_eq!(c.description, "desc");
        assert_eq!(c.reason, "reason text");
        assert_eq!(c.engine, "compCore");
        assert_eq!(c.enable_comp_core.as_deref(), Some("feature"));
        assert_eq!(c.comp_core_support.as_deref(), Some("supported"));
        let v = c.version.expect("version");
        assert_eq!((v.major, v.minor, v.fix), (1.0, 2.0, 3.0));
        let pv = c.photoshop_version.expect("psVersion");
        assert_eq!((pv.major, pv.minor, pv.fix), (24.0, 0.0, 0.0));
    }

    #[test]
    fn roundtrip_feid() {
        let mut info = LayerAdditionalInfo::default();
        info.filter_effects_masks = Some(vec![FilterEffectsMask {
            id: "my-id".to_string(),
            top: 1.0,
            left: 2.0,
            bottom: 30.0,
            right: 40.0,
            depth: 8.0,
            channels: vec![
                Some(FilterEffectsChannel {
                    compression_mode: 0.0,
                    data: vec![1, 2, 3],
                }),
                None,
                Some(FilterEffectsChannel {
                    compression_mode: 1.0,
                    data: vec![9, 8],
                }),
            ],
            extra: Some(FilterEffectsExtra {
                top: 5.0,
                left: 6.0,
                bottom: 7.0,
                right: 8.0,
                compression_mode: 0.0,
                data: vec![4, 5, 6, 7],
            }),
        }]);
        let out = roundtrip(info);
        let masks = out.filter_effects_masks.expect("filter_effects_masks");
        assert_eq!(masks.len(), 1);
        let m = &masks[0];
        assert_eq!(m.id, "my-id");
        assert_eq!(
            (m.top, m.left, m.bottom, m.right, m.depth),
            (1.0, 2.0, 30.0, 40.0, 8.0)
        );
        assert_eq!(m.channels.len(), 3);
        assert_eq!(m.channels[0].as_ref().unwrap().data, vec![1, 2, 3]);
        assert!(m.channels[1].is_none());
        assert_eq!(m.channels[2].as_ref().unwrap().data, vec![9, 8]);
        let extra = m.extra.as_ref().expect("extra");
        assert_eq!(extra.data, vec![4, 5, 6, 7]);
        assert_eq!(
            (extra.top, extra.left, extra.bottom, extra.right),
            (5.0, 6.0, 7.0, 8.0)
        );
    }

    #[test]
    fn roundtrip_artb() {
        let mut info = LayerAdditionalInfo::default();
        info.artboard = Some(LayerArtboard {
            rect: Bounds {
                top: 0.0,
                left: 0.0,
                bottom: 1000.0,
                right: 800.0,
            },
            guide_indices: Some(vec![1.0, 2.0]),
            preset_name: Some("iPhone".to_string()),
            color: Some(Color::Rgb(Rgb {
                r: 255.0,
                g: 255.0,
                b: 255.0,
            })),
            background_type: Some(1.0),
        });
        let out = roundtrip(info);
        let a = out.artboard.expect("artboard");
        assert_eq!((a.rect.bottom, a.rect.right), (1000.0, 800.0));
        assert_eq!(a.preset_name.as_deref(), Some("iPhone"));
        assert_eq!(a.guide_indices.as_deref(), Some(&[1.0, 2.0][..]));
        assert_eq!(a.background_type, Some(1.0));
        assert!(matches!(a.color, Some(Color::Rgb(_))));
    }
}

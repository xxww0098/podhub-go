/*
File: rust/crates/psd-x/src/image_resources/mod.rs

Purpose:
PSD image resource blocks (document-level resources).

Source compatibility:
- port of upstream ag-psd `src/imageResources.ts` (1:1 split).

Main responsibilities:
- mirror the corresponding upstream module while porting;
- keep this area's public contract in one place.

PORT STATUS: ported.

ARCHITECTURE — handler registry
================================
Upstream models per-resource handlers as an array `resourceHandlers[]` plus a
`resourceHandlersMap[key]`, each entry `{ key, has, read, write }`. In Rust a
`Vec<{ read: closure, write: closure }>` is awkward: the closures borrow the
typed `ImageResources` model mutably with differing capture sets and lifetimes,
and `read` needs the `left()` section-length callback. Instead the registry is
expressed as three free functions dispatching on the resource id:

  - [`has_image_resource`]  — mirror of each handler's `has` predicate (which
    resources are present, in upstream order — see [`RESOURCE_IDS`]);
  - [`read_image_resource`] — `match id { .. }` over the per-id read body;
  - [`write_image_resource`] — `match id { .. }` over the per-id write body.

This is the idiomatic, zero-cost Rust analog of `resourceHandlersMap[key]`: the
exact id numbers, signatures, padding and field math are preserved; only the
dispatch shape changes (a `match` instead of a closure table).

Upstream's `MOCK_HANDLERS && addHandler(...)` blocks are never registered (the
flag is always false upstream too). They are left unported (they only stash raw
bytes into `_irNNNN` debug fields that do not exist on the typed model). The
real (always-registered) handlers are all ported.

Notes
=====
- id 1036 thumbnail: JPEG decode/encode is gated on the `thumbnail` feature
  (`zune-jpeg` / `jpeg-encoder`). Without the feature, raw `thumbnail_raw`
  passthrough is always preserved.
- id 1075 timelineInformation uses `additional_info::timeline` converters.
- id 1006 encoded alpha names use `encoding_rs::GBK` for the high-bit branch.
*/

#![allow(clippy::too_many_lines)]

mod animations;
mod slices;
#[cfg(test)]
mod tests;
mod thumbnail_res;
mod timeline_ir;
mod write_dispatch;

pub use write_dispatch::write_image_resource;

use crate::descriptor::{DescriptorValue, read_version_and_descriptor};
use crate::helpers::EnumCodec;
use crate::psd::{
    BlendMode, CountInformation, DimensionUnit, GridAndGuidesInformation, GridInfo, GuideDirection,
    GuideInfo, ImageResources, LayerCompListItem, LayerCompsResource, OnionSkins, PixelAspectRatio,
    PointF, PrintFlags, PrintInformation, PrintScale, PrintScaleStyle, ProofSetup, RenderingIntent,
    ResolutionInfo, ResolutionUnit, Rgb, SheetDisclosure, SheetTimelineOption, UrlListItem,
    VersionInfo,
};
use crate::reader::{
    PsdReader, ReadError, ReadResult, read_ascii_string, read_bytes, read_color,
    read_fixed_point32, read_float32, read_float64, read_int16, read_int32, read_signature,
    read_uint8, read_uint16, read_uint32, read_unicode_string, skip_bytes,
};
use crate::utf8::{decode_string, encode_string};
use crate::writer::{PsdWriter, write_bytes, write_uint8};

// ===========================================================================
// Tables / small helpers (mirror module-level consts in imageResources.ts)
// ===========================================================================

/// Mirror `RESOLUTION_UNITS = [undefined, 'PPI', 'PPCM']` (1-based).
const RESOLUTION_UNITS: [Option<ResolutionUnit>; 3] =
    [None, Some(ResolutionUnit::Ppi), Some(ResolutionUnit::Ppcm)];

/// Mirror `MEASUREMENT_UNITS = [undefined, 'Inches', 'Centimeters', 'Points', 'Picas', 'Columns']`.
const MEASUREMENT_UNITS: [Option<DimensionUnit>; 6] = [
    None,
    Some(DimensionUnit::Inches),
    Some(DimensionUnit::Centimeters),
    Some(DimensionUnit::Points),
    Some(DimensionUnit::Picas),
    Some(DimensionUnit::Columns),
];

const HEX: &[u8; 16] = b"0123456789abcdef";

/// Mirror `charToNibble`.
pub(crate) fn char_to_nibble(code: u8) -> u8 {
    if code <= 57 { code - 48 } else { code - 87 }
}

/// Mirror `byteAt(value, index)`.
pub(crate) fn byte_at(value: &str, index: usize) -> u8 {
    let bytes = value.as_bytes();
    (char_to_nibble(bytes[index]) << 4) | char_to_nibble(bytes[index + 1])
}

/// Mirror `readUtf8String(reader, length)`.
pub(crate) fn read_utf8_string(reader: &mut PsdReader, length: usize) -> ReadResult<String> {
    let buffer = read_bytes(reader, length)?;
    decode_string(&buffer).map_err(|_| ReadError::StrictViolation("Invalid UTF-8".to_string()))
}

/// Mirror `writeUtf8String(writer, value)`.
pub(crate) fn write_utf8_string(writer: &mut PsdWriter, value: &str) {
    let buffer = encode_string(value);
    write_bytes(writer, Some(&buffer));
}

/// Mirror `readEncodedString(reader)`.
///
/// Reads a uint8 length, then `length` bytes. If any byte has the high bit set,
/// upstream uses `TextDecoder('gbk')`; we decode with `encoding_rs::GBK` and
/// fall back to UTF-8 (upstream catch) when that fails.
pub(crate) fn read_encoded_string(reader: &mut PsdReader) -> ReadResult<String> {
    let length = read_uint8(reader)? as usize;
    let buffer = read_bytes(reader, length)?;

    let not_ascii = buffer.iter().any(|&b| b & 0x80 != 0);

    if not_ascii {
        let (cow, _enc, had_errors) = encoding_rs::GBK.decode(&buffer);
        if !had_errors {
            return Ok(cow.into_owned());
        }
        // Upstream `catch` falls through to UTF-8 decode.
        decode_string(&buffer).map_err(|_| ReadError::StrictViolation("Invalid UTF-8".to_string()))
    } else {
        decode_string(&buffer).map_err(|_| ReadError::StrictViolation("Invalid UTF-8".to_string()))
    }
}

/// Mirror `writeEncodedString(writer, value)`.
pub(crate) fn write_encoded_string(writer: &mut PsdWriter, value: &str) {
    // Replace any code point > 0x7f with '?'.
    let ascii: String = value
        .chars()
        .map(|c| if (c as u32) > 0x7f { '?' } else { c })
        .collect();
    let buffer = encode_string(&ascii);
    write_uint8(writer, buffer.len() as u8);
    write_bytes(writer, Some(&buffer));
}

// ===========================================================================
// EnumCodec instances (mirror createEnum<...> module-level consts)
// ===========================================================================

pub(crate) fn dict(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

/// Mirror `Inte = createEnum<RenderingIntent>('Inte', 'perceptual', {...})`.
pub(crate) fn inte_codec() -> EnumCodec {
    EnumCodec::new(
        "Inte",
        "perceptual",
        dict(&[
            ("perceptual", "Img "),
            ("saturation", "Grp "),
            ("relative colorimetric", "Clrm"),
            ("absolute colorimetric", "AClr"),
        ]),
    )
}

/// Mirror `FrmD = createEnum<'auto'|'none'|'dispose'>('FrmD', '', {...})`.
pub(crate) fn frmd_codec() -> EnumCodec {
    EnumCodec::new(
        "FrmD",
        "",
        dict(&[("auto", "Auto"), ("none", "None"), ("dispose", "Disp")]),
    )
}

// Slice enums (mirror ESlice* from descriptor.ts, defined locally as a gap).
pub(crate) fn eslice_type_codec() -> EnumCodec {
    crate::descriptor_enums::eslice_type()
}
pub(crate) fn eslice_horz_codec() -> EnumCodec {
    crate::descriptor_enums::eslice_horz_align()
}
pub(crate) fn eslice_vert_codec() -> EnumCodec {
    crate::descriptor_enums::eslice_vert_align()
}
pub(crate) fn eslice_origin_codec() -> EnumCodec {
    crate::descriptor_enums::eslice_origin()
}
pub(crate) fn eslice_bg_codec() -> EnumCodec {
    crate::descriptor_enums::eslice_bg_color_type()
}

// ===========================================================================
// RenderingIntent <-> string helpers (model enum <-> EnumCodec string)
// ===========================================================================

impl RenderingIntent {
    /// Wire string for this intent ("perceptual" …).
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            RenderingIntent::Perceptual => "perceptual",
            RenderingIntent::Saturation => "saturation",
            RenderingIntent::RelativeColorimetric => "relative colorimetric",
            RenderingIntent::AbsoluteColorimetric => "absolute colorimetric",
        }
    }

    /// Wire string -> intent; unknown values fall back to Perceptual.
    pub(crate) fn from_name(s: &str) -> RenderingIntent {
        match s {
            "saturation" => RenderingIntent::Saturation,
            "relative colorimetric" => RenderingIntent::RelativeColorimetric,
            "absolute colorimetric" => RenderingIntent::AbsoluteColorimetric,
            _ => RenderingIntent::Perceptual,
        }
    }
}

// ===========================================================================
// Registry surface (ordered list of always-registered resource ids)
// ===========================================================================

/// Resource ids in upstream registration order (real, non-MOCK handlers).
///
/// Mirror of the order in which `addHandler(...)` runs for non-mock entries.
pub const RESOURCE_IDS: &[u16] = &[
    1061, // captionDigest
    1060, // xmpMetadata
    1082, // printInformation
    1005, // resolutionInfo
    1062, // printScale
    1006, // alphaChannelNames (encoded)
    1045, // alphaChannelNames (unicode)
    1053, // alphaIdentifiers
    1010, // backgroundColor
    1037, // globalAngle
    1049, // globalAltitude
    1011, // printFlags
    1034, // copyrighted
    1035, // url
    1080, // countInformation
    1024, // layerState
    1026, // layersGroup
    1072, // layerGroupsEnabledId
    1069, // layerSelectionIds
    1032, // gridAndGuidesInformation
    1065, // layerComps
    1078, // onionSkins
    1075, // timelineInformation (stub — see header)
    1076, // sheetDisclosure
    1054, // urlsList
    1050, // slices
    1064, // pixelAspectRatio
    1041, // iccUntaggedProfile
    1044, // idsSeedNumber
    1036, // thumbnail
    1057, // versionInfo
    7000, // imageReadyVariables
    7001, // imageReadyDataSets
    1088, // pathSelectionState
    4000, // animations
];

/// Mirror of each handler's `has(target)` predicate. Returns whether the resource
/// should be written, plus a count for `slices` (matches upstream returning a
/// number there). For most resources the count is 1.
pub fn has_image_resource(id: u16, target: &ImageResources) -> usize {
    let present = match id {
        1061 => target.caption_digest.is_some(),
        1060 => target.xmp_metadata.is_some(),
        1082 => target.print_information.is_some(),
        1005 => target.resolution_info.is_some(),
        1062 => target.print_scale.is_some(),
        1006 | 1045 => target.alpha_channel_names.is_some(),
        1053 => target.alpha_identifiers.is_some(),
        1010 => target.background_color.is_some(),
        1037 => target.global_angle.is_some(),
        1049 => target.global_altitude.is_some(),
        1011 => target.print_flags.is_some(),
        1034 => target.copyrighted.is_some(),
        1035 => target.url.is_some(),
        1080 => target.count_information.is_some(),
        1024 => target.layer_state.is_some(),
        1069 => target.layer_selection_ids.is_some(),
        1032 => target.grid_and_guides_information.is_some(),
        1065 => target.layer_comps.is_some(),
        1078 => target.onion_skins.is_some(),
        1075 => target.timeline_information.is_some(),
        1076 => target.sheet_disclosure.is_some(),
        1054 => target.urls_list.is_some(),
        1050 => return target.slices.as_ref().map_or(0, |s| s.len()),
        1064 => target.pixel_aspect_ratio.is_some(),
        1041 => target.icc_untagged_profile.is_some(),
        1044 => target.ids_seed_number.is_some(),
        1036 => target.thumbnail.is_some() || target.thumbnail_raw.is_some(),
        1057 => target.version_info.is_some(),
        7000 => target.image_ready_variables.is_some(),
        7001 => target.image_ready_data_sets.is_some(),
        1088 => target.path_selection_state.is_some(),
        4000 => target.animations.is_some(),
        // InternalImageResources (writer always sets these from flattened layers).
        1026 => target.layers_group.is_some(),
        1072 => target.layer_groups_enabled_id.is_some(),
        _ => false,
    };
    usize::from(present)
}

// ===========================================================================
// Read dispatch
// ===========================================================================

/// Mirror `resourceHandlersMap[key].read(reader, target, left)`.
///
/// `left` is the number of bytes remaining in the resource block (mirror of the
/// `left()` callback). Unknown ids are ignored (caller skips the block).
pub fn read_image_resource(
    id: u16,
    reader: &mut PsdReader,
    target: &mut ImageResources,
    left: usize,
) -> ReadResult<()> {
    match id {
        1061 => {
            let mut caption_digest = String::new();
            for _ in 0..16 {
                let byte = read_uint8(reader)?;
                caption_digest.push(HEX[(byte >> 4) as usize] as char);
                caption_digest.push(HEX[(byte & 0xf) as usize] as char);
            }
            target.caption_digest = Some(caption_digest);
        }
        1060 => {
            target.xmp_metadata = Some(read_utf8_string(reader, left)?);
        }
        1082 => {
            let desc = read_version_and_descriptor(reader)?;
            let intent = inte_codec()
                .decode(
                    &desc
                        .enumeration("Inte")
                        .unwrap_or_else(|| "Inte.Img ".to_string()),
                )
                .unwrap_or_else(|_| "perceptual".to_string());

            let mut info = PrintInformation {
                printer_name: Some(desc.text("printerName").unwrap_or_default()),
                rendering_intent: Some(RenderingIntent::from_name(&intent)),
                ..Default::default()
            };

            if let Some(v) = desc.bool("PstS") {
                info.printer_manages_colors = Some(v);
            }
            if let Some(v) = desc.text("Nm  ") {
                info.printer_profile = Some(v);
            }
            if let Some(v) = desc.bool("MpBl") {
                info.black_point_compensation = Some(v);
            }
            if let Some(v) = desc.bool("printSixteenBit") {
                info.print_sixteen_bit = Some(v);
            }
            if let Some(v) = desc.bool("hardProof") {
                info.hard_proof = Some(v);
            }
            if let Some(setup) = desc.descriptor("printProofSetup") {
                if let Some(DescriptorValue::Enum(bltn)) = setup.get("Bltn") {
                    let builtin = bltn.split('.').nth(1).unwrap_or("").to_string();
                    info.proof_setup = Some(ProofSetup::Builtin { builtin });
                } else if let Some(DescriptorValue::Text(bltn)) = setup.get("Bltn") {
                    let builtin = bltn.split('.').nth(1).unwrap_or("").to_string();
                    info.proof_setup = Some(ProofSetup::Builtin { builtin });
                } else {
                    let intent = inte_codec()
                        .decode(
                            &setup
                                .enumeration("Inte")
                                .unwrap_or_else(|| "Inte.Img ".to_string()),
                        )
                        .unwrap_or_else(|_| "perceptual".to_string());
                    info.proof_setup = Some(ProofSetup::Profile {
                        profile: setup.text("profile").unwrap_or_default(),
                        rendering_intent: Some(RenderingIntent::from_name(&intent)),
                        black_point_compensation: Some(setup.bool("MpBl").unwrap_or(false)),
                        paper_white: Some(setup.bool("paperWhite").unwrap_or(false)),
                    });
                }
            }

            target.print_information = Some(info);
        }
        1005 => {
            let horizontal_resolution = read_fixed_point32(reader)?;
            let horizontal_resolution_unit = read_uint16(reader)? as usize;
            let width_unit = read_uint16(reader)? as usize;
            let vertical_resolution = read_fixed_point32(reader)?;
            let vertical_resolution_unit = read_uint16(reader)? as usize;
            let height_unit = read_uint16(reader)? as usize;

            target.resolution_info = Some(ResolutionInfo {
                horizontal_resolution,
                horizontal_resolution_unit: RESOLUTION_UNITS
                    .get(horizontal_resolution_unit)
                    .copied()
                    .flatten()
                    .unwrap_or(ResolutionUnit::Ppi),
                width_unit: MEASUREMENT_UNITS
                    .get(width_unit)
                    .copied()
                    .flatten()
                    .unwrap_or(DimensionUnit::Inches),
                vertical_resolution,
                vertical_resolution_unit: RESOLUTION_UNITS
                    .get(vertical_resolution_unit)
                    .copied()
                    .flatten()
                    .unwrap_or(ResolutionUnit::Ppi),
                height_unit: MEASUREMENT_UNITS
                    .get(height_unit)
                    .copied()
                    .flatten()
                    .unwrap_or(DimensionUnit::Inches),
            });
        }
        1062 => {
            let style_index = read_int16(reader)?;
            let style = match style_index {
                0 => Some(PrintScaleStyle::Centered),
                1 => Some(PrintScaleStyle::SizeToFit),
                2 => Some(PrintScaleStyle::UserDefined),
                _ => None,
            };
            target.print_scale = Some(PrintScale {
                style,
                x: Some(read_float32(reader)? as f64),
                y: Some(read_float32(reader)? as f64),
                scale: Some(read_float32(reader)? as f64),
            });
        }
        1006 => {
            // skip if the unicode versions are already read
            if target.alpha_channel_names.is_none() {
                let mut names = Vec::new();
                let end = reader.offset + left;
                while reader.offset < end {
                    names.push(read_encoded_string(reader)?);
                }
                target.alpha_channel_names = Some(names);
            } else {
                skip_bytes(reader, left);
            }
        }
        1045 => {
            let mut names = Vec::new();
            let end = reader.offset + left;
            while reader.offset < end {
                names.push(read_unicode_string(reader)?);
            }
            target.alpha_channel_names = Some(names);
        }
        1053 => {
            let mut ids = Vec::new();
            let end = reader.offset + left;
            while end.saturating_sub(reader.offset) >= 4 {
                ids.push(read_uint32(reader)? as f64);
            }
            target.alpha_identifiers = Some(ids);
        }
        1010 => {
            target.background_color = Some(read_color(reader)?);
        }
        1037 => {
            target.global_angle = Some(read_int32(reader)? as f64);
        }
        1049 => {
            target.global_altitude = Some(read_uint32(reader)? as f64);
        }
        1011 => {
            target.print_flags = Some(PrintFlags {
                labels: Some(read_uint8(reader)? != 0),
                crop_marks: Some(read_uint8(reader)? != 0),
                color_bars: Some(read_uint8(reader)? != 0),
                registration_marks: Some(read_uint8(reader)? != 0),
                negative: Some(read_uint8(reader)? != 0),
                flip: Some(read_uint8(reader)? != 0),
                interpolate: Some(read_uint8(reader)? != 0),
                caption: Some(read_uint8(reader)? != 0),
                print_flags: Some(read_uint8(reader)? != 0),
            });
        }
        1034 => {
            target.copyrighted = Some(read_uint8(reader)? != 0);
        }
        1035 => {
            target.url = Some(read_ascii_string(reader, left)?);
        }
        1080 => {
            let desc = read_version_and_descriptor(reader)?;
            let mut groups = Vec::new();
            if let Some(list) = desc.list("countGroupList") {
                for item in list {
                    if let DescriptorValue::Descriptor(g) = item {
                        let mut points = Vec::new();
                        if let Some(plist) = g.list("countObjectList") {
                            for p in plist {
                                if let DescriptorValue::Descriptor(pd) = p {
                                    points.push(PointF {
                                        x: pd.number("X   ").unwrap_or(0.0),
                                        y: pd.number("Y   ").unwrap_or(0.0),
                                    });
                                }
                            }
                        }
                        groups.push(CountInformation {
                            color: Rgb {
                                r: g.number("Rd  ").unwrap_or(0.0),
                                g: g.number("Grn ").unwrap_or(0.0),
                                b: g.number("Bl  ").unwrap_or(0.0),
                            },
                            name: g.text("Nm  ").unwrap_or_default(),
                            size: g.number("Rds ").unwrap_or(0.0),
                            font_size: g.number("fontSize").unwrap_or(0.0),
                            visible: g.bool("Vsbl").unwrap_or(false),
                            points,
                        });
                    }
                }
            }
            target.count_information = Some(groups);
        }
        1024 => {
            target.layer_state = Some(read_uint16(reader)? as f64);
        }
        1026 => {
            // InternalImageResources.layersGroup — applied to Layer.linkGroup in read_layer_info.
            let mut groups = Vec::new();
            let mut remaining = left;
            while remaining >= 2 {
                groups.push(read_uint16(reader)? as f64);
                remaining -= 2;
            }
            if remaining > 0 {
                skip_bytes(reader, remaining);
            }
            reader.layers_group = groups;
        }
        1072 => {
            // InternalImageResources.layerGroupsEnabledId → Layer.linkGroupEnabled.
            let mut ids = Vec::new();
            let mut remaining = left;
            while remaining >= 1 {
                ids.push(read_uint8(reader)? as f64);
                remaining -= 1;
            }
            reader.layer_groups_enabled_id = ids;
        }
        1069 => {
            let mut count = read_uint16(reader)?;
            let mut ids = Vec::new();
            while count > 0 {
                count -= 1;
                ids.push(read_uint32(reader)? as f64);
            }
            target.layer_selection_ids = Some(ids);
        }
        1032 => {
            let version = read_uint32(reader)?;
            let horizontal = read_uint32(reader)? as f64;
            let vertical = read_uint32(reader)? as f64;
            let count = read_uint32(reader)?;

            if version != 1 {
                return Err(ReadError::StrictViolation(format!(
                    "Invalid 1032 resource version: {version}"
                )));
            }

            let mut guides = Vec::new();
            for _ in 0..count {
                let location = read_uint32(reader)? as f64 / 32.0;
                let direction = if read_uint8(reader)? != 0 {
                    GuideDirection::Horizontal
                } else {
                    GuideDirection::Vertical
                };
                guides.push(GuideInfo {
                    location,
                    direction,
                });
            }

            target.grid_and_guides_information = Some(GridAndGuidesInformation {
                grid: Some(GridInfo {
                    horizontal,
                    vertical,
                }),
                guides: Some(guides),
            });
        }
        1065 => {
            let desc = read_version_and_descriptor(reader)?;
            let mut list = Vec::new();
            if let Some(items) = desc.list("list") {
                for item in items {
                    if let DescriptorValue::Descriptor(it) = item {
                        let comment = it.text("comment");
                        list.push(LayerCompListItem {
                            id: it.number("compID").unwrap_or(0.0),
                            name: it.text("Nm  ").unwrap_or_default(),
                            comment,
                            // Bitmask; keep raw number (7 = visibility|position|appearance).
                            captured_info: it.number("capturedInfo").unwrap_or(0.0),
                        });
                    }
                }
            }
            let last_applied = desc.number("lastAppliedComp");
            target.layer_comps = Some(LayerCompsResource { list, last_applied });
        }
        1078 => {
            let desc = read_version_and_descriptor(reader)?;
            let blnm = desc.integer("BlnM").unwrap_or(0);
            target.onion_skins = Some(OnionSkins {
                enabled: desc.bool("enab").unwrap_or(false),
                frames_before: desc.number("numBefore").unwrap_or(0.0),
                frames_after: desc.number("numAfter").unwrap_or(0.0),
                frame_spacing: desc.number("Spcn").unwrap_or(0.0),
                min_opacity: desc.number("minOpacity").unwrap_or(0.0) / 100.0,
                max_opacity: desc.number("maxOpacity").unwrap_or(0.0) / 100.0,
                blend_mode: onion_skin_blend_mode(blnm),
            });
        }
        1075 => {
            timeline_ir::read_timeline_information(reader, target)?;
        }
        1076 => {
            let desc = read_version_and_descriptor(reader)?;
            let mut disclosure = SheetDisclosure::default();
            if let Some(list) = desc.list("sheetTimelineOptions") {
                let mut options = Vec::new();
                for item in list {
                    if let DescriptorValue::Descriptor(o) = item {
                        options.push(SheetTimelineOption {
                            sheet_id: o.number("sheetID").unwrap_or(0.0),
                            sheet_disclosed: o.bool("sheetDisclosed").unwrap_or(false),
                            lights_disclosed: o.bool("lightsDisclosed").unwrap_or(false),
                            meshes_disclosed: o.bool("meshesDisclosed").unwrap_or(false),
                            materials_disclosed: o.bool("materialsDisclosed").unwrap_or(false),
                        });
                    }
                }
                disclosure.sheet_timeline_options = Some(options);
            }
            target.sheet_disclosure = Some(disclosure);
        }
        1054 => {
            let count = read_uint32(reader)?;
            let mut list = Vec::new();
            for _ in 0..count {
                let long = read_signature(reader)?;
                if long != "slic" && reader.options.throw_for_missing_features == Some(true) {
                    return Err(ReadError::StrictViolation("Unknown long".to_string()));
                }
                let id = read_uint32(reader)? as f64;
                let url = read_unicode_string(reader)?;
                list.push(UrlListItem {
                    id,
                    url,
                    r#ref: "slice".to_string(),
                });
            }
            target.urls_list = Some(list);
        }
        1050 => {
            slices::read_slices(reader, target)?;
        }
        1064 => {
            if read_uint32(reader)? > 2 {
                return Err(ReadError::StrictViolation(
                    "Invalid pixelAspectRatio version".to_string(),
                ));
            }
            target.pixel_aspect_ratio = Some(PixelAspectRatio {
                aspect: read_float64(reader)?,
            });
        }
        1041 => {
            target.icc_untagged_profile = Some(read_uint8(reader)? != 0);
        }
        1044 => {
            target.ids_seed_number = Some(read_uint32(reader)? as f64);
        }
        1036 => {
            thumbnail_res::read_thumbnail(reader, target, left)?;
        }
        1057 => {
            let version = read_uint32(reader)?;
            if version != 1 {
                return Err(ReadError::StrictViolation(
                    "Invalid versionInfo version".to_string(),
                ));
            }
            target.version_info = Some(VersionInfo {
                has_real_merged_data: read_uint8(reader)? != 0,
                writer_name: read_unicode_string(reader)?,
                reader_name: read_unicode_string(reader)?,
                file_version: read_uint32(reader)? as f64,
            });
            // skipBytes(reader, left()) — already consumed; remaining skipped by caller.
            let consumed_end = reader.offset;
            let _ = consumed_end;
            skip_bytes(reader, 0);
        }
        7000 => {
            target.image_ready_variables = Some(read_utf8_string(reader, left)?);
        }
        7001 => {
            target.image_ready_data_sets = Some(read_utf8_string(reader, left)?);
        }
        1088 => {
            // Upstream stores `null` as `obj ` (Reference), which readReferenceStructure
            // flattens to string[] (`Path.vectorMask`, layer name, …).
            let desc = read_version_and_descriptor(reader)?;
            let mut paths = Vec::new();
            match desc.get("null") {
                Some(DescriptorValue::Reference(items)) => {
                    for item in items {
                        match item {
                            crate::descriptor::ReferenceItem::Enumerated(s)
                            | crate::descriptor::ReferenceItem::Property(s)
                            | crate::descriptor::ReferenceItem::Name(s) => {
                                paths.push(s.trim_end_matches('\0').to_string());
                            }
                            _ => {}
                        }
                    }
                }
                Some(DescriptorValue::List(list)) => {
                    for item in list {
                        if let DescriptorValue::Text(s) = item {
                            paths.push(s.trim_end_matches('\0').to_string());
                        }
                    }
                }
                _ => {}
            }
            target.path_selection_state = Some(paths);
        }
        4000 => {
            animations::read_animations(reader, target, left)?;
        }
        _ => {
            // Unknown / MOCK-only id — caller skips the block.
        }
    }
    Ok(())
}

// ===========================================================================
// Unit-index helpers (mirror Math.max(1, ARRAY.indexOf(x)))
// ===========================================================================

pub(crate) fn resolution_unit_index(u: ResolutionUnit) -> u16 {
    match u {
        ResolutionUnit::Ppi => 1,
        ResolutionUnit::Ppcm => 2,
    }
}

pub(crate) fn measurement_unit_index(u: DimensionUnit) -> u16 {
    match u {
        DimensionUnit::Inches => 1,
        DimensionUnit::Centimeters => 2,
        DimensionUnit::Points => 3,
        DimensionUnit::Picas => 4,
        DimensionUnit::Columns => 5,
    }
}

// ===========================================================================
// Onion-skin blend mode table (mirror onionSkinsBlendModes)
// ===========================================================================

pub(crate) fn onion_skin_blend_mode(index: i32) -> BlendMode {
    match index {
        7 => BlendMode::Multiply,
        8 => BlendMode::Screen,
        23 => BlendMode::Difference,
        _ => BlendMode::Normal,
    }
}

pub(crate) fn onion_skin_blend_index(mode: BlendMode) -> i32 {
    match mode {
        BlendMode::Multiply => 7,
        BlendMode::Screen => 8,
        BlendMode::Difference => 23,
        BlendMode::Normal => 0,
        _ => 0,
    }
}

// ===========================================================================
// ===========================================================================

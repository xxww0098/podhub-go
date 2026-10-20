//! Write dispatch for image resource handlers.

use super::*;
use crate::descriptor::{Descriptor, DescriptorValue, write_version_and_descriptor};
use crate::psd::*;
use crate::reader::ReadResult;
use crate::writer::*;

/// Mirror `resourceHandlersMap[key].write(writer, target, index)`.
pub fn write_image_resource(
    id: u16,
    writer: &mut PsdWriter,
    target: &ImageResources,
    index: usize,
) -> ReadResult<()> {
    match id {
        1061 => {
            let digest = target.caption_digest.as_deref().unwrap_or("");
            for i in 0..16 {
                write_uint8(writer, byte_at(digest, i * 2));
            }
        }
        1060 => {
            write_utf8_string(writer, target.xmp_metadata.as_deref().unwrap_or(""));
        }
        1082 => {
            let info = target.print_information.as_ref().unwrap();
            let mut desc = Descriptor::new("", "printOutput");

            if info.printer_manages_colors == Some(true) {
                desc.set("PstS", DescriptorValue::Boolean(true));
            } else {
                if let Some(hp) = info.hard_proof {
                    desc.set("hardProof", DescriptorValue::Boolean(hp));
                }
                desc.set("ClrS", DescriptorValue::Enum("ClrS.RGBC".to_string()));
                desc.set(
                    "Nm  ",
                    DescriptorValue::Text(
                        info.printer_profile
                            .clone()
                            .unwrap_or_else(|| "CIE RGB".to_string()),
                    ),
                );
            }

            let intent = info.rendering_intent.unwrap_or(RenderingIntent::Perceptual);
            desc.set(
                "Inte",
                DescriptorValue::Enum(inte_codec().encode(Some(intent.as_str())).unwrap()),
            );

            if info.printer_manages_colors != Some(true) {
                desc.set(
                    "MpBl",
                    DescriptorValue::Boolean(info.black_point_compensation.unwrap_or(false)),
                );
            }

            desc.set(
                "printSixteenBit",
                DescriptorValue::Boolean(info.print_sixteen_bit.unwrap_or(false)),
            );
            desc.set(
                "printerName",
                DescriptorValue::Text(info.printer_name.clone().unwrap_or_default()),
            );

            match &info.proof_setup {
                Some(ProofSetup::Profile {
                    profile,
                    rendering_intent,
                    black_point_compensation,
                    paper_white,
                }) => {
                    // Upstream fieldToExtType: printProofSetup → name "Proof Setup", classID "proofSetup"
                    let mut sub = Descriptor::new("Proof Setup", "proofSetup");
                    sub.set("profile", DescriptorValue::Text(profile.clone()));
                    let pi = rendering_intent.unwrap_or(RenderingIntent::Perceptual);
                    sub.set(
                        "Inte",
                        DescriptorValue::Enum(inte_codec().encode(Some(pi.as_str())).unwrap()),
                    );
                    sub.set(
                        "MpBl",
                        DescriptorValue::Boolean(black_point_compensation.unwrap_or(false)),
                    );
                    sub.set(
                        "paperWhite",
                        DescriptorValue::Boolean(paper_white.unwrap_or(false)),
                    );
                    desc.set("printProofSetup", DescriptorValue::Descriptor(sub));
                }
                other => {
                    let builtin = match other {
                        Some(ProofSetup::Builtin { builtin }) if !builtin.is_empty() => {
                            format!("builtinProof.{builtin}")
                        }
                        _ => "builtinProof.proofCMYK".to_string(),
                    };
                    // Upstream fieldToExtType: printProofSetup → name "Proof Setup", classID "proofSetup"
                    let mut sub = Descriptor::new("Proof Setup", "proofSetup");
                    sub.set("Bltn", DescriptorValue::Enum(builtin));
                    desc.set("printProofSetup", DescriptorValue::Descriptor(sub));
                }
            }

            write_version_and_descriptor(writer, &desc);
        }
        1005 => {
            let info = target.resolution_info.as_ref().unwrap();
            write_fixed_point32(writer, info.horizontal_resolution);
            write_uint16(
                writer,
                resolution_unit_index(info.horizontal_resolution_unit),
            );
            write_uint16(writer, measurement_unit_index(info.width_unit));
            write_fixed_point32(writer, info.vertical_resolution);
            write_uint16(writer, resolution_unit_index(info.vertical_resolution_unit));
            write_uint16(writer, measurement_unit_index(info.height_unit));
        }
        1062 => {
            let ps = target.print_scale.as_ref().unwrap();
            let style_index = match ps.style {
                Some(PrintScaleStyle::Centered) => 0,
                Some(PrintScaleStyle::SizeToFit) => 1,
                Some(PrintScaleStyle::UserDefined) => 2,
                None => 0,
            };
            write_int16(writer, style_index);
            write_float32(writer, ps.x.unwrap_or(0.0) as f32);
            write_float32(writer, ps.y.unwrap_or(0.0) as f32);
            write_float32(writer, ps.scale.unwrap_or(0.0) as f32);
        }
        1006 => {
            for name in target.alpha_channel_names.as_ref().unwrap() {
                write_encoded_string(writer, name);
            }
        }
        1045 => {
            for name in target.alpha_channel_names.as_ref().unwrap() {
                write_unicode_string_with_padding(writer, name);
            }
        }
        1053 => {
            for id in target.alpha_identifiers.as_ref().unwrap() {
                write_uint32(writer, *id as u32);
            }
        }
        1010 => {
            write_color(writer, target.background_color.as_ref());
        }
        1037 => {
            write_int32(writer, target.global_angle.unwrap() as i32);
        }
        1049 => {
            write_uint32(writer, target.global_altitude.unwrap() as u32);
        }
        1011 => {
            let f = target.print_flags.as_ref().unwrap();
            for b in [
                f.labels,
                f.crop_marks,
                f.color_bars,
                f.registration_marks,
                f.negative,
                f.flip,
                f.interpolate,
                f.caption,
                f.print_flags,
            ] {
                write_uint8(writer, u8::from(b.unwrap_or(false)));
            }
        }
        1034 => {
            write_uint8(writer, u8::from(target.copyrighted.unwrap_or(false)));
        }
        1035 => {
            write_ascii_string(writer, target.url.as_deref().unwrap());
        }
        1080 => {
            let mut desc = Descriptor::new("", "Cnt ");
            desc.set("Vrsn", DescriptorValue::Integer(1));
            let mut group_list = Vec::new();
            for g in target.count_information.as_ref().unwrap() {
                // fieldToArrayExtType: countGroup / countObject.
                let mut gd = Descriptor::new("", "countGroup");
                // getTypeByKey Rd/Grn/Bl → doub unless root=artd; X/Y are doub.
                gd.set("Rd  ", DescriptorValue::Double(g.color.r));
                gd.set("Grn ", DescriptorValue::Double(g.color.g));
                gd.set("Bl  ", DescriptorValue::Double(g.color.b));
                gd.set("Nm  ", DescriptorValue::Text(g.name.clone()));
                gd.set("Rds ", DescriptorValue::Integer(g.size as i32));
                gd.set("fontSize", DescriptorValue::Integer(g.font_size as i32));
                gd.set("Vsbl", DescriptorValue::Boolean(g.visible));
                let mut points = Vec::new();
                for p in &g.points {
                    let mut pd = Descriptor::new("", "countObject");
                    pd.set("X   ", DescriptorValue::Double(p.x));
                    pd.set("Y   ", DescriptorValue::Double(p.y));
                    points.push(DescriptorValue::Descriptor(pd));
                }
                gd.set("countObjectList", DescriptorValue::List(points));
                group_list.push(DescriptorValue::Descriptor(gd));
            }
            desc.set("countGroupList", DescriptorValue::List(group_list));
            write_version_and_descriptor(writer, &desc);
        }
        1024 => {
            write_uint16(writer, target.layer_state.unwrap() as u16);
        }
        1026 => {
            for g in target.layers_group.as_ref().unwrap() {
                write_uint16(writer, *g as u16);
            }
        }
        1072 => {
            for id in target.layer_groups_enabled_id.as_ref().unwrap() {
                write_uint8(writer, *id as u8);
            }
        }
        1069 => {
            let ids = target.layer_selection_ids.as_ref().unwrap();
            write_uint16(writer, ids.len() as u16);
            for id in ids {
                write_uint32(writer, *id as u32);
            }
        }
        1032 => {
            let info = target.grid_and_guides_information.as_ref().unwrap();
            let grid = info.grid.unwrap_or(GridInfo {
                horizontal: 18.0 * 32.0,
                vertical: 18.0 * 32.0,
            });
            let empty = Vec::new();
            let guides = info.guides.as_ref().unwrap_or(&empty);
            write_uint32(writer, 1);
            write_uint32(writer, grid.horizontal as u32);
            write_uint32(writer, grid.vertical as u32);
            write_uint32(writer, guides.len() as u32);
            for g in guides {
                write_uint32(writer, (g.location * 32.0) as u32);
                write_uint8(writer, u8::from(g.direction == GuideDirection::Horizontal));
            }
        }
        1065 => {
            let lc = target.layer_comps.as_ref().unwrap();
            let mut desc = Descriptor::new("", "CompList");
            let mut list = Vec::new();
            for item in &lc.list {
                let mut t = Descriptor::new("", "Comp");
                t.set("Nm  ", DescriptorValue::Text(item.name.clone()));
                if let Some(comment) = &item.comment {
                    t.set("comment", DescriptorValue::Text(comment.clone()));
                }
                t.set("compID", DescriptorValue::Integer(item.id as i32));
                t.set(
                    "capturedInfo",
                    DescriptorValue::Integer(item.captured_info as i32),
                );
                list.push(DescriptorValue::Descriptor(t));
            }
            desc.set("list", DescriptorValue::List(list));
            if let Some(last) = lc.last_applied {
                desc.set("lastAppliedComp", DescriptorValue::Integer(last as i32));
            }
            write_version_and_descriptor(writer, &desc);
        }
        1078 => {
            let os = target.onion_skins.as_ref().unwrap();
            let mut desc = Descriptor::new("", "null");
            desc.set("Vrsn", DescriptorValue::Integer(1));
            desc.set("enab", DescriptorValue::Boolean(os.enabled));
            desc.set(
                "numBefore",
                DescriptorValue::Integer(os.frames_before as i32),
            );
            desc.set("numAfter", DescriptorValue::Integer(os.frames_after as i32));
            desc.set("Spcn", DescriptorValue::Integer(os.frame_spacing as i32));
            desc.set(
                "minOpacity",
                DescriptorValue::Integer((os.min_opacity * 100.0) as i32),
            );
            desc.set(
                "maxOpacity",
                DescriptorValue::Integer((os.max_opacity * 100.0) as i32),
            );
            desc.set(
                "BlnM",
                DescriptorValue::Integer(onion_skin_blend_index(os.blend_mode)),
            );
            write_version_and_descriptor(writer, &desc);
        }
        1075 => {
            super::timeline_ir::write_timeline_information(writer, target)?;
        }
        1076 => {
            let d = target.sheet_disclosure.as_ref().unwrap();
            let mut desc = Descriptor::new("", "null");
            desc.set("Vrsn", DescriptorValue::Integer(1));
            if let Some(opts) = &d.sheet_timeline_options {
                let mut list = Vec::new();
                for o in opts {
                    // fieldToArrayExtType sheetTimelineOptions → null
                    let mut od = Descriptor::new("", "null");
                    od.set("Vrsn", DescriptorValue::Integer(2));
                    od.set("sheetID", DescriptorValue::Integer(o.sheet_id as i32));
                    od.set(
                        "sheetDisclosed",
                        DescriptorValue::Boolean(o.sheet_disclosed),
                    );
                    od.set(
                        "lightsDisclosed",
                        DescriptorValue::Boolean(o.lights_disclosed),
                    );
                    od.set(
                        "meshesDisclosed",
                        DescriptorValue::Boolean(o.meshes_disclosed),
                    );
                    od.set(
                        "materialsDisclosed",
                        DescriptorValue::Boolean(o.materials_disclosed),
                    );
                    list.push(DescriptorValue::Descriptor(od));
                }
                desc.set("sheetTimelineOptions", DescriptorValue::List(list));
            }
            write_version_and_descriptor(writer, &desc);
        }
        1054 => {
            let list = target.urls_list.as_ref().unwrap();
            write_uint32(writer, list.len() as u32);
            for item in list {
                write_signature(writer, "slic").expect("signature");
                write_uint32(writer, item.id as u32);
                write_unicode_string(writer, &item.url);
            }
        }
        1050 => {
            super::slices::write_slices(writer, target, index);
        }
        1064 => {
            write_uint32(writer, 2); // version
            write_float64(writer, target.pixel_aspect_ratio.as_ref().unwrap().aspect);
        }
        1041 => {
            write_uint8(
                writer,
                u8::from(target.icc_untagged_profile.unwrap_or(false)),
            );
        }
        1044 => {
            write_uint32(writer, target.ids_seed_number.unwrap() as u32);
        }
        1036 => {
            super::thumbnail_res::write_thumbnail(writer, target);
        }
        1057 => {
            let vi = target.version_info.as_ref().unwrap();
            write_uint32(writer, 1);
            write_uint8(writer, u8::from(vi.has_real_merged_data));
            write_unicode_string(writer, &vi.writer_name);
            write_unicode_string(writer, &vi.reader_name);
            write_uint32(writer, vi.file_version as u32);
        }
        7000 => {
            write_utf8_string(writer, target.image_ready_variables.as_deref().unwrap());
        }
        7001 => {
            write_utf8_string(writer, target.image_ready_data_sets.as_deref().unwrap());
        }
        1088 => {
            // Upstream typeToField: key `null` → `obj ` (Reference of Enmr/name).
            let mut desc = Descriptor::new("", "null");
            let paths = target.path_selection_state.as_ref().unwrap();
            let items: Vec<crate::descriptor::ReferenceItem> = paths
                .iter()
                .map(|s| {
                    if s.contains('.') {
                        crate::descriptor::ReferenceItem::Enumerated(s.clone())
                    } else {
                        crate::descriptor::ReferenceItem::Name(s.clone())
                    }
                })
                .collect();
            desc.set("null", DescriptorValue::Reference(items));
            write_version_and_descriptor(writer, &desc);
        }
        4000 => {
            super::animations::write_animations(writer, target);
        }
        _ => {}
    }
    Ok(())
}

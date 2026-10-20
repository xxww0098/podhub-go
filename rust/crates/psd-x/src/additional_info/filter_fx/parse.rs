//! parseFilterFX / parseFilterFXItem port.

use super::enums::*;
use super::util::*;
use crate::descriptor::{Descriptor, DescriptorValue, parse_color};
use crate::psd::*;
use crate::reader::{ReadError, ReadResult};

pub fn parse_filter_fx(desc: &Descriptor, throw_missing: bool) -> ReadResult<PlacedLayerFilter> {
    let list = desc.list("filterFXList").unwrap_or(&[]);
    let mut out = Vec::new();
    for item in list {
        let DescriptorValue::Descriptor(d) = item else {
            continue;
        };
        if let Some(f) = parse_filter_fx_item(d, throw_missing)? {
            out.push(f);
        }
    }
    Ok(PlacedLayerFilter {
        enabled: desc.bool("enab").unwrap_or(true),
        valid_at_position: desc.bool("validAtPosition").unwrap_or(true),
        mask_enabled: desc.bool("filterMaskEnable").unwrap_or(true),
        mask_linked: desc.bool("filterMaskLinked").unwrap_or(false),
        mask_extend_with_white: desc.bool("filterMaskExtendWithWhite").unwrap_or(true),
        list: out,
    })
}

pub fn parse_filter_fx_item(f: &Descriptor, throw_missing: bool) -> ReadResult<Option<Filter>> {
    let blend = f.descriptor("blendOptions");
    let opacity = blend
        .and_then(|b| b.get("Opct"))
        .map(crate::descriptor::parse_percent)
        .and_then(Result::ok)
        .unwrap_or(1.0);
    let blend_mode = blend
        .and_then(|b| b.enumeration("Md  "))
        .map(|s| bln_m_decode(&s))
        .unwrap_or(BlendMode::Normal);
    let frg = f
        .descriptor("FrgC")
        .map(parse_color)
        .transpose()?
        .unwrap_or(Color::Rgb(Rgb {
            r: 255.0,
            g: 255.0,
            b: 255.0,
        }));
    let bck = f
        .descriptor("BckC")
        .map(parse_color)
        .transpose()?
        .unwrap_or(Color::Rgb(Rgb {
            r: 0.0,
            g: 0.0,
            b: 0.0,
        }));

    let base = |variant: FilterVariant| Filter {
        variant,
        name: f.text("Nm  ").unwrap_or_default(),
        opacity,
        blend_mode,
        enabled: f.bool("enab").unwrap_or(true),
        has_options: f.bool("hasoptions").unwrap_or(false),
        foreground_color: frg.clone(),
        background_color: bck.clone(),
    };

    if let Some(fltr) = f.descriptor("Fltr") {
        let class_id = fltr.class_id.as_str();
        let variant = match class_id {
            "boxblur" => FilterVariant::BoxBlur(RadiusFilter {
                radius: fltr.units("Rds ")?,
            }),
            "GsnB" => FilterVariant::GaussianBlur(RadiusFilter {
                radius: fltr.units("Rds ")?,
            }),
            "MtnB" => FilterVariant::MotionBlur {
                angle: fltr.number("Angl").unwrap_or(0.0),
                distance: fltr.units("Dstn")?,
            },
            "RdlB" => FilterVariant::RadialBlur {
                amount: fltr.number("Amnt").unwrap_or(0.0),
                method: blr_m_decode(&fltr.enumeration("BlrM").unwrap_or_default()),
                quality: blr_q_decode(&fltr.enumeration("BlrQ").unwrap_or_default()),
            },
            "shapeBlur" => FilterVariant::ShapeBlur {
                radius: fltr.units("Rds ")?,
                custom_shape: {
                    let cs = fltr.descriptor("customShape");
                    NamedId {
                        name: cs.and_then(|c| c.text("Nm  ")).unwrap_or_default(),
                        id: cs.and_then(|c| c.text("Idnt")).unwrap_or_default(),
                    }
                },
            },
            "SmrB" => FilterVariant::SmartBlur {
                radius: fltr.number("Rds ").unwrap_or(0.0),
                threshold: fltr.number("Thsh").unwrap_or(0.0),
                quality: sm_bq_decode(&fltr.enumeration("SmBQ").unwrap_or_default()),
                mode: sm_bm_decode(&fltr.enumeration("SmBM").unwrap_or_default()),
            },
            "surfaceBlur" => FilterVariant::SurfaceBlur {
                radius: fltr.units("Rds ")?,
                threshold: fltr.number("Thsh").unwrap_or(0.0),
            },
            "Dspl" => FilterVariant::Displace {
                horizontal_scale: fltr.number("HrzS").unwrap_or(0.0),
                vertical_scale: fltr.number("VrtS").unwrap_or(0.0),
                displacement_map: dsp_m_decode(&fltr.enumeration("DspM").unwrap_or_default()),
                undefined_areas: und_a_decode(&fltr.enumeration("UndA").unwrap_or_default()),
                displacement_file: match fltr.get("DspF") {
                    Some(DescriptorValue::Path(p)) => DisplacementFile {
                        signature: p.sig.clone(),
                        path: p.path.clone(),
                    },
                    Some(DescriptorValue::Descriptor(d)) => DisplacementFile {
                        signature: d.text("sig").unwrap_or_default(),
                        path: d.text("path").unwrap_or_default(),
                    },
                    _ => DisplacementFile {
                        signature: String::new(),
                        path: String::new(),
                    },
                },
            },
            "Pnch" => FilterVariant::Pinch {
                amount: fltr.number("Amnt").unwrap_or(0.0),
            },
            "Plr " => FilterVariant::PolarCoordinates {
                conversion: cnvr_decode(&fltr.enumeration("Cnvr").unwrap_or_default()),
            },
            "Rple" => FilterVariant::Ripple {
                amount: fltr.number("Amnt").unwrap_or(0.0),
                size: rpl_s_decode(&fltr.enumeration("RplS").unwrap_or_default()),
            },
            "Shr " => FilterVariant::Shear {
                shear_points: fltr
                    .list("ShrP")
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|v| {
                        let DescriptorValue::Descriptor(p) = v else {
                            return None;
                        };
                        Some(PointF {
                            x: p.number("Hrzn").unwrap_or(0.0),
                            y: p.number("Vrtc").unwrap_or(0.0),
                        })
                    })
                    .collect(),
                shear_start: fltr.number("ShrS").unwrap_or(0.0),
                shear_end: fltr.number("ShrE").unwrap_or(0.0),
                undefined_areas: und_a_decode(&fltr.enumeration("UndA").unwrap_or_default()),
            },
            "Sphr" => FilterVariant::Spherize {
                amount: fltr.number("Amnt").unwrap_or(0.0),
                mode: sph_m_decode(&fltr.enumeration("SphM").unwrap_or_default()),
            },
            "Twrl" => FilterVariant::Twirl {
                angle: fltr.number("Angl").unwrap_or(0.0),
            },
            "Wave" => FilterVariant::Wave {
                number_of_generators: fltr.number("NmbG").unwrap_or(0.0),
                wave_type: wvtp_decode(&fltr.enumeration("Wvtp").unwrap_or_default()),
                wavelength: MinMax {
                    min: fltr.number("WLMn").unwrap_or(0.0),
                    max: fltr.number("WLMx").unwrap_or(0.0),
                },
                amplitude: MinMax {
                    min: fltr.number("AmMn").unwrap_or(0.0),
                    max: fltr.number("AmMx").unwrap_or(0.0),
                },
                scale: PointF {
                    x: fltr.number("SclH").unwrap_or(0.0),
                    y: fltr.number("SclV").unwrap_or(0.0),
                },
                random_seed: fltr.number("RndS").unwrap_or(0.0),
                undefined_areas: und_a_decode(&fltr.enumeration("UndA").unwrap_or_default()),
            },
            "ZgZg" => FilterVariant::ZigZag {
                amount: fltr.number("Amnt").unwrap_or(0.0),
                ridges: fltr.number("NmbR").unwrap_or(0.0),
                style: zz_ty_decode(&fltr.enumeration("ZZTy").unwrap_or_default()),
            },
            "AdNs" => FilterVariant::AddNoise {
                amount: fltr.percent("Nose").unwrap_or(1.0),
                distribution: dstr_decode(&fltr.enumeration("Dstr").unwrap_or_default()),
                monochromatic: fltr.bool("Mnch").unwrap_or(false),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "DstS" => FilterVariant::DustAndScratches {
                radius: fltr.number("Rds ").unwrap_or(0.0),
                threshold: fltr.number("Thsh").unwrap_or(0.0),
            },
            "Mdn " => FilterVariant::Median(RadiusFilter {
                radius: fltr.units("Rds ")?,
            }),
            "denoise" => FilterVariant::ReduceNoise {
                preset: fltr.text("preset").unwrap_or_default(),
                remove_jpeg_artifact: fltr.bool("removeJPEGArtifact").unwrap_or(false),
                reduce_color_noise: fltr.percent("ClNs").unwrap_or(1.0),
                sharpen_details: fltr.percent("Shrp").unwrap_or(1.0),
                channel_denoise: fltr
                    .list("channelDenoise")
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|v| {
                        let DescriptorValue::Descriptor(c) = v else {
                            return None;
                        };
                        // Chnl is `obj ` (Reference of Enmr), same as curves.
                        let channels = parse_chnl_channels(c)
                            .into_iter()
                            .map(|ch| match ch {
                                CurvesFilterChannel::Red => DenoiseChannel::Red,
                                CurvesFilterChannel::Green => DenoiseChannel::Green,
                                CurvesFilterChannel::Blue => DenoiseChannel::Blue,
                                CurvesFilterChannel::Composite => DenoiseChannel::Composite,
                            })
                            .collect();
                        Some(ChannelDenoise {
                            channels,
                            amount: c.number("Amnt").unwrap_or(0.0),
                            preserve_details: c.number("EdgF"),
                        })
                    })
                    .collect(),
            },
            "ClrH" => FilterVariant::ColorHalftone {
                radius: fltr.number("Rds ").unwrap_or(0.0),
                angle1: fltr.number("Ang1").unwrap_or(0.0),
                angle2: fltr.number("Ang2").unwrap_or(0.0),
                angle3: fltr.number("Ang3").unwrap_or(0.0),
                angle4: fltr.number("Ang4").unwrap_or(0.0),
            },
            "Crst" => FilterVariant::Crystallize {
                cell_size: fltr.number("ClSz").unwrap_or(0.0),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "Mztn" => FilterVariant::Mezzotint {
                mezzotint_type: mzt_t_decode(&fltr.enumeration("MztT").unwrap_or_default()),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "Msc " => FilterVariant::Mosaic {
                cell_size: fltr.units("ClSz")?,
            },
            "Pntl" => FilterVariant::Pointillize {
                cell_size: fltr.number("ClSz").unwrap_or(0.0),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "Clds" => FilterVariant::Clouds {
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "DfrC" => FilterVariant::DifferenceClouds {
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "Fbrs" => FilterVariant::Fibers {
                variance: fltr.number("Vrnc").unwrap_or(0.0),
                strength: fltr.number("Strg").unwrap_or(0.0),
                random_seed: fltr.number("RndS").unwrap_or(0.0),
            },
            "LnsF" => FilterVariant::LensFlare {
                brightness: fltr.number("Brgh").unwrap_or(0.0),
                position: {
                    let p = fltr.descriptor("FlrC");
                    PointF {
                        x: p.and_then(|d| d.number("Hrzn")).unwrap_or(0.0),
                        y: p.and_then(|d| d.number("Vrtc")).unwrap_or(0.0),
                    }
                },
                lens_type: lns_decode(&fltr.enumeration("Lns ").unwrap_or_default()),
            },
            "smartSharpen" => FilterVariant::SmartSharpen {
                amount: fltr.percent("Amnt").unwrap_or(1.0),
                radius: fltr.units("Rds ")?,
                threshold: fltr.number("Thsh").unwrap_or(0.0),
                angle: fltr.number("Angl").unwrap_or(0.0),
                more_accurate: fltr.bool("moreAccurate").unwrap_or(false),
                blur: blur_type_decode(&fltr.enumeration("blur").unwrap_or_default()),
                preset: fltr.text("preset").unwrap_or_default(),
                shadow: {
                    let s = fltr.descriptor("sdwM");
                    SmartSharpenTone {
                        fade_amount: s.map(|d| d.percent("Amnt").unwrap_or(1.0)).unwrap_or(0.0),
                        tonal_width: s.map(|d| d.percent("Wdth").unwrap_or(1.0)).unwrap_or(0.0),
                        radius: s.and_then(|d| d.number("Rds ")).unwrap_or(0.0),
                    }
                },
                highlight: {
                    let s = fltr.descriptor("hglM");
                    SmartSharpenTone {
                        fade_amount: s.map(|d| d.percent("Amnt").unwrap_or(1.0)).unwrap_or(0.0),
                        tonal_width: s.map(|d| d.percent("Wdth").unwrap_or(1.0)).unwrap_or(0.0),
                        radius: s.and_then(|d| d.number("Rds ")).unwrap_or(0.0),
                    }
                },
            },
            "UnsM" => FilterVariant::UnsharpMask {
                amount: fltr.percent("Amnt").unwrap_or(1.0),
                radius: fltr.units("Rds ")?,
                threshold: fltr.number("Thsh").unwrap_or(0.0),
            },
            "Dfs " => FilterVariant::Diffuse {
                mode: dfs_m_decode(&fltr.enumeration("Md  ").unwrap_or_default()),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "Embs" => FilterVariant::Emboss {
                angle: fltr.number("Angl").unwrap_or(0.0),
                height: fltr.number("Hght").unwrap_or(0.0),
                amount: fltr.number("Amnt").unwrap_or(0.0),
            },
            "Extr" => FilterVariant::Extrude {
                extrude_type: ext_t_decode(&fltr.enumeration("ExtT").unwrap_or_default()),
                size: fltr.number("ExtS").unwrap_or(0.0),
                depth: fltr.number("ExtD").unwrap_or(0.0),
                depth_mode: ext_r_decode(&fltr.enumeration("ExtR").unwrap_or_default()),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
                solid_front_faces: fltr.bool("ExtF").unwrap_or(false),
                mask_incomplete_blocks: fltr.bool("ExtM").unwrap_or(false),
            },
            "Tls " => FilterVariant::Tiles {
                number_of_tiles: fltr.number("TlNm").unwrap_or(0.0),
                maximum_offset: fltr.number("TlOf").unwrap_or(0.0),
                fill_empty_area_with: fl_cl_decode(&fltr.enumeration("FlCl").unwrap_or_default()),
                random_seed: fltr.number("FlRs").unwrap_or(0.0),
            },
            "TrcC" => FilterVariant::TraceContour {
                level: fltr.number("Lvl ").unwrap_or(0.0),
                edge: cnt_e_decode(&fltr.enumeration("Edg ").unwrap_or_default()),
            },
            "Wnd " => FilterVariant::Wind {
                method: wnd_m_decode(&fltr.enumeration("WndM").unwrap_or_default()),
                direction: drct_decode(&fltr.enumeration("Drct").unwrap_or_default()),
            },
            "Dntr" => FilterVariant::DeInterlace {
                eliminate: int_e_decode(&fltr.enumeration("IntE").unwrap_or_default()),
                new_fields_by: int_c_decode(&fltr.enumeration("IntC").unwrap_or_default()),
            },
            "Cstm" => FilterVariant::Custom {
                scale: fltr.number("Scl ").unwrap_or(0.0),
                offset: fltr.number("Ofst").unwrap_or(0.0),
                matrix: fltr
                    .list("Mtrx")
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|v| match v {
                        DescriptorValue::Double(d) => Some(*d),
                        DescriptorValue::Integer(i) => Some(*i as f64),
                        _ => None,
                    })
                    .collect(),
            },
            "HghP" => FilterVariant::HighPass(RadiusFilter {
                radius: fltr.units("Rds ")?,
            }),
            "Mxm " => FilterVariant::Maximum(RadiusFilter {
                radius: fltr.units("Rds ")?,
            }),
            "Mnm " => FilterVariant::Minimum(RadiusFilter {
                radius: fltr.units("Rds ")?,
            }),
            "Ofst" => FilterVariant::Offset {
                horizontal: fltr.number("Hrzn").unwrap_or(0.0),
                vertical: fltr.number("Vrtc").unwrap_or(0.0),
                undefined_areas: fl_md_decode(&fltr.enumeration("Fl  ").unwrap_or_default()),
            },
            "HsbP" => FilterVariant::HsbHsl {
                input_mode: clr_s_decode(&fltr.enumeration("Inpt").unwrap_or_default()),
                row_order: clr_s_decode(&fltr.enumeration("Otpt").unwrap_or_default()),
            },
            "oilPaint" => FilterVariant::OilPaint {
                lighting_on: fltr.bool("lightingOn").unwrap_or(false),
                stylization: fltr.number("stylization").unwrap_or(0.0),
                cleanliness: fltr.number("cleanliness").unwrap_or(0.0),
                brush_scale: fltr.number("brushScale").unwrap_or(0.0),
                micro_brush: fltr.number("microBrush").unwrap_or(0.0),
                light_direction: fltr.number("LghD").unwrap_or(0.0),
                specularity: fltr.number("specularity").unwrap_or(0.0),
            },
            "LqFy" => FilterVariant::Liquify {
                liquify_mesh: fltr.raw("LqMe").map(|b| b.to_vec()).unwrap_or_default(),
            },
            "BrgC" => FilterVariant::BrightnessContrast {
                brightness: fltr.number("Brgh").unwrap_or(0.0),
                contrast: fltr.number("Cntr").unwrap_or(0.0),
                use_legacy: fltr.bool("useLegacy").unwrap_or(false),
            },
            "rigidTransform" => parse_puppet(fltr)?,
            "PbPl" => parse_oil_plugin(fltr),
            "perspectiveWarpTransform" => parse_perspective_warp(fltr)?,
            "Crvs" => parse_curves(fltr)?,
            other => {
                if throw_missing {
                    return Err(ReadError::StrictViolation(format!(
                        "Unknown filter classId: {other}"
                    )));
                }
                return Ok(None);
            }
        };
        return Ok(Some(base(variant)));
    }

    let filter_id = f.number("filterID").unwrap_or(0.0) as i64;
    let variant = match filter_id {
        1098281575 => FilterVariant::Average,
        1114403360 => FilterVariant::Blur,
        1114403405 => FilterVariant::BlurMore,
        1148416099 => FilterVariant::Despeckle,
        1180922912 => FilterVariant::Facet,
        1181902701 => FilterVariant::Fragment,
        1399353968 => FilterVariant::Sharpen,
        1399353925 => FilterVariant::SharpenEdges,
        1399353933 => FilterVariant::SharpenMore,
        1181639749 => FilterVariant::FindEdges,
        1399616122 => FilterVariant::Solarize,
        1314149187 => FilterVariant::NtscColors,
        1231976050 => FilterVariant::Invert,
        other => {
            if throw_missing {
                return Err(ReadError::StrictViolation(format!(
                    "Unknown filterID: {other}"
                )));
            }
            return Ok(None);
        }
    };
    Ok(Some(base(variant)))
}

fn parse_oil_plugin(fltr: &Descriptor) -> FilterVariant {
    let mut parameters = Vec::new();
    for i in 0..FROM_A_TO_Z.len() {
        let ia = FROM_A_TO_Z[i] as char;
        if fltr.text(&format!("PN{ia}a")).is_none() {
            break;
        }
        for j in 0..FROM_A_TO_Z.len() {
            let ja = FROM_A_TO_Z[j] as char;
            let key = format!("PN{ia}{ja}");
            let Some(name) = fltr.text(&key) else {
                break;
            };
            parameters.push(NamedValue {
                name,
                value: fltr.number(&format!("PF{ia}{ja}")).unwrap_or(0.0),
            });
        }
    }
    FilterVariant::OilPaintPlugin {
        name: fltr.text("KnNm").unwrap_or_default(),
        gpu: fltr.bool("GpuY").unwrap_or(false),
        lighting: fltr.bool("LIWy").unwrap_or(false),
        parameters,
    }
}

fn parse_perspective_warp(fltr: &Descriptor) -> ReadResult<FilterVariant> {
    let vertices = fltr
        .list("vertices")
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| {
            let DescriptorValue::Descriptor(d) = v else {
                return None;
            };
            hrzn_vrtc_to_point(d).ok()
        })
        .collect();
    let warped_vertices = fltr
        .list("warpedVertices")
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| {
            let DescriptorValue::Descriptor(d) = v else {
                return None;
            };
            hrzn_vrtc_to_point(d).ok()
        })
        .collect();
    let quads = fltr
        .list("quads")
        .unwrap_or(&[])
        .iter()
        .filter_map(|v| {
            let DescriptorValue::Descriptor(d) = v else {
                return None;
            };
            let idx = d.list("indices").unwrap_or(&[]);
            Some(
                idx.iter()
                    .filter_map(|x| match x {
                        DescriptorValue::Double(n) => Some(*n),
                        DescriptorValue::Integer(n) => Some(*n as f64),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .collect();
    Ok(FilterVariant::PerspectiveWarp {
        quads,
        vertices,
        warped_vertices,
    })
}

fn parse_chnl_channels(a: &Descriptor) -> Vec<CurvesFilterChannel> {
    match a.get("Chnl") {
        Some(DescriptorValue::List(items)) => items
            .iter()
            .filter_map(|ch| match ch {
                DescriptorValue::Enum(s) | DescriptorValue::Text(s) => Some(curves_chnl_decode(s)),
                DescriptorValue::Reference(refs) => refs.iter().find_map(|r| match r {
                    crate::descriptor::ReferenceItem::Enumerated(s) => Some(curves_chnl_decode(s)),
                    _ => None,
                }),
                _ => None,
            })
            .collect(),
        Some(DescriptorValue::Reference(refs)) => refs
            .iter()
            .filter_map(|r| match r {
                crate::descriptor::ReferenceItem::Enumerated(s) => Some(curves_chnl_decode(s)),
                _ => None,
            })
            .collect(),
        Some(DescriptorValue::Enum(s)) | Some(DescriptorValue::Text(s)) => {
            vec![curves_chnl_decode(s)]
        }
        _ => Vec::new(),
    }
}

fn parse_curves(fltr: &Descriptor) -> ReadResult<FilterVariant> {
    let preset_kind = preset_kind_decode(&fltr.enumeration("presetKind").unwrap_or_default());
    let adjustments = if let Some(list) = fltr.list("Adjs") {
        let mut out = Vec::new();
        for item in list {
            let DescriptorValue::Descriptor(a) = item else {
                continue;
            };
            let channels = parse_chnl_channels(a);
            if let Some(curve_list) = a.list("Crv ") {
                let curve = curve_list
                    .iter()
                    .filter_map(|c| {
                        let DescriptorValue::Descriptor(p) = c else {
                            return None;
                        };
                        Some(CurvesFilterPoint {
                            x: p.number("Hrzn").unwrap_or(0.0),
                            y: p.number("Vrtc").unwrap_or(0.0),
                            curved: p.bool("Cnty"),
                        })
                    })
                    .collect();
                out.push(CurvesFilterAdjustment::Curve { channels, curve });
            } else if let Some(vals) = a.list("Mpng") {
                let values = vals
                    .iter()
                    .filter_map(|v| match v {
                        DescriptorValue::Double(d) => Some(*d),
                        DescriptorValue::Integer(i) => Some(*i as f64),
                        _ => None,
                    })
                    .collect();
                out.push(CurvesFilterAdjustment::Values { channels, values });
            } else {
                return Err(ReadError::StrictViolation(
                    "Unknown curve adjustment".into(),
                ));
            }
        }
        Some(out)
    } else {
        None
    };
    Ok(FilterVariant::Curves {
        preset_kind,
        adjustments,
    })
}

fn parse_puppet(fltr: &Descriptor) -> ReadResult<FilterVariant> {
    let bounds = vec![
        PointF {
            x: fltr.number("PuX0").unwrap_or(0.0),
            y: fltr.number("PuY0").unwrap_or(0.0),
        },
        PointF {
            x: fltr.number("PuX1").unwrap_or(0.0),
            y: fltr.number("PuY1").unwrap_or(0.0),
        },
        PointF {
            x: fltr.number("PuX2").unwrap_or(0.0),
            y: fltr.number("PuY2").unwrap_or(0.0),
        },
        PointF {
            x: fltr.number("PuX3").unwrap_or(0.0),
            y: fltr.number("PuY3").unwrap_or(0.0),
        },
    ];
    let mut shapes = Vec::new();
    for item in fltr.list("puppetShapeList").unwrap_or(&[]) {
        let DescriptorValue::Descriptor(p) = item else {
            continue;
        };
        let mesh_boundary_path = p
            .descriptor("meshBoundaryPath")
            .and_then(|mb| mb.list("pathComponents"))
            .unwrap_or(&[])
            .iter()
            .filter_map(|c| {
                let DescriptorValue::Descriptor(comp) = c else {
                    return None;
                };
                let shape_operation = comp
                    .enumeration("shapeOperation")
                    .or_else(|| comp.text("shapeOperation"))
                    .unwrap_or_default();
                let shape_operation = shape_operation
                    .split('.')
                    .nth(1)
                    .unwrap_or(&shape_operation)
                    .to_string();
                let paths = comp
                    .list("SbpL")
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|t| {
                        let DescriptorValue::Descriptor(tp) = t else {
                            return None;
                        };
                        let points = tp
                            .list("Pts ")
                            .unwrap_or(&[])
                            .iter()
                            .filter_map(|pt| {
                                let DescriptorValue::Descriptor(pd) = pt else {
                                    return None;
                                };
                                let anchor = pd
                                    .descriptor("Anch")
                                    .map(hrzn_vrtc_to_point)
                                    .transpose()
                                    .ok()
                                    .flatten()?;
                                let forward = pd
                                    .descriptor("Fwd ")
                                    .map(hrzn_vrtc_to_point)
                                    .transpose()
                                    .ok()
                                    .flatten()?;
                                let backward = pd
                                    .descriptor("Bwd ")
                                    .map(hrzn_vrtc_to_point)
                                    .transpose()
                                    .ok()
                                    .flatten()?;
                                Some(PuppetMeshPoint {
                                    anchor,
                                    forward,
                                    backward,
                                    smooth: pd.bool("Smoo").unwrap_or(false),
                                })
                            })
                            .collect();
                        Some(PuppetMeshPath {
                            closed: tp.bool("Clsp").unwrap_or(false),
                            points,
                        })
                    })
                    .collect();
                Some(PuppetPathComponent {
                    shape_operation,
                    paths,
                })
            })
            .collect();
        let pin_overlay = p
            .list("PnOv")
            .unwrap_or(&[])
            .iter()
            .filter_map(|v| match v {
                DescriptorValue::Boolean(b) => Some(*b),
                _ => None,
            })
            .collect();
        shapes.push(PuppetShape {
            rigid_type: p.bool("rigidType").unwrap_or(false),
            original_vertex_array: p
                .raw("originalVertexArray")
                .map(uint8_to_points)
                .unwrap_or_default(),
            deformed_vertex_array: p
                .raw("deformedVertexArray")
                .map(uint8_to_points)
                .unwrap_or_default(),
            index_array: p
                .raw("indexArray")
                .map(|b| uint8_to_u32(b).into_iter().map(|x| x as f64).collect())
                .unwrap_or_default(),
            pin_offsets: p
                .list("pinOffsets")
                .map(|l| {
                    let nums: Vec<f64> = l
                        .iter()
                        .filter_map(|v| match v {
                            DescriptorValue::Double(d) => Some(*d),
                            DescriptorValue::Integer(i) => Some(*i as f64),
                            _ => None,
                        })
                        .collect();
                    array_to_points(&nums)
                })
                .unwrap_or_default(),
            pos_final_pins: p
                .list("posFinalPins")
                .map(|l| {
                    let nums: Vec<f64> = l
                        .iter()
                        .filter_map(|v| match v {
                            DescriptorValue::Double(d) => Some(*d),
                            DescriptorValue::Integer(i) => Some(*i as f64),
                            _ => None,
                        })
                        .collect();
                    array_to_points(&nums)
                })
                .unwrap_or_default(),
            pin_vertex_indices: p
                .list("pinVertexIndices")
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| match v {
                    DescriptorValue::Double(d) => Some(*d),
                    DescriptorValue::Integer(i) => Some(*i as f64),
                    _ => None,
                })
                .collect(),
            selected_pin: p
                .list("selectedPin")
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| match v {
                    DescriptorValue::Double(d) => Some(*d),
                    DescriptorValue::Integer(i) => Some(*i as f64),
                    _ => None,
                })
                .collect(),
            pin_position: p
                .list("PinP")
                .map(|l| {
                    let nums: Vec<f64> = l
                        .iter()
                        .filter_map(|v| match v {
                            DescriptorValue::Double(d) => Some(*d),
                            DescriptorValue::Integer(i) => Some(*i as f64),
                            _ => None,
                        })
                        .collect();
                    array_to_points(&nums)
                })
                .unwrap_or_default(),
            pin_rotation: p
                .list("PnRt")
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| match v {
                    DescriptorValue::Double(d) => Some(*d),
                    DescriptorValue::Integer(i) => Some(*i as f64),
                    _ => None,
                })
                .collect(),
            pin_overlay,
            pin_depth: p
                .list("PnDp")
                .unwrap_or(&[])
                .iter()
                .filter_map(|v| match v {
                    DescriptorValue::Double(d) => Some(*d),
                    DescriptorValue::Integer(i) => Some(*i as f64),
                    _ => None,
                })
                .collect(),
            mesh_quality: p.number("meshQuality").unwrap_or(0.0),
            mesh_expansion: p.number("meshExpansion").unwrap_or(0.0),
            mesh_rigidity: p.number("meshRigidity").unwrap_or(0.0),
            image_resolution: p.number("imageResolution").unwrap_or(0.0),
            mesh_boundary_path,
        });
    }
    Ok(FilterVariant::Puppet {
        rigid_type: fltr.bool("rigidType").unwrap_or(false),
        bounds,
        puppet_shape_list: shapes,
    })
}

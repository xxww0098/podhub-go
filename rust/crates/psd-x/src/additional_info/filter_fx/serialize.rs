//! serializeFilterFXItem port.

use super::enums::*;
use super::util::*;
use crate::descriptor::{
    Descriptor, DescriptorValue, PathValue, ReferenceItem, serialize_color, units_value,
};
use crate::psd::*;

pub fn serialize_filter_fx_item(f: &Filter) -> Descriptor {
    let mut base = Descriptor::new("", "filterFX");
    base.set("Nm  ", DescriptorValue::Text(f.name.clone()));
    let mut blend = Descriptor::new("", "blendOptions");
    blend.set("Opct", units_percent_f(f.opacity));
    blend.set("Md  ", DescriptorValue::Enum(bln_m_encode(f.blend_mode)));
    base.set("blendOptions", DescriptorValue::Descriptor(blend));
    base.set("enab", DescriptorValue::Boolean(f.enabled));
    base.set("hasoptions", DescriptorValue::Boolean(f.has_options));
    base.set(
        "FrgC",
        DescriptorValue::Descriptor(serialize_color(Some(&f.foreground_color))),
    );
    base.set(
        "BckC",
        DescriptorValue::Descriptor(serialize_color(Some(&f.background_color))),
    );

    match &f.variant {
        FilterVariant::Average => {
            base.set("filterID", DescriptorValue::Integer(1098281575));
        }
        FilterVariant::Blur => {
            base.set("filterID", DescriptorValue::Integer(1114403360));
        }
        FilterVariant::BlurMore => {
            base.set("filterID", DescriptorValue::Integer(1114403405));
        }
        FilterVariant::Despeckle => {
            base.set("filterID", DescriptorValue::Integer(1148416099));
        }
        FilterVariant::Facet => {
            base.set("filterID", DescriptorValue::Integer(1180922912));
        }
        FilterVariant::Fragment => {
            base.set("filterID", DescriptorValue::Integer(1181902701));
        }
        FilterVariant::Sharpen => {
            base.set("filterID", DescriptorValue::Integer(1399353968));
        }
        FilterVariant::SharpenEdges => {
            base.set("filterID", DescriptorValue::Integer(1399353925));
        }
        FilterVariant::SharpenMore => {
            base.set("filterID", DescriptorValue::Integer(1399353933));
        }
        FilterVariant::FindEdges => {
            base.set("filterID", DescriptorValue::Integer(1181639749));
        }
        FilterVariant::Solarize => {
            base.set("filterID", DescriptorValue::Integer(1399616122));
        }
        FilterVariant::NtscColors => {
            base.set("filterID", DescriptorValue::Integer(1314149187));
        }
        FilterVariant::Invert => {
            base.set("filterID", DescriptorValue::Integer(1231976050));
        }
        FilterVariant::BoxBlur(p) => {
            let mut fl = Descriptor::new("Box Blur", "boxblur");
            fl.set("Rds ", uv_radius(&p.radius));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(697));
        }
        FilterVariant::GaussianBlur(p) => {
            let mut fl = Descriptor::new("Gaussian Blur", "GsnB");
            fl.set("Rds ", uv_radius(&p.radius));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1198747202));
        }
        FilterVariant::MotionBlur { angle, distance } => {
            let mut fl = Descriptor::new("Motion Blur", "MtnB");
            fl.set("Angl", DescriptorValue::Double(*angle));
            fl.set("Dstn", units_value(Some(distance)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1299476034));
        }
        FilterVariant::RadialBlur {
            amount,
            method,
            quality,
        } => {
            let mut fl = Descriptor::new("Radial Blur", "RdlB");
            fl.set("Amnt", DescriptorValue::Double(*amount));
            fl.set("BlrM", DescriptorValue::Enum(blr_m_encode(*method)));
            fl.set("BlrQ", DescriptorValue::Enum(blr_q_encode(*quality)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1382313026));
        }
        FilterVariant::ShapeBlur {
            radius,
            custom_shape,
        } => {
            let mut fl = Descriptor::new("Shape Blur", "shapeBlur");
            fl.set("Rds ", uv_radius(radius));
            let mut cs = Descriptor::new("", "customShape");
            cs.set("Nm  ", DescriptorValue::Text(custom_shape.name.clone()));
            cs.set("Idnt", DescriptorValue::Text(custom_shape.id.clone()));
            fl.set("customShape", DescriptorValue::Descriptor(cs));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(702));
        }
        FilterVariant::SmartBlur {
            radius,
            threshold,
            quality,
            mode,
        } => {
            let mut fl = Descriptor::new("Smart Blur", "SmrB");
            fl.set("Rds ", DescriptorValue::Double(*radius));
            fl.set("Thsh", DescriptorValue::Double(*threshold));
            fl.set("SmBQ", DescriptorValue::Enum(sm_bq_encode(*quality)));
            fl.set("SmBM", DescriptorValue::Enum(sm_bm_encode(*mode)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1399681602));
        }
        FilterVariant::SurfaceBlur { radius, threshold } => {
            let mut fl = Descriptor::new("Surface Blur", "surfaceBlur");
            fl.set("Rds ", uv_radius(radius));
            fl.set("Thsh", DescriptorValue::Double(*threshold));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(701));
        }
        FilterVariant::Displace {
            horizontal_scale,
            vertical_scale,
            displacement_map,
            undefined_areas,
            displacement_file,
        } => {
            let mut fl = Descriptor::new("Displace", "Dspl");
            fl.set("HrzS", DescriptorValue::Double(*horizontal_scale));
            fl.set("VrtS", DescriptorValue::Double(*vertical_scale));
            fl.set(
                "DspM",
                DescriptorValue::Enum(dsp_m_encode(*displacement_map)),
            );
            fl.set(
                "UndA",
                DescriptorValue::Enum(und_a_encode(*undefined_areas)),
            );
            fl.set(
                "DspF",
                DescriptorValue::Path(PathValue {
                    sig: displacement_file.signature.clone(),
                    path: displacement_file.path.clone(),
                }),
            );
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1148416108));
        }
        FilterVariant::Pinch { amount } => {
            let mut fl = Descriptor::new("Pinch", "Pnch");
            fl.set("Amnt", DescriptorValue::Double(*amount));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1349411688));
        }
        FilterVariant::PolarCoordinates { conversion } => {
            let mut fl = Descriptor::new("Polar Coordinates", "Plr ");
            fl.set("Cnvr", DescriptorValue::Enum(cnvr_encode(*conversion)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1349284384));
        }
        FilterVariant::Ripple { amount, size } => {
            let mut fl = Descriptor::new("Ripple", "Rple");
            fl.set("Amnt", DescriptorValue::Double(*amount));
            fl.set("RplS", DescriptorValue::Enum(rpl_s_encode(*size)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1383099493));
        }
        FilterVariant::Shear {
            shear_points,
            shear_start,
            shear_end,
            undefined_areas,
        } => {
            let mut fl = Descriptor::new("Shear", "Shr ");
            let pts: Vec<DescriptorValue> = shear_points
                .iter()
                .map(|p| {
                    let mut d = Descriptor::new("", "Pnt ");
                    d.set("Hrzn", DescriptorValue::Double(p.x));
                    d.set("Vrtc", DescriptorValue::Double(p.y));
                    DescriptorValue::Descriptor(d)
                })
                .collect();
            fl.set("ShrP", DescriptorValue::List(pts));
            fl.set(
                "UndA",
                DescriptorValue::Enum(und_a_encode(*undefined_areas)),
            );
            fl.set("ShrS", DescriptorValue::Double(*shear_start));
            fl.set("ShrE", DescriptorValue::Double(*shear_end));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1399353888));
        }
        FilterVariant::Spherize { amount, mode } => {
            let mut fl = Descriptor::new("Spherize", "Sphr");
            fl.set("Amnt", DescriptorValue::Double(*amount));
            fl.set("SphM", DescriptorValue::Enum(sph_m_encode(*mode)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1399875698));
        }
        FilterVariant::Twirl { angle } => {
            let mut fl = Descriptor::new("Twirl", "Twrl");
            fl.set("Angl", DescriptorValue::Double(*angle));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1417114220));
        }
        FilterVariant::Wave {
            number_of_generators,
            wave_type,
            wavelength,
            amplitude,
            scale,
            random_seed,
            undefined_areas,
        } => {
            let mut fl = Descriptor::new("Wave", "Wave");
            fl.set("Wvtp", DescriptorValue::Enum(wvtp_encode(*wave_type)));
            fl.set("NmbG", DescriptorValue::Double(*number_of_generators));
            fl.set("WLMn", DescriptorValue::Double(wavelength.min));
            fl.set("WLMx", DescriptorValue::Double(wavelength.max));
            fl.set("AmMn", DescriptorValue::Double(amplitude.min));
            fl.set("AmMx", DescriptorValue::Double(amplitude.max));
            fl.set("SclH", DescriptorValue::Double(scale.x));
            fl.set("SclV", DescriptorValue::Double(scale.y));
            fl.set(
                "UndA",
                DescriptorValue::Enum(und_a_encode(*undefined_areas)),
            );
            fl.set("RndS", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1466005093));
        }
        FilterVariant::ZigZag {
            amount,
            ridges,
            style,
        } => {
            let mut fl = Descriptor::new("ZigZag", "ZgZg");
            fl.set("Amnt", DescriptorValue::Double(*amount));
            fl.set("NmbR", DescriptorValue::Double(*ridges));
            fl.set("ZZTy", DescriptorValue::Enum(zz_ty_encode(*style)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1516722791));
        }
        FilterVariant::AddNoise {
            amount,
            distribution,
            monochromatic,
            random_seed,
        } => {
            let mut fl = Descriptor::new("Add Noise", "AdNs");
            fl.set("Dstr", DescriptorValue::Enum(dstr_encode(*distribution)));
            fl.set("Nose", units_percent_f(*amount));
            fl.set("Mnch", DescriptorValue::Boolean(*monochromatic));
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1097092723));
        }
        FilterVariant::DustAndScratches { radius, threshold } => {
            let mut fl = Descriptor::new("Dust & Scratches", "DstS");
            fl.set("Rds ", DescriptorValue::Double(*radius));
            fl.set("Thsh", DescriptorValue::Double(*threshold));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1148417107));
        }
        FilterVariant::Median(p) => {
            let mut fl = Descriptor::new("Median", "Mdn ");
            fl.set("Rds ", uv_radius(&p.radius));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1298427424));
        }
        FilterVariant::ReduceNoise {
            preset,
            remove_jpeg_artifact,
            reduce_color_noise,
            sharpen_details,
            channel_denoise,
        } => {
            let mut fl = Descriptor::new("Reduce Noise", "denoise");
            fl.set("ClNs", units_percent_f(*reduce_color_noise));
            fl.set("Shrp", units_percent_f(*sharpen_details));
            fl.set(
                "removeJPEGArtifact",
                DescriptorValue::Boolean(*remove_jpeg_artifact),
            );
            let chans: Vec<DescriptorValue> = channel_denoise
                .iter()
                .map(|c| {
                    let mut d = Descriptor::new("", "channelDenoiseParams");
                    d.set(
                        "Chnl",
                        DescriptorValue::Reference(
                            c.channels
                                .iter()
                                .map(|ch| ReferenceItem::Enumerated(chnl_encode(*ch)))
                                .collect(),
                        ),
                    );
                    d.set("Amnt", DescriptorValue::Double(c.amount));
                    if let Some(pd) = c.preserve_details {
                        d.set("EdgF", DescriptorValue::Double(pd));
                    }
                    DescriptorValue::Descriptor(d)
                })
                .collect();
            fl.set("channelDenoise", DescriptorValue::List(chans));
            fl.set("preset", DescriptorValue::Text(preset.clone()));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(633));
        }
        FilterVariant::ColorHalftone {
            radius,
            angle1,
            angle2,
            angle3,
            angle4,
        } => {
            let mut fl = Descriptor::new("Color Halftone", "ClrH");
            fl.set("Rds ", DescriptorValue::Double(*radius));
            fl.set("Ang1", DescriptorValue::Double(*angle1));
            fl.set("Ang2", DescriptorValue::Double(*angle2));
            fl.set("Ang3", DescriptorValue::Double(*angle3));
            fl.set("Ang4", DescriptorValue::Double(*angle4));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1131180616));
        }
        FilterVariant::Crystallize {
            cell_size,
            random_seed,
        } => {
            let mut fl = Descriptor::new("Crystallize", "Crst");
            fl.set("ClSz", DescriptorValue::Double(*cell_size));
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1131574132));
        }
        FilterVariant::Mezzotint {
            mezzotint_type,
            random_seed,
        } => {
            let mut fl = Descriptor::new("Mezzotint", "Mztn");
            fl.set("MztT", DescriptorValue::Enum(mzt_t_encode(*mezzotint_type)));
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1299870830));
        }
        FilterVariant::Mosaic { cell_size } => {
            let mut fl = Descriptor::new("Mosaic", "Msc ");
            fl.set("ClSz", units_value(Some(cell_size)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1299407648));
        }
        FilterVariant::Pointillize {
            cell_size,
            random_seed,
        } => {
            let mut fl = Descriptor::new("Pointillize", "Pntl");
            fl.set("ClSz", DescriptorValue::Double(*cell_size));
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1349416044));
        }
        FilterVariant::Clouds { random_seed } => {
            let mut fl = Descriptor::new("Clouds", "Clds");
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1131177075));
        }
        FilterVariant::DifferenceClouds { random_seed } => {
            let mut fl = Descriptor::new("Difference Clouds", "DfrC");
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1147564611));
        }
        FilterVariant::Fibers {
            variance,
            strength,
            random_seed,
        } => {
            let mut fl = Descriptor::new("Fibers", "Fbrs");
            fl.set("Vrnc", DescriptorValue::Double(*variance));
            fl.set("Strg", DescriptorValue::Double(*strength));
            fl.set("RndS", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1180856947));
        }
        FilterVariant::LensFlare {
            brightness,
            position,
            lens_type,
        } => {
            let mut fl = Descriptor::new("Lens Flare", "LnsF");
            fl.set("Brgh", DescriptorValue::Double(*brightness));
            let mut p = Descriptor::new("", "Pnt ");
            p.set("Hrzn", DescriptorValue::Double(position.x));
            p.set("Vrtc", DescriptorValue::Double(position.y));
            fl.set("FlrC", DescriptorValue::Descriptor(p));
            fl.set("Lns ", DescriptorValue::Enum(lns_encode(*lens_type)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1282306886));
        }
        FilterVariant::SmartSharpen {
            amount,
            radius,
            threshold,
            angle,
            more_accurate,
            blur,
            preset,
            shadow,
            highlight,
        } => {
            let mut fl = Descriptor::new("Smart Sharpen", "smartSharpen");
            fl.set("Amnt", units_percent_f(*amount));
            fl.set("Rds ", uv_radius(radius));
            fl.set("Thsh", DescriptorValue::Double(*threshold));
            fl.set("Angl", DescriptorValue::Double(*angle));
            fl.set("moreAccurate", DescriptorValue::Boolean(*more_accurate));
            fl.set("blur", DescriptorValue::Enum(blur_type_encode(*blur)));
            fl.set("preset", DescriptorValue::Text(preset.clone()));
            let mut sdw = Descriptor::new("Parameters", "adaptCorrectTones");
            sdw.set("Amnt", units_percent_f(shadow.fade_amount));
            sdw.set("Wdth", units_percent_f(shadow.tonal_width));
            sdw.set("Rds ", DescriptorValue::Double(shadow.radius));
            fl.set("sdwM", DescriptorValue::Descriptor(sdw));
            let mut hgl = Descriptor::new("Parameters", "adaptCorrectTones");
            hgl.set("Amnt", units_percent_f(highlight.fade_amount));
            hgl.set("Wdth", units_percent_f(highlight.tonal_width));
            hgl.set("Rds ", DescriptorValue::Double(highlight.radius));
            fl.set("hglM", DescriptorValue::Descriptor(hgl));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(698));
        }
        FilterVariant::UnsharpMask {
            amount,
            radius,
            threshold,
        } => {
            let mut fl = Descriptor::new("Unsharp Mask", "UnsM");
            fl.set("Amnt", units_percent_f(*amount));
            fl.set("Rds ", uv_radius(radius));
            fl.set("Thsh", DescriptorValue::Double(*threshold));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1433301837));
        }
        FilterVariant::Diffuse { mode, random_seed } => {
            let mut fl = Descriptor::new("Diffuse", "Dfs ");
            fl.set("Md  ", DescriptorValue::Enum(dfs_m_encode(*mode)));
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1147564832));
        }
        FilterVariant::Emboss {
            angle,
            height,
            amount,
        } => {
            let mut fl = Descriptor::new("Emboss", "Embs");
            fl.set("Angl", DescriptorValue::Double(*angle));
            fl.set("Hght", DescriptorValue::Double(*height));
            fl.set("Amnt", DescriptorValue::Double(*amount));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1164796531));
        }
        FilterVariant::Extrude {
            extrude_type,
            size,
            depth,
            depth_mode,
            random_seed,
            solid_front_faces,
            mask_incomplete_blocks,
        } => {
            let mut fl = Descriptor::new("Extrude", "Extr");
            fl.set("ExtS", DescriptorValue::Double(*size));
            fl.set("ExtD", DescriptorValue::Double(*depth));
            fl.set("ExtF", DescriptorValue::Boolean(*solid_front_faces));
            fl.set("ExtM", DescriptorValue::Boolean(*mask_incomplete_blocks));
            fl.set("ExtT", DescriptorValue::Enum(ext_t_encode(*extrude_type)));
            fl.set("ExtR", DescriptorValue::Enum(ext_r_encode(*depth_mode)));
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1165522034));
        }
        FilterVariant::Tiles {
            number_of_tiles,
            maximum_offset,
            fill_empty_area_with,
            random_seed,
        } => {
            let mut fl = Descriptor::new("Tiles", "Tls ");
            fl.set("TlNm", DescriptorValue::Double(*number_of_tiles));
            fl.set("TlOf", DescriptorValue::Double(*maximum_offset));
            fl.set(
                "FlCl",
                DescriptorValue::Enum(fl_cl_encode(*fill_empty_area_with)),
            );
            fl.set("FlRs", DescriptorValue::Double(*random_seed));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1416393504));
        }
        FilterVariant::TraceContour { level, edge } => {
            let mut fl = Descriptor::new("Trace Contour", "TrcC");
            fl.set("Lvl ", DescriptorValue::Double(*level));
            fl.set("Edg ", DescriptorValue::Enum(cnt_e_encode(*edge)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1416782659));
        }
        FilterVariant::Wind { method, direction } => {
            let mut fl = Descriptor::new("Wind", "Wnd ");
            fl.set("WndM", DescriptorValue::Enum(wnd_m_encode(*method)));
            fl.set("Drct", DescriptorValue::Enum(drct_encode(*direction)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1466852384));
        }
        FilterVariant::DeInterlace {
            eliminate,
            new_fields_by,
        } => {
            let mut fl = Descriptor::new("De-Interlace", "Dntr");
            fl.set("IntE", DescriptorValue::Enum(int_e_encode(*eliminate)));
            fl.set("IntC", DescriptorValue::Enum(int_c_encode(*new_fields_by)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1148089458));
        }
        FilterVariant::Custom {
            scale,
            offset,
            matrix,
        } => {
            let mut fl = Descriptor::new("Custom", "Cstm");
            fl.set("Scl ", DescriptorValue::Double(*scale));
            fl.set("Ofst", DescriptorValue::Double(*offset));
            fl.set(
                "Mtrx",
                DescriptorValue::List(matrix.iter().map(|v| DescriptorValue::Double(*v)).collect()),
            );
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1131639917));
        }
        FilterVariant::HighPass(p) => {
            let mut fl = Descriptor::new("High Pass", "HghP");
            fl.set("Rds ", uv_radius(&p.radius));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1214736464));
        }
        FilterVariant::Maximum(p) => {
            let mut fl = Descriptor::new("Maximum", "Mxm ");
            fl.set("Rds ", uv_radius(&p.radius));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1299737888));
        }
        FilterVariant::Minimum(p) => {
            let mut fl = Descriptor::new("Minimum", "Mnm ");
            fl.set("Rds ", uv_radius(&p.radius));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1299082528));
        }
        FilterVariant::Offset {
            horizontal,
            vertical,
            undefined_areas,
        } => {
            let mut fl = Descriptor::new("Offset", "Ofst");
            // getTypeByKey: Hrzn/Vrtc with parent._classID === 'Ofst' → long
            fl.set("Hrzn", DescriptorValue::Integer(*horizontal as i32));
            fl.set("Vrtc", DescriptorValue::Integer(*vertical as i32));
            fl.set(
                "Fl  ",
                DescriptorValue::Enum(fl_md_encode(*undefined_areas)),
            );
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1332114292));
        }
        FilterVariant::HsbHsl {
            input_mode,
            row_order,
        } => {
            let mut fl = Descriptor::new("", "HsbP");
            fl.set("Inpt", DescriptorValue::Enum(clr_s_encode(*input_mode)));
            fl.set("Otpt", DescriptorValue::Enum(clr_s_encode(*row_order)));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1215521360));
        }
        FilterVariant::OilPaint {
            lighting_on,
            stylization,
            cleanliness,
            brush_scale,
            micro_brush,
            light_direction,
            specularity,
        } => {
            let mut fl = Descriptor::new("Oil Paint", "oilPaint");
            fl.set("lightingOn", DescriptorValue::Boolean(*lighting_on));
            fl.set("stylization", DescriptorValue::Double(*stylization));
            fl.set("cleanliness", DescriptorValue::Double(*cleanliness));
            fl.set("brushScale", DescriptorValue::Double(*brush_scale));
            fl.set("microBrush", DescriptorValue::Double(*micro_brush));
            fl.set("LghD", DescriptorValue::Double(*light_direction));
            fl.set("specularity", DescriptorValue::Double(*specularity));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1122));
        }
        FilterVariant::Liquify { liquify_mesh } => {
            let mut fl = Descriptor::new("Liquify", "LqFy");
            fl.set("LqMe", DescriptorValue::RawData(liquify_mesh.clone()));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1282492025));
        }
        FilterVariant::BrightnessContrast {
            brightness,
            contrast,
            use_legacy,
        } => {
            let mut fl = Descriptor::new("Brightness/Contrast", "BrgC");
            fl.set("Brgh", DescriptorValue::Double(*brightness));
            fl.set("Cntr", DescriptorValue::Double(*contrast));
            fl.set("useLegacy", DescriptorValue::Boolean(*use_legacy));
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1114793795));
        }
        FilterVariant::Curves {
            preset_kind,
            adjustments,
        } => {
            let mut fl = Descriptor::new("Curves", "Crvs");
            fl.set(
                "presetKind",
                DescriptorValue::Enum(preset_kind_encode(*preset_kind)),
            );
            if let Some(adjs) = adjustments {
                let list: Vec<DescriptorValue> = adjs
                    .iter()
                    .map(|a| {
                        let mut d = Descriptor::new("", "CrvA");
                        match a {
                            CurvesFilterAdjustment::Curve { channels, curve } => {
                                // fieldToType Chnl → obj (Reference of Enmr), not VlLs.
                                d.set(
                                    "Chnl",
                                    DescriptorValue::Reference(
                                        channels
                                            .iter()
                                            .map(|c| {
                                                ReferenceItem::Enumerated(curves_chnl_encode(*c))
                                            })
                                            .collect(),
                                    ),
                                );
                                d.set(
                                    "Crv ",
                                    DescriptorValue::List(
                                        curve
                                            .iter()
                                            .map(|c| {
                                                let mut p = Descriptor::new("", "Pnt ");
                                                p.set("Hrzn", DescriptorValue::Double(c.x));
                                                p.set("Vrtc", DescriptorValue::Double(c.y));
                                                if c.curved == Some(true) {
                                                    p.set("Cnty", DescriptorValue::Boolean(true));
                                                }
                                                DescriptorValue::Descriptor(p)
                                            })
                                            .collect(),
                                    ),
                                );
                            }
                            CurvesFilterAdjustment::Values { channels, values } => {
                                d.set(
                                    "Chnl",
                                    DescriptorValue::Reference(
                                        channels
                                            .iter()
                                            .map(|c| {
                                                ReferenceItem::Enumerated(curves_chnl_encode(*c))
                                            })
                                            .collect(),
                                    ),
                                );
                                d.set(
                                    "Mpng",
                                    DescriptorValue::List(
                                        values
                                            .iter()
                                            .map(|v| DescriptorValue::Double(*v))
                                            .collect(),
                                    ),
                                );
                            }
                        }
                        DescriptorValue::Descriptor(d)
                    })
                    .collect();
                fl.set("Adjs", DescriptorValue::List(list));
            }
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1131574899));
        }
        FilterVariant::PerspectiveWarp {
            quads,
            vertices,
            warped_vertices,
        } => {
            let mut fl = Descriptor::new("Perspective Warp", "perspectiveWarpTransform");
            fl.set(
                "vertices",
                DescriptorValue::List(
                    vertices
                        .iter()
                        .map(|p| DescriptorValue::Descriptor(point_to_hrzn_vrtc(p)))
                        .collect(),
                ),
            );
            fl.set(
                "warpedVertices",
                DescriptorValue::List(
                    warped_vertices
                        .iter()
                        .map(|p| DescriptorValue::Descriptor(point_to_hrzn_vrtc(p)))
                        .collect(),
                ),
            );
            fl.set(
                "quads",
                DescriptorValue::List(
                    quads
                        .iter()
                        .map(|q| {
                            let mut d = Descriptor::new("", "null");
                            d.set(
                                "indices",
                                DescriptorValue::List(
                                    q.iter().map(|i| DescriptorValue::Double(*i)).collect(),
                                ),
                            );
                            DescriptorValue::Descriptor(d)
                        })
                        .collect(),
                ),
            );
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(442));
        }
        FilterVariant::OilPaintPlugin {
            name,
            gpu,
            lighting,
            parameters,
        } => {
            let mut fl = Descriptor::new("Oil Paint Plugin", "PbPl");
            fl.set("KnNm", DescriptorValue::Text(name.clone()));
            fl.set("GpuY", DescriptorValue::Boolean(*gpu));
            fl.set("LIWy", DescriptorValue::Boolean(*lighting));
            fl.set("FPth", DescriptorValue::Text("1".into()));
            for (i, param) in parameters.iter().enumerate() {
                let suffix = format!(
                    "{}{}",
                    FROM_A_TO_Z[i / FROM_A_TO_Z.len()] as char,
                    FROM_A_TO_Z[i % FROM_A_TO_Z.len()] as char
                );
                fl.set(
                    format!("PN{suffix}"),
                    DescriptorValue::Text(param.name.clone()),
                );
                fl.set(format!("PT{suffix}"), DescriptorValue::Integer(0));
                fl.set(format!("PF{suffix}"), DescriptorValue::Double(param.value));
            }
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(1348620396));
        }
        FilterVariant::Puppet {
            rigid_type,
            bounds,
            puppet_shape_list,
        } => {
            let mut fl = Descriptor::new("Rigid Transform", "rigidTransform");
            fl.set(
                "null",
                DescriptorValue::List(vec![DescriptorValue::Enum("Ordn.Trgt".into())]),
            );
            fl.set("rigidType", DescriptorValue::Boolean(*rigid_type));
            let shapes: Vec<DescriptorValue> = puppet_shape_list
                .iter()
                .map(|p| serialize_puppet_shape(p))
                .collect();
            fl.set("puppetShapeList", DescriptorValue::List(shapes));
            for (i, b) in bounds.iter().take(4).enumerate() {
                fl.set(format!("PuX{i}"), DescriptorValue::Double(b.x));
                fl.set(format!("PuY{i}"), DescriptorValue::Double(b.y));
            }
            base.set("Fltr", DescriptorValue::Descriptor(fl));
            base.set("filterID", DescriptorValue::Integer(991));
        }
    }
    // Mirror getTypeByKey / fieldToType: many filter numeric fields are `long`.
    coerce_filter_descriptor_types(&mut base);
    base
}

fn serialize_puppet_shape(p: &PuppetShape) -> DescriptorValue {
    let mut d = Descriptor::new("", "puppetShape");
    d.set("rigidType", DescriptorValue::Boolean(p.rigid_type));
    d.set("VrsM", DescriptorValue::Integer(1));
    d.set("VrsN", DescriptorValue::Integer(0));
    let orig: Vec<f32> = p
        .original_vertex_array
        .iter()
        .flat_map(|pt| [pt.x as f32, pt.y as f32])
        .collect();
    d.set(
        "originalVertexArray",
        DescriptorValue::RawData(f32_to_uint8(&orig)),
    );
    let defo: Vec<f32> = p
        .deformed_vertex_array
        .iter()
        .flat_map(|pt| [pt.x as f32, pt.y as f32])
        .collect();
    d.set(
        "deformedVertexArray",
        DescriptorValue::RawData(f32_to_uint8(&defo)),
    );
    let idx: Vec<u32> = p.index_array.iter().map(|x| *x as u32).collect();
    d.set("indexArray", DescriptorValue::RawData(u32_to_uint8(&idx)));
    d.set(
        "pinOffsets",
        DescriptorValue::List(
            points_to_array(&p.pin_offsets)
                .into_iter()
                .map(DescriptorValue::Double)
                .collect(),
        ),
    );
    d.set(
        "posFinalPins",
        DescriptorValue::List(
            points_to_array(&p.pos_final_pins)
                .into_iter()
                .map(DescriptorValue::Double)
                .collect(),
        ),
    );
    d.set(
        "pinVertexIndices",
        DescriptorValue::List(
            p.pin_vertex_indices
                .iter()
                .map(|v| DescriptorValue::Double(*v))
                .collect(),
        ),
    );
    d.set(
        "PinP",
        DescriptorValue::List(
            points_to_array(&p.pin_position)
                .into_iter()
                .map(DescriptorValue::Double)
                .collect(),
        ),
    );
    d.set(
        "PnRt",
        DescriptorValue::List(
            p.pin_rotation
                .iter()
                .map(|v| DescriptorValue::Double(*v))
                .collect(),
        ),
    );
    d.set(
        "PnOv",
        DescriptorValue::List(
            p.pin_overlay
                .iter()
                .map(|v| DescriptorValue::Boolean(*v))
                .collect(),
        ),
    );
    d.set(
        "PnDp",
        DescriptorValue::List(
            p.pin_depth
                .iter()
                .map(|v| DescriptorValue::Double(*v))
                .collect(),
        ),
    );
    d.set("meshQuality", DescriptorValue::Double(p.mesh_quality));
    d.set("meshExpansion", DescriptorValue::Double(p.mesh_expansion));
    d.set("meshRigidity", DescriptorValue::Double(p.mesh_rigidity));
    d.set(
        "imageResolution",
        DescriptorValue::Double(p.image_resolution),
    );
    let mut mbp = Descriptor::new("", "pathClass");
    let comps: Vec<DescriptorValue> = p
        .mesh_boundary_path
        .iter()
        .map(|c| {
            let mut cd = Descriptor::new("", "PaCm");
            cd.set(
                "shapeOperation",
                DescriptorValue::Enum(format!("shapeOperation.{}", c.shape_operation)),
            );
            let paths: Vec<DescriptorValue> = c
                .paths
                .iter()
                .map(|path| {
                    let mut pd = Descriptor::new("", "Sbpl");
                    pd.set("Clsp", DescriptorValue::Boolean(path.closed));
                    let pts: Vec<DescriptorValue> = path
                        .points
                        .iter()
                        .map(|pt| {
                            let mut pp = Descriptor::new("", "Pthp");
                            pp.set(
                                "Anch",
                                DescriptorValue::Descriptor(point_to_hrzn_vrtc(&pt.anchor)),
                            );
                            pp.set(
                                "Fwd ",
                                DescriptorValue::Descriptor(point_to_hrzn_vrtc(&pt.forward)),
                            );
                            pp.set(
                                "Bwd ",
                                DescriptorValue::Descriptor(point_to_hrzn_vrtc(&pt.backward)),
                            );
                            pp.set("Smoo", DescriptorValue::Boolean(pt.smooth));
                            DescriptorValue::Descriptor(pp)
                        })
                        .collect();
                    pd.set("Pts ", DescriptorValue::List(pts));
                    DescriptorValue::Descriptor(pd)
                })
                .collect();
            cd.set("SbpL", DescriptorValue::List(paths));
            DescriptorValue::Descriptor(cd)
        })
        .collect();
    mbp.set("pathComponents", DescriptorValue::List(comps));
    d.set("meshBoundaryPath", DescriptorValue::Descriptor(mbp));
    d.set(
        "selectedPin",
        DescriptorValue::List(
            p.selected_pin
                .iter()
                .map(|v| DescriptorValue::Double(*v))
                .collect(),
        ),
    );
    DescriptorValue::Descriptor(d)
}

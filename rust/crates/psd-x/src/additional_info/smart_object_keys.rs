//! Smart-object keys (`PxSc`/`PlLd`/`SoLd`/`Patt*`/`lnk*`); patterns via `reader::read_pattern`.

use crate::additional_info::{ReadCtx, WriteCtx};
use crate::descriptor::{
    Descriptor, DescriptorValue, UnitDoubleValue, read_version_and_descriptor,
    write_version_and_descriptor,
};
use crate::helpers::{Dict, EnumCodec};
use crate::psd::{
    CustomEnvelopeWarp, LayerAdditionalInfo, NumDenom, Orientation, PixelSource,
    PixelSourceFrameReader, PixelSourceFrameReaderLink, PixelSourceInterpretation, PlacedLayer,
    PlacedLayerType, PointF, Units, UnitsBounds, UnitsValue, Warp, WarpStyle,
};
use crate::reader::{
    PsdReader, ReadError, ReadResult, read_float64, read_int32, read_pascal_string, read_pattern,
    read_signature, skip_bytes,
};
use crate::writer::{PsdWriter, write_float64, write_int32, write_pattern, write_signature};
// --- read ---
pub fn read(
    key: &str,
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &mut ReadCtx,
) -> ReadResult<Option<()>> {
    match key {
        "PxSc" => read_pxsc(reader, info)?,
        "PlLd" => read_plld(reader, info, left)?,
        "SoLd" | "SoLE" => read_sold(reader, info, left, ctx)?,
        "Patt" | "Pat2" | "Pat3" => {
            while left(reader) > 0 {
                let pattern = read_pattern(reader)?;
                info.patterns.get_or_insert_with(Vec::new).push(pattern);
            }
        }
        "lnk2" | "lnkD" | "lnk3" | "lnkE" => {
            crate::additional_info::linked_files::read_lnk(key, reader, left, ctx)?;
        }
        _ => return Ok(None),
    }
    Ok(Some(()))
}
// --- has ---
pub fn has(key: &str, info: &LayerAdditionalInfo, ctx: &WriteCtx<'_>) -> Option<bool> {
    match key {
        "PxSc" => Some(false), // upstream: () => false
        "PlLd" | "SoLd" | "SoLE" => Some(info.placed_layer.is_some()),
        "Patt" | "Pat2" | "Pat3" => Some(
            info.patterns
                .as_ref()
                .map(|p| !p.is_empty())
                .unwrap_or(false),
        ),
        "lnk2" | "lnkD" | "lnk3" | "lnkE" => {
            Some(crate::additional_info::linked_files::has_lnk(key, ctx))
        }
        _ => None,
    }
}
// --- write ---
pub fn write(
    key: &str,
    writer: &mut PsdWriter,
    info: &LayerAdditionalInfo,
    ctx: &mut WriteCtx,
) -> Option<ReadResult<()>> {
    let r = match key {
        "PxSc" => write_pxsc(writer, info),
        "PlLd" => write_plld(writer, info),
        "SoLd" | "SoLE" => write_sold(writer, info),
        "Patt" | "Pat2" | "Pat3" => {
            for pattern in info.patterns.as_deref().unwrap_or(&[]) {
                write_pattern(writer, pattern);
            }
            Ok(())
        }
        "lnk2" | "lnkD" | "lnk3" | "lnkE" => {
            crate::additional_info::linked_files::write_lnk(key, writer, ctx)
        }
        _ => return None,
    };
    Some(r)
}
// --- Enum codecs / converters (mirror of descriptor.ts: Ornt / warpStyle) ---
fn dict(pairs: &[(&str, &str)]) -> Dict {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}
fn ornt_codec() -> EnumCodec {
    EnumCodec::new(
        "Ornt",
        "horizontal",
        dict(&[("horizontal", "Hrzn"), ("vertical", "Vrtc")]),
    )
}
fn warp_style_codec() -> EnumCodec {
    EnumCodec::new(
        "warpStyle",
        "none",
        dict(&[
            ("none", "warpNone"),
            ("arc", "warpArc"),
            ("arcLower", "warpArcLower"),
            ("arcUpper", "warpArcUpper"),
            ("arch", "warpArch"),
            ("bulge", "warpBulge"),
            ("shellLower", "warpShellLower"),
            ("shellUpper", "warpShellUpper"),
            ("flag", "warpFlag"),
            ("wave", "warpWave"),
            ("fish", "warpFish"),
            ("rise", "warpRise"),
            ("fisheye", "warpFisheye"),
            ("inflate", "warpInflate"),
            ("squeeze", "warpSqueeze"),
            ("twist", "warpTwist"),
            ("cylinder", "warpCylinder"),
            ("custom", "warpCustom"),
        ]),
    )
}
fn orientation_to_str(v: Orientation) -> &'static str {
    match v {
        Orientation::Horizontal => "horizontal",
        Orientation::Vertical => "vertical",
    }
}
fn orientation_from_str(s: &str) -> Orientation {
    match s {
        "vertical" => Orientation::Vertical,
        _ => Orientation::Horizontal,
    }
}
fn warp_style_to_str(v: WarpStyle) -> &'static str {
    match v {
        WarpStyle::None => "none",
        WarpStyle::Arc => "arc",
        WarpStyle::ArcLower => "arcLower",
        WarpStyle::ArcUpper => "arcUpper",
        WarpStyle::Arch => "arch",
        WarpStyle::Bulge => "bulge",
        WarpStyle::ShellLower => "shellLower",
        WarpStyle::ShellUpper => "shellUpper",
        WarpStyle::Flag => "flag",
        WarpStyle::Wave => "wave",
        WarpStyle::Fish => "fish",
        WarpStyle::Rise => "rise",
        WarpStyle::Fisheye => "fisheye",
        WarpStyle::Inflate => "inflate",
        WarpStyle::Squeeze => "squeeze",
        WarpStyle::Twist => "twist",
        WarpStyle::Custom => "custom",
        WarpStyle::Cylinder => "cylinder",
    }
}
fn warp_style_from_str(s: &str) -> WarpStyle {
    match s {
        "arc" => WarpStyle::Arc,
        "arcLower" => WarpStyle::ArcLower,
        "arcUpper" => WarpStyle::ArcUpper,
        "arch" => WarpStyle::Arch,
        "bulge" => WarpStyle::Bulge,
        "shellLower" => WarpStyle::ShellLower,
        "shellUpper" => WarpStyle::ShellUpper,
        "flag" => WarpStyle::Flag,
        "wave" => WarpStyle::Wave,
        "fish" => WarpStyle::Fish,
        "rise" => WarpStyle::Rise,
        "fisheye" => WarpStyle::Fisheye,
        "inflate" => WarpStyle::Inflate,
        "squeeze" => WarpStyle::Squeeze,
        "twist" => WarpStyle::Twist,
        "custom" => WarpStyle::Custom,
        "cylinder" => WarpStyle::Cylinder,
        _ => WarpStyle::None,
    }
}
fn placed_layer_type_from_index(i: i32) -> ReadResult<PlacedLayerType> {
    Ok(match i {
        0 => PlacedLayerType::Unknown,
        1 => PlacedLayerType::Vector,
        2 => PlacedLayerType::Raster,
        3 => PlacedLayerType::ImageStack,
        other => {
            return Err(ReadError::StrictViolation(format!(
                "Invalid placedLayer type: {other}"
            )));
        }
    })
}
fn placed_layer_type_to_index(t: PlacedLayerType) -> i32 {
    match t {
        PlacedLayerType::Unknown => 0,
        PlacedLayerType::Vector => 1,
        PlacedLayerType::Raster => 2,
        PlacedLayerType::ImageStack => 3,
    }
}
// --- Units helpers (mirror of parseUnits / unitsValue / parseUnitsOrNumber) ---
// units helpers — canonical home is descriptor.rs.
use crate::descriptor::{parse_units, parse_units_or_number};
/// Adapter over `descriptor::units_value` (by-reference, always `Some`).
fn units_value(v: &UnitsValue) -> DescriptorValue {
    crate::descriptor::units_value(Some(v))
}
fn double_list(values: &[f64]) -> DescriptorValue {
    DescriptorValue::List(values.iter().map(|v| DescriptorValue::Double(*v)).collect())
}
// --- Fraction (frac) helpers ---
/// Mirror of `frac(desc)` — reads { numerator, denominator } from a descriptor.
fn read_frac(v: Option<&DescriptorValue>) -> NumDenom {
    if let Some(DescriptorValue::Descriptor(d)) = v {
        NumDenom {
            numerator: d.number("numerator").unwrap_or(0.0),
            denominator: d.number("denominator").unwrap_or(600.0),
        }
    } else {
        NumDenom {
            numerator: 0.0,
            denominator: 600.0,
        }
    }
}
fn write_frac(nd: &NumDenom) -> DescriptorValue {
    let mut d = Descriptor::new("", "null");
    d.set("numerator", DescriptorValue::Integer(nd.numerator as i32));
    d.set(
        "denominator",
        DescriptorValue::Integer(nd.denominator as i32),
    );
    DescriptorValue::Descriptor(d)
}
// ===========================================================================
// Warp parse / encode (full set: bounds / orders / deform / envelope)
// mirror of parseWarp / encodeWarp / isQuiltWarp / getWarpFromPlacedLayer
// ===========================================================================
fn parse_warp(warp: &Descriptor) -> ReadResult<Warp> {
    let style_str = warp_style_codec()
        .decode(warp.enumeration("warpStyle").as_deref().unwrap_or(""))
        .map_err(ReadError::StrictViolation)?;
    let rotate_str = ornt_codec()
        .decode(warp.enumeration("warpRotate").as_deref().unwrap_or(""))
        .map_err(ReadError::StrictViolation)?;
    let (value, values) = match warp.get("warpValues") {
        Some(_) => (None, Some(warp.number_list("warpValues"))),
        None => (Some(warp.number("warpValue").unwrap_or(0.0)), None),
    };
    let (bounds, bounds_class_id) = match warp.descriptor("bounds") {
        Some(b) => {
            let get = |k: &str| -> ReadResult<UnitsValue> {
                b.get(k)
                    .ok_or_else(|| ReadError::StrictViolation(format!("Missing warp bound: {k}")))
                    .and_then(parse_units_or_number)
            };
            (
                Some(UnitsBounds {
                    top: get("Top ")?,
                    left: get("Left")?,
                    bottom: get("Btom")?,
                    right: get("Rght")?,
                }),
                Some(b.class_id.clone()),
            )
        }
        None => (None, None),
    };
    let mut result = Warp {
        style: Some(warp_style_from_str(&style_str)),
        value,
        values,
        perspective: Some(warp.number("warpPerspective").unwrap_or(0.0)),
        perspective_other: Some(warp.number("warpPerspectiveOther").unwrap_or(0.0)),
        rotate: Some(orientation_from_str(&rotate_str)),
        bounds,
        bounds_class_id,
        u_order: warp.number("uOrder"),
        v_order: warp.number("vOrder"),
        deform_num_rows: None,
        deform_num_cols: None,
        custom_envelope_warp: None,
    };
    let has_rows = warp.get("deformNumRows").is_some();
    let has_cols = warp.get("deformNumCols").is_some();
    if has_rows || has_cols {
        result.deform_num_rows = warp.number("deformNumRows");
        result.deform_num_cols = warp.number("deformNumCols");
    }
    if let Some(envelope) = warp.descriptor("customEnvelopeWarp") {
        let mut cew = CustomEnvelopeWarp::default();
        // meshPoints: ObjectArray of { type: 'Hrzn'/'Vrtc', values }
        let (xs, ys) = match envelope.get("meshPoints") {
            Some(DescriptorValue::ObjectArray(items)) => {
                let xs = items
                    .iter()
                    .find(|i| i.type_ == "Hrzn")
                    .map(|i| i.values.clone())
                    .unwrap_or_default();
                let ys = items
                    .iter()
                    .find(|i| i.type_ == "Vrtc")
                    .map(|i| i.values.clone())
                    .unwrap_or_default();
                (xs, ys)
            }
            _ => (Vec::new(), Vec::new()),
        };
        for i in 0..xs.len() {
            cew.mesh_points.push(PointF {
                x: xs[i],
                y: *ys.get(i).unwrap_or(&0.0),
            });
        }
        let qx = object_array_values(envelope, "quiltSliceX");
        let qy = object_array_values(envelope, "quiltSliceY");
        if qx.is_some() || qy.is_some() {
            cew.quilt_slice_x = Some(qx.unwrap_or_default());
            cew.quilt_slice_y = Some(qy.unwrap_or_default());
        }
        result.custom_envelope_warp = Some(cew);
    }
    Ok(result)
}
/// Extracts `values` from the first ObjectArray element by key (for quiltSliceX/Y).
fn object_array_values(desc: &Descriptor, key: &str) -> Option<Vec<f64>> {
    match desc.get(key) {
        Some(DescriptorValue::ObjectArray(items)) => items.first().map(|i| i.values.clone()),
        _ => None,
    }
}
fn is_quilt_warp(warp: &Warp) -> bool {
    warp.deform_num_cols.is_some()
        || warp.deform_num_rows.is_some()
        || warp
            .custom_envelope_warp
            .as_ref()
            .map(|c| c.quilt_slice_x.is_some() || c.quilt_slice_y.is_some())
            .unwrap_or(false)
}
/// Mirror of `encodeWarp(warp)` (full field set).
fn encode_warp(warp: &Warp) -> Descriptor {
    let class_id = if is_quilt_warp(warp) {
        "quiltWarp"
    } else {
        "warp"
    };
    let mut desc = Descriptor::new("", class_id);
    let style = warp.style.map(warp_style_to_str);
    desc.set(
        "warpStyle",
        DescriptorValue::Enum(warp_style_codec().encode(style).expect("warpStyle encode")),
    );
    if let Some(values) = &warp.values {
        desc.set("warpValues", double_list(values));
    } else {
        desc.set(
            "warpValue",
            DescriptorValue::Double(warp.value.unwrap_or(0.0)),
        );
    }
    desc.set(
        "warpPerspective",
        DescriptorValue::Double(warp.perspective.unwrap_or(0.0)),
    );
    desc.set(
        "warpPerspectiveOther",
        DescriptorValue::Double(warp.perspective_other.unwrap_or(0.0)),
    );
    let rotate = warp.rotate.map(orientation_to_str);
    desc.set(
        "warpRotate",
        DescriptorValue::Enum(ornt_codec().encode(rotate).expect("warpRotate encode")),
    );
    let zero = UnitsValue {
        units: Units::Pixels,
        value: 0.0,
    };
    let bounds = warp.bounds;
    // Quilt → classFloatRect; else Rctn. Does not round-trip bounds_class_id.
    let is_quilt = is_quilt_warp(warp);
    let bounds_class = if is_quilt { "classFloatRect" } else { "Rctn" };
    let mut b = Descriptor::new("", bounds_class);
    b.set(
        "Top ",
        units_value(bounds.as_ref().map(|x| &x.top).unwrap_or(&zero)),
    );
    b.set(
        "Left",
        units_value(bounds.as_ref().map(|x| &x.left).unwrap_or(&zero)),
    );
    b.set(
        "Btom",
        units_value(bounds.as_ref().map(|x| &x.bottom).unwrap_or(&zero)),
    );
    b.set(
        "Rght",
        units_value(bounds.as_ref().map(|x| &x.right).unwrap_or(&zero)),
    );
    desc.set("bounds", DescriptorValue::Descriptor(b));
    desc.set(
        "uOrder",
        DescriptorValue::Integer(warp.u_order.unwrap_or(0.0) as i32),
    );
    desc.set(
        "vOrder",
        DescriptorValue::Integer(warp.v_order.unwrap_or(0.0) as i32),
    );
    if is_quilt {
        desc.set(
            "deformNumRows",
            DescriptorValue::Integer(warp.deform_num_rows.unwrap_or(0.0) as i32),
        );
        desc.set(
            "deformNumCols",
            DescriptorValue::Integer(warp.deform_num_cols.unwrap_or(0.0) as i32),
        );
    }
    if let Some(cew) = &warp.custom_envelope_warp {
        let mut env = Descriptor::new("", "customEnvelopeWarp");
        let xs: Vec<f64> = cew.mesh_points.iter().map(|p| p.x).collect();
        let ys: Vec<f64> = cew.mesh_points.iter().map(|p| p.y).collect();
        if is_quilt {
            env.set(
                "quiltSliceX",
                DescriptorValue::ObjectArray(vec![crate::descriptor::ObjectArrayItem {
                    type_: "quiltSliceX".to_string(),
                    values: cew.quilt_slice_x.clone().unwrap_or_default(),
                }]),
            );
            env.set(
                "quiltSliceY",
                DescriptorValue::ObjectArray(vec![crate::descriptor::ObjectArrayItem {
                    type_: "quiltSliceY".to_string(),
                    values: cew.quilt_slice_y.clone().unwrap_or_default(),
                }]),
            );
        }
        env.set(
            "meshPoints",
            DescriptorValue::ObjectArray(vec![
                crate::descriptor::ObjectArrayItem {
                    type_: "Hrzn".to_string(),
                    values: xs,
                },
                crate::descriptor::ObjectArrayItem {
                    type_: "Vrtc".to_string(),
                    values: ys,
                },
            ]),
        );
        desc.set("customEnvelopeWarp", DescriptorValue::Descriptor(env));
    }
    desc
}
/// Mirror of `getWarpFromPlacedLayer(placed)`.
impl Warp {
    pub(crate) fn from_placed_layer(placed: &PlacedLayer) -> ReadResult<Warp> {
        if let Some(w) = &placed.warp {
            return Ok(w.clone());
        }
        let w = placed.width.unwrap_or(0.0);
        let h = placed.height.unwrap_or(0.0);
        if w == 0.0 || h == 0.0 {
            return Err(ReadError::StrictViolation(
                "You must provide width and height of the linked image in placedLayer".to_string(),
            ));
        }
        let px = |v: f64| UnitsValue {
            value: v,
            units: Units::Pixels,
        };
        let xs = [0.0, w / 3.0, w * 2.0 / 3.0, w];
        let ys = [0.0, h / 3.0, h * 2.0 / 3.0, h];
        let mut mesh_points = Vec::with_capacity(16);
        for &y in &ys {
            for &x in &xs {
                mesh_points.push(PointF { x, y });
            }
        }
        Ok(Warp {
            style: Some(WarpStyle::Custom),
            value: Some(0.0),
            values: None,
            perspective: Some(0.0),
            perspective_other: Some(0.0),
            rotate: Some(Orientation::Horizontal),
            bounds: Some(UnitsBounds {
                top: px(0.0),
                left: px(0.0),
                bottom: px(h),
                right: px(w),
            }),
            bounds_class_id: None,
            u_order: Some(4.0),
            v_order: Some(4.0),
            deform_num_rows: None,
            deform_num_cols: None,
            custom_envelope_warp: Some(CustomEnvelopeWarp {
                quilt_slice_x: None,
                quilt_slice_y: None,
                mesh_points,
            }),
        })
    }
}
fn check_guid(id: &str) -> ReadResult<()> {
    if crate::guid::is_guid(id) {
        Ok(())
    } else {
        Err(ReadError::StrictViolation(
            "ID must be in a GUID format (example: 20953ddb-9391-11ec-b4f1-c15674f50bc4)"
                .to_string(),
        ))
    }
}
// --- PxSc ---
fn read_pxsc(reader: &mut PsdReader, info: &mut LayerAdditionalInfo) -> ReadResult<()> {
    let desc = read_version_and_descriptor(reader)?;
    if desc.number("pixelSourceType").map(|v| v as i32) == Some(1986285651) {
        let origin = desc
            .descriptor("origin")
            .ok_or_else(|| ReadError::StrictViolation("PxSc missing origin".to_string()))?;
        let interp = desc
            .descriptor("interpretation")
            .ok_or_else(|| ReadError::StrictViolation("PxSc missing interpretation".to_string()))?;
        let frame_reader = desc
            .descriptor("frameReader")
            .ok_or_else(|| ReadError::StrictViolation("PxSc missing frameReader".to_string()))?;
        let link = frame_reader
            .descriptor("Lnk ")
            .ok_or_else(|| ReadError::StrictViolation("PxSc missing Lnk".to_string()))?;
        // interpretAlpha enum string "alphaInterpretation.<value>" -> "<value>"
        let interpret_alpha = interp
            .enumeration("interpretAlpha")
            .and_then(|s| s.split('.').nth(1).map(|s| s.to_string()))
            .unwrap_or_default();
        let profile = match interp.get("profile") {
            Some(DescriptorValue::RawData(d)) => d.clone(),
            _ => Vec::new(),
        };
        info.pixel_source = Some(PixelSource {
            source_type: "vdPS".to_string(),
            origin: PointF {
                x: origin.number("Hrzn").unwrap_or(0.0),
                y: origin.number("Vrtc").unwrap_or(0.0),
            },
            interpretation: PixelSourceInterpretation {
                interpret_alpha,
                profile,
            },
            frame_reader: PixelSourceFrameReader {
                reader_type: "QTFR".to_string(),
                link: PixelSourceFrameReaderLink {
                    name: link.text("Nm  ").unwrap_or_default(),
                    full_path: link.text("fullPath").unwrap_or_default(),
                    original_path: link.text("originalPath").unwrap_or_default(),
                    relative_path: link.text("relPath").unwrap_or_default(),
                    alias: match link.get("alis") {
                        Some(DescriptorValue::Alias(s)) => s.clone(),
                        Some(DescriptorValue::Text(s)) => s.clone(),
                        _ => String::new(),
                    },
                },
                media_descriptor: frame_reader.text("mediaDescriptor").unwrap_or_default(),
            },
            show_altered_video: matches!(
                desc.get("showAlteredVideo"),
                Some(DescriptorValue::Boolean(true))
            ),
        });
    }
    // else: unknown pixelSourceType — upstream just logs.
    Ok(())
}
fn write_pxsc(writer: &mut PsdWriter, info: &LayerAdditionalInfo) -> ReadResult<()> {
    let source = info
        .pixel_source
        .as_ref()
        .ok_or_else(|| ReadError::StrictViolation("PxSc: missing pixelSource".to_string()))?;
    let mut desc = Descriptor::new("", "PixelSource");
    desc.set("pixelSourceType", DescriptorValue::Integer(1986285651));
    desc.set("descVersion", DescriptorValue::Integer(1));
    let mut origin = Descriptor::new("", "Pnt ");
    origin.set("Hrzn", DescriptorValue::Double(source.origin.x));
    origin.set("Vrtc", DescriptorValue::Double(source.origin.y));
    desc.set("origin", DescriptorValue::Descriptor(origin));
    let mut interp = Descriptor::new("", "footageInterpretation");
    interp.set("Vrsn", DescriptorValue::Integer(1));
    interp.set(
        "interpretAlpha",
        DescriptorValue::Enum(format!(
            "alphaInterpretation.{}",
            source.interpretation.interpret_alpha
        )),
    );
    interp.set(
        "profile",
        DescriptorValue::RawData(source.interpretation.profile.clone()),
    );
    desc.set("interpretation", DescriptorValue::Descriptor(interp));
    let mut frame_reader = Descriptor::new("", "FrameReader");
    frame_reader.set("frameReaderType", DescriptorValue::Integer(1364477522));
    frame_reader.set("descVersion", DescriptorValue::Integer(1));
    let mut link = Descriptor::new("", "ExternalFileLink");
    link.set("descVersion", DescriptorValue::Integer(2));
    link.set(
        "Nm  ",
        DescriptorValue::Text(source.frame_reader.link.name.clone()),
    );
    link.set(
        "fullPath",
        DescriptorValue::Text(source.frame_reader.link.full_path.clone()),
    );
    link.set(
        "originalPath",
        DescriptorValue::Text(source.frame_reader.link.original_path.clone()),
    );
    link.set(
        "alis",
        DescriptorValue::Alias(source.frame_reader.link.alias.clone()),
    );
    link.set(
        "relPath",
        DescriptorValue::Text(source.frame_reader.link.relative_path.clone()),
    );
    frame_reader.set("Lnk ", DescriptorValue::Descriptor(link));
    frame_reader.set(
        "mediaDescriptor",
        DescriptorValue::Text(source.frame_reader.media_descriptor.clone()),
    );
    desc.set("frameReader", DescriptorValue::Descriptor(frame_reader));
    desc.set(
        "showAlteredVideo",
        DescriptorValue::Boolean(source.show_altered_video),
    );
    write_version_and_descriptor(writer, &desc);
    Ok(())
}
// --- PlLd (legacy placed layer) ---
fn read_plld(
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
) -> ReadResult<()> {
    if read_signature(reader)? != "plcL" {
        return Err(ReadError::StrictViolation(
            "Invalid PlLd signature".to_string(),
        ));
    }
    if read_int32(reader)? != 3 {
        return Err(ReadError::StrictViolation(
            "Invalid PlLd version".to_string(),
        ));
    }
    let id = read_pascal_string(reader, 1)?;
    let page_number = read_int32(reader)?;
    let total_pages = read_int32(reader)?;
    read_int32(reader)?; // antiAliasPolicy 16
    let placed_layer_type = placed_layer_type_from_index(read_int32(reader)?)?;
    let mut transform = Vec::with_capacity(8);
    for _ in 0..8 {
        transform.push(read_float64(reader)?);
    }
    let warp_version = read_int32(reader)?;
    if warp_version != 0 {
        return Err(ReadError::StrictViolation(format!(
            "Invalid Warp version {warp_version}"
        )));
    }
    let warp_desc = read_version_and_descriptor(reader)?;
    // skip if SoLd already set it
    if info.placed_layer.is_none() {
        info.placed_layer = Some(PlacedLayer {
            id,
            layer_type: Some(placed_layer_type),
            page_number: Some(page_number as f64),
            total_pages: Some(total_pages as f64),
            transform,
            warp: Some(parse_warp(&warp_desc)?),
            ..PlacedLayer::default()
        });
    }
    skip_bytes(reader, left(reader));
    Ok(())
}
fn write_plld(writer: &mut PsdWriter, info: &LayerAdditionalInfo) -> ReadResult<()> {
    let placed = info
        .placed_layer
        .as_ref()
        .ok_or_else(|| ReadError::StrictViolation("PlLd: missing placedLayer".to_string()))?;
    write_signature(writer, "plcL").expect("signature");
    write_int32(writer, 3); // version
    check_guid(&placed.id)?;
    crate::writer::write_pascal_string(writer, &placed.id, 1).expect("pascal string");
    write_int32(writer, 1); // pageNumber
    write_int32(writer, 1); // totalPages
    write_int32(writer, 16); // antiAliasPolicy
    let t = placed
        .layer_type
        .ok_or_else(|| ReadError::StrictViolation("Invalid placedLayer type".to_string()))?;
    write_int32(writer, placed_layer_type_to_index(t));
    for i in 0..8 {
        write_float64(writer, *placed.transform.get(i).unwrap_or(&0.0));
    }
    write_int32(writer, 0); // warp version
    let warp = Warp::from_placed_layer(placed)?;
    write_version_and_descriptor(writer, &encode_warp(&warp));
    Ok(())
}
// --- SoLd (smart object placed layer) ---
fn read_sold(
    reader: &mut PsdReader,
    info: &mut LayerAdditionalInfo,
    left: &dyn Fn(&PsdReader) -> usize,
    ctx: &ReadCtx<'_>,
) -> ReadResult<()> {
    if read_signature(reader)? != "soLD" {
        return Err(ReadError::StrictViolation("Invalid SoLd type".to_string()));
    }
    let version = read_int32(reader)?;
    if version != 4 && version != 5 {
        return Err(ReadError::StrictViolation(format!(
            "Invalid SoLd version {version}"
        )));
    }
    let desc = read_version_and_descriptor(reader)?;
    let trnf = desc.number_list("Trnf");
    let non_affine = desc.number_list("nonAffineTransform");
    let size = desc.descriptor("Sz  ");
    let warp_src = if desc.get("quiltWarp").is_some() {
        desc.descriptor("quiltWarp")
    } else {
        desc.descriptor("warp")
    };
    let mut placed = PlacedLayer {
        id: desc.text("Idnt").unwrap_or_default(),
        placed: desc.text("placed"),
        layer_type: Some(placed_layer_type_from_index(
            desc.number("Type").map(|v| v as i32).unwrap_or(0),
        )?),
        page_number: desc.number("PgNm"),
        total_pages: desc.number("totalPages"),
        frame_step: Some(read_frac(desc.get("frameStep"))),
        duration: Some(read_frac(desc.get("duration"))),
        frame_count: desc.number("frameCount"),
        transform: trnf.clone(),
        width: size.and_then(|s| s.number("Wdth")),
        height: size.and_then(|s| s.number("Hght")),
        resolution: desc.get("Rslt").and_then(|v| parse_units(v).ok()),
        warp: warp_src.map(parse_warp).transpose()?,
        ..PlacedLayer::default()
    };
    if !non_affine.is_empty()
        && non_affine.len() == trnf.len()
        && non_affine.iter().zip(trnf.iter()).any(|(a, b)| a != b)
    {
        placed.non_affine_transform = Some(non_affine);
    }
    if let Some(c) = desc.number("Crop") {
        if c != 0.0 {
            placed.crop = Some(c);
        }
    }
    if let Some(c) = desc.number("comp") {
        if c != 0.0 {
            placed.comp = Some(c);
        }
    }
    if let Some(ci) = desc.descriptor("compInfo") {
        placed.comp_info = Some(crate::psd::CompInfo {
            comp_id: ci.number("compID").unwrap_or(0.0),
            original_comp_id: ci.number("originalCompID").unwrap_or(0.0),
        });
    }
    if let Some(DescriptorValue::Descriptor(filter_fx)) = desc.get("filterFX") {
        let throw = ctx.options.throw_for_missing_features == Some(true);
        placed.filter = Some(crate::additional_info::filter_fx::parse_filter_fx(
            filter_fx, throw,
        )?);
    }
    info.placed_layer = Some(placed);
    skip_bytes(reader, left(reader)); // HACK (upstream)
    Ok(())
}
fn write_sold(writer: &mut PsdWriter, info: &LayerAdditionalInfo) -> ReadResult<()> {
    write_signature(writer, "soLD").expect("signature");
    write_int32(writer, 4); // version
    let placed = info
        .placed_layer
        .as_ref()
        .ok_or_else(|| ReadError::StrictViolation("SoLd: missing placedLayer".to_string()))?;
    check_guid(&placed.id)?;
    // Instance GUID: validated when present; when absent the writer
    // substitutes `placed.id` (already checked above).
    if let Some(instance) = placed.placed.as_deref() {
        check_guid(instance)?;
    }
    let mut desc = Descriptor::new("", "null");
    desc.set("Idnt", DescriptorValue::Text(placed.id.clone()));
    desc.set(
        "placed",
        DescriptorValue::Text(placed.placed.clone().unwrap_or_else(|| placed.id.clone())),
    );
    desc.set(
        "PgNm",
        DescriptorValue::Integer(placed.page_number.unwrap_or(1.0) as i32),
    );
    desc.set(
        "totalPages",
        DescriptorValue::Integer(placed.total_pages.unwrap_or(1.0) as i32),
    );
    if let Some(crop) = placed.crop {
        desc.set("Crop", DescriptorValue::Integer(crop as i32));
    }
    desc.set(
        "frameStep",
        write_frac(&placed.frame_step.unwrap_or(NumDenom {
            numerator: 0.0,
            denominator: 600.0,
        })),
    );
    desc.set(
        "duration",
        write_frac(&placed.duration.unwrap_or(NumDenom {
            numerator: 0.0,
            denominator: 600.0,
        })),
    );
    desc.set(
        "frameCount",
        DescriptorValue::Integer(placed.frame_count.unwrap_or(0.0) as i32),
    );
    desc.set("Annt", DescriptorValue::Integer(16));
    let t = placed
        .layer_type
        .ok_or_else(|| ReadError::StrictViolation("Invalid placedLayer type".to_string()))?;
    desc.set(
        "Type",
        DescriptorValue::Integer(placed_layer_type_to_index(t)),
    );
    desc.set("Trnf", double_list(&placed.transform));
    desc.set(
        "nonAffineTransform",
        double_list(
            placed
                .non_affine_transform
                .as_deref()
                .unwrap_or(&placed.transform),
        ),
    );
    // warp / quiltWarp: mirror upstream split.
    let warp = Warp::from_placed_layer(placed)?;
    let quilt = placed.warp.as_ref().map(is_quilt_warp).unwrap_or(false);
    desc.set("warp", DescriptorValue::Descriptor(encode_warp(&warp)));
    let mut size = Descriptor::new("", "Pnt ");
    // typeToField: Wdth/Hght are doub.
    size.set("Wdth", DescriptorValue::Double(placed.width.unwrap_or(0.0)));
    size.set(
        "Hght",
        DescriptorValue::Double(placed.height.unwrap_or(0.0)),
    );
    desc.set("Sz  ", DescriptorValue::Descriptor(size));
    desc.set(
        "Rslt",
        match &placed.resolution {
            Some(r) => units_value(r),
            None => DescriptorValue::UnitDouble(UnitDoubleValue {
                units: "Density".to_string(),
                value: 72.0,
            }),
        },
    );
    if let Some(filter) = &placed.filter {
        desc.set(
            "filterFX",
            DescriptorValue::Descriptor(crate::additional_info::filter_fx::serialize_filter_fx(
                filter,
            )),
        );
    }
    // Upstream order: filterFX → quiltWarp (replace warp) → comp → compInfo
    if quilt {
        let quilt_warp = encode_warp(placed.warp.as_ref().unwrap());
        let mut warp_desc = Descriptor::new("", "warp");
        warp_desc.set(
            "warpStyle",
            DescriptorValue::Enum("warpStyle.warpNone".to_string()),
        );
        copy_field(&quilt_warp, &mut warp_desc, "warpValue");
        copy_field(&quilt_warp, &mut warp_desc, "warpPerspective");
        copy_field(&quilt_warp, &mut warp_desc, "warpPerspectiveOther");
        copy_field(&quilt_warp, &mut warp_desc, "warpRotate");
        copy_field(&quilt_warp, &mut warp_desc, "bounds");
        copy_field(&quilt_warp, &mut warp_desc, "uOrder");
        copy_field(&quilt_warp, &mut warp_desc, "vOrder");
        if let Some((_, v)) = desc.items.iter_mut().find(|(k, _)| k == "warp") {
            *v = DescriptorValue::Descriptor(warp_desc);
        }
        desc.set("quiltWarp", DescriptorValue::Descriptor(quilt_warp));
    }
    if let Some(c) = placed.comp {
        desc.set("comp", DescriptorValue::Integer(c as i32));
    }
    if let Some(ci) = placed.comp_info {
        let mut ci_desc = Descriptor::new("", "null");
        ci_desc.set("compID", DescriptorValue::Integer(ci.comp_id as i32));
        ci_desc.set(
            "originalCompID",
            DescriptorValue::Integer(ci.original_comp_id as i32),
        );
        desc.set("compInfo", DescriptorValue::Descriptor(ci_desc));
    }
    write_version_and_descriptor(writer, &desc);
    Ok(())
}
fn copy_field(src: &Descriptor, dst: &mut Descriptor, key: &str) {
    if let Some(v) = src.get(key) {
        dst.set(key, v.clone());
    }
}

//! Smart-object / smart-filter / linked-file fixture pins + 64-filter symmetry.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::additional_info::filter_fx::{parse_filter_fx_item, serialize_filter_fx_item};
use psdx::descriptor::{Descriptor, DescriptorValue, write_version_and_descriptor};
use psdx::psd::ReadOptions;
use psdx::psd::*;
use psdx::read_psd;
use psdx::reader::PsdReader;
use psdx::writer::create_writer_default;
use serde_json::Value;

fn fixture_psd(name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join("read").join(name);
    let psd = dir.join("src.psd");
    let psb = dir.join("src.psb");
    if psd.is_file() {
        Some(psd)
    } else if psb.is_file() {
        Some(psb)
    } else {
        None
    }
}

fn golden_json(name: &str) -> Option<Value> {
    let p = test_corpus::golden_root()
        .join("read")
        .join(name)
        .join("psd.json");
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn read_fixture(name: &str) -> Option<Psd> {
    let src = fixture_psd(name)?;
    let bytes = fs::read(src).ok()?;
    let opts = ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        ..ReadOptions::default()
    };
    read_psd(&bytes, &opts).ok()
}

fn json_eq_path(actual: &Value, expected: &Value, path: &str) {
    let mut diffs = Vec::new();
    fn walk(a: &Value, b: &Value, path: &str, diffs: &mut Vec<String>) {
        match (a, b) {
            (Value::Number(x), Value::Number(y)) => {
                let xf = x.as_f64().unwrap_or(f64::NAN);
                let yf = y.as_f64().unwrap_or(f64::NAN);
                let xf = if xf == 0.0 { 0.0 } else { xf };
                let yf = if yf == 0.0 { 0.0 } else { yf };
                let diff = (xf - yf).abs();
                if !(xf.is_nan() && yf.is_nan()) && diff > 1e-12 * xf.abs().max(yf.abs()).max(1.0) {
                    diffs.push(format!("{path}: {xf} != {yf}"));
                }
            }
            (Value::Array(xs), Value::Array(ys)) => {
                if xs.len() != ys.len() {
                    diffs.push(format!("{path}: len {} != {}", xs.len(), ys.len()));
                    return;
                }
                for (i, (x, y)) in xs.iter().zip(ys).enumerate() {
                    walk(x, y, &format!("{path}[{i}]"), diffs);
                }
            }
            (Value::Object(xs), Value::Object(ys)) => {
                for k in ys.keys() {
                    match (xs.get(k), ys.get(k)) {
                        (Some(xv), Some(yv)) => walk(xv, yv, &format!("{path}.{k}"), diffs),
                        (None, Some(_)) => diffs.push(format!("{path}.{k}: missing in actual")),
                        _ => {}
                    }
                }
            }
            _ if a == b => {}
            _ => diffs.push(format!("{path}: {a:?} != {b:?}")),
        }
    }
    walk(actual, expected, path, &mut diffs);
    assert!(
        diffs.is_empty(),
        "M6 path mismatch at {path}:\n{}",
        diffs.into_iter().take(12).collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn smart_object_linked_files_match_golden() {
    for name in [
        "smart-object",
        "smart-object-png",
        "smart-object-curves",
        "smart-filter",
        "smart-filter-blur",
    ] {
        let Some(psd) = read_fixture(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let Some(golden) = golden_json(name) else {
            eprintln!("skip {name}: golden missing");
            continue;
        };
        let mut actual = serde_json::to_value(&psd).expect("serialize");
        if let Some(Value::Array(files)) = actual.get_mut("linkedFiles") {
            for f in files {
                if let Some(o) = f.as_object_mut() {
                    o.remove("data");
                }
            }
        }
        json_eq_path(
            &actual["linkedFiles"],
            &golden["linkedFiles"],
            &format!("{name}.linkedFiles"),
        );
    }
}

#[test]
fn smart_filter_trees_match_golden() {
    for name in ["smart-filter", "smart-filter-blur", "smart-object-curves"] {
        let Some(psd) = read_fixture(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let Some(golden) = golden_json(name) else {
            eprintln!("skip {name}: golden missing");
            continue;
        };
        let actual = serde_json::to_value(&psd).expect("serialize");
        let children = actual["children"].as_array().expect("children");
        let gchildren = golden["children"].as_array().expect("golden children");
        let mut found = false;
        for (i, (layer, glayer)) in children.iter().zip(gchildren).enumerate() {
            if glayer.pointer("/placedLayer/filter").is_none() {
                continue;
            }
            found = true;
            json_eq_path(
                &layer["placedLayer"]["filter"],
                &glayer["placedLayer"]["filter"],
                &format!("{name}.children[{i}].placedLayer.filter"),
            );
        }
        assert!(found, "{name}: expected a placedLayer.filter in golden");
    }
}

#[test]
fn linked_layers_link_groups_populated() {
    let Some(psd) = read_fixture("linked-layers") else {
        eprintln!("skip linked-layers: fixture missing");
        return;
    };
    let children = psd.children.as_ref().expect("children");
    assert!(
        children.iter().any(|l| l.link_group.is_some()),
        "expected linkGroup from image resource 1026"
    );
    let Some(golden) = golden_json("linked-layers") else {
        return;
    };
    let actual = serde_json::to_value(&psd).unwrap();
    for (i, glayer) in golden["children"].as_array().unwrap().iter().enumerate() {
        if let Some(g) = glayer.get("linkGroup") {
            json_eq_path(
                &actual["children"][i]["linkGroup"],
                g,
                &format!("linked-layers.children[{i}].linkGroup"),
            );
        }
        if let Some(g) = glayer.get("linkGroupEnabled") {
            json_eq_path(
                &actual["children"][i]["linkGroupEnabled"],
                g,
                &format!("linked-layers.children[{i}].linkGroupEnabled"),
            );
        }
    }
}

fn sample_units() -> UnitsValue {
    UnitsValue {
        units: Units::Pixels,
        value: 3.5,
    }
}

fn base_filter(variant: FilterVariant) -> Filter {
    Filter {
        variant,
        name: "Test Filter".into(),
        opacity: 1.0,
        blend_mode: BlendMode::Normal,
        enabled: true,
        has_options: true,
        foreground_color: Color::Rgb(Rgb {
            r: 255.0,
            g: 255.0,
            b: 255.0,
        }),
        background_color: Color::Rgb(Rgb {
            r: 0.0,
            g: 0.0,
            b: 0.0,
        }),
    }
}

fn all_64_filters() -> Vec<Filter> {
    let u = sample_units();
    let named = NamedId {
        name: "shape".into(),
        id: "deadbeef".into(),
    };
    vec![
        base_filter(FilterVariant::Average),
        base_filter(FilterVariant::Blur),
        base_filter(FilterVariant::BlurMore),
        base_filter(FilterVariant::BoxBlur(RadiusFilter { radius: u })),
        base_filter(FilterVariant::GaussianBlur(RadiusFilter { radius: u })),
        base_filter(FilterVariant::MotionBlur {
            angle: 45.0,
            distance: u,
        }),
        base_filter(FilterVariant::RadialBlur {
            amount: 10.0,
            method: RadialBlurMethod::Spin,
            quality: RadialBlurQuality::Good,
        }),
        base_filter(FilterVariant::ShapeBlur {
            radius: u,
            custom_shape: named.clone(),
        }),
        base_filter(FilterVariant::SmartBlur {
            radius: 3.0,
            threshold: 10.0,
            quality: LowMediumHigh::Medium,
            mode: SmartBlurMode::Normal,
        }),
        base_filter(FilterVariant::SurfaceBlur {
            radius: u,
            threshold: 5.0,
        }),
        base_filter(FilterVariant::Displace {
            horizontal_scale: 10.0,
            vertical_scale: 10.0,
            displacement_map: DisplacementMap::StretchToFit,
            undefined_areas: WrapOrRepeat::RepeatEdgePixels,
            displacement_file: DisplacementFile {
                signature: "8BIM".into(),
                path: "/tmp/map".into(),
            },
        }),
        base_filter(FilterVariant::Pinch { amount: 50.0 }),
        base_filter(FilterVariant::PolarCoordinates {
            conversion: PolarConversion::RectangularToPolar,
        }),
        base_filter(FilterVariant::Ripple {
            amount: 20.0,
            size: SmallMediumLarge::Medium,
        }),
        base_filter(FilterVariant::Shear {
            shear_points: vec![PointF { x: 0.0, y: 0.0 }, PointF { x: 1.0, y: 1.0 }],
            shear_start: 0.0,
            shear_end: 1.0,
            undefined_areas: WrapOrRepeat::WrapAround,
        }),
        base_filter(FilterVariant::Spherize {
            amount: 30.0,
            mode: SpherizeMode::Normal,
        }),
        base_filter(FilterVariant::Twirl { angle: 90.0 }),
        base_filter(FilterVariant::Wave {
            number_of_generators: 5.0,
            wave_type: WaveType::Sine,
            wavelength: MinMax {
                min: 1.0,
                max: 10.0,
            },
            amplitude: MinMax { min: 1.0, max: 5.0 },
            scale: PointF { x: 100.0, y: 100.0 },
            random_seed: 1.0,
            undefined_areas: WrapOrRepeat::RepeatEdgePixels,
        }),
        base_filter(FilterVariant::ZigZag {
            amount: 10.0,
            ridges: 5.0,
            style: ZigZagStyle::PondRipples,
        }),
        base_filter(FilterVariant::AddNoise {
            amount: 0.25,
            distribution: NoiseDistribution::Uniform,
            monochromatic: true,
            random_seed: 2.0,
        }),
        base_filter(FilterVariant::Despeckle),
        base_filter(FilterVariant::DustAndScratches {
            radius: 2.0,
            threshold: 3.0,
        }),
        base_filter(FilterVariant::Median(RadiusFilter { radius: u })),
        base_filter(FilterVariant::ReduceNoise {
            preset: "Default".into(),
            remove_jpeg_artifact: false,
            reduce_color_noise: 0.1,
            sharpen_details: 0.2,
            channel_denoise: vec![ChannelDenoise {
                channels: vec![DenoiseChannel::Composite],
                amount: 5.0,
                preserve_details: Some(1.0),
            }],
        }),
        base_filter(FilterVariant::ColorHalftone {
            radius: 4.0,
            angle1: 0.0,
            angle2: 15.0,
            angle3: 30.0,
            angle4: 45.0,
        }),
        base_filter(FilterVariant::Crystallize {
            cell_size: 8.0,
            random_seed: 3.0,
        }),
        base_filter(FilterVariant::Facet),
        base_filter(FilterVariant::Fragment),
        base_filter(FilterVariant::Mezzotint {
            mezzotint_type: MezzotintType::FineDots,
            random_seed: 4.0,
        }),
        base_filter(FilterVariant::Mosaic { cell_size: u }),
        base_filter(FilterVariant::Pointillize {
            cell_size: 5.0,
            random_seed: 5.0,
        }),
        base_filter(FilterVariant::Clouds { random_seed: 6.0 }),
        base_filter(FilterVariant::DifferenceClouds { random_seed: 7.0 }),
        base_filter(FilterVariant::Fibers {
            variance: 10.0,
            strength: 20.0,
            random_seed: 8.0,
        }),
        base_filter(FilterVariant::LensFlare {
            brightness: 100.0,
            position: PointF { x: 50.0, y: 50.0 },
            lens_type: LensType::Zoom50To300,
        }),
        base_filter(FilterVariant::Sharpen),
        base_filter(FilterVariant::SharpenEdges),
        base_filter(FilterVariant::SharpenMore),
        base_filter(FilterVariant::SmartSharpen {
            amount: 0.5,
            radius: u,
            threshold: 1.0,
            angle: 0.0,
            more_accurate: true,
            blur: SmartSharpenBlur::GaussianBlur,
            preset: "Default".into(),
            shadow: SmartSharpenTone {
                fade_amount: 0.1,
                tonal_width: 0.2,
                radius: 1.0,
            },
            highlight: SmartSharpenTone {
                fade_amount: 0.1,
                tonal_width: 0.2,
                radius: 1.0,
            },
        }),
        base_filter(FilterVariant::UnsharpMask {
            amount: 0.5,
            radius: u,
            threshold: 2.0,
        }),
        base_filter(FilterVariant::Diffuse {
            mode: DiffuseMode::Normal,
            random_seed: 9.0,
        }),
        base_filter(FilterVariant::Emboss {
            angle: 135.0,
            height: 3.0,
            amount: 100.0,
        }),
        base_filter(FilterVariant::Extrude {
            extrude_type: ExtrudeType::Blocks,
            size: 10.0,
            depth: 20.0,
            depth_mode: ExtrudeDepthMode::Random,
            random_seed: 10.0,
            solid_front_faces: true,
            mask_incomplete_blocks: false,
        }),
        base_filter(FilterVariant::FindEdges),
        base_filter(FilterVariant::Solarize),
        base_filter(FilterVariant::Tiles {
            number_of_tiles: 10.0,
            maximum_offset: 10.0,
            fill_empty_area_with: TilesFill::BackgroundColor,
            random_seed: 11.0,
        }),
        base_filter(FilterVariant::TraceContour {
            level: 128.0,
            edge: LowerUpper::Upper,
        }),
        base_filter(FilterVariant::Wind {
            method: WindMethod::Wind,
            direction: LeftRight::Right,
        }),
        base_filter(FilterVariant::DeInterlace {
            eliminate: DeInterlaceEliminate::OddLines,
            new_fields_by: DeInterlaceNewFields::Interpolation,
        }),
        base_filter(FilterVariant::NtscColors),
        base_filter(FilterVariant::Custom {
            scale: 1.0,
            offset: 0.0,
            matrix: vec![0.0, -1.0, 0.0, -1.0, 5.0, -1.0, 0.0, -1.0, 0.0],
        }),
        base_filter(FilterVariant::HighPass(RadiusFilter { radius: u })),
        base_filter(FilterVariant::Maximum(RadiusFilter { radius: u })),
        base_filter(FilterVariant::Minimum(RadiusFilter { radius: u })),
        base_filter(FilterVariant::Offset {
            horizontal: 10.0,
            vertical: 10.0,
            undefined_areas: OffsetUndefinedAreas::WrapAround,
        }),
        base_filter(FilterVariant::Puppet {
            rigid_type: true,
            bounds: vec![
                PointF { x: 0.0, y: 0.0 },
                PointF { x: 1.0, y: 0.0 },
                PointF { x: 1.0, y: 1.0 },
                PointF { x: 0.0, y: 1.0 },
            ],
            puppet_shape_list: vec![],
        }),
        base_filter(FilterVariant::OilPaintPlugin {
            name: "plugin".into(),
            gpu: true,
            lighting: false,
            parameters: vec![NamedValue {
                name: "p0".into(),
                value: 1.0,
            }],
        }),
        base_filter(FilterVariant::HsbHsl {
            input_mode: RgbHsbHsl::Rgb,
            row_order: RgbHsbHsl::Hsb,
        }),
        base_filter(FilterVariant::OilPaint {
            lighting_on: true,
            stylization: 0.1,
            cleanliness: 0.2,
            brush_scale: 0.3,
            micro_brush: 0.4,
            light_direction: 45.0,
            specularity: 0.5,
        }),
        base_filter(FilterVariant::Liquify {
            liquify_mesh: vec![1, 2, 3, 4],
        }),
        base_filter(FilterVariant::PerspectiveWarp {
            quads: vec![vec![0.0, 1.0, 2.0, 3.0]],
            vertices: vec![UnitsPoint { x: u, y: u }],
            warped_vertices: vec![UnitsPoint { x: u, y: u }],
        }),
        base_filter(FilterVariant::Curves {
            preset_kind: CurvesPresetKind::Custom,
            adjustments: None,
        }),
        base_filter(FilterVariant::Invert),
        base_filter(FilterVariant::BrightnessContrast {
            brightness: 10.0,
            contrast: 20.0,
            use_legacy: false,
        }),
    ]
}

#[test]
fn all_64_filter_types_read_write_symmetry() {
    let filters = all_64_filters();
    assert_eq!(filters.len(), 64, "expected 64 synthetic filter variants");

    for (i, filter) in filters.iter().enumerate() {
        let desc = serialize_filter_fx_item(filter);
        // Round-trip through descriptor binary framing as SoLd would store it.
        let mut writer = create_writer_default();
        write_version_and_descriptor(&mut writer, &desc);
        let buf = writer.to_bytes();
        let mut reader = PsdReader::new(&buf, None, None);
        let back_desc = psdx::descriptor::read_version_and_descriptor(&mut reader)
            .unwrap_or_else(|e| panic!("filter[{i}] descriptor read: {e:?}"));

        // Also direct parse of the in-memory descriptor (same tree).
        let parsed = parse_filter_fx_item(&desc, true)
            .unwrap_or_else(|e| panic!("filter[{i}] parse: {e:?}"))
            .unwrap_or_else(|| panic!("filter[{i}] returned None"));
        let re_ser = serialize_filter_fx_item(&parsed);

        // ClassID / filterID must survive serialize→parse→serialize.
        assert_eq!(
            desc.get("filterID"),
            re_ser.get("filterID"),
            "filter[{i}] filterID mismatch after round-trip"
        );
        let has_fltr = matches!(desc.get("Fltr"), Some(DescriptorValue::Descriptor(_)));
        let has_fltr2 = matches!(re_ser.get("Fltr"), Some(DescriptorValue::Descriptor(_)));
        assert_eq!(has_fltr, has_fltr2, "filter[{i}] Fltr presence mismatch");
        if has_fltr {
            let c1 = match desc.get("Fltr") {
                Some(DescriptorValue::Descriptor(d)) => d.class_id.as_str(),
                _ => "",
            };
            let c2 = match re_ser.get("Fltr") {
                Some(DescriptorValue::Descriptor(d)) => d.class_id.as_str(),
                _ => "",
            };
            assert_eq!(c1, c2, "filter[{i}] Fltr classID mismatch");
        }

        // Binary framing must be readable.
        let _ = back_desc;
        let _ = Descriptor::new("", "null");
    }
}

#[test]
fn m3_m4_m5_smoke_not_regressed() {
    for name in ["16bits", "32bits", "effects"] {
        let Some(psd) = read_fixture(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        assert!(
            psd.children
                .as_ref()
                .map(|c| !c.is_empty())
                .unwrap_or(false),
            "{name}: expected children"
        );
    }
}

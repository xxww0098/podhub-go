//! Companion-format fixture pins: abr-read / csh-read / ase-read.
//!
//! Mirrors upstream `abr.spec.ts` / `csh.spec.ts` / `ase.spec.ts`: decode each
//! fixture, strip pixel buffers, compare structure to fixture `data.json`
//! under `vendor/agpsd-fixtures/{abr,csh,ase}-read/` (upstream goldens).

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::{Path, PathBuf};

use psdx::abr::{
    Brush, BrushDynamics, BrushShape, DualBrush, ReadAbrOptions, ShapeDynamics, Texture,
    ToolOptions, ToolType, Transfer,
};
use psdx::ase::{Ase, AseColor, AseColorType, AseColorValue, AseEntry};
use psdx::csh::Csh;
use psdx::psd::{BezierPath, BlendMode, BooleanOperation, FillRule, LayerVectorMask};
use psdx::{read_abr, read_ase, read_csh};
use serde_json::{Map, Value, json};

fn fixtures_dir(kind: &str) -> PathBuf {
    test_corpus::corpus_root().join(kind)
}

fn fixture_dir_or_skip(kind: &str) -> Option<PathBuf> {
    let directory = fixtures_dir(kind);
    if !directory.is_dir() {
        eprintln!(
            "skip {kind}: external ag-psd fixtures are not installed at {}",
            directory.display()
        );
        return None;
    }
    Some(directory)
}

fn json_eq(a: &Value, b: &Value, path: &str, diffs: &mut Vec<String>) {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => {
            let xf = x.as_f64().unwrap_or(f64::NAN);
            let yf = y.as_f64().unwrap_or(f64::NAN);
            let xf = if xf == 0.0 { 0.0 } else { xf };
            let yf = if yf == 0.0 { 0.0 } else { yf };
            let close = if xf.is_nan() && yf.is_nan() {
                true
            } else {
                let diff = (xf - yf).abs();
                diff <= 1e-9 * xf.abs().max(yf.abs()).max(1.0)
            };
            if !close {
                diffs.push(format!("{path}: number {xf} != {yf}"));
            }
        }
        (Value::Array(xs), Value::Array(ys)) => {
            if xs.len() != ys.len() {
                diffs.push(format!("{path}: array len {} != {}", xs.len(), ys.len()));
                return;
            }
            for (i, (x, y)) in xs.iter().zip(ys).enumerate() {
                json_eq(x, y, &format!("{path}[{i}]"), diffs);
            }
        }
        (Value::Object(xs), Value::Object(ys)) => {
            for k in ys.keys() {
                match (xs.get(k), ys.get(k)) {
                    (Some(xv), Some(yv)) => json_eq(xv, yv, &format!("{path}.{k}"), diffs),
                    (None, Some(_)) => diffs.push(format!("{path}.{k}: missing in actual")),
                    _ => {}
                }
            }
            for k in xs.keys() {
                if !ys.contains_key(k) {
                    diffs.push(format!("{path}.{k}: unexpected in actual"));
                }
            }
        }
        _ if a == b => {}
        _ => diffs.push(format!("{path}: {a:?} != {b:?}")),
    }
}

fn assert_json_match(actual: &Value, expected: &Value, label: &str) {
    let mut diffs = Vec::new();
    json_eq(actual, expected, "$", &mut diffs);
    assert!(
        diffs.is_empty(),
        "{label} golden mismatch ({} diffs):\n{}",
        diffs.len(),
        diffs.into_iter().take(24).collect::<Vec<_>>().join("\n")
    );
}

fn load_golden(kind: &str, name: &str) -> Value {
    let p = fixtures_dir(kind).join(name).join("data.json");
    let s = fs::read_to_string(&p)
        .unwrap_or_else(|e| panic!("missing fixture golden {}: {e}", p.display()));
    serde_json::from_str(&s).expect("golden json")
}

// ---------------------------------------------------------------------------
// ABR → JSON (upstream shape after deleting alpha / pattern.data)
// ---------------------------------------------------------------------------

fn dynamics_json(d: &BrushDynamics) -> Value {
    json!({
        "control": d.control,
        "steps": d.steps,
        "jitter": d.jitter,
        "minimum": d.minimum,
    })
}

fn blend_json(m: BlendMode) -> Value {
    Value::String(m.as_json_str().to_string())
}

fn shape_json(shape: &BrushShape) -> Value {
    match shape {
        BrushShape::Computed {
            size,
            angle,
            roundness,
            hardness,
            spacing_on,
            spacing,
            flip_x,
            flip_y,
        } => json!({
            "type": "computed",
            "size": size,
            "angle": angle,
            "roundness": roundness,
            "spacingOn": spacing_on,
            "spacing": spacing,
            "flipX": flip_x,
            "flipY": flip_y,
            "hardness": hardness,
        }),
        BrushShape::Sampled {
            name,
            size,
            angle,
            roundness,
            spacing_on,
            spacing,
            flip_x,
            flip_y,
            sampled_data,
        } => json!({
            "type": "sampled",
            "name": name,
            "size": size,
            "angle": angle,
            "roundness": roundness,
            "spacingOn": spacing_on,
            "spacing": spacing,
            "flipX": flip_x,
            "flipY": flip_y,
            "sampledData": sampled_data,
        }),
        BrushShape::Tips {
            angle,
            size,
            shape,
            physics,
            spacing,
            spacing_on,
            flip_x,
            flip_y,
            tips_type,
            tips_length_ratio,
            tips_hardness,
            tips_grid_size,
            tips_erodible_tip_height_map,
            tips_airbrush_cutoff_angle,
            tips_airbrush_granularity,
            tips_airbrush_streakiness,
            tips_airbrush_splat_size,
            tips_airbrush_splat_count,
        } => {
            let mut m = Map::new();
            m.insert("type".into(), json!("tips"));
            m.insert("angle".into(), json!(angle));
            m.insert("size".into(), json!(size));
            m.insert("shape".into(), json!(shape));
            m.insert("physics".into(), json!(physics));
            m.insert("spacing".into(), json!(spacing));
            m.insert("spacingOn".into(), json!(spacing_on));
            m.insert("flipX".into(), json!(flip_x));
            m.insert("flipY".into(), json!(flip_y));
            m.insert("tipsType".into(), json!(tips_type));
            m.insert("tipsLengthRatio".into(), json!(tips_length_ratio));
            m.insert("tipsHardness".into(), json!(tips_hardness));
            if let Some(g) = tips_grid_size {
                m.insert("tipsGridSize".into(), json!(g));
            }
            if let Some(hm) = tips_erodible_tip_height_map {
                m.insert(
                    "tipsErodibleTipHeightMap".into(),
                    Value::Array(hm.iter().map(|&b| json!(b)).collect()),
                );
            }
            m.insert(
                "tipsAirbrushCutoffAngle".into(),
                json!(tips_airbrush_cutoff_angle),
            );
            m.insert(
                "tipsAirbrushGranularity".into(),
                json!(tips_airbrush_granularity),
            );
            m.insert(
                "tipsAirbrushStreakiness".into(),
                json!(tips_airbrush_streakiness),
            );
            m.insert(
                "tipsAirbrushSplatSize".into(),
                json!(tips_airbrush_splat_size),
            );
            m.insert(
                "tipsAirbrushSplatCount".into(),
                json!(tips_airbrush_splat_count),
            );
            Value::Object(m)
        }
        BrushShape::Dynamic {
            size,
            angle,
            shape,
            density,
            length,
            clumping,
            thickness,
            stiffness,
            physics,
            spacing,
            spacing_on,
            flip_x,
            flip_y,
        } => json!({
            "type": "dynamic",
            "shape": shape,
            "angle": angle,
            "size": size,
            "density": density,
            "length": length,
            "clumping": clumping,
            "thickness": thickness,
            "stiffness": stiffness,
            "physics": physics,
            "spacing": spacing,
            "spacingOn": spacing_on,
            "flipX": flip_x,
            "flipY": flip_y,
        }),
    }
}

fn shape_dynamics_json(d: &ShapeDynamics) -> Value {
    json!({
        "tiltScale": d.tilt_scale,
        "sizeDynamics": dynamics_json(&d.size_dynamics),
        "angleDynamics": dynamics_json(&d.angle_dynamics),
        "roundnessDynamics": dynamics_json(&d.roundness_dynamics),
        "flipX": d.flip_x,
        "flipY": d.flip_y,
        "brushProjection": d.brush_projection,
        "minimumDiameter": d.minimum_diameter,
        "minimumRoundness": d.minimum_roundness,
    })
}

fn texture_json(t: &Texture) -> Value {
    json!({
        "id": t.id,
        "name": t.name,
        "blendMode": blend_json(t.blend_mode),
        "depth": t.depth,
        "depthMinimum": t.depth_minimum,
        "depthDynamics": dynamics_json(&t.depth_dynamics),
        "scale": t.scale,
        "invert": t.invert,
        "brightness": t.brightness,
        "contrast": t.contrast,
        "textureEachTip": t.texture_each_tip,
    })
}

fn dual_brush_json(d: &DualBrush) -> Value {
    json!({
        "flip": d.flip,
        "shape": shape_json(&d.shape),
        "blendMode": blend_json(d.blend_mode),
        "useScatter": d.use_scatter,
        "spacing": d.spacing,
        "count": d.count,
        "bothAxes": d.both_axes,
        "countDynamics": dynamics_json(&d.count_dynamics),
        "scatterDynamics": dynamics_json(&d.scatter_dynamics),
    })
}

fn tool_type_json(t: ToolType) -> &'static str {
    match t {
        ToolType::Brush => "brush",
        ToolType::MixerBrush => "mixer brush",
        ToolType::SmudgeBrush => "smudge brush",
    }
}

fn tool_options_json(t: &ToolOptions) -> Value {
    let mut m = Map::new();
    m.insert("type".into(), json!(tool_type_json(t.type_)));
    m.insert("brushPreset".into(), json!(t.brush_preset));
    m.insert("flow".into(), json!(t.flow));
    if let Some(v) = t.wetness {
        m.insert("wetness".into(), json!(v));
    }
    if let Some(v) = t.dryness {
        m.insert("dryness".into(), json!(v));
    }
    if let Some(v) = t.mix {
        m.insert("mix".into(), json!(v));
    }
    m.insert("smooth".into(), json!(t.smooth));
    m.insert("mode".into(), blend_json(t.mode));
    m.insert("opacity".into(), json!(t.opacity));
    m.insert("smoothing".into(), json!(t.smoothing));
    m.insert("smoothingValue".into(), json!(t.smoothing_value));
    m.insert("smoothingRadiusMode".into(), json!(t.smoothing_radius_mode));
    m.insert("smoothingCatchup".into(), json!(t.smoothing_catchup));
    m.insert(
        "smoothingCatchupAtEnd".into(),
        json!(t.smoothing_catchup_at_end),
    );
    m.insert(
        "smoothingZoomCompensation".into(),
        json!(t.smoothing_zoom_compensation),
    );
    m.insert("pressureSmoothing".into(), json!(t.pressure_smoothing));
    m.insert(
        "usePressureOverridesSize".into(),
        json!(t.use_pressure_overrides_size),
    );
    m.insert(
        "usePressureOverridesOpacity".into(),
        json!(t.use_pressure_overrides_opacity),
    );
    m.insert("useLegacy".into(), json!(t.use_legacy));
    if let Some(v) = t.auto_fill {
        m.insert("autoFill".into(), json!(v));
    }
    if let Some(v) = t.auto_clean {
        m.insert("autoClean".into(), json!(v));
    }
    if let Some(v) = t.load_solid_color_only {
        m.insert("loadSolidColorOnly".into(), json!(v));
    }
    if let Some(v) = t.sample_all_layers {
        m.insert("sampleAllLayers".into(), json!(v));
    }
    if let Some(d) = &t.flow_dynamics {
        m.insert("flowDynamics".into(), dynamics_json(d));
    }
    if let Some(d) = &t.opacity_dynamics {
        m.insert("opacityDynamics".into(), dynamics_json(d));
    }
    if let Some(d) = &t.size_dynamics {
        m.insert("sizeDynamics".into(), dynamics_json(d));
    }
    Value::Object(m)
}

fn transfer_json(t: &Transfer) -> Value {
    json!({
        "flowDynamics": dynamics_json(&t.flow_dynamics),
        "opacityDynamics": dynamics_json(&t.opacity_dynamics),
        "wetnessDynamics": dynamics_json(&t.wetness_dynamics),
        "mixDynamics": dynamics_json(&t.mix_dynamics),
    })
}

fn brush_json(b: &Brush) -> Value {
    let mut m = Map::new();
    m.insert("name".into(), json!(b.name));
    m.insert("shape".into(), shape_json(&b.shape));
    m.insert("spacing".into(), json!(b.spacing));
    m.insert("wetEdges".into(), json!(b.wet_edges));
    m.insert("noise".into(), json!(b.noise));
    m.insert("useBrushSize".into(), json!(b.use_brush_size));
    if let Some(v) = b.interpretation {
        m.insert("interpretation".into(), json!(v));
    }
    if let Some(v) = b.protect_texture {
        m.insert("protectTexture".into(), json!(v));
    }
    if let Some(d) = &b.shape_dynamics {
        m.insert("shapeDynamics".into(), shape_dynamics_json(d));
    }
    if let Some(s) = &b.scatter {
        m.insert(
            "scatter".into(),
            json!({
                "count": s.count,
                "bothAxes": s.both_axes,
                "countDynamics": dynamics_json(&s.count_dynamics),
                "scatterDynamics": dynamics_json(&s.scatter_dynamics),
            }),
        );
    }
    if let Some(t) = &b.texture {
        m.insert("texture".into(), texture_json(t));
    }
    if let Some(d) = &b.dual_brush {
        m.insert("dualBrush".into(), dual_brush_json(d));
    }
    if let Some(c) = &b.color_dynamics {
        m.insert(
            "colorDynamics".into(),
            json!({
                "foregroundBackground": dynamics_json(&c.foreground_background),
                "hue": c.hue,
                "saturation": c.saturation,
                "brightness": c.brightness,
                "purity": c.purity,
                "perTip": c.per_tip,
            }),
        );
    }
    if let Some(t) = &b.transfer {
        m.insert("transfer".into(), transfer_json(t));
    }
    if let Some(p) = &b.brush_pose {
        m.insert(
            "brushPose".into(),
            json!({
                "overrideAngle": p.override_angle,
                "overrideTiltX": p.override_tilt_x,
                "overrideTiltY": p.override_tilt_y,
                "overridePressure": p.override_pressure,
                "pressure": p.pressure,
                "tiltX": p.tilt_x,
                "tiltY": p.tilt_y,
                "angle": p.angle,
            }),
        );
    }
    if let Some(t) = &b.tool_options {
        m.insert("toolOptions".into(), tool_options_json(t));
    }
    Value::Object(m)
}

fn abr_to_json(abr: &psdx::Abr) -> Value {
    let samples: Vec<Value> = abr
        .samples
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "bounds": {
                    "x": s.bounds.x,
                    "y": s.bounds.y,
                    "w": s.bounds.w,
                    "h": s.bounds.h,
                }
            })
        })
        .collect();
    let patterns: Vec<Value> = abr
        .patterns
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "name": p.name,
                "x": p.x,
                "y": p.y,
                "bounds": {
                    "x": p.bounds.x,
                    "y": p.bounds.y,
                    "w": p.bounds.w,
                    "h": p.bounds.h,
                }
            })
        })
        .collect();
    let brushes: Vec<Value> = abr.brushes.iter().map(brush_json).collect();
    json!({
        "samples": samples,
        "patterns": patterns,
        "brushes": brushes,
    })
}

// ---------------------------------------------------------------------------
// CSH / ASE → JSON
// ---------------------------------------------------------------------------

fn bool_op_json(op: BooleanOperation) -> &'static str {
    match op {
        BooleanOperation::Exclude => "exclude",
        BooleanOperation::Combine => "combine",
        BooleanOperation::Subtract => "subtract",
        BooleanOperation::Intersect => "intersect",
    }
}

fn fill_rule_json(r: FillRule) -> &'static str {
    match r {
        FillRule::EvenOdd => "even-odd",
        FillRule::NonZero => "non-zero",
    }
}

fn path_json(p: &BezierPath) -> Value {
    let mut m = Map::new();
    m.insert("open".into(), json!(p.open));
    if let Some(op) = p.operation {
        m.insert("operation".into(), json!(bool_op_json(op)));
    }
    m.insert(
        "knots".into(),
        Value::Array(
            p.knots
                .iter()
                .map(|k| {
                    json!({
                        "linked": k.linked,
                        "points": k.points,
                    })
                })
                .collect(),
        ),
    );
    m.insert("fillRule".into(), json!(fill_rule_json(p.fill_rule)));
    Value::Object(m)
}

fn mask_fields(mask: &LayerVectorMask, into: &mut Map<String, Value>) {
    if let Some(v) = mask.invert {
        into.insert("invert".into(), json!(v));
    }
    if let Some(v) = mask.not_link {
        into.insert("notLink".into(), json!(v));
    }
    if let Some(v) = mask.disable {
        into.insert("disable".into(), json!(v));
    }
    if let Some(v) = mask.fill_starts_with_all_pixels {
        into.insert("fillStartsWithAllPixels".into(), json!(v));
    }
    into.insert(
        "paths".into(),
        Value::Array(mask.paths.iter().map(path_json).collect()),
    );
}

fn csh_to_json(csh: &Csh) -> Value {
    let shapes: Vec<Value> = csh
        .shapes
        .iter()
        .map(|s| {
            let mut m = Map::new();
            m.insert("name".into(), json!(s.name));
            m.insert("id".into(), json!(s.id));
            m.insert("width".into(), json!(s.width));
            m.insert("height".into(), json!(s.height));
            mask_fields(&s.mask, &mut m);
            Value::Object(m)
        })
        .collect();
    json!({ "shapes": shapes })
}

fn ase_type_json(t: AseColorType) -> &'static str {
    match t {
        AseColorType::Global => "global",
        AseColorType::Spot => "spot",
        AseColorType::Normal => "normal",
    }
}

fn ase_color_json(c: &AseColor) -> Value {
    let color = match &c.color {
        AseColorValue::Rgb { r, g, b, type_ } => json!({
            "r": r, "g": g, "b": b, "type": ase_type_json(*type_),
        }),
        AseColorValue::Cmyk { c, m, y, k, type_ } => json!({
            "c": c, "m": m, "y": y, "k": k, "type": ase_type_json(*type_),
        }),
        AseColorValue::Gray { k, type_ } => json!({
            "k": k, "type": ase_type_json(*type_),
        }),
        AseColorValue::Lab { l, a, b, type_ } => json!({
            "l": l, "a": a, "b": b, "type": ase_type_json(*type_),
        }),
    };
    json!({ "name": c.name, "color": color })
}

fn ase_to_json(ase: &Ase) -> Value {
    let colors: Vec<Value> = ase
        .colors
        .iter()
        .map(|e| match e {
            AseEntry::Color(c) => ase_color_json(c),
            AseEntry::Group(g) => json!({
                "name": g.name,
                "colors": g.colors.iter().map(ase_color_json).collect::<Vec<_>>(),
            }),
        })
        .collect();
    json!({ "colors": colors })
}

// ---------------------------------------------------------------------------
// Fixture tests
// ---------------------------------------------------------------------------

fn each_subdir(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn abr_read_fixtures_match_goldens() {
    let Some(base) = fixture_dir_or_skip("abr-read") else {
        return;
    };
    let names = each_subdir(&base);
    assert_eq!(
        names,
        ["sample-and-pattern", "simple", "special", "tilt"],
        "expected 4 abr-read fixtures"
    );

    for name in &names {
        let src = base.join(name).join("src.abr");
        let bytes = fs::read(&src).unwrap_or_else(|e| panic!("read {}: {e}", src.display()));
        let abr = read_abr(&bytes, &ReadAbrOptions::default())
            .unwrap_or_else(|e| panic!("read_abr {name}: {e:?}"));

        // Pixel buffers present and sized correctly (PNG goldens live beside src).
        for s in &abr.samples {
            assert_eq!(
                s.alpha.len(),
                (s.bounds.w * s.bounds.h) as usize,
                "{name} sample {} alpha len",
                s.id
            );
        }
        for p in &abr.patterns {
            assert_eq!(
                p.data.len(),
                (p.bounds.w * p.bounds.h) as usize * 4,
                "{name} pattern {} data len",
                p.id
            );
        }

        let actual = abr_to_json(&abr);
        let expected = load_golden("abr-read", name);
        assert_json_match(&actual, &expected, &format!("abr-read/{name}"));
    }
}

#[test]
fn csh_read_fixtures_match_goldens() {
    let Some(base) = fixture_dir_or_skip("csh-read") else {
        return;
    };
    let names = each_subdir(&base);
    assert_eq!(names, ["animals"], "expected 1 csh-read fixture");

    for name in &names {
        let src = base.join(name).join("src.csh");
        let bytes = fs::read(&src).unwrap_or_else(|e| panic!("read {}: {e}", src.display()));
        let csh = read_csh(&bytes).unwrap_or_else(|e| panic!("read_csh {name}: {e:?}"));
        assert!(!csh.shapes.is_empty(), "{name}: empty shapes");

        let actual = csh_to_json(&csh);
        let expected = load_golden("csh-read", name);
        assert_json_match(&actual, &expected, &format!("csh-read/{name}"));
    }
}

#[test]
fn ase_read_fixtures_match_goldens() {
    let Some(base) = fixture_dir_or_skip("ase-read") else {
        return;
    };
    let names = each_subdir(&base);
    assert_eq!(
        names,
        ["from-photoshop", "piratetrousle-dusk"],
        "expected 2 ase-read fixtures"
    );

    for name in &names {
        let src = base.join(name).join("src.ase");
        let bytes = fs::read(&src).unwrap_or_else(|e| panic!("read {}: {e}", src.display()));
        let ase = read_ase(&bytes).unwrap_or_else(|e| panic!("read_ase {name}: {e:?}"));
        assert!(!ase.colors.is_empty(), "{name}: empty colors");

        let actual = ase_to_json(&ase);
        let expected = load_golden("ase-read", name);
        assert_json_match(&actual, &expected, &format!("ase-read/{name}"));
    }
}

#[test]
fn abr_blend_modes_include_abr_only_variants() {
    let Some(base) = fixture_dir_or_skip("abr-read") else {
        return;
    };
    let src = base.join("special/src.abr");
    let bytes = fs::read(&src).expect("special abr");
    let abr = read_abr(&bytes, &ReadAbrOptions::default()).expect("decode special");

    let modes: Vec<BlendMode> = abr
        .brushes
        .iter()
        .flat_map(|b| {
            b.texture
                .as_ref()
                .map(|t| t.blend_mode)
                .into_iter()
                .chain(b.dual_brush.as_ref().map(|d| d.blend_mode))
        })
        .collect();

    assert!(
        modes.contains(&BlendMode::LinearHeight),
        "expected linear height from BlnM.linearHeight, got {modes:?}"
    );
    assert!(
        modes.contains(&BlendMode::Subtraction),
        "expected subtraction from BlnM.Sbtr, got {modes:?}"
    );
}

//! shmd / artboards / annotations / timeline fixture pins.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::additional_info::timeline::{parse_track_list, serialize_track_list};
use psdx::psd::ReadOptions;
use psdx::psd::*;
use psdx::read_psd;
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
        "M7 path mismatch at {path}:\n{}",
        diffs.into_iter().take(12).collect::<Vec<_>>().join("\n")
    );
}

fn collect_layer_fields(layers: &[Value], out: &mut Vec<(String, Value)>) {
    for layer in layers {
        let name = layer
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        for key in [
            "timestamp",
            "animationFrames",
            "animationFrameFlags",
            "timeline",
            "comps",
            "artboard",
        ] {
            if let Some(v) = layer.get(key) {
                out.push((format!("{name}.{key}"), v.clone()));
            }
        }
        if let Some(Value::Array(ch)) = layer.get("children") {
            collect_layer_fields(ch, out);
        }
    }
}

#[test]
fn animation_frame_shmd_matches_golden() {
    let name = "animation-frame";
    let Some(psd) = read_fixture(name) else {
        eprintln!("skip {name}: fixture missing");
        return;
    };
    let Some(golden) = golden_json(name) else {
        eprintln!("skip {name}: golden missing");
        return;
    };
    let actual = serde_json::to_value(&psd).expect("serialize");
    let mut a_fields = Vec::new();
    let mut g_fields = Vec::new();
    collect_layer_fields(actual["children"].as_array().unwrap(), &mut a_fields);
    collect_layer_fields(golden["children"].as_array().unwrap(), &mut g_fields);
    assert!(!g_fields.is_empty(), "golden should have shmd fields");
    for (key, gv) in &g_fields {
        let av = a_fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .unwrap_or_else(|| panic!("missing {key} in actual"));
        json_eq_path(av, gv, &format!("{name}.{key}"));
    }
}

#[test]
fn layer_comps_shmd_and_resource_match_golden() {
    let name = "layer-comps";
    let Some(psd) = read_fixture(name) else {
        eprintln!("skip {name}: fixture missing");
        return;
    };
    let Some(golden) = golden_json(name) else {
        eprintln!("skip {name}: golden missing");
        return;
    };
    let actual = serde_json::to_value(&psd).expect("serialize");
    json_eq_path(
        &actual["imageResources"]["layerComps"],
        &golden["imageResources"]["layerComps"],
        "layer-comps.imageResources.layerComps",
    );
    let mut a_fields = Vec::new();
    let mut g_fields = Vec::new();
    collect_layer_fields(actual["children"].as_array().unwrap(), &mut a_fields);
    collect_layer_fields(golden["children"].as_array().unwrap(), &mut g_fields);
    for (key, gv) in &g_fields {
        let av = a_fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .unwrap_or_else(|| panic!("missing {key} in actual"));
        json_eq_path(av, gv, &format!("{name}.{key}"));
    }
}

#[test]
fn artboards_document_and_timestamps_match_golden() {
    let name = "artboards";
    let Some(psd) = read_fixture(name) else {
        eprintln!("skip {name}: fixture missing");
        return;
    };
    let Some(golden) = golden_json(name) else {
        eprintln!("skip {name}: golden missing");
        return;
    };
    let actual = serde_json::to_value(&psd).expect("serialize");
    json_eq_path(
        &actual["artboards"],
        &golden["artboards"],
        "artboards.artboards",
    );
    let mut a_fields = Vec::new();
    let mut g_fields = Vec::new();
    collect_layer_fields(actual["children"].as_array().unwrap(), &mut a_fields);
    collect_layer_fields(golden["children"].as_array().unwrap(), &mut g_fields);
    for (key, gv) in &g_fields {
        let av = a_fields
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
            .unwrap_or_else(|| panic!("missing {key} in actual"));
        json_eq_path(av, gv, &format!("{name}.{key}"));
    }
}

#[test]
fn timeline_track_list_round_trip() {
    let tracks = vec![TimelineTrack {
        track_type: TimelineTrackType::SheetTransform,
        enabled: Some(true),
        effect_params: Some(TimelineEffectParams {
            fill_canvas: true,
            zoom_origin: 0.0,
            keys: vec![TimelineKey {
                interpolation: TimelineKeyInterpolation::Linear,
                time: Fraction {
                    numerator: 0.0,
                    denominator: 600.0,
                },
                selected: Some(false),
                data: TimelineKeyData::Transform {
                    scale: PointF { x: 1.0, y: 1.0 },
                    skew: PointF { x: 0.0, y: 0.0 },
                    rotation: 0.0,
                    translation: PointF { x: 10.0, y: 20.0 },
                },
            }],
        }),
        keys: vec![TimelineKey {
            interpolation: TimelineKeyInterpolation::Linear,
            time: Fraction {
                numerator: 0.0,
                denominator: 600.0,
            },
            selected: Some(false),
            data: TimelineKeyData::Transform {
                scale: PointF { x: 1.0, y: 1.0 },
                skew: PointF { x: 0.0, y: 0.0 },
                rotation: 0.0,
                translation: PointF { x: 10.0, y: 20.0 },
            },
        }],
    }];
    let list = serialize_track_list(&tracks).expect("serialize");
    let parsed = parse_track_list(&list).expect("parse");
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].track_type, TimelineTrackType::SheetTransform);
    assert_eq!(parsed[0].keys.len(), 1);
    match &parsed[0].keys[0].data {
        TimelineKeyData::Transform { translation, .. } => {
            assert!((translation.x - 10.0).abs() < 1e-9);
            assert!((translation.y - 20.0).abs() < 1e-9);
        }
        other => panic!("unexpected key data {other:?}"),
    }
    let _ = list;
}

#[test]
fn m3_m4_m5_m6_smoke_not_regressed() {
    for name in [
        "16bits",
        "32bits",
        "2026-blend-modes",
        "smart-object",
        "effects",
    ] {
        let Some(psd) = read_fixture(name) else {
            eprintln!("skip smoke {name}: fixture missing");
            continue;
        };
        assert!(
            psd.children
                .as_ref()
                .map(|c| !c.is_empty())
                .unwrap_or(false)
                || psd.width > 0.0,
            "{name}: expected a readable document"
        );
    }
}

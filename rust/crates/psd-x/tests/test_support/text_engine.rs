//! Text-engine EngineData fixes + text-* golden pins.
//!
//! Four fixtures use psdx-blessed structure goldens (inherited font
//! resolution is default-on). The rest pin against JS-oracle `tests/goldens/read`.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::engine_data::{parse_engine_data, serialize_engine_data};
use psdx::psd::ReadOptions;
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

/// Fixtures re-blessed for default-on font resolution (see `tests/goldens/psdx-blessed/read/*/REVIEW.md`).
const FONT_RESOLUTION_BLESSED: &[&str] =
    &["text-complex", "text-layer", "text-simple", "text-simple2"];

fn oracle_golden_json(name: &str) -> Option<Value> {
    let p = test_corpus::golden_root()
        .join("read")
        .join(name)
        .join("psd.json");
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn blessed_golden_json(name: &str) -> Option<Value> {
    let p = test_corpus::golden_root()
        .join("psdx-blessed/read")
        .join(name)
        .join("psd.json");
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn golden_json(name: &str) -> Option<Value> {
    if FONT_RESOLUTION_BLESSED.contains(&name) {
        blessed_golden_json(name).or_else(|| oracle_golden_json(name))
    } else {
        oracle_golden_json(name)
    }
}

fn clean_for_json(v: &mut Value) {
    let Some(obj) = v.as_object_mut() else {
        return;
    };
    obj.remove("canvas");
    obj.remove("imageData");
    obj.remove("rawCompositeData");
    if let Some(Value::Object(res)) = obj.get_mut("imageResources") {
        res.remove("xmpMetadata");
        res.remove("thumbnail");
        res.remove("thumbnailRaw");
    }
    if let Some(Value::Array(files)) = obj.get_mut("linkedFiles") {
        for f in files {
            if let Some(o) = f.as_object_mut() {
                o.remove("data");
            }
        }
    }
    fn clean_layers(layers: &mut Value) {
        let Some(arr) = layers.as_array_mut() else {
            return;
        };
        for layer in arr {
            let Some(o) = layer.as_object_mut() else {
                continue;
            };
            o.remove("canvas");
            o.remove("imageData");
            o.remove("rawData");
            if let Some(Value::Object(m)) = o.get_mut("mask") {
                m.remove("canvas");
                m.remove("imageData");
            }
            if let Some(Value::Object(m)) = o.get_mut("realMask") {
                m.remove("canvas");
                m.remove("imageData");
            }
            if let Some(ch) = o.get_mut("children") {
                clean_layers(ch);
            }
        }
    }
    if let Some(ch) = obj.get_mut("children") {
        clean_layers(ch);
    }
}

fn json_eq(a: &Value, b: &Value, path: &str, diffs: &mut Vec<String>) {
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
                json_eq(x, y, &format!("{path}[{i}]"), diffs);
            }
        }
        (Value::Object(xs), Value::Object(ys)) => {
            for k in xs.keys() {
                if !ys.contains_key(k) {
                    diffs.push(format!("{path}.{k}: missing in golden"));
                }
            }
            for k in ys.keys() {
                if !xs.contains_key(k) {
                    diffs.push(format!("{path}.{k}: missing in actual"));
                }
            }
            for (k, xv) in xs {
                if let Some(yv) = ys.get(k) {
                    json_eq(xv, yv, &format!("{path}.{k}"), diffs);
                }
            }
        }
        _ if a == b => {}
        _ => diffs.push(format!("{path}: type/value mismatch")),
    }
}

fn assert_fixture_matches_golden(name: &str) {
    let Some(src) = fixture_psd(name) else {
        eprintln!("skip {name}: fixture missing");
        return;
    };
    let Some(expected) = golden_json(name) else {
        eprintln!("skip {name}: golden missing");
        return;
    };
    let bytes = fs::read(src).expect("read fixture");
    let opts = ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        ..ReadOptions::default()
    };
    let psd = read_psd(&bytes, &opts).expect("read_psd");
    let mut actual = serde_json::to_value(&psd).expect("serialize");
    clean_for_json(&mut actual);
    let mut diffs = Vec::new();
    json_eq(&actual, &expected, "$", &mut diffs);
    assert!(
        diffs.is_empty(),
        "{name}: {} diffs; e.g. {}",
        diffs.len(),
        diffs
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>()
            .join(" | ")
    );
}

#[test]
fn text_fixtures_match_goldens() {
    for name in [
        "text-alternatives",
        "text-bug",
        "text-carriage-return",
        "text-complex",
        "text-layer",
        "text-paragraph-align",
        "text-path",
        "text-simple",
        "text-simple2",
    ] {
        assert_fixture_matches_golden(name);
    }
}

/// Byte-exact serialize after parse (preserves EngineData key insertion order).
/// Note: serializing from `engineData.json` via `serde_json` is not comparable
/// unless `preserve_order` is on — dict key order would diverge from the bin.
#[test]
fn engine_data_serialize_matches_upstream_bin() {
    let bin_path = test_corpus::corpus_root().join("engineData.bin");
    if !bin_path.is_file() {
        eprintln!("skip engine_data serialize: fixture missing");
        return;
    }
    let expected = fs::read(bin_path).unwrap();
    let parsed = parse_engine_data(&expected).expect("parse");
    let actual = serialize_engine_data(&parsed, false);
    assert_eq!(
        actual,
        expected,
        "parse→serialize must match engineData.bin (len {} vs {})",
        actual.len(),
        expected.len()
    );
}

#[test]
fn m3_m7_smoke_not_regressed() {
    for name in [
        "16bits",
        "32bits",
        "2026-blend-modes",
        "smart-object",
        "effects",
        "artboards",
        "animation-frame",
        "layer-comps",
    ] {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip smoke {name}: fixture missing");
            continue;
        };
        let bytes = fs::read(src).unwrap();
        let opts = ReadOptions {
            use_image_data: Some(true),
            skip_thumbnail: Some(true),
            ..ReadOptions::default()
        };
        let psd = read_psd(&bytes, &opts).unwrap_or_else(|e| panic!("{name}: {e:?}"));
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

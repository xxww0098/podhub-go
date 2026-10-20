//! Inherited font resolution (`ReadOptions::resolve_inherited_fonts`).
//!
//! Default-on: Regular style-sheet font fills missing per-run fonts.
//! `Some(false)` is the upstream-oracle escape hatch. Four text fixtures use
//! psdx-blessed goldens; the rest still pin JS-oracle `tests/goldens/read`.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::engine_data::{EngineValue, parse_engine_data, serialize_engine_data};
use psdx::psd::{Layer, ReadOptions, TextStyle, WriteOptions};
use psdx::text::{decode_engine_data_with_options, encode_engine_data};
use psdx::{read_psd, write_psd};
use serde_json::Value;

/// Fixtures re-blessed for default-on font resolution.
const FONT_RESOLUTION_BLESSED: &[&str] =
    &["text-complex", "text-layer", "text-simple", "text-simple2"];

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

fn read_opts(resolve_inherited_fonts: Option<bool>) -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        resolve_inherited_fonts,
        ..ReadOptions::default()
    }
}

fn golden_json(name: &str) -> Option<Value> {
    let root = if FONT_RESOLUTION_BLESSED.contains(&name) {
        test_corpus::golden_root().join("psdx-blessed/read")
    } else {
        test_corpus::golden_root().join("read")
    };
    let p = root.join(name).join("psd.json");
    fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn walk_layers<'a>(layers: &'a [Layer], out: &mut Vec<&'a Layer>) {
    for layer in layers {
        out.push(layer);
        if let Some(children) = layer.children.as_ref() {
            walk_layers(children, out);
        }
    }
}

fn text_layers(psd: &psdx::psd::Psd) -> Vec<&Layer> {
    let mut all = Vec::new();
    if let Some(children) = psd.children.as_ref() {
        walk_layers(children, &mut all);
    }
    all.into_iter()
        .filter(|l| l.additional_info.text.is_some())
        .collect()
}

fn style_some_count(s: &TextStyle) -> usize {
    match serde_json::to_value(s).expect("style json") {
        Value::Object(map) => map.len(),
        _ => 0,
    }
}

fn resolved_run_fonts(text: &psdx::psd::LayerTextData) -> Vec<String> {
    let base = text
        .style
        .as_ref()
        .and_then(|s| s.font.as_ref())
        .map(|f| f.name.clone());
    match text.style_runs.as_ref() {
        None => base.into_iter().collect(),
        Some(runs) => runs
            .iter()
            .map(|r| {
                r.style
                    .font
                    .as_ref()
                    .map(|f| f.name.clone())
                    .or_else(|| base.clone())
                    .unwrap_or_else(|| "<none>".into())
            })
            .collect(),
    }
}

/// Default read (fonts resolved) must match psdx-blessed / oracle goldens.
#[test]
fn default_text_fixtures_match_goldens() {
    let names = [
        "text-alternatives",
        "text-bug",
        "text-carriage-return",
        "text-complex",
        "text-layer",
        "text-paragraph-align",
        "text-path",
        "text-simple",
        "text-simple2",
    ];
    for name in names {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let Some(expected) = golden_json(name) else {
            eprintln!("skip {name}: golden missing");
            continue;
        };
        let bytes = fs::read(src).expect("read fixture");
        let psd = read_psd(&bytes, &read_opts(None)).expect("read_psd");
        let mut actual = serde_json::to_value(&psd).expect("serialize");
        clean_for_json(&mut actual);
        let mut diffs = Vec::new();
        json_eq(&actual, &expected, "$", &mut diffs);
        assert!(
            diffs.is_empty(),
            "{name} default vs golden: {} diffs; e.g. {}",
            diffs.len(),
            diffs
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join(" | ")
        );
    }
}

/// `Some(false)` keeps matching JS-oracle goldens for all text-* fixtures.
#[test]
fn oracle_escape_hatch_text_fixtures_match_goldens() {
    let names = [
        "text-alternatives",
        "text-bug",
        "text-carriage-return",
        "text-complex",
        "text-layer",
        "text-paragraph-align",
        "text-path",
        "text-simple",
        "text-simple2",
    ];
    for name in names {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let golden_path = test_corpus::golden_root()
            .join("read")
            .join(name)
            .join("psd.json");
        if !golden_path.is_file() {
            eprintln!("skip {name}: JS oracle golden missing");
            continue;
        }
        let bytes = fs::read(src).expect("read fixture");
        let psd = read_psd(&bytes, &read_opts(Some(false))).expect("read_psd");
        let mut actual = serde_json::to_value(&psd).expect("serialize");
        clean_for_json(&mut actual);
        let expected: Value =
            serde_json::from_str(&fs::read_to_string(golden_path).unwrap()).unwrap();
        let mut diffs = Vec::new();
        json_eq(&actual, &expected, "$", &mut diffs);
        assert!(
            diffs.is_empty(),
            "{name} oracle-OFF vs JS golden: {} diffs; e.g. {}",
            diffs.len(),
            diffs
                .iter()
                .take(6)
                .cloned()
                .collect::<Vec<_>>()
                .join(" | ")
        );
    }
}

#[test]
fn default_resolves_real_fonts_on_affected_fixtures() {
    for name in ["text-layer", "text-simple", "text-simple2"] {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let psd = read_psd(&fs::read(src).unwrap(), &read_opts(None)).unwrap();
        let text = text_layers(&psd)[0].additional_info.text.as_ref().unwrap();
        let base = text
            .style
            .as_ref()
            .and_then(|s| s.font.as_ref())
            .map(|f| f.name.as_str())
            .unwrap_or("<none>");
        assert_eq!(base, "MyriadPro-Regular", "{name}");
    }

    let Some(src) = fixture_psd("text-complex") else {
        eprintln!("skip text-complex: fixture missing");
        return;
    };
    let psd = read_psd(&fs::read(src).unwrap(), &read_opts(None)).unwrap();
    let text = text_layers(&psd)[0].additional_info.text.as_ref().unwrap();
    let fonts = resolved_run_fonts(text);
    assert_eq!(
        fonts,
        vec![
            "MyriadPro-Bold",
            "MyriadPro-Bold",
            "MyriadPro-Regular",
            "MyriadPro-Regular",
            "CourierNewPSMT",
            "MyriadPro-Regular",
            "MyriadPro-Regular",
            "MyriadPro-Regular",
            "MyriadPro-Regular",
            "ArialMT",
            "MyriadPro-Regular",
        ]
    );
}

#[test]
fn default_write_keeps_real_fonts_in_font_table() {
    for name in ["text-layer", "text-simple", "text-simple2"] {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let psd = read_psd(&fs::read(src).unwrap(), &read_opts(None)).unwrap();
        let out = write_psd(&psd, &WriteOptions::default()).expect("write");
        let again = read_psd(&out, &read_opts(None)).expect("re-read");
        let font = text_layers(&again)[0]
            .additional_info
            .text
            .as_ref()
            .unwrap()
            .style
            .as_ref()
            .and_then(|s| s.font.as_ref())
            .map(|f| f.name.as_str())
            .unwrap_or("<none>");
        assert_eq!(font, "MyriadPro-Regular", "{name}: write/read font");
    }
}

#[test]
fn resolved_fonts_do_not_inflate_per_run_key_count() {
    for name in [
        "text-complex",
        "text-simple",
        "text-simple2",
        "text-layer",
        "text-alternatives",
    ] {
        let Some(src) = fixture_psd(name) else {
            eprintln!("skip {name}: fixture missing");
            continue;
        };
        let bytes = fs::read(src).unwrap();
        let off = read_psd(&bytes, &read_opts(Some(false))).unwrap();
        let on = read_psd(&bytes, &read_opts(None)).unwrap();
        let off_layers = text_layers(&off);
        let on_layers = text_layers(&on);
        assert_eq!(off_layers.len(), on_layers.len(), "{name}: layer count");
        for (a, b) in off_layers.iter().zip(on_layers.iter()) {
            let a_runs = a
                .additional_info
                .text
                .as_ref()
                .unwrap()
                .style_runs
                .as_deref()
                .unwrap_or(&[]);
            let b_runs = b
                .additional_info
                .text
                .as_ref()
                .unwrap()
                .style_runs
                .as_deref()
                .unwrap_or(&[]);
            assert_eq!(a_runs.len(), b_runs.len(), "{name}: run count");
            for (i, (ra, rb)) in a_runs.iter().zip(b_runs.iter()).enumerate() {
                assert_eq!(
                    style_some_count(&ra.style),
                    style_some_count(&rb.style),
                    "{name} run[{i}]: key count (full-field merge?)"
                );
            }
            let ba = a
                .additional_info
                .text
                .as_ref()
                .unwrap()
                .style
                .as_ref()
                .unwrap();
            let bb = b
                .additional_info
                .text
                .as_ref()
                .unwrap()
                .style
                .as_ref()
                .unwrap();
            assert_eq!(
                style_some_count(ba),
                style_some_count(bb),
                "{name}: base style key count"
            );
        }
    }
}

/// EngineData-level: missing Font on a run picks Regular sheet font, not fonts[0].
#[test]
fn decode_with_options_uses_regular_sheet_font_only() {
    fn n(x: f64) -> EngineValue {
        EngineValue::Number(x)
    }
    fn s(x: &str) -> EngineValue {
        EngineValue::Str(x.to_string())
    }
    fn d(entries: Vec<(&str, EngineValue)>) -> EngineValue {
        EngineValue::Dict(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }

    let engine = d(vec![
        (
            "EngineDict",
            d(vec![
                ("Editor", d(vec![("Text", s("Hi\r"))])),
                ("AntiAlias", n(4.0)),
                ("UseFractionalGlyphWidths", EngineValue::Bool(true)),
                (
                    "StyleRun",
                    d(vec![
                        (
                            "RunArray",
                            EngineValue::Array(vec![d(vec![(
                                "StyleSheet",
                                d(vec![("StyleSheetData", d(vec![("FontSize", n(12.0))]))]),
                            )])]),
                        ),
                        ("RunLengthArray", EngineValue::Array(vec![n(3.0)])),
                    ]),
                ),
                (
                    "ParagraphRun",
                    d(vec![
                        ("RunArray", EngineValue::Array(vec![])),
                        ("RunLengthArray", EngineValue::Array(vec![])),
                    ]),
                ),
            ]),
        ),
        (
            "ResourceDict",
            d(vec![
                ("TheNormalStyleSheet", n(0.0)),
                (
                    "StyleSheetSet",
                    EngineValue::Array(vec![d(vec![
                        ("Name", s("Normal RGB")),
                        (
                            "StyleSheetData",
                            d(vec![("Font", n(1.0)), ("FontSize", n(24.0))]),
                        ),
                    ])]),
                ),
                (
                    "FontSet",
                    EngineValue::Array(vec![
                        d(vec![
                            ("Name", s("AdobeInvisFont")),
                            ("Script", n(0.0)),
                            ("FontType", n(0.0)),
                            ("Synthetic", n(0.0)),
                        ]),
                        d(vec![
                            ("Name", s("RealFont-Regular")),
                            ("Script", n(0.0)),
                            ("FontType", n(0.0)),
                            ("Synthetic", n(0.0)),
                        ]),
                    ]),
                ),
            ]),
        ),
    ]);

    let off = decode_engine_data_with_options(&engine, false);
    let on = decode_engine_data_with_options(&engine, true);

    let off_font = off
        .style
        .as_ref()
        .and_then(|s| s.font.as_ref())
        .map(|f| f.name.as_str());
    let on_font = on
        .style
        .as_ref()
        .and_then(|s| s.font.as_ref())
        .map(|f| f.name.as_str());
    assert_eq!(off_font, Some("AdobeInvisFont"));
    assert_eq!(on_font, Some("RealFont-Regular"));

    let on_size = on.style.as_ref().and_then(|s| s.font_size).or_else(|| {
        on.style_runs
            .as_ref()
            .and_then(|r| r.first())
            .and_then(|r| r.style.font_size)
    });
    assert_eq!(
        on_size,
        Some(12.0),
        "must not full-merge Regular FontSize=24"
    );

    let encoded = encode_engine_data(&on);
    let bytes = serialize_engine_data(&encoded, false);
    let parsed = parse_engine_data(&bytes).unwrap();
    let font_set = match &parsed {
        EngineValue::Dict(m) => m
            .iter()
            .find(|(k, _)| k == "ResourceDict")
            .and_then(|(_, v)| match v {
                EngineValue::Dict(rd) => rd.iter().find(|(k, _)| k == "FontSet").map(|(_, v)| v),
                _ => None,
            }),
        _ => None,
    };
    let names: Vec<String> = match font_set {
        Some(EngineValue::Array(arr)) => arr
            .iter()
            .filter_map(|f| match f {
                EngineValue::Dict(d) => {
                    d.iter()
                        .find(|(k, _)| k == "Name")
                        .and_then(|(_, v)| match v {
                            EngineValue::Str(s) => Some(s.clone()),
                            _ => None,
                        })
                }
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    };
    assert!(
        names.iter().any(|n| n == "RealFont-Regular"),
        "FontSet after encode: {names:?}"
    );
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

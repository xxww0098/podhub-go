//! Text style setters + base/run merge rules.
//!
//! Self-loop tests against read fixtures. Skip cleanly when the ag-psd fixture
//! corpus is absent.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::engine_data::EngineValue;
use psdx::psd::{Color, Font, Layer, LayerTextData, ReadOptions, Rgb, WriteOptions};
use psdx::text::encode_engine_data;
use psdx::{FontResolution, RasterPolicy, TextEdit, TextEditError, read_psd, write_psd};

fn fixture_src(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
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

fn fixture_expected(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
    let psd = dir.join("expected.psd");
    let psb = dir.join("expected.psb");
    if psd.is_file() {
        Some(psd)
    } else if psb.is_file() {
        Some(psb)
    } else {
        None
    }
}

fn read_opts_resolved() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        resolve_inherited_fonts: Some(true),
        ..ReadOptions::default()
    }
}

fn read_opts_byte_oracle() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        use_raw_thumbnail: Some(true),
        throw_for_missing_features: Some(true),
        resolve_inherited_fonts: Some(false),
        ..ReadOptions::default()
    }
}

fn first_text_path(psd: &psdx::psd::Psd) -> Option<Vec<usize>> {
    fn walk(layers: &[Layer], prefix: &mut Vec<usize>) -> Option<Vec<usize>> {
        for (i, layer) in layers.iter().enumerate() {
            prefix.push(i);
            if layer.additional_info.text.is_some() {
                return Some(prefix.clone());
            }
            if let Some(children) = layer.children.as_ref() {
                if let Some(found) = walk(children, prefix) {
                    return Some(found);
                }
            }
            prefix.pop();
        }
        None
    }
    psd.children.as_ref().and_then(|c| walk(c, &mut Vec::new()))
}

fn layer_text_data<'a>(psd: &'a psdx::psd::Psd, path: &[usize]) -> &'a LayerTextData {
    let mut layers = psd.children.as_ref().expect("children");
    let mut cur = None;
    for (depth, &idx) in path.iter().enumerate() {
        cur = layers.get(idx);
        let layer = cur.expect("path");
        if depth + 1 < path.len() {
            layers = layer.children.as_ref().expect("children");
        }
    }
    cur.expect("layer")
        .additional_info
        .text
        .as_ref()
        .expect("text")
}

fn resolved_run_fonts(text: &LayerTextData) -> Vec<String> {
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

fn resolved_run_sizes(text: &LayerTextData) -> Vec<Option<f64>> {
    let base = text.style.as_ref().and_then(|s| s.font_size);
    match text.style_runs.as_ref() {
        None => vec![base],
        Some(runs) => runs.iter().map(|r| r.style.font_size.or(base)).collect(),
    }
}

fn resolved_run_colors(text: &LayerTextData) -> Vec<Option<Color>> {
    let base = text.style.as_ref().and_then(|s| s.fill_color);
    match text.style_runs.as_ref() {
        None => vec![base],
        Some(runs) => runs.iter().map(|r| r.style.fill_color.or(base)).collect(),
    }
}

fn dict_get<'a>(v: &'a EngineValue, key: &str) -> Option<&'a EngineValue> {
    match v {
        EngineValue::Dict(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
        _ => None,
    }
}

fn font_set_names(text: &LayerTextData) -> Vec<String> {
    let root = encode_engine_data(text);
    let font_set = dict_get(&root, "ResourceDict")
        .and_then(|d| dict_get(d, "FontSet"))
        .expect("FontSet");
    match font_set {
        EngineValue::Array(arr) => arr
            .iter()
            .filter_map(|f| {
                dict_get(f, "Name").and_then(|n| match n {
                    EngineValue::Str(s) => Some(s.clone()),
                    _ => None,
                })
            })
            .collect(),
        _ => panic!("FontSet not array"),
    }
}

fn sample_font(name: &str) -> Font {
    Font {
        name: name.into(),
        script: Some(0.0),
        font_type: Some(0.0),
        synthetic: Some(0.0),
    }
}

/// EngineData colors round-trip through /255 encoding; allow tiny drift.
fn colors_close(a: Color, b: Color) -> bool {
    match (a, b) {
        (Color::Rgb(x), Color::Rgb(y)) => {
            (x.r - y.r).abs() < 0.05 && (x.g - y.g).abs() < 0.05 && (x.b - y.b).abs() < 0.05
        }
        (Color::Rgba(x), Color::Rgba(y)) => {
            (x.r - y.r).abs() < 0.05
                && (x.g - y.g).abs() < 0.05
                && (x.b - y.b).abs() < 0.05
                && (x.a - y.a).abs() < 0.05
        }
        _ => a == b,
    }
}

/// Setting whole-layer font on a multi-font layer updates every run after reread.
#[test]
fn set_font_applies_to_every_run_after_reread() {
    let Some(src) = fixture_src("read", "text-complex") else {
        eprintln!("skip: read/text-complex missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd).expect("text layer");
    let before = resolved_run_fonts(layer_text_data(&psd, &path));
    assert!(
        before
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            > 1,
        "fixture must have multiple distinct per-run fonts, got {before:?}"
    );
    let new_font = sample_font("PsdxTicket12-TestFont");

    let queried: Vec<String>;
    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        let mut layer = session.layer_at(&path).expect("layer");
        layer.set_font(new_font.clone()).expect("set_font");
        let n = layer.style_run_count().expect("count");
        queried = (0..n)
            .map(|i| {
                layer
                    .effective_style(i)
                    .expect("effective")
                    .font
                    .expect("font")
                    .name
            })
            .collect();
        assert!(queried.iter().all(|n| n == "PsdxTicket12-TestFont"));
        let _ = session.finish();
    }

    let font_names = font_set_names(layer_text_data(&psd, &path));
    assert!(
        font_names.iter().any(|n| n == "PsdxTicket12-TestFont"),
        "FontSet must contain new font: {font_names:?}"
    );
    for old in &before {
        if old == "PsdxTicket12-TestFont" {
            continue;
        }
        assert!(
            !font_names.iter().any(|n| n == old),
            "FontSet must drop old-only font {old}: {font_names:?}"
        );
    }

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&written, &read_opts_resolved()).expect("reread");
    let after = resolved_run_fonts(layer_text_data(&reread, &path));
    assert!(
        after.iter().all(|n| n == "PsdxTicket12-TestFont"),
        "every run must be new font after reread, got {after:?}"
    );
    assert_eq!(queried, after, "effective_style must match reread merge");
}

#[test]
fn set_font_size_applies_to_every_run_after_reread() {
    let Some(src) = fixture_src("read", "text-complex") else {
        eprintln!("skip: read/text-complex missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd).expect("text layer");
    let new_size = 42.0;

    let queried: Vec<Option<f64>>;
    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        let mut layer = session.layer_at(&path).expect("layer");
        layer.set_font_size(new_size).expect("set_font_size");
        let n = layer.style_run_count().expect("count");
        queried = (0..n)
            .map(|i| layer.effective_style(i).expect("effective").font_size)
            .collect();
        assert!(queried.iter().all(|s| *s == Some(new_size)));
        let _ = session.finish();
    }

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&written, &read_opts_resolved()).expect("reread");
    let after = resolved_run_sizes(layer_text_data(&reread, &path));
    assert!(
        after.iter().all(|s| *s == Some(new_size)),
        "every run size must be {new_size} after reread, got {after:?}"
    );
    assert_eq!(queried, after);
}

#[test]
fn set_fill_color_applies_to_every_run_after_reread() {
    let Some(src) = fixture_src("read", "text-complex") else {
        eprintln!("skip: read/text-complex missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd).expect("text layer");
    let before = resolved_run_colors(layer_text_data(&psd, &path));
    let mut distinct = Vec::new();
    for c in before.iter().flatten() {
        if !distinct.iter().any(|x| x == c) {
            distinct.push(*c);
        }
    }
    assert!(
        distinct.len() > 1,
        "fixture should have multiple fill colors, got {distinct:?}"
    );
    let new_color = Color::Rgb(Rgb {
        r: 10.0,
        g: 20.0,
        b: 30.0,
    });

    let queried: Vec<Option<Color>>;
    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        let mut layer = session.layer_at(&path).expect("layer");
        layer.set_fill_color(new_color).expect("set_fill_color");
        let n = layer.style_run_count().expect("count");
        queried = (0..n)
            .map(|i| layer.effective_style(i).expect("effective").fill_color)
            .collect();
        assert!(queried.iter().all(|c| *c == Some(new_color)));
        let _ = session.finish();
    }

    let written = write_psd(&psd, &WriteOptions::default()).expect("write");
    let reread = read_psd(&written, &read_opts_resolved()).expect("reread");
    let after = resolved_run_colors(layer_text_data(&reread, &path));
    assert!(
        after
            .iter()
            .all(|c| c.is_some_and(|c| colors_close(c, new_color))),
        "every run color must match after reread, got {after:?}"
    );
    assert_eq!(queried.len(), after.len());
    for (q, a) in queried.iter().zip(after.iter()) {
        match (q, a) {
            (Some(q), Some(a)) => assert!(colors_close(*q, *a), "{q:?} vs {a:?}"),
            _ => panic!("color presence mismatch: {q:?} vs {a:?}"),
        }
    }
}

#[test]
fn unsupported_fill_color_errors_at_api_boundary() {
    let Some(src) = fixture_src("read", "text-complex") else {
        eprintln!("skip: read/text-complex missing");
        return;
    };
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_resolved()).expect("read");
    let path = first_text_path(&psd).expect("text layer");
    let mut session =
        TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved).expect("begin");
    let err = session
        .layer_at(&path)
        .expect("layer")
        .set_fill_color(Color::Lab(psdx::psd::Lab {
            l: 50.0,
            a: 10.0,
            b: -10.0,
        }))
        .expect_err("LAB must fail");
    assert_eq!(err, TextEditError::UnsupportedTextColor);
}

/// No-op set_font → byte-identical to expected.psd.
#[test]
fn noop_set_font_matches_expected_psd() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let Some(expected_path) = fixture_expected("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box expected missing");
        return;
    };
    let expected = fs::read(&expected_path).expect("expected");
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    let path = first_text_path(&psd).expect("text");
    let current = layer_text_data(&psd, &path)
        .style
        .as_ref()
        .and_then(|s| s.font.clone())
        .expect("base font");

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_font(current)
            .expect("noop set_font");
        let report = session.finish();
        assert_eq!(report.mutations, 0);
        assert!(!report.doc_text_blob_dropped);
    }

    let written = write_psd(
        &psd,
        &WriteOptions {
            log_missing_features: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert_eq!(
        written,
        expected,
        "noop set_font must match expected.psd (len {} vs {})",
        written.len(),
        expected.len()
    );
}

#[test]
fn noop_set_font_size_matches_expected_psd() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let Some(expected_path) = fixture_expected("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box expected missing");
        return;
    };
    let expected = fs::read(&expected_path).expect("expected");
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    let path = first_text_path(&psd).expect("text");
    let current = layer_text_data(&psd, &path)
        .style
        .as_ref()
        .and_then(|s| s.font_size)
        .expect("base font_size");

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_font_size(current)
            .expect("noop");
        let report = session.finish();
        assert_eq!(report.mutations, 0);
    }

    let written = write_psd(
        &psd,
        &WriteOptions {
            log_missing_features: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert_eq!(written, expected);
}

#[test]
fn noop_set_fill_color_matches_expected_psd() {
    let Some(src) = fixture_src("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box missing");
        return;
    };
    let Some(expected_path) = fixture_expected("read-write", "text-box") else {
        eprintln!("skip: read-write/text-box expected missing");
        return;
    };
    let expected = fs::read(&expected_path).expect("expected");
    let bytes = fs::read(&src).expect("src");
    let mut psd = read_psd(&bytes, &read_opts_byte_oracle()).expect("read");
    let path = first_text_path(&psd).expect("text");
    let current = layer_text_data(&psd, &path)
        .style
        .as_ref()
        .and_then(|s| s.fill_color)
        .expect("base fill_color");

    {
        let mut session = TextEdit::begin(&mut psd, RasterPolicy::Leave, FontResolution::Resolved)
            .expect("begin");
        session
            .layer_at(&path)
            .expect("layer")
            .set_fill_color(current)
            .expect("noop");
        let report = session.finish();
        assert_eq!(report.mutations, 0);
    }

    let written = write_psd(
        &psd,
        &WriteOptions {
            log_missing_features: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert_eq!(written, expected);
}

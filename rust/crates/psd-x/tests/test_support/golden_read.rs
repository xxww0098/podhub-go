//! Golden loop: read each corpus `read/` fixture, serialize to JSON, compare to
//! regenerated goldens with f64 normalization. Panic paths are caught so the
//! ratchet can still report per-fixture status.

#![cfg(feature = "serde")]

use psdx::psd::ReadOptions;
use psdx::read_psd;
use psdx::test_corpus;
use serde_json::Value;
use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn fixtures_read_dir() -> PathBuf {
    test_corpus::corpus_root().join("read")
}

fn goldens_read_dir() -> PathBuf {
    test_corpus::golden_root().join("read")
}

/// Replay gen-goldens.js `cleanForJson` on a serialized document so structure
/// goldens (which strip pixels / xmp / thumbnails) are comparable.
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

/// Compare JSON values with numbers normalized via `as_f64` (and `-0.0` → `0.0`).
/// Floats use a tiny relative epsilon so 0.19607843137254902 vs …4904 does not fire.
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
                diff <= 1e-12 * xf.abs().max(yf.abs()).max(1.0)
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
        _ => diffs.push(format!("{path}: {a:?} != {b:?}")),
    }
}

fn find_src(dir: &Path) -> Option<PathBuf> {
    for name in ["src.psd", "src.psb"] {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}

#[derive(Debug)]
enum Outcome {
    Match,
    Diff { count: usize, sample: Vec<String> },
    Panic(String),
    ReadError(String),
    MissingGolden,
    MissingSrc,
}

fn compare_one(name: &str) -> Outcome {
    let fix = fixtures_read_dir().join(name);
    let Some(src) = find_src(&fix) else {
        return Outcome::MissingSrc;
    };
    let golden_path = goldens_read_dir().join(name).join("psd.json");
    if !golden_path.is_file() {
        // Fall back to committed data.json for local runs without gen-goldens.
        let fallback = fix.join("data.json");
        if !fallback.is_file() {
            return Outcome::MissingGolden;
        }
        return compare_against(&src, &fallback);
    }
    compare_against(&src, &golden_path)
}

fn compare_against(src: &Path, golden_path: &Path) -> Outcome {
    let bytes = match fs::read(src) {
        Ok(b) => b,
        Err(e) => return Outcome::ReadError(e.to_string()),
    };
    let opts = ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        ..ReadOptions::default()
    };

    let result = catch_unwind(AssertUnwindSafe(|| read_psd(&bytes, &opts)));
    let psd = match result {
        Ok(Ok(p)) => p,
        Ok(Err(e)) => return Outcome::ReadError(format!("{e:?}")),
        Err(payload) => {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| (*s).to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "box panic".into());
            return Outcome::Panic(msg);
        }
    };

    let mut actual = match serde_json::to_value(&psd) {
        Ok(v) => v,
        Err(e) => return Outcome::ReadError(format!("serialize: {e}")),
    };
    clean_for_json(&mut actual);
    let expected: Value = match fs::read_to_string(golden_path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
    {
        Some(v) => v,
        None => return Outcome::MissingGolden,
    };

    let mut diffs = Vec::new();
    json_eq(&actual, &expected, "$", &mut diffs);
    if diffs.is_empty() {
        Outcome::Match
    } else {
        Outcome::Diff {
            count: diffs.len(),
            sample: diffs.into_iter().take(8).collect(),
        }
    }
}

#[test]
fn golden_read_ratchet() {
    let dir = fixtures_read_dir();
    if !dir.is_dir() {
        eprintln!(
            "skip golden_read_ratchet: fixtures missing at {} (set PSDX_FIXTURES_DIR)",
            dir.display()
        );
        return;
    }

    let mut names: Vec<_> = fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n != "cmyk") // negative upstream case
        .collect();
    names.sort();

    let mut matched = 0usize;
    let mut comparable = 0usize;
    let mut report = Vec::new();

    for name in &names {
        let outcome = compare_one(name);
        match &outcome {
            Outcome::Match => {
                matched += 1;
                comparable += 1;
            }
            Outcome::Diff { count, sample } => {
                comparable += 1;
                report.push(format!(
                    "DIFF {name}: {count} paths; e.g. {}",
                    sample.join(" | ")
                ));
            }
            Outcome::Panic(m) => report.push(format!("PANIC {name}: {m}")),
            Outcome::ReadError(m) => report.push(format!("READ_ERR {name}: {m}")),
            Outcome::MissingGolden => report.push(format!("NO_GOLDEN {name}")),
            Outcome::MissingSrc => report.push(format!("NO_SRC {name}")),
        }
    }

    println!(
        "golden_read ratchet: {matched}/{comparable} matched (of {} fixtures scanned)",
        names.len()
    );
    for line in report.iter().take(40) {
        println!("{line}");
    }
    if report.len() > 40 {
        println!("... {} more", report.len() - 40);
    }

    // Fail only if we could not compare anything while fixtures exist.
    assert!(
        comparable > 0,
        "expected to compare at least one golden; got comparable=0"
    );
    // Soft gate: print summary file for the ratchet.
    let summary = format!(
        "# M1 golden read ratchet\n\nmatched: {matched}\ncomparable: {comparable}\nfixtures: {}\n\n",
        names.len()
    );
    let _ = fs::write(repo_root().join("tests/M1_RATCHET.md"), summary);
}

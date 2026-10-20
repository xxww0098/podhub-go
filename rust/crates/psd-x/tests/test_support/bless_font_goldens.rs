//! One-shot bless helper for the psdx-blessed font goldens (not part of CI). Run:
//! `cargo test -p psdx --features test-support --test test_support write -- --ignored --nocapture`

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::ReadOptions;
use psdx::read_psd;
use serde_json::Value;

const FIXTURES: &[&str] = &["text-layer", "text-simple", "text-simple2", "text-complex"];

fn fixture_psd(name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join("read").join(name);
    let psd = dir.join("src.psd");
    if psd.is_file() { Some(psd) } else { None }
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

#[test]
#[ignore = "manual: regenerate tests/goldens/psdx-blessed/read/*/psd.json"]
fn write() {
    let opts = ReadOptions {
        use_image_data: Some(true),
        skip_thumbnail: Some(true),
        ..ReadOptions::default()
    };
    for name in FIXTURES {
        let src = fixture_psd(name).expect("fixture");
        let bytes = fs::read(&src).expect("read");
        let psd = read_psd(&bytes, &opts).expect("read_psd");
        let mut actual = serde_json::to_value(&psd).expect("json");
        clean_for_json(&mut actual);
        let out_dir = test_corpus::golden_root()
            .join("psdx-blessed/read")
            .join(name);
        fs::create_dir_all(&out_dir).expect("mkdir");
        let out_path = out_dir.join("psd.json");
        let json = serde_json::to_string_pretty(&actual).expect("pretty");
        fs::write(&out_path, format!("{json}\n")).expect("write");
        eprintln!("wrote {}", out_path.display());
    }
}

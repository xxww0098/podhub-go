//! Image resources + thumbnail fixture pins.

#![cfg(feature = "serde")]

use psdx::test_corpus;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{ReadOptions, WriteOptions};
use psdx::{read_psd, write_psd};
use serde_json::Value;

fn fixture_psd(kind: &str, name: &str) -> Option<PathBuf> {
    let dir = test_corpus::corpus_root().join(kind).join(name);
    for fname in ["src.psd", "src.psb"] {
        let p = dir.join(fname);
        if p.is_file() {
            return Some(p);
        }
    }
    None
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
            for (i, (x, y)) in xs.iter().zip(ys.iter()).enumerate() {
                json_eq(x, y, &format!("{path}[{i}]"), diffs);
            }
        }
        (Value::Object(xs), Value::Object(ys)) => {
            let mut keys: Vec<_> = xs.keys().chain(ys.keys()).collect();
            keys.sort();
            keys.dedup();
            for k in keys {
                match (xs.get(k), ys.get(k)) {
                    (Some(x), Some(y)) => json_eq(x, y, &format!("{path}.{k}"), diffs),
                    (Some(_), None) => diffs.push(format!("{path}.{k}: only in actual")),
                    (None, Some(_)) => diffs.push(format!("{path}.{k}: only in expected")),
                    (None, None) => {}
                }
            }
        }
        _ if a == b => {}
        _ => diffs.push(format!("{path}: type/value mismatch")),
    }
}

fn find_resource(buf: &[u8], id: u16) -> Option<&[u8]> {
    let needle = {
        let mut v = b"8BIM".to_vec();
        v.extend_from_slice(&id.to_be_bytes());
        v
    };
    let pos = buf.windows(needle.len()).position(|w| w == needle)?;
    let at = &buf[pos + needle.len()..];
    if at.is_empty() {
        return None;
    }
    let name_len = at[0] as usize;
    let mut off = 1 + name_len;
    if (name_len + 1) % 2 != 0 {
        off += 1;
    }
    if at.len() < off + 4 {
        return None;
    }
    let size = u32::from_be_bytes(at[off..off + 4].try_into().unwrap()) as usize;
    off += 4;
    if at.len() < off + size {
        return None;
    }
    Some(&at[off..off + size])
}

#[test]
fn slices_fixture_matches_golden() {
    let Some(src) = fixture_psd("read", "slices") else {
        eprintln!("skip slices: fixture missing");
        return;
    };
    let Some(expected) = golden_json("slices") else {
        eprintln!("skip slices: golden missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            skip_thumbnail: Some(true),
            ..ReadOptions::default()
        },
    )
    .expect("read slices");
    let mut actual = serde_json::to_value(&psd).unwrap();
    clean_for_json(&mut actual);
    let mut diffs = Vec::new();
    json_eq(&actual, &expected, "$", &mut diffs);
    assert!(
        diffs.is_empty(),
        "slices golden mismatch ({}): {}",
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
fn thumbnail_raw_passthrough_round_trip() {
    let Some(src) = fixture_psd("read-write", "masks") else {
        eprintln!("skip thumbnail passthrough: fixture missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let opts = ReadOptions {
        use_image_data: Some(true),
        use_raw_thumbnail: Some(true),
        ..ReadOptions::default()
    };
    let psd = read_psd(&bytes, &opts).expect("read");
    let raw = psd
        .image_resources
        .as_ref()
        .and_then(|r| r.thumbnail_raw.as_ref())
        .expect("thumbnailRaw present");
    assert!(raw.width > 0.0 && raw.height > 0.0);
    assert!(!raw.data.is_empty());
    assert_eq!(&raw.data[..2], &[0xff, 0xd8]);

    let out = write_psd(
        &psd,
        &WriteOptions {
            generate_thumbnail: Some(false),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    let payload = find_resource(&out, 1036).expect("written 1036");
    // header is 28 bytes before JPEG
    assert!(payload.len() > 28);
    assert_eq!(&payload[28..30], &[0xff, 0xd8]);
    assert_eq!(&payload[28..], raw.data.as_slice());

    let again = read_psd(&out, &opts).expect("re-read");
    let raw2 = again
        .image_resources
        .as_ref()
        .and_then(|r| r.thumbnail_raw.as_ref())
        .expect("thumbnailRaw after round-trip");
    assert_eq!(raw2.data, raw.data);
    assert_eq!(raw2.width, raw.width);
    assert_eq!(raw2.height, raw.height);
}

#[test]
fn write_always_emits_layers_group_resources() {
    let Some(src) = fixture_psd("read", "layers") else {
        eprintln!("skip 1026/1072: fixture missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            skip_thumbnail: Some(true),
            use_raw_thumbnail: Some(true),
            ..ReadOptions::default()
        },
    )
    .expect("read");
    let out = write_psd(&psd, &WriteOptions::default()).expect("write");
    let g1026 = find_resource(&out, 1026).expect("resource 1026");
    let g1072 = find_resource(&out, 1072).expect("resource 1072");
    assert!(!g1026.is_empty() || psd.children.as_ref().map_or(true, |c| c.is_empty()));
    // One u16 per flattened layer; at least the placeholder path writes something
    // when children exist.
    if psd
        .children
        .as_ref()
        .map(|c| !c.is_empty())
        .unwrap_or(false)
    {
        assert!(g1026.len() >= 2);
        assert!(!g1072.is_empty());
    }
}

#[test]
fn generate_thumbnail_sets_image_resource() {
    let Some(src) = fixture_psd("read", "background") else {
        eprintln!("skip generate_thumbnail: fixture missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            skip_thumbnail: Some(true),
            ..ReadOptions::default()
        },
    )
    .expect("read");
    // Drop any existing thumb so generate path owns it.
    if let Some(res) = psd.image_resources.as_mut() {
        res.thumbnail = None;
        res.thumbnail_raw = None;
    }
    let out = write_psd(
        &psd,
        &WriteOptions {
            generate_thumbnail: Some(true),
            ..WriteOptions::default()
        },
    )
    .expect("write");

    #[cfg(feature = "thumbnail")]
    {
        let payload = find_resource(&out, 1036).expect("1036 from generate_thumbnail");
        assert!(payload.len() > 28);
        assert_eq!(&payload[28..30], &[0xff, 0xd8]);
        let w = u32::from_be_bytes(payload[4..8].try_into().unwrap());
        let h = u32::from_be_bytes(payload[8..12].try_into().unwrap());
        assert!(w > 0 && h > 0);
        assert!(w <= 160 && h <= 160);
    }
    #[cfg(not(feature = "thumbnail"))]
    {
        // Without encode support, generate creates PixelData but write cannot
        // emit JPEG — resource may be empty. Ensure write still succeeds.
        let _ = find_resource(&out, 1036);
    }
}

#[test]
fn gbk_encoded_alpha_names_decode() {
    // Synthetic: high-bit GBK "测试" (ce d2 / ca d4) as a length-prefixed name.
    use psdx::image_resources::{read_image_resource, write_image_resource};
    use psdx::psd::ImageResources;
    use psdx::reader::PsdReader;
    use psdx::writer::create_writer;

    let gbk_bytes = [0xB2, 0xE2, 0xCA, 0xD4]; // 测试 in GBK
    let mut target = ImageResources::default();
    target.alpha_channel_names = Some(vec!["测试".to_string()]);

    // Write via unicode path (1045) then verify GBK round via encoded path by
    // crafting a 1006 payload manually.
    let mut w = create_writer(64);
    // length + gbk bytes
    use psdx::writer::{write_bytes, write_uint8};
    write_uint8(&mut w, gbk_bytes.len() as u8);
    write_bytes(&mut w, Some(&gbk_bytes));
    let payload = w.to_bytes();

    let mut r = PsdReader::new(&payload, None, None);
    let mut out = ImageResources::default();
    read_image_resource(1006, &mut r, &mut out, payload.len()).expect("read 1006");
    let names = out.alpha_channel_names.expect("names");
    assert_eq!(names, vec!["测试".to_string()]);

    // Also ensure write path still works for ASCII names.
    let mut ascii = ImageResources::default();
    ascii.alpha_channel_names = Some(vec!["Alpha 1".to_string()]);
    let mut w2 = create_writer(64);
    write_image_resource(1006, &mut w2, &ascii, 0).unwrap();
    let bytes = w2.to_bytes();
    let mut r2 = PsdReader::new(&bytes, None, None);
    let mut out2 = ImageResources::default();
    read_image_resource(1006, &mut r2, &mut out2, bytes.len()).unwrap();
    assert_eq!(out2.alpha_channel_names, Some(vec!["Alpha 1".to_string()]));
}

#[cfg(feature = "thumbnail")]
#[test]
fn use_raw_thumbnail_false_decodes_pixels() {
    let Some(src) = fixture_psd("read", "slices") else {
        eprintln!("skip decode thumbnail: fixture missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            use_raw_thumbnail: Some(false),
            skip_thumbnail: Some(false),
            ..ReadOptions::default()
        },
    )
    .expect("read");
    let thumb = psd
        .image_resources
        .as_ref()
        .and_then(|r| r.thumbnail.as_ref())
        .expect("decoded thumbnail");
    assert!(thumb.width > 0 && thumb.height > 0);
    assert_eq!(thumb.depth, 8);
    assert!(thumb.data.len() >= (thumb.width as usize) * (thumb.height as usize) * 4);
    assert!(
        psd.image_resources
            .as_ref()
            .unwrap()
            .thumbnail_raw
            .is_none()
    );
}

#[test]
fn timeline_information_round_trip_when_present() {
    let Some(src) = fixture_psd("read", "animation-timeline") else {
        eprintln!("skip 1075: fixture missing");
        return;
    };
    let bytes = fs::read(src).unwrap();
    let psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            skip_thumbnail: Some(true),
            use_raw_thumbnail: Some(true),
            ..ReadOptions::default()
        },
    )
    .expect("read animation-timeline");
    let info = psd
        .image_resources
        .as_ref()
        .and_then(|r| r.timeline_information.as_ref());
    if info.is_none() {
        eprintln!("animation-timeline has no timelineInformation; skip assert");
        return;
    }
    let info = info.unwrap();
    assert!(info.frame_rate > 0.0 || !info.global_tracks.is_empty() || info.enabled);

    let out = write_psd(
        &psd,
        &WriteOptions {
            generate_thumbnail: Some(false),
            ..WriteOptions::default()
        },
    )
    .expect("write");
    assert!(find_resource(&out, 1075).is_some());
}

#[test]
fn m3_m8_smoke_not_regressed() {
    for name in [
        "16bits",
        "32bits",
        "smart-object",
        "artboards",
        "text-simple",
    ] {
        let Some(src) = fixture_psd("read", name) else {
            continue;
        };
        let bytes = fs::read(src).unwrap();
        let psd = read_psd(
            &bytes,
            &ReadOptions {
                use_image_data: Some(true),
                skip_thumbnail: Some(true),
                ..ReadOptions::default()
            },
        );
        assert!(psd.is_ok(), "{name}: {:?}", psd.err());
    }
}

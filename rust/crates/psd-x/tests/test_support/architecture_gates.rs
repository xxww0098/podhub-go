//! Editing-API process gates: keep editing modules slim and keep
//! serializable model field sets stable. Structural guardrails for acceptance
//! items that would otherwise stay honour-system.

use psdx::test_corpus;
use std::collections::BTreeSet;
use std::fs;
use std::path::PathBuf;

use psdx::psd::{Psd, ReadOptions};
use psdx::read_psd;
use psdx::smart_object::{LayerTarget, Replacement, find_smart_objects, replace_smart_object};

fn src_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

fn fixtures_root() -> PathBuf {
    test_corpus::corpus_root()
}

/// Editing-API modules must stay under a 1000-line soft cap.
#[test]
fn m14_source_files_under_1000_lines() {
    let files = [
        "smart_object/mod.rs",
        "smart_object/errors.rs",
        "smart_object/frame.rs",
        "smart_object/guid.rs",
        "smart_object/replace.rs",
        "smart_object/target.rs",
        "smart_object/types.rs",
        "smart_object/warp.rs",
        "text_edit/mod.rs",
        "text_edit/geometry.rs",
        "text_edit/runs.rs",
        "text_edit/style.rs",
        "text_edit/session_tests.rs",
        "image_sniff.rs",
        "edit/mod.rs",
        "edit/layer_preview.rs",
        "guid.rs",
    ];
    for rel in files {
        let path = src_root().join(rel);
        assert!(path.is_file(), "missing M14 source {rel}");
        let text = fs::read_to_string(&path).expect("read");
        let n = text.lines().count();
        assert!(
            n <= 1000,
            "{rel} has {n} lines (cap 1000); split before growing further"
        );
    }
}

/// Frozen allowlist of document-level JSON keys observed in goldens + image
/// payloads. Editing APIs must not introduce new serializable model fields.
#[test]
fn psd_top_level_serde_keys_within_allowlist() {
    // Union of keys from tests/goldens/read/*/psd.json plus composite pixel
    // fields that appear when reading with image data enabled.
    let allowed: BTreeSet<&str> = [
        "artboards",
        "bitsPerChannel",
        "canvas",
        "channels",
        "children",
        "colorMode",
        "compositorUsed",
        "engineData",
        "filterEffectsMasks",
        "filterMask",
        "globalLayerMaskInfo",
        "height",
        "imageData",
        "imageResources",
        "linkedFiles",
        "palette",
        "pathList",
        "patterns",
        "rawCompositeData",
        "userMask",
        "width",
    ]
    .into_iter()
    .collect();

    let default_keys: BTreeSet<_> = serde_json::to_value(Psd::default())
        .expect("default")
        .as_object()
        .expect("object")
        .keys()
        .cloned()
        .collect();
    let unexpected_default: Vec<_> = default_keys
        .iter()
        .map(|s| s.as_str())
        .filter(|k| !allowed.contains(k))
        .collect();
    assert!(
        unexpected_default.is_empty(),
        "default Psd grew new top-level keys: {unexpected_default:?}"
    );

    let Some(bytes) = fs::read(fixtures_root().join("read-write/smart/src.psd")).ok() else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            use_raw_thumbnail: Some(true),
            throw_for_missing_features: Some(true),
            ..ReadOptions::default()
        },
    )
    .expect("read");
    let keys: BTreeSet<_> = serde_json::to_value(&psd)
        .expect("serialize")
        .as_object()
        .expect("object")
        .keys()
        .cloned()
        .collect();
    let unexpected: Vec<_> = keys
        .iter()
        .map(|s| s.as_str())
        .filter(|k| !allowed.contains(k))
        .collect();
    assert!(
        unexpected.is_empty(),
        "fixture Psd has new top-level serde keys (M14 forbids model field adds): {unexpected:?}"
    );
}

/// Ticket 06: after same-size replace, wiping only the edited linked-file
/// payload leaves the serialized model identical — layers and other linked
/// records must not change (stronger than nulling the whole target layer).
#[test]
fn only_linked_payload_differs_in_serialized_model() {
    let Some(bytes) = fs::read(fixtures_root().join("read-write/smart/src.psd")).ok() else {
        eprintln!("skip: read-write/smart missing");
        return;
    };
    let mut psd = read_psd(
        &bytes,
        &ReadOptions {
            use_image_data: Some(true),
            use_raw_thumbnail: Some(true),
            throw_for_missing_features: Some(true),
            ..ReadOptions::default()
        },
    )
    .expect("read");
    let infos = find_smart_objects(&psd, &LayerTarget::Path(vec![]));
    assert!(!infos.is_empty());
    let path = infos[0].path.clone();
    let linked_id = infos[0].linked_id.clone();
    let name = infos[0].file_name.clone().unwrap_or_else(|| "asset".into());
    let mut new_data = psd
        .linked_files
        .as_ref()
        .unwrap()
        .iter()
        .find(|f| f.id == linked_id)
        .and_then(|f| f.data.clone())
        .expect("embedded data");
    let mid = new_data.len() / 2;
    new_data[mid] ^= 0x33;

    let mut before = serde_json::to_value(&psd).expect("serialize before");
    replace_smart_object(
        &mut psd,
        &LayerTarget::Path(path),
        Replacement::new(&new_data, name),
    )
    .expect("replace");
    let mut after = serde_json::to_value(&psd).expect("serialize after");

    null_linked_data(&mut before, &linked_id);
    null_linked_data(&mut after, &linked_id);
    assert_eq!(
        before, after,
        "after wiping edited linked payload, models must match (no layer collateral)"
    );
}

fn null_linked_data(doc: &mut serde_json::Value, linked_id: &str) {
    let Some(files) = doc.get_mut("linkedFiles").and_then(|f| f.as_array_mut()) else {
        return;
    };
    for file in files {
        if file.get("id").and_then(|v| v.as_str()) == Some(linked_id) {
            if let Some(obj) = file.as_object_mut() {
                obj.insert("data".into(), serde_json::Value::Null);
            }
        }
    }
}

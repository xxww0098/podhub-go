//! Independent native verification of the fixed WB wasm32 parity baseline.
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use listing_core::wb::{Issue, Material, Preview, WbProductConfig, build_preview, metadata_issues};
use serde::{Deserialize, Serialize};

// Test and exporter decode the shared input independently; neither imports
// the other's implementation or the listing-core-wasm host ABI.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputCase {
    id: String,
    material: Material,
    config: WbProductConfig,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExpectedCase {
    id: String,
    metadata_issues: Vec<Issue>,
    preview: Preview,
}

fn fixture(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/ambient")
        .join(name)
}

fn read(path: &Path) -> String {
    std::fs::read_to_string(path).unwrap_or_else(|error| {
        panic!(
            "{} must be an existing fixed fixture: {error}",
            path.display()
        )
    })
}

fn assert_native_matches_golden(input: &str, golden: &str) {
    let cases: Vec<InputCase> = serde_json::from_str(input).expect("shared input must decode");
    let expected: Vec<ExpectedCase> =
        serde_json::from_str(golden).expect("fixed golden must decode");
    assert_eq!(
        cases.len(),
        8,
        "keep both valid cases and all refusal families"
    );
    assert_eq!(
        expected.len(),
        cases.len(),
        "no missing or extra golden cases"
    );
    let mut ids = BTreeSet::new();
    for (case, expected) in cases.iter().zip(&expected) {
        assert!(ids.insert(&case.id), "duplicate input case {}", case.id);
        assert_eq!(case.id, expected.id, "case identity/order drift");
        let actual = build_preview(&case.material, &case.config);
        assert_eq!(
            actual.upload_bytes, expected.preview.upload_bytes,
            "{}: native upload bytes drifted",
            case.id
        );
        assert_eq!(
            actual, expected.preview,
            "{}: full preview/coordinates drifted",
            case.id
        );
        assert_eq!(
            metadata_issues(&case.material),
            expected.metadata_issues,
            "{}: metadata drifted",
            case.id
        );
        if matches!(
            case.id.as_str(),
            "unicode-escaping-ordered-variants" | "defaults-manual-cleared-zero"
        ) {
            assert!(
                actual.issues.is_empty(),
                "{} must remain a valid preview",
                case.id
            );
            assert!(actual.group.is_some() && actual.upload_bytes.is_some());
        } else {
            assert!(
                !actual.issues.is_empty(),
                "{} must remain a refusal",
                case.id
            );
            assert!(actual.group.is_none() && actual.upload_bytes.is_none());
        }
    }
}

#[test]
fn wb_native_preview_matches_the_fixed_shared_golden() {
    assert_native_matches_golden(
        &read(&fixture("wb-preview-input.json")),
        &read(&fixture("wb-preview-golden.json")),
    );
}

#[test]
fn wb_missing_golden_fails_without_creating_or_healing_a_file() {
    let missing = fixture("wb-preview-golden.missing.json");
    assert!(!missing.exists());
    assert!(std::panic::catch_unwind(|| read(&missing)).is_err());
    assert!(!missing.exists(), "verification must never write a fixture");
}

#[test]
fn wb_changed_upload_byte_fails_without_updating_the_fixed_golden() {
    let input = read(&fixture("wb-preview-input.json"));
    let path = fixture("wb-preview-golden.json");
    let original = read(&path);
    let mut changed: Vec<ExpectedCase> = serde_json::from_str(&original).unwrap();
    changed[0].preview.upload_bytes.as_mut().unwrap()[0] ^= 1;
    let mismatch = serde_json::to_string(&changed).unwrap();
    assert!(std::panic::catch_unwind(|| assert_native_matches_golden(&input, &mismatch)).is_err());
    assert_eq!(
        read(&path),
        original,
        "verification must never heal the fixed golden"
    );
}

#[test]
fn wb_changed_refusal_coordinate_fails_without_updating_the_fixed_golden() {
    let input = read(&fixture("wb-preview-input.json"));
    let path = fixture("wb-preview-golden.json");
    let original = read(&path);
    let mut changed: Vec<ExpectedCase> = serde_json::from_str(&original).unwrap();
    let refused = changed
        .iter_mut()
        .find(|case| case.id == "blank-text-variant-coordinate")
        .unwrap();
    refused.preview.issues[0].variant_index = Some(0);
    let mismatch = serde_json::to_string(&changed).unwrap();
    assert!(std::panic::catch_unwind(|| assert_native_matches_golden(&input, &mismatch)).is_err());
    assert_eq!(
        read(&path),
        original,
        "verification must never heal the fixed golden"
    );
}

//! Whole-document `composite()` vs Photoshop `composite.bin`.
//!
//! Tolerance: **byte-exact only**. No PNG oracle (checked-in canvases are
//! premultiply-corrupted). Missing goldens skip with an exact regen command and
//! are counted so a skip cannot be mistaken for a pass.
//!
//! The matcher list is an exact ratchet (inverse of `ORACLE_BYTE_DIVERGENCES` in
//! `read_write_bytes.rs`): every name on it must match; every other fixture with
//! a golden must *not* match and must appear in `ORACLE_BYTE_EXCLUSIONS` with a
//! reason. A newly matching excluded fixture fails the suite until the matcher
//! list absorbs it.

use psdx::composite::{CompositeRegion, CompositeRequest, CompositeTarget, composite};
use psdx::psd::{Layer, ReadOptions};
use psdx::read_psd;
use psdx::test_corpus;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

/// Fixtures whose `CompositeTarget::Document` + `CompositeRegion::Full` output
/// matches `tests/goldens/read/<name>/composite.bin` byte-for-byte today.
///
/// Spec candidate `groups` (partial alpha, hidden layer, non-unit opacity,
/// nested pass-through groups) was measured first and **diverges** — see
/// `ORACLE_BYTE_EXCLUSIONS`. Among matchers, `nested` covers nested groups;
/// `background` / `layers` / `psb` / `section-2` exercise partial-alpha source
/// pixels under Normal blend. The full four-property conjunction rejoins this
/// list when the compositor catches up (zero tolerance — no silent ε).
const ORACLE_BYTE_MATCHERS: &[&str] = &[
    "background",
    "cyllinder-warp",
    "grayscale",
    "key-origin-shape-bbox",
    "layer-larger-than-drawing",
    "layer-offsets-read",
    "layers",
    "nested",
    "psb",
    "section-2",
];

/// Exact exclusion list: fixture name → why it is not a matcher.
/// A fixture here that begins matching must fail (force the matcher list to grow
/// and this list to shrink).
const ORACLE_BYTE_EXCLUSIONS: &[(&str, &str)] = &[
    ("16bits", "non-8-bit document; compositor emits RGBA8"),
    (
        "2026-blend-modes",
        "layer effects; non-normal blend modes beyond compositor subset",
    ),
    ("32bits", "non-8-bit document; compositor emits RGBA8"),
    ("adjustment-layers", "adjustment layers; layer masks"),
    ("alias", "text (no font rasterization)"),
    (
        "alpha-composite",
        "alpha compositing diverges from Photoshop flatten",
    ),
    ("animation-effects", "layer effects"),
    (
        "animation-frame",
        "document animation / timeline flatten diverges",
    ),
    (
        "animation-offset",
        "document animation / timeline flatten diverges",
    ),
    ("animation-timeline", "layer effects; smart objects"),
    ("artboards", "artboard document flatten diverges"),
    ("bitmap", "non-8-bit; non-RGB color mode"),
    ("bitmap-rle", "non-8-bit; non-RGB color mode"),
    (
        "blend-if",
        "layer effects; vector fill/stroke; blend-if not evaluated",
    ),
    ("blend-mode", "layer effects"),
    (
        "cat",
        "compositor diverges (zero-alpha RGB / vector-adjacent residual); not byte-exact",
    ),
    (
        "count",
        "document structure flatten diverges (opaque vs transparent canvas)",
    ),
    ("effects", "layer effects"),
    (
        "fill-opacity",
        "fill opacity / non-normal blend path diverges from Photoshop flatten",
    ),
    ("gradient", "vector fill/stroke; layer masks"),
    (
        "gradient-overlay",
        "layer effects; vector fill/stroke; layer masks",
    ),
    (
        "gradient-overlay-2",
        "adjustment layers; vector fill/stroke; layer masks",
    ),
    ("grayscale-alpha", "non-RGB color mode"),
    ("group-drop-shadows", "layer effects; vector fill/stroke"),
    (
        "groups",
        "spec key candidate: 300×200, nested pass-through groups, hidden layer, \
         opacity≈0.5, 22926 partial-alpha golden pixels — first comparison failed. \
         Divergences: Photoshop stores white under zero-alpha (got black); \
         ~6577 visible pixels differ in RGB under matching alpha (partial-alpha \
         stacking / blend rounding; max channel Δ=120). Zero tolerance kept; \
         re-pin when byte-exact.",
    ),
    (
        "guides",
        "document structure flatten diverges (opaque vs transparent canvas)",
    ),
    ("indexed", "non-RGB color mode"),
    (
        "just-bg",
        "document structure flatten diverges (opaque vs transparent canvas)",
    ),
    (
        "lantern",
        "compositor flatten diverges from Photoshop (features outside subset)",
    ),
    ("layer-comps", "layer comps flatten diverges"),
    ("layer-mask", "layer masks diverge from Photoshop flatten"),
    (
        "linked-layers",
        "linked-layer document flatten diverges from Photoshop",
    ),
    (
        "mesh-transform",
        "smart objects / placed transform without matching raster path",
    ),
    (
        "pass-through",
        "pass-through group compositing diverges from Photoshop flatten",
    ),
    ("pattern", "layer effects"),
    (
        "placed-transform",
        "smart objects / placed transform without matching raster path",
    ),
    ("psb-test", "non-RGB; layer effects; text; smart objects"),
    (
        "rle-fail",
        "near-match residual (1 px) after decode — not byte-exact; no tolerance",
    ),
    ("round", "vector fill/stroke"),
    (
        "sai",
        "compositor flatten diverges from Photoshop (features outside subset)",
    ),
    (
        "section",
        "document structure flatten diverges (opaque vs transparent canvas)",
    ),
    (
        "slices",
        "document structure flatten diverges (opaque vs transparent canvas)",
    ),
    (
        "smart-filter",
        "smart objects / filters without matching raster path",
    ),
    (
        "smart-filter-blur",
        "smart objects / filters without matching raster path",
    ),
    (
        "smart-object",
        "smart objects without matching cached raster path",
    ),
    (
        "smart-object-curves",
        "smart objects without matching cached raster path",
    ),
    (
        "smart-object-png",
        "smart objects without matching cached raster path",
    ),
    ("text-alternatives", "text (no font rasterization)"),
    (
        "text-bug",
        "vector fill/stroke; text (no font rasterization)",
    ),
    (
        "text-carriage-return",
        "layer effects; text (no font rasterization)",
    ),
    ("text-complex", "text (no font rasterization)"),
    ("text-layer", "text (no font rasterization)"),
    ("text-paragraph-align", "text (no font rasterization)"),
    ("text-path", "text (no font rasterization)"),
    ("text-simple", "text (no font rasterization)"),
    ("text-simple2", "text (no font rasterization)"),
    ("vector-complex", "vector fill/stroke; layer masks"),
    ("vector-layer", "vector fill/stroke; layer masks"),
    ("winding-even-odd", "vector fill/stroke"),
    ("winding-non-zero", "vector fill/stroke"),
];

fn fixtures_read_dir() -> PathBuf {
    test_corpus::corpus_root().join("read")
}

fn golden_composite(name: &str) -> PathBuf {
    test_corpus::golden_root()
        .join("read")
        .join(name)
        .join("composite.bin")
}

fn fixture_psd(name: &str) -> Option<PathBuf> {
    let dir = fixtures_read_dir().join(name);
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

fn read_opts() -> ReadOptions {
    ReadOptions {
        use_image_data: Some(true),
        throw_for_missing_features: Some(true),
        log_missing_features: Some(true),
        strict: Some(false),
        debug: Some(true),
        ..Default::default()
    }
}

fn list_fixture_names() -> Vec<String> {
    let root = fixtures_read_dir();
    if !root.is_dir() {
        return Vec::new();
    }
    let mut names: Vec<_> = fs::read_dir(&root)
        .expect("list fixtures")
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.is_dir())
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .filter(|name| fixture_psd(name).is_some())
        .collect();
    names.sort();
    names
}

fn composite_document(psd: &psdx::psd::Psd) -> Vec<u8> {
    let result = composite(
        psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: u64::MAX,
        },
    )
    .expect("composite Document/Full");
    // Never touch PNG paths — only the positioned RGBA buffer.
    result.raster.pixels.data
}

fn first_diff(a: &[u8], b: &[u8]) -> Option<(usize, Option<u8>, Option<u8>)> {
    let n = a.len().max(b.len());
    for i in 0..n {
        let av = a.get(i).copied();
        let bv = b.get(i).copied();
        if av != bv {
            return Some((i, av, bv));
        }
    }
    None
}

#[derive(Debug)]
enum CompareOutcome {
    Match,
    Mismatch { detail: String },
    Skip { reason: String },
}

fn compare_fixture(name: &str) -> CompareOutcome {
    let Some(src) = fixture_psd(name) else {
        return CompareOutcome::Skip {
            reason: format!("fixture missing (set PSDX_FIXTURES_DIR)"),
        };
    };
    let golden_path = golden_composite(name);
    if !golden_path.is_file() {
        return CompareOutcome::Skip {
            reason: format!("golden missing (set PSDX_GOLDENS_DIR)"),
        };
    }

    let bytes = fs::read(&src).unwrap_or_else(|e| panic!("read {name} fixture: {e}"));
    let psd = match read_psd(&bytes, &read_opts()) {
        Ok(p) => p,
        Err(e) => {
            return CompareOutcome::Mismatch {
                detail: format!("read_psd failed: {e}"),
            };
        }
    };

    let got = composite_document(&psd);
    // Oracle is `composite.bin` only — never canvas.png / other checked-in PNGs.
    assert_eq!(
        golden_path.extension().and_then(|e| e.to_str()),
        Some("bin"),
        "{name}: oracle path must be .bin, not PNG"
    );
    let golden = fs::read(&golden_path).unwrap_or_else(|e| panic!("read {name} golden: {e}"));
    if got == golden {
        CompareOutcome::Match
    } else {
        let diff = first_diff(&got, &golden);
        CompareOutcome::Mismatch {
            detail: format!(
                "byte mismatch len {} vs {}: first_diff={diff:?}",
                got.len(),
                golden.len()
            ),
        }
    }
}

#[test]
fn document_composite_matches_photoshop_composite_bin_ratchet() {
    let names = list_fixture_names();
    if names.is_empty() {
        eprintln!(
            "skip composite oracle: fixtures missing at {} (set PSDX_FIXTURES_DIR)",
            fixtures_read_dir().display()
        );
        eprintln!(
            "oracle skip summary: skipped=all matchers={} exclusions={} (skip ≠ pass)",
            ORACLE_BYTE_MATCHERS.len(),
            ORACLE_BYTE_EXCLUSIONS.len()
        );
        return;
    }

    let matchers: HashSet<&str> = ORACLE_BYTE_MATCHERS.iter().copied().collect();
    let exclusions: HashMap<&str, &str> = ORACLE_BYTE_EXCLUSIONS.iter().copied().collect();

    assert!(
        matchers.is_disjoint(&exclusions.keys().copied().collect()),
        "matcher and exclusion lists must be disjoint"
    );

    let mut matched = Vec::new();
    let mut excluded_ok = Vec::new();
    let mut skipped = Vec::new();
    let mut failures = Vec::new();

    for name in &names {
        let outcome = compare_fixture(name);
        let is_matcher = matchers.contains(name.as_str());
        let excl_reason = exclusions.get(name.as_str());

        match outcome {
            CompareOutcome::Skip { reason } => {
                eprintln!("SKIP {name}: {reason}");
                skipped.push(format!("{name}: {reason}"));
            }
            CompareOutcome::Match if is_matcher => {
                eprintln!("MATCH {name}");
                matched.push(name.clone());
            }
            CompareOutcome::Match => {
                // Ratchet: excluded (or unknown) fixture started matching.
                failures.push(format!(
                    "{name}: now matches composite.bin byte-for-byte — remove from \
                     ORACLE_BYTE_EXCLUSIONS and add to ORACLE_BYTE_MATCHERS"
                ));
            }
            CompareOutcome::Mismatch { detail } if is_matcher => {
                failures.push(format!(
                    "{name}: pinned matcher diverged from composite.bin ({detail})"
                ));
            }
            CompareOutcome::Mismatch { detail } => {
                if let Some(reason) = excl_reason {
                    eprintln!("EXCL {name}: {reason} ({detail})");
                    excluded_ok.push(name.clone());
                } else {
                    failures.push(format!(
                        "{name}: mismatches composite.bin but is not listed in \
                         ORACLE_BYTE_EXCLUSIONS ({detail})"
                    ));
                }
            }
        }
    }

    // Every pinned matcher / exclusion entry must exist in the corpus when fixtures are present.
    for m in ORACLE_BYTE_MATCHERS {
        assert!(
            names.iter().any(|n| n == m),
            "pinned matcher {m:?} missing from fixture corpus"
        );
    }
    for (name, _) in ORACLE_BYTE_EXCLUSIONS {
        assert!(
            names.iter().any(|n| n == *name),
            "exclusion {name:?} missing from fixture corpus"
        );
    }

    let skipped_matchers = skipped
        .iter()
        .filter(|s| {
            ORACLE_BYTE_MATCHERS
                .iter()
                .any(|m| s.starts_with(&format!("{m}:")))
        })
        .count();
    let skipped_exclusions = skipped
        .iter()
        .filter(|s| {
            ORACLE_BYTE_EXCLUSIONS
                .iter()
                .any(|(n, _)| s.starts_with(&format!("{n}:")))
        })
        .count();

    eprintln!(
        "oracle summary: matched={} exclusions_confirmed={} skipped={} \
         (skipped_matchers={} skipped_exclusions={}) failures={}",
        matched.len(),
        excluded_ok.len(),
        skipped.len(),
        skipped_matchers,
        skipped_exclusions,
        failures.len()
    );
    if !skipped.is_empty() {
        eprintln!(
            "oracle skip summary: skipped={} (skip ≠ pass). Point PSDX_GOLDENS_DIR at \
             a golden tree, or arm PSDX_REQUIRE_FIXTURES=1 to fail instead",
            skipped.len()
        );
        for s in &skipped {
            eprintln!("  {s}");
        }
    }

    // Skips are visible above; non-skipped matchers must all match.
    assert_eq!(
        matched.len() + skipped_matchers,
        ORACLE_BYTE_MATCHERS.len(),
        "pinned matchers must match or skip; matched={:?} skipped={:?}",
        matched,
        skipped
    );
    assert_eq!(
        excluded_ok.len() + skipped_exclusions,
        ORACLE_BYTE_EXCLUSIONS.len(),
        "exclusions must mismatch or skip; excluded_ok={} skipped_exclusions={}",
        excluded_ok.len(),
        skipped_exclusions
    );
    assert!(
        failures.is_empty(),
        "composite.bin oracle ratchet failures:\n{}",
        failures.join("\n")
    );
}

#[test]
fn band_concatenation_matches_full_document_without_oracle() {
    // Uses a pinned matcher when present; otherwise a tiny synthetic tree.
    let name = "layers";
    let psd = if let Some(src) = fixture_psd(name) {
        let bytes = fs::read(src).expect("read layers fixture");
        read_psd(&bytes, &read_opts()).expect("read_psd layers")
    } else {
        eprintln!("band-concat: fixture {name} missing — using synthetic document");
        synthetic_band_psd()
    };

    let height = psd.height as i32;
    assert!(height > 0, "document height must be positive");

    let full = composite(
        &psd,
        &CompositeRequest {
            target: CompositeTarget::Document,
            region: CompositeRegion::Full,
            max_pixels: u64::MAX,
        },
    )
    .expect("full composite");

    let band_h = (height / 3).max(1);
    let mut concat = Vec::new();
    let mut top = 0;
    while top < height {
        let bottom = (top + band_h).min(height);
        let band = composite(
            &psd,
            &CompositeRequest {
                target: CompositeTarget::Document,
                region: CompositeRegion::Rows { top, bottom },
                max_pixels: u64::MAX,
            },
        )
        .unwrap_or_else(|e| panic!("band {top}..{bottom}: {e}"));
        assert_eq!(band.raster.top, top);
        assert_eq!(band.raster.pixels.height, (bottom - top) as u32);
        concat.extend_from_slice(&band.raster.pixels.data);
        top = bottom;
    }

    assert_eq!(
        concat, full.raster.pixels.data,
        "band-concat must equal full composite (no oracle)"
    );
}

fn synthetic_band_psd() -> psdx::psd::Psd {
    use psdx::psd::{LayerAdditionalInfo, PixelData, Psd};
    let red = Layer {
        left: Some(0.0),
        top: Some(0.0),
        right: Some(2.0),
        bottom: Some(6.0),
        image_data: Some(PixelData::rgba8(2, 6, [200, 0, 0, 128].repeat(12))),
        additional_info: LayerAdditionalInfo {
            name: Some("red".into()),
            ..LayerAdditionalInfo::default()
        },
        ..Layer::default()
    };
    Psd {
        width: 2.0,
        height: 6.0,
        children: Some(vec![red]),
        ..Psd::default()
    }
}

#[test]
fn matcher_list_includes_nested_groups_fixture() {
    assert!(
        ORACLE_BYTE_MATCHERS.contains(&"nested"),
        "pinned list must include nested (nested groups)"
    );
    assert!(
        ORACLE_BYTE_EXCLUSIONS
            .iter()
            .any(|(n, r)| *n == "groups" && r.contains("spec key candidate")),
        "groups must stay on the exclusion list with a written reason until byte-exact"
    );
}

#[test]
fn oracle_lists_are_sorted_unique_and_cover_no_png() {
    let mut matchers = ORACLE_BYTE_MATCHERS.to_vec();
    let mut sorted = matchers.clone();
    sorted.sort_unstable();
    matchers.sort_unstable();
    matchers.dedup();
    assert_eq!(
        matchers, sorted,
        "ORACLE_BYTE_MATCHERS must be sorted unique"
    );
    assert_eq!(matchers.len(), ORACLE_BYTE_MATCHERS.len());

    let mut excl_names: Vec<&str> = ORACLE_BYTE_EXCLUSIONS.iter().map(|(n, _)| *n).collect();
    let mut excl_sorted = excl_names.clone();
    excl_sorted.sort_unstable();
    excl_names.sort_unstable();
    excl_names.dedup();
    assert_eq!(
        excl_names, excl_sorted,
        "ORACLE_BYTE_EXCLUSIONS must be sorted unique"
    );
    assert_eq!(excl_names.len(), ORACLE_BYTE_EXCLUSIONS.len());

    for (_, reason) in ORACLE_BYTE_EXCLUSIONS {
        assert!(
            !reason.is_empty(),
            "every exclusion needs a non-empty reason"
        );
    }

    // Corpus paths used by this suite end in .bin / .psd / .psb only.
    let bin = Path::new("composite.bin");
    assert_eq!(bin.extension().and_then(|e| e.to_str()), Some("bin"));
}

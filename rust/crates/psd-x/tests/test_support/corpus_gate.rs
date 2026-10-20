//! The one test that fails when the read corpus is missing.
//!
//! Every other fixture-gated test returns early when the corpus is absent, and
//! Rust has no skip state, so each of those returns is reported as a **pass**.
//! Without this gate the suite is green whether it read the corpus or nothing
//! at all — and it currently reads nothing, because the corpus is not
//! committed.
//!
//! Unarmed, this test only prints what it found. Arm it to make absence fail:
//!
//! ```text
//! PSDX_REQUIRE_FIXTURES=1 cargo test -p psdx --features test-support --test test_support corpus_gate
//! ```
//!
//! That is the qualification form. A green `cargo test -p psdx` without it
//! proves the crate compiles, not that it still parses PSD files correctly.

use psdx::test_corpus;
use std::path::Path;

/// Documents worth resolving before calling a corpus usable.
///
/// Not the whole corpus — a spot check across the shapes the suite leans on
/// hardest, so a truncated or half-copied tree fails here rather than as 24
/// separate silent skips.
const SPOT_CHECK: &[&str] = &[
    "text",
    "text-box",
    "layers",
    "layer-mask",
    "smart-object",
    "16bits",
    "32bits",
];

fn count_documents(read_root: &Path) -> usize {
    let Ok(entries) = std::fs::read_dir(read_root) else {
        return 0;
    };
    entries
        .flatten()
        .filter(|e| e.path().join("src.psd").is_file())
        .count()
}

#[test]
fn corpus_is_present_when_required() {
    let corpus = test_corpus::corpus_root();
    let goldens = test_corpus::golden_root();
    let read_root = corpus.join("read");
    let documents = count_documents(&read_root);
    let missing: Vec<&str> = SPOT_CHECK
        .iter()
        .copied()
        .filter(|name| !read_root.join(name).join("src.psd").is_file())
        .collect();

    eprintln!("corpus   {} ({documents} documents)", corpus.display());
    eprintln!("goldens  {}", goldens.display());
    if !missing.is_empty() {
        eprintln!("missing  {}", missing.join(", "));
    }

    if !test_corpus::required() {
        eprintln!(
            "gate unarmed — set {}=1 to make a missing corpus fail",
            test_corpus::REQUIRE_ENV
        );
        return;
    }

    assert!(
        corpus.is_dir(),
        "corpus root does not exist: {}\nset {} to an existing copy",
        corpus.display(),
        test_corpus::FIXTURES_DIR_ENV
    );
    assert!(
        documents > 0,
        "corpus at {} has no read/<name>/src.psd documents",
        corpus.display()
    );
    assert!(
        missing.is_empty(),
        "corpus at {} is incomplete, missing: {}",
        corpus.display(),
        missing.join(", ")
    );
    assert!(
        goldens.is_dir(),
        "golden root does not exist: {}\nset {} to an existing copy",
        goldens.display(),
        test_corpus::GOLDENS_DIR_ENV
    );
}

/// The resolver must not silently accept a relocation that points nowhere.
///
/// Pointing `PSDX_FIXTURES_DIR` at a typo is the likeliest way to re-enter the
/// state this gate exists to catch, so an override that resolves to nothing is
/// worth the same failure as no corpus at all.
#[test]
fn override_pointing_nowhere_is_not_silently_accepted() {
    // The skip policy (silent when unarmed, fail-loud when armed) lives in
    // test_corpus::fixture_dir_override, the single home for corpus env rules.
    let Some(_) = test_corpus::fixture_dir_override() else {
        return;
    };
    let corpus = test_corpus::corpus_root();
    assert!(
        corpus.is_dir(),
        "{} points at {}, which does not exist",
        test_corpus::FIXTURES_DIR_ENV,
        corpus.display()
    );
}

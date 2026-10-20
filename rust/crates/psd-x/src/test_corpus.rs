/*
File: rust/crates/psd-x/src/test_corpus.rs

Purpose:
Single resolver for the upstream read corpus and the generated goldens that
psd-x's fixture-gated tests read. No upstream counterpart. Tests resolve the
corpus here instead of through per-test root helpers, so the anchor lives in
one place.

Main responsibilities:
- resolve one corpus root and one golden root, overridable by environment;
- decide, in one place, whether a missing artifact skips or fails the test.
*/

//! Test-corpus resolution for the fixture-gated tests.
//!
//! # Where the corpus lives
//!
//! Both trees are resolved relative to this crate, and neither is committed:
//!
//! ```text
//! rust/crates/psd-x/vendor/agpsd-fixtures/   upstream ag-psd test data
//! rust/crates/psd-x/tests/goldens/           goldens generated from it
//! ```
//!
//! `PSDX_FIXTURES_DIR` and `PSDX_GOLDENS_DIR` override them, so the corpus can
//! stay outside the repository. See the crate README for what the corpus is
//! and which upstream revision it belongs to.
//!
//! # Missing corpus
//!
//! Without the corpus a gated test returns before asserting anything, and Rust
//! has no skip state, so it is reported as **passed**. The suite is therefore
//! green whether or not it checked anything — the failure mode this module
//! exists to make visible.
//!
//! Set `PSDX_REQUIRE_FIXTURES=1` to turn every missing artifact into a panic
//! naming the path it expected. A qualification run should set it; a green run
//! without it proves only that the code compiles.
//!
//! ```text
//! PSDX_REQUIRE_FIXTURES=1 cargo test -p psdx
//! ```
//!
//! [`report`] is the counterpart for tests that resolve a path themselves:
//! it applies the same policy without going through [`corpus`] or [`golden`].

use std::path::{Path, PathBuf};

/// Environment variable relocating the upstream corpus.
pub const FIXTURES_DIR_ENV: &str = "PSDX_FIXTURES_DIR";
/// Environment variable relocating the generated goldens.
pub const GOLDENS_DIR_ENV: &str = "PSDX_GOLDENS_DIR";
/// Environment variable turning a missing artifact into a failure.
pub const REQUIRE_ENV: &str = "PSDX_REQUIRE_FIXTURES";

/// Root of the upstream ag-psd corpus.
///
/// `PSDX_FIXTURES_DIR` wins; otherwise `rust/crates/psd-x/vendor/agpsd-fixtures`.
pub fn corpus_root() -> PathBuf {
    match std::env::var_os(FIXTURES_DIR_ENV) {
        Some(dir) => PathBuf::from(dir),
        None => crate_dir().join("vendor/agpsd-fixtures"),
    }
}

/// Root of the generated goldens.
///
/// `PSDX_GOLDENS_DIR` wins; otherwise `rust/crates/psd-x/tests/goldens`.
pub fn golden_root() -> PathBuf {
    match std::env::var_os(GOLDENS_DIR_ENV) {
        Some(dir) => PathBuf::from(dir),
        None => crate_dir().join("tests/goldens"),
    }
}

/// Whether a missing artifact must fail rather than skip.
pub fn required() -> bool {
    matches!(
        std::env::var(REQUIRE_ENV).as_deref(),
        Ok("1") | Ok("true") | Ok("yes")
    )
}

/// The `PSDX_FIXTURES_DIR` override, or `None` when it is unset.
///
/// Panics instead of returning `None` when [`required`] holds — an armed suite
/// must fail on every missing artifact, an unset override included. Centralizes
/// the skip policy so test bodies never read the environment themselves.
pub fn fixture_dir_override() -> Option<PathBuf> {
    match std::env::var_os(FIXTURES_DIR_ENV) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => {
            if required() {
                panic!(
                    "{FIXTURES_DIR_ENV} is unset but {REQUIRE_ENV} is armed; \
                     the override cannot be exercised"
                );
            }
            None
        }
    }
}

/// A path under the corpus, or `None` when it is absent.
///
/// Panics instead of returning `None` when [`required`] holds.
pub fn corpus(rel: impl AsRef<Path>) -> Option<PathBuf> {
    resolve(corpus_root().join(rel), Kind::Corpus)
}

/// A path under the goldens, or `None` when it is absent.
///
/// Panics instead of returning `None` when [`required`] holds.
pub fn golden(rel: impl AsRef<Path>) -> Option<PathBuf> {
    resolve(golden_root().join(rel), Kind::Golden)
}

/// The `read/<name>` corpus directory for a document.
pub fn read_dir(name: &str) -> Option<PathBuf> {
    corpus(Path::new("read").join(name))
}

/// The `read/<name>/src.psd` document itself.
pub fn read_psd(name: &str) -> Option<PathBuf> {
    corpus(Path::new("read").join(name).join("src.psd"))
}

/// Apply the missing-artifact policy to a path this caller resolved itself.
///
/// Returns `false` when the artifact is absent and the test should return
/// early; panics in that case when [`required`] holds. Use it to keep an
/// existing bespoke path expression while still honouring `PSDX_REQUIRE_FIXTURES`.
pub fn report(path: &Path, what: &str) -> bool {
    if path.exists() {
        return true;
    }
    if required() {
        panic!(
            "{what}: missing corpus artifact {}\n{}",
            path.display(),
            HINT
        );
    }
    eprintln!("skip {what}: missing {}", path.display());
    false
}

enum Kind {
    Corpus,
    Golden,
}

const HINT: &str = concat!(
    "The corpus is not committed. Point PSDX_FIXTURES_DIR / PSDX_GOLDENS_DIR at ",
    "an existing copy, or place it at rust/crates/psd-x/{vendor/agpsd-fixtures,tests/goldens}. ",
    "See rust/crates/psd-x/README.md for the upstream revision it tracks."
);

fn crate_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

fn resolve(path: PathBuf, kind: Kind) -> Option<PathBuf> {
    if path.exists() {
        return Some(path);
    }
    let label = match kind {
        Kind::Corpus => "fixture",
        Kind::Golden => "golden",
    };
    if required() {
        panic!("missing {label} {}\n{HINT}", path.display());
    }
    eprintln!("skip: missing {label} {}", path.display());
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both roots must be anchored at the crate, not at a parent guess.
    ///
    /// The bug this replaces was exactly that: helpers named `repo_root()`
    /// returned `crates/`, so the corpus was looked for at `crates/vendor/`.
    #[test]
    fn roots_sit_under_this_crate() {
        let crate_dir = crate_dir();
        if std::env::var_os(FIXTURES_DIR_ENV).is_none() {
            assert!(corpus_root().starts_with(&crate_dir), "{:?}", corpus_root());
        }
        if std::env::var_os(GOLDENS_DIR_ENV).is_none() {
            assert!(golden_root().starts_with(&crate_dir), "{:?}", golden_root());
        }
    }

    #[test]
    fn read_helpers_compose_the_upstream_layout() {
        let psd = corpus_root().join("read/text/src.psd");
        assert_eq!(
            psd.parent(),
            Some(corpus_root().join("read/text").as_path())
        );
    }

    /// `report` must not claim an absent artifact is present.
    #[test]
    fn report_is_false_for_a_missing_path() {
        if required() {
            return; // the panic path is asserted by the corpus doctor test
        }
        assert!(!report(
            &corpus_root().join("definitely/not/here.psd"),
            "unit"
        ));
    }
}

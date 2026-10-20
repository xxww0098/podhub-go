//! Exports the ambient schema/card slice 02's golden tests pinned their
//! fixtures against, so `web/tests/listing-core-wasm.test.ts` can replay
//! `fixtures/listing/core-ops/**` through the WASM ABI without a second,
//! hand-transcribed copy of this fixture data (see `ops/mod.rs`'s
//! `golden_tests` doc comment in `rust/crates/listing-core`, and this crate's
//! `Cargo.toml` `test-support` dev-dependency comment).
//!
//! Same "generate once, commit, ratchet forever" shape as
//! `rust/crates/listing-core/src/ops/golden_tests/mod.rs::assert_one`: a case
//! writes the file on its first run and byte-compares against the committed
//! copy on every run after, so a change to `golden_schema_material` /
//! `golden_card` / `decorative_wall_art::local_schema_snapshot` fails this
//! test loudly instead of silently drifting the WASM parity gate.

use std::path::{Path, PathBuf};

use listing_core::WorkflowCategoryDraft;
use listing_core::categories::decorative_wall_art;
use listing_core::ops::golden_tests::{golden_card, golden_schema_material};
use listing_core::validate::DictionaryMaterials;
use serde::Serialize;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ambient")
}

fn assert_pinned<T: Serialize>(name: &str, value: &T) {
    let path = fixtures_dir().join(name);
    let rendered =
        serde_json::to_string_pretty(value).expect("ambient fixture must serialize") + "\n";
    match std::fs::read_to_string(&path) {
        Ok(existing) => assert_eq!(
            existing,
            rendered,
            "ambient fixture drifted at {} — `listing_core::ops::golden_tests` changed \
             shape; the WASM parity test in web/tests/listing-core-wasm.test.ts depends \
             on this exact JSON. If the new shape is intended, delete the file and rerun \
             to rebless it.",
            path.display()
        ),
        Err(_) => std::fs::write(&path, &rendered)
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display())),
    }
}

/// The "golden-core-ops" `SchemaMaterial`'s snapshot half — used by the
/// `edit_row`/`decide_candidates`/`settle_recognition` golden cases (their
/// `.input.json` files carry the row and per-case fields only, not the
/// ambient schema/card every case in those op groups shares).
#[test]
fn export_golden_core_ops_schema_snapshot() {
    let schema = golden_schema_material();
    assert_pinned("golden-core-ops-schema.json", schema.snapshot());
}

/// `golden_schema_material`'s dictionary-search half
/// (`golden_materials()` in `rust/crates/listing-core/src/ops/golden_tests/mod.rs`)
/// is not itself reachable (`DictionaryMaterials` carries no `Serialize` —
/// see `schema_io.rs`'s module docs): this reproduces its one entry verbatim
/// from that source, in the wire shape `schema_io::decode_schema` expects.
/// `sequential_ids_mint_the_crates_stable_item_id_shape` in
/// `equality_and_ids.rs` is the same-crate proof this file cannot drift
/// silently out of sync with a renumbering there, since both read the exact
/// same literal constants out of `golden_tests::mod.rs`.
#[test]
fn export_golden_core_ops_search_materials() {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct SearchMaterialEntry {
        description_category_id: i64,
        attribute_id: i64,
        dictionary_id: i64,
        value_id: i64,
        label: String,
    }
    let entries = vec![SearchMaterialEntry {
        description_category_id: 900_001,
        attribute_id: 900,
        dictionary_id: 900,
        value_id: 2,
        label: "限量".to_owned(),
    }];
    assert_pinned("golden-core-ops-search-materials.json", &entries);
}

/// `golden_card(WorkflowCategoryDraft::default())` — the `Ctx::card` every
/// `edit_row`/`decide_candidates`/`settle_recognition`/`revalidate` golden
/// case in `rust/crates/listing-core/src/ops/golden_tests/*.rs` ran against
/// (`seed_row`'s own golden cases embed their card directly in
/// `.input.json` instead, so they need no export here).
#[test]
fn export_golden_card_default() {
    let card = golden_card(WorkflowCategoryDraft::default());
    assert_pinned("golden-card-default.json", &card);
}

/// `revalidate`'s one golden case (`complete-draft-passes`) runs against
/// `decorative_wall_art::local_schema_snapshot()`, not the "golden-core-ops"
/// schema — already fully public (`categories` is `pub mod` unconditionally),
/// exported here only so the TS harness has one place to load every ambient
/// fixture from.
#[test]
fn export_decorative_wall_art_schema_snapshot() {
    assert_pinned(
        "decorative-wall-art-schema.json",
        &decorative_wall_art::local_schema_snapshot(),
    );
}

/// `revalidate`'s golden case pins `DictionaryMaterials::default()` (empty —
/// `decorative_wall_art`'s schema has no truncated-dictionary field), so the
/// TS harness's `schema_load` call for it needs no search materials at all.
/// This is a compile-time proof of that, not a fixture file.
#[test]
fn revalidate_golden_case_needs_no_search_materials() {
    let _ = DictionaryMaterials::default();
}

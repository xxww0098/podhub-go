//! A larger native↔WASM parity corpus than slice 02's 12 golden cases, per
//! slice 03's verification gate: "另拿开发库里现有的行 payload 批量跑 native
//! 与 wasm...dev 库行数不足就用金标生成器扩样". This crate's tests do not
//! stand up a database, so this generates the "扩样" instead, reusing the
//! exact same generator building blocks slice 02's own golden tests use —
//! `decorative_wall_art`'s real Ozon category schema (not a synthetic one) plus
//! `compose::compose_tests::{golden_card, golden_draft_values}`, the same
//! fixture `revalidate_and_media.rs`'s `fully_valid_row` composes from.
//!
//! [`SAMPLE_COUNT`] rows, each seeded from a Card (varying name/price/offer_id/
//! description) and then revalidated to a `Passed` verdict with real
//! evidence — both steps' native output pinned the same "generate once,
//! commit, ratchet forever" way as `golden_fixture_export.rs`.
//! `web/tests/listing-core-wasm.test.ts` replays every one through the WASM
//! ABI and diffs against these files.

use std::path::{Path, PathBuf};

use listing_core::categories::decorative_wall_art;
use listing_core::compose::compose_tests::golden_card;
use listing_core::envelope::RowSource;
use listing_core::ops::{self, Ctx, SchemaMaterial};
use listing_core::validate::DictionaryMaterials;
use listing_core::{WorkflowCategoryDraft, WorkflowDraftValue};
use serde::Serialize;
use serde_json::json;

/// Comfortably more than the 12 pinned golden cases without bloating the repo
/// (~2.5 KB/row pinned × 2 ops × 50 ≈ 250 KB, the same order of magnitude as
/// slice 02's own 12-case fixture set).
const SAMPLE_COUNT: usize = 50;

fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/synthetic")
}

fn synthetic_draft(index: usize) -> WorkflowCategoryDraft {
    let mut draft = WorkflowCategoryDraft::default();
    draft.values.insert(
        "offer_id".to_owned(),
        WorkflowDraftValue::Text(format!("SYN-{index:03}")),
    );
    // Pure Cyrillic — `validate_name` (`rust/crates/listing-core/src/validate.rs`)
    // rejects Han characters at `revalidate` time (unlike `seed_row`, which
    // never validates); this batch is revalidated, so it must pass that rule
    // to reach `Passed` and mint real evidence.
    draft.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text(format!("Настенная роспись №{index}")),
    );
    draft.values.insert(
        "description".to_owned(),
        WorkflowDraftValue::Text(format!(
            "Синтетический образец #{index} для сопоставления native↔WASM."
        )),
    );
    draft.values.insert(
        "price".to_owned(),
        WorkflowDraftValue::Text(format!("{}.{:02}", 100 + index, (index * 7) % 100)),
    );
    draft
}

#[test]
fn export_synthetic_seed_row_and_revalidate_batch() {
    let snapshot = decorative_wall_art::local_schema_snapshot();
    let schema = SchemaMaterial::new(
        std::sync::Arc::new(snapshot),
        DictionaryMaterials::default(),
    );
    let card = golden_card();
    let dir = fixtures_dir();
    std::fs::create_dir_all(dir.join("seed_row")).expect("create seed_row synthetic dir");
    std::fs::create_dir_all(dir.join("revalidate")).expect("create revalidate synthetic dir");

    for index in 0..SAMPLE_COUNT {
        // `seed_row`/`revalidate` never call `ctx.ids` (only `edit_row` does —
        // see `rust/crates/listing-core/src/ops/edit.rs`), so a no-op stands in.
        let mut ids = || [0u8; 16];
        let source = RowSource {
            asset_id: String::new(),
            sha256: format!("sha256:synthetic-{index:03}"),
            file_name: format!("synthetic-{index:03}.psd"),
        };
        let draft = synthetic_draft(index);
        let seed_ctx = Ctx {
            schema: &schema,
            card: Some(&card),
            now_ms: 1_700_000_100_000 + index as u64,
            ids: &mut ids,
        };
        let seeded = ops::seed_row(&seed_ctx, source.clone(), Some(draft.clone()));
        write_pinned(
            &dir.join("seed_row")
                .join(format!("syn-{index:03}.input.json")),
            &json!({"card": &card, "source": &source, "suppliedDraft": &draft}),
        );
        write_pinned(
            &dir.join("seed_row")
                .join(format!("syn-{index:03}.output.json")),
            &seeded,
        );

        let mut ids = || [0u8; 16];
        let revalidate_ctx = Ctx {
            schema: &schema,
            card: Some(&card),
            now_ms: 1_700_000_100_000 + index as u64,
            ids: &mut ids,
        };
        let edited = ops::revalidate(&revalidate_ctx, seeded.clone());
        assert_eq!(
            format!("{:?}", edited.verdict.fact),
            "Passed",
            "synthetic case {index} must revalidate to Passed — the batch is only a \
             meaningful native↔WASM parity sample if the rule engine actually runs \
             every branch (evidence, content_ready), not just the seed path"
        );
        write_pinned(
            &dir.join("revalidate")
                .join(format!("syn-{index:03}.input.json")),
            &seeded,
        );
        write_pinned(
            &dir.join("revalidate")
                .join(format!("syn-{index:03}.output.json")),
            &json!({
                "row": &edited.row,
                "fact": format!("{:?}", edited.verdict.fact),
                "contentReady": edited.verdict.content_ready,
                "evidenceDigest": edited.verdict.evidence.as_ref().map(|evidence| evidence.digest.clone()),
            }),
        );
    }
}

fn write_pinned<T: Serialize>(path: &Path, value: &T) {
    let rendered =
        serde_json::to_string_pretty(value).expect("synthetic fixture must serialize") + "\n";
    match std::fs::read_to_string(path) {
        Ok(existing) => assert_eq!(
            existing,
            rendered,
            "synthetic fixture drifted at {} — delete and rerun to rebless if intended",
            path.display()
        ),
        Err(_) => std::fs::write(path, &rendered)
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display())),
    }
}

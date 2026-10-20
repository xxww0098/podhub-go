//! Golden fixtures for every op in this module (browser-owned-listing slice
//! 02, "验证门": `cargo test -p listing-core ops::` byte-exact).
//!
//! Each case writes `fixtures/listing/core-ops/<op>/<case>.input.json` and
//! `<case>.output.json` on its first run and byte-compares against the
//! committed file on every run after — the same "generate once, commit,
//! ratchet forever" shape `compose_tests.rs`'s `PINNED_REQUEST_DIGEST` and
//! `plan.rs`'s `assert_plan_goldens` already use elsewhere in this crate, and
//! `rust/crates/psd-x`'s `bless_font_goldens` for the same repo-wide pattern.
//! The native↔WASM golden comparison (`listing-core-wasm`) runs these same
//! ops against the same JSON shapes across the WASM boundary, so a drift here
//! is a drift local.
//!
//! One case module per op (AGENTS.md's 500-line file limit): this file only
//! holds the fixture schema every case shares and the golden-assertion
//! helpers; `seed_row.rs`, `edit_row.rs`, `candidates_and_recognition.rs`,
//! `revalidate_and_media.rs` and `equality_and_ids.rs` hold the `#[test]`s.
//! `legacy_row.rs` drives `edit_row` over rows saved before the system media
//! write guard with behaviour assertions only; it writes no golden file.

#[cfg(test)]
use std::path::{Path, PathBuf};

#[cfg(test)]
use serde::Serialize;

use crate::WorkflowLanguage;
use crate::envelope::CardPayload;
use crate::records::{
    CategorySchemaSnapshot, ListingFieldConstraints, ListingFieldDefinition, ListingFieldEditor,
    ListingFieldOption,
};
use crate::validate::DictionaryMaterials;
use crate::workflow_dto::types::{WorkflowAiFieldPolicy, WorkflowCategoryDraft};

use super::SchemaMaterial;

// The cases are `#[test]`s; only the fixture builders above them are the
// `test-support` surface `listing-core-wasm` replays.
#[cfg(test)]
mod candidates_and_recognition;
#[cfg(test)]
mod edit_row;
#[cfg(test)]
mod equality_and_ids;
#[cfg(test)]
mod legacy_row;
#[cfg(test)]
mod revalidate_and_media;
#[cfg(test)]
mod seed_row;

const DESCRIPTION_CATEGORY_ID: i64 = 900_001;
const TYPE_ID: i64 = 5_001;
const TAGS_DICTIONARY_ID: i64 = 900;

/// One custom schema shared by every case: `offer_id` / `name` / `price` earn
/// the crate's field-specific validation rules (so a case can exercise a
/// realistic pass/fail verdict, not just generic editor checks); `tags` is a
/// truncated `MultiSelect` dictionary field (one inline option, a second
/// resolvable only through `DictionaryMaterials`' search half — the
/// "截断字典" case); `size`/`color` form a two-field complex group (the
/// "复杂字段顺序" case). `decorative_wall_art::local_schema_snapshot` (this
/// crate's other shared test fixture) has neither a dictionary field nor a
/// complex group, so this slice needs its own.
fn golden_schema_snapshot() -> CategorySchemaSnapshot {
    CategorySchemaSnapshot {
        category_key: "golden-core-ops".to_owned(),
        label: "测试类目".to_owned(),
        description_category_id: DESCRIPTION_CATEGORY_ID,
        type_id: TYPE_ID,
        schema_revision: "golden-v1".to_owned(),
        recipe_id: 0,
        recipe_revision: 1,
        catalog_schema_version: 1,
        fields: vec![
            ListingFieldDefinition::plain(
                "offer_id",
                "Offer ID",
                "基础",
                ListingFieldEditor::Text,
                true,
            ),
            ListingFieldDefinition::plain(
                "name",
                "商品名称",
                "基础",
                ListingFieldEditor::Text,
                true,
            ),
            ListingFieldDefinition::plain(
                "price",
                "价格 (RUB)",
                "基础",
                ListingFieldEditor::Decimal,
                true,
            ),
            ListingFieldDefinition {
                key: "tags".to_owned(),
                label: "标签".to_owned(),
                group: "属性".to_owned(),
                editor: ListingFieldEditor::MultiSelect,
                required: false,
                constraints: ListingFieldConstraints {
                    collection: true,
                    max_value_count: None,
                    dictionary_id: Some(TAGS_DICTIONARY_ID.to_string()),
                },
                attribute_id: Some(TAGS_DICTIONARY_ID.to_string()),
                options: vec![ListingFieldOption {
                    id: "1".to_owned(),
                    value: "精选".to_owned(),
                    ..Default::default()
                }],
                options_truncated: true,
                ..Default::default()
            },
            ListingFieldDefinition {
                key: "size".to_owned(),
                label: "尺寸".to_owned(),
                group: "规格".to_owned(),
                editor: ListingFieldEditor::Text,
                required: false,
                complex_id: Some("10".to_owned()),
                complex_group_collection: true,
                ..Default::default()
            },
            ListingFieldDefinition {
                key: "color".to_owned(),
                label: "颜色".to_owned(),
                group: "规格".to_owned(),
                editor: ListingFieldEditor::Text,
                required: false,
                complex_id: Some("10".to_owned()),
                complex_group_collection: true,
                ..Default::default()
            },
        ],
    }
}

/// The one dictionary value only resolvable through the schema cache's
/// search half — `options_truncated` on `tags` means Cloud's inline
/// `options` (id `"1"`, "精选") is not the whole dictionary, and a Draft can
/// legitimately reference an id the search endpoint found but the inline
/// list did not carry (`docs/listing-design.md` §3.7's truncated-dictionary
/// contract).
fn golden_materials() -> DictionaryMaterials {
    let mut materials = DictionaryMaterials::default();
    materials.insert_searched(
        DESCRIPTION_CATEGORY_ID,
        TAGS_DICTIONARY_ID,
        TAGS_DICTIONARY_ID,
        2,
        "限量",
    );
    materials
}

/// `pub`: the `listing-core-wasm` crate (a `test-support` dev-dependency)
/// reconstructs this exact schema to replay these golden cases through the
/// WASM ABI — see this module's doc comment in `ops/mod.rs`.
pub fn golden_schema_material() -> SchemaMaterial {
    SchemaMaterial::new(
        std::sync::Arc::new(golden_schema_snapshot()),
        golden_materials(),
    )
}

/// `pub`: see [`golden_schema_material`]'s doc comment.
pub fn golden_card(defaults: WorkflowCategoryDraft) -> CardPayload {
    CardPayload {
        category_key: "golden-core-ops".to_owned(),
        description_category_id: DESCRIPTION_CATEGORY_ID,
        type_id: TYPE_ID,
        language: WorkflowLanguage::Ru,
        defaults,
        ai_prompt_id: "prompt-golden".to_owned(),
        ai_prompt_sha256: "sha256:prompt".to_owned(),
        supplier_product_id: None,
        psd_template_asset_id: "asset-golden".to_owned(),
        psd_template_sha256: "sha256:tpl".to_owned(),
        psd_template_file_name: "template.psd".to_owned(),
        ai_field_policy: WorkflowAiFieldPolicy {
            allowed_field_keys: vec!["name".to_owned(), "price".to_owned(), "tags".to_owned()],
            protected_field_keys: Vec::new(),
        },
        videos: Vec::new(),
        video_cover: None,
        queue: Default::default(),
    }
}

/// Deterministic id source: every fixture that mints a complex-item id gets
/// the same sequence, so the golden file is stable across runs.
#[cfg(test)]
fn sequential_ids() -> impl FnMut() -> [u8; 16] {
    let mut next = 0u128;
    move || {
        next += 1;
        next.to_be_bytes()[..16].try_into().expect("16 bytes")
    }
}

#[cfg(test)]
fn golden_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/listing/core-ops")
}

#[cfg(test)]
fn assert_golden<I: Serialize, O: Serialize>(op: &str, case: &str, input: &I, output: &O) {
    let dir = golden_root().join(op);
    std::fs::create_dir_all(&dir)
        .unwrap_or_else(|error| panic!("create {}: {error}", dir.display()));
    assert_one(&dir.join(format!("{case}.input.json")), input);
    assert_one(&dir.join(format!("{case}.output.json")), output);
}

#[cfg(test)]
fn assert_one<T: Serialize>(path: &Path, value: &T) {
    let value = serde_json::to_value(value).expect("golden value must serialize");
    let rendered =
        serde_json::to_string_pretty(&value).expect("golden value must pretty-print") + "\n";
    match std::fs::read_to_string(path) {
        Ok(existing) => assert_eq!(
            existing,
            rendered,
            "golden drifted at {} — inspect the diff and, if the new shape is \
             intended, delete the file and rerun to rebless it",
            path.display()
        ),
        Err(_) => std::fs::write(path, &rendered)
            .unwrap_or_else(|error| panic!("write {}: {error}", path.display())),
    }
}

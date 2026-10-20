//! `edit_row` over a row saved before the system media write guard, whose
//! Draft, origins and hand-edited keys still hold video and cover fields.
//! Behaviour assertions only; this module writes no golden file. Carrying
//! that media back unchanged, or dropping some or all of it, saves exactly
//! what a row that never held it saves — Draft, origins, keys, stored
//! document, verdict and plan; adding or changing it is refused by field and
//! group with the row's own step. Canonical keys and raw groups count without
//! a cached schema, a light save stays facts-only, and the send guard still
//! refuses the Draft as stored.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Value, json};

use crate::FieldAddress;
use crate::ops::{Ctx, DraftEdit, EditOutcome, LeanRow, RowEdit, SchemaMaterial, edit_row};
use crate::projections::{SystemMediaEntry, system_media_row_refusal, system_media_write_error};
use crate::records::{FieldValueOrigin, FieldValueOriginKind, ListingFieldDefinition};
use crate::{
    WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
};

use super::edit_row::seeded_row;
use super::{
    golden_card, golden_materials, golden_schema_material, golden_schema_snapshot, sequential_ids,
};

const NOW: u64 = 1_700_000_000_400;
/// The host every forged system media value here names.
const FORGED_HOST: &str = "evil.example.invalid";
const FORGED: &str = "https://evil.example.invalid/forged.mp4";
const OTHER: &str = "https://evil.example.invalid/other.mp4";
/// The golden schema's ordinary complex group (`size` / `color`) and the
/// item id of the row's one item in it.
const SIZE_GROUP: i64 = 10;
const PART_ITEM: &str = "part-1";
/// A plain schema alias of the video URL attribute.
const ALIAS: &str = "video_url";
/// Every key that names system media in these rows.
const SYSTEM_KEYS: [&str; 5] = [
    "attribute_21837",
    "attribute_21841",
    "attribute_22273",
    "attribute_21845",
    ALIAS,
];

fn attribute_field(
    key: &str,
    attribute_id: i64,
    complex_id: Option<i64>,
) -> ListingFieldDefinition {
    ListingFieldDefinition {
        key: key.to_owned(),
        label: key.to_owned(),
        group: "属性".to_owned(),
        attribute_id: Some(attribute_id.to_string()),
        complex_id: complex_id.map(|id| id.to_string()),
        complex_group_collection: complex_id.is_some(),
        ..ListingFieldDefinition::default()
    }
}

/// The golden schema plus both system groups under their canonical keys and
/// the video URL attribute under [`ALIAS`].
fn system_media_schema() -> SchemaMaterial {
    let mut snapshot = golden_schema_snapshot();
    snapshot.fields.push(attribute_field(ALIAS, 21841, None));
    for (attribute, group) in [
        (21837, 100001),
        (21841, 100001),
        (22273, 100001),
        (21845, 100002),
    ] {
        let key = ListingFieldDefinition::attribute_key(attribute);
        let field = attribute_field(&key, attribute, Some(group));
        snapshot.fields.push(field);
    }
    SchemaMaterial::new(std::sync::Arc::new(snapshot), golden_materials())
}

fn text(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Text(value.to_owned())
}

fn url(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Url(value.to_owned())
}

fn group(
    complex_id: i64,
    item_id: &str,
    pairs: &[(&str, WorkflowDraftValue)],
) -> WorkflowComplexDraftGroup {
    let values: BTreeMap<String, WorkflowDraftValue> = pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), value.clone()))
        .collect();
    WorkflowComplexDraftGroup {
        complex_id,
        items: vec![WorkflowComplexDraftItem {
            item_id: item_id.to_owned(),
            values,
        }],
    }
}

/// The values of item `item_id` of group `complex_id` in `draft`.
fn item_values<'a>(
    draft: &'a mut WorkflowCategoryDraft,
    complex_id: i64,
    item_id: &str,
) -> &'a mut BTreeMap<String, WorkflowDraftValue> {
    let item = draft
        .complex_values
        .iter_mut()
        .filter(|group| group.complex_id == complex_id)
        .flat_map(|group| &mut group.items)
        .find(|item| item.item_id == item_id)
        .unwrap_or_else(|| panic!("an item {item_id} in group {complex_id}"));
    &mut item.values
}

fn plain(key: &str) -> FieldAddress {
    FieldAddress::Plain {
        field_key: key.to_owned(),
    }
}

fn complex(complex_id: i64, item_id: &str, key: &str) -> FieldAddress {
    FieldAddress::Complex {
        group_key: complex_id.to_string(),
        item_id: item_id.to_owned(),
        field_key: key.to_owned(),
        value_index: None,
    }
}

fn origin(address: FieldAddress, kind: FieldValueOriginKind) -> FieldValueOrigin {
    FieldValueOrigin {
        address,
        kind,
        source_ref: None,
        updated_at_ms: 1_600_000_000_000,
    }
}

/// A seeded row with ordinary operator data: a hand-edited price, an
/// ordinary clear, and an ordinary group item with a Manual origin.
fn ordinary_row() -> LeanRow {
    let mut row = seeded_row();
    row.draft.values.insert("price".to_owned(), text("120"));
    row.draft.cleared.insert("tags".to_owned());
    let part = group(SIZE_GROUP, PART_ITEM, &[("size", text("40x60"))]);
    row.draft.complex_values.push(part);
    row.hand_edited_keys.insert("price".to_owned());
    let size = complex(SIZE_GROUP, PART_ITEM, "size");
    let manual = origin(size, FieldValueOriginKind::Manual);
    row.field_origins.push(manual);
    row
}

/// [`ordinary_row`] as a row saved before the write guard holds it: every
/// kind of system media in its Draft, hand-edited keys and origins.
fn legacy_row() -> LeanRow {
    let mut row = ordinary_row();
    let draft = &mut row.draft;
    draft.values.insert(ALIAS.to_owned(), url(FORGED));
    let cover_key = "attribute_21845".to_owned();
    draft.values.insert(cover_key, url(FORGED));
    draft.cleared.insert("attribute_22273".to_owned());
    let part = item_values(draft, SIZE_GROUP, PART_ITEM);
    part.insert("attribute_21837".to_owned(), text("title"));
    draft.complex_values.push(group(
        100001,
        "video-1",
        &[
            ("attribute_21841", url(FORGED)),
            ("attribute_22273", text("OLD-OFFER")),
        ],
    ));
    let cover = group(100002, "cover-1", &[("attribute_21845", url(FORGED))]);
    draft.complex_values.push(cover);
    for key in [ALIAS, "attribute_21845", "attribute_22273"] {
        row.hand_edited_keys.insert(key.to_owned());
    }
    row.field_origins.extend([
        origin(plain(ALIAS), FieldValueOriginKind::Manual),
        origin(plain("attribute_21845"), FieldValueOriginKind::CardDefault),
        origin(
            complex(100001, "video-1", "attribute_21841"),
            FieldValueOriginKind::Manual,
        ),
        origin(
            complex(SIZE_GROUP, PART_ITEM, "attribute_21837"),
            FieldValueOriginKind::Manual,
        ),
    ]);
    row
}

/// `draft` with the one ordinary edit every save here makes.
fn renamed(mut draft: WorkflowCategoryDraft) -> WorkflowCategoryDraft {
    let name = text("Decorative Wall Art");
    draft.values.insert("name".to_owned(), name);
    draft
}

fn edit(
    schema: &SchemaMaterial,
    row: LeanRow,
    draft: WorkflowCategoryDraft,
    light: bool,
) -> Result<EditOutcome, String> {
    let card = golden_card(WorkflowCategoryDraft::default());
    let mut ids = sequential_ids();
    let mut ctx = Ctx {
        schema,
        card: Some(&card),
        now_ms: NOW,
        ids: &mut ids,
    };
    let edit = DraftEdit {
        changes: json!({}),
        draft,
        light,
        store_moved: false,
    };
    edit_row(&mut ctx, row, RowEdit::Draft(edit))
}

fn saved(answer: Result<EditOutcome, String>, label: &str) -> EditOutcome {
    answer.unwrap_or_else(|message| panic!("{label}: refused: {message}"))
}

fn refused(answer: Result<EditOutcome, String>, label: &str) -> String {
    answer.err().unwrap_or_else(|| panic!("{label}: saved"))
}

/// The same ordinary edit of the row that never held system media.
fn twin_save(schema: &SchemaMaterial) -> EditOutcome {
    let twin = ordinary_row();
    let answer = edit(schema, twin.clone(), renamed(twin.draft), false);
    saved(answer, "twin")
}

fn json_of<T: Serialize>(value: &T) -> Value {
    serde_json::to_value(value).expect("serializable")
}

fn digests(outcome: &EditOutcome) -> Option<(String, String)> {
    let evidence = outcome.edited.verdict.evidence.as_ref()?;
    let digest = evidence.digest.clone();
    Some((digest, evidence.card_defaults_digest.clone()))
}

/// `saved` is exactly the save of the row that never held system media.
fn assert_same_save(label: &str, saved: &EditOutcome, clean: &EditOutcome) {
    let (row, twin_row) = (json_of(&saved.edited.row), json_of(&clean.edited.row));
    assert_eq!(row, twin_row, "{label}: row");
    assert_eq!(saved.stored, clean.stored, "{label}: stored document");
    let (mine, twin) = (&saved.edited.verdict, &clean.edited.verdict);
    let fact = format!("{:?}", mine.fact);
    assert_eq!(fact, format!("{:?}", twin.fact), "{label}: fact");
    let issues = json_of(&mine.issues);
    assert_eq!(issues, json_of(&twin.issues), "{label}: issues");
    assert_eq!(mine.content_ready, twin.content_ready, "{label}");
    assert_eq!(digests(saved), digests(clean), "{label}: evidence");
    assert_eq!(json_of(&saved.plan), json_of(&clean.plan), "{label}: plan");
    let (mine, twin) = (&saved.invalidation, &clean.invalidation);
    assert_eq!(mine.content_state, twin.content_state, "{label}");
    assert_eq!(mine.media_state, twin.media_state, "{label}");
    assert_eq!(mine.submission_state, twin.submission_state, "{label}");
}

fn names_system_media(address: &FieldAddress) -> bool {
    match address {
        FieldAddress::Plain { field_key } => SYSTEM_KEYS.contains(&field_key.as_str()),
        FieldAddress::Complex {
            group_key,
            field_key,
            ..
        } => {
            matches!(group_key.as_str(), "100001" | "100002")
                || SYSTEM_KEYS.contains(&field_key.as_str())
        }
    }
}

/// No system value, clear, group, origin or hand-edited key is left in the
/// saved row or its stored document.
fn assert_no_system_media(label: &str, outcome: &EditOutcome) {
    let row = &outcome.edited.row;
    for group in &row.draft.complex_values {
        let id = group.complex_id;
        assert!(id != 100001 && id != 100002, "{label}: group {id}");
    }
    for origin in &row.field_origins {
        let address = &origin.address;
        assert!(!names_system_media(address), "{label}: {address:?}");
    }
    for key in SYSTEM_KEYS {
        assert!(!row.hand_edited_keys.contains(key), "{label}: {key}");
        for part in ["draft", "handEditedKeys", "fieldOrigins"] {
            let stored = outcome.stored[part].to_string();
            assert!(!stored.contains(key), "{label}: {part} {key}: {stored}");
        }
    }
    let stored = outcome.stored.to_string();
    assert!(!stored.contains(FORGED_HOST), "{label}: {stored}");
}

fn value(key: &str) -> SystemMediaEntry {
    SystemMediaEntry::Value {
        field_key: key.to_owned(),
    }
}

#[test]
fn a_full_edit_carrying_legacy_system_media_back_saves_the_row_clean() {
    let schema = system_media_schema();
    let legacy = legacy_row();
    let guard = system_media_write_error(schema.snapshot(), &legacy.draft);
    assert!(guard.is_some(), "as stored, the send guard refuses it");

    let clean = twin_save(&schema);
    let answer = edit(&schema, legacy.clone(), renamed(legacy.draft), false);
    let outcome = saved(answer, "unchanged legacy");

    assert_same_save("unchanged legacy", &outcome, &clean);
    assert_no_system_media("unchanged legacy", &outcome);
    let row = &outcome.edited.row;
    let ordinary = renamed(ordinary_row().draft);
    assert_eq!(row.draft, ordinary, "the ordinary Draft");
    assert!(row.draft.cleared.contains("tags"), "the ordinary clear");
    assert!(row.hand_edited_keys.contains("name"), "the edit is Manual");
    let kind_at = |address: FieldAddress| {
        let origins = &row.field_origins;
        let found = origins.iter().find(|item| item.address == address);
        found.map(|item| item.kind)
    };
    let size = complex(SIZE_GROUP, PART_ITEM, "size");
    assert_eq!(kind_at(size), Some(FieldValueOriginKind::Manual));
    assert_eq!(kind_at(plain("name")), Some(FieldValueOriginKind::Manual));
    let guard = system_media_write_error(schema.snapshot(), &row.draft);
    assert!(guard.is_none(), "what it saved passes the send guard");
}

#[test]
fn dropping_some_or_all_legacy_system_media_saves_without_manual_clears() {
    let schema = system_media_schema();
    let clean = twin_save(&schema);

    let mut partly = legacy_row().draft;
    partly.values.remove(ALIAS);
    partly.cleared.remove("attribute_22273");
    let groups = &mut partly.complex_values;
    groups.retain(|group| group.complex_id != 100002);
    let part = item_values(&mut partly, SIZE_GROUP, PART_ITEM);
    part.remove("attribute_21837");

    for (label, draft) in [
        ("all of it dropped", ordinary_row().draft),
        ("part of it dropped", partly),
    ] {
        let outcome = saved(edit(&schema, legacy_row(), renamed(draft), false), label);
        assert_same_save(label, &outcome, &clean);
        assert_no_system_media(label, &outcome);
    }
}

#[test]
fn adding_or_changing_system_media_is_refused_by_field_and_group_with_the_rows_own_step() {
    let schema = system_media_schema();
    let legacy = || legacy_row().draft;

    let mut changed_alias = legacy();
    changed_alias.values.insert(ALIAS.to_owned(), url(OTHER));
    let mut new_canonical = legacy();
    let video_key = "attribute_21841".to_owned();
    new_canonical.values.insert(video_key, url(FORGED));
    let mut new_clear = legacy();
    new_clear.cleared.insert("attribute_21845".to_owned());
    let mut changed_video = legacy();
    let video = item_values(&mut changed_video, 100001, "video-1");
    video.insert("attribute_21841".to_owned(), url(OTHER));
    let mut new_cover = legacy();
    let covers = group(100002, "cover-2", &[("attribute_21845", url(OTHER))]);
    new_cover.complex_values.push(covers);
    let mut mixed = legacy();
    let part = item_values(&mut mixed, SIZE_GROUP, PART_ITEM);
    part.insert("attribute_21845".to_owned(), url(OTHER));

    let cases = [
        ("a changed alias value", changed_alias, value(ALIAS)),
        (
            "a new canonical value",
            new_canonical,
            value("attribute_21841"),
        ),
        (
            "a new clear",
            new_clear,
            SystemMediaEntry::Cleared {
                field_key: "attribute_21845".to_owned(),
            },
        ),
        (
            "a changed video item",
            changed_video,
            SystemMediaEntry::Group { complex_id: 100001 },
        ),
        (
            "a second cover item",
            new_cover,
            SystemMediaEntry::Group { complex_id: 100002 },
        ),
        (
            "a new system key in an ordinary item",
            mixed,
            SystemMediaEntry::GroupField {
                complex_id: SIZE_GROUP,
                field_key: "attribute_21845".to_owned(),
            },
        ),
    ];
    for (label, draft, entry) in cases {
        let message = refused(edit(&schema, legacy_row(), renamed(draft), false), label);
        assert_eq!(message, system_media_row_refusal(&[entry]), "{label}");
        assert!(!message.contains("方案默认值"), "{label}: {message}");
    }

    let mut alias = legacy();
    alias.values.insert(ALIAS.to_owned(), url(OTHER));
    let message = refused(edit(&schema, legacy_row(), alias, false), "wording");
    assert_eq!(
        message,
        "系统媒体由发送时的媒体证据填写，本行草稿不能新增或修改：字段 video_url。\
         请在本行草稿中移除这些字段或组后重新保存；视频和封面请使用媒体入口上传"
    );

    // A row that never held system media: all of it is new.
    let mut raw = ordinary_row().draft;
    let cover = group(100002, "cover-1", &[("attribute_21845", url(FORGED))]);
    raw.complex_values.push(cover);
    let answer = edit(&schema, ordinary_row(), raw, false);
    let message = refused(answer, "an ordinary row");
    let cover = SystemMediaEntry::Group { complex_id: 100002 };
    assert_eq!(message, system_media_row_refusal(&[cover]));
}

#[test]
fn without_cached_system_fields_canonical_keys_and_raw_groups_still_count() {
    // The golden schema lists no system field; `ALIAS` is an ordinary key
    // under it, so the legacy row here holds only canonical keys and groups.
    let schema = golden_schema_material();
    let mut legacy = legacy_row();
    legacy.draft.values.remove(ALIAS);
    legacy.hand_edited_keys.remove(ALIAS);
    let alias = plain(ALIAS);
    legacy.field_origins.retain(|item| item.address != alias);

    let clean = twin_save(&schema);
    let answer = edit(&schema, legacy.clone(), renamed(legacy.draft), false);
    let outcome = saved(answer, "uncached legacy");
    assert_same_save("uncached legacy", &outcome, &clean);
    assert_no_system_media("uncached legacy", &outcome);

    let mut canonical = ordinary_row().draft;
    let video_key = "attribute_21841".to_owned();
    canonical.values.insert(video_key, url(FORGED));
    let answer = edit(&schema, ordinary_row(), canonical, false);
    let message = refused(answer, "a canonical value");
    let entry = value("attribute_21841");
    assert_eq!(message, system_media_row_refusal(&[entry]));

    let mut raw = ordinary_row().draft;
    let video = group(100001, "video-2", &[("name", text("owned"))]);
    raw.complex_values.push(video);
    let answer = edit(&schema, ordinary_row(), raw, false);
    let message = refused(answer, "a raw group");
    let video = SystemMediaEntry::Group { complex_id: 100001 };
    assert_eq!(message, system_media_row_refusal(&[video]));
}

#[test]
fn a_light_save_keeps_its_facts_only_contract_and_is_not_judged() {
    let schema = system_media_schema();
    let mut changed = legacy_row().draft;
    changed.values.insert(ALIAS.to_owned(), url(OTHER));

    let outcome = saved(edit(&schema, legacy_row(), changed, true), "light");

    let draft = &outcome.edited.row.draft;
    assert_eq!(draft.values.get(ALIAS), Some(&url(OTHER)), "stored as sent");
    assert_eq!(format!("{:?}", outcome.edited.verdict.fact), "Stale");
    assert!(outcome.plan.is_none());
}

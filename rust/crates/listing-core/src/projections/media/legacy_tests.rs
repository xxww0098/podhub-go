//! [`admit_card_defaults`]: the Card defaults write boundary over legacy
//! system media. Stored system media riding along unchanged, or partly
//! dropped, is cleaned; anything new or changed is refused by field and
//! group, with or without a cached schema, under both coordinates of a move.

use std::collections::{BTreeMap, BTreeSet};

use crate::records::ListingFieldDefinition;
use crate::{
    WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
};

use super::{SystemMediaEntry, admit_card_defaults};

const FORGED: &str = "https://evil.example.invalid/forged.mp4";
const OTHER: &str = "https://evil.example.invalid/other.mp4";
/// An ordinary complex group; its own field is `part`.
const PART_GROUP: i64 = 7;

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

/// A cached schema with both system groups under their canonical keys and
/// the video URL attribute under the plain alias `alias`.
fn schema(alias: &str) -> Vec<ListingFieldDefinition> {
    let mut fields = vec![
        attribute_field(alias, 21841, None),
        attribute_field("part", 9999, Some(PART_GROUP)),
    ];
    for (attribute, group) in [
        (21837, 100001),
        (21841, 100001),
        (22273, 100001),
        (21845, 100002),
    ] {
        let key = ListingFieldDefinition::attribute_key(attribute);
        fields.push(attribute_field(&key, attribute, Some(group)));
    }
    fields
}

fn text(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Text(value.to_owned())
}

fn url(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Url(value.to_owned())
}

fn item(item_id: &str, pairs: &[(&str, WorkflowDraftValue)]) -> WorkflowComplexDraftItem {
    WorkflowComplexDraftItem {
        item_id: item_id.to_owned(),
        values: pairs
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    }
}

fn group(complex_id: i64, items: Vec<WorkflowComplexDraftItem>) -> WorkflowComplexDraftGroup {
    WorkflowComplexDraftGroup { complex_id, items }
}

/// The first item of the group at `index` in `draft`.
fn first_item(draft: &mut WorkflowCategoryDraft, index: usize) -> &mut WorkflowComplexDraftItem {
    &mut draft.complex_values[index].items[0]
}

/// Ordinary defaults only: a price, an ordinary clear and an ordinary group.
fn ordinary() -> WorkflowCategoryDraft {
    let part = item("part-1", &[("part", text("frame"))]);
    WorkflowCategoryDraft {
        values: BTreeMap::from([("price".to_owned(), text("90"))]),
        cleared: BTreeSet::from(["old_price".to_owned()]),
        complex_values: vec![group(PART_GROUP, vec![part])],
    }
}

/// [`ordinary`] as a Card saved before the write guard holds it: every kind
/// of system media beside the ordinary defaults, the groups ordered
/// part (0), video (1), cover (2).
fn legacy() -> WorkflowCategoryDraft {
    let part = item(
        "part-1",
        &[
            ("part", text("frame")),
            ("attribute_21837", text("old title")),
        ],
    );
    let video = item(
        "video-1",
        &[
            ("attribute_21841", url(FORGED)),
            ("attribute_22273", text("OLD-OFFER")),
        ],
    );
    let cover = item("cover-1", &[("attribute_21845", url(FORGED))]);
    WorkflowCategoryDraft {
        values: BTreeMap::from([
            ("price".to_owned(), text("90")),
            ("video_url".to_owned(), url(FORGED)),
            ("attribute_21845".to_owned(), url(FORGED)),
        ]),
        cleared: BTreeSet::from(["old_price".to_owned(), "attribute_22273".to_owned()]),
        complex_values: vec![
            group(PART_GROUP, vec![part]),
            group(100001, vec![video]),
            group(100002, vec![cover]),
        ],
    }
}

fn refused(
    fields: &[ListingFieldDefinition],
    stored: Option<&WorkflowCategoryDraft>,
    next: &WorkflowCategoryDraft,
) -> Vec<SystemMediaEntry> {
    let mut attempt = next.clone();
    let answer = admit_card_defaults(&[fields], stored, &mut attempt);
    let refusal = answer.expect_err("system media is refused");
    assert_eq!(&attempt, next, "a refused write is left as sent");
    refusal.entries
}

/// Set `key` in `item`.
fn put(item: &mut WorkflowComplexDraftItem, key: &str, value: WorkflowDraftValue) {
    item.values.insert(key.to_owned(), value);
}

fn value(key: &str) -> SystemMediaEntry {
    SystemMediaEntry::Value {
        field_key: key.to_owned(),
    }
}

fn group_field(key: &str) -> SystemMediaEntry {
    SystemMediaEntry::GroupField {
        complex_id: PART_GROUP,
        field_key: key.to_owned(),
    }
}

#[test]
fn unchanged_legacy_system_media_rides_along_with_an_ordinary_edit_and_is_cleaned() {
    let fields = schema("video_url");
    let stored = legacy();
    let mut edited = legacy();
    edited.values.insert("price".to_owned(), text("91"));

    let cleaned = admit_card_defaults(&[&fields], Some(&stored), &mut edited);

    assert_eq!(cleaned, Ok(true));
    let mut expected = ordinary();
    expected.values.insert("price".to_owned(), text("91"));
    assert_eq!(edited, expected, "only the ordinary defaults are saved");
}

#[test]
fn dropping_some_legacy_system_media_is_a_removal_and_the_rest_is_cleaned() {
    let fields = schema("video_url");
    let stored = legacy();
    let mut dropped = legacy();
    dropped.values.remove("video_url");
    dropped.cleared.remove("attribute_22273");
    // The cover group goes; the video item loses one of its values.
    dropped.complex_values.pop();
    let video_item = first_item(&mut dropped, 1);
    video_item.values.remove("attribute_22273");

    let cleaned = admit_card_defaults(&[&fields], Some(&stored), &mut dropped);

    assert_eq!(cleaned, Ok(true));
    assert_eq!(dropped, ordinary());
}

#[test]
fn defaults_without_system_media_pass_untouched() {
    let fields = schema("video_url");
    let mut edited = ordinary();
    edited.values.insert("price".to_owned(), text("95"));
    let sent = edited.clone();

    let cleaned = admit_card_defaults(&[&fields], Some(&legacy()), &mut edited);

    assert_eq!(cleaned, Ok(false));
    assert_eq!(edited, sent);
}

#[test]
fn new_or_changed_system_media_is_refused_by_field_and_group() {
    let fields = schema("video_url");
    let stored = legacy();

    let mut changed = legacy();
    changed.values.insert("video_url".to_owned(), url(OTHER));
    assert_eq!(
        refused(&fields, Some(&stored), &changed),
        [value("video_url")]
    );

    let mut canonical = legacy();
    canonical
        .values
        .insert("attribute_21841".to_owned(), url(FORGED));
    assert_eq!(
        refused(&fields, Some(&stored), &canonical),
        [value("attribute_21841")]
    );

    let mut cleared = legacy();
    cleared.cleared.insert("attribute_21845".to_owned());
    assert_eq!(
        refused(&fields, Some(&stored), &cleared),
        [SystemMediaEntry::Cleared {
            field_key: "attribute_21845".to_owned(),
        }]
    );

    let mut video = legacy();
    put(first_item(&mut video, 1), "attribute_21841", url(OTHER));
    let mut cover = legacy();
    let second_cover = item("cover-2", &[("attribute_21845", url(OTHER))]);
    cover.complex_values[2].items.push(second_cover);
    for (complex_id, next) in [(100001, video), (100002, cover)] {
        assert_eq!(
            refused(&fields, Some(&stored), &next),
            [SystemMediaEntry::Group { complex_id }]
        );
    }

    let mut foreign = legacy();
    put(first_item(&mut foreign, 0), "attribute_21845", url(OTHER));
    assert_eq!(
        refused(&fields, Some(&stored), &foreign),
        [group_field("attribute_21845")]
    );
}

#[test]
fn a_new_card_refuses_every_system_media_value() {
    let fields = schema("video_url");
    let entries = refused(&fields, None, &legacy());

    assert_eq!(
        entries,
        [
            value("attribute_21845"),
            value("video_url"),
            SystemMediaEntry::Cleared {
                field_key: "attribute_22273".to_owned(),
            },
            SystemMediaEntry::Group { complex_id: 100001 },
            SystemMediaEntry::Group { complex_id: 100002 },
            group_field("attribute_21837"),
        ]
    );
    let mut attempt = legacy();
    let answer = admit_card_defaults(&[&fields], None, &mut attempt);
    let message = answer.expect_err("refused").to_string();
    for named in [
        "字段 attribute_21845",
        "字段 attribute_22273 的清空",
        "系统媒体组 100001",
        "组 7 内的字段 attribute_21837",
        "请在方案默认值中删除这些字段或组后重新保存",
    ] {
        assert!(message.contains(named), "{named} in {message}");
    }
}

#[test]
fn without_a_cached_schema_canonical_keys_and_raw_groups_still_count() {
    let mut canonical = ordinary();
    canonical
        .values
        .insert("attribute_21841".to_owned(), url(FORGED));
    assert_eq!(refused(&[], None, &canonical), [value("attribute_21841")]);

    let mut raw_group = ordinary();
    let owned = item("", &[("name", text("owned"))]);
    raw_group.complex_values.push(group(100002, vec![owned]));
    assert_eq!(
        refused(&[], None, &raw_group),
        [SystemMediaEntry::Group { complex_id: 100002 }]
    );

    // Stored raw groups and canonical keys still ride along and are cleaned.
    let mut stored = legacy();
    stored.values.remove("video_url");
    let mut unchanged = stored.clone();
    let cleaned = admit_card_defaults(&[], Some(&stored), &mut unchanged);
    assert_eq!(cleaned, Ok(true));
    assert_eq!(unchanged, ordinary());
}

#[test]
fn a_coordinate_move_judges_the_write_under_both_schemas() {
    let before = schema("video_url");
    let after = schema("clip_link");
    let stored = legacy();

    // The old coordinate's alias still names system media after the move,
    // so the legacy value is cleaned rather than kept as an ordinary key.
    let mut unchanged = legacy();
    let cleaned = admit_card_defaults(&[&before, &after], Some(&stored), &mut unchanged);
    assert_eq!(cleaned, Ok(true));
    assert_eq!(unchanged, ordinary());

    // A value under the new coordinate's alias is new system media.
    let mut moved = legacy();
    moved.values.insert("clip_link".to_owned(), url(FORGED));
    let mut attempt = moved.clone();
    let answer = admit_card_defaults(&[&before, &after], Some(&stored), &mut attempt);
    let refusal = answer.expect_err("a move cannot add system media");
    assert_eq!(refusal.entries, [value("clip_link")]);
    assert_eq!(attempt, moved);
}

#[test]
fn recombining_held_values_into_one_item_is_a_new_item() {
    let fields = schema("video_url");
    let mut stored = ordinary();
    stored.complex_values[0].items = vec![
        item("", &[("attribute_21845", url(FORGED))]),
        item("", &[("attribute_21837", text("old title"))]),
    ];
    let mut recombined = ordinary();
    recombined.complex_values[0].items = vec![item(
        "",
        &[
            ("attribute_21845", url(FORGED)),
            ("attribute_21837", text("old title")),
        ],
    )];

    assert_eq!(
        refused(&fields, Some(&stored), &recombined),
        [
            group_field("attribute_21837"),
            group_field("attribute_21845"),
        ]
    );
}

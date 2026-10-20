//! The one system media admission both write boundaries share, as the row
//! Draft boundary uses it: stored system media rides along unchanged or
//! dropped and is stripped; anything new or changed is answered by field and
//! group, the write left as sent, and the row refusal names the row's own
//! Draft and the step that gets the save through — never the Card defaults.

use std::collections::{BTreeMap, BTreeSet};

use crate::{
    WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
};

use super::{
    SystemMediaDefaultsRefusal, SystemMediaEntry, SystemMediaFields, system_media_row_refusal,
};

const FORGED: &str = "https://evil.example.invalid/forged.mp4";
const OTHER: &str = "https://evil.example.invalid/other.mp4";

fn url(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Url(value.to_owned())
}

fn text(value: &str) -> WorkflowDraftValue {
    WorkflowDraftValue::Text(value.to_owned())
}

/// A stored row Draft: a price beside a canonical cover value, a cleared
/// offer field and a raw video group item.
fn stored() -> WorkflowCategoryDraft {
    WorkflowCategoryDraft {
        values: BTreeMap::from([
            ("price".to_owned(), text("120")),
            ("attribute_21845".to_owned(), url(FORGED)),
        ]),
        cleared: BTreeSet::from(["attribute_22273".to_owned()]),
        complex_values: vec![WorkflowComplexDraftGroup {
            complex_id: 100001,
            items: vec![WorkflowComplexDraftItem {
                item_id: "video-1".to_owned(),
                values: BTreeMap::from([("attribute_21841".to_owned(), url(FORGED))]),
            }],
        }],
    }
}

/// [`stored`] without its system media.
fn ordinary() -> WorkflowCategoryDraft {
    WorkflowCategoryDraft {
        values: BTreeMap::from([("price".to_owned(), text("120"))]),
        ..WorkflowCategoryDraft::default()
    }
}

#[test]
fn stored_system_media_rides_along_or_is_dropped_and_is_stripped_either_way() {
    // No cached schema: the canonical keys and the raw groups still count.
    let fields = SystemMediaFields::of_fields(&[]);

    let mut unchanged = stored();
    assert_eq!(fields.admit(Some(&stored()), &mut unchanged), Ok(true));
    assert_eq!(unchanged, ordinary());

    let mut dropped = stored();
    dropped.complex_values.clear();
    assert_eq!(fields.admit(Some(&stored()), &mut dropped), Ok(true));
    assert_eq!(dropped, ordinary());

    let mut none_left = ordinary();
    assert_eq!(fields.admit(Some(&stored()), &mut none_left), Ok(false));
    assert_eq!(none_left, ordinary());
}

#[test]
fn new_or_changed_system_media_is_answered_by_entry_and_the_write_left_as_sent() {
    let fields = SystemMediaFields::of_fields(&[]);

    let mut changed = stored();
    changed
        .values
        .insert("attribute_21845".to_owned(), url(OTHER));
    changed.cleared.insert("attribute_21837".to_owned());
    let video = &mut changed.complex_values[0].items[0].values;
    video.insert("attribute_21841".to_owned(), url(OTHER));
    let sent = changed.clone();

    let entries = fields
        .admit(Some(&stored()), &mut changed)
        .expect_err("changed system media is refused");

    assert_eq!(
        entries,
        [
            SystemMediaEntry::Value {
                field_key: "attribute_21845".to_owned(),
            },
            SystemMediaEntry::Cleared {
                field_key: "attribute_21837".to_owned(),
            },
            SystemMediaEntry::Group { complex_id: 100001 },
        ]
    );
    assert_eq!(changed, sent, "a refused write is left as sent");
}

#[test]
fn the_row_refusal_names_the_rows_draft_and_the_card_refusal_keeps_its_own_words() {
    let entries = vec![
        SystemMediaEntry::Value {
            field_key: "attribute_21845".to_owned(),
        },
        SystemMediaEntry::GroupField {
            complex_id: 7,
            field_key: "attribute_21837".to_owned(),
        },
    ];

    assert_eq!(
        system_media_row_refusal(&entries),
        "系统媒体由发送时的媒体证据填写，本行草稿不能新增或修改：\
         字段 attribute_21845、组 7 内的字段 attribute_21837。\
         请在本行草稿中移除这些字段或组后重新保存；视频和封面请使用媒体入口上传"
    );
    let card = SystemMediaDefaultsRefusal { entries }.to_string();
    assert_eq!(
        card,
        "系统媒体由发送时的媒体证据填写，方案默认值不能新增或修改：\
         字段 attribute_21845、组 7 内的字段 attribute_21837。\
         请在方案默认值中删除这些字段或组后重新保存；视频和封面请在方案媒体中上传"
    );
}

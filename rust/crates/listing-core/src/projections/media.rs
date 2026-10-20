//! Media ownership of schema fields, and the one rule that keeps system media
//! out of every Draft, Card default and build.
//!
//! System media is Ozon's product-video group 100001 (attributes 21837 title,
//! 21841 URL, 22273 offer) and video-cover group 100002 (21845 URL). Only the
//! serializer writes them, from the send-time media evidence
//! (`ProductImportMedia::product_videos` / `video_cover_url`, see
//! `product_import::build_product_import_request`), and that evidence is
//! what the Cloud send checks against the server's own records. A value on
//! one of these fields anywhere in a Draft would reach Seller without that
//! evidence: a raw 100001 / 100002 group, the attribute under its schema key
//! or its canonical `attribute_{id}` key, as a plain value, a clear, or an
//! item value inside some other group. The write guard refuses all of them,
//! and the build drops all of them after every layer that could write one.
//!
//! The four attribute and two group ids live here and nowhere else; callers
//! ask this module rather than copying them.
//!
//! Card defaults saved before the write guard may still carry system media.
//! [`admit_card_defaults`] is the one Card write boundary for them: the
//! stored subset may ride along unchanged (or be dropped) and is cleaned on
//! save; anything new or changed is refused by field and group.
//!
//! Rows saved before the write guard may carry it in their Draft the same
//! way. A full Draft edit (`ops::edit_row`) is judged by the same admission
//! against the row's own stored Draft, and refused with
//! [`system_media_row_refusal`], which names the row's Draft rather than the
//! Card's defaults.

use std::collections::BTreeSet;
use std::fmt;

use crate::records::{CategorySchemaSnapshot, FieldAddress, ListingFieldDefinition};
use crate::{
    CategorySchemaView, WorkflowCategoryDraft, WorkflowComplexDraftItem, WorkflowDraftValue,
};

use super::{OZON_MODEL_NAME_ATTRIBUTE_ID, OZON_SELLER_CODE_ATTRIBUTE_ID};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FieldMediaClass {
    Editable,
    System,
    Filename,
    Other,
}

const EDITABLE_MEDIA_KEYS: &[&str] = &["images", "images360", "primary_image", "color_image"];
const SYSTEM_MEDIA_ATTRIBUTE_IDS: &[i64] = &[21837, 21841, 22273, 21845];
const SYSTEM_MEDIA_GROUP_IDS: &[i64] = &[100001, 100002];
const FILENAME_ATTRIBUTE_IDS: &[i64] =
    &[OZON_SELLER_CODE_ATTRIBUTE_ID, OZON_MODEL_NAME_ATTRIBUTE_ID];

const SYSTEM_MEDIA_MESSAGE: &str = "系统媒体由发送时的媒体证据填写，不能在草稿里编辑或清空";

/// One classifier for media ownership. Backfill uses [`field_pack::occupies`]
/// for whether a slot may be filled; this function only names the class.
pub fn field_media_class(
    key: &str,
    attribute_id: Option<i64>,
    complex_id: Option<i64>,
) -> FieldMediaClass {
    if complex_id.is_some_and(|id| SYSTEM_MEDIA_GROUP_IDS.contains(&id))
        || attribute_id.is_some_and(|id| SYSTEM_MEDIA_ATTRIBUTE_IDS.contains(&id))
    {
        return FieldMediaClass::System;
    }
    if EDITABLE_MEDIA_KEYS.contains(&key) {
        return FieldMediaClass::Editable;
    }
    if key == "offer_id" || attribute_id.is_some_and(|id| FILENAME_ATTRIBUTE_IDS.contains(&id)) {
        return FieldMediaClass::Filename;
    }
    FieldMediaClass::Other
}

pub fn system_media_write_error(
    schema: &CategorySchemaSnapshot,
    draft: &WorkflowCategoryDraft,
) -> Option<&'static str> {
    system_media_draft_error(&schema.fields, draft)
}

/// [`system_media_write_error`] over bare schema fields. With none — a
/// coordinate with no cached schema — the raw system groups and the
/// canonical system attribute keys still count, so a missing cache never
/// opens the guard and never has to be filled to judge a write. Card
/// defaults go through [`admit_card_defaults`] instead, and a full row Draft
/// edit through `SystemMediaFields::admit` against the row's stored Draft.
pub fn system_media_draft_error(
    fields: &[ListingFieldDefinition],
    draft: &WorkflowCategoryDraft,
) -> Option<&'static str> {
    SystemMediaFields::of_fields(fields)
        .written_by(draft)
        .then_some(SYSTEM_MEDIA_MESSAGE)
}

/// One system media fact a Card defaults or row Draft write added or changed.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum SystemMediaEntry {
    /// A plain value under a system field key.
    Value { field_key: String },
    /// An explicit clear of a system field key.
    Cleared { field_key: String },
    /// An item of a raw system media group (100001 / 100002).
    Group { complex_id: i64 },
    /// A system field key inside an ordinary complex group.
    GroupField { complex_id: i64, field_key: String },
}

/// A Card defaults write that adds or changes system media. The message
/// names every offending field or group and how to get the save through.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SystemMediaDefaultsRefusal {
    pub entries: Vec<SystemMediaEntry>,
}

impl fmt::Display for SystemMediaDefaultsRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let named = named(&self.entries);
        write!(
            f,
            "系统媒体由发送时的媒体证据填写，方案默认值不能新增或修改：{named}。\
             请在方案默认值中删除这些字段或组后重新保存；视频和封面请在方案媒体中上传"
        )
    }
}

impl std::error::Error for SystemMediaDefaultsRefusal {}

/// The refusal of a full row Draft edit that adds or changes system media:
/// every offending field or group, and how to get the save through.
pub(crate) fn system_media_row_refusal(entries: &[SystemMediaEntry]) -> String {
    let named = named(entries);
    format!(
        "系统媒体由发送时的媒体证据填写，本行草稿不能新增或修改：{named}。\
         请在本行草稿中移除这些字段或组后重新保存；视频和封面请使用媒体入口上传"
    )
}

/// `entries` as one list for a refusal message, in entry order.
fn named(entries: &[SystemMediaEntry]) -> String {
    entries
        .iter()
        .map(|entry| match entry {
            SystemMediaEntry::Value { field_key } => format!("字段 {field_key}"),
            SystemMediaEntry::Cleared { field_key } => format!("字段 {field_key} 的清空"),
            SystemMediaEntry::Group { complex_id } => format!("系统媒体组 {complex_id}"),
            SystemMediaEntry::GroupField {
                complex_id,
                field_key,
            } => format!("组 {complex_id} 内的字段 {field_key}"),
        })
        .collect::<Vec<_>>()
        .join("、")
}

/// The Card defaults write boundary for system media.
///
/// `schemas` are the cached field lists the write may be judged under — the
/// stored and the next coordinate when a write moves the Card, so a schema
/// alias of either counts; none at all still names the raw groups and the
/// canonical keys. `stored` is the server's own copy of the defaults (`None`
/// for a new Card), never what a client claims it was.
///
/// System media in `next` that `stored` already held, unchanged, is legacy
/// riding along with a whole-payload save; dropping some of it is a removal.
/// Both are allowed and cleaned out of `next`. Any value, clear or group item
/// `stored` does not hold as-is is refused, `next` untouched. Answers whether
/// anything was cleaned.
pub fn admit_card_defaults(
    schemas: &[&[ListingFieldDefinition]],
    stored: Option<&WorkflowCategoryDraft>,
    next: &mut WorkflowCategoryDraft,
) -> Result<bool, SystemMediaDefaultsRefusal> {
    let fields = SystemMediaFields::classified(schemas.iter().copied().flat_map(|fields| {
        fields.iter().map(|field| {
            (
                field.key.as_str(),
                field.attribute_id_i64(),
                field.complex_id_i64(),
            )
        })
    }));
    fields
        .admit(stored, next)
        .map_err(|entries| SystemMediaDefaultsRefusal { entries })
}

/// The field keys that name system media under one schema: every key the
/// schema classifies [`FieldMediaClass::System`], plus the canonical
/// `attribute_{id}` key of each system attribute whether or not the schema
/// lists it.
pub(crate) struct SystemMediaFields {
    keys: BTreeSet<String>,
}

impl SystemMediaFields {
    fn classified<'a>(fields: impl Iterator<Item = (&'a str, Option<i64>, Option<i64>)>) -> Self {
        let mut keys: BTreeSet<String> = SYSTEM_MEDIA_ATTRIBUTE_IDS
            .iter()
            .map(|id| ListingFieldDefinition::attribute_key(*id))
            .collect();
        keys.extend(
            fields
                .filter(|(key, attribute_id, complex_id)| {
                    field_media_class(key, *attribute_id, *complex_id) == FieldMediaClass::System
                })
                .map(|(key, ..)| key.to_owned()),
        );
        Self { keys }
    }

    pub(crate) fn of_fields(fields: &[ListingFieldDefinition]) -> Self {
        Self::classified(fields.iter().map(|field| {
            (
                field.key.as_str(),
                field.attribute_id_i64(),
                field.complex_id_i64(),
            )
        }))
    }

    pub(crate) fn of_view(schema: &CategorySchemaView) -> Self {
        Self::classified(
            schema
                .fields
                .iter()
                .map(|field| (field.key.as_str(), field.attribute_id, field.complex_id)),
        )
    }

    pub(crate) fn names(&self, key: &str) -> bool {
        self.keys.contains(key)
    }

    /// The one admission of a write over stored system media, shared by the
    /// Card defaults and the row Draft boundaries. `stored` is the server's
    /// own copy (`None` when there is none). What `stored` already holds
    /// may ride along unchanged or be dropped, and is stripped from `next`;
    /// anything else is answered with every entry it adds or changes, `next`
    /// untouched. Answers whether anything was stripped.
    pub(crate) fn admit(
        &self,
        stored: Option<&WorkflowCategoryDraft>,
        next: &mut WorkflowCategoryDraft,
    ) -> Result<bool, Vec<SystemMediaEntry>> {
        if !self.written_by(next) {
            return Ok(false);
        }
        let held = stored.map(|stored| self.subset(stored)).unwrap_or_default();
        let entries = entries_beyond(&self.subset(next), &held);
        if !entries.is_empty() {
            return Err(entries);
        }
        self.strip(next);
        Ok(true)
    }

    /// Whether `draft` sets or clears a system media field anywhere.
    fn written_by(&self, draft: &WorkflowCategoryDraft) -> bool {
        draft
            .values
            .keys()
            .chain(&draft.cleared)
            .any(|key| self.names(key))
            || draft.complex_values.iter().any(|group| {
                is_system_group(group.complex_id)
                    || group
                        .items
                        .iter()
                        .any(|item| item.values.keys().any(|key| self.names(key)))
            })
    }

    /// Whether `address` lies on a system media field.
    pub(crate) fn owns(&self, address: &FieldAddress) -> bool {
        match address {
            FieldAddress::Plain { field_key } => self.names(field_key),
            FieldAddress::Complex {
                group_key,
                field_key,
                ..
            } => group_key.parse::<i64>().is_ok_and(is_system_group) || self.names(field_key),
        }
    }

    /// Only the system media of `draft`: its system values and clears, its raw
    /// system groups whole, and the system keys of any other group's items.
    /// Items that carry none of it are left out.
    fn subset(&self, draft: &WorkflowCategoryDraft) -> WorkflowCategoryDraft {
        let mut subset = WorkflowCategoryDraft {
            values: draft
                .values
                .iter()
                .filter(|(key, _)| self.names(key))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
            cleared: draft
                .cleared
                .iter()
                .filter(|key| self.names(key))
                .cloned()
                .collect(),
            complex_values: draft.complex_values.clone(),
        };
        for group in &mut subset.complex_values {
            if !is_system_group(group.complex_id) {
                for item in &mut group.items {
                    item.values.retain(|key, _| self.names(key));
                }
            }
            group.items.retain(|item| !item.values.is_empty());
        }
        subset
            .complex_values
            .retain(|group| !group.items.is_empty());
        subset
    }

    /// Drop every system media value and clear from `draft`; everything else
    /// stays exactly as it was.
    pub(crate) fn strip(&self, draft: &mut WorkflowCategoryDraft) {
        draft.values.retain(|key, _| !self.names(key));
        draft.cleared.retain(|key| !self.names(key));
        draft
            .complex_values
            .retain(|group| !is_system_group(group.complex_id));
        for group in &mut draft.complex_values {
            for item in &mut group.items {
                item.values.retain(|key, _| !self.names(key));
            }
        }
    }
}

fn is_system_group(complex_id: i64) -> bool {
    SYSTEM_MEDIA_GROUP_IDS.contains(&complex_id)
}

/// The system media `carried` holds that `held` does not hold as-is. Both are
/// [`SystemMediaFields::subset`]s. A group item is held when an item of the
/// same group and item id holds every one of its values; otherwise its raw
/// system group, or each ordinary-group key no such item holds, is named.
fn entries_beyond(
    carried: &WorkflowCategoryDraft,
    held: &WorkflowCategoryDraft,
) -> Vec<SystemMediaEntry> {
    let mut entries = BTreeSet::new();
    for (key, value) in &carried.values {
        if held.values.get(key) != Some(value) {
            entries.insert(SystemMediaEntry::Value {
                field_key: key.clone(),
            });
        }
    }
    for key in &carried.cleared {
        if !held.cleared.contains(key) {
            entries.insert(SystemMediaEntry::Cleared {
                field_key: key.clone(),
            });
        }
    }
    for group in &carried.complex_values {
        let peers: Vec<&WorkflowComplexDraftItem> = held
            .complex_values
            .iter()
            .filter(|peer| peer.complex_id == group.complex_id)
            .flat_map(|peer| &peer.items)
            .collect();
        for item in &group.items {
            let peers: Vec<&WorkflowComplexDraftItem> = peers
                .iter()
                .copied()
                .filter(|peer| peer.item_id == item.item_id)
                .collect();
            if peers.iter().any(|peer| {
                item.values
                    .iter()
                    .all(|(key, value)| holds(peer, key, value))
            }) {
                continue;
            }
            if is_system_group(group.complex_id) {
                entries.insert(SystemMediaEntry::Group {
                    complex_id: group.complex_id,
                });
                continue;
            }
            let unheld: Vec<&String> = item
                .values
                .iter()
                .filter(|(key, value)| !peers.iter().any(|peer| holds(peer, key, value)))
                .map(|(key, _)| key)
                .collect();
            // Every value is held, just not by one item: a recombination is a
            // new item, so all of its keys are named.
            let named = if unheld.is_empty() {
                item.values.keys().collect()
            } else {
                unheld
            };
            entries.extend(named.into_iter().map(|key| SystemMediaEntry::GroupField {
                complex_id: group.complex_id,
                field_key: key.clone(),
            }));
        }
    }
    entries.into_iter().collect()
}

/// Whether `peer` holds `key` at exactly `value`.
fn holds(peer: &WorkflowComplexDraftItem, key: &str, value: &WorkflowDraftValue) -> bool {
    peer.values.get(key) == Some(value)
}

#[cfg(test)]
mod legacy_tests;
#[cfg(test)]
mod row_tests;

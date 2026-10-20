//! The pure half of Field Packs.
//!
//! A Pack supplies defaults for managed and shared field-pack data. The
//! Listing API no longer applies Packs to Cards.
//! Occupancy is unset / value / cleared: `0` and `false` are values; a cleared
//! key is not a gap. Storage and sharing are the Cloud service's job.

use std::collections::BTreeSet;

use crate::projections::SystemMediaFields;
use crate::{CategorySchemaView, WorkflowCategoryDraft, without_product_instance_owned_values};

/// A Pack is worth writing only when it carries something.
#[cfg(test)]
pub fn is_publishable(draft: &WorkflowCategoryDraft) -> bool {
    !draft.values.is_empty()
        || draft
            .complex_values
            .iter()
            .any(|group| !group.items.is_empty())
}

/// Whether a slot is already owned: a present value (including `0`, `false`,
/// and an empty array) or an explicit clear. Missing is unset and may be filled.
/// Complex items call this with `present = !values.is_empty()`; `{ values: {} }`
/// is not present.
pub fn occupies(present: bool, cleared: bool) -> bool {
    present || cleared
}

/// Drop complex items that do not occupy their group. Save and gap-seeding both
/// use this so an empty `{ values: {} }` cannot block a default group.
pub fn strip_empty_placeholders(draft: &mut WorkflowCategoryDraft) {
    for group in &mut draft.complex_values {
        group
            .items
            .retain(|item| occupies(!item.values.is_empty(), false));
    }
    draft.complex_values.retain(|group| !group.items.is_empty());
}

/// Fill only what the destination left unset, and only with fields the current
/// Category Schema actually has. Cleared keys stay cleared.
///
/// System media (the video and cover groups) is never seeded: only send-time
/// media evidence writes it, so its values, clears and groups leave both the
/// destination and the defaults — a Card saved before the write guard
/// included — before anything is filled.
pub fn seed_gaps(
    schema: &CategorySchemaView,
    draft: &mut WorkflowCategoryDraft,
    mut defaults: WorkflowCategoryDraft,
) {
    let system_media = SystemMediaFields::of_view(schema);
    system_media.strip(draft);
    system_media.strip(&mut defaults);
    strip_empty_placeholders(draft);
    let known_keys: BTreeSet<&str> = schema.fields.iter().map(|f| f.key.as_str()).collect();
    let known_groups: BTreeSet<i64> = schema
        .complex_groups
        .iter()
        .map(|group| group.complex_id)
        .collect();
    for (key, value) in defaults.values {
        if known_keys.contains(key.as_str())
            && !occupies(
                draft.values.contains_key(&key),
                draft.cleared.contains(&key),
            )
        {
            draft.values.insert(key, value);
        }
    }
    for key in defaults.cleared {
        if known_keys.contains(key.as_str())
            && !occupies(
                draft.values.contains_key(&key),
                draft.cleared.contains(&key),
            )
        {
            draft.cleared.insert(key);
        }
    }
    for mut group in defaults.complex_values {
        if !known_groups.contains(&group.complex_id)
            || draft
                .complex_values
                .iter()
                .any(|existing| existing.complex_id == group.complex_id)
        {
            continue;
        }
        for item in &mut group.items {
            item.values
                .retain(|key, _| known_keys.contains(key.as_str()));
        }
        group
            .items
            .retain(|item| occupies(!item.values.is_empty(), false));
        if !group.items.is_empty() {
            draft.complex_values.push(group);
        }
    }
}

/// A Pack never carries Product-Instance-owned values (offer id, media, …):
/// those belong to one row, not to a reusable default set.
pub fn pack_draft_json(
    schema: &CategorySchemaView,
    draft: WorkflowCategoryDraft,
) -> Result<String, serde_json::Error> {
    serde_json::to_string(&without_product_instance_owned_values(schema, draft))
}

// Seeding over system media in the supplied Draft and legacy Card defaults.
#[cfg(test)]
mod system_media_tests;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{
        CategoryComplexGroup, CategoryFieldConstraints, CategoryFieldEditor, CategoryFieldSource,
        CategoryFieldView, WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
    };

    use super::*;

    fn field(key: &str, complex_id: Option<i64>) -> CategoryFieldView {
        CategoryFieldView {
            key: key.to_owned(),
            name: key.to_owned(),
            description: String::new(),
            group_name: String::new(),
            source: CategoryFieldSource::Attribute,
            editor: CategoryFieldEditor::Text,
            raw_type: None,
            attribute_id: Some(1),
            complex_id,
            complex_group_collection: false,
            read_only: false,
            aspect: None,
            constraints: CategoryFieldConstraints {
                required: false,
                collection: false,
                max_value_count: None,
                dictionary_id: None,
            },
            options: Vec::new(),
            options_truncated: false,
        }
    }

    fn schema() -> CategorySchemaView {
        CategorySchemaView {
            description_category_id: 1,
            type_id: 2,
            language: None,
            fields: vec![
                field("style", None),
                field("material", None),
                field("part", Some(7)),
            ],
            complex_groups: vec![CategoryComplexGroup {
                complex_id: 7,
                name: "组".to_owned(),
                collection: true,
                field_keys: vec!["part".to_owned()],
            }],
        }
    }

    fn text(value: &str) -> WorkflowDraftValue {
        WorkflowDraftValue::Text(value.to_owned())
    }

    #[test]
    fn seeding_fills_gaps_and_never_overwrites_or_invents_fields() {
        let mut draft = WorkflowCategoryDraft {
            values: BTreeMap::from([("style".to_owned(), text("已填"))]),
            ..Default::default()
        };
        let defaults = WorkflowCategoryDraft {
            values: BTreeMap::from([
                ("style".to_owned(), text("默认")),
                ("material".to_owned(), text("画布")),
                ("unknown".to_owned(), text("不在 Schema 里")),
            ]),
            complex_values: vec![
                WorkflowComplexDraftGroup {
                    complex_id: 7,
                    items: vec![WorkflowComplexDraftItem {
                        item_id: String::new(),
                        values: BTreeMap::from([
                            ("part".to_owned(), text("A")),
                            ("unknown".to_owned(), text("B")),
                        ]),
                    }],
                },
                WorkflowComplexDraftGroup {
                    complex_id: 99,
                    items: vec![WorkflowComplexDraftItem::default()],
                },
            ],
            ..Default::default()
        };

        seed_gaps(&schema(), &mut draft, defaults);

        assert_eq!(draft.values.get("style"), Some(&text("已填")));
        assert_eq!(draft.values.get("material"), Some(&text("画布")));
        assert!(!draft.values.contains_key("unknown"));
        assert_eq!(draft.complex_values.len(), 1);
        assert_eq!(draft.complex_values[0].complex_id, 7);
        assert_eq!(draft.complex_values[0].items[0].values.len(), 1);
    }

    #[test]
    fn empty_placeholder_does_not_block_the_default_group() {
        let mut draft = WorkflowCategoryDraft {
            complex_values: vec![WorkflowComplexDraftGroup {
                complex_id: 7,
                items: vec![WorkflowComplexDraftItem::default()],
            }],
            ..Default::default()
        };
        let defaults = WorkflowCategoryDraft {
            complex_values: vec![WorkflowComplexDraftGroup {
                complex_id: 7,
                items: vec![WorkflowComplexDraftItem {
                    item_id: String::new(),
                    values: BTreeMap::from([("part".to_owned(), text("默认"))]),
                }],
            }],
            ..Default::default()
        };
        seed_gaps(&schema(), &mut draft, defaults);
        assert_eq!(draft.complex_values.len(), 1);
        assert_eq!(
            draft.complex_values[0].items[0].values.get("part"),
            Some(&text("默认"))
        );
        assert!(
            draft.complex_values[0]
                .items
                .iter()
                .all(|item| !item.values.is_empty())
        );
    }

    #[test]
    fn zero_false_and_empty_array_occupy_plain_slots() {
        let mut draft = WorkflowCategoryDraft {
            values: BTreeMap::from([
                ("style".to_owned(), WorkflowDraftValue::Integer(0)),
                ("material".to_owned(), WorkflowDraftValue::Boolean(false)),
            ]),
            ..Default::default()
        };
        draft
            .values
            .insert("tags".to_owned(), WorkflowDraftValue::TextList(Vec::new()));
        let mut schema = schema();
        schema.fields.push(field("tags", None));
        let defaults = WorkflowCategoryDraft {
            values: BTreeMap::from([
                ("style".to_owned(), text("默认")),
                ("material".to_owned(), text("默认")),
                ("tags".to_owned(), text("默认")),
            ]),
            ..Default::default()
        };
        seed_gaps(&schema, &mut draft, defaults);
        assert_eq!(
            draft.values.get("style"),
            Some(&WorkflowDraftValue::Integer(0))
        );
        assert_eq!(
            draft.values.get("material"),
            Some(&WorkflowDraftValue::Boolean(false))
        );
        assert_eq!(
            draft.values.get("tags"),
            Some(&WorkflowDraftValue::TextList(Vec::new()))
        );
    }

    #[test]
    fn seeding_never_replaces_a_group_the_card_already_has() {
        let mut draft = WorkflowCategoryDraft {
            values: BTreeMap::new(),
            cleared: BTreeSet::new(),
            complex_values: vec![WorkflowComplexDraftGroup {
                complex_id: 7,
                items: vec![WorkflowComplexDraftItem {
                    item_id: String::new(),
                    values: BTreeMap::from([("part".to_owned(), text("卡片自己的"))]),
                }],
            }],
        };
        let defaults = WorkflowCategoryDraft {
            values: BTreeMap::new(),
            cleared: BTreeSet::new(),
            complex_values: vec![WorkflowComplexDraftGroup {
                complex_id: 7,
                items: vec![WorkflowComplexDraftItem {
                    item_id: String::new(),
                    values: BTreeMap::from([("part".to_owned(), text("Pack 的"))]),
                }],
            }],
        };

        seed_gaps(&schema(), &mut draft, defaults);

        assert_eq!(draft.complex_values.len(), 1);
        assert_eq!(
            draft.complex_values[0].items[0].values.get("part"),
            Some(&text("卡片自己的"))
        );
    }

    #[test]
    fn an_empty_draft_is_not_publishable_as_a_pack() {
        assert!(!is_publishable(&WorkflowCategoryDraft::default()));
        assert!(is_publishable(&WorkflowCategoryDraft {
            values: BTreeMap::from([("style".to_owned(), text("x"))]),
            ..Default::default()
        }));
    }

    #[test]
    fn a_pack_body_drops_product_instance_owned_values() {
        let mut schema = schema();
        schema.fields.push(field("offer_id", None));
        let draft = WorkflowCategoryDraft {
            values: BTreeMap::from([
                ("style".to_owned(), text("现代")),
                ("offer_id".to_owned(), text("ART-001")),
            ]),
            ..Default::default()
        };

        let json = pack_draft_json(&schema, draft).expect("encode pack body");

        assert!(json.contains("现代"));
        assert!(
            !json.contains("ART-001"),
            "a Field Pack must never carry one row's identity"
        );
    }

    #[test]
    fn seeding_keeps_zero_and_false_as_values() {
        let mut draft = WorkflowCategoryDraft {
            values: BTreeMap::from([
                ("count".to_owned(), WorkflowDraftValue::Integer(0)),
                ("flag".to_owned(), WorkflowDraftValue::Boolean(false)),
            ]),
            ..Default::default()
        };
        let defaults = WorkflowCategoryDraft {
            values: BTreeMap::from([
                ("count".to_owned(), WorkflowDraftValue::Integer(9)),
                ("flag".to_owned(), WorkflowDraftValue::Boolean(true)),
            ]),
            ..Default::default()
        };

        seed_gaps(&schema_with_count_and_flag(), &mut draft, defaults);

        assert_eq!(
            draft.values.get("count"),
            Some(&WorkflowDraftValue::Integer(0))
        );
        assert_eq!(
            draft.values.get("flag"),
            Some(&WorkflowDraftValue::Boolean(false))
        );
    }

    #[test]
    fn seeding_does_not_restore_a_cleared_key() {
        let mut draft = WorkflowCategoryDraft {
            cleared: BTreeSet::from(["style".to_owned()]),
            ..Default::default()
        };
        let defaults = WorkflowCategoryDraft {
            values: BTreeMap::from([("style".to_owned(), text("默认"))]),
            ..Default::default()
        };

        seed_gaps(&schema(), &mut draft, defaults);

        assert!(!draft.values.contains_key("style"));
        assert!(draft.cleared.contains("style"));
    }

    fn schema_with_count_and_flag() -> CategorySchemaView {
        let mut view = schema();
        view.fields.push(field("count", None));
        view.fields.push(field("flag", None));
        view
    }
}

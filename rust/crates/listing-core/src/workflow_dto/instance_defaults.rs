//! Instance defaults overlay (Cloud-owned projection helpers).
// ===== instance_defaults.rs =====
use std::collections::BTreeSet;

use crate::{DESCRIPTION_ATTRIBUTE_ID, SEARCH_TAGS_ATTRIBUTE_ID};

use super::{
    CategorySchemaView, WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem,
};

const OZON_NAME_ATTRIBUTE_ID: i64 = 4180;
const OZON_SELLER_CODE_ATTRIBUTE_ID: i64 = 9024;
const OZON_MODEL_NAME_ATTRIBUTE_ID: i64 = 9048;

/// The field keys one Product Instance owns under this Schema: source identity,
/// recognition prose and delivered media. A reusable default set (card
/// 默认字段, Field Pack, Card Package) never carries them and is never judged
/// incomplete for lacking them — this is the **card-default exclusion
/// boundary**, and 型号 9048 is inside it: a card default can never overwrite
/// the common model of a row.
///
/// 主题 (7109) and JSON富内容 (11254) are not in this set: like 销售价 /
/// 划线价 they are card-default fields the operator may also type per row
/// (`hand_edited` wins at send; see the workbench `tableInput` columns).
pub fn product_instance_owned_keys(schema: &CategorySchemaView) -> BTreeSet<String> {
    let mut owned = [
        "name",
        "offer_id",
        "images",
        "images360",
        "primary_image",
        "color_image",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<BTreeSet<_>>();
    for field in &schema.fields {
        if matches!(
            field.attribute_id,
            Some(
                OZON_NAME_ATTRIBUTE_ID
                    | DESCRIPTION_ATTRIBUTE_ID
                    | OZON_SELLER_CODE_ATTRIBUTE_ID
                    | OZON_MODEL_NAME_ATTRIBUTE_ID
                    | SEARCH_TAGS_ATTRIBUTE_ID
            )
        ) {
            owned.insert(field.key.clone());
        }
    }
    owned
}

fn strip_instance_owned_keys(
    mut draft: WorkflowCategoryDraft,
    owned: &BTreeSet<String>,
) -> WorkflowCategoryDraft {
    for field_key in owned {
        draft.values.remove(field_key);
        draft.cleared.remove(field_key);
        for group in &mut draft.complex_values {
            for item in &mut group.items {
                item.values.remove(field_key);
            }
        }
    }
    draft
}

/// A Product Instance starts before per-image work. Fields owned by source
/// identity, recognition, or media delivery must therefore start empty even
/// when a legacy card snapshot contains them. AI write permission is not
/// ownership: a required card default may also be AI-editable, so stable
/// table/attribute identities define this boundary rather than the allow-list.
pub fn without_product_instance_owned_values(
    schema: &CategorySchemaView,
    draft: WorkflowCategoryDraft,
) -> WorkflowCategoryDraft {
    strip_instance_owned_keys(draft, &product_instance_owned_keys(schema))
}

/// The field keys the **server pipeline** fills for a new row, and that the
/// workbench shows read-only rather than editable.
///
/// 货号 = offer_id plus its 9024 Seller code. An ordinary import derives both
/// from the source file stem; the opt-in same-design import derives them from
/// the row UUID (PH-<row_id>) before seeding, so a retry or a rename cannot
/// move an existing row.
///
/// 型号 (9048) is deliberately **not** here. It is instance-owned like these
/// (see [product_instance_owned_keys]) but the operator owns its value per
/// row: the file stem only stands in while the draft holds no model at all.
pub fn pipeline_injected_keys(schema: &CategorySchemaView) -> BTreeSet<String> {
    let mut injected = ["offer_id".to_owned()].into_iter().collect::<BTreeSet<_>>();
    if let Some(key) =
        crate::projections::plain_attribute_field_key(schema, OZON_SELLER_CODE_ATTRIBUTE_ID)
    {
        injected.insert(key.to_owned());
    }
    injected
}

/// The plain 9048 key: the per-row editable common 型号. None when this Schema
/// has no plain 9048, which is the "category not supported yet" signal the
/// association import and the workbench 型号 column both report.
pub fn model_field_key(schema: &CategorySchemaView) -> Option<String> {
    crate::projections::plain_attribute_field_key(schema, OZON_MODEL_NAME_ATTRIBUTE_ID)
        .map(str::to_owned)
}

/// The field keys that name a row's source identity: 货号 (offer_id plus the
/// 9024 Seller code) together with 型号 (9048). Clearing generated content
/// keeps exactly these, so an explicitly set model survives the clear that
/// wipes the copy and the images around it.
pub fn source_identity_keys(schema: &CategorySchemaView) -> BTreeSet<String> {
    let mut identity = ["offer_id".to_owned()].into_iter().collect::<BTreeSet<_>>();
    for field in &schema.fields {
        if matches!(
            field.attribute_id,
            Some(OZON_SELLER_CODE_ATTRIBUTE_ID | OZON_MODEL_NAME_ATTRIBUTE_ID)
        ) {
            identity.insert(field.key.clone());
        }
    }
    identity
}

/// Drop every value except source identity so a cleared row starts over like a
/// fresh import: generated copy, operator picks and inherited card copies all
/// leave the stored Draft, and `cleared` marks on other fields drop with them,
/// so card defaults can fill those fields again at send as on a new row.
pub fn without_non_identity_values(
    schema: &CategorySchemaView,
    mut draft: WorkflowCategoryDraft,
) -> WorkflowCategoryDraft {
    let identity = source_identity_keys(schema);
    draft.values.retain(|key, _| identity.contains(key));
    draft.cleared.retain(|key| identity.contains(key));
    for group in &mut draft.complex_values {
        for item in &mut group.items {
            item.values.retain(|key, _| identity.contains(key));
        }
    }
    draft
}

/// Assemble send-click values: current card 默认字段 win for every
/// non-instance-owned address. Instance copies of price/VAT/brand and the rest
/// are not a cache. `hand_edited` keys are the exception — the operator typed
/// them on this instance, so they win over the card (an edited key with no
/// instance value stays empty). Owned keys (name, offer_id, media, …) stay on
/// the instance. The result is not written back onto the Product Instance draft.
pub fn overlay_current_card_defaults(
    current: WorkflowCategoryDraft,
    defaults: &WorkflowCategoryDraft,
    schema: &CategorySchemaView,
    hand_edited: &BTreeSet<String>,
) -> WorkflowCategoryDraft {
    let owned = product_instance_owned_keys(schema);
    let mut merged = strip_instance_owned_keys(defaults.clone(), &owned);
    for key in &owned {
        if let Some(value) = current.values.get(key) {
            merged.values.insert(key.clone(), value.clone());
        }
    }
    for key in hand_edited {
        if owned.contains(key) {
            continue;
        }
        match current.values.get(key) {
            Some(value) => {
                merged.values.insert(key.clone(), value.clone());
            }
            None => {
                merged.values.remove(key);
            }
        }
    }
    for key in &current.cleared {
        merged.values.remove(key);
        merged.cleared.insert(key.clone());
    }
    overlay_complex_owned(&mut merged, &current, &owned);
    merged
}

fn overlay_complex_owned(
    merged: &mut WorkflowCategoryDraft,
    current: &WorkflowCategoryDraft,
    owned: &BTreeSet<String>,
) {
    for group in &current.complex_values {
        if let Some(target) = merged
            .complex_values
            .iter_mut()
            .find(|candidate| candidate.complex_id == group.complex_id)
        {
            for (index, item) in group.items.iter().enumerate() {
                if let Some(slot) = target.items.iter().position(|candidate| {
                    is_stable_item_id(&item.item_id) && candidate.item_id == item.item_id
                }) {
                    copy_owned_keys(&mut target.items[slot], item, owned);
                    continue;
                }
                // A card slot that has never been given an id still lines up
                // with the instance item in this request. Stamp the instance
                // id so later writes find that same item.
                if let Some(target_item) = target.items.get_mut(index)
                    && target_item.item_id.is_empty()
                {
                    if is_stable_item_id(&item.item_id) {
                        target_item.item_id = item.item_id.clone();
                    }
                    copy_owned_keys(target_item, item, owned);
                } else {
                    target.items.push(owned_only_item(item, owned));
                }
            }
        } else {
            merged.complex_values.push(WorkflowComplexDraftGroup {
                complex_id: group.complex_id,
                items: group
                    .items
                    .iter()
                    .map(|item| owned_only_item(item, owned))
                    .collect(),
            });
        }
    }
}

fn is_stable_item_id(item_id: &str) -> bool {
    crate::content_policy::is_stable_item_id(item_id)
}

fn copy_owned_keys(
    target: &mut WorkflowComplexDraftItem,
    item: &WorkflowComplexDraftItem,
    owned: &BTreeSet<String>,
) {
    for key in owned {
        if let Some(value) = item.values.get(key) {
            target.values.insert(key.clone(), value.clone());
        }
    }
}

fn owned_only_item(
    item: &WorkflowComplexDraftItem,
    owned: &BTreeSet<String>,
) -> WorkflowComplexDraftItem {
    let mut owned_item = WorkflowComplexDraftItem {
        item_id: item.item_id.clone(),
        values: item
            .values
            .iter()
            .filter(|(key, _)| owned.contains(*key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
    };
    if owned_item.values.is_empty() {
        owned_item.item_id.clear();
    }
    owned_item
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workflow_dto::{
        CategoryFieldConstraints, CategoryFieldEditor, CategoryFieldSource, CategoryFieldView,
        WorkflowDraftValue,
    };

    fn field(key: &str, attribute_id: Option<i64>) -> CategoryFieldView {
        CategoryFieldView {
            key: key.to_owned(),
            name: key.to_owned(),
            description: String::new(),
            group_name: String::new(),
            source: CategoryFieldSource::Attribute,
            editor: CategoryFieldEditor::Text,
            raw_type: None,
            attribute_id,
            complex_id: None,
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

    fn key_set(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|key| (*key).to_owned()).collect()
    }

    #[test]
    fn generated_copy_is_instance_owned_while_table_inputs_take_card_defaults() {
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![
                field("price", None),
                field("attribute_4180", Some(OZON_NAME_ATTRIBUTE_ID)),
                field("attribute_23171", Some(SEARCH_TAGS_ATTRIBUTE_ID)),
                field("attribute_11254", Some(11_254)),
                field("attribute_7109", Some(7_109)),
            ],
            complex_groups: Vec::new(),
        };
        let mut defaults = WorkflowCategoryDraft::default();
        defaults.values.insert(
            "price".to_owned(),
            WorkflowDraftValue::Text("90".to_owned()),
        );
        defaults.values.insert(
            "attribute_4180".to_owned(),
            WorkflowDraftValue::Text("old product name".to_owned()),
        );
        defaults.values.insert(
            "attribute_23171".to_owned(),
            WorkflowDraftValue::Text("#card #default".to_owned()),
        );
        defaults.values.insert(
            "attribute_11254".to_owned(),
            WorkflowDraftValue::Text("{\"content\":[]}".to_owned()),
        );
        defaults.values.insert(
            "attribute_7109".to_owned(),
            WorkflowDraftValue::Text("花卉和植物".to_owned()),
        );

        let stripped = without_product_instance_owned_values(&schema, defaults.clone());
        assert_eq!(
            stripped.values.get("price"),
            Some(&WorkflowDraftValue::Text("90".to_owned()))
        );
        assert_eq!(stripped.values.get("attribute_4180"), None);
        assert_eq!(stripped.values.get("attribute_23171"), None);
        // 主题 / JSON富内容 are card-default fields with a per-row override,
        // exactly like 销售价: a default set may carry them.
        assert_eq!(
            stripped.values.get("attribute_11254"),
            Some(&WorkflowDraftValue::Text("{\"content\":[]}".to_owned()))
        );
        assert_eq!(
            stripped.values.get("attribute_7109"),
            Some(&WorkflowDraftValue::Text("花卉和植物".to_owned()))
        );

        let overlaid = overlay_current_card_defaults(
            WorkflowCategoryDraft::default(),
            &defaults,
            &schema,
            &BTreeSet::new(),
        );
        assert_eq!(
            overlaid.values.get("price"),
            Some(&WorkflowDraftValue::Text("90".to_owned()))
        );
        assert_eq!(overlaid.values.get("attribute_4180"), None);
        assert_eq!(overlaid.values.get("attribute_23171"), None);
        assert_eq!(
            overlaid.values.get("attribute_11254"),
            Some(&WorkflowDraftValue::Text("{\"content\":[]}".to_owned()))
        );
        assert_eq!(
            overlaid.values.get("attribute_7109"),
            Some(&WorkflowDraftValue::Text("花卉和植物".to_owned()))
        );
    }

    /// 货号 vs 型号: offer_id + 9024 are the pipeline's to fill, 9048 is
    /// instance-owned but the operator's to set per row, and every one of them
    /// is excluded from card defaults and kept by a content clear.
    #[test]
    fn the_identity_vocabulary_separates_offer_id_from_the_model() {
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![
                field("attribute_9024", Some(OZON_SELLER_CODE_ATTRIBUTE_ID)),
                field("attribute_9048", Some(OZON_MODEL_NAME_ATTRIBUTE_ID)),
                field("price", None),
            ],
            complex_groups: Vec::new(),
        };
        assert_eq!(
            pipeline_injected_keys(&schema),
            key_set(&["offer_id", "attribute_9024"]),
            "the pipeline fills 货号; 型号 is the operator's"
        );
        assert_eq!(model_field_key(&schema).as_deref(), Some("attribute_9048"));
        assert_eq!(
            source_identity_keys(&schema),
            key_set(&["offer_id", "attribute_9024", "attribute_9048"]),
            "a clear keeps 货号 and an explicitly set 型号"
        );
        let owned = product_instance_owned_keys(&schema);
        for key in ["offer_id", "attribute_9024", "attribute_9048"] {
            assert!(owned.contains(key), "{key} is never a card default");
        }
        assert!(!owned.contains("price"));
    }

    /// A category whose 9048 lives only inside a complex group has no 型号
    /// column: this slice reports it unsupported instead of half-filling it.
    #[test]
    fn a_complex_only_model_field_has_no_model_column() {
        let mut complex = field("attribute_9048", Some(OZON_MODEL_NAME_ATTRIBUTE_ID));
        complex.complex_id = Some(7);
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![
                field("attribute_9024", Some(OZON_SELLER_CODE_ATTRIBUTE_ID)),
                complex,
            ],
            complex_groups: Vec::new(),
        };
        assert_eq!(model_field_key(&schema), None);
        assert_eq!(
            pipeline_injected_keys(&schema),
            key_set(&["offer_id", "attribute_9024"])
        );
        // Ownership is keyed by attribute id, not by plainness: the card still
        // never supplies a complex-group model.
        assert!(product_instance_owned_keys(&schema).contains("attribute_9048"));
    }

    #[test]
    fn clearing_generated_content_keeps_only_source_identity() {
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![
                field("attribute_9024", Some(OZON_SELLER_CODE_ATTRIBUTE_ID)),
                field("attribute_9048", Some(OZON_MODEL_NAME_ATTRIBUTE_ID)),
                field("description", Some(DESCRIPTION_ATTRIBUTE_ID)),
                field("tags", Some(SEARCH_TAGS_ATTRIBUTE_ID)),
                field("theme", Some(7_109)),
            ],
            complex_groups: Vec::new(),
        };
        let mut draft = WorkflowCategoryDraft::default();
        for (key, value) in [
            ("offer_id", "ART-001"),
            ("attribute_9024", "ART-001"),
            ("attribute_9048", "ART-001"),
            ("name", "AI title"),
            ("description", "AI description"),
            ("tags", "#ai"),
            ("theme", "汽车和摩托车"),
            ("price", "90"),
            ("style", "manual style"),
        ] {
            draft
                .values
                .insert(key.to_owned(), WorkflowDraftValue::Text(value.to_owned()));
        }
        draft.cleared.insert("vat".to_owned());
        draft.complex_values.push(WorkflowComplexDraftGroup {
            complex_id: 7,
            items: vec![WorkflowComplexDraftItem {
                item_id: String::new(),
                values: [
                    (
                        "offer_id".to_owned(),
                        WorkflowDraftValue::Text("VAR-1".to_owned()),
                    ),
                    (
                        "material".to_owned(),
                        WorkflowDraftValue::Text("cotton".to_owned()),
                    ),
                ]
                .into_iter()
                .collect(),
            }],
        });

        let cleared = without_non_identity_values(&schema, draft);

        for key in ["offer_id", "attribute_9024", "attribute_9048"] {
            assert!(
                cleared.values.contains_key(key),
                "{key} is the row's source identity"
            );
        }
        for key in ["name", "description", "tags", "theme", "price", "style"] {
            assert!(
                !cleared.values.contains_key(key),
                "{key} is generated or filled content"
            );
        }
        assert!(
            !cleared.cleared.contains("vat"),
            "cleared marks reset with the values they pinned"
        );
        let item = &cleared.complex_values[0].items[0];
        assert_eq!(
            item.values.get("offer_id"),
            Some(&WorkflowDraftValue::Text("VAR-1".to_owned()))
        );
        assert!(!item.values.contains_key("material"));
    }

    #[test]
    fn reconfigured_card_defaults_win_over_stale_instance_copies() {
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![
                field("price", None),
                field("vat", None),
                field("attribute_4180", Some(OZON_NAME_ATTRIBUTE_ID)),
            ],
            complex_groups: Vec::new(),
        };
        let mut instance = WorkflowCategoryDraft::default();
        instance.values.insert(
            "price".to_owned(),
            WorkflowDraftValue::Text("90".to_owned()),
        );
        instance.values.insert(
            "attribute_4180".to_owned(),
            WorkflowDraftValue::Text("this row's name".to_owned()),
        );
        let mut defaults = WorkflowCategoryDraft::default();
        defaults.values.insert(
            "price".to_owned(),
            WorkflowDraftValue::Text("1990".to_owned()),
        );
        defaults
            .values
            .insert("vat".to_owned(), WorkflowDraftValue::Text("0".to_owned()));
        defaults.values.insert(
            "attribute_4180".to_owned(),
            WorkflowDraftValue::Text("card default name".to_owned()),
        );

        let overlaid =
            overlay_current_card_defaults(instance, &defaults, &schema, &BTreeSet::new());
        assert_eq!(
            overlaid.values.get("price"),
            Some(&WorkflowDraftValue::Text("1990".to_owned()))
        );
        assert_eq!(
            overlaid.values.get("vat"),
            Some(&WorkflowDraftValue::Text("0".to_owned()))
        );
        assert_eq!(
            overlaid.values.get("attribute_4180"),
            Some(&WorkflowDraftValue::Text("this row's name".to_owned()))
        );
    }

    #[test]
    fn hand_edited_instance_price_survives_the_send_overlay() {
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![field("price", None), field("vat", None)],
            complex_groups: Vec::new(),
        };
        let mut instance = WorkflowCategoryDraft::default();
        instance.values.insert(
            "price".to_owned(),
            WorkflowDraftValue::Text("90".to_owned()),
        );
        // Inherited copy the operator never touched.
        instance
            .values
            .insert("vat".to_owned(), WorkflowDraftValue::Text("0.1".to_owned()));
        let mut defaults = WorkflowCategoryDraft::default();
        defaults.values.insert(
            "price".to_owned(),
            WorkflowDraftValue::Text("1990".to_owned()),
        );
        defaults
            .values
            .insert("vat".to_owned(), WorkflowDraftValue::Text("0".to_owned()));

        // The operator's typed price wins; the untouched vat copy does not.
        let hand_edited = ["price".to_owned()].into_iter().collect();
        let overlaid = overlay_current_card_defaults(instance, &defaults, &schema, &hand_edited);
        assert_eq!(
            overlaid.values.get("price"),
            Some(&WorkflowDraftValue::Text("90".to_owned()))
        );
        assert_eq!(
            overlaid.values.get("vat"),
            Some(&WorkflowDraftValue::Text("0".to_owned()))
        );
    }

    #[test]
    fn a_cleared_instance_field_is_not_restored_by_card_defaults() {
        let schema = CategorySchemaView {
            description_category_id: 17_027_906,
            type_id: 91_955,
            language: None,
            fields: vec![field("price", None), field("vat", None)],
            complex_groups: Vec::new(),
        };
        let mut instance = WorkflowCategoryDraft::default();
        instance.cleared.insert("price".to_owned());
        instance
            .values
            .insert("vat".to_owned(), WorkflowDraftValue::Text("0.1".to_owned()));
        let mut defaults = WorkflowCategoryDraft::default();
        defaults.values.insert(
            "price".to_owned(),
            WorkflowDraftValue::Text("1990".to_owned()),
        );
        defaults
            .values
            .insert("vat".to_owned(), WorkflowDraftValue::Text("0".to_owned()));

        let overlaid =
            overlay_current_card_defaults(instance, &defaults, &schema, &BTreeSet::new());
        assert!(
            !overlaid.values.contains_key("price"),
            "cleared stays cleared; restore is an explicit action"
        );
        assert!(overlaid.cleared.contains("price"));
        assert_eq!(
            overlaid.values.get("vat"),
            Some(&WorkflowDraftValue::Text("0".to_owned()))
        );
    }
}

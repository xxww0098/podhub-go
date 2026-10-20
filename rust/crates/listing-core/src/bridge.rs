//! Workflow DTO ↔ Listing record bridge.
//!
//! A Category Schema arrives as an `crate::CategorySchemaView` and the
//! operator's values as a `WorkflowCategoryDraft`; validation, planning and
//! Seller serialization all speak [`ListingDraftRecord`]. These functions are
//! the only translation, and they are pure.

use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

#[cfg(test)]
use crate::{CategoryFieldEditor, CategorySchemaView};
use crate::{WorkflowCategoryDraft, WorkflowDraftValue};

use super::records::{
    CategorySchemaSnapshot, ChoiceValue, ComplexDraftItem, ListingDraftRecord, ListingFieldEditor,
    ListingLifecycleState, RawDraftValue,
};
#[cfg(test)]
use super::records::{ListingFieldConstraints, ListingFieldDefinition, ListingFieldOption};
#[cfg(test)]
use super::schema::{
    SemanticComplexGroupIdentity, SemanticFieldIdentity, semantic_schema_revision,
};

#[cfg(test)]
pub fn schema_snapshot_from_view(view: &CategorySchemaView) -> CategorySchemaSnapshot {
    let schema_revision = workflow_schema_semantic_revision(view);
    CategorySchemaSnapshot {
        category_key: format!("workflow:{}:{}", view.description_category_id, view.type_id),
        label: format!("Ozon {} / {}", view.description_category_id, view.type_id),
        description_category_id: view.description_category_id,
        type_id: view.type_id,
        schema_revision,
        recipe_id: 0,
        recipe_revision: 0,
        catalog_schema_version: 0,
        fields: view
            .fields
            .iter()
            .map(|field| ListingFieldDefinition {
                key: field.key.clone(),
                label: field.name.clone(),
                group: if field.group_name.is_empty() {
                    "属性".to_owned()
                } else {
                    field.group_name.clone()
                },
                editor: listing_editor_from_workflow(field.editor),
                required: field.constraints.required,
                constraints: ListingFieldConstraints {
                    collection: field.constraints.collection,
                    max_value_count: field.constraints.max_value_count.map(|count| count as u32),
                    dictionary_id: field.constraints.dictionary_id.map(|id| id.to_string()),
                },
                attribute_id: field.attribute_id.map(|id| id.to_string()),
                complex_id: field.complex_id.map(|id| id.to_string()),
                description: field.description.clone(),
                raw_type: field.raw_type.clone(),
                read_only: field.read_only,
                complex_group_collection: field.complex_group_collection,
                aspect: field.aspect,
                options: field
                    .options
                    .iter()
                    .map(|option| ListingFieldOption {
                        id: option.id.to_string(),
                        value: option.value.clone(),
                        info: option.info.clone(),
                        picture: option.picture.clone(),
                    })
                    .collect(),
                options_truncated: field.options_truncated,
            })
            .collect(),
    }
}

pub fn listing_record_for_validation(
    snapshot: Arc<CategorySchemaSnapshot>,
    draft: &WorkflowCategoryDraft,
) -> ListingDraftRecord {
    let mut field_values = BTreeMap::new();
    let mut raw_values = BTreeMap::new();
    let mut list_elements = BTreeMap::new();
    let split_scalar_lines = scalar_collection_keys(&snapshot);
    for (key, value) in &draft.values {
        field_values.insert(key.clone(), workflow_value_text(value));
        if let Some(elements) = list_elements_of(value, split_scalar_lines.contains(key.as_str())) {
            list_elements.insert(key.clone(), elements);
        } else {
            raw_values.insert(key.clone(), workflow_value_raw(value));
        }
    }
    // Category identity belongs to the selected schema, not editable defaults.
    // Supplier drafts deliberately omit these fixed fields; every validator
    // and frozen import must see the same authoritative coordinates.
    for (key, value) in [
        ("description_category_id", snapshot.description_category_id),
        ("type_id", snapshot.type_id),
    ] {
        let value = WorkflowDraftValue::Integer(value);
        field_values.insert(key.to_owned(), workflow_value_text(&value));
        raw_values.insert(key.to_owned(), workflow_value_raw(&value));
    }
    let complex_values: BTreeMap<String, Vec<ComplexDraftItem>> = draft
        .complex_values
        .iter()
        .map(|group| {
            (
                group.complex_id.to_string(),
                group
                    .items
                    .iter()
                    .map(|item| {
                        let mut values = BTreeMap::new();
                        let mut item_lists = BTreeMap::new();
                        for (key, value) in &item.values {
                            if let Some(elements) =
                                list_elements_of(value, split_scalar_lines.contains(key.as_str()))
                            {
                                item_lists.insert(key.clone(), elements);
                            }
                            values.insert(key.clone(), workflow_value_raw(value));
                        }
                        ComplexDraftItem {
                            item_id: item.item_id.clone(),
                            values,
                            list_elements: item_lists,
                        }
                    })
                    .collect(),
            )
        })
        .collect();
    ListingDraftRecord {
        draft_id: "_validate".to_owned(),
        draft_revision: 1,
        category_key: snapshot.category_key.clone(),
        description_category_id: snapshot.description_category_id,
        type_id: snapshot.type_id,
        schema_revision: snapshot.schema_revision.clone(),
        recipe_id: snapshot.recipe_id,
        recipe_revision: snapshot.recipe_revision,
        catalog_schema_version: snapshot.catalog_schema_version,
        schema_snapshot: snapshot,
        field_values,
        raw_values,
        list_elements,
        complex_values,
        field_origins: Vec::new(),
        lifecycle_state: ListingLifecycleState::Draft,
        normalized_snapshot: None,
        execution_plan: None,
        updated_at_ms: 0,
        envelope_version: super::records::CURRENT_ENVELOPE_VERSION,
        unusable: false,
        preview_required: false,
        decode_failures: Vec::new(),
    }
}

#[cfg(test)]
fn listing_editor_from_workflow(editor: CategoryFieldEditor) -> ListingFieldEditor {
    match editor {
        CategoryFieldEditor::Text => ListingFieldEditor::Text,
        CategoryFieldEditor::Integer => ListingFieldEditor::Integer,
        CategoryFieldEditor::Decimal => ListingFieldEditor::Decimal,
        CategoryFieldEditor::Boolean => ListingFieldEditor::Boolean,
        CategoryFieldEditor::SingleSelect => ListingFieldEditor::SingleSelect,
        CategoryFieldEditor::MultiSelect => ListingFieldEditor::MultiSelect,
        CategoryFieldEditor::DictionarySearch => ListingFieldEditor::DictionarySearch,
        CategoryFieldEditor::Url => ListingFieldEditor::Url,
        CategoryFieldEditor::UrlList => ListingFieldEditor::UrlList,
    }
}

/// Schema Revision for a workflow Category Schema view — presentation excluded.
#[cfg(test)]
pub fn workflow_schema_semantic_revision(schema: &CategorySchemaView) -> String {
    let fields = schema
        .fields
        .iter()
        .map(|field| SemanticFieldIdentity {
            key: field.key.clone(),
            editor: listing_editor_from_workflow(field.editor),
            required: field.constraints.required,
            collection: field.constraints.collection,
            max_value_count: field.constraints.max_value_count.map(|count| count as u32),
            dictionary_id: field.constraints.dictionary_id.map(|id| id.to_string()),
            attribute_id: field.attribute_id.map(|id| id.to_string()),
            complex_id: field.complex_id.map(|id| id.to_string()),
            complex_group_collection: field.complex_group_collection,
            read_only: field.read_only,
            aspect: field.aspect,
            option_ids: field
                .options
                .iter()
                .map(|option| option.id.to_string())
                .collect(),
            options_truncated: field.options_truncated,
        })
        .collect::<Vec<_>>();
    let complex_groups = schema
        .complex_groups
        .iter()
        .map(|group| SemanticComplexGroupIdentity {
            complex_id: group.complex_id,
            collection: group.collection,
            field_keys: group.field_keys.clone(),
        })
        .collect::<Vec<_>>();
    // Prefix keeps workflow-dynamic revisions distinct from cloud grid hashes.
    format!(
        "workflow:{}",
        semantic_schema_revision(
            schema.description_category_id,
            schema.type_id,
            0,
            0,
            0,
            &fields,
            &complex_groups,
        )
    )
}

pub fn workflow_value_text(value: &WorkflowDraftValue) -> String {
    match value {
        WorkflowDraftValue::Text(value) | WorkflowDraftValue::Url(value) => value.clone(),
        WorkflowDraftValue::TextList(values) | WorkflowDraftValue::UrlList(values) => {
            values.join(", ")
        }
        WorkflowDraftValue::Integer(value) => value.to_string(),
        WorkflowDraftValue::IntegerList(values) => values
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        WorkflowDraftValue::Decimal(value) => value.to_string(),
        WorkflowDraftValue::DecimalList(values) => values
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        WorkflowDraftValue::Boolean(value) => value.to_string(),
        WorkflowDraftValue::BooleanList(values) => values
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        WorkflowDraftValue::SingleSelect(value) => value.value.clone(),
        WorkflowDraftValue::MultiSelect(values) => values
            .iter()
            .map(|value| value.value.clone())
            .collect::<Vec<_>>()
            .join(", "),
    }
}

fn scalar_collection_keys(snapshot: &CategorySchemaSnapshot) -> BTreeSet<&str> {
    snapshot
        .fields
        .iter()
        .filter(|field| {
            matches!(field.editor, ListingFieldEditor::UrlList)
                || (field.constraints.collection
                    && !matches!(
                        field.editor,
                        ListingFieldEditor::SingleSelect
                            | ListingFieldEditor::MultiSelect
                            | ListingFieldEditor::DictionarySearch
                    ))
        })
        .map(|field| field.key.as_str())
        .collect()
}

/// Element boundary. List variants stay one element per item. A scalar string
/// is historical ingest and splits on newlines only when the field is a
/// non-dictionary collection. `UrlList` and other `*List` variants are never
/// passed through that split.
pub fn list_elements_of(
    value: &WorkflowDraftValue,
    split_scalar_lines: bool,
) -> Option<Vec<String>> {
    match value {
        WorkflowDraftValue::TextList(values) | WorkflowDraftValue::UrlList(values) => {
            Some(values.clone())
        }
        WorkflowDraftValue::IntegerList(values) => {
            Some(values.iter().map(ToString::to_string).collect())
        }
        WorkflowDraftValue::DecimalList(values) => {
            Some(values.iter().map(ToString::to_string).collect())
        }
        WorkflowDraftValue::BooleanList(values) => {
            Some(values.iter().map(ToString::to_string).collect())
        }
        WorkflowDraftValue::Text(text) | WorkflowDraftValue::Url(text) if split_scalar_lines => {
            Some(newline_elements(text))
        }
        _ => None,
    }
}

pub fn workflow_value_raw(value: &WorkflowDraftValue) -> RawDraftValue {
    match value {
        WorkflowDraftValue::SingleSelect(value) => RawDraftValue::OneChoice(ChoiceValue {
            id: value.dictionary_value_id.to_string(),
            label: value.value.clone(),
        }),
        WorkflowDraftValue::MultiSelect(values) => RawDraftValue::ManyChoices(
            values
                .iter()
                .map(|value| ChoiceValue {
                    id: value.dictionary_value_id.to_string(),
                    label: value.value.clone(),
                })
                .collect(),
        ),
        _ => RawDraftValue::Text(workflow_value_text(value)),
    }
}

pub fn newline_elements(value: &str) -> Vec<String> {
    value
        .split('\n')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use crate::{
        CategoryComplexGroup, CategoryFieldConstraints, CategoryFieldOption, CategoryFieldSource,
        CategoryFieldView, WorkflowComplexDraftGroup, WorkflowComplexDraftItem,
        WorkflowDraftSelection,
    };

    use super::*;

    fn field(key: &str, editor: CategoryFieldEditor, complex_id: Option<i64>) -> CategoryFieldView {
        CategoryFieldView {
            key: key.to_owned(),
            name: key.to_owned(),
            description: String::new(),
            group_name: String::new(),
            source: CategoryFieldSource::Attribute,
            editor,
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

    /// A field whose Seller aspect answer is known.
    fn dimensionalised(
        mut view: CategorySchemaView,
        index: usize,
        aspect: bool,
    ) -> CategorySchemaView {
        view.fields[index].aspect = Some(aspect);
        view
    }

    fn view() -> CategorySchemaView {
        CategorySchemaView {
            description_category_id: 17027906,
            type_id: 91976,
            language: None,
            fields: vec![
                field("name", CategoryFieldEditor::Text, None),
                field("color", CategoryFieldEditor::SingleSelect, None),
                field("part", CategoryFieldEditor::Text, Some(7)),
            ],
            complex_groups: vec![CategoryComplexGroup {
                complex_id: 7,
                name: "组".to_owned(),
                collection: true,
                field_keys: vec!["part".to_owned()],
            }],
        }
    }

    #[test]
    fn typed_draft_values_project_into_listing_text_and_raw_values() {
        let draft = WorkflowCategoryDraft {
            values: BTreeMap::from([
                (
                    "name".to_owned(),
                    WorkflowDraftValue::Text(" Картина ".to_owned()),
                ),
                (
                    "color".to_owned(),
                    WorkflowDraftValue::SingleSelect(WorkflowDraftSelection {
                        dictionary_value_id: 42,
                        value: "蓝色".to_owned(),
                    }),
                ),
            ]),
            complex_values: vec![WorkflowComplexDraftGroup {
                complex_id: 7,
                items: vec![WorkflowComplexDraftItem {
                    item_id: "ci_part".to_owned(),
                    values: BTreeMap::from([(
                        "part".to_owned(),
                        WorkflowDraftValue::Text("A".to_owned()),
                    )]),
                }],
            }],
            ..Default::default()
        };
        let record =
            listing_record_for_validation(Arc::new(schema_snapshot_from_view(&view())), &draft);

        assert_eq!(
            record.field_values["description_category_id"],
            record.description_category_id.to_string()
        );
        assert_eq!(record.field_values["type_id"], record.type_id.to_string());
        assert!(!draft.values.contains_key("description_category_id"));
        assert_eq!(record.field_values["name"], " Картина ");
        assert_eq!(
            record.raw_values["color"],
            RawDraftValue::OneChoice(ChoiceValue {
                id: "42".to_owned(),
                label: "蓝色".to_owned()
            })
        );
        assert_eq!(record.complex_values["7"][0].item_id, "ci_part");
        assert_eq!(record.lifecycle_state, ListingLifecycleState::Draft);
    }

    /// C6: only semantic material may move a Schema Revision.
    #[test]
    fn schema_revision_ignores_labels_and_moves_on_semantic_drift() {
        let baseline = workflow_schema_semantic_revision(&view());
        assert!(baseline.starts_with("workflow:sha256:"));

        let mut cosmetic = view();
        cosmetic.fields[0].name = "别的标签".to_owned();
        cosmetic.fields[0].description = "说明".to_owned();
        cosmetic.fields[0].group_name = "分组".to_owned();
        assert_eq!(baseline, workflow_schema_semantic_revision(&cosmetic));

        let mut semantic = view();
        semantic.fields[0].constraints.required = true;
        assert_ne!(baseline, workflow_schema_semantic_revision(&semantic));

        let mut options = view();
        options.fields[1].options.push(CategoryFieldOption {
            id: 42,
            value: "蓝色".to_owned(),
            info: String::new(),
            picture: String::new(),
        });
        assert_ne!(baseline, workflow_schema_semantic_revision(&options));

        // An aspect flip is variant semantics, so the revision must move: a
        // Category Schema that starts distinguishing variants is not the same
        // schema a Draft was pinned to.
        assert_ne!(
            baseline,
            workflow_schema_semantic_revision(&dimensionalised(view(), 1, true))
        );
        // ...and the unknown state is a different fact from "known not to be
        // a dimension", so it moves the revision too.
        assert_ne!(
            workflow_schema_semantic_revision(&dimensionalised(view(), 1, false)),
            workflow_schema_semantic_revision(&dimensionalised(view(), 1, true))
        );
    }

    #[test]
    fn list_elements_survive_the_bridge_and_scalar_history_splits_on_newlines_only() {
        let mut schema = view();
        let mut tags = field("tags", CategoryFieldEditor::Text, None);
        tags.constraints.collection = true;
        schema
            .fields
            .push(field("photos", CategoryFieldEditor::UrlList, None));
        schema.fields.push(tags);
        let draft = WorkflowCategoryDraft {
            values: BTreeMap::from([
                (
                    "tags".to_owned(),
                    WorkflowDraftValue::Text("a, b\nc; d".to_owned()),
                ),
                (
                    "photos".to_owned(),
                    WorkflowDraftValue::UrlList(vec!["https://cdn.example/a,b.jpg".to_owned()]),
                ),
                (
                    "notes".to_owned(),
                    WorkflowDraftValue::TextList(vec!["a, b".to_owned(), "c; d\ne".to_owned()]),
                ),
                ("zero".to_owned(), WorkflowDraftValue::Integer(0)),
                ("flag".to_owned(), WorkflowDraftValue::Boolean(false)),
                ("empty".to_owned(), WorkflowDraftValue::TextList(vec![])),
            ]),
            ..Default::default()
        };
        let record =
            listing_record_for_validation(Arc::new(schema_snapshot_from_view(&schema)), &draft);
        assert_eq!(
            record.list_elements["tags"],
            vec!["a, b".to_owned(), "c; d".to_owned()]
        );
        assert_eq!(record.field_values["tags"], "a, b\nc; d");
        assert_eq!(
            record.list_elements["photos"],
            vec!["https://cdn.example/a,b.jpg".to_owned()]
        );
        assert_eq!(
            record.list_elements["notes"],
            vec!["a, b".to_owned(), "c; d\ne".to_owned()]
        );
        assert_eq!(
            record.raw_values["zero"],
            RawDraftValue::Text("0".to_owned())
        );
        assert_eq!(
            record.raw_values["flag"],
            RawDraftValue::Text("false".to_owned())
        );
        assert_eq!(record.list_elements["empty"], Vec::<String>::new());
        assert!(!record.list_elements.contains_key("missing"));
        assert!(!record.raw_values.contains_key("empty"));
    }
}

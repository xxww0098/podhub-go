//! Supplier defaults use the final listing validator, with per-product fields deferred.
use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;

use serde::{Deserialize, Serialize};

use crate::ops::SchemaMaterial;
use crate::records::{FieldAddress, ListingFieldDefinition, ListingFieldEditor};
use crate::validate::validate_fields_with;
use crate::workflow_dto::types::WorkflowDraftSelection;
use crate::{
    WorkflowCategoryDraft, WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierConfigInput {
    pub values: BTreeMap<String, Vec<SupplierValue>>,
    pub complex_values: Vec<SupplierComplexGroup>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierComplexGroup {
    pub complex_id: i64,
    pub items: Vec<SupplierComplexItem>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierComplexItem {
    pub item_id: String,
    pub values: BTreeMap<String, Vec<SupplierValue>>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum SupplierValue {
    Text { value: String },
    Integer { value: i64 },
    Decimal { value: String },
    Flag { value: bool },
    Options { options: Vec<SupplierOption> },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SupplierOption {
    pub option_id: i64,
    pub value: String,
}

#[derive(Debug, Serialize)]
pub struct SupplierConfigOutcome {
    pub draft: WorkflowCategoryDraft,
    pub issues: Vec<SupplierFieldIssue>,
}

#[derive(Debug, Serialize)]
pub struct SupplierFieldIssue {
    pub issue: &'static str,
    pub field_key: String,
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub complex_id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_index: Option<usize>,
}

fn issue(
    key: &str,
    code: &str,
    message: String,
    location: Option<(i64, usize)>,
) -> SupplierFieldIssue {
    SupplierFieldIssue {
        issue: "field_validation",
        field_key: key.to_owned(),
        code: code.to_owned(),
        message,
        complex_id: location.map(|v| v.0),
        item_index: location.map(|v| v.1),
    }
}

pub fn row_owned(field: &ListingFieldDefinition) -> bool {
    matches!(
        field.key.as_str(),
        "offer_id"
            | "name"
            | "price"
            | "old_price"
            | "images"
            | "images360"
            | "primary_image"
            | "color_image"
    ) || matches!(
        field.attribute_id.as_deref(),
        Some("4191" | "9024" | "9048" | "23171" | "7109")
    )
}

fn field_for_key<'a>(
    fields: &'a [ListingFieldDefinition],
    key: &str,
    complex: i64,
) -> Option<&'a ListingFieldDefinition> {
    let parts = key.split(':').collect::<Vec<_>>();
    let field = match parts.as_slice() {
        ["fixed", name]
            if complex == 0
                && matches!(
                    *name,
                    "barcode"
                        | "width"
                        | "height"
                        | "depth"
                        | "dimension_unit"
                        | "weight"
                        | "weight_unit"
                        | "vat"
                        | "currency_code"
                ) =>
        {
            fields
                .iter()
                .find(|f| f.key == *name && f.attribute_id.is_none())
        }
        ["attribute", id, group] if group.parse::<i64>().ok() == Some(complex) => fields
            .iter()
            .find(|f| f.attribute_id.as_deref() == Some(*id)),
        _ => None,
    }?;
    (field
        .complex_id
        .as_deref()
        .and_then(|id| id.parse::<i64>().ok())
        .unwrap_or(0)
        == complex
        && !row_owned(field))
    .then_some(field)
}

fn workflow_value(
    entries: &[SupplierValue],
    field: &ListingFieldDefinition,
) -> Option<WorkflowDraftValue> {
    use SupplierValue as S;
    use WorkflowDraftValue as W;
    let first = entries.first()?;
    let collection = field.constraints.collection || entries.len() > 1;
    match first {
        S::Text { .. } => {
            let values = entries
                .iter()
                .map(|v| {
                    if let S::Text { value } = v {
                        Some(value.clone())
                    } else {
                        None
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            Some(if collection {
                if matches!(
                    field.editor,
                    ListingFieldEditor::Url | ListingFieldEditor::UrlList
                ) {
                    W::UrlList(values)
                } else {
                    W::TextList(values)
                }
            } else if field.editor == ListingFieldEditor::Url {
                W::Url(values[0].clone())
            } else {
                W::Text(values[0].clone())
            })
        }
        S::Integer { .. } => {
            let values = entries
                .iter()
                .map(|v| {
                    if let S::Integer { value } = v {
                        Some(*value)
                    } else {
                        None
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            Some(if collection {
                W::IntegerList(values)
            } else {
                W::Integer(values[0])
            })
        }
        S::Decimal { .. } => {
            let values = entries
                .iter()
                .map(|v| {
                    if let S::Decimal { value } = v {
                        Some(value.clone())
                    } else {
                        None
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            let numbers = values
                .iter()
                .map(|v| v.parse::<f64>().ok().filter(|v| v.is_finite()))
                .collect::<Option<Vec<_>>>();
            Some(match numbers {
                Some(n) if collection => W::DecimalList(n),
                Some(n) => W::Decimal(n[0]),
                None if collection => W::TextList(values),
                None => W::Text(values[0].clone()),
            })
        }
        S::Flag { .. } => {
            let values = entries
                .iter()
                .map(|v| {
                    if let S::Flag { value } = v {
                        Some(*value)
                    } else {
                        None
                    }
                })
                .collect::<Option<Vec<_>>>()?;
            Some(if collection {
                W::BooleanList(values)
            } else {
                W::Boolean(values[0])
            })
        }
        S::Options { .. } => {
            let mut values = Vec::new();
            for entry in entries {
                let S::Options { options } = entry else {
                    return None;
                };
                values.extend(options.iter().map(|o| WorkflowDraftSelection {
                    dictionary_value_id: o.option_id,
                    value: o.value.clone(),
                }));
            }
            Some(if !field.constraints.collection && values.len() == 1 {
                W::SingleSelect(values.remove(0))
            } else {
                W::MultiSelect(values)
            })
        }
    }
}

fn project_values(
    fields: &[ListingFieldDefinition],
    values: &BTreeMap<String, Vec<SupplierValue>>,
    location: Option<(i64, usize)>,
    issues: &mut Vec<SupplierFieldIssue>,
) -> BTreeMap<String, WorkflowDraftValue> {
    let mut out = BTreeMap::new();
    for (key, entries) in values {
        let Some(field) = field_for_key(fields, key, location.map(|v| v.0).unwrap_or(0)) else {
            let field_key = key
                .strip_prefix("fixed:")
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    key.split(':')
                        .nth(1)
                        .map(|id| format!("attribute_{id}"))
                        .unwrap_or_else(|| key.clone())
                });
            issues.push(issue(
                &field_key,
                "unknown_field",
                format!("配置字段 {key} 不属于当前可编辑位置"),
                location,
            ));
            continue;
        };
        if entries.is_empty() {
            continue;
        }
        if !field.constraints.collection && entries.len() > 1 {
            issues.push(issue(
                &field.key,
                "cardinality",
                format!("{} 只允许一个值", field.label),
                location,
            ));
        }
        if let Some(value) = workflow_value(entries, field) {
            out.insert(field.key.clone(), value);
        } else {
            issues.push(issue(
                &field.key,
                "type",
                format!("{} 的值类型不一致", field.label),
                location,
            ));
        }
    }
    out
}

pub fn validate(schema: &SchemaMaterial, input: &SupplierConfigInput) -> SupplierConfigOutcome {
    let mut issues = Vec::new();
    let fields = &schema.snapshot().fields;
    let mut draft = WorkflowCategoryDraft {
        values: project_values(fields, &input.values, None, &mut issues),
        ..Default::default()
    };
    let mut groups = BTreeSet::new();
    let mut item_ids = BTreeSet::new();
    for group in &input.complex_values {
        let known = fields.iter().any(|f| {
            f.complex_id.as_deref().and_then(|v| v.parse::<i64>().ok()) == Some(group.complex_id)
        });
        if !known || !groups.insert(group.complex_id) {
            issues.push(issue(
                "",
                "complex_placement",
                format!("复杂组 {} 无效或重复", group.complex_id),
                Some((group.complex_id, 0)),
            ));
            continue;
        }
        let mut items = Vec::new();
        for (index, item) in group.items.iter().enumerate() {
            if item.item_id.trim().is_empty() || !item_ids.insert(item.item_id.clone()) {
                issues.push(issue(
                    "",
                    "complex_placement",
                    "复杂组条目标识无效或重复".to_owned(),
                    Some((group.complex_id, index)),
                ));
            }
            items.push(WorkflowComplexDraftItem {
                item_id: item.item_id.clone(),
                values: project_values(
                    fields,
                    &item.values,
                    Some((group.complex_id, index)),
                    &mut issues,
                ),
            });
        }
        draft.complex_values.push(WorkflowComplexDraftGroup {
            complex_id: group.complex_id,
            items,
        });
    }
    let mut snapshot = schema.snapshot().as_ref().clone();
    for field in &mut snapshot.fields {
        if row_owned(field) {
            field.required = false;
        }
        if let Some(raw) = &field.raw_type {
            let supported = matches!(
                raw.trim()
                    .to_ascii_lowercase()
                    .replace(['-', ' '], "_")
                    .as_str(),
                "integer"
                    | "int"
                    | "int32"
                    | "int64"
                    | "long"
                    | "decimal"
                    | "float"
                    | "double"
                    | "number"
                    | "numeric"
                    | "boolean"
                    | "bool"
                    | "url"
                    | "uri"
                    | "link"
                    | "url_list"
                    | "urls"
                    | "uri_list"
                    | "link_list"
                    | "enum"
                    | "enumeration"
                    | "select"
                    | "dictionary"
                    | "multiselect"
                    | "multi_select"
                    | "multi_enum"
                    | "enum_list"
                    | "string"
                    | "text"
                    | "char"
                    | "textarea"
                    | "rich_text"
                    | "richtext"
            );
            if !raw.trim().is_empty() && !supported && field.required {
                issues.push(issue(
                    &field.key,
                    "type",
                    format!("{} 使用尚未支持的 Ozon 类型 {raw}", field.label),
                    None,
                ));
            }
        }
    }
    let record = crate::bridge::listing_record_for_validation(Arc::new(snapshot), &draft);
    let (_, field_issues) = validate_fields_with(&record, schema.materials());
    {
        for found in field_issues {
            let location = match &found.address {
                FieldAddress::Complex {
                    group_key, item_id, ..
                } => group_key.parse::<i64>().ok().map(|id| {
                    (
                        id,
                        draft
                            .complex_values
                            .iter()
                            .find(|g| g.complex_id == id)
                            .and_then(|g| g.items.iter().position(|i| i.item_id == *item_id))
                            .unwrap_or(0),
                    )
                }),
                FieldAddress::Plain { .. } => None,
            };
            issues.push(issue(
                &found.field_key,
                &found.code,
                found.message,
                location,
            ));
        }
    }
    SupplierConfigOutcome { draft, issues }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::records::CategorySchemaSnapshot;
    use crate::validate::DictionaryMaterials;
    use serde_json::{Value, json};

    fn schema() -> SchemaMaterial {
        let mut fields = Vec::new();
        for (key, editor, required) in [
            ("name", "text", true),
            ("width", "integer", true),
            ("dimension_unit", "text", true),
            ("currency_code", "text", false),
        ] {
            fields.push(json!({"key":key,"label":key,"group":"Fixed","editor":editor,"required":required,"constraints":{"collection":false},"options":[]}));
        }
        fields.push(json!({"key":"attribute_85","label":"brand","group":"attrs","editor":"dictionary_search","required":true,"attribute_id":"85","constraints":{"collection":false,"dictionary_id":"5"},"options":[],"options_truncated":true}));
        for (id, editor, required) in [(8790, "url", true), (8789, "text", false)] {
            fields.push(json!({"key":format!("attribute_{id}"),"label":id.to_string(),"group":"PDF","editor":editor,"required":required,"attribute_id":id.to_string(),"complex_id":"8788","complex_group_collection":true,"constraints":{"collection":false},"options":[]}));
        }
        let snapshot:CategorySchemaSnapshot=serde_json::from_value(json!({"category_key":"test","label":"test","description_category_id":1,"type_id":2,"schema_revision":"test","recipe_id":0,"recipe_revision":0,"catalog_schema_version":0,"fields":fields})).unwrap();
        let mut materials = DictionaryMaterials::default();
        materials.insert_searched(1, 85, 5, 9, "confirmed");
        SchemaMaterial::new(Arc::new(snapshot), materials)
    }
    fn input() -> Value {
        json!({"values":{"fixed:width":[{"kind":"integer","value":10}],"fixed:dimension_unit":[{"kind":"text","value":"mm"}],"fixed:currency_code":[{"kind":"text","value":"RUB"}],"attribute:85:0":[{"kind":"options","options":[{"option_id":9,"value":"confirmed"}]}]},"complex_values":[{"complex_id":8788,"items":[{"item_id":"11111111-1111-4111-8111-111111111111","values":{"attribute:8790:8788":[{"kind":"text","value":"https://example.com/a.pdf"}]}},{"item_id":"22222222-2222-4222-8222-222222222222","values":{"attribute:8790:8788":[{"kind":"text","value":"https://example.com/b.pdf"}]}}]}]})
    }

    #[test]
    fn accepts_the_shared_editor_item_ids_without_rewriting_them() {
        let mut value = input();
        let id = "ci_233dcabfbac64c558e36b13b7d872aae";
        value["complex_values"][0]["items"][1]["item_id"] = json!(id);
        let out = validate(&schema(), &serde_json::from_value(value).unwrap());
        assert!(out.issues.is_empty(), "{:?}", out.issues);
        assert_eq!(out.draft.complex_values[0].items[1].item_id, id);
    }
    fn run(value: Value) -> SupplierConfigOutcome {
        validate(&schema(), &serde_json::from_value(value).unwrap())
    }

    #[test]
    fn uses_final_rules_and_keeps_repeated_items() {
        let out = run(input());
        assert!(out.issues.is_empty(), "{:?}", out.issues);
        assert!(!out.draft.values.contains_key("name"));
        assert_eq!(out.draft.complex_values[0].items.len(), 2);
        assert_eq!(
            out.draft.complex_values[0].items[1].item_id,
            "22222222-2222-4222-8222-222222222222"
        );
    }
    #[test]
    fn required_dimensions_and_confirmed_dictionary_ids_still_block() {
        let mut value = input();
        value["values"]["fixed:width"] = json!([{"kind":"integer","value":-1}]);
        value["values"]["attribute:85:0"] =
            json!([{"kind":"options","options":[{"option_id":999,"value":"forged"}]}]);
        value["values"]
            .as_object_mut()
            .unwrap()
            .remove("fixed:dimension_unit");
        let out = run(value);
        for (field, code) in [
            ("width", "invalid_positive_integer"),
            ("dimension_unit", "required"),
            ("attribute_85", "dictionary_material_required"),
        ] {
            assert!(
                out.issues
                    .iter()
                    .any(|i| i.field_key == field && i.code == code),
                "{:?}",
                out.issues
            );
        }
    }
    #[test]
    fn errors_point_to_the_second_complex_item() {
        let mut value = input();
        value["complex_values"][0]["items"][1]["values"]["attribute:8790:8788"] =
            json!([{"kind":"text","value":"bad-url"}]);
        let out = run(value);
        assert!(out.issues.iter().any(|i| i.code == "invalid_url"
            && i.item_index == Some(1)
            && i.complex_id == Some(8788)));
    }
    #[test]
    fn unknown_placements_and_duplicates_are_not_dropped_silently() {
        let mut value = input();
        value["values"]["attribute:8790:8788"] = json!([{"kind":"text","value":"wrong-place"}]);
        value["complex_values"][0]["items"][1]["item_id"] =
            value["complex_values"][0]["items"][0]["item_id"].clone();
        let out = run(value);
        assert!(out.issues.iter().any(|i| i.code == "unknown_field"));
        assert!(out.issues.iter().any(|i| i.code == "complex_placement"));
    }
}

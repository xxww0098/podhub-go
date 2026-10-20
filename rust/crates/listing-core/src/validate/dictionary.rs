//! Dictionary materials and the dictionary audit: whether a chosen value id
//! is a member of its Seller dictionary, and which label a confirmed id pairs
//! with when the snapshot is built.

use std::collections::BTreeMap;

use super::issues::{FieldIssue, IssueParameter, issue};
use crate::issue_keys::OzonValidateCode as Code;
use crate::records::{FieldAddress, ListingFieldEditor, NormalizedAttributeValue, RawDraftValue};

/// Complete dictionaries and individual Seller-confirmed search hits.
/// The caller prefetches these. Validation never calls Seller.
#[derive(Debug, Clone, Default)]
pub struct DictionaryMaterials {
    members: BTreeMap<(i64, i64, i64), BTreeMap<i64, String>>,
    searched: BTreeMap<(i64, i64, i64), BTreeMap<i64, String>>,
}

impl DictionaryMaterials {
    pub fn insert(
        &mut self,
        description_category_id: i64,
        attribute_id: i64,
        dictionary_id: i64,
        value_id: i64,
        label: impl Into<String>,
    ) {
        self.members
            .entry((description_category_id, attribute_id, dictionary_id))
            .or_default()
            .insert(value_id, label.into());
    }

    pub fn insert_searched(
        &mut self,
        description_category_id: i64,
        attribute_id: i64,
        dictionary_id: i64,
        value_id: i64,
        label: impl Into<String>,
    ) {
        self.searched
            .entry((description_category_id, attribute_id, dictionary_id))
            .or_default()
            .insert(value_id, label.into());
    }

    /// Seller-confirmed search hits as `(description_category_id, attribute_id,
    /// dictionary_id, value_id, label)`, in stable key then value-id order.
    pub fn searched_entries(&self) -> impl Iterator<Item = (i64, i64, i64, i64, &str)> + '_ {
        self.searched
            .iter()
            .flat_map(|(&(category, attribute, dictionary), values)| {
                values.iter().map(move |(&value, label)| {
                    (category, attribute, dictionary, value, label.as_str())
                })
            })
    }

    fn get(&self, key: (i64, i64, i64)) -> Option<&BTreeMap<i64, String>> {
        self.members.get(&key)
    }
}

pub(crate) fn is_dictionary_editor(editor: ListingFieldEditor) -> bool {
    matches!(
        editor,
        ListingFieldEditor::SingleSelect
            | ListingFieldEditor::MultiSelect
            | ListingFieldEditor::DictionarySearch
    )
}

pub(super) fn parsed_choice(
    choice: &crate::records::ChoiceValue,
) -> Option<NormalizedAttributeValue> {
    let id = choice.id.trim().parse::<i64>().ok()?;
    let label = choice.label.trim();
    Some(NormalizedAttributeValue {
        value: if label.is_empty() {
            id.to_string()
        } else {
            label.to_owned()
        },
        dictionary_value_id: Some(id),
    })
}

fn dictionary_coordinate(
    field: &crate::schema::ListingFieldDefinition,
    category_id: i64,
) -> Option<(i64, i64, i64)> {
    let attribute_id = field.attribute_id.as_deref()?.parse().ok()?;
    let dictionary_id = field.constraints.dictionary_id.as_deref()?.parse().ok()?;
    Some((category_id, attribute_id, dictionary_id))
}

pub(super) fn fill_choice_label(
    field: &crate::schema::ListingFieldDefinition,
    category_id: i64,
    materials: &DictionaryMaterials,
    entry: &mut NormalizedAttributeValue,
) {
    let Some(id) = entry.dictionary_value_id else {
        return;
    };
    // Search evidence came from Seller. Never let a draft-supplied label
    // replace the value paired with that confirmed dictionary ID.
    if !field
        .options
        .iter()
        .any(|option| option.id.trim().parse::<i64>().ok() == Some(id))
    {
        if let Some(label) = dictionary_coordinate(field, category_id)
            .and_then(|key| materials.searched.get(&key))
            .and_then(|members| members.get(&id))
            .filter(|label| !label.trim().is_empty())
        {
            entry.value = label.trim().to_owned();
            return;
        }
    }
    if !entry.value.is_empty() && entry.value != id.to_string() {
        return;
    }
    if let Some(option) = field.options.iter().find(|option| {
        option.id.trim().parse::<i64>().ok() == Some(id) && !option.value.trim().is_empty()
    }) {
        entry.value = option.value.trim().to_owned();
        return;
    }
    let Some(key) = dictionary_coordinate(field, category_id) else {
        return;
    };
    if let Some(label) = materials
        .get(key)
        .or_else(|| materials.searched.get(&key))
        .and_then(|members| members.get(&id))
        .filter(|label| !label.trim().is_empty())
    {
        entry.value = label.trim().to_owned();
    }
}

pub(super) fn audit_dictionary(
    field: &crate::schema::ListingFieldDefinition,
    raw: Option<&RawDraftValue>,
    address: Option<&FieldAddress>,
    category_id: i64,
    materials: &DictionaryMaterials,
    issues: &mut Vec<FieldIssue>,
) {
    let Some(raw) = raw else {
        return;
    };
    let choices: Vec<&crate::records::ChoiceValue> = match raw {
        RawDraftValue::OneChoice(choice) => vec![choice],
        RawDraftValue::ManyChoices(choices) => choices.iter().collect(),
        RawDraftValue::Text(value) if !value.trim().is_empty() => {
            push_dictionary_issue(
                field,
                address,
                None,
                None,
                Code::InvalidDictionaryId,
                "不是字典 id",
                issues,
            );
            return;
        }
        _ => return,
    };
    for (index, choice) in choices.into_iter().enumerate() {
        let Ok(id) = choice.id.trim().parse::<i64>() else {
            push_dictionary_issue(
                field,
                address,
                Some(index),
                Some(choice.id.as_str()),
                Code::InvalidDictionaryId,
                &format!("「{}」不是字典 id", choice.id),
                issues,
            );
            continue;
        };
        if field
            .options
            .iter()
            .any(|option| option.id.trim().parse::<i64>().ok() == Some(id))
        {
            continue;
        }
        if field.options_truncated {
            let key = dictionary_coordinate(field, category_id);
            match key.and_then(|key| materials.get(key)) {
                Some(members) if !members.contains_key(&id) => push_dictionary_issue(
                    field,
                    address,
                    Some(index),
                    Some(choice.id.as_str()),
                    Code::UnknownDictionaryId,
                    &format!("{id} 不在该字典里"),
                    issues,
                ),
                Some(_) => {}
                None if key
                    .and_then(|key| materials.searched.get(&key))
                    .is_some_and(|members| members.contains_key(&id)) => {}
                None => push_dictionary_issue(
                    field,
                    address,
                    Some(index),
                    Some(choice.id.as_str()),
                    Code::DictionaryMaterialRequired,
                    "需要该类目属性的字典材料",
                    issues,
                ),
            }
        } else if !field.options.is_empty() {
            push_dictionary_issue(
                field,
                address,
                Some(index),
                Some(choice.id.as_str()),
                Code::UnknownDictionaryId,
                &format!("{id} 不在该字典里"),
                issues,
            );
        }
    }
}

fn push_dictionary_issue(
    field: &crate::schema::ListingFieldDefinition,
    address: Option<&FieldAddress>,
    index: Option<usize>,
    id_text: Option<&str>,
    code: Code,
    message: &str,
    issues: &mut Vec<FieldIssue>,
) {
    let mut field_issue = issue(
        &field.key,
        code,
        format!("{}：{message}", field.label),
        Some(format!("为「{}」选择一个字典值", field.label)),
    );
    if let Some(address) = address {
        field_issue.address = address.clone();
    }
    if let Some(index) = index.and_then(|index| u32::try_from(index).ok())
        && let FieldAddress::Complex { value_index, .. } = &mut field_issue.address
    {
        *value_index = Some(index);
    }
    if let Some(index) = index.and_then(|index| i64::try_from(index).ok()) {
        field_issue
            .parameters
            .insert("value_index".to_owned(), IssueParameter::Integer(index));
    }
    if let Some(id_text) = id_text {
        field_issue.parameters.insert(
            "id".to_owned(),
            IssueParameter::Text(id_text.trim().to_owned()),
        );
    }
    issues.push(field_issue);
}

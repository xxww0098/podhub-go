//! Recognition fills blank prose and records Candidate Edits for explicit review.

use crate::{
    CategoryFieldEditor, CategoryFieldView, CategorySchemaView, WorkflowAiCandidate,
    WorkflowAiCandidateState, WorkflowAiFieldPolicy, WorkflowAiResult, WorkflowDraftValue,
};
use crate::{DESCRIPTION_ATTRIBUTE_ID, SEARCH_TAGS_ATTRIBUTE_ID};

use super::content_policy::{
    ai_allowed, append_unknown_reviews, candidate_address, field_key, has_content, is_manual,
    is_stable_item_id, record_origin, value_at, write_value,
};
use super::envelope::{RowAi, RowPayload};
use super::records::{FieldAddress, FieldValueOriginKind};

pub fn settlement_plan(
    schema: &CategorySchemaView,
    current: &RowPayload,
    policy: &WorkflowAiFieldPolicy,
    result: &WorkflowAiResult,
    request_id: &str,
    prompt_sha256: &str,
    now_ms: u64,
) -> RowPayload {
    let mut next = current.clone();
    next.ai = RowAi {
        request_id: request_id.to_owned(),
        prompt_sha256: prompt_sha256.to_owned(),
        model_version: result.model.clone(),
        summary: Some(crate::WorkflowAiSummary {
            tags: result.tags.clone(),
            model: result.model.clone(),
        }),
        candidates: result
            .candidates
            .iter()
            .map(|candidate| {
                let mut candidate = candidate.clone();
                candidate.state = WorkflowAiCandidateState::Proposed;
                candidate.current_value = None;
                candidate.issue = None;
                match candidate_address(&candidate.address) {
                    Some(address) => {
                        candidate.address = address.clone();
                        candidate.current_value = value_at(&current.draft, &address).cloned();
                        if !ai_allowed(schema, policy, &address) || is_manual(current, &address) {
                            candidate.state = WorkflowAiCandidateState::Unresolved;
                            candidate.issue =
                                Some("字段不在识图策略内或已由人工填写；请保留现值".to_owned());
                        }
                    }
                    None => {
                        candidate.state = WorkflowAiCandidateState::Unresolved;
                        candidate.issue = Some(
                            "字段不在识图策略内、地址无效或已由人工填写；请保留现值".to_owned(),
                        );
                    }
                }
                candidate
            })
            .collect(),
    };

    let tags = ai_search_tags_text(&result.tags).unwrap_or_default();
    for (key, attribute, raw) in [
        (Some("name"), None, result.ru.as_str()),
        (
            None,
            Some(DESCRIPTION_ATTRIBUTE_ID),
            result.description.as_str(),
        ),
        (None, Some(SEARCH_TAGS_ATTRIBUTE_ID), tags.as_str()),
    ] {
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let Some(field) = schema.fields.iter().find(|field| {
            key.is_some_and(|key| field.key == key)
                || attribute.is_some_and(|id| field.attribute_id == Some(id))
        }) else {
            continue;
        };
        let address = field_address(field, &current.draft);
        if !ai_allowed(schema, policy, &address)
            || is_manual(current, &address)
            || current.draft.cleared.contains(field_key(&address))
        {
            continue;
        }
        // Addressed proposals take the review path even when prose also names
        // that field. Nothing pending is silently applied by the prose shortcut.
        if next
            .ai
            .candidates
            .iter()
            .any(|candidate| candidate_address(&candidate.address).as_ref() == Some(&address))
        {
            continue;
        }
        let value = prose_value(field, raw);
        let previous = value_at(&current.draft, &address);
        if has_content(previous) {
            if !current
                .field_origins
                .iter()
                .any(|origin| origin.address == address)
            {
                next.ai.candidates.push(WorkflowAiCandidate {
                    address: address.clone(),
                    value,
                    current_value: previous.cloned(),
                    source: "ai".to_owned(),
                    state: WorkflowAiCandidateState::Proposed,
                    issue: Some("现值没有来源记录；请确认保留现值或采用识别建议".to_owned()),
                });
            }
        } else if write_value(&mut next.draft, &address, Some(value)) {
            record_origin(
                &mut next,
                address,
                FieldValueOriginKind::AiConfirmed,
                Some(request_id.to_owned()),
                now_ms,
            );
        }
    }
    append_unknown_reviews(&mut next, schema);
    next
}

pub fn ai_search_tags_text(tags: &[String]) -> Option<String> {
    let value = tags
        .iter()
        .map(|tag| tag.trim().trim_start_matches('#').trim())
        .filter(|tag| !tag.is_empty())
        .map(|tag| format!("#{tag}"))
        .collect::<Vec<_>>()
        .join(" ");
    (!value.is_empty()).then_some(value)
}

fn field_address(field: &CategoryFieldView, draft: &super::WorkflowCategoryDraft) -> FieldAddress {
    match field.complex_id {
        None => FieldAddress::Plain {
            field_key: field.key.clone(),
        },
        Some(id) => FieldAddress::Complex {
            group_key: id.to_string(),
            item_id: draft
                .complex_values
                .iter()
                .find(|group| group.complex_id == id)
                .and_then(|group| {
                    group
                        .items
                        .iter()
                        .find(|item| is_stable_item_id(&item.item_id))
                })
                .map(|item| item.item_id.clone())
                .unwrap_or_default(),
            field_key: field.key.clone(),
            value_index: None,
        },
    }
}

fn prose_value(field: &CategoryFieldView, raw: &str) -> WorkflowDraftValue {
    let lines = || {
        raw.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect()
    };
    if field.editor == CategoryFieldEditor::UrlList {
        WorkflowDraftValue::UrlList(lines())
    } else if field.constraints.collection {
        WorkflowDraftValue::TextList(lines())
    } else if field.editor == CategoryFieldEditor::Url {
        WorkflowDraftValue::Url(raw.to_owned())
    } else {
        WorkflowDraftValue::Text(raw.to_owned())
    }
}

#[cfg(test)]
#[path = "content_policy_tests.rs"]
mod tests;

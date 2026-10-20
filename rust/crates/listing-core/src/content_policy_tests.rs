use super::*;
use crate::FieldAddress as WorkflowAddress;
use crate::compose::compose_tests::golden_row;
use crate::content_policy::{self, decide_candidate, record_origin};
use crate::projections::{category_schema_view, default_ai_policy};
use crate::{WorkflowComplexDraftGroup, WorkflowComplexDraftItem};

/// Deterministic stand-in for host-injected randomness (production callers
/// use a real RNG — see `mint_item_id`'s doc comment). Distinct per call
/// within one test so minted item ids stay distinguishable.
fn incrementing_random_bytes() -> impl FnMut() -> [u8; 16] {
    let mut counter: u128 = 0;
    move || {
        counter += 1;
        counter.to_be_bytes()
    }
}

fn result() -> WorkflowAiResult {
    WorkflowAiResult {
        ru: "Новое имя".to_owned(),
        description: "Новое описание".to_owned(),
        tags: vec![],
        model: "model".to_owned(),
        cost_microfen: 0,
        candidates: vec![],
    }
}

#[test]
fn settlement_preserves_nonempty_fields_and_leaves_candidates_proposed() {
    let mut row = golden_row();
    let schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let policy = default_ai_policy(&schema);
    record_origin(
        &mut row,
        FieldAddress::Plain {
            field_key: "name".to_owned(),
        },
        FieldValueOriginKind::Manual,
        None,
        1,
    );
    record_origin(
        &mut row,
        FieldAddress::Plain {
            field_key: "description".to_owned(),
        },
        FieldValueOriginKind::CardDefault,
        None,
        1,
    );
    let mut result = result();
    result.candidates.push(WorkflowAiCandidate {
        address: WorkflowAddress::Plain {
            field_key: "name".to_owned(),
        },
        value: WorkflowDraftValue::Text("proposal".to_owned()),
        current_value: None,
        source: "ai".to_owned(),
        state: WorkflowAiCandidateState::Proposed,
        issue: None,
    });
    let next = settlement_plan(&schema, &row, &policy, &result, "air-one", "prompt", 2);
    assert_eq!(
        next.draft, row.draft,
        "AI never overwrites Manual or nonempty preset prose"
    );
    assert_eq!(
        next.ai.candidates[0].state,
        WorkflowAiCandidateState::Unresolved
    );
    assert_eq!(next.ai.request_id, "air-one");
}

#[test]
fn blank_prose_is_owned_but_unknown_nonempty_prose_requires_review_even_if_equal() {
    let mut row = golden_row();
    row.draft.values.remove("description");
    let schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let policy = default_ai_policy(&schema);
    let mut result = result();
    let WorkflowDraftValue::Text(name) = row.draft.values["name"].clone() else {
        panic!("name");
    };
    result.ru = name;
    let next = settlement_plan(&schema, &row, &policy, &result, "air-one", "prompt", 2);
    assert_eq!(next.draft.values["name"], row.draft.values["name"]);
    assert_eq!(
        next.ai.candidates.len(),
        1,
        "equal text still cannot prove ownership of the previous image"
    );
    assert_eq!(
        next.ai.candidates[0].state,
        WorkflowAiCandidateState::Proposed
    );
    assert_eq!(
        next.draft.values["description"],
        WorkflowDraftValue::Text(result.description)
    );
    assert!(
        next.field_origins
            .iter()
            .any(
                |origin| content_policy::field_key(&origin.address) == "description"
                    && origin.kind == FieldValueOriginKind::AiConfirmed
            )
    );
}

#[test]
fn source_change_clears_only_proven_ai_and_manual_clear_stays_owned() {
    let mut row = golden_row();
    let schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let policy = default_ai_policy(&schema);
    record_origin(
        &mut row,
        FieldAddress::Plain {
            field_key: "name".to_owned(),
        },
        FieldValueOriginKind::AiConfirmed,
        Some("air-old".to_owned()),
        1,
    );
    record_origin(
        &mut row,
        FieldAddress::Plain {
            field_key: "offer_id".to_owned(),
        },
        FieldValueOriginKind::SellerSku,
        None,
        1,
    );
    let old = row.draft.clone();
    row.draft.values.remove("description");
    content_policy::record_manual_changes(&mut row, &old, 2);
    content_policy::invalidate_source(&mut row, true, &schema);
    assert!(!row.draft.values.contains_key("name"));
    assert!(!row.draft.values.contains_key("description"));
    assert_eq!(row.draft.values["offer_id"], old.values["offer_id"]);
    let next = settlement_plan(&schema, &row, &policy, &result(), "air-new", "prompt", 3);
    assert!(
        !next.draft.values.contains_key("description"),
        "AI cannot refill a manual clear"
    );
}

#[test]
fn explicit_complex_confirmation_normalizes_address_and_refuses_manual_or_index_splices() {
    let mut row = golden_row();
    let mut schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let mut field = schema
        .fields
        .iter()
        .find(|field| field.key == "name")
        .unwrap()
        .clone();
    field.key = "style".to_owned();
    field.complex_id = Some(7);
    schema.fields.push(field);
    let policy = default_ai_policy(&schema);
    row.draft.complex_values = vec![WorkflowComplexDraftGroup {
        complex_id: 7,
        items: vec![WorkflowComplexDraftItem {
            item_id: "ci_style".to_owned(),
            ..WorkflowComplexDraftItem::default()
        }],
    }];
    let mut result = result();
    result.ru.clear();
    result.description.clear();
    result.candidates.push(WorkflowAiCandidate {
        address: WorkflowAddress::Complex {
            group_key: "7".to_owned(),
            item_id: "ci_style".to_owned(),
            field_key: "style".to_owned(),
            value_index: None,
        },
        value: WorkflowDraftValue::Text("modern".to_owned()),
        current_value: None,
        source: "ai".to_owned(),
        state: WorkflowAiCandidateState::Proposed,
        issue: None,
    });
    let mut next = settlement_plan(&schema, &row, &policy, &result, "air-one", "prompt", 2);
    assert!(next.draft.complex_values[0].items[0].values.is_empty());
    decide_candidate(&mut next, &schema, &policy, 0, true, 3).unwrap();
    assert_eq!(
        next.draft.complex_values[0].items[0].values["style"],
        WorkflowDraftValue::Text("modern".to_owned())
    );
    let mut card = crate::compose::compose_tests::golden_card();
    card.defaults.complex_values = row.draft.complex_values.clone();
    card.defaults.complex_values[0].items[0].values.insert(
        "style".to_owned(),
        WorkflowDraftValue::Text("preset".to_owned()),
    );
    let composed = crate::build::build_listing(&next, &card).draft;
    assert_eq!(
        composed.complex_values[0].items[0].values["style"],
        WorkflowDraftValue::Text("modern".to_owned()),
        "explicitly confirmed values survive the send-time Card overlay"
    );
    let mut manual = row.clone();
    record_origin(
        &mut manual,
        FieldAddress::Complex {
            group_key: "7".into(),
            item_id: "ci_style".into(),
            field_key: "style".into(),
            value_index: None,
        },
        FieldValueOriginKind::Manual,
        None,
        1,
    );
    manual.ai = settlement_plan(&schema, &row, &policy, &result, "air-one", "prompt", 2).ai;
    assert!(decide_candidate(&mut manual, &schema, &policy, 0, true, 3).is_err());
    assert!(
        content_policy::candidate_address(&FieldAddress::Complex {
            group_key: "7".into(),
            item_id: "item_0".into(),
            field_key: "style".into(),
            value_index: None,
        })
        .is_none()
    );
    assert!(
        content_policy::candidate_address(&FieldAddress::Complex {
            group_key: "7".into(),
            item_id: "workflow-7-0".into(),
            field_key: "style".into(),
            value_index: None,
        })
        .is_none()
    );
    if let WorkflowAddress::Complex { value_index, .. } = &mut result.candidates[0].address {
        *value_index = Some(0);
    }
    let invalid = settlement_plan(&schema, &row, &policy, &result, "air-one", "prompt", 2);
    assert_eq!(
        invalid.ai.candidates[0].state,
        WorkflowAiCandidateState::Unresolved
    );
}

#[test]
fn omitted_complex_source_reviews_survive_a_narrower_recognition_policy() {
    let mut row = golden_row();
    let mut schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let mut field = schema
        .fields
        .iter()
        .find(|field| field.key == "name")
        .unwrap()
        .clone();
    field.key = "style".into();
    field.complex_id = Some(7);
    schema.fields.push(field);
    row.draft.complex_values = vec![WorkflowComplexDraftGroup {
        complex_id: 7,
        items: ["ci_0", "ci_1"]
            .into_iter()
            .map(|item_id| WorkflowComplexDraftItem {
                item_id: item_id.to_owned(),
                values: std::collections::BTreeMap::from([(
                    "style".into(),
                    WorkflowDraftValue::Text("old image style".into()),
                )]),
            })
            .collect(),
    }];
    let mut policy = default_ai_policy(&schema);
    content_policy::invalidate_source(&mut row, true, &schema);
    policy.allowed_field_keys = vec!["name".into()];
    let next = settlement_plan(&schema, &row, &policy, &result(), "air-new", "prompt", 3);
    assert!(next.ai.candidates.iter().any(|candidate| matches!(&candidate.address, WorkflowAddress::Complex { item_id, .. } if item_id == "ci_1")), "OCR omission or a policy change cannot settle an old-image field");
}

#[test]
fn editing_one_complex_item_does_not_claim_the_other_items_ai_value() {
    let mut row = golden_row();
    let mut schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let mut field = schema
        .fields
        .iter()
        .find(|field| field.key == "name")
        .unwrap()
        .clone();
    field.key = "style".into();
    field.complex_id = Some(7);
    schema.fields.push(field);
    row.draft.complex_values = vec![WorkflowComplexDraftGroup {
        complex_id: 7,
        items: ["ci_0", "ci_1"]
            .into_iter()
            .map(|item_id| WorkflowComplexDraftItem {
                item_id: item_id.to_owned(),
                values: std::collections::BTreeMap::from([(
                    "style".into(),
                    WorkflowDraftValue::Text("old AI".into()),
                )]),
            })
            .collect(),
    }];
    for item_id in ["ci_0", "ci_1"] {
        record_origin(
            &mut row,
            FieldAddress::Complex {
                group_key: "7".into(),
                item_id: item_id.into(),
                field_key: "style".into(),
                value_index: None,
            },
            FieldValueOriginKind::AiConfirmed,
            Some("air-old".into()),
            1,
        );
    }
    let previous = row.draft.clone();
    row.draft.complex_values[0].items[0]
        .values
        .insert("style".into(), WorkflowDraftValue::Text("manual".into()));
    content_policy::record_manual_changes(&mut row, &previous, 2);
    content_policy::invalidate_source(&mut row, true, &schema);
    assert_eq!(
        row.draft.complex_values[0].items[0].values["style"],
        WorkflowDraftValue::Text("manual".into())
    );
    assert!(
        !row.draft.complex_values[0].items[1]
            .values
            .contains_key("style"),
        "only the edited address became Manual"
    );
}

#[test]
fn keeping_a_blank_proposal_is_an_explicit_manual_blank() {
    let mut row = golden_row();
    row.draft.values.remove("name");
    let schema = category_schema_view(&row.schema_snapshot, Some(row.language));
    let policy = default_ai_policy(&schema);
    let mut result = result();
    result.candidates.push(WorkflowAiCandidate {
        address: WorkflowAddress::Plain {
            field_key: "name".into(),
        },
        value: WorkflowDraftValue::Text("proposal".into()),
        current_value: None,
        source: "ai".into(),
        state: WorkflowAiCandidateState::Proposed,
        issue: None,
    });
    let mut next = settlement_plan(&schema, &row, &policy, &result, "air-one", "prompt", 1);
    decide_candidate(&mut next, &schema, &policy, 0, false, 2).unwrap();
    result.candidates.clear();
    let retried = settlement_plan(&schema, &next, &policy, &result, "air-two", "prompt", 3);
    assert!(!retried.draft.values.contains_key("name"));
    assert!(is_manual(
        &retried,
        &FieldAddress::Plain {
            field_key: "name".into()
        }
    ));
}

fn complex_item(item_id: &str, style: &str) -> WorkflowComplexDraftItem {
    WorkflowComplexDraftItem {
        item_id: item_id.to_owned(),
        values: std::collections::BTreeMap::from([(
            "style".into(),
            WorkflowDraftValue::Text(style.into()),
        )]),
    }
}

fn complex_address(item_id: &str) -> FieldAddress {
    FieldAddress::Complex {
        group_key: "7".into(),
        item_id: item_id.into(),
        field_key: "style".into(),
        value_index: None,
    }
}

#[test]
fn migration_gives_each_content_item_one_stable_id_and_rereads_do_not_renumber() {
    use crate::content_policy::{ItemIdMigration, is_stable_item_id};
    use crate::records::{FieldValueOrigin, FieldValueOriginKind};
    use crate::validate::{FieldIssue, IssueSeverity};

    let mut payload = golden_row();
    payload.hand_edited_keys.insert("price".into());
    let hand_edited = payload.hand_edited_keys.clone();
    payload.draft.complex_values = vec![WorkflowComplexDraftGroup {
        complex_id: 7,
        items: vec![
            WorkflowComplexDraftItem::default(),
            complex_item("", "first"),
            complex_item("", "second"),
        ],
    }];
    payload.field_origins.push(FieldValueOrigin {
        address: complex_address("workflow-7-0"),
        kind: FieldValueOriginKind::Manual,
        source_ref: None,
        updated_at_ms: 1,
    });
    payload.field_origins.push(FieldValueOrigin {
        address: complex_address("workflow-7-1"),
        kind: FieldValueOriginKind::Manual,
        source_ref: None,
        updated_at_ms: 1,
    });
    payload.ai.candidates.push(WorkflowAiCandidate {
        address: complex_address("item_2"),
        value: WorkflowDraftValue::Text("second".into()),
        current_value: None,
        source: "ai".into(),
        state: WorkflowAiCandidateState::Proposed,
        issue: None,
    });
    payload.validation_issues.push(FieldIssue {
        field_key: "style".into(),
        code: "required".into(),
        parameters: Default::default(),
        severity: IssueSeverity::Blocking,
        address: complex_address("workflow-7-1"),
        message: "填写".into(),
        remediation: None,
    });

    assert_eq!(
        content_policy::rewrite_complex_item_ids(&mut payload, &mut incrementing_random_bytes())
            .unwrap(),
        ItemIdMigration::Rewritten
    );
    assert_eq!(payload.draft.complex_values[0].items.len(), 2);
    let first = payload.draft.complex_values[0].items[0].item_id.clone();
    let second = payload.draft.complex_values[0].items[1].item_id.clone();
    assert!(is_stable_item_id(&first) && is_stable_item_id(&second) && first != second);
    assert_eq!(payload.field_origins.len(), 1);
    assert_eq!(payload.field_origins[0].address, complex_address(&first));
    assert_eq!(payload.ai.candidates[0].address, complex_address(&second));
    assert_eq!(
        payload.validation_issues[0].address,
        complex_address(&first)
    );
    assert_eq!(payload.hand_edited_keys, hand_edited);
    assert!(
        payload.draft.complex_values[0]
            .items
            .iter()
            .all(|item| !item.item_id.is_empty())
    );

    let frozen = payload.clone();
    assert_eq!(
        content_policy::rewrite_complex_item_ids(&mut payload, &mut incrementing_random_bytes())
            .unwrap(),
        ItemIdMigration::Unchanged
    );
    assert_eq!(payload, frozen);

    payload.draft.complex_values[0].items.swap(0, 1);
    assert_eq!(
        content_policy::value_at(&payload.draft, &complex_address(&first)),
        Some(&WorkflowDraftValue::Text("first".into()))
    );
    payload.draft.complex_values[0]
        .items
        .retain(|item| item.item_id != first);
    assert_eq!(
        content_policy::value_at(&payload.draft, &complex_address(&second)),
        Some(&WorkflowDraftValue::Text("second".into()))
    );
    assert_eq!(payload.ai.candidates[0].address, complex_address(&second));
    assert_eq!(payload.field_origins[0].address, complex_address(&first));
}

#[test]
fn mixed_item_ids_are_not_treated_as_migrated() {
    let mut payload = golden_row();
    payload.draft.complex_values = vec![WorkflowComplexDraftGroup {
        complex_id: 7,
        items: vec![complex_item("ci_kept", "a"), complex_item("", "b")],
    }];
    let before = payload.clone();
    assert!(
        content_policy::rewrite_complex_item_ids(&mut payload, &mut incrementing_random_bytes())
            .is_err()
    );
    assert_eq!(payload, before);

    payload.draft.complex_values[0].items[1].item_id = "ci_other".into();
    payload
        .field_origins
        .push(crate::records::FieldValueOrigin {
            address: complex_address("workflow-7-0"),
            kind: crate::records::FieldValueOriginKind::AiConfirmed,
            source_ref: None,
            updated_at_ms: 1,
        });
    let before = payload.clone();
    assert!(
        content_policy::rewrite_complex_item_ids(&mut payload, &mut incrementing_random_bytes())
            .is_err()
    );
    assert_eq!(payload, before);
}

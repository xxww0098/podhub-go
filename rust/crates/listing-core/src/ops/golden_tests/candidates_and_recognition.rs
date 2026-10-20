//! `decide_candidates` and `settle_recognition` golden cases.

use serde_json::json;

use crate::FieldAddress;
use crate::ops::{
    CandidateDecision, Ctx, RecognitionAnswer, decide_candidates, settle_recognition,
};
use crate::workflow_dto::types::{
    WorkflowAiCandidate, WorkflowAiCandidateState, WorkflowCategoryDraft, WorkflowDraftValue,
};

use super::edit_row::seeded_row;
use super::{assert_golden, golden_card, golden_schema_material, sequential_ids};

#[test]
fn decide_candidates_applies_an_accept_and_a_reject_in_order() {
    let mut row = seeded_row();
    row.ai.candidates = vec![
        WorkflowAiCandidate {
            address: FieldAddress::Plain {
                field_key: "name".to_owned(),
            },
            value: WorkflowDraftValue::Text("Decorative Wall Art".to_owned()),
            current_value: None,
            source: "ai".to_owned(),
            state: WorkflowAiCandidateState::Proposed,
            issue: None,
        },
        WorkflowAiCandidate {
            address: FieldAddress::Plain {
                field_key: "price".to_owned(),
            },
            value: WorkflowDraftValue::Text("99.90".to_owned()),
            current_value: None,
            source: "ai".to_owned(),
            state: WorkflowAiCandidateState::Proposed,
            issue: None,
        },
    ];
    let card = golden_card(WorkflowCategoryDraft::default());
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_400,
        ids: &mut ids,
    };
    let decisions = vec![
        CandidateDecision {
            index: 0,
            accept: true,
        },
        CandidateDecision {
            index: 1,
            accept: false,
        },
    ];
    let input_row = row.clone();
    let edited = decide_candidates(&ctx, row, &decisions).expect("decisions apply");
    assert_eq!(
        edited.row.draft.values.get("name"),
        Some(&WorkflowDraftValue::Text("Decorative Wall Art".to_owned()))
    );
    assert_golden(
        "decide_candidates",
        "accept-name-reject-price",
        &json!({"row": &input_row}),
        &json!({
            "row": &edited.row,
            "fact": format!("{:?}", edited.verdict.fact),
        }),
    );
}

#[test]
fn settle_recognition_fills_blanks_and_keeps_the_callers_tag_order() {
    let row = seeded_row();
    let card = golden_card(WorkflowCategoryDraft::default());
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_500,
        ids: &mut ids,
    };
    // `tags` arrives already merged — Cloud's `purchased_result` prepends the
    // prompt's fixed tags before this op ever runs (see this op's module
    // docs); this fixture states the merged order directly to prove
    // `settle_recognition` passes it through untouched.
    let answer = RecognitionAnswer {
        ru: "Декоративная настенная роспись".to_owned(),
        description: "Настенное панно ручной работы.".to_owned(),
        tags: vec![
            "#классика".to_owned(),
            "#гостиная".to_owned(),
            "#коридор".to_owned(),
        ],
        candidates: vec![WorkflowAiCandidate {
            address: FieldAddress::Plain {
                field_key: "price".to_owned(),
            },
            value: WorkflowDraftValue::Text("149.90".to_owned()),
            current_value: None,
            source: "ai".to_owned(),
            state: WorkflowAiCandidateState::Proposed,
            issue: None,
        }],
        model: "qwen-vl".to_owned(),
        cost_microfen: 1_200,
        request_id: "req-golden-1".to_owned(),
        prompt_sha256: "sha256:prompt-golden".to_owned(),
    };
    let input = json!({
        "row": &row,
        "ru": &answer.ru,
        "description": &answer.description,
        "tags": &answer.tags,
        "model": &answer.model,
        "costMicrofen": answer.cost_microfen,
        "requestId": &answer.request_id,
    });
    let expected_tags = answer.tags.clone();
    let edited = settle_recognition(&ctx, row, answer).expect("recognition settles with a card");
    assert_eq!(
        edited
            .row
            .ai
            .summary
            .as_ref()
            .map(|summary| summary.tags.clone()),
        Some(expected_tags),
        "settle_recognition must not reorder the caller's tags"
    );
    assert_golden(
        "settle_recognition",
        "fills-blanks-and-keeps-tag-order",
        &input,
        &json!({
            "row": &edited.row,
            "fact": format!("{:?}", edited.verdict.fact),
        }),
    );
}

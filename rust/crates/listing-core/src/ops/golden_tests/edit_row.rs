//! `edit_row` golden cases: clearing generated content (空值与清空), a
//! dictionary value only present in the search materials (截断字典), and a
//! store move folded into a manual field edit.

use serde_json::json;

use crate::FieldAddress;
use crate::envelope::RowSource;
use crate::ops::{Ctx, DraftEdit, LeanRow, RowEdit, edit_row, seed_row};
use crate::workflow_dto::types::{
    WorkflowAiCandidate, WorkflowAiCandidateState, WorkflowCategoryDraft, WorkflowDraftValue,
};

use super::{assert_golden, golden_card, golden_schema_material, sequential_ids};

pub(super) fn seeded_row() -> LeanRow {
    let mut defaults = WorkflowCategoryDraft::default();
    defaults.values.insert(
        "offer_id".to_owned(),
        WorkflowDraftValue::Text("ART-001".to_owned()),
    );
    let card = golden_card(defaults);
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_000,
        ids: &mut ids,
    };
    let source = RowSource {
        asset_id: "asset-seed".to_owned(),
        sha256: "sha256:seed-source".to_owned(),
        file_name: "seed.psd".to_owned(),
    };
    seed_row(&ctx, source, None)
}

#[test]
fn edit_row_clears_generated_content_but_keeps_identity_fields() {
    let mut row = seeded_row();
    row.draft.values.insert(
        "price".to_owned(),
        WorkflowDraftValue::Text("120".to_owned()),
    );
    row.ai.candidates.push(WorkflowAiCandidate {
        address: FieldAddress::Plain {
            field_key: "price".to_owned(),
        },
        value: WorkflowDraftValue::Text("120".to_owned()),
        current_value: None,
        source: "ai".to_owned(),
        state: WorkflowAiCandidateState::Proposed,
        issue: None,
    });
    row.media.images.push(crate::WorkflowImageLifecycle {
        account_id: None,
        index: 0,
        file_name: "slice-0.jpg".to_owned(),
        content_hash: "sha256:img0".to_owned(),
        group_name: "hero".to_owned(),
        width: 900,
        height: 1200,
        byte_size: Some(1024),
        phase: crate::WorkflowImagePhase::PublicReady,
        public_url: Some("https://media.example.invalid/img0.jpg".to_owned()),
        object_key: None,
        error_code: None,
    });

    let card = golden_card(WorkflowCategoryDraft::default());
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let mut ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_100,
        ids: &mut ids,
    };
    let input_row = row.clone();
    let outcome = edit_row(&mut ctx, row, RowEdit::ClearGeneratedContent).expect("clear succeeds");
    assert!(outcome.edited.row.media.images.is_empty());
    assert!(outcome.edited.row.ai.candidates.is_empty());
    assert_eq!(outcome.invalidation.content_state, Some("draft"));
    assert_eq!(outcome.invalidation.media_state, Some("pending"));
    assert_golden(
        "edit_row",
        "clear-generated-content-keeps-identity",
        &input_row,
        &json!({
            "row": &outcome.edited.row,
            "fact": format!("{:?}", outcome.edited.verdict.fact),
            "invalidation": {
                "contentState": outcome.invalidation.content_state,
                "mediaState": outcome.invalidation.media_state,
                "submissionState": outcome.invalidation.submission_state,
            },
            "stored": &outcome.stored,
        }),
    );
}

#[test]
fn edit_row_accepts_a_dictionary_value_only_present_in_the_search_materials() {
    let row = seeded_row();
    let card = golden_card(WorkflowCategoryDraft::default());
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let mut ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_200,
        ids: &mut ids,
    };
    let mut draft = row.draft.clone();
    draft.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("Decorative Wall Art".to_owned()),
    );
    draft.values.insert(
        "price".to_owned(),
        WorkflowDraftValue::Text("99.90".to_owned()),
    );
    draft.values.insert(
        "tags".to_owned(),
        WorkflowDraftValue::MultiSelect(vec![crate::WorkflowDraftSelection {
            dictionary_value_id: 2,
            value: "限量".to_owned(),
        }]),
    );
    let edit = DraftEdit {
        changes: json!({}),
        draft: draft.clone(),
        light: false,
        store_moved: false,
    };
    let outcome =
        edit_row(&mut ctx, row.clone(), RowEdit::Draft(edit)).expect("draft edit succeeds");
    assert_eq!(
        outcome.edited.row.draft.values.get("tags"),
        Some(&WorkflowDraftValue::MultiSelect(vec![
            crate::WorkflowDraftSelection {
                dictionary_value_id: 2,
                value: "限量".to_owned(),
            }
        ]))
    );
    assert_golden(
        "edit_row",
        "truncated-dictionary-search-material",
        &json!({"row": &row, "draft": &draft}),
        &json!({
            "row": &outcome.edited.row,
            "fact": format!("{:?}", outcome.edited.verdict.fact),
            "issues": &outcome.edited.verdict.issues,
        }),
    );
}

#[test]
fn edit_row_folds_a_store_move_into_the_same_manual_field_edit() {
    let row = seeded_row();
    let card = golden_card(WorkflowCategoryDraft::default());
    let schema = golden_schema_material();
    let mut ids = sequential_ids();
    let mut ctx = Ctx {
        schema: &schema,
        card: Some(&card),
        now_ms: 1_700_000_000_300,
        ids: &mut ids,
    };
    let mut draft = row.draft.clone();
    draft.values.insert(
        "name".to_owned(),
        WorkflowDraftValue::Text("Decorative Wall Art".to_owned()),
    );
    let edit = DraftEdit {
        changes: json!({}),
        draft: draft.clone(),
        light: false,
        store_moved: true,
    };
    let outcome =
        edit_row(&mut ctx, row.clone(), RowEdit::Draft(edit)).expect("draft edit succeeds");
    assert!(
        outcome
            .invalidation
            .submission_state
            .is_some_and(|state| state == "none")
    );
    assert_golden(
        "edit_row",
        "store-move-with-manual-field",
        &json!({"row": &row, "draft": &draft, "storeMoved": true}),
        &json!({
            "invalidation": {
                "contentState": outcome.invalidation.content_state,
                "mediaState": outcome.invalidation.media_state,
                "submissionState": outcome.invalidation.submission_state,
            },
            "fact": format!("{:?}", outcome.edited.verdict.fact),
        }),
    );
}

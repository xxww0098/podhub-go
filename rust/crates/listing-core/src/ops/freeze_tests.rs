use super::*;
use crate::compose::compose_frozen_import;
use crate::compose::compose_tests::{
    PINNED_REQUEST_DIGEST, golden_card, golden_import, golden_row,
};
use crate::validate::DictionaryMaterials;
use crate::{WorkflowAiCandidate, WorkflowDraftValue};

const ROW_ID: &str = "draft-ozon-golden";

fn golden() -> (SchemaMaterial, CardPayload, LeanRow) {
    let (row, snapshot) = LeanRow::from_row(golden_row());
    (
        SchemaMaterial::new(snapshot, DictionaryMaterials::default()),
        golden_card(),
        row,
    )
}

fn refused(outcome: FreezeOutcome) -> (FreezeRefusal, Vec<FieldIssue>, Option<BuildEvidence>) {
    match outcome {
        FreezeOutcome::Refused {
            reason,
            issues,
            evidence,
        } => (reason, issues, evidence),
        FreezeOutcome::Frozen { .. } => panic!("expected a refusal"),
    }
}

/// The browser op freezes the exact bytes and identities the Cloud compose
/// path pins against the shared wire golden.
#[test]
fn golden_row_freezes_to_the_wire_golden_and_matches_cloud_compose() {
    let (schema, card, row) = golden();
    let FreezeOutcome::Frozen { frozen, evidence } = freeze_listing(&schema, &card, row, ROW_ID)
    else {
        panic!("golden row must freeze");
    };
    assert_eq!(frozen.import, golden_import());
    assert_eq!(frozen.digest, PINNED_REQUEST_DIGEST);
    assert_eq!(frozen.offer_id, "ART-001");
    assert_eq!(
        frozen.client_operation_id,
        format!("workflow:{ROW_ID}:ART-001:{PINNED_REQUEST_DIGEST}")
    );
    assert_eq!(
        frozen,
        compose_frozen_import(ROW_ID, &golden_row(), &card).expect("cloud compose")
    );
    assert_eq!(
        evidence,
        build_listing(&golden_row(), &card).evidence(&card),
        "provenance is the same BuildEvidence the server build produces"
    );
}

#[test]
fn a_stale_schema_revision_is_refused_before_build() {
    let (schema, card, mut row) = golden();
    row.schema_revision = "older-revision".to_owned();
    let (reason, issues, evidence) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(reason, FreezeRefusal::SchemaStale);
    assert_eq!(issues[0].code, "schema_stale");
    assert!(issues[0].remediation.is_some());
    assert!(evidence.is_none());
}

#[test]
fn a_row_from_another_category_is_refused() {
    let (schema, card, mut row) = golden();
    row.type_id += 1;
    let (reason, issues, _) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(reason, FreezeRefusal::CoordinateMismatch);
    assert_eq!(issues[0].code, "coordinate_mismatch");

    let (schema, mut card, row) = golden();
    card.type_id += 1;
    let mut row = row;
    row.type_id = card.type_id;
    let (reason, _, _) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(
        reason,
        FreezeRefusal::CoordinateMismatch,
        "row and card agreeing is not enough: the resident schema must match too"
    );

    let (schema, mut card, mut row) = golden();
    card.category_key = "workflow:other".to_owned();
    row.category_key = card.category_key.clone();
    let (reason, _, _) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(
        reason,
        FreezeRefusal::CoordinateMismatch,
        "the snapshot's category key must agree too"
    );
}

#[test]
fn row_and_card_languages_must_match_exactly() {
    let (schema, card, mut row) = golden();
    assert_eq!(card.language, crate::WorkflowLanguage::Default);
    row.language = crate::WorkflowLanguage::Ru;
    let (reason, issues, _) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(reason, FreezeRefusal::CoordinateMismatch);
    assert_eq!(
        issues[0].code, "language_mismatch",
        "default and ru are distinct coordinates"
    );
}

#[test]
fn a_blank_or_untrimmed_row_id_never_mints_a_client_operation_id() {
    for row_id in ["", "  ", " draft-ozon-golden"] {
        let (schema, card, row) = golden();
        let (reason, issues, evidence) = refused(freeze_listing(&schema, &card, row, row_id));
        assert_eq!(reason, FreezeRefusal::RowIdInvalid);
        assert_eq!(issues[0].field_key, "row_id");
        assert!(evidence.is_none());
    }
}

#[test]
fn unconfirmed_ai_candidates_are_never_publishable() {
    let (schema, card, mut row) = golden();
    let address = FieldAddress::Plain {
        field_key: "name".to_owned(),
    };
    for state in [
        WorkflowAiCandidateState::Proposed,
        WorkflowAiCandidateState::Unresolved,
        WorkflowAiCandidateState::Rejected,
    ] {
        row.ai.candidates.push(WorkflowAiCandidate {
            address: address.clone(),
            value: WorkflowDraftValue::Text("AI name".to_owned()),
            current_value: None,
            source: "ocr".to_owned(),
            state,
            issue: None,
        });
    }
    let (reason, issues, _) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(reason, FreezeRefusal::CandidatesUnresolved);
    assert_eq!(issues.len(), 2, "rejected candidates are settled");
    assert!(
        issues
            .iter()
            .all(|issue| issue.address == address && issue.code == "ai_candidate_unresolved")
    );
}

#[test]
fn a_validation_refusal_keeps_actionable_field_issues_and_provenance() {
    let (schema, card, mut row) = golden();
    row.draft.values.remove("name");
    let (reason, issues, evidence) = refused(freeze_listing(&schema, &card, row, ROW_ID));
    assert_eq!(reason, FreezeRefusal::ValidationFailed);
    assert!(
        issues
            .iter()
            .any(|issue| issue.field_key == "name" && issue.code == "required"),
        "{issues:?}"
    );
    assert!(
        evidence.is_some(),
        "build ran, so its provenance is reported"
    );
}

/// The refusal reason is the stage evidence for its issues: freeze's own
/// refusals carry declared freeze keys, and `validation_failed` forwards
/// validate keys unchanged rather than relabelling them as freeze.
#[test]
fn every_refusal_issue_classifies_under_the_stage_its_reason_names() {
    use crate::issue_keys::IssueStage;

    let mut refusals = Vec::new();
    let (schema, card, mut row) = golden();
    row.schema_revision = "older-revision".to_owned();
    refusals.push(refused(freeze_listing(&schema, &card, row, ROW_ID)));
    let (schema, card, mut row) = golden();
    row.type_id += 1;
    refusals.push(refused(freeze_listing(&schema, &card, row, ROW_ID)));
    let (schema, card, mut row) = golden();
    row.language = crate::WorkflowLanguage::Ru;
    refusals.push(refused(freeze_listing(&schema, &card, row, ROW_ID)));
    let (schema, card, row) = golden();
    refusals.push(refused(freeze_listing(&schema, &card, row, " ")));
    let (schema, card, mut row) = golden();
    row.ai.candidates.push(WorkflowAiCandidate {
        address: FieldAddress::Plain {
            field_key: "name".to_owned(),
        },
        value: WorkflowDraftValue::Text("AI name".to_owned()),
        current_value: None,
        source: "ocr".to_owned(),
        state: WorkflowAiCandidateState::Proposed,
        issue: None,
    });
    refusals.push(refused(freeze_listing(&schema, &card, row, ROW_ID)));
    let (schema, card, mut row) = golden();
    row.draft.values.remove("name");
    refusals.push(refused(freeze_listing(&schema, &card, row, ROW_ID)));

    let mut stages = Vec::new();
    for (reason, issues, _) in refusals {
        let stage = reason.issue_stage();
        stages.push(stage);
        assert!(!issues.is_empty(), "{reason:?}");
        for issue in &issues {
            let key = issue
                .known_key(stage)
                .unwrap_or_else(|| panic!("{reason:?}: {} undeclared for {stage:?}", issue.code));
            assert_eq!(key.stage(), stage);
        }
    }
    assert_eq!(
        stages,
        [
            IssueStage::Freeze,
            IssueStage::Freeze,
            IssueStage::Freeze,
            IssueStage::Freeze,
            IssueStage::Freeze,
            IssueStage::Validate,
        ]
    );
}

fn refusal_names() -> Vec<&'static str> {
    FreezeRefusal::ALL
        .iter()
        .map(|reason| reason.as_str())
        .collect()
}

/// The closed refusal set: one ordered list, one literal per reason, and the
/// serde name is the `as_str` literal WASM op 11 has always answered as
/// `reason`. Adding, renaming or reordering a reason must change this test
/// on purpose.
#[test]
fn refusal_wire_names_are_the_closed_declared_set() {
    assert_eq!(
        refusal_names(),
        [
            "row_id_invalid",
            "schema_stale",
            "coordinate_mismatch",
            "candidates_unresolved",
            "validation_failed",
            "freeze_failed",
        ]
    );
    for (position, reason) in FreezeRefusal::ALL.iter().enumerate() {
        // Exhaustive on purpose: a new variant does not compile here until it
        // is given its place in `ALL` and in the list above.
        let declared = match reason {
            FreezeRefusal::RowIdInvalid => 0,
            FreezeRefusal::SchemaStale => 1,
            FreezeRefusal::CoordinateMismatch => 2,
            FreezeRefusal::CandidatesUnresolved => 3,
            FreezeRefusal::ValidationFailed => 4,
            FreezeRefusal::FreezeFailed => 5,
        };
        assert_eq!(declared, position, "{reason:?}");
        let json = serde_json::to_string(reason).expect("serialize");
        assert_eq!(json, format!("\"{}\"", reason.as_str()));
        let back: FreezeRefusal = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, *reason);
    }
}

/// Strict decode: nothing outside the six reasons becomes a known reason —
/// not a freeze issue code that rides *under* a reason, not Cloud's Draft
/// skip reason, not another casing or padding.
#[test]
fn an_unknown_refusal_never_decodes_to_a_known_one() {
    for rejected in [
        serde_json::json!("language_mismatch"),
        serde_json::json!("ai_candidate_unresolved"),
        serde_json::json!("blocked"),
        serde_json::json!("compose_failed"),
        serde_json::json!("ROW_ID_INVALID"),
        serde_json::json!("rowIdInvalid"),
        serde_json::json!(" schema_stale"),
        serde_json::json!("unknown"),
        serde_json::json!(""),
        serde_json::json!(null),
        serde_json::json!(4),
    ] {
        assert!(
            serde_json::from_value::<FreezeRefusal>(rejected.clone()).is_err(),
            "{rejected}"
        );
    }

    // Six refusals and six freeze issue codes are two different sets that
    // share four spellings; neither is an alias of the other.
    use std::collections::BTreeSet;
    let refusals: BTreeSet<&str> = refusal_names().into_iter().collect();
    let codes: BTreeSet<&str> = crate::issue_keys::OzonFreezeCode::ALL
        .iter()
        .map(|code| code.as_str())
        .collect();
    assert_eq!(
        refusals.difference(&codes).copied().collect::<Vec<_>>(),
        ["candidates_unresolved", "validation_failed"]
    );
    assert_eq!(
        codes.difference(&refusals).copied().collect::<Vec<_>>(),
        ["ai_candidate_unresolved", "language_mismatch"]
    );
}

/// The OpenAPI component Cloud registers is derived from the same enum: a
/// string enum named `FreezeRefusal` listing exactly `ALL`, in order.
#[cfg(feature = "openapi")]
#[test]
fn openapi_component_enumerates_exactly_the_refusals() {
    use utoipa::{PartialSchema, ToSchema};

    assert_eq!(<FreezeRefusal as ToSchema>::name(), "FreezeRefusal");
    let schema = serde_json::to_value(<FreezeRefusal as PartialSchema>::schema())
        .expect("schema serializes");
    assert_eq!(schema["type"], "string", "{schema}");
    assert_eq!(
        schema["enum"],
        serde_json::json!(refusal_names()),
        "{schema}"
    );
}

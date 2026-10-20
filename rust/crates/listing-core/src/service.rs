//! The two pure row operations the HTTP layer calls.
//!
//! No DB, no clock, no transport: the caller writes the returned payload back
//! under the revision CAS and stores the returned [`ValidationFact`] in
//! `listing_rows.validation_state`.

use op_workflow::ValidationFact;

use super::bridge::listing_record_for_validation;
use super::build::{BuildEvidence, build_listing};
use super::compose::validate_built;
use super::envelope::{CardPayload, RowPayload};
use super::error::ListingError;
use super::plan::{PlanError, build_execution_plan};
use super::records::{ExecutionPlan, ListingLifecycleState};
use super::validate::DictionaryMaterials;

impl From<PlanError> for ListingError {
    fn from(error: PlanError) -> Self {
        match error {
            PlanError::NotValidated => Self::NotValidated,
            PlanError::MissingNormalizedSnapshot => Self::MissingNormalizedSnapshot,
        }
    }
}

/// Normalize and validate the row's Draft. Execution Plans are built on demand.
///
/// Returns the payload to persist — `normalizedSnapshot` and
/// `validationIssues` replaced — and the `validation_state` it earns. A
/// rejected Draft is not an error: it is a `Blocked` row with its issues
/// attached, which is exactly what the operator needs to see.
pub fn validate_row(
    payload: &RowPayload,
    card: Option<&CardPayload>,
) -> (RowPayload, ValidationFact, Option<BuildEvidence>) {
    validate_row_with(payload, card, &DictionaryMaterials::default())
}

pub fn validate_row_with(
    payload: &RowPayload,
    card: Option<&CardPayload>,
    materials: &DictionaryMaterials,
) -> (RowPayload, ValidationFact, Option<BuildEvidence>) {
    let mut next = payload.clone();
    let (draft, evidence) = match card {
        Some(card) => {
            let built = build_listing(payload, card);
            let evidence = built.evidence(card);
            (built.draft, Some(evidence))
        }
        None => (payload.draft.clone(), None),
    };
    match validate_built(payload, &draft, materials) {
        Err(issues) => {
            next.normalized_snapshot = None;
            next.validation_issues = issues;
            (next, ValidationFact::Blocked, evidence)
        }
        Ok(validated) => {
            next.normalized_snapshot = Some(validated.snapshot);
            next.validation_issues = Vec::new();
            (next, ValidationFact::Passed, evidence)
        }
    }
}

/// Recompute the Execution Plan for a row that already validated. The plan is
/// derived, never stored, so every read rebuilds it from the snapshot.
pub fn execution_plan(payload: &RowPayload) -> Result<ExecutionPlan, ListingError> {
    let snapshot = payload
        .normalized_snapshot
        .clone()
        .ok_or(ListingError::MissingNormalizedSnapshot)?;
    let mut record = listing_record_for_validation(payload.schema_snapshot.clone(), &payload.draft);
    record.lifecycle_state = ListingLifecycleState::Validated;
    record.normalized_snapshot = Some(snapshot);
    Ok(build_execution_plan(&record)?)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{WorkflowCategoryDraft, WorkflowDraftValue, WorkflowLanguage};

    use super::*;
    use crate::categories::decorative_wall_art;
    use crate::envelope::{RowAi, RowMedia, RowSource};

    fn row(values: BTreeMap<String, WorkflowDraftValue>) -> RowPayload {
        let schema = decorative_wall_art::local_schema_snapshot();
        RowPayload {
            category_key: schema.category_key.clone(),
            description_category_id: schema.description_category_id,
            type_id: schema.type_id,
            supplier_product_id: None,
            language: WorkflowLanguage::Default,
            schema_revision: schema.schema_revision.clone(),
            schema_snapshot: std::sync::Arc::new(schema),
            draft: WorkflowCategoryDraft {
                values,
                complex_values: Vec::new(),
                ..Default::default()
            },
            hand_edited_keys: Default::default(),
            field_origins: Vec::new(),
            normalized_snapshot: None,
            validation_issues: Vec::new(),
            source: RowSource::default(),
            render_evidence: None,
            media: RowMedia::default(),
            ai: RowAi::default(),
            failure_log: Vec::new(),
        }
    }

    fn golden_values() -> BTreeMap<String, WorkflowDraftValue> {
        crate::compose::compose_tests::golden_draft_values()
    }

    #[test]
    fn a_complete_draft_validates_and_stores_its_snapshot() {
        let (next, state, evidence) = validate_row(&row(golden_values()), None);

        assert!(evidence.is_none());
        assert_eq!(state, ValidationFact::Passed);
        assert!(next.validation_issues.is_empty());
        let snapshot = next
            .normalized_snapshot
            .as_ref()
            .expect("a passed row stores its normalized snapshot");
        assert_eq!(snapshot.offer_id, "ART-001");
        assert!(
            !execution_plan(&next)
                .expect("plan")
                .ozon_operations
                .is_empty()
        );
    }

    #[test]
    fn an_incomplete_draft_is_blocked_with_its_issues_and_no_snapshot() {
        let mut values = golden_values();
        values.remove("offer_id");
        let mut previous = row(values.clone());
        previous.normalized_snapshot = validate_row(&row(golden_values()), None)
            .0
            .normalized_snapshot;

        let (next, state, evidence) = validate_row(&previous, None);

        assert!(evidence.is_none());
        assert_eq!(state, ValidationFact::Blocked);
        assert!(
            next.normalized_snapshot.is_none(),
            "a blocked row must not keep a snapshot the send path would trust"
        );
        assert!(
            next.validation_issues
                .iter()
                .any(|issue| issue.field_key == "offer_id" && issue.code == "required")
        );
    }

    #[test]
    fn a_plan_cannot_be_built_without_a_snapshot() {
        assert!(matches!(
            execution_plan(&row(golden_values())),
            Err(ListingError::MissingNormalizedSnapshot)
        ));
    }
}

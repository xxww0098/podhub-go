//! Golden rejection fixtures (`fixtures/listing/validation/rejection-*.json`)
//! replayed through `normalize_and_validate`. Test-only.

use std::collections::BTreeMap;
use std::path::Path;

use serde::Deserialize;

use super::{ValidationOutcome, normalize_and_validate};
use crate::records::{ListingDraftRecord, ListingLifecycleState};

/// Load golden rejection fixtures and assert `normalize_and_validate` matches.
pub fn assert_golden_rejection_cases(fixtures_root: &Path) -> Result<(), String> {
    let directory = fixtures_root.join("validation");
    let entries = std::fs::read_dir(&directory)
        .map_err(|error| format!("read {}: {error}", directory.display()))?;
    let mut saw_case = false;
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or_default();
        if !name.starts_with("rejection-") || !name.ends_with(".json") {
            continue;
        }
        saw_case = true;
        let raw = std::fs::read_to_string(&path)
            .map_err(|error| format!("read {}: {error}", path.display()))?;
        let case: GoldenRejectionCase =
            serde_json::from_str(&raw).map_err(|error| format!("{}: {error}", path.display()))?;
        let draft = case.to_draft();
        match normalize_and_validate(&draft) {
            ValidationOutcome::Accepted { .. } => {
                return Err(format!(
                    "{} expected rejection but validation accepted",
                    path.display()
                ));
            }
            ValidationOutcome::Rejected { issues } => {
                let actual: Vec<_> = issues
                    .iter()
                    .map(|issue| (issue.field_key.as_str(), issue.code.as_str()))
                    .collect();
                let expected: Vec<_> = case
                    .expected_issues
                    .iter()
                    .map(|issue| (issue.field_key.as_str(), issue.code.as_str()))
                    .collect();
                if actual != expected {
                    return Err(format!(
                        "{} issue mismatch\nexpected: {expected:?}\nactual:   {actual:?}",
                        path.display()
                    ));
                }
            }
        }
    }
    if !saw_case {
        return Err(format!(
            "no rejection-*.json goldens under {}",
            directory.display()
        ));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct GoldenRejectionCase {
    category_key: String,
    description_category_id: i64,
    type_id: i64,
    field_values: BTreeMap<String, String>,
    expected_issues: Vec<GoldenIssue>,
}

#[derive(Debug, Deserialize)]
struct GoldenIssue {
    field_key: String,
    code: String,
}

impl GoldenRejectionCase {
    fn to_draft(&self) -> ListingDraftRecord {
        let schema = crate::categories::decorative_wall_art::local_schema_snapshot();
        ListingDraftRecord {
            draft_id: "golden-draft".to_owned(),
            draft_revision: 1,
            category_key: self.category_key.clone(),
            description_category_id: self.description_category_id,
            type_id: self.type_id,
            schema_revision: schema.schema_revision.clone(),
            recipe_id: schema.recipe_id,
            recipe_revision: schema.recipe_revision,
            catalog_schema_version: schema.catalog_schema_version,
            schema_snapshot: std::sync::Arc::new(schema),
            field_values: self.field_values.clone(),
            raw_values: Default::default(),
            list_elements: Default::default(),
            complex_values: Default::default(),
            field_origins: Default::default(),
            lifecycle_state: ListingLifecycleState::Draft,
            normalized_snapshot: None,
            execution_plan: None,
            updated_at_ms: 0,
            envelope_version: crate::records::CURRENT_ENVELOPE_VERSION,
            unusable: false,
            preview_required: false,
            decode_failures: Vec::new(),
        }
    }
}

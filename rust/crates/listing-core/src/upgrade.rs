use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use super::records::{CategorySchemaSnapshot, RawDraftValue};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DriftStatus {
    Compatible,
    UpgradeAvailable,
    Blocked,
    SourceUnavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftUpgradePreview {
    pub draft_id: String,
    pub expected_draft_revision: u64,
    pub from_schema_revision: String,
    pub to_schema_revision: String,
    pub status: DriftStatus,
    pub mapped_values: BTreeMap<String, RawDraftValue>,
    pub orphaned_values: BTreeMap<String, RawDraftValue>,
}

pub fn preview_upgrade(
    draft_id: &str,
    draft_revision: u64,
    current: &CategorySchemaSnapshot,
    candidate: Option<&CategorySchemaSnapshot>,
    values: &BTreeMap<String, RawDraftValue>,
) -> DraftUpgradePreview {
    let Some(candidate) = candidate else {
        return DraftUpgradePreview {
            draft_id: draft_id.to_owned(),
            expected_draft_revision: draft_revision,
            from_schema_revision: current.schema_revision.clone(),
            to_schema_revision: current.schema_revision.clone(),
            status: DriftStatus::SourceUnavailable,
            mapped_values: BTreeMap::new(),
            orphaned_values: values.clone(),
        };
    };
    let candidate_keys = candidate
        .fields
        .iter()
        .map(|field| field.key.as_str())
        .collect::<std::collections::BTreeSet<_>>();
    let (mapped_values, orphaned_values) = values
        .iter()
        .map(|(key, value)| (key.clone(), value.clone()))
        .partition(|(key, _)| candidate_keys.contains(key.as_str()));
    let status = if candidate.description_category_id != current.description_category_id
        || candidate.type_id != current.type_id
    {
        DriftStatus::Blocked
    } else if candidate.schema_revision == current.schema_revision {
        DriftStatus::Compatible
    } else {
        DriftStatus::UpgradeAvailable
    };
    DraftUpgradePreview {
        draft_id: draft_id.to_owned(),
        expected_draft_revision: draft_revision,
        from_schema_revision: current.schema_revision.clone(),
        to_schema_revision: candidate.schema_revision.clone(),
        status,
        mapped_values,
        orphaned_values,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::categories::decorative_wall_art;

    #[test]
    fn upgrade_preview_is_pure_and_preserves_orphans() {
        let current = decorative_wall_art::local_schema_snapshot();
        let mut candidate = current.clone();
        candidate.schema_revision = "sha256:new".to_owned();
        candidate.fields.retain(|field| field.key != "brand");
        let values = BTreeMap::from([
            ("name".to_owned(), RawDraftValue::Text("art".to_owned())),
            ("brand".to_owned(), RawDraftValue::Text("legacy".to_owned())),
        ]);
        let preview = preview_upgrade("draft", 7, &current, Some(&candidate), &values);
        assert_eq!(preview.status, DriftStatus::UpgradeAvailable);
        assert!(preview.mapped_values.contains_key("name"));
        assert!(preview.orphaned_values.contains_key("brand"));
        assert_eq!(values["brand"], RawDraftValue::Text("legacy".to_owned()));
    }

    #[test]
    fn source_failure_is_distinct_from_semantic_block() {
        let current = decorative_wall_art::local_schema_snapshot();
        let unavailable = preview_upgrade("draft", 1, &current, None, &BTreeMap::new());
        let mut incompatible = current.clone();
        incompatible.type_id += 1;
        let blocked = preview_upgrade("draft", 1, &current, Some(&incompatible), &BTreeMap::new());
        assert_eq!(unavailable.status, DriftStatus::SourceUnavailable);
        assert_eq!(blocked.status, DriftStatus::Blocked);
    }

    // Cloud SSOT: adoption CAS is covered by Cloud listing_kernel patch tests.
}

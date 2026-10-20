//! Cloud Listing identities.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Listing-owned identity attached after Cloud creates the canonical Draft.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DraftRef {
    pub draft_id: String,
    pub draft_revision: u64,
    pub schema_revision: String,
}

impl DraftRef {
    /// A Cloud boundary accepts only the UUID minted by Cloud.
    #[must_use]
    pub fn cloud_draft_id(&self) -> Option<&str> {
        cloud_draft_id(&self.draft_id)
    }
}

/// Return a validated Cloud Listing identity.
#[must_use]
fn cloud_draft_id(value: &str) -> Option<&str> {
    let value = value.trim();
    Uuid::parse_str(value).ok().map(|_| value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cloud_draft_id_accepts_only_a_uuid() {
        assert!(cloud_draft_id("").is_none());
        assert!(cloud_draft_id("workflow_instance_product").is_none());
        assert!(cloud_draft_id("not-a-uuid").is_none());

        let id = "e1ab4380-29d5-47f0-81e4-eae7ffc2f7ce";
        assert_eq!(cloud_draft_id(id), Some(id));
    }

    #[test]
    fn draft_ref_exposes_only_a_cloud_uuid() {
        let local = DraftRef {
            draft_id: "workflow_instance_product".to_owned(),
            draft_revision: 1,
            schema_revision: "schema".to_owned(),
        };
        assert!(local.cloud_draft_id().is_none());

        let cloud = DraftRef {
            draft_id: "e1ab4380-29d5-47f0-81e4-eae7ffc2f7ce".to_owned(),
            ..local
        };
        assert_eq!(
            cloud.cloud_draft_id(),
            Some("e1ab4380-29d5-47f0-81e4-eae7ffc2f7ce")
        );
    }
}

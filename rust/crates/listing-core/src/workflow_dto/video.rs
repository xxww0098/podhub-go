//! Product video/cover metadata Cloud persists on cards and drafts.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowVideoRole {
    Product,
    Cover,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowVideoOrigin {
    ManagedUpload,
    PublicUrl,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkflowVideoMetadata {
    pub role: WorkflowVideoRole,
    #[serde(default = "default_video_origin")]
    pub origin: WorkflowVideoOrigin,
    pub file_name: String,
    pub content_type: String,
    pub size_bytes: u64,
    pub duration_ms: u64,
    pub public_url: Option<String>,
    #[serde(default)]
    pub object_key: Option<String>,
    #[serde(default)]
    pub content_hash: Option<String>,
}

fn default_video_origin() -> WorkflowVideoOrigin {
    WorkflowVideoOrigin::ManagedUpload
}

// ===== evidence.rs =====

//! Language pin carried by a Draft and Category Schema snapshot.
// ===== language.rs =====

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowLanguage {
    Default,
    Ru,
    En,
    Tr,
    ZhHans,
}

// ===== address.rs =====

//! Op 16. No schema handle: the plan only reads the browser's own bytes.

use listing_core::stage_gate::{self, StageRequest};

use crate::error::CoreError;

pub(crate) const OP_PLAN_STAGE: u32 = 16;

pub(crate) fn plan_from_bytes(bytes: &[u8]) -> Result<Vec<u8>, CoreError> {
    let request: StageRequest = serde_json::from_slice(bytes).map_err(CoreError::decode)?;
    let value = stage_gate::plan_stage(request).map_err(CoreError::decode)?;
    serde_json::to_vec(&value).map_err(CoreError::decode)
}

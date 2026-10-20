//! WB operations in the existing listing-core ABI; no HTTP or send operation.
pub(crate) mod decode;
pub(crate) mod ops;

/// Input `{config: WbProductConfig}` + WB resident handle → `wb::Preview`.
pub(crate) const OP_WB_BUILD_PREVIEW: u32 = 14;
/// WB resident handle, empty input → `Vec<wb::Issue>` from metadata admission.
pub(crate) const OP_WB_METADATA_ISSUES: u32 = 15;

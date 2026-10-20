//! Cloud-owned workflow DTOs: the shape Cloud persists, puts on the wire and
//! hands to the SPA.
//!
//! They live here, not in the `op-workflow` crate, so the decision kernel
//! does not carry persistence, serde/TS and page-editing concerns it never
//! decides on; the kernel owns only operation facts, inputs, plans, decisions
//! and the stable job keys.
//!
//! Nothing here decides an operation: the five fixed operations stay in
//! [`op_workflow::operations`], and Cloud's `listing::kernel::facts` projects
//! rows onto those facts.

pub mod address;
pub mod evidence;
pub mod instance_defaults;
pub mod language;
pub mod types;
pub mod video;

pub use address::FieldAddress;
#[cfg(test)]
pub use evidence::WorkflowFailureStage;
pub use evidence::{
    MediaRole, WorkflowAiSummary, WorkflowFailureLogEntry, WorkflowImageLifecycle,
    WorkflowImagePhase, media_role_of,
};
pub use instance_defaults::{
    model_field_key, overlay_current_card_defaults, pipeline_injected_keys, source_identity_keys,
    without_non_identity_values, without_product_instance_owned_values,
};
pub use language::WorkflowLanguage;
pub use types::{
    CategoryComplexGroup, CategoryFieldConstraints, CategoryFieldEditor, CategoryFieldOption,
    CategoryFieldSource, CategoryFieldView, CategorySchemaView, WorkflowAiCandidate,
    WorkflowAiCandidateState, WorkflowAiFieldPolicy, WorkflowAiResult, WorkflowCategoryDraft,
    WorkflowComplexDraftGroup, WorkflowComplexDraftItem, WorkflowDraftValue,
};
#[cfg(test)]
pub use types::{WorkflowDraftSelection, WorkflowValidationIssue, WorkflowValidationIssueCode};
pub use video::WorkflowVideoMetadata;
// `test-support`, not plain `test`: `compose::compose_tests` (also
// `test-support`-gated, a cross-crate fixture Cloud's own tests build from)
// names these.
#[cfg(any(test, feature = "test-support"))]
pub use video::{WorkflowVideoOrigin, WorkflowVideoRole};

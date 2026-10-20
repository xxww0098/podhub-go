//! I/O-free PodHub workflow domain: the deterministic decision kernel.
//!
//! Cloud owns persistence, HTTP wire and effects. This crate owns operation
//! facts, inputs, plans, decisions, blocker/error/noop values, the stable
//! job/idempotency keys and the five fixed operation decision points (slice /
//! recognize / upload / send / prepare). It has no HTTP or
//! filesystem dependency.
//!
//! Draft/schema/AI/video projection types are **not** here: they serve Cloud
//! persistence and the SPA, so they live in
//! `rust/crates/listing-core/src/workflow_dto/`.

#![forbid(unsafe_code)]

mod identity;
pub mod operations;

pub use identity::DraftRef;
pub use operations::{
    ActiveOperations, Decision, JobSpec, NoopReason, OperationBlocker, OperationError,
    OperationFacts, OperationKind, PrepareInput, PrepareMediaPlan, PrepareOutcome, PreparePlan,
    RecognizeInput, RenderEvidence, SendBatchInput, SendRowInput, SliceInput, SubmissionFact,
    SubmissionIntentSpec, UploadInput, ValidationFact, WorkFact, prepare, recognize,
    recognize_job_key, send, send_job_key, slice, slice_job_key, upload, upload_job_key,
};

//! Decision model shared by the five fixed workflow operations.
//!
//! Cloud projects the four orthogonal row states and Job ledger
//! into borrowed, read-only [`OperationFacts`]. The five functions decide
//! from those facts; Cloud applies the resulting decisions.

use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::DraftRef;

/// Projection of the orthogonal `content_state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkFact {
    /// No content has been produced yet.
    Missing,
    /// A recognition job is currently running.
    Running,
    /// Committed AI content exists for the current inputs.
    Ready,
    /// The last attempt failed; a retry is allowed.
    Failed,
}

/// Projection of the orthogonal `validation_state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ValidationFact {
    /// Derived work is stale: revalidation is required before sending.
    Stale,
    /// Validation failed; the row cannot be sent as-is.
    Blocked,
    /// The current Listing serialization already passed validation.
    Passed,
}

/// Projection of the orthogonal `submission_state`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionFact {
    /// No submission intent exists for this row.
    None,
    /// An intent is persisted and queued.
    Queued,
    /// The Seller call is in flight.
    Submitting,
    /// The Seller call may have happened but no clear result came back;
    /// reconciliation is the only legal next step.
    Unknown,
    /// The Seller accepted the import.
    Accepted,
    /// The Seller rejected it; a corrected re-send is allowed.
    Rejected,
}

/// The active Job ledger entries an adapter currently observes for one row.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ActiveOperations {
    pub recognize_job_id: Option<String>,
    pub slice_job_id: Option<String>,
    pub upload_job_id: Option<String>,
    pub send_job_id: Option<String>,
}

/// Committed render evidence — the only acceptable proof that slices exist.
///
/// The manifest payload itself stays executor-side. The kernel compares these
/// four fingerprints and never trusts a UI self-report.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RenderEvidence {
    pub source_sha256: String,
    pub template_sha256: String,
    pub renderer_contract_version: String,
    pub manifest_digest: String,
}

/// Borrowed, read-only facts one operation decides on.
///
/// The decision kernel does not persist this projection.
#[derive(Debug, Clone)]
pub struct OperationFacts<'a> {
    /// The row the caller wants to act on. Cloud passes its `listing_rows.id`.
    pub workflow_id: &'a str,

    /// Cloud Listing identity. Operations that cross the Cloud boundary
    /// (send) require a valid Cloud UUID here.
    pub draft_ref: Option<&'a DraftRef>,

    /// Revision the adapter read from the trusted store.
    pub actual_revision: u64,

    /// Revision the user's click was rendered against (CAS expectation).
    pub expected_revision: u64,

    pub content: WorkFact,
    pub media: WorkFact,
    pub validation: ValidationFact,
    pub submission: SubmissionFact,

    /// Every AI Candidate Edit is Confirmed or Rejected.
    pub candidates_settled: bool,

    /// Committed slice evidence, when the store has one.
    pub render: Option<&'a RenderEvidence>,

    /// Owned Job ledger observation, populated from Cloud jobs.
    pub active: ActiveOperations,

    /// Generation new jobs are born under.
    pub cancel_generation: u64,

    /// Whether that generation is already stopped.
    pub cancelled: bool,
}

/// The four effect kinds the kernel may schedule.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationKind {
    Recognize,
    Slice,
    Upload,
    Send,
}

/// Errors are only contract violations, never business conditions. Anything a
/// user can see and fix is a [`Decision::Blocked`] blocker instead.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum OperationError {
    #[error(
        "row revision changed while the click was in flight: expected {expected}, actual {actual}"
    )]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("row identity is empty or invalid")]
    InvalidIdentity,
    #[error("evidence is inconsistent with the submitted request")]
    InvalidEvidence,
    #[error("operation input is empty or falls outside the contract")]
    InvalidInput,
    #[error("the generation was cancelled; no new effect may start")]
    Cancelled,
}

/// Why a requested effect is already satisfied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NoopReason {
    ContentReady,
    MediaReady,
    RenderEvidenceMatches,
    SubmissionAccepted,
}

/// A displayable, fixable business condition. Blockers are decisions, not
/// exceptions: the UI shows them and the user can address them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationBlocker {
    /// No source image is bound (or its sha is empty).
    MissingSourceImage,
    /// No PSD template is bound (or its sha is empty).
    MissingTemplate,
    /// The renderer contract version is missing.
    MissingRendererContract,
    /// The delivery contract version is missing.
    MissingDeliveryContract,
    /// The bound source/template disagree with the row's facts.
    InconsistentBinding,
    /// Recognition has no prompt (or its sha is empty).
    MissingPrompt,
    /// No media account is bound for delivery.
    MissingMediaAccount,
    /// Upload was requested but no committed render evidence exists.
    MissingRenderEvidence,
    /// Render evidence exists but the adapter produced no upload plan.
    UploadPlanMissing,
    /// AI Candidate Edits are not fully confirmed/rejected.
    CandidatesUnsettled,
    /// Send requires AI content ready.
    ContentNotReady,
    /// Send requires delivered media ready.
    MediaNotReady,
    /// Kept so older decisions still decode. Send no longer emits this:
    /// field validity is the caller's current validate result.
    ValidationStale,
    /// Kept so older decisions still decode. Send no longer emits this.
    ValidationFailed,
    /// A submission intent is already queued or in flight.
    SubmissionInFlight,
    /// The Seller result is unknown; reconciliation is the only path.
    NeedsReconciliation,
    /// Send needs a Cloud Listing UUID (`DraftRef::cloud_draft_id`).
    MissingCloudIdentity,
    /// The projection shows a running state with no recoverable Job.
    OrphanedRunningState { operation: OperationKind },
    /// The row is bound to a different Store than the batch target.
    TargetStoreMismatch { bound: String, requested: String },
}

/// One fixed decision for one operation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision<T> {
    /// The required evidence already exists; no effect is needed.
    Noop { reason: NoopReason },
    /// The same work is already running; subscribe to the existing Job.
    Wait { job_id: String },
    /// Create or reuse one idempotent Job.
    Start { job: JobSpec<T> },
    /// A user- or data-level condition is not met (not a system error).
    Blocked { blockers: Vec<OperationBlocker> },
}

/// The idempotent effect the adapter must persist and drive.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobSpec<T> {
    pub kind: OperationKind,
    /// `UNIQUE (org_id, kind, idempotency_key)` in the Cloud Job ledger:
    /// double clicks, API retries and restarts all find the original Job.
    pub idempotency_key: String,
    /// Revision the decision was made against; async writeback is fenced by
    /// `revision == job.input_revision`.
    pub input_revision: u64,
    /// Generation to birth the Job under; a stopped generation starts nothing.
    pub cancel_generation: u64,
    pub payload: T,
}

/// The frozen Seller submission contract `send()` returns. The adapter
/// persists it in one short transaction (intent + `submission_state=queued`
/// + send Job + outbox event) and only then may a worker call the Seller API.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmissionIntentSpec {
    /// Sorted `(row_id, revision)` of the rows this intent submits.
    pub row_revisions: Vec<(String, u64)>,
    pub target_store_id: String,
    /// Distinct `DraftRef.schema_revision` values of the submitted rows.
    pub schema_revisions: Vec<String>,
    /// Seller payload digest frozen by `listing-core` validate+plan+compose.
    pub payload_digest: String,
    pub idempotency_key: String,
}

/// One row of a send batch. Every row carries its own facts: the batch is a
/// Store-scoped collection, the decision stays row-truthful.
#[derive(Clone, Copy)]
pub struct SendRowInput<'a> {
    pub facts: &'a OperationFacts<'a>,
    pub draft_ref: &'a DraftRef,
    pub target_store_id: &'a str,
}

/// A send decision input: one Store, at most 100 rows, one frozen payload
/// digest. Rows are composed into one Seller import by the adapter, never
/// one HTTP call per row.
pub struct SendBatchInput<'a> {
    pub rows: &'a [SendRowInput<'a>],
    pub frozen_payload_digest: &'a str,
    pub target_store_id: &'a str,
}

/// Slice: produce a committed render manifest from the bound source image and
/// PSD template. `bindings_consistent` is the adapter's verdict that the bound
/// assets agree with the row facts; the kernel turns a negative verdict into
/// [`OperationBlocker::InconsistentBinding`].
pub struct SliceInput<'a, T> {
    pub facts: &'a OperationFacts<'a>,
    /// Executor payload (Cloud or browser request shape).
    pub request: T,
    pub source_sha256: &'a str,
    pub template_sha256: &'a str,
    pub renderer_contract_version: &'a str,
    pub bindings_consistent: bool,
}

/// Recognize: produce candidate content from source image + prompt + processing contract.
/// The payload is executor-side; `request` is never a UI-visible handle.
pub struct RecognizeInput<'a, T> {
    pub facts: &'a OperationFacts<'a>,
    pub request: T,
    pub image_sha256: &'a str,
    /// Hash of the prompt — the raw prompt text never enters the kernel
    /// (AI cache key = image + hash(prompt) + processing contract).
    pub prompt_sha256: &'a str,
    pub recognition_contract_version: &'a str,
}

/// Upload: deliver already-committed PSD slices to public object storage.
/// This never uploads the raw source image.
pub struct UploadInput<'a, T> {
    pub facts: &'a OperationFacts<'a>,
    pub request: T,
    pub manifest_digest: &'a str,
    pub media_account_id: &'a str,
    pub delivery_contract_version: &'a str,
}

/// The fixed prepare combinator: recognize, slice and upload run in that order;
/// send is never composed here.
pub struct PrepareInput<'a, R, S, U> {
    pub facts: &'a OperationFacts<'a>,
    pub recognize: RecognizeInput<'a, R>,
    pub slice: SliceInput<'a, S>,
    /// Present only when committed render evidence exists.
    pub upload: Option<UploadInput<'a, U>>,
}

/// The media rail of a prepare plan.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareMediaPlan<S, U> {
    /// Media is already ready.
    Ready,
    /// Slicing is running; subscribe to the existing Job.
    Wait,
    /// Evidence exists: only delivery is missing. Never a re-slice.
    Upload(Decision<U>),
    /// No trusted evidence: slice first, then the prepared upload.
    SliceThenUpload(Decision<S>),
    Blocked(Vec<OperationBlocker>),
}

/// Aggregate outcome of a prepare plan. Derived, never persisted: no
/// `prepare_state` exists (the UI derives it from sub-jobs and row facts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PrepareOutcome {
    /// At least one effect job is being created.
    Running,
    /// All rails are waiting on existing jobs.
    Waiting,
    /// Machine work is done but candidates need operator review.
    NeedsReview,
    /// Nothing left to do; the row is prepared.
    Prepared,
    Blocked(Vec<OperationBlocker>),
}

/// The plan `prepare()` returns: per-rail decisions plus the aggregate
/// outcome. Each media stage is planned only after recognition has succeeded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PreparePlan<R, S, U> {
    pub recognition: Decision<R>,
    pub media: PrepareMediaPlan<S, U>,
    pub outcome: PrepareOutcome,
}

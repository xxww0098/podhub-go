//! Decision unit tests for the five fixed operations (design §十三).

use super::*;

use crate::DraftRef;

#[derive(Debug, Clone, PartialEq, Eq)]
struct AiRequest;
#[derive(Debug, Clone, PartialEq, Eq)]
struct RenderRequest;
#[derive(Debug, Clone, PartialEq, Eq)]
struct DeliveryRequest;

const CLOUD_UUID: &str = "e1ab4380-29d5-47f0-81e4-eae7ffc2f7ce";

fn cloud_draft() -> DraftRef {
    DraftRef {
        draft_id: CLOUD_UUID.to_owned(),
        draft_revision: 3,
        schema_revision: "schema-v2".to_owned(),
    }
}

struct Facts {
    workflow_id: String,
    draft_ref: Option<DraftRef>,
    actual_revision: u64,
    expected_revision: u64,
    content: WorkFact,
    media: WorkFact,
    validation: ValidationFact,
    submission: SubmissionFact,
    candidates_settled: bool,
    render: Option<RenderEvidence>,
    active: ActiveOperations,
    cancel_generation: u64,
    cancelled: bool,
}

impl Facts {
    fn new() -> Self {
        Self {
            workflow_id: "row-1".to_owned(),
            draft_ref: None,
            actual_revision: 1,
            expected_revision: 1,
            content: WorkFact::Missing,
            media: WorkFact::Missing,
            validation: ValidationFact::Stale,
            submission: SubmissionFact::None,
            candidates_settled: true,
            render: None,
            active: ActiveOperations::default(),
            cancel_generation: 1,
            cancelled: false,
        }
    }

    fn facts(&self) -> OperationFacts<'_> {
        OperationFacts {
            workflow_id: &self.workflow_id,
            draft_ref: self.draft_ref.as_ref(),
            actual_revision: self.actual_revision,
            expected_revision: self.expected_revision,
            content: self.content,
            media: self.media,
            validation: self.validation,
            submission: self.submission,
            candidates_settled: self.candidates_settled,
            render: self.render.as_ref(),
            active: self.active.clone(),
            cancel_generation: self.cancel_generation,
            cancelled: self.cancelled,
        }
    }
}

fn evidence() -> RenderEvidence {
    RenderEvidence {
        source_sha256: "src-sha-1".to_owned(),
        template_sha256: "psd-sha-1".to_owned(),
        renderer_contract_version: "render-v1".to_owned(),
        manifest_digest: "manifest-sha-1".to_owned(),
    }
}

fn ready_row_facts() -> Facts {
    let mut facts = Facts::new();
    facts.draft_ref = Some(cloud_draft());
    facts.content = WorkFact::Ready;
    facts.media = WorkFact::Ready;
    facts.validation = ValidationFact::Passed;
    facts
}

fn ready_row() -> Facts {
    let mut facts = ready_row_facts();
    facts.workflow_id = "listing-row-1".to_owned();
    facts
}

fn recognize_input<'a>(facts: &'a OperationFacts<'a>) -> RecognizeInput<'a, AiRequest> {
    RecognizeInput {
        facts,
        request: AiRequest,
        image_sha256: "img-sha-1",
        prompt_sha256: "prompt-hash-1",
        recognition_contract_version: "recognition-v1",
    }
}

fn slice_input<'a>(facts: &'a OperationFacts<'a>) -> SliceInput<'a, RenderRequest> {
    SliceInput {
        facts,
        request: RenderRequest,
        source_sha256: "src-sha-1",
        template_sha256: "psd-sha-1",
        renderer_contract_version: "render-v1",
        bindings_consistent: true,
    }
}

fn upload_input<'a>(facts: &'a OperationFacts<'a>) -> UploadInput<'a, DeliveryRequest> {
    UploadInput {
        facts,
        request: DeliveryRequest,
        manifest_digest: "manifest-sha-1",
        media_account_id: "account-1",
        delivery_contract_version: "delivery-v1",
    }
}

fn send_row<'a>(
    facts: &'a OperationFacts<'a>,
    draft: &'a DraftRef,
    store: &'a str,
) -> SendRowInput<'a> {
    SendRowInput {
        facts,
        draft_ref: draft,
        target_store_id: store,
    }
}

fn run_prepare<'a>(
    facts: &'a OperationFacts<'a>,
    upload: Option<UploadInput<'a, DeliveryRequest>>,
) -> Result<PreparePlan<AiRequest, RenderRequest, DeliveryRequest>, OperationError> {
    prepare(PrepareInput {
        facts,
        recognize: recognize_input(facts),
        slice: slice_input(facts),
        upload,
    })
}

fn start_payload<T>(decision: &Decision<T>) -> &JobSpec<T> {
    match decision {
        Decision::Start { job } => job,
        _ => panic!("expected a Start decision"),
    }
}

fn blockers_of<T>(decision: &Decision<T>) -> &[OperationBlocker] {
    match decision {
        Decision::Blocked { blockers } => blockers,
        _ => panic!("expected a Blocked decision"),
    }
}

mod fences;
mod keys;
mod prepare;
mod recognize;
mod send;
mod slice;
mod upload;

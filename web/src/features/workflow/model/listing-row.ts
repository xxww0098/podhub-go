import type { ErrorFeedback } from "@/lib/error-feedback"
import type { PsdTemplateFailure } from "../prepare/psd-template-failure"
import type { PublishRequestEvidence } from "./publish-request-evidence"
import type {
  FieldLayerView,
  PickedPsdAsset,
  RowStage,
  WorkflowAiCandidate,
  WorkflowPreparationProgress,
  WorkflowReadinessReport,
} from "@/bindings/commands"
import type { PipelineRowStatus, TrackStatus } from "../prepare/pipeline-machine"

export type ListingRow = {
  id: string
  /** Canonical Workflow instance / DraftRef backing this image. */
  draftId: string
  imageName: string
  previewUrl?: string
  source?: PickedPsdAsset
  status: PipelineRowStatus
  /** The Cloud-derived row stage, once a projection has been seen. */
  stage?: RowStage
  /** Transport uncertainty survives a missing/older Cloud projection until exact reconciliation. */
  publishUnconfirmed?: boolean
  /** Validated local request diagnostics; bound to the attempted saved row version. */
  publishRequestEvidence?: PublishRequestEvidence
  publishDiagnostic?: import("./publish-diagnostic").PublishDiagnosticReference & {
    identity: import("./publish-request-evidence").PublishRequestIdentity
  }
  /** Build sources by plain field key, for the in-cell source marker. */
  sourceLayers?: Record<string, FieldLayerView>
  ai: TrackStatus
  render: TrackStatus
  upload: TrackStatus
  /** Normalized once at the failure boundary; never generated while rendering. */
  errorFeedback?: ErrorFeedback
  log: string
  preparationPlan?: WorkflowPreparationProgress
  preparationAi?: WorkflowPreparationProgress
  psdTemplateFailure?: PsdTemplateFailure
  preparationRender?: WorkflowPreparationProgress
  preparationUpload?: WorkflowPreparationProgress
  candidates?: WorkflowAiCandidate[]
  readiness?: WorkflowReadinessReport
}

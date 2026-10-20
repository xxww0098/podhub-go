import type { PsdTemplateFailure } from "../prepare/psd-template-failure"
import type { WorkflowProductLifecycle, WorkflowReadinessReport, WorkflowValidationIssue } from "@/bindings/commands"
import type { RowStageTracks } from "../prepare/preparation-branches"
import type { PreparationVerb } from "../prepare/preparation-tracks"

export type PublishRemediationCause =
  | "structured_issue" | "contract_invalid" | "request_offer_busy" | "request_refused"
  | "send_refused_psd" | "send_refused_store" | "send_refused_stale" | "send_refused_candidates"
  | "send_refused_fields" | "send_refused_existing" | "send_refused"
  | "outcome_unknown" | "operator_attested"
  | "prepare_leg" | "missing_source" | "wallet_balance"
  | "writes_disabled" | "brand_hashtag" | "duplicate_spu" | "credential_expired"
  | "fields_invalid" | "provider_rejected"

/** Only actions the row already exposes elsewhere; never send, never release. */
export type PublishRemediationAction =
  | { kind: "repair_brand"; label: string }
  | { kind: "retry_stage"; verb: PreparationVerb; label: string }
  | { kind: "review_candidates"; label: string }

export type PublishRemediation = {
  cause: PublishRemediationCause
  reason: string
  scope: string
  steps: string[]
  traceId?: string
  /** Read-only reference; it never authorizes a repair, release or send. */
  diagnosticId?: string
  diagnosticCode?: import("@/lib/diagnostic-summary").DiagnosticCode | null
  reportable?: boolean
  action?: PublishRemediationAction
}

export type PublishRemediationFacts = {
  lifecycle: WorkflowProductLifecycle
  readiness?: WorkflowReadinessReport
  rowLog: string
  localUnconfirmed?: boolean
  psdTemplateFailure?: PsdTemplateFailure
  tracks?: RowStageTracks
  /** `false` only when the row is known to have lost its local source image. */
  hasSource?: boolean
  imageName?: string
  /** `brandRepairEligible` passed and the caller holds the repair callback. */
  brandRepairable?: boolean
  platform?: string
  requestEvidence?: import("./publish-request-evidence").PublishRequestEvidence
  requestIdentity?: import("./publish-request-evidence").PublishRequestIdentity
  /** Current Listing field verdict. Empty when this attempt recorded no issues. */
  issues?: readonly Pick<WorkflowValidationIssue, "message">[]
}


/** Normalized diagnostics from any producer; raw external codes stay in the
 * diagnostic owner and are never interpolated into presentation copy. */
export type PublishProblem = {
  platform: string
  stage: string
  code: string
  field?: string | null
  traceId?: string
  family?: keyof typeof import("./publish-solutions").publishSolutions
  /** Local native coordinates; never a send permission or a remote diagnostic payload. */
  location?: import("./publish-wb-location").PublishWbLocation
}

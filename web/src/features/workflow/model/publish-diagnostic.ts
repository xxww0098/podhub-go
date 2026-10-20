import { captureDiagnostic, type DiagnosticPublishAction } from "@/lib/error-telemetry"
import type { DiagnosticCaptureInput } from "@/lib/diagnostic-capture"
import type { DiagnosticDetail } from "@/lib/diagnostic-memory"
import { approvedDiagnosticField, DIAGNOSTIC_STAGES, type DiagnosticStage } from "@/lib/diagnostic-summary"
import { safeDiagnosticTrace } from "@/lib/diagnostic-context"
import type { PublishProblem, PublishRemediation } from "./publish-problem"
import { resolvePublishRemediation } from "./publish-remediation"

/** Safe row reference only. No original, callback, token or exception is persisted. */
export type PublishDiagnosticReference = Readonly<{
  eventKey: string
  diagnosticId?: string
  traceId?: string
  errorFeedback?: import("@/lib/error-feedback").ErrorFeedback
}>
export type DiagnosticRowResult = import("@/bindings/commands").WorkflowOperationRowResult & { publishDiagnostic?: PublishDiagnosticReference }

/** Local extensions are validated again where a public command result enters the projection. */
export function diagnosticReferenceFrom(value: unknown): PublishDiagnosticReference | undefined {
  if (!value || typeof value !== "object") return undefined
  try {
    const ref: unknown = Object.getOwnPropertyDescriptor(value, "publishDiagnostic")?.value
    if (!ref || typeof ref !== "object") return undefined
    const id: unknown = Object.getOwnPropertyDescriptor(ref, "diagnosticId")?.value
    if (typeof id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return undefined
    const trace: unknown = Object.getOwnPropertyDescriptor(ref, "traceId")?.value
    return { eventKey: id, diagnosticId: id,
      ...(typeof trace === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(trace) ? { traceId: trace } : {}) }
  } catch { return undefined }
}
export type PublishDiagnosticEvidence = Pick<DiagnosticCaptureInput, "exactOperation" | "traceEvidence" | "publishAction">

/** The existing solution resolver is the only classification owner. */
export function normalizePublishDiagnostic(
  problem: PublishProblem | PublishRemediation, evidence: PublishDiagnosticEvidence = {},
): DiagnosticCaptureInput | null {
  const solution = "cause" in problem ? problem : resolvePublishRemediation(problem)
  if (!solution?.diagnosticCode) return null
  const sourceStage = "stage" in problem ? problem.stage : solution.cause === "outcome_unknown" ? "result" : "submit"
  const stage: DiagnosticStage = Object.hasOwn(DIAGNOSTIC_STAGES, sourceStage) ? sourceStage as DiagnosticStage : "build"
  const platform = "platform" in problem ? /^[a-z][a-z0-9_-]{0,31}$/.test(problem.platform) ? problem.platform : "unknown" : "ozon"
  const field = "field" in problem && approvedDiagnosticField(problem.field) ? problem.field : null
  return { code: solution.diagnosticCode, platform, stage, field, ...evidence,
    traceEvidence: { ...evidence.traceEvidence,
      listingIssueTraceId: safeDiagnosticTrace(evidence.traceEvidence?.listingIssueTraceId) ?? safeDiagnosticTrace(solution.traceId),
      requestHeaderTraceId: safeDiagnosticTrace(evidence.traceEvidence?.requestHeaderTraceId) } }
}

/** Call at the normalized event boundary, once; presentation remains read-only. */
export function capturePublishDiagnostic(problem: PublishProblem | PublishRemediation, evidence: PublishDiagnosticEvidence = {}): Promise<DiagnosticDetail | null> {
  const input = normalizePublishDiagnostic(problem, evidence)
  return input ? captureDiagnostic(input) : Promise.resolve(null)
}

export type PublishDiagnosticDispatch = Readonly<{
  action: DiagnosticPublishAction | null
  current: () => boolean
  onDispatch: () => void
}>

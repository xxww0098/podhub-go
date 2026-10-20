import { diagnosticProperty } from "./diagnostic-context"
import { errorMessage } from "./error-message"
import { diagLog } from "./diag-log"
import { reportErrorFeedback } from "./error-feedback-reporting"
import { collectErrorEnvironment, type ErrorReportContext } from "./error-report-environment"
import { refusalPair } from "./listing-refusal"

export type ErrorFeedback = {
  errorId: string
  code: string
  summary: string
  outcome: "unknown" | "failed"
  action?: string
  traceId?: string
  status?: number
}

function identifier(reason: unknown, key: string, pattern: RegExp): string | undefined {
  const value = diagnosticProperty(reason, key)
  return typeof value === "string" && pattern.test(value) ? value : undefined
}

/** A random 64-bit receipt, kept as text to avoid JS/JSON integer rounding. */
function errorNumber(): string {
  const words = crypto.getRandomValues(new Uint32Array(2))
  return ((BigInt(words[0]!) << 32n) | BigInt(words[1]!)).toString().padStart(20, "0")
}

export function createErrorFeedback(reason: unknown, fallback: string): ErrorFeedback {
  const code = refusalPair(reason)?.code ?? "operation_failed"
  const traceId = identifier(reason, "traceId", /^[A-Za-z0-9_.:-]{1,128}$/)
  const status = diagnosticProperty(reason, "status")
  const message = diagnosticProperty(reason, "message")
  const remediation = diagnosticProperty(reason, "remediation")
  // Copy only validated own properties: exception getters and raw bodies never become UI.
  const summary = errorMessage({ message, code, name: diagnosticProperty(reason, "name") },
    typeof reason === "string" ? errorMessage(reason, fallback) : fallback)
  const unconfirmed = /(?:result|outcome)_unknown|bad_response/.test(code)
    || [message, remediation].some(value => typeof value === "string" && /未.*确认|不要重复提交/.test(value))
  return {
    errorId: errorNumber(), code, traceId,
    outcome: unconfirmed ? "unknown" : "failed",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    summary: unconfirmed ? "云端结果待确认" : summary,
    action: unconfirmed ? "刷新核对结果，请勿重复提交。" : errorMessage(remediation, "") || undefined,
  }
}

/** HTTP path and x-request-id from an error this client constructed. OCR requestId stays out. */
export function errorTransportContext(reason: unknown): ErrorReportContext {
  const apiPath = diagnosticProperty(reason, "apiPath")
  const traceId = diagnosticProperty(reason, "traceId")
  const status = diagnosticProperty(reason, "status")
  return {
    ...(typeof apiPath === "string" ? { apiPath } : {}),
    ...(typeof apiPath === "string" && typeof traceId === "string" ? { requestId: traceId } : {}),
    ...(typeof status === "number" && Number.isInteger(status) ? { apiStatus: status } : {}),
  }
}

/** UI copy stays local; the backend receives only bounded machine metadata. */
export function reportFeedback(feedback: ErrorFeedback, context: ErrorReportContext = {}, logged = false): void {
  const { errorId, code, traceId, status } = feedback
  if (!logged) diagLog("[feedback]", "error", { errorId, code, traceId, status, stage: context.stage, row: context.rowId, card: context.cardId })
  reportErrorFeedback({ errorId, code, traceId, status, ...collectErrorEnvironment(), ...context })
}

import { diagnosticProperty } from "./diagnostic-context"
import { errorMessage } from "./error-message"
import { diagLog } from "./diag-log"
import { reportErrorFeedback } from "./error-feedback-reporting"
import { collectErrorEnvironment, type ErrorReportContext } from "./error-report-environment"
import { refusalPair } from "./listing-refusal"
import { newErrorId } from "./error-id"

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

export function createErrorFeedback(reason: unknown, fallback: string): ErrorFeedback {
  const refusal = refusalPair(reason)
  const code = refusal?.code ?? "operation_failed"
  const traceId = identifier(reason, "traceId", /^[A-Za-z0-9_.:-]{1,128}$/)
  const status = diagnosticProperty(reason, "status")
  const message = diagnosticProperty(reason, "message")
  const remediation = diagnosticProperty(reason, "remediation") ?? (refusal?.refusal === "missing_model"
    ? "系统默认识图模型暂不可用，请联系管理员配置。随后重试识别或一键准备，已完成图片保留。"
    : refusal?.refusal === "missing_media_account"
      ? "请工作空间所有者在「设置 → 存储桶」完成创建，再重试上传。"
      : undefined)
  // Copy only validated own properties: exception getters and raw bodies never become UI.
  const summary = errorMessage({ message, code, name: diagnosticProperty(reason, "name") },
    typeof reason === "string" ? errorMessage(reason, fallback) : fallback)
  const unconfirmed = /(?:result|outcome)_unknown|bad_response/.test(code)
    || [message, remediation].some(value => typeof value === "string" && /未.*确认|不要重复提交/.test(value))
  return {
    errorId: newErrorId(), code, traceId,
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

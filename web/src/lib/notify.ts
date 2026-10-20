import { createElement } from "react"
import { ErrorFeedbackDescription } from "@/components/error-feedback-description"
import { createErrorFeedback, errorTransportContext, reportFeedback, type ErrorFeedback } from "./error-feedback"
import type { ErrorReportContext } from "./error-report-environment"
import { refusalPair } from "./listing-refusal"
import { toast } from "@/components/ui/toast"
import { diagLog, reportError } from "@/lib/diag-log"
import {
  commandErrorCode,
  errorMessage,
  isWorkspaceCapRefusal,
} from "@/lib/error-message"

type NotifyOptions = {
  description?: string
  id?: string
  timeout?: number
  reason?: unknown
  feedback?: ErrorFeedback
  context?: ErrorReportContext
}

const NOTIFY_LOG = "[notify]"
const LOG_FIELD_CAP = 240

/** Flatten and clip a toast field so one `diagLog` line stays greppable. */
function logField(value: string | undefined): string | undefined {
  if (value == null || value.length === 0) return undefined
  const oneLine = value.replace(/\s+/g, " ").trim()
  if (!oneLine) return undefined
  return oneLine.length <= LOG_FIELD_CAP ? oneLine : `${oneLine.slice(0, LOG_FIELD_CAP)}…`
}

/**
 * Keep the exception class only. Its message can quote URLs, response bodies
 * or credentials; the resolved operator copy is already a separate field.
 */
function notifyReason(reason: unknown): string | undefined {
  return reason instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(reason.name)
    ? reason.name : undefined
}

function logNotifyError(fields: {
  message: string
  description?: string
  code?: string
  reason?: string
  errorId?: string
  traceId?: string
  status?: number
  stage?: string
  rowId?: string
  cardId?: string
}) {
  return diagLog(NOTIFY_LOG, "error", {
    message: logField(fields.message),
    description: logField(fields.description),
    code: logField(fields.code),
    reason: logField(fields.reason),
    errorId: fields.errorId,
    traceId: fields.traceId,
    status: fields.status,
    stage: fields.stage,
    row: fields.rowId,
    card: fields.cardId,
  })
}

/** Keep a caller-supplied reason. Otherwise copy the concrete refusal off the error. */
function withRefusal(reason: unknown, context: ErrorReportContext = {}): ErrorReportContext {
  const base = { ...errorTransportContext(reason), ...context }
  if (context.refusalReason) return base
  const pair = refusalPair(reason)
  return pair ? { ...base, refusalReason: pair.refusal } : base
}

function addErrorToast(message: string, options: NotifyOptions & { feedback: ErrorFeedback }) {
  return toast.add({
    type: "error",
    id: options?.id,
    title: message,
    description: createElement(ErrorFeedbackDescription, { feedback: options.feedback, description: options.description }),
    timeout: options?.timeout ?? 6_000,
  })
}

export type LiveNoticeType = "loading" | "error" | "unknown" | "info"

export type LiveNotice = {
  id: string
  type: LiveNoticeType
  title: string
  description?: string
  reason?: unknown
  feedback?: ErrorFeedback
  action?: {
    label: string
    disabled?: boolean
    onClick: () => void
  }
}

/**
 * One overlay: the toast host. Ephemeral success / failure / info and
 * persistent live status both land here — never as an in-page banner.
 * Field issues ride their own toast; ledger StateChips stay on the row.
 * Error toasts also write one `[notify] error` console line so DevTools can grep them.
 */
export function notifyError(message: string, options?: NotifyOptions) {
  const details = options?.feedback ?? createErrorFeedback(options?.reason, message)
  if (!options?.feedback) details.errorId = logNotifyError({ message, ...details, ...options?.context }) ?? details.errorId
  reportFeedback(details, withRefusal(options?.reason, options?.context), !options?.feedback)
  return addErrorToast(message, { ...options, feedback: details })
}

export function notifySuccess(message: string, options?: NotifyOptions) {
  return toast.add({
    type: "success",
    title: message,
    description: options?.description,
    timeout: options?.timeout ?? 4_000,
  })
}

export function notifyInfo(message: string, options?: NotifyOptions) {
  return toast.add({
    type: "info",
    title: message,
    description: options?.description,
    timeout: options?.timeout ?? 4_000,
  })
}

/**
 * How long a cap refusal stays up. Cloud writes the next step into the
 * sentence — "解散一个不再使用的自建空间" — and that is a decision, not a glance.
 */
const REFUSAL_TIMEOUT = 20_000

/** Surface a host CommandError (or unknown reject) as a top-center error toast. */
export function notifyCommandError(reason: unknown, fallback: string) {
  const code = commandErrorCode(reason)
  const message = errorMessage(reason, fallback)
  // Keyed by code so a repeated refusal replaces its own row instead of
  // stacking: the in-progress guard fires per attempt, and a cap refusal
  // answers every retry of a thing that can never succeed.
  const refusal = isWorkspaceCapRefusal(reason)
  const details = createErrorFeedback(reason, fallback)
  details.errorId = reportError(NOTIFY_LOG, reason, {
    message: logField(message),
    code: details.code,
    errorId: details.errorId,
    traceId: details.traceId,
    status: details.status,
    reason: notifyReason(reason),
  }) ?? details.errorId
  reportFeedback(details, withRefusal(reason), true)
  return addErrorToast(details.summary, {
    feedback: details,
    id:
      refusal || code === "workflow_task_in_progress" || code === "cloud_unavailable"
        ? code
        : undefined,
    timeout: refusal ? REFUSAL_TIMEOUT : undefined,
  })
}

/** Persistent live fact. Same viewport as ephemeral toasts; does not auto-dismiss. */
export function notifyLive(notice: LiveNotice) {
  const details = notice.type === "error" ? notice.feedback ?? createErrorFeedback(notice.reason, notice.title) : undefined
  if (details) {
    if (!notice.feedback) details.errorId = logNotifyError({ message: notice.title, ...details }) ?? details.errorId
    reportFeedback(details, withRefusal(notice.reason), !notice.feedback)
  }
  return toast.add({
    id: notice.id,
    type: notice.type,
    title: notice.title,
    description: details ? createElement(ErrorFeedbackDescription, { feedback: details, description: notice.description }) : notice.description,
    timeout: 0,
    actionProps: notice.action
      ? {
          children: notice.action.label,
          disabled: notice.action.disabled,
          onClick: notice.action.onClick,
        }
      : undefined,
  })
}

export function clearLive(id: string) {
  toast.close(id)
}

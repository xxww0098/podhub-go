import type { ListingIntent } from "@/bindings/http-listing-intents"
import type { SendFact } from "./types"

/** Created/resumed/replayed describe admission, never Seller acceptance. */
export function factFromIntent(intent: ListingIntent, isKnownIssue?: (stage: string, code: string) => boolean): SendFact {
  const base = { intentId: intent.id, serverOperationId: intent.client_operation_id, serverRevision: intent.row_revision, receipt: intent }
  const task = intent.external_task_id
  const positiveTask = typeof task === "string" && /^[1-9]\d*$/.test(task) && Number.isSafeInteger(Number(task))
  if (intent.state === "accepted") {
    const issue = intent.current_issue_status === "present" ? intent.current_issue : undefined
    const code = Number.isSafeInteger(intent.row_revision) && intent.row_revision >= 0
      && intent.last_error_code === "OZON_ROW_REJECTED" && issue?.code === "OZON_ROW_REJECTED"
      && issue.phase === "submit" && issue.resolved_at_ms == null && issue.input_revision === intent.row_revision
      ? issue.code : undefined
    return { ...base, state: "accepted", ...(positiveTask ? { taskId: Number(task) } : {}), ...(code ? { code, canResume: false } : {}) }
  }
  if (intent.state === "queued" || intent.state === "submitting") return { ...base, state: "pending" }
  if (intent.state === "superseded" && intent.can_resume) return { ...base, state: "rejected", canResume: true }
  if (intent.state === "rejected" && intent.current_issue_status === "present" && intent.can_resume
    && intent.current_issue && isKnownIssue?.(intent.current_issue.phase, intent.current_issue.code)
    && Array.isArray(intent.current_issue.allowed_actions) && intent.current_issue.allowed_actions.includes("resume")) {
    return { ...base, state: "rejected", canResume: true }
  }
  return { ...base, state: "unknown" }
}

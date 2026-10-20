import type { ListingIntent } from "@/bindings/http-listing-intents"
import type { SendFact } from "./types"

/** Created/resumed/replayed describe admission, never Seller acceptance. */
export function factFromIntent(intent: ListingIntent, isKnownIssue?: (stage: string, code: string) => boolean): SendFact {
  const base = { intentId: intent.id, serverOperationId: intent.client_operation_id, serverRevision: intent.row_revision, receipt: intent }
  const task = intent.external_task_id
  const positiveTask = typeof task === "string" && /^[1-9]\d*$/.test(task) && Number.isSafeInteger(Number(task))
  if (intent.state === "accepted") return positiveTask ? { ...base, state: "accepted", taskId: Number(task) } : { ...base, state: "accepted" }
  if (intent.state === "queued" || intent.state === "submitting") return { ...base, state: "pending" }
  if (intent.state === "superseded" && intent.can_resume) return { ...base, state: "rejected", canResume: true }
  if (intent.state === "rejected" && intent.current_issue_status === "present" && intent.can_resume
    && intent.current_issue && isKnownIssue?.(intent.current_issue.phase, intent.current_issue.code)
    && Array.isArray(intent.current_issue.allowed_actions) && intent.current_issue.allowed_actions.includes("resume")) {
    return { ...base, state: "rejected", canResume: true }
  }
  return { ...base, state: "unknown" }
}

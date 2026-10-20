import type { PipelineEvidence } from "./publish-pipeline-metrics"
import type { NetworkReport } from "./mock-browser-network"
import type { PublishHaltReason } from "@/features/workflow/rows/types"
import type { ReconcileResult } from "@/features/workflow/submit/queue/types"
export const scenarios = ["local", "accepted", "stop", "unknown", "schema", "media", "wb", "wb-empty", "late",
  "wb-characteristics", "diagnostic-report", "diagnostic-route", "diagnostic-offline", "request-400", "request-409",
  "brand-repair", "brand-no-action", "brand-stale-revision", "brand-stop", "brand-scope",
  "unknown-release", "unknown-missing-id", "unknown-readback-failed", "unknown-stale-context", "unknown-no-resident",
  "brand-keepalive-return", "unknown-keepalive-return", "admission-store-unavailable", "admission-capacity-full",
  "admission-offer-busy", "admission-busy-exhausted", "reconcile-pending-200", "reconcile-lost-history", "wb-error-coordinates"] as const
export type Scenario = typeof scenarios[number]
export type QueueEvidence = {
  rowCount: number; closed: boolean; actionId?: string
  snapshot: { phase: string; inFlight: number; deadlines: number[]; counts: { accepted: number; rejected: number; unknown: number; pending: number }; haltedDestinations: string[]
    halts: { blockId: string; platform: string; destination: string; reason: PublishHaltReason }[] }
  busy?: Record<string, { attempts: number; startedAt: number }>; reconciliation?: ReconcileResult
  rows: { id: string; destination: string; state: string; rev: number }[]
  parents: { id: string; destination: string; state: string; budget: { submits: number; schema: number; media: number }; remaining: number; haltReason?: PublishHaltReason }[] | undefined
}
export type ScenarioResult = {
  name: string; status: "passed" | "failed" | "pending"; problems: string[]
  evidence?: PipelineEvidence; network?: NetworkReport; artifacts: string[]
  console: { type: string; text: string }[]; pageErrors: string[]
  screenshots: { file: string; before: number; after: number }[]
  performance?: ReturnType<typeof performanceProblems>
}
export function performanceProblems(evidence: PipelineEvidence) {
  const windows = evidence.actions.map((action) => {
    const end = action.end ?? evidence.capturedAt
    const commits = evidence.commits.filter((entry) => entry.at >= action.start && entry.at <= end).length
    const dispatches = evidence.business.filter((entry) => entry.event === "dispatch" && entry.at >= action.start && entry.at <= end)
    const zeroCalls = ["import", "single-edit", "validate-compose", "stop", "idle", "wb-import", "wb-edit-validate",
      "diagnostic-select", "diagnostic-details", "diagnostic-copy", "diagnostic-route", "diagnostic-offline",
      "workbench-configure", "unknown-confirm", "workbench-stop", "workbench-scope"].includes(action.name)
    const tasks = evidence.longtasks.filter((entry) => entry.start < end && entry.start + entry.duration > action.start)
    const limit = action.name === "idle" ? 0
      : ["import", "validate-compose", "normal-send", "continue", "query", "reload", "workbench-load", "brand-repair", "unknown-inspect", "unknown-release"].includes(action.name) ? 128 : 16
    return { id: action.id, name: action.name, start: action.start, end, commits, commitLimit: limit, longtasks: tasks, dispatches: dispatches.length, zeroCallBudget: zeroCalls,
      failed: action.status !== "passed" || (zeroCalls && dispatches.length !== 0) || commits > limit
        || tasks.some((entry) => entry.start >= (evidence.readyAt ?? Infinity) && entry.duration >= 50) }
  })
  return { observerSupported: evidence.observerSupported, windows,
    firstPaint: evidence.longtasks.filter((entry) => entry.start < (evidence.readyAt ?? Infinity)),
    allLongtasks: evidence.longtasks,
    failed: !evidence.observerSupported || windows.some((window) => window.failed)
      || evidence.longtasks.some((entry) => entry.start >= (evidence.readyAt ?? Infinity) && entry.duration >= 50) }
}
// An empty implementation dependency list and a complete fixture matrix do not imply full-goal acceptance.
// Native gesture/clipboard limits, required gates and fresh independent full review remain separate evidence.
export const pendingDependencies = [] as const

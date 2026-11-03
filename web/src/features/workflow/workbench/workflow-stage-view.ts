import type { RowStage, WorkflowProductLifecycle } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { filterReconcileRows, type ReconcileFilter } from "./reconcile-filter"

export const WORKFLOW_STAGE_VIEWS = ["materials", "processing", "ready", "receipts"] as const
export type WorkflowStageView = (typeof WORKFLOW_STAGE_VIEWS)[number]
export type WorkflowView = WorkflowStageView | "all"

const STAGE_VIEW = {
  awaiting_content: "materials",
  recognizing: "processing",
  recognition_failed: "processing",
  rendering: "processing",
  uploading: "processing",
  media_failed: "processing",
  candidates_pending: "processing",
  fields_invalid: "processing",
  build_stale: "ready",
  ready_to_publish: "ready",
  queued: "receipts",
  submitting: "receipts",
  outcome_unknown: "receipts",
  accepted: "receipts",
  publish_rejected: "receipts",
  operator_attested: "receipts",
} satisfies Record<RowStage, WorkflowStageView>

type StageDrafts = Record<string, { lifecycle?: WorkflowProductLifecycle } | undefined>

/** A browsing group over existing facts; this never changes a row's lifecycle or send permission. */
export function workflowStageViewOf(row: ListingRow, drafts: StageDrafts): WorkflowStageView {
  if (row.publishUnconfirmed) return "receipts"
  const stage = drafts[row.draftId]?.lifecycle?.stage ?? row.stage
  return stage ? STAGE_VIEW[stage] ?? "materials" : "materials"
}

/** The one visible scope for the grid, selection, batch commands and column fill. */
export function workflowStageViewScope(
  rows: readonly ListingRow[],
  drafts: StageDrafts,
  stage: WorkflowView,
  reconcile: ReconcileFilter,
  selectedRowIds: ReadonlySet<string>,
) {
  const counts: Record<WorkflowStageView, number> = { materials: 0, processing: 0, ready: 0, receipts: 0 }
  const stageRows: ListingRow[] = []
  for (const row of rows) {
    const group = workflowStageViewOf(row, drafts)
    counts[group] += 1
    if (stage === "all" || group === stage) stageRows.push(row)
  }
  const visibleRows = filterReconcileRows(stageRows, drafts, reconcile)
  const selectedIds = visibleRows.filter((row) => selectedRowIds.has(row.id)).map((row) => row.id)
  return { rows: visibleRows, selectedIds, selectedRowIds: new Set(selectedIds), counts }
}

import type { WorkflowDraftView, WorkflowProductStatusView } from "@/bindings/commands"
import { workflowActions } from "../workflow-actions"
import type { ListingRow } from "../model/listing-row"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { fieldIssueSummary } from "../model/workflow-readiness"
import { listingWorkbenchScope, patchListingWorkbench } from "./listing-workbench-store"
import { diagLog } from "@/lib/diag-log"
import { listingLog } from "@/lib/listing-log"
import { captureWorkbenchPublishDiagnostics } from "./publish-diagnostic-producer"

/** Add a complete server verdict to its existing Product Instance. */
export function productWithStatus(
  product: WorkflowDraftView,
  status: WorkflowProductStatusView,
): WorkflowDraftView {
  if (status.lifecycle.view_revision < product.lifecycle.view_revision) return product
  return {
    ...product,
    target_store_id: status.target_store_id,
    draft: status.draft ?? product.draft,
    validation_state: status.validation_state ?? product.validation_state,
    issues: status.issues ?? product.issues,
    lifecycle: status.lifecycle,
  }
}

/**
 * Read the Cloud ListingRowView back onto one row. Every preparation step and
 * every edit/media mutation ends here rather than projecting what the renderer
 * believes it just did — the lifecycle is the only thing that survives a
 * restart. Returns undefined when Cloud could not be read.
 */
export async function refreshProductStatus(row: ListingRow, log?: string, scope = listingWorkbenchScope()) {
  const started = performance.now()
  listingLog({ module: "verify", event: "verify.start", rowId: row.draftId })
  const status = await workflowActions
    .workflowGetProductStatus(row.draftId)
    .catch((reason) => {
      diagLog("[listing-status]", "read_failed", { draftId: row.draftId, reason: reason instanceof Error ? reason.message : String(reason) })
      listingLog({
        level: "error", module: "verify", event: "verify.end", rowId: row.draftId,
        durationMs: performance.now() - started, errorCode: "read_failed",
      })
      return undefined
    })
  if (!status) return undefined
  listingLog({
    module: "verify", event: "verify.end", rowId: row.draftId,
    durationMs: performance.now() - started,
    fields: { stage: status.lifecycle.stage, revision: status.lifecycle.view_revision },
  })
  commitProductStatus(row.draftId, status, scope, log)
  return status
}

export type ProductStatusCommitItem = {
  draftId: string
  status?: WorkflowProductStatusView
  log?: string
  fallbackStatus?: ListingRow["status"]
  /** Submission normalization supplies safe references, never HTTP bodies. */
  diagnostic?: import("../model/publish-diagnostic").PublishDiagnosticReference
}

/** Batch-commit server verdicts or logs onto rows in a single store transaction. */
export function commitProductStatuses(
  items: ProductStatusCommitItem[],
  scope = listingWorkbenchScope(),
  normalizeDiagnostics = true,
): boolean {
  if (!items.length) return false
  let accepted = false
  const acceptedDraftIds = new Set<string>()
  patchListingWorkbench((current) => {
    const itemMap = new Map(items.map((item) => [item.draftId, item]))
    const nextProductDrafts: Record<string, WorkflowDraftView> = { ...current.productBases }

    for (const item of items) {
      if (item.status) {
        const product = current.productBases[item.draftId]
        if (!product || item.status.lifecycle.view_revision < product.lifecycle.view_revision) continue
        if (item.status.lifecycle.stage !== product.lifecycle.stage) {
          const issues = item.status.lifecycle.stage === "fields_invalid"
            ? fieldIssueSummary(item.status.issues)
            : undefined
          diagLog("[listing-send]", "row.status", {
            row: item.draftId,
            stage: item.status.lifecycle.stage,
            revision: item.status.lifecycle.view_revision,
            ...(issues ? { issues } : {}),
          })
        }
        nextProductDrafts[item.draftId] = productWithStatus(product, item.status)
        acceptedDraftIds.add(item.draftId)
      } else {
        acceptedDraftIds.add(item.draftId)
      }
    }

    if (acceptedDraftIds.size === 0) return {}
    accepted = true

    const nextRows = current.rows.map((candidate) => {
      const draftId = candidate.draftId || candidate.id
      if (!acceptedDraftIds.has(draftId) && !acceptedDraftIds.has(candidate.id)) return candidate
      const item = itemMap.get(draftId) ?? itemMap.get(candidate.id)
      if (!item) return candidate
      if (item.status) {
        return {
          ...projectListingRowLifecycle(candidate, item.status.lifecycle, item.status.readiness, item.status.source_layers),
          ...(item.log === undefined ? {} : { log: item.log }),
        }
      }
      return {
        ...candidate,
        ...(item.fallbackStatus ? { status: item.fallbackStatus } : {}),
        ...(item.log === undefined ? {} : { log: item.log }),
      }
    })

    return {
      productDrafts: nextProductDrafts,
      rows: nextRows,
    }
  }, scope)
  if (accepted && normalizeDiagnostics) void captureWorkbenchPublishDiagnostics([...acceptedDraftIds], scope,
    new Map(items.flatMap((item) => item.diagnostic ? [[item.draftId, item.diagnostic] as const] : [])))
  return accepted
}

export function commitProductStatus(draftId: string, status: WorkflowProductStatusView, scope: number, log?: string): boolean {
  return commitProductStatuses([{ draftId, status, log }], scope)
}

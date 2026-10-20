import { useEffect, useRef } from "react"
import type { WorkflowQueueState } from "@/bindings/commands"
import { workflowActions } from "../workflow-actions"
import { useVisiblePolling } from "@/lib/visible-polling"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  useListingWorkbenchStore,
  type ListingWorkbenchRuntime,
} from "./listing-workbench-store"
import { rowPreparing } from "../prepare/preparation-tracks"
import { productWithStatus } from "./product-status"
import { reportError } from "@/lib/diag-log"

export function workbenchNeedsPolling(state: ListingWorkbenchRuntime): boolean {
  return state.rows.some((row) => {
    const lifecycle = state.productDrafts[row.draftId]?.lifecycle
    return lifecycle && ["recognizing", "rendering", "uploading"].includes(lifecycle.stage)
  })
}

type PollContext = {
  active: boolean
  cardId?: string
  generation: number
  busy: boolean
  pendingCardChanges: boolean
  queueStopRequested: boolean
  streamHealthy?: boolean
  projectQueueState: (queue: WorkflowQueueState) => void
}

function rowWritable(state: ListingWorkbenchRuntime, row: ListingWorkbenchRuntime["rows"][number]): boolean {
  return !rowPreparing(state.activity, row.id) &&
    !["dirty", "saving", "error"].includes(state.rowSaveStates[row.draftId] ?? "idle")
}

/** A response may only update rows that stayed untouched for its whole flight. */
export async function pollWorkbench(
  flight: { inFlight: boolean },
  readContext: () => PollContext,
): Promise<void> {
  const context = { ...readContext() }
  const before = peekListingWorkbench()
  if (flight.inFlight || !context.active || context.busy || !context.cardId || !workbenchNeedsPolling(before)) return
  flight.inFlight = true
  try {
    const isCurrent = () => {
      const now = readContext()
      return now.active && !now.busy && now.cardId === context.cardId && now.generation === context.generation
    }
    const snapshot = await workflowActions.workflowReadCardStatus(context.cardId, isCurrent)
    const now = readContext()
    if (!isCurrent()) return
    const originalRows = new Map(before.rows.map((row) => [row.draftId, row]))
    const statuses = new Map(snapshot.rows.map((row) => [row.draftId, row]))
    const current = peekListingWorkbench()
    const queueUnchanged = !context.pendingCardChanges && !now.pendingCardChanges &&
      context.queueStopRequested === now.queueStopRequested &&
      current.rows === before.rows && current.productDrafts === before.productDrafts &&
      current.queueFrozenIds === before.queueFrozenIds &&
      current.queuePaused === before.queuePaused &&
      current.queueRunning === before.queueRunning &&
      current.queueHaltReason === before.queueHaltReason
    const productDrafts = { ...current.productBases }
    const rows = current.rows.map((row) => {
      const original = originalRows.get(row.draftId)
      const product = current.productDrafts[row.draftId]
      const result = statuses.get(row.draftId)
      if (!original || !product || !result || row !== original ||
        product !== before.productDrafts[row.draftId] ||
        !rowWritable(before, original) || !rowWritable(current, row) ||
        result.status.lifecycle.view_revision < product.lifecycle.view_revision) return row
      const next = productWithStatus(product, result.status)
      const nextRow = projectListingRowLifecycle(row, next.lifecycle, result.status.readiness)
      const observed = [product.target_store_id, product.draft, product.validation_state, product.issues, product.lifecycle, product.updated_at_ms, row.status, row.ai, row.render, row.upload, row.candidates, row.readiness]
      const received = [next.target_store_id, next.draft, next.validation_state, next.issues, next.lifecycle, result.updatedAtMs, nextRow.status, nextRow.ai, nextRow.render, nextRow.upload, nextRow.candidates, nextRow.readiness]
      // A different revision already proves a change. Equal revisions still
      // compare the projection so polling can heal local optimistic state.
      if (product.lifecycle.view_revision === next.lifecycle.view_revision &&
        product.updated_at_ms === result.updatedAtMs &&
        JSON.stringify(observed) === JSON.stringify(received)) return row
      productDrafts[row.draftId] = { ...next, updated_at_ms: result.updatedAtMs }
      return nextRow
    })
    if (rows.some((row, index) => row !== current.rows[index])) {
      patchListingWorkbench({ productDrafts, rows })
    }
    if (queueUnchanged && (
      snapshot.queue.running !== current.queueRunning || snapshot.queue.paused !== current.queuePaused ||
      (snapshot.queue.halt_reason ?? null) !== current.queueHaltReason ||
      snapshot.queue.stop_after_current !== now.queueStopRequested ||
      JSON.stringify(snapshot.queue.frozen_row_ids) !== JSON.stringify(current.queueFrozenIds)
    )) now.projectQueueState(snapshot.queue)
  } catch (reason) {
    reportError("[listing-poll]", reason, { card: context.cardId })
    // A failed observation keeps the last useful projection; the next visible beat retries.
  } finally {
    flight.inFlight = false
  }
}

export function useWorkbenchPolling(readContext: () => PollContext): void {
  const pending = useListingWorkbenchStore(workbenchNeedsPolling)
  const context = useRef(readContext)
  useEffect(() => {
    context.current = readContext
  }, [readContext])
  const flight = useRef({ inFlight: false })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const current = readContext()
  useVisiblePolling({
    enabled: current.active && !current.busy && Boolean(current.cardId) && pending,
    intervalMs: current.streamHealthy ? 15_000 : 2_000,
    restartKey: current.cardId,
    onPoll: () => {
      void pollWorkbench(flight.current, () => {
        const latest = context.current()
        return { ...latest, active: latest.active && mounted.current && document.visibilityState === "visible" }
      })
    },
  })
}

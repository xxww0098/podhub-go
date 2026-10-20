import { create } from "zustand"
import { useStoreWithEqualityFn } from "zustand/traditional"

import type { QueueHaltReason, WorkflowDraftView, WorkflowReadinessReport } from "@/bindings/commands"
import type { SaveState } from "@/components/save-state-chip"
import type { ListingRow } from "../model/listing-row"
import { changedProductFields, mergeProductEdit, productEditBaseline, type ProductEditFields } from "../model/product-edit"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { readOcrModelChoice } from "../prepare/ocr-model-preference"
import {
  NO_GUIDED_PREPARATION,
  NO_PREPARATION_ACTIVITY,
  NO_PREPARATION_PROGRESS,
  type GuidedPreparation,
  type PreparationActivity,
  type PreparationProgress,
} from "../prepare/preparation-tracks"
import {
  sameWorkflowTaskProgress,
  workflowTaskProgressView,
  type WorkflowTaskProgressView,
} from "../workflow-task-progress"

/**
 * In-window workbench runtime for the open Listing Card. Cloud remains the
 * Draft / row_state SSOT: this store is the table, queue and
 * preparation projection the runner already held in useState, so a publish
 * tick can repaint the grid without rebuilding the library shell.
 */
export type ListingWorkbenchRuntime = {
  scope: number
  modelRouting?: import("../prepare/ocr-model-routing").OcrModelRouting
  productBases: Record<string, WorkflowDraftView>
  dirtyProducts: Record<string, ProductEdit>
  removedProducts: ReadonlySet<string>
  pendingRemovalIds: ReadonlySet<string>
  cardName: string
  /** The card the mounted runner is showing; undefined while on the library. */
  cardId?: string
  rows: ListingRow[]
  selectedIds: string[]
  activeProductId?: string
  productDrafts: Record<string, WorkflowDraftView>
  rowSaveStates: Record<string, SaveState>
  queueRunning: boolean
  queuePaused: boolean
  /** Typed reason the queue halted; null while running clean or idle. */
  queueHaltReason: QueueHaltReason | null
  queueFrozenIds: string[]
  activity: PreparationActivity
  preparationProgress: PreparationProgress
  guidedPreparation: GuidedPreparation
  /**
   * Monotonic marker of applied card-level invalidations.
   * A save request captures this value when it is issued; its response is
   * dropped if the marker has moved meanwhile, because a template change does
   * not bump row view_revision — only the invalidation's refetch carries
   * the authoritative row.
   */
  mediaEpoch: number
}

export type ProductEdit = { id: number; base: WorkflowDraftView; view: WorkflowDraftView; fields: ProductEditFields }
let scopeSequence = 0
let editSequence = 0

export function emptyListingWorkbench(): ListingWorkbenchRuntime {
  const modelRouting = readOcrModelChoice()
  return {
    scope: ++scopeSequence,
    ...(modelRouting ? { modelRouting } : {}),
    productBases: {},
    dirtyProducts: {},
    removedProducts: new Set(),
    pendingRemovalIds: new Set(),
    cardName: "",
    cardId: undefined,
    rows: [],
    selectedIds: [],
    activeProductId: undefined,
    productDrafts: {},
    rowSaveStates: {},
    queueRunning: false,
    queuePaused: false,
    queueHaltReason: null,
    queueFrozenIds: [],
    activity: NO_PREPARATION_ACTIVITY,
    preparationProgress: { ...NO_PREPARATION_PROGRESS },
    guidedPreparation: { ...NO_GUIDED_PREPARATION },
    mediaEpoch: 0,
  }
}

const useListingWorkbenchStore = create<ListingWorkbenchRuntime>(emptyListingWorkbench)

export function peekListingWorkbench(): ListingWorkbenchRuntime {
  return useListingWorkbenchStore.getState()
}

/**
 * Subscribe to workbench snapshots. `previous` is the store from before this
 * commit. Callers that only read the next snapshot keep working.
 */
export function subscribeListingWorkbench(
  onStoreChange: (state: ListingWorkbenchRuntime, previous?: ListingWorkbenchRuntime) => void,
): () => void {
  return useListingWorkbenchStore.subscribe(onStoreChange)
}

export function resetListingWorkbench(): void {
  const pendingRemovalIds = peekListingWorkbench().pendingRemovalIds
  useListingWorkbenchStore.setState({ ...emptyListingWorkbench(), pendingRemovalIds }, true)
}

export function listingWorkbenchScope(): number {
  return useListingWorkbenchStore.getState().scope
}

export function listingScopeCurrent(scope: number): boolean {
  return scope === listingWorkbenchScope()
}

function visibleProducts(
  bases: Record<string, WorkflowDraftView>,
  dirty: Record<string, ProductEdit>,
  previous?: Pick<ListingWorkbenchRuntime, "productBases" | "dirtyProducts" | "productDrafts">,
) {
  const visible: Record<string, WorkflowDraftView> = {}
  for (const [id, base] of Object.entries(bases)) {
    if (previous?.productBases[id] === base && previous.dirtyProducts[id] === dirty[id] && previous.productDrafts[id]) {
      visible[id] = previous.productDrafts[id]
    } else if (dirty[id]) {
      const merged = mergeProductEdit(dirty[id].base, dirty[id].view, base, false, dirty[id].fields)
      visible[id] = {
        ...base,
        ...merged,
        // `mergeProductEdit` returns the mergeable fields only; the edit's own
        // cleared set and hand-edited marks ride the view so a just-typed or
        // just-cleared cell keeps its honest echo instead of the inherited
        // card default.
        draft: dirty[id].view.draft.cleared
          ? { ...merged.draft, cleared: dirty[id].view.draft.cleared }
          : merged.draft,
        hand_edited_keys:
          dirty[id].view.hand_edited_keys ?? base.hand_edited_keys,
      }
    } else {
      visible[id] = base
    }
  }
  return visible
}

/** Server responses enter here; local edits never become the server baseline. */
function mergeProducts(
  current: ListingWorkbenchRuntime,
  incoming: Record<string, WorkflowDraftView>,
  previous = current,
) {
  const productBases: Record<string, WorkflowDraftView> = {}
  const removedProducts = new Set(current.removedProducts)
  const dirtyProducts = { ...current.dirtyProducts }
  for (const id of Object.keys(current.productBases)) {
    if (!(id in incoming)) {
      removedProducts.add(id)
      delete dirtyProducts[id]
    }
  }
  for (const [id, next] of Object.entries(incoming)) {
    if (removedProducts.has(id)) continue
    const previous = current.productBases[id]
    productBases[id] = previous && previous.lifecycle.view_revision > next.lifecycle.view_revision ? previous : next
  }
  return {
    productBases, dirtyProducts, removedProducts,
    productDrafts: visibleProducts(productBases, dirtyProducts, previous),
  }
}

export function patchListingWorkbench(
  patch:
    | Partial<ListingWorkbenchRuntime>
    | ((current: ListingWorkbenchRuntime) => Partial<ListingWorkbenchRuntime>),
  scope = listingWorkbenchScope(),
): ListingWorkbenchRuntime {
  useListingWorkbenchStore.setState((current) => {
    if (current.scope !== scope) return current
    const next = typeof patch === "function" ? patch(current) : patch
    const pendingRemovalIds = next.pendingRemovalIds ?? current.pendingRemovalIds
    return { ...next, ...(next.productDrafts ? mergeProducts(current, next.productDrafts) : {}),
      ...(next.rows?.some((row) => pendingRemovalIds.has(row.draftId))
        ? { rows: next.rows.filter((row) => !pendingRemovalIds.has(row.draftId)) } : {}) }
  })
  return useListingWorkbenchStore.getState()
}

export function projectListingRows(
  project: (current: ListingRow[]) => ListingRow[],
  scope = listingWorkbenchScope(),
): ListingRow[] {
  return patchListingWorkbench((current) => ({
    rows: project(current.rows).filter((row) => !current.removedProducts.has(row.draftId)),
  }), scope).rows
}

export function projectListingProducts(
  project: (current: Record<string, WorkflowDraftView>) => Record<string, WorkflowDraftView>,
  scope = listingWorkbenchScope(),
): Record<string, WorkflowDraftView> {
  return patchListingWorkbench((current) => ({ productDrafts: project(current.productBases) }), scope).productDrafts
}

/** Capture the operator's original field values before any server response can arrive. */
export function editListingProduct(draftId: string, view: WorkflowDraftView): ProductEdit | undefined {
  const current = peekListingWorkbench()
  const base = current.productBases[draftId]
  if (!base) return undefined
  const pending = current.dirtyProducts[draftId]
  const edit = {
    id: ++editSequence,
    base: pending ? { ...base, ...productEditBaseline(pending.base, pending.view, base, pending.base, pending.fields) } : base,
    view,
    fields: changedProductFields(base, view, pending?.fields),
  }
  const dirtyProducts = { ...current.dirtyProducts, [draftId]: edit }
  useListingWorkbenchStore.setState({
    dirtyProducts,
    productDrafts: visibleProducts(current.productBases, dirtyProducts, current),
  })
  return edit
}

/** Rebase only after the operator explicitly chose to keep their conflicting edits. */
export function confirmListingProductEdit(edit: ProductEdit, scope: number): ProductEdit | undefined {
  const current = peekListingWorkbench()
  const id = edit.view.draft_id
  if (current.scope !== scope || current.dirtyProducts[id]?.id !== edit.id || !current.productBases[id]) return undefined
  const base = current.productBases[id]
  const view = current.productDrafts[id]!
  const confirmed = { id: ++editSequence, base, view, fields: changedProductFields(base, view) }
  useListingWorkbenchStore.setState({ dirtyProducts: { ...current.dirtyProducts, [id]: confirmed } })
  return confirmed
}

/** A response acknowledges only that save request; later keystrokes remain an overlay. */
export function settleListingProductEdit(
  edit: ProductEdit,
  saved: WorkflowDraftView,
  scope: number,
  readiness?: WorkflowReadinessReport,
  requestMediaEpoch?: number,
): void {
  const current = peekListingWorkbench()
  const id = saved.draft_id
  if (current.scope !== scope || !current.productBases[id] || current.removedProducts.has(id)) return
  // A response issued before an applied card-level invalidation is
  // dropped — the template change does not bump row view_revision, so view_revision cannot detect this staleness. The edit
  // stays dirty and flushes again; the invalidation's refetch owns the
  // authoritative baseline.
  if (requestMediaEpoch !== undefined && requestMediaEpoch < current.mediaEpoch) return
  const dirtyProducts = { ...current.dirtyProducts }
  const pending = dirtyProducts[id]
  if (pending?.id === edit.id) delete dirtyProducts[id]
  else if (pending) {
    const base = { ...pending.base, ...productEditBaseline(edit.base, edit.view, pending.base, saved, edit.fields) }
    dirtyProducts[id] = {
      ...pending,
      base,
      fields: changedProductFields(base, pending.view),
    }
  }
  const merged = mergeProducts({ ...current, dirtyProducts }, { ...current.productBases, [id]: saved }, current)
  useListingWorkbenchStore.setState({
    ...merged,
    rows: current.rows.map((row) => row.draftId === id
      ? projectListingRowLifecycle(row, merged.productBases[id]!.lifecycle, saved.lifecycle.view_revision >= current.productBases[id]!.lifecycle.view_revision ? readiness : undefined)
      : row),
  })
}

/** Snapshot membership and streamed rows share the HTTP edit-overlay owner. */
export function receiveListingProducts(
  incoming: Array<{ product: WorkflowDraftView; readiness: WorkflowReadinessReport }>,
  removed: ReadonlySet<string>,
  scope: number,
): void {
  useListingWorkbenchStore.setState((current) => {
    if (current.scope !== scope) return current
    const products = { ...current.productBases }
    const removedProducts = new Set([...current.removedProducts, ...removed])
    for (const id of removed) delete products[id]
    for (const { product } of incoming) if (!removedProducts.has(product.draft_id)) products[product.draft_id] = product
    const merged = mergeProducts({ ...current, removedProducts }, products)
    const rows = new Map(current.rows.filter((row) => !removedProducts.has(row.draftId)).map((row) => [row.draftId, row]))
    // Membership (add/remove) or queue_position changes force a re-sort; pure
    // content updates keep the existing array order and unchanged references.
    let orderChanged = rows.size !== current.rows.length
    let rowsChanged = orderChanged
    for (const { product, readiness } of incoming) {
      const base = merged.productBases[product.draft_id]
      if (!base || current.pendingRemovalIds.has(product.draft_id) || base.lifecycle.view_revision > product.lifecycle.view_revision) continue
      const previous = rows.get(product.draft_id)
      if (previous) {
        const previousPosition = current.productBases[product.draft_id]?.lifecycle.queue_position ?? Number.MAX_SAFE_INTEGER
        if ((base.lifecycle.queue_position ?? Number.MAX_SAFE_INTEGER) !== previousPosition) orderChanged = true
        rows.set(product.draft_id, projectListingRowLifecycle(previous, base.lifecycle, readiness, base.source_layers))
      } else {
        orderChanged = true
        rows.set(product.draft_id, projectListingRowLifecycle({
          id: product.draft_id, draftId: product.draft_id,
          imageName: base.lifecycle.source_file_name ?? "", status: "pending",
          ai: "idle", render: "idle", upload: "idle", log: "正在恢复源图…",
        }, base.lifecycle, readiness))
      }
      rowsChanged = true
    }
    const nextRows = !rowsChanged ? current.rows
      : !orderChanged ? current.rows.map((row) => rows.get(row.draftId)!)
      : [...rows.values()].sort((a, b) =>
        (merged.productBases[a.draftId]?.lifecycle.queue_position ?? Number.MAX_SAFE_INTEGER) -
        (merged.productBases[b.draftId]?.lifecycle.queue_position ?? Number.MAX_SAFE_INTEGER))
    const liveIds = new Set(nextRows.map((row) => row.id))
    return {
      ...merged,
      rows: nextRows,
      selectedIds: current.selectedIds.every((id) => liveIds.has(id))
        ? current.selectedIds
        : current.selectedIds.filter((id) => liveIds.has(id)),
    }
  })
}

export function projectListingSelection(
  project: (current: Set<string>) => Set<string>,
): Set<string> {
  const next = project(new Set(useListingWorkbenchStore.getState().selectedIds))
  useListingWorkbenchStore.setState({ selectedIds: [...next] })
  return next
}

export { useListingWorkbenchStore }

export function useWorkflowProgress(): WorkflowTaskProgressView | null {
  return useStoreWithEqualityFn(
    useListingWorkbenchStore,
    (state) => {
      return workflowTaskProgressView({
        cardName: state.cardName,
        frozenDraftIds: state.queueFrozenIds,
        paused: state.queuePaused,
        running: state.queueRunning,
        rows: state.rows,
      })
    },
    sameWorkflowTaskProgress,
  )
}

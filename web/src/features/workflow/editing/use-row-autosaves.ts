import { useRef } from "react"
import type {
  CategorySchemaView,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowDraftView,
  WorkflowProductSaveResult,
} from "@/bindings/commands"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { errorMessage } from "@/lib/error-message"
import { persistRowEdit } from "../batch-actions"
import { DurableAutosave } from "./durable-autosave"
import type { WorkbenchEditableColumn } from "../workbench/workbench-cell-editor"
import { lifecycleSealed } from "../model/listing-row-lifecycle"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  editListingProduct,
  confirmListingProductEdit,
  listingWorkbenchScope,
  listingScopeCurrent,
  settleListingProductEdit,
  type ProductEdit,
} from "../workbench/listing-workbench-store"
import { refreshProductStatus } from "../workbench/product-status"
import { AUTOSAVE_DEBOUNCE_MS } from "./use-card-autosave"
import {
  formatTagString,
  parseTagString,
} from "../workbench/workbench-cell-edit"
import {
  DESCRIPTION_ATTRIBUTE_ID,
  MODEL_NAME_ATTRIBUTE_ID,
  RICH_CONTENT_ATTRIBUTE_ID,
  SEARCH_TAGS_ATTRIBUTE_ID,
  fieldByAttributeId,
  fieldLocation,
} from "../workflow-shared"
import { mergeProductEdit } from "../model/product-edit"

/**
 * The attribute every editor column writes, minus 名称 (which is a fixed key).
 * Typed as a complete record, so another column cannot silently inherit the
 * previous one's attribute id.
 */
const PROSE_COLUMN_ATTRIBUTE_ID: Record<
  Exclude<WorkbenchEditableColumn, "name">,
  number
> = {
  description: DESCRIPTION_ATTRIBUTE_ID,
  tags: SEARCH_TAGS_ATTRIBUTE_ID,
  rich_content: RICH_CONTENT_ATTRIBUTE_ID,
  model: MODEL_NAME_ATTRIBUTE_ID,
}
import {
  textValue,
  readWorkflowValue,
  writeWorkflowValue,
  type WorkflowValueLocation,
} from "../workflow-draft"

type RowSaveResult = WorkflowProductSaveResult & { edit: ProductEdit; mediaEpoch: number }

/**
 * The local half of `record_manual_changes` (`listing_api/rows.rs`): a plain
 * field whose value actually changed is hand-edited the moment it is typed —
 * the cell must show the typed echo now, not wait for the PATCH to answer with
 * the recomputed `handEditedKeys`. Complex-item edits stay unmarked, matching
 * the server boundary.
 */
function withHandEditedKey(
  product: WorkflowDraftView,
  draft: WorkflowCategoryDraft,
  fieldKey: string,
  value: WorkflowDraftValue | undefined,
  location: WorkflowValueLocation,
): WorkflowDraftView {
  if (location.complexId !== undefined) return { ...product, draft }
  const before = readWorkflowValue(product.draft, fieldKey)
  const changed =
    JSON.stringify(before ?? null) !== JSON.stringify(value ?? null)
  const keys = product.hand_edited_keys ?? []
  return {
    ...product,
    draft,
    hand_edited_keys:
      changed && !keys.includes(fieldKey)
        ? [...keys, fieldKey]
        : product.hand_edited_keys,
  }
}

/**
 * One flush in flight per `DurableAutosave`. Callers that arrive while a row's
 * flush is queued or running share the same promise instead of burning another
 * global slot behind it. `settled` stays false until the ticket is resolved, so
 * a caller resuming in the microtask between `resolve()` and the map cleanup
 * starts a fresh ticket rather than joining an already-resolved one.
 */
type FlushTicket = {
  promise: Promise<boolean>
  resolve: (ok: boolean) => void
  settled: boolean
}

/**
 * Drain one row until it is quiescent. `DurableAutosave.flush()` re-reads the
 * latest payload when its serialized turn runs, so the loop closes the window
 * where a flush returned true for the revision it wrote while a newer
 * `markDirty` landed behind it: a shared true means the newest edit persisted.
 */
async function drainFlushTicket(
  autosave: DurableAutosave<ProductEdit, RowSaveResult>,
): Promise<boolean> {
  for (;;) {
    if (!(await autosave.flush())) return false
    if (!autosave.hasPendingChanges()) return true
  }
}

/** The existing Retry action resolves conflicts only after an explicit operator choice. */
export async function prepareRowSaveRetry(
  draftId: string,
  confirm: (message: string) => boolean | Promise<boolean> = (message) =>
    window.confirm(`${message}\n\n确定：保留我的修改并保存。\n取消：保留输入，暂不保存。`),
): Promise<ProductEdit | undefined> {
  const scope = listingWorkbenchScope()
  const cached = peekListingWorkbench()
  // No local edit on a known Product Instance means nothing to retry: answer
  // before any Cloud read. A real edit still re-reads below for the CAS base.
  if (!cached.dirtyProducts[draftId] || !cached.productBases[draftId]) return undefined
  const row = cached.rows.find((candidate) => candidate.draftId === draftId)
  if (row) await refreshProductStatus(row, undefined, scope)
  const current = peekListingWorkbench()
  const edit = current.dirtyProducts[draftId]
  const base = current.productBases[draftId]
  if (current.scope !== scope || !edit || !base) return undefined
  try {
    mergeProductEdit(edit.base, edit.view, base, true, edit.fields)
    return edit
  } catch (reason) {
    if (!(await confirm(errorMessage(reason, "字段存在编辑冲突")))) return undefined
    return confirmListingProductEdit(edit, scope)
  }
}

/**
 * Row edits flushed to Cloud at once. Each flush is one PATCH under the Workspace's
 * regular-write budget (`WORKSPACE_REGULAR_WRITE_BUDGET`, seven); three leave room
 * for the preparation executor's own writes running beside a flush. Every entry
 * point — debounce, manual retry, pre-send drain and teardown — goes through the
 * same bounded queue, so the cap is a real cap.
 */
const AUTOSAVE_FLUSH_CONCURRENCY = 3

/**
 * One durable autosave per Product Instance. The card template has its own in
 * `useCardAutosave`; a row must not be able to mark another row's edit as
 * saved, and the revision counters inside `DurableAutosave` keep that honest.
 */
export function useRowAutosaves({
  schema,
  confirm,
}: {
  schema: CategorySchemaView | undefined
  /** Conflict prompt; the screen hosts a real dialog so this stays off `window.confirm`. */
  confirm?: (message: string) => boolean | Promise<boolean>
}) {
  const autosavesRef = useRef(
    new Map<string, DurableAutosave<ProductEdit, RowSaveResult>>(),
  )
  const timersRef = useRef(new Map<string, number>())
  const flushTicketsRef = useRef(
    new Map<DurableAutosave<ProductEdit, RowSaveResult>, FlushTicket>(),
  )
  const flushQueueRef = useRef<
    Array<{
      autosave: DurableAutosave<ProductEdit, RowSaveResult>
      ticket: FlushTicket
    }>
  >([])
  const flushRunningRef = useRef(0)

  function pumpFlushQueue() {
    while (
      flushRunningRef.current < AUTOSAVE_FLUSH_CONCURRENCY &&
      flushQueueRef.current.length
    ) {
      const next = flushQueueRef.current.shift()!
      flushRunningRef.current += 1
      void drainFlushTicket(next.autosave)
        .then(
          (ok) => {
            next.ticket.settled = true
            next.ticket.resolve(ok)
          },
          () => {
            next.ticket.settled = true
            next.ticket.resolve(false)
          },
        )
        .finally(() => {
          if (flushTicketsRef.current.get(next.autosave) === next.ticket) {
            flushTicketsRef.current.delete(next.autosave)
          }
          flushRunningRef.current -= 1
          pumpFlushQueue()
        })
    }
  }

  /**
   * Every flush shares the write budget; the drain reads `latest` at run time.
   * One ticket per row: while it is queued or running another caller joins its
   * promise instead of spending a second slot behind the same serialized write.
   */
  function scheduleFlush(
    autosave: DurableAutosave<ProductEdit, RowSaveResult>,
  ): Promise<boolean> {
    const existing = flushTicketsRef.current.get(autosave)
    if (existing && !existing.settled) return existing.promise
    let resolve!: (ok: boolean) => void
    const promise = new Promise<boolean>((resolver) => {
      resolve = resolver
    })
    const ticket: FlushTicket = { promise, resolve, settled: false }
    flushTicketsRef.current.set(autosave, ticket)
    flushQueueRef.current.push({ autosave, ticket })
    pumpFlushQueue()
    return ticket.promise
  }

  /** One serialised durable writer per Product Instance; see `persistRowEdit`. */
  function rowAutosave(draftId: string) {
    const existing = autosavesRef.current.get(draftId)
    if (existing) return existing
    const scope = listingWorkbenchScope()
    const autosave = new DurableAutosave<ProductEdit, RowSaveResult>(
      async (edit) => {
        // A queued save keeps its immutable edit and the scope it was created
        // under: a teardown drain must still fire after the scope bump, so a
        // stale scope cannot refuse admission. The server-side revision CAS and
        // row existence are the durable guards; UI writeback below stays
        // scope-guarded. While the scope is live, a missing row still refuses.
        if (listingScopeCurrent(scope) && !peekListingWorkbench().productBases[draftId]) {
          throw new Error("商品已移除")
        }
        // Captured before the request is issued: if a
        // card-level invalidation is applied while the save is in flight, the
        // response predates it and settle drops it.
        const mediaEpoch = peekListingWorkbench().mediaEpoch
        try {
          // The flush rides the stream-fed workbench view: the durable
          // autosave owes no pre-PATCH GET. The server CAS
          // plus the single conflict retry stay the truth anchors.
          const known = peekListingWorkbench().productBases[edit.view.draft_id]
          return { ...(await persistRowEdit(edit.view, edit.base, edit.fields, known)), edit, mediaEpoch }
        } catch (reason) {
          if (listingScopeCurrent(scope)) {
            const row = peekListingWorkbench().rows.find((candidate) => candidate.draftId === draftId)
            if (row) await refreshProductStatus(row)
            notifyCommandError(reason, "商品字段未能保存，输入已保留，请核对后重试。")
          }
          throw reason
        }
      },
      (result) => {
        const { saved, status, edit } = result
        settleListingProductEdit(edit, saved, scope, status.readiness, result.mediaEpoch)
        autosave.rebaseLatest((latest) => peekListingWorkbench().dirtyProducts[draftId] ?? latest)
      },
      (phase) => {
        if (!listingScopeCurrent(scope) || !peekListingWorkbench().productBases[draftId]) return
        patchListingWorkbench((current) => ({
          rowSaveStates: { ...current.rowSaveStates, [draftId]: phase },
        }), scope)
      },
    )
    autosavesRef.current.set(draftId, autosave)
    return autosave
  }

  /** Echo the keystroke immediately; the durable write follows on the debounce. */
  function editRowCell(
    draftId: string,
    column: WorkbenchEditableColumn,
    value: string,
  ) {
    const product = peekListingWorkbench().productDrafts[draftId]
    if (!product || !schema) return
    if (lifecycleSealed(product.lifecycle)) {
      notifyError("该商品已有 Ozon 终局回执，字段不可再修改。")
      return
    }
    // Prose columns address their field by attribute id: a live Schema calls
    // 简介 `attribute_4191` and a local fixture calls it `description`.
    const field =
      column === "name"
        ? schema.fields.find((candidate) => candidate.key === "name")
        : fieldByAttributeId(schema, PROSE_COLUMN_ATTRIBUTE_ID[column])
    if (!field) return
    const location = column === "name" ? {} : fieldLocation(field)
    const fieldValue =
      column === "tags" ? formatTagString(parseTagString(value)) : value
    const draftValue =
      column === "tags"
        ? textValue(field, fieldValue)
        : fieldValue
          ? textValue(field, fieldValue)
          : undefined
    queueRowEdit(
      draftId,
      withHandEditedKey(
        product,
        writeWorkflowValue(product.draft, field.key, draftValue, location),
        field.key,
        draftValue,
        location,
      ),
    )
  }

  /**
   * The dictionary half of the same write: a picked 主题 value already IS the draft
   * value (dictionary id plus label), so this path stores it as it stands instead of
   * building a text value first. Same row closure, debounce and CAS as a keystroke.
   */
  function editRowField(
    draftId: string,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) {
    const product = peekListingWorkbench().productDrafts[draftId]
    if (!product || !schema) return
    if (lifecycleSealed(product.lifecycle)) {
      notifyError("该商品已有 Ozon 终局回执，字段不可再修改。")
      return
    }
    queueRowEdit(
      draftId,
      withHandEditedKey(
        product,
        writeWorkflowValue(product.draft, fieldKey, value, location),
        fieldKey,
        value,
        location,
      ),
    )
  }

  /** Mark one row dirty and arm its debounce — both editors end here. */
  function queueRowEdit(draftId: string, next: WorkflowDraftView) {
    const edit = editListingProduct(draftId, next)
    if (!edit) return
    rowAutosave(draftId).markDirty(edit)
    window.clearTimeout(timersRef.current.get(draftId))
    timersRef.current.set(
      draftId,
      window.setTimeout(() => {
        timersRef.current.delete(draftId)
        void scheduleFlush(rowAutosave(draftId))
      }, AUTOSAVE_DEBOUNCE_MS),
    )
  }
  async function retryRowSave(draftId: string) {
    window.clearTimeout(timersRef.current.get(draftId))
    timersRef.current.delete(draftId)
    const edit = await prepareRowSaveRetry(draftId, confirm)
    if (!edit) return
    rowAutosave(draftId).markDirty(edit)
    void scheduleFlush(rowAutosave(draftId))
  }

  /**
   * Teardown path: every pending row write is queued under the shared budget
   * before the host bumps the workbench scope. Each queued drain holds its
   * immutable edit and original scope, so the PATCH still leaves after the
   * bump; writeback stays fenced by the scope checks in the callbacks.
   * Nothing is awaited; the caller is unmounting and only needs the writes fired.
   */
  function flushRowAutosavesNow() {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer)
    }
    timersRef.current.clear()
    for (const autosave of autosavesRef.current.values()) {
      void scheduleFlush(autosave)
    }
  }

  /** Drain every pending row edit; false when any row is still unsaved. */
  async function flushRowAutosaves(): Promise<boolean> {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer)
    }
    timersRef.current.clear()
    const results = await Promise.all(
      [...autosavesRef.current.values()].map((autosave) => scheduleFlush(autosave)),
    )
    return results.every(Boolean)
  }

  /** Drain just these Product Instances; false when any stayed unsaved. */
  async function flushRowsFor(draftIds: readonly string[]): Promise<boolean> {
    for (const draftId of draftIds) {
      window.clearTimeout(timersRef.current.get(draftId))
      timersRef.current.delete(draftId)
    }
    const flushed = await Promise.all(
      draftIds.map(
        (draftId) =>
          autosavesRef.current.get(draftId)
            ? scheduleFlush(autosavesRef.current.get(draftId)!)
            : Promise.resolve(true),
      ),
    )
    return flushed.every(Boolean)
  }

  function pendingRowEdits(): boolean {
    return [...autosavesRef.current.values()].some((autosave) =>
      autosave.hasPendingChanges(),
    )
  }

  function forgetRows(draftIds: Iterable<string>) {
    for (const draftId of draftIds) {
      window.clearTimeout(timersRef.current.get(draftId))
      timersRef.current.delete(draftId)
      const autosave = autosavesRef.current.get(draftId)
      autosave?.dispose()
      // A queued ticket still resolves when its drain runs; dropping the map
      // entry only stops a later caller from joining a row that is gone.
      if (autosave) flushTicketsRef.current.delete(autosave)
      autosavesRef.current.delete(draftId)
    }
  }

  // Row autosaves are per Product Instance; a different card has different
  // instances, so their revision counters must not carry over.
  function resetRowAutosaves() {
    for (const timer of timersRef.current.values()) {
      window.clearTimeout(timer)
    }
    timersRef.current.clear()
    for (const autosave of autosavesRef.current.values()) {
      autosave.dispose()
      flushTicketsRef.current.delete(autosave)
    }
    autosavesRef.current.clear()
  }

  return {
    editRowCell,
    editRowField,
    retryRowSave,
    flushRowAutosavesNow,
    flushRowAutosaves,
    flushRowsFor,
    pendingRowEdits,
    forgetRows,
    resetRowAutosaves,
  }
}

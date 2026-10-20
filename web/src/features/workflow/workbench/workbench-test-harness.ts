/**
 * Mock harness for the workbench tests: the stubbed Cloud fetch boundary, the
 * batch-verb row deps `workflow-screen.tsx` wires in, markup probes and the
 * inert FieldWorkbench callbacks. Every network call here is a local stub.
 */
import assert from "node:assert/strict"
import type { WorkflowDraftView } from "@/bindings/commands"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import type { BatchRowDeps } from "../batch-actions"
import type { ListingRow } from "../model/listing-row"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import {
  NO_GUIDED_PREPARATION,
  NO_PREPARATION_ACTIVITY,
  NO_PREPARATION_PROGRESS,
} from "../prepare/preparation-tracks"
import { workflowActions } from "../workflow-actions"
import { productWithStatus } from "./product-status"

type FetchCall = { url: string, method: string, body: any }

/**
 * The Cloud half of the workbench. The verbs and the row reads are HTTP, so a
 * test stubs the route.
 */
export function installFetch(reply: (call: FetchCall) => unknown): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: FetchCall = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return new Response(JSON.stringify({ data: reply(call) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return calls
}

/** One `ListingRowView` in the four-column shape `row-state.ts` reads. */
export function cloudRow(id: string, overrides: Partial<import("@/bindings/listing-projection").ListingRowView> = {}): import("@/bindings/listing-projection").ListingRowView {
  return {
    id,
    card_id: "card-1",
    store_id: "store-1",
    revision: 3,
  view_revision: 1,
  projection: listingProjection(),
    content_state: "ready",
    media_state: "ready",
    validation_state: "passed",
    submission_state: "none",
    draft: { values: {}, complex_values: [] },
    validation_issues: [],
    media: { images: [], videos: [] },
    ai: { candidates: [] },
    source: { assetId: "", sha256: "sha-1", fileName: "image-1.jpg" },
    payload: {},
    updated_at_ms: 0,
    build: { state: "stale", sources: [] },
    ...overrides,
  }
}

export function routes(calls: FetchCall[]): string[] {
  return calls.map((call) => `${call.method} ${call.url}`)
}

/**
 * One button's markup, found by its accessible name. `disabled` is a per-button
 * fact, and asserting it against the whole document would pass on any other
 * disabled button in the toolbar.
 */
export function buttonMarkup(html: string, ariaLabel: string): string {
  const start = html.indexOf(`aria-label="${ariaLabel}"`)
  assert.notEqual(start, -1, `no control is named ${ariaLabel}`)
  const open = html.lastIndexOf("<button", start)
  const close = html.indexOf("</button>", start)
  assert.ok(open !== -1 && close !== -1, `${ariaLabel} is not a button`)
  return html.slice(open, close)
}

/**
 * One field's markup, cut off at the next field wrapper. `disabled` on the whole
 * form would pass on any other locked field in the panel.
 */
export function fieldMarkup(html: string, fieldKey: string): string {
  const start = html.indexOf(`data-field-key="${fieldKey}"`)
  assert.notEqual(start, -1, `no field named ${fieldKey}`)
  const next = html.indexOf("data-field-key=", start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

/**
 * The renderer half of a batch verb, mirroring what `workflow-screen.tsx` wires
 * in: rows are patched in place and every step ends by re-reading the
 * ListingRowView rather than by projecting what the renderer believes it just did.
 */
export function harness(rows: ListingRow[], drafts: Record<string, WorkflowDraftView>) {
  let current = rows
  const products: Record<string, WorkflowDraftView | undefined> = { ...drafts }
  const deps: BatchRowDeps = {
    drafts: () => products,
    patchRow: (rowId, patch) => {
      current = current.map((candidate) =>
        candidate.id === rowId ? { ...candidate, ...patch } : candidate,
      )
    },
    startRows: (rowIds, patch) => {
      const targeted = new Set(rowIds)
      current = current.map((candidate) =>
        targeted.has(candidate.id) ? { ...candidate, ...patch } : candidate,
      )
    },
    settleProgress: () => undefined,
    commitProduct: (draftId, status) => {
      const stored = products[draftId]
      if (stored) products[draftId] = productWithStatus(stored, status)
    },
    settleRow: async (target, log, failed) => {
      const status = await workflowActions
        .workflowGetProductStatus(target.draftId)
        .catch(() => undefined)
      if (!status) {
        deps.patchRow(target.id, failed ? { status: "failed", log } : { log })
        return
      }
      const stored = products[target.draftId]
      if (stored) products[target.draftId] = { ...stored, lifecycle: status.lifecycle }
      current = current.map((candidate) =>
        candidate.id === target.id
          ? {
              ...projectListingRowLifecycle(candidate, status.lifecycle, status.readiness),
              log,
            }
          : candidate,
      )
    },
  }
  return {
    deps,
    products,
    row: (id: string) => current.find((candidate) => candidate.id === id)!,
  }
}

export const workbenchProps = {
  rowSaveStates: {},
  cardDraft: { values: {}, complex_values: [] },
  cardIssues: [],
  cardFieldOrigins: [],
  targetStoreId: "store-1",
  busy: false,
  activity: NO_PREPARATION_ACTIVITY,
  preparationProgress: NO_PREPARATION_PROGRESS,
  guidedPreparation: NO_GUIDED_PREPARATION,
  queuePaused: false,
  queueRunning: false,
  queueStopRequested: false,
  storeConfigured: true,
  storeLabel: "测试店铺",
  dragging: false,
  onSelectionChange: () => undefined,
  onImportImages: () => undefined,
  onClearRows: () => undefined,
  onRemoveRows: () => undefined,
  onEditCell: () => undefined,
  onEditField: () => undefined,
  onRetryRowSave: () => undefined,
  onFlushRows: async () => true,
  onRunAiRows: () => undefined,
  onRunRenderRows: () => undefined,
  onRunDeliverRows: () => undefined,
  onPrepareRows: () => undefined,
  onStopPreparation: () => undefined,
  onSendRows: () => undefined,
  onUpdateCardDefault: () => undefined,
  onCancelRowIntent: () => undefined,
  onPauseQueue: () => undefined,
  onCancelQueue: () => undefined,
  onResumeQueue: () => undefined,
}

// Local, browser-owned listing rows. See
// specs/browser-owned-listing/slices/09-row-store.md.
//
// `row` and `verdict` are intentionally `unknown`: they hold JSON produced by
// the listing-core WASM field-rules kernel (`web/src/listing-core/`). Every
// file in this module treats them as opaque
// blobs — store and return them verbatim, never parse or validate their
// shape. That shape belongs to `rust/crates/listing-core` alone.

export type LocalRow = {
  v: 1
  /** crypto.randomUUID(); also the Intent's listing_row_id and the row half of the OCR key. */
  id: string
  workspaceUuid: string
  cardId: string
  /** Import order = queue order. */
  position: number
  /** Result of store-quota sharding (existing store-quota.ts). */
  storeId?: string
  createdAtMs: number
  updatedAtMs: number
  /** Bumped on every write; async results carry the rev they started with and are discarded on mismatch (I6). */
  rev: number
  /** Opaque LeanRow JSON — see module header. */
  row: unknown
  /** Opaque listing-core Verdict JSON — see module header. */
  verdict?: unknown
  diagnostic?: import("../model/publish-diagnostic").PublishDiagnosticReference & { revision: number }
  ocr?: {
    attempt: number
    state: "pending" | "settled" | "failed" | "paused_unbilled" | "paused_busy"
    pendingKey?: string
    requestId?: string
    promptSha256?: string
    error?: { code: string; message: string }
  }
  // Image object keys live inside `row` (LeanRow's media); batch time is
  // parsed from the key, not stored separately here.
  media?: {
    state: "idle" | "rendering" | "uploading" | "ready" | "failed"
    error?: { code: string; message: string }
  }
  submission?: {
    platform?: string
    logicalBlockId?: string
    sendActionId?: string
    offerId?: string
    state: "queued" | "submitting" | "unconfirmed" | "accepted" | "rejected" | "unknown" | "cancelled"
    storeId: string
    serverRevision?: number
    intentId?: string
    clientOperationId?: string
    digest?: string
    taskId?: number
    receipt?: unknown
  }
}

/** Card-level local state (send queue etc.). Written by slice 16. */
export type CardLocalState = {
  workspaceUuid: string
  cardId: string
  publish?: PublishQueueState
  queue: {
    frozenRowIds: string[]
    nextPosition: number
    paused: boolean
    stopAfterCurrent: boolean
    haltReason?: string
  }
}

/**
 * Distinguishable failure for an IndexedDB write rejected by the browser's
 * storage quota. Per I4 (paid OCR results and submission receipts must reach
 * IndexedDB before the UI reports them done), a full quota must never be
 * swallowed into a generic error or a silent drop of the in-memory rows —
 * callers can match on `code` without depending on `instanceof` across
 * module boundaries. A later slice's UI catches this and calls the existing
 * `notifyError` pattern; this module only needs to surface it undamaged.
 */
export class LocalStorageFullError extends Error {
  readonly code = "local_storage_full" as const
  constructor(cause?: unknown) {
    super("IndexedDB write rejected: storage quota exceeded")
    this.name = "LocalStorageFullError"
    this.cause = cause
  }
}

/** Durable S16 facts; payloads remain exclusively on LocalRow, never a platform/payload table. */
export type PublishBudget = { submits: number; schema: number; media: number }
export type PublishHaltReason = {
  code: "store_unavailable" | "submit_capacity_full" | "offer_busy" | "store_busy"
  cause: "request_refusal" | "retries_exhausted" | "deadline_exhausted"
  at: number
}
export type PublishBlock = {
  id: string
  platform: string
  destination: string
  rowIds: string[]
  remainingRowIds: string[]
  budget: PublishBudget
  state: "pending" | "sending" | "settled" | "halted"
  /** Only an explicit eligible retry of this parent clears a request-level halt. */
  haltReason?: PublishHaltReason
  /** A reserved busy retry survives Stop/refresh without refunding its credit or wait. */
  busyRetryAt?: number
}
export type PublishOfferLock = {
  platform: string
  destination: string
  offerId: string
  rowId: string
  intentId?: string
  serverOperationId?: string
  state: "pending" | "unknown" | "accepted"
}
export type PublishQueueState = {
  actionId: string
  phase: "running" | "stopping" | "paused" | "complete"
  blocks: PublishBlock[]
  busy: Record<string, { attempts: number; startedAt: number }>
  locks: PublishOfferLock[]
  /** In-flight receipt survives row deletion/revision changes without being applied to the new row. */
  evidence: Array<{ blockId: string; rowId: string; intentId?: string; serverOperationId?: string; state: string }>
}

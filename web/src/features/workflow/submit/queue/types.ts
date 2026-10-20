import type { PlatformIssue } from "../../platforms/core"
import type { CardRows } from "../../rows/card-rows"
import type { LocalRow, PublishHaltReason, PublishOfferLock, PublishQueueState } from "../../rows/types"
import type { PublishDiagnosticDispatch, PublishDiagnosticReference } from "../../model/publish-diagnostic"

export type PreparedRow = {
  rowId: string
  revision: number
  offerId: string
  digest: string
  previewOperationId: string
  /** Native-produced transport item; never persisted separately from LocalRow. */
  body: unknown
}
export type SendFact = {
  state: "accepted" | "pending" | "rejected" | "unknown"
  intentId?: string
  serverOperationId?: string
  serverRevision?: number
  taskId?: number
  code?: string
  canResume?: boolean
  receipt?: unknown
  issues?: readonly PlatformIssue[]
  /** A request refusal proves only this attempt, not any older Intent. */
  admission?: "store_busy" | "store_unavailable" | "submit_capacity_full" | "offer_busy"
  diagnostic?: PublishDiagnosticReference
  /** The operation boundary already classified this fact, including known user issues. */
  diagnosticClassified?: true
}
export type ReconcileSelection = { platform: string; destination: string } & (
  { rowIds: readonly string[]; blockId?: never } | { blockId: string; rowIds?: never }
)
/** Captured local pins, never a preview identity or an API DTO. */
export type ReconcilePin = Readonly<{ rowId: string; revision: number; identity?: Readonly<{
  intentId: string; serverOperationId: string; serverRevision: number
}> }>
export type ReconcileCandidate = {
  rowId: string; intentId: string; serverOperationId: string; serverRevision: number
  state: SendFact["state"]; taskId?: number; code?: string
}
export type ReconcileRead = { complete: boolean; rows: readonly {
  rowId: string; candidates: readonly ReconcileCandidate[]
  fact?: Pick<SendFact, "state" | "intentId" | "serverOperationId" | "serverRevision" | "taskId" | "code" | "canResume">
}[] }
export type ReconcileResult = ReconcileRead & {
  status: "read" | "invalid_selection" | "mixed_identity" | "unavailable" | "stale" | "busy"
  platform: string; destination: string; rowIds: readonly string[]
  mode?: "identities" | "history"; appliedRowIds: readonly string[]
}
export type SendCapability = {
  prepare(rows: readonly LocalRow[], signal: AbortSignal): Promise<{ items: PreparedRow[]; blocked: Array<{ rowId: string; issues: readonly PlatformIssue[] }> }>
  bytes(destination: string, items: readonly PreparedRow[]): number
  send(destination: string, items: readonly PreparedRow[], request: { deadlineAt: number; diagnostics?: PublishDiagnosticDispatch }): Promise<ReadonlyMap<string, SendFact>>
  /** One explicit E read, <=100 pins. Unlinked history is manual inspection only. */
  reconcile?(destination: string, rows: readonly ReconcilePin[], signal: AbortSignal): Promise<ReconcileRead>
  releaseUnknown?(destination: string, locks: readonly PublishOfferLock[], signal: AbortSignal): Promise<{
    releasedIntentIds: readonly string[]
    complete: boolean
    unresolvedIntentIds: readonly string[]
  }>
  /** Schema refresh is explicit C, reupload is S15; both must update real CardRows. */
  repair?(kind: "schema" | "media", rows: readonly LocalRow[], signal: AbortSignal): Promise<void>
  canRepair?(kind: "schema" | "media"): boolean
}
export type SendQueueOptions = {
  rows: CardRows
  workspaceUuid: string
  cardId: string
  capabilities: Readonly<Record<string, SendCapability>>
  /** Identity captured by the owner: account/workspace/card/config generation. */
  current(): boolean
  now?: () => number
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}
export type SendQueueSnapshot = {
  phase: "idle" | PublishQueueState["phase"]
  counts: Readonly<Record<SendFact["state"], number>>
  inFlight: number
  deadlines: readonly number[]
  haltedDestinations: readonly string[]
  halts: readonly { blockId: string; platform: string; destination: string; reason: PublishHaltReason }[]
}

import { listingLog, noteListingRow } from "@/lib/listing-log"
import type { LocalRow, PublishQueueState } from "../../rows/types"
import type { ReconcilePin, ReconcileResult, ReconcileSelection, SendQueueOptions } from "./types"
import { saveQueue } from "./persistence"

export function emptyReconcile(selection: ReconcileSelection, status: ReconcileResult["status"]): ReconcileResult {
  return { status, platform: selection.platform, destination: selection.destination, rowIds: [], complete: false, rows: [], appliedRowIds: [] }
}

/** No paging, no submit/release, and no inference of identity from latest history. */
export async function reconcileQueue(options: SendQueueOptions, queue: PublishQueueState, selection: ReconcileSelection, signal: AbortSignal): Promise<ReconcileResult> {
  const { platform, destination } = selection
  const result = emptyReconcile(selection, "invalid_selection")
  const validScope = () => options.current() && options.rows.writable && options.rows.error === undefined
    && !signal.aborted && queue.phase !== "stopping"
  if (!validScope()) return { ...result, status: "stale" }
  const block = selection.blockId === undefined ? undefined : queue.blocks.find((entry) => entry.id === selection.blockId
    && entry.platform === platform && entry.destination === destination)
  const ids = [...(selection.rowIds ?? block?.rowIds.filter((id) => queue.locks.some((lock) => lock.platform === platform
    && lock.destination === destination && lock.rowId === id && lock.state !== "accepted")) ?? [])]
  if (!platform.trim() || platform.trim() !== platform || !destination.trim() || destination.trim() !== destination
    || ids.length === 0 || ids.length > 100 || new Set(ids).size !== ids.length
    || ids.some((id) => !id.trim() || id.trim() !== id || id.includes(","))) return result
  const captured = ids.map((id) => {
    const row = options.rows.get(id)
    const submission = row?.submission
    const locks = queue.locks.filter((lock) => lock.platform === platform && lock.destination === destination && lock.rowId === id && lock.state !== "accepted")
    if (!row || row.workspaceUuid !== options.workspaceUuid || row.cardId !== options.cardId || row.storeId !== destination
      || submission?.platform !== platform || submission.storeId !== destination || locks.length !== 1
      || !["unconfirmed", "unknown", "queued", "submitting"].includes(submission.state)) return undefined
    const lock = locks[0]!
    if (submission.offerId !== lock.offerId || submission.intentId !== lock.intentId || submission.clientOperationId !== lock.serverOperationId) return undefined
    const hasIdentity = !!submission.intentId && !!submission.clientOperationId && Number.isSafeInteger(submission.serverRevision) && submission.serverRevision! >= 0
    // Partial identity is not equivalent to wholly lost authority.
    if (!hasIdentity && (submission.intentId !== undefined || submission.clientOperationId !== undefined || submission.serverRevision !== undefined)) return undefined
    const pin: ReconcilePin = Object.freeze({ rowId: id, revision: row.rev, ...(hasIdentity ? { identity: Object.freeze({
      intentId: submission.intentId!, serverOperationId: submission.clientOperationId!, serverRevision: submission.serverRevision!,
    }) } : {}) })
    return { pin, submission: { ...submission }, lock, lockPin: { ...lock } }
  })
  if (captured.some((entry) => !entry)) return result
  const pins = Object.freeze(captured.map((entry) => entry!.pin))
  result.rowIds = Object.freeze(ids)
  // One homogeneous selection prevents silently ignoring its no-ID rows.
  if (pins.some((pin) => pin.identity) && pins.some((pin) => !pin.identity)) return { ...result, status: "mixed_identity" }
  result.mode = pins[0]!.identity ? "identities" : "history"
  const capability = options.capabilities[platform]
  if (!capability?.reconcile) return { ...result, status: "unavailable" }
  const started = performance.now()
  for (const pin of pins) {
    if (pin.identity?.intentId) noteListingRow(pin.rowId, { intentId: pin.identity.intentId })
    listingLog({ module: "verify", event: "reconcile.start", rowId: pin.rowId })
  }
  const read = await capability.reconcile(destination, pins, signal).catch((error: unknown) => {
    for (const rowId of ids) {
      listingLog({
        level: "error", module: "verify", event: "reconcile.end", rowId,
        durationMs: performance.now() - started, errorCode: "reconcile_failed",
      })
    }
    throw error
  })
  const current = (entry: NonNullable<typeof captured[number]>) => {
    const row = options.rows.get(entry.pin.rowId)
    const submission = row?.submission
    return validScope() && row?.workspaceUuid === options.workspaceUuid && row.cardId === options.cardId && row.storeId === destination
      && row.rev === entry.pin.revision && submission !== undefined
      && (Object.keys(entry.submission) as (keyof NonNullable<LocalRow["submission"]>)[]).every((key) => submission[key] === entry.submission[key])
      && queue.locks.includes(entry.lock) && (Object.keys(entry.lockPin) as (keyof typeof entry.lockPin)[]).every((key) => entry.lock[key] === entry.lockPin[key])
  }
  const appliedRowIds: string[] = []
  let stale = !validScope() || captured.some((entry) => entry && !current(entry))
  if (read.complete) for (const entry of captured) {
    if (!entry || !entry.pin.identity || !current(entry)) continue
    const matches = read.rows.filter((row) => row.rowId === entry.pin.rowId)
    const fact = matches.length === 1 ? matches[0]!.fact : undefined
    const identity = entry.pin.identity
    if (!fact || fact.intentId !== identity.intentId || fact.serverOperationId !== identity.serverOperationId || fact.serverRevision !== identity.serverRevision
      || !(fact.state === "accepted" || fact.state === "pending" || fact.state === "rejected" && fact.canResume)) continue
    // CAS first: a refused update must never mutate or release its offer lock.
    const updated = options.rows.update(entry.pin.rowId, (row) => ({ ...row, submission: { ...row.submission!,
      state: fact.state === "pending" ? "queued" : fact.state === "accepted" ? "accepted" : "rejected", taskId: fact.taskId, receipt: fact,
    } }), { expectRev: entry.pin.revision })
    if (!updated) { stale = true; continue }
    if (fact.state === "rejected") queue.locks = queue.locks.filter((lock) => lock !== entry.lock)
    else entry.lock.state = fact.state === "accepted" ? "accepted" : "pending"
    queue.evidence.push({ blockId: entry.submission.logicalBlockId!, rowId: entry.pin.rowId,
      intentId: fact.intentId, serverOperationId: fact.serverOperationId, state: fact.state })
    appliedRowIds.push(entry.pin.rowId)
  }
  if (appliedRowIds.length) {
    // Settle a resolved uncertainty at the same synchronous fence as its row facts,
    // before persistence yields. Stop during flush cannot strand an already accepted parent.
    if (validScope() && !queue.locks.some((lock) => lock.platform === platform && lock.destination === destination && lock.state !== "accepted")
      && !queue.blocks.some((entry) => entry.platform === platform && entry.destination === destination && entry.haltReason)) {
      for (const entry of queue.blocks) if (entry.platform === platform && entry.destination === destination && entry.state === "halted") {
        entry.state = entry.remainingRowIds.length ? "pending" : "settled"
      }
    }
    await saveQueue(options, queue)
  }
  const outcome = !stale && validScope() ? "read" : "stale"
  for (const rowId of ids) {
    listingLog({
      module: "verify", event: "reconcile.end", rowId,
      level: outcome === "stale" ? "warn" : "info",
      durationMs: performance.now() - started,
      fields: { outcome, applied: appliedRowIds.includes(rowId) },
    })
  }
  return { ...result, ...read, status: outcome, appliedRowIds }
}

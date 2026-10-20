/** S16: one scheduler, serial per platform/destination and two destinations globally. */
import type { PublishBlock, PublishHaltReason } from "../rows/types"
import { spendBusy, spendRepair, spendSubmit, waitForAdmission } from "./queue/budgets"
import { splitPreparedRows } from "./queue/chunks"
import { destinationKey, withDestination } from "./queue/destination"
import { saveQueue } from "./queue/persistence"
import { emptyReconcile, reconcileQueue } from "./queue/reconcile"
import { repairKind } from "./queue/repair"
import { applyFact, queueIssue, rejectLocal } from "./queue/state"
import { offerLocked, releaseOfferLock } from "./queue/unknown-locks"
import type { ReconcileResult, ReconcileSelection, SendFact, SendQueueOptions, SendQueueSnapshot } from "./queue/types"
import { createPublishDiagnosticAction } from "./queue/diagnostics"
import { diagnosticReferenceFrom } from "../model/publish-diagnostic"

export type SendSelection = { platform: string; destination: string; rowIds: readonly string[] }
export function createSendQueue(options: SendQueueOptions) {
  const now = options.now ?? Date.now
  let queue = options.rows.cardState()?.publish
  let diagnostics: ReturnType<typeof createPublishDiagnosticAction> | undefined
  // Refresh never resumes an interrupted write. Only explicit reconciliation may resolve it.
  if (queue) {
    queue.phase = "paused"
    for (const block of queue.blocks) if (block.state === "sending") block.state = "halted"
    for (const lock of queue.locks) if (lock.state === "pending") lock.state = "unknown"
  }
  let visibleEvidence = structuredClone(queue?.evidence ?? [])
  let running: Promise<void> | undefined
  let resolving = false
  let resolutionStop = new AbortController()
  let admission = new AbortController()
  const inFlight = new Map<string, number>()
  const listeners = new Set<() => void>()
  const halted = new Set<string>(queue?.blocks.filter((block) => block.state === "halted").map((block) => destinationKey(block.platform, block.destination)))
  const emit = () => { for (const listener of listeners) listener() }
  const stopped = () => admission.signal.aborted || !options.current() || !options.rows.writable || options.rows.error !== undefined
  const persist = async () => {
    if (queue) {
      const captured = structuredClone(queue.evidence)
      await saveQueue(options, queue)
      visibleEvidence = captured
    }
    emit()
  }
  const liveRows = (ids: readonly string[]) => ids.flatMap((id) => {
    const row = options.rows.get(id)
    return row && row.workspaceUuid === options.workspaceUuid && row.cardId === options.cardId ? [row] : []
  })

  async function haltAdmission(block: PublishBlock, code: PublishHaltReason["code"], cause: PublishHaltReason["cause"]) {
    block.state = "halted"
    block.haltReason = { code, cause, at: now() }
    delete block.busyRetryAt
    halted.add(destinationKey(block.platform, block.destination))
    await persist()
  }

  async function runBlock(block: PublishBlock) {
    const capability = options.capabilities[block.platform]
    const key = destinationKey(block.platform, block.destination)
    // The 30s busy window is dead if the clock fell behind its start or outran it.
    const busyExhausted = () => { const busy = queue!.busy[key]!; return now() < busy.startedAt || now() - busy.startedAt > 30_000 }
    if (!queue || stopped() || halted.has(key)) return
    if (!capability) {
      const issue = queueIssue(block.platform, "transport_unavailable", `${block.platform} 发送通道尚未开通，本次未发送`, "保留商品，待管理员开通该平台发送后重新发起")
      for (const row of liveRows(block.remainingRowIds)) rejectLocal(options, queue, block, row, issue.code, [issue])
      block.remainingRowIds = []; block.state = "settled"
      await persist(); return
    }
    let remaining = [...block.remainingRowIds]
    while (remaining.length > 0 && !stopped()) {
      if (block.busyRetryAt !== undefined) {
        if (busyExhausted()) { await haltAdmission(block, "store_busy", "deadline_exhausted"); return }
        await (options.wait ?? waitForAdmission)(Math.max(0, block.busyRetryAt - now()), admission.signal)
        if (stopped()) { block.state = "pending"; await persist(); return }
        if (now() < block.busyRetryAt || busyExhausted()) { await haltAdmission(block, "store_busy", "deadline_exhausted"); return }
      }
      const candidates = liveRows(remaining).filter((row) => row.storeId === block.destination
        && (!row.submission || row.submission.state === "rejected" && (row.submission.receipt as SendFact | undefined)?.canResume === true || row.submission.state === "cancelled"))
      if (candidates.length === 0) break
      let built: Awaited<ReturnType<typeof capability.prepare>>
      try { built = await capability.prepare(candidates, admission.signal) }
      catch (failure) {
        if (stopped()) return
        const issue = queueIssue(block.platform, "build_failed", `${block.platform} 商品内容生成失败，未发送`, "重新加载本地类目材料并校验；仍失败请联系管理员")
        const diagnostic = diagnosticReferenceFrom(failure)
        for (const row of candidates) rejectLocal(options, queue, block, row, issue.code, [issue], diagnostic)
        block.state = "halted"; halted.add(key); await persist(); return
      }
      if (stopped()) return
      const storedLocks = await options.rows.knownOfferLocks()
      if (stopped()) return
      const allLocks = [...queue.locks, ...storedLocks]
      const counts = new Map<string, number>()
      const rowCounts = new Map<string, number>()
      for (const item of built.items) counts.set(item.offerId, (counts.get(item.offerId) ?? 0) + 1)
      for (const item of [...built.items, ...built.blocked]) rowCounts.set(item.rowId, (rowCounts.get(item.rowId) ?? 0) + 1)
      const prepared = built.items.filter((item) => counts.get(item.offerId) === 1
        && rowCounts.get(item.rowId) === 1 && item.offerId.trim().length > 0
        && !offerLocked(allLocks, block.platform, block.destination, item.offerId)
        && candidates.some((row) => row.id === item.rowId && row.rev === item.revision))
      const { chunks, oversized } = splitPreparedRows(prepared, (items) => capability.bytes(block.destination, items))
      const rejected = [
        ...[...rowCounts].filter(([, count]) => count > 1).map(([rowId]) => ({ rowId, code: "item_key_duplicate", issues: [queueIssue(block.platform, "item_key_duplicate", "本次构建返回重复的商品标识，该商品未发送", "重新生成并校验商品后再发送")] })),
        ...built.blocked.map((entry) => ({ rowId: entry.rowId, code: "local_validation", issues: entry.issues })),
        ...oversized.map((rowId) => ({ rowId, code: "item_too_large", issues: undefined })),
        ...built.items.filter((item) => counts.get(item.offerId)! > 1).map((item) => ({ rowId: item.rowId, code: "offer_id_duplicate", issues: undefined })),
        ...built.items.filter((item) => !item.offerId.trim()).map((item) => ({ rowId: item.rowId, code: "offer_id_missing", issues: undefined })),
      ]
      for (const row of candidates) {
        const refusals = rejected.filter((entry) => entry.rowId === row.id)
        if (refusals.length) rejectLocal(options, queue, block, row, refusals[0]!.code, refusals.flatMap((entry) => entry.issues ?? []))
      }
      if (chunks.length === 0) break
      if (block.budget.submits === 0 && chunks.length > 1) {
        // Finalize the FIRST byte partition before any admission. Subsequent
        // repair partitions keep the already-spent parent and never enter here.
        const children = chunks.splice(1)
        const moved = new Set(children.flatMap((items) => items.map((item) => item.rowId)))
        block.rowIds = block.rowIds.filter((id) => !moved.has(id))
        remaining = remaining.filter((id) => !moved.has(id))
        block.remainingRowIds = [...remaining]
        queue.blocks.splice(queue.blocks.indexOf(block) + 1, 0, ...children.map((items): PublishBlock => ({
          id: crypto.randomUUID(), platform: block.platform, destination: block.destination,
          rowIds: items.map((item) => item.rowId), remainingRowIds: items.map((item) => item.rowId),
          budget: { submits: 0, schema: 0, media: 0 }, state: "pending",
        })))
      }
      const retry: string[] = []
      for (const chunk of chunks) {
        if (stopped() || halted.has(key)) return
        // Recheck after earlier network waits: edits/deletions must not be sent at old pins.
        const items = chunk.filter((item) => options.rows.get(item.rowId)?.rev === item.revision)
        if (items.length === 0) continue
        if (block.busyRetryAt !== undefined && busyExhausted()) { await haltAdmission(block, "store_busy", "deadline_exhausted"); return }
        const busyRetry = block.busyRetryAt !== undefined
        if (!spendSubmit(block.budget)) { block.state = "halted"; halted.add(key); await persist(); return }
        block.state = "sending"
        const pins = new Map<string, number>()
        for (const item of items) {
          const updated = options.rows.update(item.rowId, (row) => ({ ...row, submission: {
            platform: block.platform, storeId: block.destination, logicalBlockId: block.id,
            sendActionId: queue!.actionId, state: "submitting", offerId: item.offerId, digest: item.digest,
          } }), { expectRev: item.revision })
          if (!updated) throw new Error("Row changed during synchronous submit admission")
          pins.set(item.rowId, item.revision + 1)
          queue.locks.push({ platform: block.platform, destination: block.destination, offerId: item.offerId, rowId: item.rowId, state: "pending" })
        }
        await persist() // durable action, parent budget, pins and locks before the first fetch
        if (stopped()) {
          for (const item of items) applyFact(options, queue, block, item, pins.get(item.rowId)!, { state: "rejected", canResume: true, code: "stopped_before_dispatch" })
          block.state = "pending"
          await persist()
          return
        }
        if (busyRetry && busyExhausted()) {
          for (const item of items) applyFact(options, queue, block, item, pins.get(item.rowId)!, { state: "rejected", canResume: true, admission: "store_busy", code: "store_busy" })
          await haltAdmission(block, "store_busy", "deadline_exhausted"); return
        }
        const deadlineAt = now() + 150_000
        inFlight.set(block.id, deadlineAt)
        emit()
        let facts: ReadonlyMap<string, SendFact>
        // A Stop during durable preflight must retain this busy reservation and its deadline.
        delete block.busyRetryAt
        try { facts = await capability.send(block.destination, items, { deadlineAt, diagnostics: diagnostics?.context }) }
        catch (failure) {
          const diagnostic = diagnosticReferenceFrom(failure)
          facts = diagnostic ? new Map(items.map((item) => [item.rowId, { state: "unknown" as const, code: "send_result_unknown", diagnostic }])) : new Map()
        }
        const answered = items.map((item) => ({ item, fact: facts.get(item.rowId) ?? { state: "unknown" as const, code: "send_result_unknown" } }))
        for (const { item, fact } of answered) applyFact(options, queue, block, item, pins.get(item.rowId)!, fact)
        remaining = remaining.filter((id) => !items.some((item) => item.rowId === id))
        block.remainingRowIds = [...remaining]
        // Receipt authority is durable before observers see the in-flight counter settle.
        try { await persist() } finally { inFlight.delete(block.id) }
        emit()
        if (answered.some(({ fact }) => fact.state === "unknown")) {
          block.state = "halted"; halted.add(key); await persist(); return
        }
        const refusal = answered.find(({ fact }) => fact.admission && fact.admission !== "store_busy")?.fact.admission
        if (refusal && refusal !== "store_busy") {
          block.remainingRowIds = [...remaining, ...answered.filter(({ fact }) => fact.state === "rejected" && fact.canResume).map(({ item }) => item.rowId)]
          await haltAdmission(block, refusal, "request_refusal"); return
        }
        if (answered.every(({ fact }) => fact.state === "rejected" && fact.admission === "store_busy")) {
          block.remainingRowIds = [...new Set([...items.map((item) => item.rowId), ...remaining, ...retry])]
          if (!spendBusy(queue, key, now())) {
            await haltAdmission(block, "store_busy", queue.busy[key]!.attempts >= 3 ? "retries_exhausted" : "deadline_exhausted"); return
          }
          block.busyRetryAt = now() + queue.busy[key]!.attempts * 5_000
          block.state = "pending"
          await persist()
          if (stopped()) return
          retry.splice(0, retry.length, ...block.remainingRowIds)
          break // Wait/retry this request before admitting any later chunk of its parent.
        } else {
          if (stopped()) { block.state = remaining.length > 0 ? "pending" : "settled"; await persist(); return }
          for (const kind of ["schema", "media"] as const) {
            const ids = answered.filter(({ item, fact }) => repairKind(fact) === kind && options.rows.get(item.rowId)?.rev === pins.get(item.rowId)! + 1).map(({ item }) => item.rowId)
            if (ids.length === 0 || !capability.repair || capability.canRepair?.(kind) === false || !spendRepair(block.budget, kind)) continue
            block.remainingRowIds = [...remaining, ...retry, ...ids]
            await persist() // repair credit is durable before any refresh/reupload
            if (stopped()) return
            try { await capability.repair(kind, liveRows(ids), admission.signal) }
            catch { block.state = "halted"; halted.add(key); await persist(); return }
            if (stopped()) return
            retry.push(...ids)
          }
        }
      }
      remaining = retry
      block.remainingRowIds = [...retry]
    }
    block.state = remaining.length > 0 && stopped() ? "pending" : "settled"
    await persist()
  }

  async function run() {
    if (!queue) return
    if (stopped()) { queue.phase = "paused"; await persist(); return }
    queue.phase = "running"
    await persist()
    const destinations = [...new Set(queue.blocks.map((block) => destinationKey(block.platform, block.destination)))]
    let next = 0
    const worker = async () => {
      while (!stopped() && next < destinations.length) {
        const key = destinations[next++]!
        if (halted.has(key)) continue
        await withDestination(JSON.stringify([options.workspaceUuid, key]), admission.signal, async () => {
          for (const block of queue!.blocks) {
            if (stopped() || halted.has(key)) break
            if (destinationKey(block.platform, block.destination) === key && block.state === "pending") await runBlock(block)
          }
        })
      }
    }
    try {
      const results = await Promise.allSettled([worker(), worker()])
      const failure = results.find((result) => result.status === "rejected")
      if (failure?.status === "rejected") throw failure.reason
    }
    finally {
      for (const block of queue.blocks) if (block.state === "sending" && !inFlight.has(block.id)) block.state = block.remainingRowIds.length > 0 ? "pending" : "settled"
      queue.phase = stopped() || queue.blocks.some((block) => block.state !== "settled") ? "paused" : "complete"
      await persist()
    }
  }
  function launch(): Promise<void> {
    if (running) return running
    admission = new AbortController()
    running = Promise.resolve().then(run).finally(() => { running = undefined; emit() })
    if (queue) queue.phase = "running"
    emit()
    return running
  }
  return {
    settled(): Promise<void> { return running ?? Promise.resolve() },
    snapshot(): SendQueueSnapshot {
      const counts = { accepted: 0, pending: 0, rejected: 0, unknown: 0 }
      for (const evidence of new Map(visibleEvidence.map((item) => [item.rowId, item])).values()) {
        switch (evidence.state) {
          case "accepted": counts.accepted++; break
          case "pending": counts.pending++; break
          case "rejected": counts.rejected++; break
          default: counts.unknown++
        }
      }
      return { counts, phase: queue?.phase ?? "idle", inFlight: inFlight.size, deadlines: [...inFlight.values()], haltedDestinations: [...halted],
        halts: queue?.blocks.flatMap((block) => block.haltReason ? [{ blockId: block.id, platform: block.platform, destination: block.destination, reason: { ...block.haltReason } }] : []) ?? [] }
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    start(selection: readonly SendSelection[]): Promise<void> {
      if (running) return running
      if (resolving) return Promise.reject(new Error("Intent reconciliation, release and local validation are still in progress"))
      if (!options.current() || !options.rows.writable) return Promise.reject(new Error("Publish scope is no longer writable"))
      if (queue && queue.blocks.some((block) => block.state === "pending" || block.state === "sending")) return Promise.reject(new Error("Continue the original send action first"))
      const locks = queue?.locks ?? []
      const blocks: PublishBlock[] = []
      const selected = new Set<string>()
      const identities = selection.flatMap((group) => group.rowIds)
      if (selection.some((group) => !group.platform.trim() || group.platform.trim() !== group.platform || !group.destination.trim() || group.destination.trim() !== group.destination)
        || identities.some((id) => !id.trim() || id.trim() !== id) || new Set(identities).size !== identities.length) {
        return Promise.reject(new Error("发送选择包含空白或重复标识，请重新选择商品后发送"))
      }
      for (const group of selection) {
        const rows = liveRows(group.rowIds).filter((row) => !selected.has(row.id) && row.storeId === group.destination && !row.submission)
        rows.forEach((row) => selected.add(row.id))
        for (let offset = 0; offset < rows.length; offset += 100) blocks.push({
          id: crypto.randomUUID(), platform: group.platform, destination: group.destination,
          rowIds: rows.slice(offset, offset + 100).map((row) => row.id),
          remainingRowIds: rows.slice(offset, offset + 100).map((row) => row.id),
          budget: { submits: 0, schema: 0, media: 0 }, state: "pending",
        })
      }
      // Keep old budget/evidence: a new explicit send must not give previous rows new credits.
      if (!queue) {
        const actionId = crypto.randomUUID()
        diagnostics = createPublishDiagnosticAction(actionId, options.current)
        queue = { actionId, phase: "running", blocks: [], busy: {}, locks: [], evidence: [] }
      }
      queue = { actionId: queue?.actionId ?? crypto.randomUUID(), phase: "running", blocks: [...(queue?.blocks ?? []), ...blocks], busy: queue?.busy ?? {}, locks, evidence: queue?.evidence ?? [] }
      return launch()
    },
    stop(): void {
      diagnostics?.close()
      if (resolving) resolutionStop.abort()
      if (!running || admission.signal.aborted || !queue) return
      admission.abort()
      queue.phase = inFlight.size > 0 ? "stopping" : "paused"
      emit() // same-frame observable state; no fetch, cancellation, query or diagnostic
    },
    continue(): Promise<void> {
      if (!queue || resolving || !options.current()) return Promise.resolve()
      return launch()
    },
    async reconcile(selection: ReconcileSelection, signal = new AbortController().signal): Promise<ReconcileResult> {
      if (!queue || running || resolving || queue.phase === "stopping") return emptyReconcile(selection, "busy")
      const captured: ReconcileSelection = "rowIds" in selection && selection.rowIds
        ? { platform: selection.platform, destination: selection.destination, rowIds: [...selection.rowIds] }
        : { platform: selection.platform, destination: selection.destination, blockId: selection.blockId! }
      resolving = true
      resolutionStop = new AbortController()
      signal = AbortSignal.any([signal, resolutionStop.signal])
      try {
        const result = await reconcileQueue(options, queue, captured, signal)
        const { platform, destination } = captured
        if (result.appliedRowIds.length) {
          if (!queue.blocks.some((block) => block.platform === platform && block.destination === destination && block.state === "halted")) halted.delete(destinationKey(platform, destination))
          visibleEvidence = structuredClone(queue.evidence) // Facts and resolved uncertainty were persisted together.
        }
        return result
      } finally { resolving = false; emit() }
    },
    async releaseUnknown(platform: string, destination: string, intentIds: readonly string[], signal = new AbortController().signal): Promise<void> {
      if (!queue || running || resolving || queue.phase === "stopping" || !options.current() || !options.rows.writable || signal.aborted) return
      const capability = options.capabilities[platform]
      if (!capability?.releaseUnknown) return
      const captured = queue.locks.filter((lock) => lock.platform === platform && lock.destination === destination
        && lock.state === "unknown" && lock.intentId && intentIds.includes(lock.intentId))
      if (captured.length === 0 || captured.length > 100 || captured.length !== intentIds.length || new Set(intentIds).size !== intentIds.length) return
      const rows = liveRows(captured.map((lock) => lock.rowId))
      const pins = new Map(rows.map((row) => [row.id, row.rev]))
      const valid = () => options.current() && options.rows.writable && options.rows.error === undefined && !signal.aborted
        && captured.every((lock) => {
          const row = options.rows.get(lock.rowId)
          const submission = row?.submission
          return row?.rev === pins.get(lock.rowId) && row?.storeId === destination && submission?.platform === platform
            && submission.storeId === destination && (submission.state === "unconfirmed" || submission.state === "unknown")
            && submission.intentId === lock.intentId && !!lock.serverOperationId && submission.clientOperationId === lock.serverOperationId
            && submission.serverRevision !== undefined && queue!.locks.includes(lock)
        })
      if (rows.length !== captured.length || !valid()) return
      resolving = true
      resolutionStop = new AbortController()
      signal = AbortSignal.any([signal, resolutionStop.signal])
      try {
        const result = await capability.releaseUnknown(destination, captured, signal)
        if (!valid()) return
        const eligible = captured.filter((lock) => releaseOfferLock(queue!.locks, lock, result.releasedIntentIds, result).length < queue!.locks.length)
        if (eligible.length === 0) return
        // A release receipt is not readiness: run the same local native preparation
        // while locks are still held, then fence both the readback and validation pins.
        const prepared = await capability.prepare(rows.filter((row) => eligible.some((lock) => lock.rowId === row.id)), signal)
        if (!valid()) return
        for (const lock of eligible) {
          const items = prepared.items.filter((item) => item.rowId === lock.rowId)
          if (prepared.blocked.some((item) => item.rowId === lock.rowId) || items.length !== 1
            || items[0]!.revision !== pins.get(lock.rowId) || items[0]!.offerId !== lock.offerId) continue
          const updated = options.rows.update(lock.rowId, (current) => ({ ...current, submission: {
            ...current.submission!, state: "rejected", receipt: { state: "rejected", canResume: true, code: "explicit_unknown_release" },
          } }), { expectRev: pins.get(lock.rowId)! })
          if (updated) {
            queue.locks = releaseOfferLock(queue.locks, lock, result.releasedIntentIds, result)
            queue.evidence.push({ blockId: options.rows.get(lock.rowId)!.submission!.logicalBlockId!, rowId: lock.rowId, intentId: lock.intentId, serverOperationId: lock.serverOperationId, state: "rejected" })
          }
        }
        await persist() // No submit; explicit retry keeps this parent's remaining credits.
      } finally {
        resolving = false
        emit()
      }
    },
    /** Explicit operator retry keeps the original action and parent credits. */
    retry(blockId: string): Promise<void> {
      if (!queue || running || resolving || !options.current() || !options.rows.writable || options.rows.error !== undefined || queue.phase === "stopping") return Promise.resolve()
      const block = queue.blocks.find((entry) => entry.id === blockId)
      if (!block || block.budget.submits >= 6 || queue.locks.some((lock) => lock.platform === block.platform && lock.destination === block.destination && lock.state === "unknown")) return Promise.resolve()
      const ids = liveRows(block.rowIds).filter((row) => row.storeId === block.destination && (!row.submission || (row.submission.platform === block.platform
        && row.submission.storeId === block.destination && row.submission.logicalBlockId === block.id && row.submission.sendActionId === queue!.actionId
        && row.submission.state === "rejected" && (row.submission.receipt as SendFact | undefined)?.canResume === true))).map((row) => row.id)
      if (!ids.length || queue.blocks.some((other) => other !== block && other.platform === block.platform && other.destination === block.destination && other.haltReason)) return Promise.resolve()
      block.remainingRowIds = ids
      delete block.haltReason
      delete block.busyRetryAt
      block.state = "pending"
      halted.delete(destinationKey(block.platform, block.destination))
      return launch()
    },
  }
}

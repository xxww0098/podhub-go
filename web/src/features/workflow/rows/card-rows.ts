// The only writer of local rows (see the spec's "单一所有者" table). See
// specs/browser-owned-listing/slices/09-row-store.md.
//
// `create`/`update`/`remove` mutate the in-memory working set immediately, so
// `all()`/`get()` are always instantly consistent — then schedule a debounced
// 250ms flush to `RowRepo.putRows()`/`deleteRows()`. `flush()` forces that
// flush immediately and must be awaited by callers who need durability before
// reporting success (I4: paid OCR results and submission receipts must reach
// IndexedDB before the UI says "done").

import { acquireCardLock, type CardLock, type CardLockScope } from "./card-lock"
import type { RowRepo } from "./row-repo"
import type { CardLocalState, LocalRow, PublishOfferLock } from "./types"
import { wbPreviewWorkingSet, type WbPreviewRows, type WbPreviewRow } from "./wb-preview-rows"

const FLUSH_DEBOUNCE_MS = 250

export interface CardRows {
  readonly wb: WbPreviewRows
  readonly writable: boolean
  /** Last persistence/lock/promotion failure; subscribe() observes changes. Explicit flush/reopen retries. */
  readonly error: unknown
  knownOfferLocks(): Promise<PublishOfferLock[]>
  cardState(): CardLocalState | undefined
  updateCardState(fn: (state: CardLocalState | undefined) => CardLocalState): void
  all(): readonly LocalRow[]
  get(id: string): LocalRow | undefined
  create(rows: Omit<LocalRow, "rev" | "createdAtMs" | "updatedAtMs">[]): void
  /** `rev`/`createdAtMs`/`updatedAtMs` are owned by CardRows, not by `fn`: rejects (returns false, no write) when `opts.expectRev` is given and does not match the row's current `rev` — the stale-result-gets-discarded invariant (I6). */
  update(id: string, fn: (row: LocalRow) => LocalRow, opts?: { expectRev?: number }): boolean
  /** Safe metadata at an existing CAS pin; does not alter business revision or retry credits. */
  attachDiagnostic(id: string, expectRev: number, ref: NonNullable<LocalRow["diagnostic"]> | undefined): boolean
  remove(ids: string[]): void
  /** Must be awaited by callers before treating data as durably saved (I4). */
  flush(): Promise<void>
  subscribe(fn: () => void): () => void
  /** Stops edits immediately; releases the writer only after persistence succeeds. A rejected close may be retried. */
  close(): Promise<void>
}

export async function openCardRows(
  repo: RowRepo,
  scope: CardLockScope,
  acquireLock: (scope: CardLockScope) => Promise<CardLock> = acquireCardLock,
  /** Owner's captured account/workspace/card generation; a scope switch closes admission. */
  current: () => boolean = () => true,
): Promise<CardRows> {
  const lock = await acquireLock(scope)
  let initialRows: LocalRow[]
  let state: CardLocalState | undefined
  let initialPreviews: WbPreviewRow[]
  try {
    const heldBeforeRead = lock.writable
    initialRows = await repo.rowsOfCard(scope.workspaceUuid, scope.cardId)
    state = await repo.cardState(scope.workspaceUuid, scope.cardId)
    initialPreviews = await repo.wbPreviewsOfCard(scope.workspaceUuid, scope.cardId)
    // A queued reader can become writer while its first snapshot is in flight.
    // Once granted, read under the held lock rather than exposing that snapshot.
    if (!heldBeforeRead && lock.writable) {
      initialRows = await repo.rowsOfCard(scope.workspaceUuid, scope.cardId)
      state = await repo.cardState(scope.workspaceUuid, scope.cardId)
      initialPreviews = await repo.wbPreviewsOfCard(scope.workspaceUuid, scope.cardId)
    }
    if (!current()) throw new Error("CardRows scope changed while opening local rows")
  } catch (error) {
    lock.release()
    throw error
  }

  let rowsById = new Map(initialRows.map((row) => [row.id, row]))
  const subscribers = new Set<() => void>()
  const pendingPut = new Map<string, LocalRow>()
  const pendingDelete = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  let flushTail: Promise<void> = Promise.resolve()
  let pendingState: CardLocalState | undefined
  let flushFailed = false
  let error: unknown
  let ready = lock.writable
  let closing = false
  let closed = false
  let closeResult: Promise<void> | undefined
  const wb = wbPreviewWorkingSet({ repo, ...scope, initial: initialPreviews, requireWritable, current,
    changed() { scheduleFlush(); notify() },
  })

  function notify() {
    for (const fn of subscribers) fn()
  }

  function requireWritable() {
    if (closing || closed) throw new Error("CardRows is closing or closed")
    if (!current() || !ready || !lock.writable || lock.error !== undefined) {
      throw new Error(
        `CardRows for ${scope.workspaceUuid}/${scope.cardId} is read-only: write lock and fresh rows are required`,
      )
    }
  }

  function scheduleFlush() {
    if (flushFailed || closing || closed || flushTimer !== undefined) return
    flushTimer = setTimeout(() => {
      flushTimer = undefined
      void flush().catch(() => {}) // error is retained and published through subscribe()
    }, FLUSH_DEBOUNCE_MS)
  }

  function flush(): Promise<void> {
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer)
      flushTimer = undefined
    }
    const result = flushTail.then(async () => {
      const putBatch = [...pendingPut.values()]
      const deleteBatch = [...pendingDelete]
      const stateBatch = pendingState
      if (putBatch.length === 0 && deleteBatch.length === 0 && !stateBatch && !wb.pending) return
      try {
        // Persist queue/budget before rows. No fetch starts until the whole flush succeeds.
        // A crash between these idempotent writes leaves a conservative pending lock.
        if (stateBatch) await repo.putCardState(stateBatch)
        if (deleteBatch.length > 0) await repo.deleteRows(deleteBatch)
        if (putBatch.length > 0) await repo.putRows(putBatch)
        await wb.flush()
      } catch (cause) {
        flushFailed = true
        if (flushTimer !== undefined) {
          clearTimeout(flushTimer)
          flushTimer = undefined
        }
        error = cause
        notify()
        throw cause
      }
      if (pendingState === stateBatch) pendingState = undefined
      for (const id of deleteBatch) pendingDelete.delete(id)
      for (const row of putBatch) {
        if (pendingPut.get(row.id) === row) pendingPut.delete(row.id)
      }
      flushFailed = false
      if (error !== undefined) {
        error = undefined
        notify()
      }
      if (pendingPut.size > 0 || pendingDelete.size > 0 || pendingState || wb.pending) scheduleFlush()
    })
    // Keep serialization alive without swallowing the rejection returned to
    // this caller. The failed batch is retried only by a later flush call.
    flushTail = result.catch(() => {})
    return result
  }

  const unsubscribeLock = lock.onChange(() => {
    if (closing || closed) return
    if (lock.error !== undefined) {
      ready = false
      error = lock.error
      notify()
      return
    }
    if (!lock.writable) return
    // Promoted from read-only: the previous writer may have changed rows
    // while this tab could not see them, so re-read before allowing any
    // write to go out on stale data.
    ready = false
    void Promise.all([repo.rowsOfCard(scope.workspaceUuid, scope.cardId), repo.cardState(scope.workspaceUuid, scope.cardId), repo.wbPreviewsOfCard(scope.workspaceUuid, scope.cardId)])
      .then(([fresh, freshState, previews]) => {
        if (closing || closed) return
        state = freshState
        wb.reset(previews)
        rowsById = new Map(fresh.map((row) => [row.id, row]))
        ready = true
        notify()
      })
      .catch((cause: unknown) => {
        if (closing || closed) return
        error = cause
        notify()
      })
  })

  return {
    wb: wb.view,
    get writable() {
      return current() && ready && lock.writable && lock.error === undefined && !closing && !closed
    },
    get error() {
      return error !== undefined ? error : lock.error
    },
    knownOfferLocks() { return repo.offerLocks(scope.workspaceUuid) },
    cardState() { return state === undefined ? undefined : structuredClone(state) },
    updateCardState(fn) {
      requireWritable()
      const next = fn(state === undefined ? undefined : structuredClone(state))
      if (next.workspaceUuid !== scope.workspaceUuid || next.cardId !== scope.cardId) throw new Error("Card state scope mismatch")
      state = structuredClone(next)
      pendingState = state
      scheduleFlush()
      notify()
    },
    all() {
      return [...rowsById.values()]
    },
    get(id) {
      return rowsById.get(id)
    },
    create(rows) {
      requireWritable()
      if (rows.length === 0) return
      const now = Date.now()
      for (const row of rows) {
        const full: LocalRow = { ...row, rev: 1, createdAtMs: now, updatedAtMs: now }
        rowsById.set(full.id, full)
        pendingPut.set(full.id, full)
        pendingDelete.delete(full.id) // defensive: a create() reusing a just-removed id must win over a queued delete

      }
      scheduleFlush()
      notify()
    },
    update(id, fn, opts) {
      requireWritable()
      const current = rowsById.get(id)
      if (!current) return false
      if (opts?.expectRev !== undefined && current.rev !== opts.expectRev) return false
      const next: LocalRow = {
        ...fn(current),
        id: current.id,
        createdAtMs: current.createdAtMs,
        rev: current.rev + 1,
        updatedAtMs: Date.now(),
      }
      rowsById.set(id, next)
      pendingPut.set(id, next)
      scheduleFlush()
      notify()
      return true
    },
    remove(ids) {
      requireWritable()
      let removed = false
      for (const id of ids) {
        if (!rowsById.delete(id)) continue
        removed = true
        pendingPut.delete(id)
        pendingDelete.add(id)
      }
      if (!removed) return
      scheduleFlush()
      notify()
    },
    attachDiagnostic(id, expectRev, ref) {
      requireWritable()
      const row = rowsById.get(id)
      if (!row || row.rev !== expectRev || (ref && ref.revision !== expectRev)) return false
      const next = { ...row, diagnostic: ref }
      rowsById.set(id, next)
      pendingPut.set(id, next)
      scheduleFlush()
      notify()
      return true
    },
    flush() {
      return flush()
    },
    subscribe(fn) {
      subscribers.add(fn)
      return () => subscribers.delete(fn)
    },
    close() {
      if (closed) return Promise.resolve()
      if (closeResult) return closeResult
      closing = true
      unsubscribeLock()
      closeResult = flush().then(() => {
        closed = true
        lock.release()
        subscribers.clear()
      }, (cause: unknown) => {
        closeResult = undefined
        throw cause
      })
      return closeResult
    },
  }
}

import assert from "node:assert/strict"
import test from "node:test"

import type { CardLock, CardLockScope } from "./card-lock"
import { openCardRows as openRows } from "./card-rows"
import { memoryRowRepo, type RowRepo } from "./row-repo"
import { sampleLocalRow } from "./row-repo.contract"

const SCOPE = { workspaceUuid: "ws-1", cardId: "card-1" }


function memoryLock(writable = true, onRelease = () => {}) {
  let held = writable
  let released = false
  let error: unknown
  const waiters = new Set<() => void>()
  const lock: CardLock = {
    get writable() { return held },
    get error() { return error },
    onChange(fn) {
      if (held) return () => {}
      waiters.add(fn)
      return () => waiters.delete(fn)
    },
    release() {
      if (released) return
      released = true
      held = false
      waiters.clear()
      onRelease()
    },
  }
  return {
    lock,
    get released() { return released },
    fail(cause: unknown) {
      error = cause
      for (const fn of waiters) fn()
      waiters.clear()
    },
    promote() {
      if (released) return
      held = true
      for (const fn of waiters) fn()
      waiters.clear()
    },
  }
}

function openCardRows(
  repo: RowRepo,
  scope: CardLockScope,
  acquireLock = async () => memoryLock().lock,
) {
  return openRows(repo, scope, acquireLock)
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

function countingRepo(repo: RowRepo) {
  const counts = { puts: 0, deletes: 0 }
  const counting: RowRepo = {
    ...repo,
    async putRows(rows) {
      counts.puts += 1
      await repo.putRows(rows)
    },
    async deleteRows(ids) {
      counts.deletes += 1
      await repo.deleteRows(ids)
    },
  }
  return { repo: counting, counts }
}

test("Bun tests explicitly inject a writable memory lock", async () => {
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE)
  assert.equal(cardRows.writable, true)
  await cardRows.close()
})

test("create() is instantly reflected in all()/get() before any flush", async () => {
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE)
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: {} }])
  assert.equal(cardRows.all().length, 1)
  const row = cardRows.get("row-1")
  assert.ok(row)
  assert.equal(row.rev, 1)
  assert.equal(typeof row.createdAtMs, "number")
  assert.equal(row.createdAtMs, row.updatedAtMs)
  await cardRows.close()
})

test("update() bumps rev and applies the transform; missing id returns false", async () => {
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE)
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: { n: 0 } }])
  const ok = cardRows.update("row-1", (row) => ({ ...row, row: { n: 1 } }))
  assert.equal(ok, true)
  const updated = cardRows.get("row-1")
  assert.deepEqual(updated?.row, { n: 1 })
  assert.equal(updated?.rev, 2)

  assert.equal(cardRows.update("missing", (row) => row), false)
  await cardRows.close()
})

test("update() with a stale expectRev is rejected and performs no write (I6)", async () => {
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE)
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: { n: 0 } }])
  const currentRev = cardRows.get("row-1")!.rev

  const rejected = cardRows.update("row-1", (row) => ({ ...row, row: { n: 999 } }), { expectRev: currentRev + 1 })
  assert.equal(rejected, false, "mismatched expectRev must be rejected")
  assert.deepEqual(cardRows.get("row-1")!.row, { n: 0 }, "rejected update must not mutate the row")
  assert.equal(cardRows.get("row-1")!.rev, currentRev, "rejected update must not bump rev")

  const accepted = cardRows.update("row-1", (row) => ({ ...row, row: { n: 1 } }), { expectRev: currentRev })
  assert.equal(accepted, true, "matching expectRev must be applied")
  assert.equal(cardRows.get("row-1")!.rev, currentRev + 1)
  await cardRows.close()
})

test("remove() drops rows from all()/get() immediately", async () => {
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE)
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: {} }])
  cardRows.remove(["row-1"])
  assert.equal(cardRows.all().length, 0)
  assert.equal(cardRows.get("row-1"), undefined)
  await cardRows.close()
})

test("flush() persists pending writes to the repo and awaiting it guarantees durability", async () => {
  const repo = memoryRowRepo()
  const cardRows = await openCardRows(repo, SCOPE)
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: {} }])
  await cardRows.flush()
  const persisted = await repo.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId)
  assert.equal(persisted.length, 1)
  assert.equal(persisted[0]?.id, "row-1")
  await cardRows.close()
})

test("many synchronous update() calls within the debounce window coalesce into one repo.putRows call", async () => {
  const { repo, counts } = countingRepo(memoryRowRepo())
  const cardRows = await openCardRows(repo, SCOPE)
  cardRows.create(
    Array.from({ length: 50 }, (_, i) => ({
      v: 1 as const,
      id: `row-${i}`,
      workspaceUuid: SCOPE.workspaceUuid,
      cardId: SCOPE.cardId,
      position: i,
      row: { n: 0 },
    })),
  )
  await cardRows.flush()
  counts.puts = 0
  for (let i = 0; i < 50; i += 1) {
    cardRows.update(`row-${i}`, (row) => ({ ...row, row: { n: 1 } }))
  }
  await cardRows.flush()
  assert.equal(counts.puts, 1, "the 250ms debounce must coalesce a synchronous burst into one transaction")
  await cardRows.close()
})

test("the debounced flush fires on its own after ~250ms without an explicit flush() call", async () => {
  const repo = memoryRowRepo()
  const cardRows = await openCardRows(repo, SCOPE)
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: {} }])
  await new Promise((resolve) => setTimeout(resolve, 400))
  const persisted = await repo.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId)
  assert.equal(persisted.length, 1, "the debounce timer must flush without the caller calling flush()")
  await cardRows.close()
})

test("subscribe() fires on create/update/remove and stops after unsubscribe", async () => {
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE)
  let calls = 0
  const unsubscribe = cardRows.subscribe(() => {
    calls += 1
  })
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: {} }])
  assert.equal(calls, 1)
  cardRows.update("row-1", (row) => row)
  assert.equal(calls, 2)
  cardRows.remove(["row-1"])
  assert.equal(calls, 3)
  unsubscribe()
  cardRows.create([sampleLocalRow({ id: "row-2", ...SCOPE })])
  assert.equal(calls, 3, "unsubscribed callback must not fire again")
  await cardRows.close()
})

test("a tab that is writable from the start never re-reads the repo, so a create()+flush() right after open() is not clobbered by a stale read", async () => {
  // An immediate lock callback once caused a delayed second read to erase
  // a create()+flush() that had already succeeded in the browser fixture.
  const base = memoryRowRepo()
  let reads = 0
  const delayedRepo: RowRepo = {
    ...base,
    async rowsOfCard(workspaceUuid, cardId) {
      reads += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return base.rowsOfCard(workspaceUuid, cardId)
    },
  }
  const cardRows = await openCardRows(delayedRepo, SCOPE)
  assert.equal(reads, 1, "only the initial load should call rowsOfCard for an already-writable tab")
  cardRows.create([{ v: 1, id: "row-1", workspaceUuid: SCOPE.workspaceUuid, cardId: SCOPE.cardId, position: 0, row: {} }])
  await cardRows.flush()
  // Give a would-be stale background re-read (the bug) time to land.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(reads, 1, "an already-writable tab must never re-read the repo in the background")
  assert.ok(cardRows.get("row-1"), "the freshly created row must still be in the working set")
  await cardRows.close()
})

test("openCardRows loads existing rows from the repo on open", async () => {
  const repo = memoryRowRepo()
  await repo.putRows([sampleLocalRow({ id: "row-1", ...SCOPE })])
  const cardRows = await openCardRows(repo, SCOPE)
  assert.equal(cardRows.all().length, 1)
  assert.equal(cardRows.get("row-1")?.id, "row-1")
  await cardRows.close()
})

test("a rejected flush retains dirty rows and a later flush saves the latest edits", async () => {
  const base = memoryRowRepo()
  await base.putRows([sampleLocalRow({ id: "recreated", ...SCOPE })])
  const failure = new DOMException("disk full", "QuotaExceededError")
  let calls = 0
  const cardRows = await openCardRows({
    ...base,
    async putRows(batch) {
      if (++calls === 1) throw failure
      await base.putRows(batch)
    },
  }, SCOPE)
  cardRows.create([sampleLocalRow({ id: "first", ...SCOPE, row: { version: 1 } })])
  cardRows.remove(["recreated"])
  await assert.rejects(cardRows.flush(), (error) => error === failure)
  assert.equal(cardRows.error, failure)
  cardRows.update("first", (row) => ({ ...row, row: { version: 2 } }))
  cardRows.create([sampleLocalRow({ id: "second", ...SCOPE })])
  cardRows.create([sampleLocalRow({ id: "recreated", ...SCOPE, row: { version: 3 } })])
  await cardRows.flush()
  const persisted = await base.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId)
  assert.equal(persisted.length, 3)
  assert.deepEqual(persisted.find((row) => row.id === "first")?.row, { version: 2 })
  assert.equal(cardRows.error, undefined)
  assert.equal(calls, 2)
  await cardRows.close()
})

test("close persists edits and removes made during an earlier in-flight write", async () => {
  const base = memoryRowRepo()
  const entered = deferred<void>()
  const finish = deferred<void>()
  let calls = 0
  const cardRows = await openCardRows({
    ...base,
    async putRows(batch) {
      if (++calls === 1) {
        entered.resolve(undefined)
        await finish.promise
      }
      await base.putRows(batch)
    },
  }, SCOPE)
  cardRows.create([
    sampleLocalRow({ id: "edited", ...SCOPE, row: { version: 1 } }),
    sampleLocalRow({ id: "removed", ...SCOPE }),
  ])
  const firstFlush = cardRows.flush()
  await entered.promise
  cardRows.update("edited", (row) => ({ ...row, row: { version: 2 } }))
  cardRows.remove(["removed"])
  const closing = cardRows.close()
  finish.resolve(undefined)
  await firstFlush
  await closing
  const persisted = await base.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId)
  assert.equal(persisted.length, 1)
  assert.deepEqual(persisted[0]?.row, { version: 2 })
  assert.equal(persisted[0]?.rev, 2)
  await cardRows.close()
})

test("remove/create/remove of the same id during a slow delete keeps the final state deleted", async () => {
  const base = memoryRowRepo()
  await base.putRows([sampleLocalRow({ id: "row", ...SCOPE })])
  const entered = deferred<void>()
  const finish = deferred<void>()
  const cardRows = await openCardRows({
    ...base,
    async deleteRows(ids) {
      entered.resolve(undefined)
      await finish.promise
      await base.deleteRows(ids)
    },
  }, SCOPE)
  cardRows.remove(["row"])
  const firstFlush = cardRows.flush()
  await entered.promise
  cardRows.create([sampleLocalRow({ id: "row", ...SCOPE, row: { version: 2 } })])
  cardRows.remove(["row"])
  finish.resolve(undefined)
  await firstFlush
  await cardRows.close()
  assert.equal((await base.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId)).length, 0)
})

test("a debounced failure is observable and does not retry without a new flush", async () => {
  const base = memoryRowRepo()
  const failure = new Error("injected write abort")
  let calls = 0
  const cardRows = await openCardRows({
    ...base,
    async putRows(batch) {
      if (++calls === 1) throw failure
      await base.putRows(batch)
    },
  }, SCOPE)
  const observed = deferred<void>()
  const unsubscribe = cardRows.subscribe(() => {
    if (cardRows.error === failure) observed.resolve(undefined)
  })
  cardRows.create([sampleLocalRow({ ...SCOPE })])
  await observed.promise
  cardRows.update(cardRows.all()[0]!.id, (row) => ({ ...row, position: 99 }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(calls, 1)
  assert.equal(cardRows.error, failure)
  await cardRows.flush()
  assert.equal(cardRows.error, undefined)
  assert.equal((await base.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId))[0]?.position, 99)
  unsubscribe()
  await cardRows.close()
})

test("promotion stays read-only until its fresh rows have loaded", async () => {
  const base = memoryRowRepo()
  await base.putRows([sampleLocalRow({ id: "row", ...SCOPE, row: { version: 1 } })])
  const controlled = memoryLock(false)
  const entered = deferred<void>()
  const finish = deferred<Awaited<ReturnType<RowRepo["rowsOfCard"]>>>()
  let reads = 0
  const cardRows = await openCardRows({
    ...base,
    async rowsOfCard(workspace, card) {
      if (++reads === 1) return base.rowsOfCard(workspace, card)
      entered.resolve(undefined)
      return finish.promise
    },
  }, SCOPE, async () => controlled.lock)
  await base.putRows([sampleLocalRow({ id: "row", ...SCOPE, row: { version: 2 }, rev: 2 })])
  const ready = deferred<void>()
  cardRows.subscribe(() => { if (cardRows.writable) ready.resolve(undefined) })
  controlled.promote()
  await entered.promise
  assert.equal(cardRows.writable, false)
  assert.throws(() => cardRows.update("row", (row) => row), /read-only/)
  finish.resolve(await base.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId))
  await ready.promise
  assert.equal(cardRows.writable, true)
  assert.deepEqual(cardRows.get("row")?.row, { version: 2 })
  await cardRows.close()
})

test("promotion during the first read reloads under the acquired lock", async () => {
  const base = memoryRowRepo()
  await base.putRows([sampleLocalRow({ id: "row", ...SCOPE, row: { version: 1 } })])
  const controlled = memoryLock(false)
  let reads = 0
  const cardRows = await openCardRows({
    ...base,
    async rowsOfCard(workspace, card) {
      const snapshot = await base.rowsOfCard(workspace, card)
      if (++reads === 1) {
        await base.putRows([sampleLocalRow({ id: "row", ...SCOPE, row: { version: 2 } })])
        controlled.promote()
      }
      return snapshot
    },
  }, SCOPE, async () => controlled.lock)
  assert.equal(reads, 2)
  assert.equal(cardRows.writable, true)
  assert.deepEqual(cardRows.get("row")?.row, { version: 2 })
  await cardRows.close()
})

test("close holds the writer until its slow final write completes and the next writer reads it", async () => {
  const base = memoryRowRepo()
  const entered = deferred<void>()
  const finish = deferred<void>()
  const readerLock = memoryLock(false)
  const writerLock = memoryLock(true, () => readerLock.promote())
  const writer = await openCardRows({
    ...base,
    async putRows(batch) {
      entered.resolve(undefined)
      await finish.promise
      await base.putRows(batch)
    },
  }, SCOPE, async () => writerLock.lock)
  const reader = await openCardRows(base, SCOPE, async () => readerLock.lock)
  const ready = deferred<void>()
  reader.subscribe(() => { if (reader.writable) ready.resolve(undefined) })
  writer.create([sampleLocalRow({ id: "final", ...SCOPE })])
  const closing = writer.close()
  await entered.promise
  assert.equal(writerLock.released, false)
  assert.equal(reader.writable, false)
  assert.throws(() => writer.update("final", (row) => row), /closing or closed/)
  finish.resolve(undefined)
  await closing
  await ready.promise
  assert.equal(writerLock.released, true)
  assert.ok(reader.get("final"))
  assert.throws(() => writer.create([sampleLocalRow({ ...SCOPE })]), /closing or closed/)
  assert.throws(() => writer.remove(["final"]), /closing or closed/)
  await writer.close()
  await reader.close()
})

test("a failed close retains ownership and dirty data until an explicit retry succeeds", async () => {
  const base = memoryRowRepo()
  const controlled = memoryLock()
  const failure = new Error("injected final write abort")
  let calls = 0
  const cardRows = await openCardRows({
    ...base,
    async putRows(batch) {
      if (++calls === 1) throw failure
      await base.putRows(batch)
    },
  }, SCOPE, async () => controlled.lock)
  cardRows.create([sampleLocalRow({ id: "final", ...SCOPE })])
  await assert.rejects(cardRows.close(), (error) => error === failure)
  assert.equal(cardRows.error, failure)
  assert.equal(controlled.released, false)
  assert.equal(cardRows.writable, false)
  assert.throws(() => cardRows.update("final", (row) => row), /closing or closed/)
  await cardRows.close()
  assert.equal(controlled.released, true)
  assert.equal((await base.rowsOfCard(SCOPE.workspaceUuid, SCOPE.cardId)).length, 1)
  assert.equal(calls, 2)
})

test("an initial read failure releases the acquired lock", async () => {
  const controlled = memoryLock()
  const failure = new Error("initial read aborted")
  await assert.rejects(openCardRows({
    ...memoryRowRepo(),
    async rowsOfCard() { throw failure },
  }, SCOPE, async () => controlled.lock), (error) => error === failure)
  assert.equal(controlled.released, true)
})

test("a rejected promotion read stays read-only and reports its cause without retry", async () => {
  const base = memoryRowRepo()
  const controlled = memoryLock(false)
  const failure = new Error("fresh read aborted")
  let reads = 0
  const cardRows = await openCardRows({
    ...base,
    async rowsOfCard(workspace, card) {
      if (++reads === 1) return base.rowsOfCard(workspace, card)
      throw failure
    },
  }, SCOPE, async () => controlled.lock)
  const observed = deferred<void>()
  cardRows.subscribe(() => { if (cardRows.error === failure) observed.resolve(undefined) })
  controlled.promote()
  await observed.promise
  assert.equal(cardRows.writable, false)
  assert.throws(() => cardRows.create([sampleLocalRow({ ...SCOPE })]), /read-only/)
  assert.equal(reads, 2)
  await cardRows.close()
})

test("a queued lock error notifies rows subscribers without reading or enabling edits", async () => {
  const controlled = memoryLock(false)
  const cardRows = await openCardRows(memoryRowRepo(), SCOPE, async () => controlled.lock)
  const failure = new Error("queued request failed")
  let notified = 0
  cardRows.subscribe(() => { if (cardRows.error === failure) notified += 1 })
  controlled.fail(failure)
  assert.equal(notified, 1)
  assert.equal(cardRows.writable, false)
  assert.throws(() => cardRows.create([sampleLocalRow({ ...SCOPE })]), /read-only/)
  await cardRows.close()
})

import assert from "node:assert/strict"
import test from "node:test"

import { commitLatest, shouldSoftReload } from "./console-model"

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept
    reject = decline
  })
  return { promise, resolve, reject }
}

test("reverse completion commits only the newest request and ignores an older failure", async () => {
  let generation = 0
  const committed: number[] = []
  const failed: unknown[] = []
  const older = deferred<number>()
  const newer = deferred<number>()
  const run = (request: Promise<number>) => {
    const ownGeneration = ++generation
    return commitLatest({
      request: () => request,
      isCurrent: () => ownGeneration === generation,
      commit: (value) => committed.push(value),
      fail: (reason) => failed.push(reason),
    })
  }

  const olderRun = run(older.promise)
  const newerRun = run(newer.promise)
  newer.resolve(2)
  assert.equal(await newerRun, true)
  older.reject(new Error("stale failure"))
  assert.equal(await olderRun, false)

  assert.deepEqual(committed, [2])
  assert.deepEqual(failed, [])
})

test("the current failure reaches the caller", async () => {
  const expected = new Error("current failure")
  const failed: unknown[] = []
  const result = await commitLatest({
    request: () => Promise.reject(expected),
    isCurrent: () => true,
    commit: () => assert.fail("failed request must not commit"),
    fail: (reason) => failed.push(reason),
  })

  assert.equal(result, false)
  assert.deepEqual(failed, [expected])
})

test("reactivation never supersedes a refresh or reconciliation", () => {
  assert.equal(shouldSoftReload(true, true, false), true)
  assert.equal(shouldSoftReload(true, true, true), false)
  assert.equal(shouldSoftReload(false, true, false), false)
  assert.equal(shouldSoftReload(true, false, false), false)
})

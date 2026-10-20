import assert from "node:assert/strict"
import test from "node:test"

import { acquireCardLock } from "./card-lock"

const SCOPE = { workspaceUuid: "ws-1", cardId: "card-1" }

type Request = (name: string, options: LockOptions, callback: (lock: Lock | null) => unknown) => Promise<unknown>

function manager(request: Request): Pick<LockManager, "request"> {
  return { request } as Pick<LockManager, "request">
}

test("missing Web Locks fails closed instead of assigning write access", async () => {
  await assert.rejects(acquireCardLock(SCOPE, null), /Web Locks API is unavailable/)
})

test("a rejected native request is surfaced instead of assigning write access", async () => {
  const failure = new DOMException("document is inactive", "InvalidStateError")
  await assert.rejects(acquireCardLock(SCOPE, manager(async () => { throw failure })), (error) => error === failure)
})

test("an initially held lock has no promotion event and release removes write access", async () => {
  const lock = await acquireCardLock(SCOPE, manager(async (name, _options, callback) => {
    return callback({ name, mode: "exclusive" })
  }))
  assert.equal(lock.writable, true)
  let fired = false
  const unsubscribe = lock.onChange(() => { fired = true })
  assert.equal(fired, false)
  unsubscribe()
  lock.release()
  assert.equal(lock.writable, false)
  lock.release()
})

test("a queued native request promotes once and release aborts an ungranted request", async () => {
  let promote!: () => void
  let signal: AbortSignal | undefined
  const locks = manager(async (name, options, callback) => {
    if (options.ifAvailable) return callback(null)
    signal = options.signal
    return new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("released", "AbortError")), { once: true })
      promote = () => { Promise.resolve(callback({ name, mode: "exclusive" })).then(() => resolve(), reject) }
    })
  })
  const lock = await acquireCardLock(SCOPE, locks)
  assert.equal(lock.writable, false)
  let fired = 0
  lock.onChange(() => { fired += 1 })
  promote()
  assert.equal(lock.writable, true)
  assert.equal(fired, 1)
  lock.release()
  assert.equal(lock.writable, false)

  const cancelled = await acquireCardLock(SCOPE, locks)
  cancelled.onChange(() => { fired += 1 })
  cancelled.release()
  assert.equal(signal?.aborted, true)
  promote()
  assert.equal(cancelled.writable, false)
  assert.equal(fired, 1)
})

test("a rejected queued request remains read-only with a diagnostic and no retry", async () => {
  const failure = new Error("background lock request rejected")
  let requests = 0
  let rejectRequest!: (error: unknown) => void
  const lock = await acquireCardLock(SCOPE, manager(async (_name, options, callback) => {
    requests += 1
    if (options.ifAvailable) return callback(null)
    return new Promise((_resolve, reject) => { rejectRequest = reject })
  }))
  let changes = 0
  lock.onChange(() => { changes += 1 })
  rejectRequest(failure)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(lock.writable, false)
  assert.equal(lock.error, failure)
  assert.equal(requests, 2)
  assert.equal(changes, 1)
  lock.release()
})

import assert from "node:assert/strict"
import { test } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { createByteWindow, createTabUploadSlots, type SlotStorage } from "./upload-budget"

function mapStorage(backing: Map<string, string>): SlotStorage {
  return {
    getItem: (key) => backing.get(key) ?? null,
    setItem: (key, value) => { backing.set(key, value) },
    removeItem: (key) => { backing.delete(key) },
    keys: () => [...backing.keys()],
  }
}

function twoTabs(cap: number, now: () => number = () => 0) {
  const storage = mapStorage(new Map())
  const shared = { storage, cap, now, ttlMs: 1_000 }
  return {
    a: createTabUploadSlots({ ...shared, tabId: "tab-a" }),
    b: createTabUploadSlots({ ...shared, tabId: "tab-b" }),
  }
}

test("two tabs share one cap and a closed tab returns its slots", () => {
  const { a, b } = twoTabs(2)
  assert.equal(a.tryAcquire(), true)
  assert.equal(a.tryAcquire(), true)
  assert.equal(b.tryAcquire(), false)
  assert.equal(a.used(), 2)
  assert.equal(b.used(), 2)
  a.close()
  assert.equal(b.used(), 0)
  assert.equal(b.tryAcquire(), true)
  assert.equal(b.tryAcquire(), true)
  assert.equal(a.tryAcquire(), false)
})

test("releasing slots without closing the tab lets the other tab in", () => {
  const { a, b } = twoTabs(1)
  assert.equal(a.tryAcquire(), true)
  assert.equal(b.tryAcquire(), false)
  a.release()
  assert.equal(b.tryAcquire(), true)
})

test("a tab that stops refreshing is ignored after the lease TTL", () => {
  let clock = 0
  const { a, b } = twoTabs(1, () => clock)
  assert.equal(a.tryAcquire(), true)
  clock = 1_000
  assert.equal(b.tryAcquire(), true, "the first tab's lease expired")
  assert.equal(a.used(), 1)
})

test("the byte window admits one more only when the bytes fit, and a single oversized object still runs", async () => {
  const window = createByteWindow(100)
  const releaseA = await window.acquire(60)
  let second = false
  const waiting = window.acquire(60).then((release) => {
    second = true
    return release
  })
  await tick()
  assert.equal(second, false)
  releaseA()
  const releaseB = await waiting
  assert.equal(second, true)
  releaseB()

  const big = await window.acquire(1_000)
  let blocked = false
  const next = window.acquire(1).then((release) => {
    blocked = true
    return release
  })
  await tick()
  assert.equal(blocked, false, "the oversized object holds the whole window")
  big()
  const releaseNext = await next
  releaseNext()
})

test("confirm slots do not consume the upload cap", () => {
  const storage = mapStorage(new Map())
  const now = () => 0
  const uploads = createTabUploadSlots({ storage, tabId: "tab-a", cap: 1, now })
  const confirms = createTabUploadSlots({
    storage, tabId: "tab-a", cap: 1, now, prefix: "podhub.complete-slot.",
  })
  assert.equal(uploads.tryAcquire(), true)
  assert.equal(uploads.tryAcquire(), false)
  assert.equal(confirms.tryAcquire(), true)
  assert.equal(confirms.used(), 1)
  assert.equal(uploads.used(), 1)
})

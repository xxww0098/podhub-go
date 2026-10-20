import assert from "node:assert/strict"
import test from "node:test"

import { createSessionCache, invalidateAllSessionCaches, onSessionInvalidated } from "./session-cache"

test("a fence on an absent key is registered, so a sign-out sweep still trips it", () => {
  const cache = createSessionCache<number>(async () => 1)
  const fence = cache.captureFence("absent")
  assert.equal(fence(), true)
  invalidateAllSessionCaches()
  assert.equal(fence(), false)
  assert.equal(cache.captureFence("absent")(), true, "a fence taken after the sweep belongs to the new session")
})

test("remember, drop and load on the key trip its fence; other keys and plain set do not", async () => {
  const cache = createSessionCache<number>(async () => 2)
  for (const touch of [
    () => cache.remember("k", 1),
    () => cache.drop("k"),
    () => cache.load("k"),
    () => cache.invalidate(),
  ]) {
    const fence = cache.captureFence("k")
    cache.set("k", 3)
    assert.equal(fence(), true, "set publishes without fencing")
    await touch()
    assert.equal(fence(), false)
  }
  const other = cache.captureFence("other")
  cache.remember("k", 4)
  assert.equal(other(), true)
})

test("session resource cleanup runs after fences trip and can unsubscribe", () => {
  const current = createSessionCache(async () => 1).captureFence("session")
  let calls = 0
  const unsubscribe = onSessionInvalidated(() => { calls++; assert.equal(current(), false) })
  try {
    invalidateAllSessionCaches()
    assert.equal(calls, 1)
    unsubscribe()
    invalidateAllSessionCaches()
    assert.equal(calls, 1)
  } finally { unsubscribe() }
})

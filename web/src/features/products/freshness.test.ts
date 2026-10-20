import assert from "node:assert/strict"
import test from "node:test"

import {
  classifyFreshness,
  storeFreshness,
  RECONCILE_PERIOD_MS,
  EXPIRED_AFTER_MS,
  FAILURE_EXPIRES_AT,
} from "./freshness"

import fixture from "../../../tests/fixtures/product-freshness.json"

test("constants match the shared threshold table", () => {
  assert.equal(RECONCILE_PERIOD_MS, fixture.reconcilePeriodMs)
  assert.equal(EXPIRED_AFTER_MS, fixture.expiredAfterMs)
  assert.equal(FAILURE_EXPIRES_AT, fixture.failureExpiresAt)
})

for (const c of fixture.cases) {
  test(`fixture: ${c.name} → ${c.expected}`, () => {
    assert.equal(
      classifyFreshness(c.referenceMs, c.periodMs, c.failures, c.nowMs),
      c.expected,
    )
  })
}

test("storeFreshness: no reconcile commit yet → never", () => {
  const now = 100_000_000_000
  assert.equal(storeFreshness(undefined, 0, now), "never")
})

test("storeFreshness: a recent commit is fresh; two periods stale", () => {
  const now = 100_000_000_000
  assert.equal(storeFreshness(now - 1_000, 0, now), "fresh")
  assert.equal(
    storeFreshness(now - 2 * RECONCILE_PERIOD_MS - 1_000, 0, now),
    "stale",
  )
})

test("storeFreshness: past three days it expires", () => {
  const now = 100_000_000_000
  assert.equal(
    storeFreshness(now - 4 * 24 * 3_600_000, 0, now),
    "expired",
  )
})

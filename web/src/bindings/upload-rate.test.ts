import assert from "node:assert/strict"
import test from "node:test"
import { etaSeconds, slidingRate } from "./upload-rate"

test("a sliding window does not jump when one chunk lands inside a steady rate", () => {
  const samples = [
    { at: 0, bytes: 0 },
    { at: 4_000, bytes: 4_000_000 },
  ]
  const steady = slidingRate(samples, 4_000, 0)
  assert.equal(steady.rate, 1_000_000)
  const jumped = slidingRate(
    [...steady.samples, { at: 4_200, bytes: 20_000_000 }],
    4_200,
    steady.rate,
  )
  assert.ok(jumped.rate < 8_000_000, `rate jumped to ${jumped.rate}`)
  assert.ok(jumped.rate > steady.rate)
})

test("a window with no span keeps the previous rate, and an empty window clears it", () => {
  const held = slidingRate([{ at: 1_000, bytes: 500 }], 1_100, 250_000)
  assert.equal(held.rate, 250_000)
  const cleared = slidingRate([{ at: 0, bytes: 1 }], 20_000, 250_000)
  assert.equal(cleared.rate, 0)
  assert.equal(etaSeconds(0, 1), 0)
  assert.equal(etaSeconds(1_000, 0), Number.POSITIVE_INFINITY)
  assert.equal(etaSeconds(2_000, 1_000), 2)
})

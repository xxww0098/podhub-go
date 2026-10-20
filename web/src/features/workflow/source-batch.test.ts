import assert from "node:assert/strict"
import test from "node:test"
import { chunkItems, mapLimit, MAX_SOURCE_BATCH } from "./source-batch"

test("a Listing Card admits a thousand source-image rows", () => {
  assert.equal(MAX_SOURCE_BATCH, 1000)
})

test("card-sized work is chunked to the mutation batch ceiling", () => {
  const items = Array.from({ length: 250 }, (_, index) => index)
  assert.deepEqual(
    chunkItems(items, 100).map((chunk) => chunk.length),
    [100, 100, 50],
  )
})

test("mapLimit never exceeds the requested concurrency", async () => {
  let active = 0
  let peak = 0
  const results = await mapLimit(
    Array.from({ length: 20 }, (_, index) => index),
    4,
    async (item) => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
      active -= 1
      return item * 2
    },
  )
  assert.equal(peak, 4)
  assert.deepEqual(results, Array.from({ length: 20 }, (_, index) => index * 2))
})

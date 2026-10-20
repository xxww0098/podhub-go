import assert from "node:assert/strict"
import test from "node:test"
import { WORKBENCH_ROW_HEIGHT, workbenchVisibleRange } from "./workbench-virtual-rows"

test("a thousand-row card only mounts the scrollport plus overscan", () => {
  const first = workbenchVisibleRange(1000, 0, 640)
  assert.equal(first.start, 0)
  assert.ok(first.end < 50, "the first paint must not mount every Product Instance")
  assert.equal(first.top, 0)
  assert.equal(first.bottom, (1000 - first.end) * WORKBENCH_ROW_HEIGHT)

  const mid = workbenchVisibleRange(1000, 500 * WORKBENCH_ROW_HEIGHT, 640)
  assert.ok(mid.start > 400)
  assert.ok(mid.end < 600)
  assert.equal(mid.end - mid.start, first.end - first.start)
  assert.equal(mid.top + (mid.end - mid.start) * WORKBENCH_ROW_HEIGHT + mid.bottom, 1000 * WORKBENCH_ROW_HEIGHT)
})

test("a small table still mounts every row", () => {
  const window = workbenchVisibleRange(8, 0, 0)
  assert.deepEqual(window, { start: 0, end: 8, top: 0, bottom: 0 })
})

import assert from "node:assert/strict"
import test from "node:test"

import { occupyOverlay } from "./exclusive-overlay"

test("opening a second overlay dismisses the first", () => {
  const closed: string[] = []
  occupyOverlay(() => closed.push("a"))
  occupyOverlay(() => closed.push("b"))
  assert.deepEqual(closed, ["a"])
})

test("releasing the occupant does not close a later overlay", () => {
  const closed: string[] = []
  const releaseA = occupyOverlay(() => closed.push("a"))
  const releaseB = occupyOverlay(() => closed.push("b"))
  releaseA()
  releaseB()
  occupyOverlay(() => closed.push("c"))
  assert.deepEqual(closed, ["a"])
})

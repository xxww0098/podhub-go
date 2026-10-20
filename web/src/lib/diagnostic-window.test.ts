import assert from "node:assert/strict"
import test from "node:test"
import { createDiagnosticWindow } from "./diagnostic-window"
import { diagnosticTestClock } from "./diagnostic-test-support"

test("one window claims 100 unique IDs as at most five batches of twenty", () => {
  const { clock } = diagnosticTestClock()
  const window = createDiagnosticWindow("action", new AbortController().signal, clock, () => undefined)
  const ids = Array.from({ length: 110 }, (_, id) => String(id))
  const seen = new Set<string>()
  for (let batch = 0; batch < 5; batch++) {
    const next = window.nextBatch(ids.filter((id) => !seen.has(id)))!
    assert.equal(next.ids.length, 20)
    next.ids.forEach((id) => seen.add(id))
  }
  assert.equal(seen.size, 100)
  assert.equal(window.nextBatch(ids.filter((id) => !seen.has(id))), null)
  window.close()
})

test("a batch has three total attempts even when a subset is acknowledged", () => {
  const { clock } = diagnosticTestClock()
  const window = createDiagnosticWindow("action", new AbortController().signal, clock, () => undefined)
  assert.deepEqual(window.nextBatch(["one", "two"]), { ids: ["one", "two"], attempt: 1 })
  assert.deepEqual(window.nextBatch(["two"]), { ids: ["two"], attempt: 2 })
  assert.deepEqual(window.nextBatch(["two"]), { ids: ["two"], attempt: 3 })
  assert.equal(window.nextBatch(["two"]), null)
  window.close()
})

test("120-second maximum and explicit shorter deadline close without reviving the budget", async () => {
  const time = diagnosticTestClock()
  let closed = 0
  const long = createDiagnosticWindow("long", new AbortController().signal, time.clock, () => closed++, 900_000)
  await time.advance(119_999)
  assert.equal(long.isOpen(), true)
  await time.advance(1)
  assert.equal(long.isOpen(), false)
  assert.equal(long.nextBatch(["late"]), null)
  const short = createDiagnosticWindow("short", new AbortController().signal, time.clock, () => closed++, 10)
  await time.advance(10)
  assert.equal(short.isOpen(), false)
  assert.equal(closed, 2)
})

test("Stop closes only its diagnostic controller and closure is idempotent", () => {
  const { clock, timers } = diagnosticTestClock()
  const stop = new AbortController()
  const submission = new AbortController()
  let closed = 0
  const window = createDiagnosticWindow("action", stop.signal, clock, () => closed++)
  stop.abort()
  window.close()
  assert.equal(window.signal.aborted, true)
  assert.equal(submission.signal.aborted, false)
  assert.equal(window.nextBatch(["one"]), null)
  assert.equal(timers.size, 0)
  assert.equal(closed, 1)
})

test("already-aborted and invalid-duration windows cannot claim events", () => {
  const { clock, timers } = diagnosticTestClock()
  const stop = new AbortController(); stop.abort()
  const aborted = createDiagnosticWindow("aborted", stop.signal, clock, () => undefined)
  assert.equal(aborted.nextBatch(["one"]), null)
  for (const duration of [0, -1, NaN, Infinity]) {
    const window = createDiagnosticWindow("invalid", new AbortController().signal, clock, () => undefined, duration)
    assert.equal(window.nextBatch(["one"]), null)
  }
  assert.equal(timers.size, 0)
})

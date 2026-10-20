/**
 * Queued OCR rows behind a full `ai_ocr` permit pool — held by another tab, or
 * by the leases a reload left behind: every claim-window here comes back
 * empty. What the wait costs per row, and what Stop costs. Mocked clock.
 */
import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"

import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { AI_CONCURRENCY } from "./ai-job"
import { cancelPrepareJobsForDrafts } from "./cancel-prepare-jobs"
import { cancelablePrepareDraftIds, requestStop } from "./execution-context"
import { FIXED_TAGS, record, ROW, windowCalls, withStubbedDevice } from "./executor-test-support"

/** Twelve recognize rows whose claims never land; each response takes `latencyMs` of mocked time. */
async function queuedBehindFullPermits(t: TestContext, latencyMs = 0) {
  const ids = Array.from({ length: 12 }, (_, i) => `queued-${latencyMs}-${i}`)
  const stub = record((call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: `${id}-ai`, kind: "ai.recognize", state: "queued", idempotency_key: id,
      payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
    }] }
    return { ...ROW, id }
  }, () => null)
  const recorded = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await recorded(input, init)
    if (latencyMs) await new Promise((resolve) => setTimeout(resolve, latencyMs))
    return response
  }) as typeof fetch
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const { runRows } = await import("./run-rows")
  let results: WorkflowOperationRowResult[] | undefined
  const running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "recognize"))
    .then((rows) => { results = rows })
  let now = 0
  /** The mocked time each recorded call left at. */
  const sentAt: number[] = []
  const settle = async () => {
    for (let turn = 0; turn < 5; turn++) await new Promise<void>((resolve) => setImmediate(resolve))
    while (sentAt.length < stub.calls.length) sentAt.push(now)
  }
  const advance = async (ms: number, until: () => boolean = () => false) => {
    for (const end = now + ms; now < end && !until();) {
      await settle()
      t.mock.timers.tick(10)
      now += 10
      await settle()
    }
  }
  return {
    ids, stub, sentAt, settle, advance,
    now: () => now,
    results: () => results,
    /** The workbench Stop: local stop first, then the pinned rows' Cloud cancel. */
    stop: () => {
      requestStop(ids)
      return cancelPrepareJobsForDrafts(cancelablePrepareDraftIds(ids))
    },
    close: async () => {
      requestStop(ids)
      await advance(1_000, () => results !== undefined)
      await running
      t.mock.timers.reset()
      stub.restore()
    },
  }
}

test("queued OCR rows share one claim-window per batch tick, far below a request per row per second", async (t) => {
  const batch = await queuedBehindFullPermits(t)
  try {
    await batch.advance(60_000)
    const polls = windowCalls(batch.stub.calls)
    const polling = new Set(polls.flatMap((call) => call.body.jobIds as string[])).size
    assert.equal(polling, AI_CONCURRENCY, "the pin window admits eight rows; the other four send nothing")
    const pollTimes = batch.stub.calls.flatMap((call, index) => call.url.endsWith("/claim-window") ? [batch.sentAt[index]!] : [])
    assert.ok(pollTimes.slice(1).every((at, index) => at - pollTimes[index]! >= 5_000), `polls at ${pollTimes.slice(0, 8).join(", ")}… ms`)
    const steady = batch.stub.calls.filter((_, index) => batch.sentAt[index]! >= 5_000)
    assert.ok(windowCalls(steady).every((call) => call.body.jobIds.length === AI_CONCURRENCY), "one poll carries the whole batch")
    // Before the shared tick each row sent claim-window + job + row reads about every second: ~2.7/s.
    const perRowPerSecond = steady.length / polling / 55
    assert.ok(perRowPerSecond < 0.3, `${perRowPerSecond.toFixed(3)} requests per queued row per second`)
    assert.equal(batch.stub.calls.some((call) => call.url.endsWith("/ocr/completions")), false)
  } finally {
    await batch.close()
  }
})

test("Stop ends every claim wait at once and sends only the cancel", async (t) => {
  const batch = await queuedBehindFullPermits(t)
  try {
    await batch.advance(7_000)
    const sent = batch.stub.calls.length
    const startedAt = performance.now()
    const cancelling = batch.stop()
    // No mocked time passes: a wait that needed its timer would keep the batch open.
    for (let turn = 0; turn < 20 && !batch.results(); turn++) await batch.settle()
    assert.ok(batch.results(), "no wait outlives Stop")
    assert.ok(performance.now() - startedAt < 100)
    await cancelling
    assert.ok(batch.results()!.every((row) => row.outcome === "noop" && row.noop_reason === "cancelled" && !row.error))
    const after = batch.stub.calls.slice(sent)
    assert.ok(after.length > 0 && after.every((call) => call.url.endsWith("/prepare/cancel")), after.map((call) => call.url).join("\n"))
  } finally {
    await batch.close()
  }
})

test("a Stop landing on an in-flight poll sends nothing after it but the cancels, three at once", async (t) => {
  const batch = await queuedBehindFullPermits(t, 50)
  try {
    await batch.advance(20_000, () => windowCalls(batch.stub.calls).some((call) => call.body.jobIds.length === AI_CONCURRENCY))
    await batch.advance(20)
    const sent = batch.stub.calls.length
    const stoppedAt = batch.now()
    let cancelled = false
    const cancelling = batch.stop().then(() => { cancelled = true })
    await batch.settle()
    assert.equal(batch.stub.calls.length - sent, 3, "the pinned rows' cancels leave together, not a round trip apart")
    await batch.advance(100, () => batch.results() !== undefined)
    const settledIn = batch.results() ? batch.now() - stoppedAt : undefined
    await batch.advance(1_000, () => cancelled)
    await cancelling
    const after = batch.stub.calls.slice(sent)
    assert.ok(after.every((call) => call.url.endsWith("/prepare/cancel")), after.map((call) => call.url).join("\n"))
    // The in-flight poll lands, each row sends its own cancel, and the batch is done.
    assert.ok(settledIn !== undefined && settledIn <= 100, `settled ${settledIn ?? "not"} ms after Stop`)
  } finally {
    await batch.close()
  }
})

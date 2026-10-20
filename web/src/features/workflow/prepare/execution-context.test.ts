/**
 * Shared execution context: the browser lease lifecycle, stop generation and outcome mapping.
 *
 * The renderer and OPFS are stubbed (executor-test-support): what these tests
 * are for is the wire — the route a verb takes, the pin it writes under, and
 * the shape Cloud will refuse if it drifts.
 */
import assert from "node:assert/strict"
import test from "node:test"

import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { AI_CONCURRENCY } from "./ai-job"
import {
  cancelablePrepareDraftIds,
  outcomeOf,
  requestStop,
} from "./execution-context"
import {
  advanceBusyClock,
  cancelledRowIds,
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  preparedRowIds,
  RECOGNISED,
  record,
  ROW,
  singleJobClaims,
  windowJobIds,
  withStubbedDevice,
} from "./executor-test-support"

test("`prepare` outcomes map onto the workbench's verb outcomes", () => {
  assert.equal(outcomeOf("running"), "start")
  assert.equal(outcomeOf("waiting"), "wait")
  assert.equal(outcomeOf("prepared"), "noop")
  assert.equal(outcomeOf("needs_review"), "needs_review")
  assert.equal(outcomeOf("blocked"), "blocked")
})

test("stop mid-prepare cancels only pinned unfinished rows", async () => {
  const ids = Array.from({ length: 80 }, (_, i) => `halt-${i + 1}`)
  let release!: () => void
  const hung = new Promise<void>((resolve) => { release = resolve })
  let windowReady!: () => void
  const sawWindow = new Promise<void>((resolve) => { windowReady = resolve })
  let prepared = 0
  const stub = record(async (call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (++prepared === AI_CONCURRENCY) windowReady()
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize",
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) { await hung; return COMPLETION }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"))
    await sawWindow
    await new Promise<void>((resolve) => setImmediate(resolve))
    const pinned = ids.slice(0, AI_CONCURRENCY)
    assert.deepEqual(preparedRowIds(stub.calls), pinned)
    assert.deepEqual(cancelablePrepareDraftIds(ids), pinned)
    requestStop(ids)
    release()
    await running
    assert.deepEqual(preparedRowIds(stub.calls), pinned)
    assert.deepEqual(cancelledRowIds(stub.calls), pinned)
    assert.equal(stub.calls.some((call) => call.url.endsWith("/prepare/cancel") && !pinned.some((id) => call.url.includes(`/rows/${id}/`))), false)
  } finally {
    release()
    await running
    stub.restore()
  }
})

test("stop mid-recognition cancels only this batch's pinned rows", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `recognize-halt-${i + 1}`)
  let release!: () => void
  const hung = new Promise<void>(resolve => { release = resolve })
  let windowReady!: () => void
  const sawWindow = new Promise<void>(resolve => { windowReady = resolve })
  let prepared = 0
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      if (++prepared === AI_CONCURRENCY) windowReady()
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize",
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) { await hung; return COMPLETION }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "recognize"))
    await sawWindow
    await new Promise<void>(resolve => setImmediate(resolve))
    const pinned = ids.slice(0, AI_CONCURRENCY)
    assert.deepEqual(preparedRowIds(stub.calls), pinned)
    assert.deepEqual(cancelablePrepareDraftIds(ids), pinned)
    requestStop(ids)
    release()
    await running
    assert.deepEqual(preparedRowIds(stub.calls), pinned)
    assert.deepEqual(cancelledRowIds(stub.calls), pinned)
  } finally {
    release()
    await running
    stub.restore()
  }
})

test("Wait grants no execution without a browser lease, even past the short retry window", async (context) => {
  let claims = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "waiting",
      jobs: [{ id: "held-ai", kind: "ai.recognize", idempotency_key: "paid-once", payload: { source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    return RECOGNISED
  }, () => { if (++claims === 8) requestStop([ROW.id]); return null })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(context, () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize")))
    assert.equal(result!.outcome, "noop")
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ocr/completions")), false)
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/settle")), false)
  } finally { stub.restore() }
})

test("an expired browser lease forfeits its claim; the row re-claims under a fresh lease", async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "expired-ai", kind: "ai.recognize", idempotency_key: "paid-once", payload: { source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    return RECOGNISED
  }, (job) => {
    now = 31_000
    return grantedClaim(job)
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result!.outcome, "start")
    assert.equal(result!.error, undefined)
    assert.equal(
      stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length,
      1,
      "the lapsed claim died before its purchase; the retried claim pays once",
    )
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/claim-window")).length, 2)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ai/fail")), false)
  } finally { stub.restore() }
})

test("browser lease heartbeat outcomes respect the last confirmed deadline", async (t) => {
  for (const scenario of [
    { name: "transient failure then success", kind: "retry", claims: 1 },
    { name: "repeated failure", kind: "fail", claims: 2 },
    { name: "explicit false", kind: "false", claims: 2 },
    { name: "delayed success after expiry", kind: "delayed", claims: 2 },
  ] as const) await t.test(scenario.name, async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] })
    let now = 0
    t.mock.method(performance, "now", () => now)
    let heartbeats = 0
    let claims = 0
    let claimed = false
    let release!: () => void
    let started!: () => void
    let releaseHeartbeat!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const preparing = new Promise<void>(resolve => { started = resolve })
    const stub = record(call => {
      if (call.url.endsWith("/prepare")) return {
        outcome: "running",
        jobs: [{ id: "heartbeat-retry-ai", kind: "ai.recognize", idempotency_key: "paid-once", payload: {
          source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" },
        } }],
      }
      if (claimed && call.method === "GET" && call.url.includes("/rows/")) {
        started()
        return held.then(() => RECOGNISED)
      }
      if (call.url.endsWith("/ocr/completions")) return COMPLETION
      return RECOGNISED
    }, job => { claimed = true; claims += 1; return grantedClaim(job) }, () => {
      heartbeats += 1
      if (scenario.kind === "delayed") return new Promise<boolean>(resolve => { releaseHeartbeat = () => resolve(true) })
      if (scenario.kind === "false") return false
      if (scenario.kind === "fail" || heartbeats === 1) throw new Error("temporary heartbeat failure")
      return true
    })
    const { runRows } = await import("./run-rows")
    const running = withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"), {}, {
      prepareAiImage: async () => new Uint8Array([7, 8, 9]),
    })
    try {
      await preparing
      now = 10_000
      t.mock.timers.tick(10_000)
      await new Promise(resolve => setImmediate(resolve))
      if (scenario.kind === "delayed") {
        now = 31_000
        releaseHeartbeat()
        await new Promise(resolve => setImmediate(resolve))
        await new Promise(resolve => setImmediate(resolve))
      } else {
        now = 20_000
        t.mock.timers.tick(10_000)
        await new Promise(resolve => setImmediate(resolve))
        now = 31_000
      }
      release()
      const [result] = await running
      // A lapsed lease kills only its own claim; the row re-claims under a
      // fresh lease and completes the Job.
      assert.equal(result?.error, undefined)
      assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 1)
      assert.equal(claims, scenario.claims)
      assert.equal(heartbeats, scenario.kind === "retry" || scenario.kind === "fail" ? 2 : 1)
    } finally { release(); await running; stub.restore() }
  })
})

test("a heartbeat response that arrives after disposal cannot overwrite the settled row", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  let releaseOcr!: () => void
  let started!: () => void
  const ocrStarted = new Promise<void>(resolve => { started = resolve })
  let releaseHeartbeat!: (value: boolean) => void
  const ocrHeld = new Promise<void>(resolve => { releaseOcr = resolve })
  const heartbeatHeld = new Promise<boolean>(resolve => { releaseHeartbeat = resolve })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "heartbeat-after-dispose", kind: "ai.recognize", idempotency_key: "paid-once", payload: {
        source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" },
      } }],
    }
    if (call.url.endsWith("/ocr/completions")) { started(); return ocrHeld.then(() => COMPLETION) }
    return RECOGNISED
  }, grantedClaim, () => heartbeatHeld)
  try {
    const { runRows } = await import("./run-rows")
    const streamed: WorkflowOperationRowResult[] = []
    const running = withStubbedDevice(() => runRows(
      { row_ids: [ROW.id], expected_revisions: [] }, "recognize", row => streamed.push(row),
    ))
    await ocrStarted
    now = 10_000
    t.mock.timers.tick(10_000)
    await new Promise(resolve => setImmediate(resolve))
    releaseOcr()
    await running
    const before = streamed.length
    releaseHeartbeat(false)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(streamed.length, before)
  } finally {
    releaseOcr()
    releaseHeartbeat?.(false)
    stub.restore()
  }
})

test("a paid OCR still settles after the local lease deadline lapses", async (t) => {
  let now = 0
  t.mock.method(performance, "now", () => now)
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "expired-ai", kind: "ai.recognize", idempotency_key: "paid-once", payload: { source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) {
      now = 31_000
      return COMPLETION
    }
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return RECOGNISED
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    assert.equal(result?.outcome, "start")
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
    assert.equal(stub.calls.find((call) => call.url.endsWith("/ai/settle"))?.body.request_id, "air-purchase")
  } finally { stub.restore() }
})

test("a new batch cannot revive work queued before Stop", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const saturated = new Promise<void>(resolve => { entered = resolve })
  let paid = 0
  const stub = record(async call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? "old-0"
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id,
      payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
    }] }
    if (call.url.endsWith("/ocr/completions")) {
      paid += 1
      if (paid === AI_CONCURRENCY) entered()
      await held
      return COMPLETION
    }
    return { ...RECOGNISED, id }
  })
  try {
    await withStubbedDevice(async () => {
      const { runRows } = await import("./run-rows")
      const first = runRows({ row_ids: Array.from({ length: AI_CONCURRENCY + 1 }, (_, i) => `old-${i}`), expected_revisions: [] }, "recognize")
      await saturated
      requestStop(Array.from({ length: AI_CONCURRENCY + 1 }, (_, i) => `old-${i}`))
      const second = runRows({ row_ids: ["new-1"], expected_revisions: [] }, "recognize")
      release()
      const [oldResults, newResults] = await Promise.all([first, second])
      assert.equal(paid, AI_CONCURRENCY + 1)
      assert.equal(singleJobClaims(stub.calls).length, 0)
      assert.equal(windowJobIds(stub.calls).filter((id) => id.startsWith("old-")).length, AI_CONCURRENCY)
      assert.ok(oldResults.every(row => row.noop_reason === "cancelled"))
      assert.equal(newResults[0]?.error, undefined)
      assert.equal(newResults[0]?.outcome, "start")
    })
  } finally { release(); stub.restore() }
})

test("stopping one card's rows leaves another active batch running", async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const bothPlanned = new Promise<void>(resolve => { entered = resolve })
  let planned = 0
  const stub = record(async call => {
    if (call.url.endsWith("/prepare")) {
      if (++planned === 2) entered()
      await held
      return { outcome: "prepared", jobs: [] }
    }
    throw new Error(`unexpected ${call.url}`)
  })
  const { runRows } = await import("./run-rows")
  const first = runRows({ row_ids: ["card-a-row"], expected_revisions: [] }, "recognize")
  const second = runRows({ row_ids: ["card-b-row"], expected_revisions: [] }, "recognize")
  try {
    await bothPlanned
    requestStop(["card-b-row"])
    release()
    const [[a], [b]] = await Promise.all([first, second])
    assert.equal(a?.noop_reason, undefined)
    assert.equal(b?.noop_reason, "cancelled")
  } finally { release(); await Promise.all([first, second]); stub.restore() }
})

test("a Worker transport failure finishes the row and stops renewing its browser lease", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const preparing = new Promise<void>(resolve => { started = resolve })
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "worker-failed-ai", kind: "ai.recognize", idempotency_key: "unbought", payload: {
        source_sha256: ROW.source.sha256, recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图" },
      } }],
    }
    return ROW
  })
  const { runRows } = await import("./run-rows")
  const running = withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"), {}, {
    prepareAiImage: async () => {
      started()
      await held
      throw Object.assign(new Error("the render Worker failed"), { code: "RENDER_WORKER_ERROR" })
    },
  })
  try {
    await preparing
    t.mock.timers.tick(10_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stub.calls.filter(call => call.url.endsWith("/heartbeat")).length, 0)
    assert.deepEqual(windowJobIds(stub.calls), [], "preprocessing cannot claim a lease")
    release()
    const [result] = await running
    assert.equal(result?.error?.code, "RENDER_WORKER_ERROR")
    assert.deepEqual(windowJobIds(stub.calls), ["worker-failed-ai", "worker-failed-ai", "worker-failed-ai"],
      "each bounded attempt re-claims the Job before its failed preprocessing surfaces")
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/fail")).length, 3)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ocr/completions")), false)
    assert.deepEqual(stub.calls.find(call => call.url.endsWith("/ai/fail"))?.body, {
      job_id: "worker-failed-ai", lease: { owner: "tab-worker-failed-ai", epoch: 1 },
    })
    t.mock.timers.tick(30_000)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(stub.calls.filter(call => call.url.endsWith("/heartbeat")).length, 0, "completed failure must release the lease timer")
  } finally { release(); await running; stub.restore() }
})

// Standalone recognition owns no render residency, including while OCR waits.

test("Stop after refused recognize admission does not cancel an unpinned row", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) {
      requestStop([ROW.id])
      return new Response(JSON.stringify({ code: "cloud_queue_busy", error: "full" }), { status: 429 })
    }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.noop_reason, "cancelled")
    assert.deepEqual(cancelledRowIds(stub.calls), [])
    assert.deepEqual(windowJobIds(stub.calls), [])
  } finally { stub.restore() }
})

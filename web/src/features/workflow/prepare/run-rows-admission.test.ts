/** Planning admission, shared claim windows and original-command retry.
 * Tests cross the runRows interface; HTTP, OPFS and rendering use the existing recorded adapters.
 */
import assert from "node:assert/strict"
import test, { before } from "node:test"
import { sharedListingCore } from "@/listing-core/client"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { requestStop, setCardContext } from "./execution-context"
import {
  advanceBusyClock,
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  RECOGNISED,
  record,
  ROW,
  singleJobClaims,
  windowCalls,
  windowJobIds,
  withStubbedDevice,
} from "./executor-test-support"

// Async WASM file I/O/compilation must finish before the bounded mock-clock loop.
// This suite no longer relies on an earlier, unrelated OCR test warming the singleton.
before(async () => { await sharedListingCore().issueManifest() })

test("empty claim-window then grant retries once and settles one OCR", async (t) => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let claims = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-claim-empty", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: "job-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  }, (job) => {
    claims += 1
    if (claims === 1) return null
    return grantedClaim(job)
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(t, () => withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    ))
    assert.equal(result!.error, undefined)
    assert.equal(result!.outcome, "start")
    assert.equal(claims, 2, "HardQuota empty window must retry claim-window, not enter seen")
    assert.equal(singleJobClaims(stub.calls).length, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
  } finally {
    stub.restore()
  }
})

test("busy batches keep claiming the original jobs until Stop, independent of batch size", async (context) => {
  const budgets: number[] = []
  for (const batchSize of [1, 2, 3]) {
    const ids = Array.from({ length: batchSize }, (_, i) => `busy-budget-${batchSize}-${i}`)
    const attempts = new Map<string, number>()
    const stub = record((call) => {
      const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
      if (call.url.endsWith("/prepare")) {
        return { outcome: "running", jobs: [{ id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
      }
      return { ...RECOGNISED, id }
    }, (job) => {
      const count = (attempts.get(job.id) ?? 0) + 1
      attempts.set(job.id, count)
      if (count === 8) requestStop([job.id.replace(/-ai$/, "")])
      return null
    })
    try {
      const { runRows } = await import("./run-rows")
      const results = await advanceBusyClock(context, () => withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "recognize")))
      assert.ok(results.every((row) => row.outcome === "noop" && row.noop_reason === "cancelled" && !row.error))
      assert.equal(singleJobClaims(stub.calls).length, 0)
      const perJob = ids.map((id) => windowJobIds(stub.calls).filter((jobId) => jobId === `${id}-ai`).length)
      assert.ok(perJob.every((count) => count === perJob[0]))
      budgets.push(perJob[0]!)
    } finally {
      stub.restore()
    }
  }
  assert.deepEqual(budgets, [8, 8, 8])
})

test("capacity returning after the short budget completes the original job without another click", async (context) => {
  let claims = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-still-queued", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  }, (job) => {
    claims += 1
    return claims <= 8 ? null : grantedClaim(job)
  })
  try {
    const { runRows } = await import("./run-rows")
    const progress: WorkflowOperationRowResult[] = []
    const [result] = await advanceBusyClock(context, () => withStubbedDevice(() => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "recognize", row => progress.push(row))))
    assert.equal(result?.outcome, "start")
    assert.equal(result?.error, undefined)
    assert.equal(claims, 9)
    assert.ok(progress.some(row => row.interim && row.noop_reason === "queue_busy"))
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/prepare")).length, 1)
    assert.equal(singleJobClaims(stub.calls).length, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
  } finally {
    stub.restore()
  }
})

test("HardQuota full claim-window stays empty and waits without a 429 storm", async () => {
  const ids = Array.from({ length: 100 }, (_, i) => `full-${i + 1}`)
  let windowReady!: () => void
  const sawWindow = new Promise<void>((resolve) => { windowReady = resolve })
  const stub = record((call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize",
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    return { ...RECOGNISED, id }
  }, () => {
    windowReady()
    return null
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = runRows({ row_ids: ids, expected_revisions: [] }, "prepare")
    await sawWindow
    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    assert.equal(singleJobClaims(stub.calls).length, 0)
    assert.ok(windowCalls(stub.calls).every((call) => (call.body.jobIds as string[]).length >= 1))
    assert.equal(stub.calls.some((call) => call.url.endsWith("/ocr/completions")), false)
    requestStop(ids)
    const results = await running
    assert.ok(results.every((row) => !row.error))
    assert.equal(singleJobClaims(stub.calls).length, 0)
  } finally {
    requestStop(ids)
    await running
    stub.restore()
  }
})

test("a freed slot is claimed on the next claim-window poll", async (t) => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let polls = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{
        id: "job-freed", kind: "ai.recognize", idempotency_key: "job-key",
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  }, (job) => {
    polls += 1
    return polls === 1 ? null : grantedClaim(job)
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(t, () => withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "prepare"),
    ))
    assert.equal(result?.outcome, "start")
    assert.equal(result?.error, undefined)
    assert.equal(polls, 2)
    assert.equal(singleJobClaims(stub.calls).length, 0)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
  } finally {
    stub.restore()
  }
})

test("a two-job claim-window runs each job once", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const ids = ["row-a", "row-b"]
  const stub = record((call) => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? ids[0]!
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{
        id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id,
        payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
      }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    return { ...RECOGNISED, id }
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "prepare"))
    assert.equal(singleJobClaims(stub.calls).length, 0)
    assert.ok(windowCalls(stub.calls).some((call) => (call.body.jobIds as string[]).length === 2))
    assert.deepEqual(windowJobIds(stub.calls).sort(), ["row-a-ai", "row-b-ai"])
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 2)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 2)
    assert.ok(results.every((row) => row.outcome === "start" && !row.error))
  } finally {
    stub.restore()
  }
})

// Combined prepare keeps the independent render rail alive when AI fails.

test("external queue occupancy backs off without occupying the AI stage", async (t) => {
  let refusals = 0
  let localSettled = false
  const stub = record(call => {
    const id = call.url.match(/rows\/([^/]+)/)?.[1] ?? "local"
    if (call.url.endsWith("/prepare")) {
      if (id === "external" && refusals++ < 2) return new Response(JSON.stringify({ code: "queue_busy", error: "other tab owns capacity" }), { status: 503, headers: { "Retry-After": "0" } })
      if (id === "external") assert.equal(localSettled, true)
      return { outcome: "running", jobs: [{ id: `${id}-ai`, kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    }
    if (call.url.endsWith("/ocr/completions")) return COMPLETION
    if (call.url.endsWith("/ai/settle") && id === "local") localSettled = true
    return { ...RECOGNISED, id }
  })
  try {
    const { runRows } = await import("./run-rows")
    const results = await advanceBusyClock(t, () => withStubbedDevice(() => runRows({ row_ids: ["external", "local"], expected_revisions: [] }, "recognize")))
    assert.equal(refusals, 3)
    assert.ok(results.every(row => !row.error && row.outcome === "start"))
  } finally { stub.restore() }
})

test("long admission waits reuse the same command and finish when admission reopens", async (context) => {
  let attempts = 0
  const stub = record(call => call.method === "GET" && /\/rows\/[^/]+$/.test(call.url)
    ? ROW
    : ++attempts <= 9
      ? new Response(JSON.stringify({ code: "queue_busy", error: "external capacity remains occupied" }), { status: 503, headers: { "Retry-After": "30" } })
      : { outcome: "prepared", jobs: [] })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(context, () => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "recognize"))
    assert.notEqual(result?.outcome, "wait")
    assert.equal(result?.error, undefined)
    const plans = stub.calls.filter(call => call.url.endsWith("/prepare"))
    assert.equal(plans.length, 10)
    assert.equal(new Set(plans.map(call => call.body.commandId)).size, 1)
  } finally { stub.restore() }
})

test("HTTP planning admission backs off before the durable plan is obtained", async (t) => {
  let plans = 0
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) {
      if (++plans === 1) return new Response(JSON.stringify({ code: "too_many_requests", error: "busy" }), { status: 429, headers: { "Retry-After": "0" } })
      return { outcome: "prepared", jobs: [] }
    }
    throw new Error("a prepared row needs no work")
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(t, () => runRows({ row_ids: ["row-1"], expected_revisions: [] }, "recognize"))
    assert.equal(plans, 2)
    assert.equal(result?.outcome, "noop")
    assert.equal(result?.error, undefined)
  } finally { stub.restore() }
})

test("OCR 429 backoff releases the AI slot so another row can run", async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `backoff-${i}`)
  const attempts = new Map<string, number>()
  let fifthPaid!: () => void
  const fifthDone = new Promise<void>(resolve => { fifthPaid = resolve })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const stub = record(async call => {
    const id = call.headers["Idempotency-Key"]
      ?? call.url.match(/rows\/([^/]+)/)?.[1]
      ?? ids[0]!
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: `${id}-ai`, kind: "ai.recognize", idempotency_key: id, payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }],
    }
    if (call.url.endsWith("/ocr/completions")) {
      const n = (attempts.get(id) ?? 0) + 1
      attempts.set(id, n)
      if (id === ids[4]) { fifthPaid(); return COMPLETION }
      if (n === 1) return new Response(JSON.stringify({ code: "BUSY", error: "busy" }), { status: 429 })
      await held
      return COMPLETION
    }
    return { ...RECOGNISED, id }
  })
  let running: Promise<WorkflowOperationRowResult[]> | undefined
  try {
    const { runRows } = await import("./run-rows")
    running = withStubbedDevice(() => runRows({ row_ids: ids, expected_revisions: [] }, "recognize"))
    await Promise.race([
      fifthDone,
      new Promise((_, reject) => setTimeout(() => reject(new Error("429 backoff still held the AI slots")), 400)),
    ])
    assert.equal(attempts.get(ids[4]!), 1)
  } finally { release(); await running; stub.restore() }
})

test("another tab completing a job closes an empty claim window without a purchase", async () => {
  const stub = record(call => call.url.endsWith("/prepare") ? { outcome: "running", jobs: [{ id: "other-tab", kind: "ai.recognize", state: "succeeded", idempotency_key: "shared-key", payload: {} }] } : RECOGNISED, () => null)
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    assert.equal(result?.outcome, "start")
    assert.equal(windowCalls(stub.calls).length, 1)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 0)
  } finally { stub.restore() }
})

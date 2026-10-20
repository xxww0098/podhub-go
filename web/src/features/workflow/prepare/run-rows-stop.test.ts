/** Stop fences new effects while already purchased work can settle.
 * Tests cross the runRows interface; HTTP, OPFS and rendering use the existing recorded adapters.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { setErrorFeedbackContext } from "@/lib/error-feedback-reporting"
import { route } from "@/api/routes"
import { AI_CONCURRENCY } from "./ai-job"
import { requestStop, setCardContext } from "./execution-context"
import {
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  windowCalls,
  RECOGNISED,
  record,
  ROW,
  withStubbedDevice,
} from "./executor-test-support"

test("停止一键准备后不新增 OCR 或上传 Job", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  setErrorFeedbackContext({ sessionKey: "stop-preparation-receipts" })
  let receipts = 0
  let revision = 9
  const stub = record((call) => {
    if (call.url === route("eventsInbox")) {
      for (const event of call.body.events) {
        assert.equal(event.kind, "error_feedback.v1")
        assert.equal(event.schema_version, 1)
        assert.match(event.id, /^[0-9]{20}$/)
        const payload = JSON.parse(event.payload_json)
        assert.equal(payload.errorId, event.id)
        assert.equal(payload.code, "workflow_media_writeback_stale")
        assert.equal(payload.refusalReason, "workflow_executor_failed")
        assert.ok(Object.keys(payload).every(key => ["errorId", "code", "traceId", "status", "stage", "rowId", "cardId", "appVersion", "userId", "workspaceId", "userAgent", "requestId", "apiPath", "apiStatus", "refusalReason", "media"].includes(key)))
        receipts++
      }
      return { accepted: call.body.events.map((event: { id: string }) => event.id), rejected: [] }
    }
    if (call.url.endsWith("/prepare")) {
      return {
        outcome: "running",
        jobs: [
          { id: "job-ai", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } }, updated_at_ms: 0 },
          { id: "job-media", kind: "media.render", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, updated_at_ms: 0 },
        ],
      }
    }
    if (call.url.endsWith("/ocr/completions")) {
      requestStop(Array.from({ length: AI_CONCURRENCY + 1 }, (_, index) => `row-${index + 1}`))
      return COMPLETION
    }
    if (call.url.endsWith("/ai/settle")) { revision += 1; return ROW }
    return { ...ROW, revision }
  })
  try {
    const { runRows } = await import("./run-rows")
    // One row more than the AI pool: the last item cannot buy after Stop.
    const rowIds = Array.from({ length: AI_CONCURRENCY + 1 }, (_, index) => `row-${index + 1}`)
    const results = await withStubbedDevice(() =>
      runRows({
        row_ids: rowIds,
        expected_revisions: rowIds.map((rowId) => ({ row_id: rowId, revision: 9 })),
      }, "prepare"),
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(receipts, 1, "failed media writeback emits one safe receipt before teardown")
    // Already issued purchases may settle; no new upload starts after Stop.
    const purchases = stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length
    assert.ok(purchases >= 1 && purchases <= AI_CONCURRENCY, `purchases: ${purchases}`)
    assert.equal(stub.calls.some((call) => call.method === "PUT" && call.url.includes("/media/")), false)
    assert.equal(stub.calls.some((call) => call.url.endsWith("-upload/claim")), false)
    assert.deepEqual(results.map((result) => result.outcome), rowIds.map(() => "noop"))
  } finally {
    setErrorFeedbackContext({ sessionKey: null })
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("stop after a successful render does not start upload, and in-flight OCR still settles", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  let releaseOcr!: () => void
  const heldOcr = new Promise<void>(resolve => { releaseOcr = resolve })
  let releaseRender!: () => void
  const heldRender = new Promise<void>(resolve => { releaseRender = resolve })
  let paid!: () => void
  const sawOcr = new Promise<void>(resolve => { paid = resolve })
  const stub = record(async call => {
    if (call.url.endsWith("/prepare")) {
      if (call.body.operation === "upload") throw new Error("cancel must not plan upload")
      return {
        outcome: "running",
        jobs: [
          { id: "job-ai", kind: "ai.recognize", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } } },
          { id: "job-media", kind: "media.render", payload: { psd_template_sha256: "template-sha" } },
        ],
      }
    }
    if (call.url.endsWith("/ocr/completions")) { paid(); await heldOcr; return COMPLETION }
    if (call.url.endsWith("/media")) {
      await heldRender
      return { applied: true, jobs: [], row: { ...ROW, mediaState: "rendered" } }
    }
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, mediaState: "rendered" }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const running = withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "prepare"),
    )
    await sawOcr
    requestStop(["row-1"])
    releaseRender()
    releaseOcr()
    const [result] = await running
    assert.ok(stub.calls.some(call => call.url.endsWith("/ocr/completions")))
    assert.ok(stub.calls.some(call => call.url.endsWith("/ai/settle")), "in-flight OCR must settle")
    assert.equal(stub.calls.some(call => call.url.endsWith("/prepare") && call.body.operation === "upload"), false)
    assert.equal(stub.calls.some(call => call.method === "PUT" && call.url.includes("/media/")), false)
    assert.equal(stub.calls.some(call => call.url.includes("/batch/submit")), false)
    assert.equal(result?.noop_reason, "cancelled")
  } finally {
    releaseRender()
    releaseOcr()
    stub.restore()
    setCardContext({ psdTemplateSha256: "" })
  }
})

test("stopping one batch does not cancel another batch or leak capacity into the next run", async () => {
  let releasePurchase!: () => void
  const heldPurchase = new Promise<void>(resolve => { releasePurchase = resolve })
  let purchased!: () => void
  const purchaseStarted = new Promise<void>(resolve => { purchased = resolve })
  let waiting!: () => void
  const claimWaiting = new Promise<void>(resolve => { waiting = resolve })
  const stub = record(async call => {
    const id = call.url.match(/rows[/]([^/]+)/)?.[1] ?? "live"
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{
      id: id + "-ai", kind: "ai.recognize", idempotency_key: id,
      payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } },
    }] }
    if (call.url.endsWith("/ocr/completions")) {
      purchased()
      await heldPurchase
      return COMPLETION
    }
    return { ...RECOGNISED, id }
  }, job => job.id === "stopped-ai" ? null : grantedClaim(job))
  try {
    const { runRows } = await import("./run-rows")
    await withStubbedDevice(async () => {
      const stopped = runRows({ row_ids: ["stopped"], expected_revisions: [] }, "recognize", row => {
        if (row.outcome === "wait") waiting()
      })
      const live = runRows({ row_ids: ["live"], expected_revisions: [] }, "recognize")
      try {
        await Promise.all([claimWaiting, purchaseStarted])
        requestStop(["stopped"])
        const [cancelled] = await stopped
        assert.equal(cancelled?.noop_reason, "cancelled")
        assert.equal(cancelled?.error, undefined)
        releasePurchase()
        const [completed] = await live
        assert.equal(completed?.outcome, "start")
        assert.equal(completed?.error, undefined)
        assert.equal(completed?.noop_reason, undefined)
        const claims = windowCalls(stub.calls)
        assert.ok(claims.every(call => call.body.jobIds.length === 1), "claim windows remain batch-owned")
        const [next] = await runRows({ row_ids: ["fresh"], expected_revisions: [] }, "recognize")
        assert.equal(next?.outcome, "start")
        assert.equal(next?.error, undefined)
        assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions")).length, 2)
        assert.ok(stub.calls.filter(call => call.url.endsWith("/prepare/cancel")).every(call => call.url.includes("/stopped/")))
      } finally {
        requestStop(["stopped", "live", "fresh"])
        releasePurchase()
        await Promise.allSettled([stopped, live])
      }
    })
  } finally { releasePurchase(); stub.restore() }
})

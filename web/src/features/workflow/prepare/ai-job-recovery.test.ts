/** OCR recovery: busy waits, uncertain receipts, and stop behavior. */
import assert from "node:assert/strict"
import test, { before } from "node:test"

import { sharedListingCore } from "@/listing-core/client"

import type { WorkflowOperationRowResult } from "@/bindings/commands"
import {
  OCR_RETRY_KEY_SUFFIX,
} from "./ai-job"
import { requestStop, setCardContext } from "./execution-context"
import {
  advanceBusyClock,
  busy,
  COMPLETION,
  FIXED_TAGS,
  grantedClaim,
  ocrRecoveryView,
  RECOGNISED,
  ROW,
  windowCalls,
  withStubbedDevice,
} from "./executor-test-support"
import { record } from "./ai-job-test-support"

// Load WASM before mocked retry timers advance the workflow clock.
before(async () => { await sharedListingCore().issueManifest() })

test("an OCR 429 is waited out under the same key: one purchase, the row does not fail", async (t) => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const JOB_KEY = "recognize:v1:row-1:9:ai:v2:source-sha:prompt-sha:browser-image-v1_ocr-v1"
  let refusals = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: JOB_KEY, payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      refusals += 1
      if (refusals === 1) return busy(429, "当前工作空间的 AI 并发已达上限，请稍后重试")
      if (refusals === 2) return busy(429, "该 Workspace 的并发预算已用尽，请稍后重试")
      return COMPLETION
    }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const progress: WorkflowOperationRowResult[] = []
    const [result] = await advanceBusyClock(t, () => withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize", row => progress.push(row)),
    ))
    assert.equal(result!.error, undefined, "a busy ceiling is a wait, not a row failure")
    assert.equal(result!.outcome, "start")
    const keys = stub.calls
      .filter((call) => call.url.endsWith("/ocr/completions"))
      .map((call) => call.headers["Idempotency-Key"])
    assert.deepEqual(keys, [JOB_KEY, JOB_KEY, JOB_KEY], "a 429 bought nothing, so the key never changes")
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ai/settle")).length, 1)
    assert.ok(progress.some(row => row.preparation_progress?.some(entry => entry.stage === "ai" && entry.state === "waiting")))
    assert.ok(progress.some(row => row.preparation_progress?.some(entry => entry.stage === "ai" && entry.state === "running" && entry.message === "正在识别图片")))
  } finally {
    stub.restore()
  }
})

test("persistent OCR busy retries the same purchase key without reclaiming the job", async (t) => {
  let posts = 0
  const keys: string[] = []
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "busy-ai", idempotency_key: "busy-key", kind: "ai.recognize", payload: {
        source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" },
      } }],
    }
    if (call.url.endsWith("/ocr/completions")) {
      posts += 1
      keys.push(call.headers["Idempotency-Key"]!)
      if (posts <= 4) return new Response(JSON.stringify({ code: "BUSY", error: "busy" }), {
        status: 429, headers: { "Retry-After": "1" },
      })
      return COMPLETION
    }
    return RECOGNISED
  }, grantedClaim)
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await advanceBusyClock(t, () => withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize")))
    assert.equal(result?.error, undefined)
    assert.deepEqual(keys, ["busy-key", "busy-key", "busy-key", "busy-key", "busy-key"])
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/settle")).length, 1)
    assert.equal(windowCalls(stub.calls).length, 1, "busy retry must not re-claim the job")
  } finally {
    stub.restore()
  }
})

test("OCR busy wait keeps the lease alive across 30 seconds and Stop prevents a second purchase", { timeout: 5_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
  let now = 0
  t.mock.method(performance, "now", () => now)
  let waiting!: () => void
  const busyWait = new Promise<void>(resolve => { waiting = resolve })
  let posts = 0
  let heartbeats = 0
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) return {
      outcome: "running",
      jobs: [{ id: "long-busy-ai", idempotency_key: "long-busy-key", kind: "ai.recognize", payload: {
        source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" },
      } }],
    }
    if (call.url.endsWith("/ocr/completions")) {
      posts += 1
      return new Response(JSON.stringify({ code: "BUSY", error: "busy" }), {
        status: 429, headers: { "Retry-After": "35" },
      })
    }
    return RECOGNISED
  }, grantedClaim, () => {
    heartbeats += 1
    return true
  })
  try {
    const { runRows } = await import("./run-rows")
    const running = withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize", row => {
      if (row.preparation_progress?.some(entry => entry.stage === "ai" && entry.state === "waiting")) waiting()
    }))
    await busyWait
    // Advance both the lease deadline clock and timers, allowing each renewal to finish.
    while (now < 31_000) {
      now += 250
      t.mock.timers.tick(250)
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    requestStop([ROW.id])
    t.mock.timers.tick(250)
    const [result] = await running
    assert.equal(result?.outcome, "noop")
    assert.equal(posts, 1, "Stop during Retry-After must prevent a second OCR purchase")
    assert.ok(heartbeats >= 3, `heartbeats: ${heartbeats}`)
    assert.equal(windowCalls(stub.calls).length, 1, "busy wait must keep the original claim")
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/fail")), false)
  } finally {
    requestStop([ROW.id])
    stub.restore()
  }
})

test("stop while waiting on a busy OCR ceiling ends the row as cancelled, not failed", async () => {
  setCardContext({ psdTemplateSha256: "template-sha" })
  const stub = record((call) => {
    if (call.url.endsWith("/prepare")) {
      return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", aggregate_id: "row-1", aggregate_type: "listing_row", input_revision: 9, state: "queued", attempt: 0, idempotency_key: "job-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "识图提示词" } }, updated_at_ms: 0 }] }
    }
    if (call.url.endsWith("/ocr/completions")) {
      requestStop(["row-1"])
      return busy(429, "当前工作空间的 AI 并发已达上限，请稍后重试")
    }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: ["row-1"], expected_revisions: [{ row_id: "row-1", revision: 9 }] }, "recognize"),
    )
    assert.equal(result!.noop_reason, "cancelled")
    assert.equal(result!.error, undefined)
    assert.equal(stub.calls.filter((call) => call.url.endsWith("/ocr/completions")).length, 1)
  } finally {
    stub.restore()
  }
})

test("OCR timeout recovers a settled usable purchase through GET include and does not fail the job", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", idempotency_key: "recover-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    if (call.url.endsWith("/ocr/completions") && call.method === "POST") throw new TypeError("The operation was aborted.")
    if (call.url.includes("include=ocrRecovery")) {
      return { ...ROW, ocr_recovery: ocrRecoveryView([
        { attempt: "original", status: "settled", requestId: "air-purchase", resultUsable: true },
        { attempt: "contract_retry", status: "absent" },
      ]) }
    }
    if (call.url.endsWith("/ai/fail")) throw new Error("timeout must not fail the job")
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, revision: 10 }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    assert.equal(result?.product?.lifecycle.revision, 10)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/settle")).length, 1)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/fail")), false)
    assert.ok(stub.calls.some(call => call.url.includes("include=ocrRecovery")))
  } finally { stub.restore() }
})

test("OCR recovery posts the contract retry when original is settled and unusable", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", idempotency_key: "recover-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    if (call.url.endsWith("/ocr/completions") && call.method === "POST") {
      if (call.headers["Idempotency-Key"] === `recover-key${OCR_RETRY_KEY_SUFFIX}`) return COMPLETION
      throw new TypeError("The operation was aborted.")
    }
    if (call.url.includes("include=ocrRecovery")) {
      return { ...ROW, ocr_recovery: ocrRecoveryView([
        { attempt: "original", status: "settled", requestId: "air-bad", resultUsable: false },
        { attempt: "contract_retry", status: "absent" },
      ]) }
    }
    if (call.url.endsWith("/ai/settle")) return { ...RECOGNISED, revision: 10 }
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    const posts = stub.calls.filter(call => call.url.endsWith("/ocr/completions") && call.method === "POST")
    assert.deepEqual(posts.map(call => call.headers["Idempotency-Key"]), ["recover-key", `recover-key${OCR_RETRY_KEY_SUFFIX}`])
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/settle")).length, 1)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/fail")), false)
  } finally { stub.restore() }
})

test("OCR recovery pauses on unbilled_unknown without failing the job", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", idempotency_key: "recover-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    if (call.url.endsWith("/ocr/completions") && call.method === "POST") {
      return new Response(JSON.stringify({ code: "UPSTREAM_UNKNOWN", error: "response lost" }), { status: 504 })
    }
    if (call.url.includes("include=ocrRecovery")) {
      return { ...ROW, ocr_recovery: ocrRecoveryView([
        { attempt: "original", status: "unbilled_unknown", requestId: "air-unknown" },
        { attempt: "contract_retry", status: "absent" },
      ]) }
    }
    if (call.url.endsWith("/ai/fail")) throw new Error("unbilled_unknown must not fail the job")
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/fail")), false)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/settle")), false)
  } finally { stub.restore() }
})

test("an upstream 429 arrives as a terminal 502 that pauses into recovery, never a busy retry", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", idempotency_key: "uncertain-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    if (call.url.endsWith("/ocr/completions") && call.method === "POST") {
      // The upstream 429 landed `unbilled_unknown`, so the
      // answer is a terminal 502 with the new-key instruction; the
      // Retry-After hint rides along without borrowing the busy shape (D5).
      return new Response(JSON.stringify({
        code: "UPSTREAM_FAILED",
        error: "AI 上游返回 HTTP 429。本次未计费，请更换新的 Idempotency-Key 重试",
      }), { status: 502, headers: { "Retry-After": "2" } })
    }
    if (call.url.includes("include=ocrRecovery")) {
      return { ...ROW, ocr_recovery: ocrRecoveryView([
        { attempt: "original", status: "unbilled_unknown", requestId: "air-unknown" },
        { attempt: "contract_retry", status: "absent" },
      ]) }
    }
    if (call.url.endsWith("/ai/fail")) throw new Error("an uncertain upstream must not fail the job")
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const progress: WorkflowOperationRowResult[] = []
    const [result] = await withStubbedDevice(() =>
      runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize", row => progress.push(row)),
    )
    assert.equal(result?.error, undefined, "an uncertain upstream pauses the row, it does not fail it")
    const posts = stub.calls.filter(call => call.url.endsWith("/ocr/completions") && call.method === "POST")
    assert.deepEqual(posts.map(call => call.headers["Idempotency-Key"]), ["uncertain-key"],
      "one purchase: no same-key busy retry despite Retry-After, no new-key re-buy")
    assert.ok(stub.calls.some(call => call.url.includes("include=ocrRecovery")), "the pause goes through the recovery view")
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/settle")), false)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/fail")), false)
    assert.ok(progress.some(row => row.preparation_progress?.some(entry => entry.stage === "ai" && entry.state === "waiting")),
      "the existing unbilled waiting feedback carries the pause")
  } finally { stub.restore() }
})

test("a same-key replay over a terminal-unbilled purchase pauses into recovery instead of failing the job", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "job-1", kind: "ai.recognize", idempotency_key: "ended-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    if (call.url.endsWith("/ocr/completions") && call.method === "POST") {
      // Cloud's already-terminal answer for the same key:
      // the purchase ended `unbilled_unknown`, a new key is required.
      return new Response(JSON.stringify({
        code: "REQUEST_UNBILLED_UNKNOWN",
        error: "相同 Idempotency-Key 的请求已结束（unbilled_unknown），请换用新的 Key",
      }), { status: 409 })
    }
    if (call.url.includes("include=ocrRecovery")) {
      return { ...ROW, ocr_recovery: ocrRecoveryView([
        { attempt: "original", status: "unbilled_unknown", requestId: "air-unknown" },
        { attempt: "contract_retry", status: "absent" },
      ]) }
    }
    if (call.url.endsWith("/ai/fail")) throw new Error("a terminal-unbilled replay must not fail the job")
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.error, undefined, "the needs-new-key signal pauses, it does not fail")
    const posts = stub.calls.filter(call => call.url.endsWith("/ocr/completions") && call.method === "POST")
    assert.deepEqual(posts.map(call => call.headers["Idempotency-Key"]), ["ended-key"], "no re-purchase under any key")
    assert.ok(stub.calls.some(call => call.url.includes("include=ocrRecovery")))
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/settle")), false)
    assert.equal(stub.calls.some(call => call.url.endsWith("/ai/fail")), false)
  } finally { stub.restore() }
})

test("Stop during a lost OCR response does not fail the job", async () => {
  const stub = record(call => {
    if (call.url.endsWith("/prepare")) return { outcome: "running", jobs: [{ id: "stopped-paid", kind: "ai.recognize", idempotency_key: "paid-key", payload: { source_sha256: "source-sha", recognition_prompt: { fixed_tags: FIXED_TAGS, content: "prompt" } } }] }
    if (call.url.endsWith("/ocr/completions") && call.method === "POST") {
      requestStop([ROW.id])
      return new Response(JSON.stringify({ code: "UPSTREAM_UNKNOWN", error: "response lost" }), { status: 504 })
    }
    if (call.url.includes("include=ocrRecovery")) {
      return { ...ROW, ocr_recovery: ocrRecoveryView([
        { attempt: "original", status: "settled", requestId: "air-purchase", resultUsable: true },
        { attempt: "contract_retry", status: "absent" },
      ]) }
    }
    if (call.url.endsWith("/ai/fail")) throw new Error("stop after a paid OCR must not fail the job")
    if (call.url.endsWith("/ai/settle")) return RECOGNISED
    return ROW
  })
  try {
    const { runRows } = await import("./run-rows")
    const [result] = await withStubbedDevice(() => runRows({ row_ids: [ROW.id], expected_revisions: [] }, "recognize"))
    assert.equal(result?.noop_reason, "cancelled")
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ocr/completions") && call.method === "POST").length, 1)
    assert.equal(stub.calls.filter(call => call.url.endsWith("/ai/fail")).length, 0)
  } finally { stub.restore() }
})

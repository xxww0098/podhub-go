import assert from "node:assert/strict"
import test from "node:test"

import {
  bindListingRows,
  configureListingLogTransport,
  flushListingLogs,
  listingFailureModule,
  listingRowFailureStage,
  listingLog,
  noteListingRow,
  releaseListingBatch,
  resetListingLogForTests,
  sanitizeMessage,
  setListingLogCollect,
} from "./listing-log"

const ROW = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const BATCH = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const INTENT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
const PSD = `sha256:${"ab".repeat(32)}`

function capture() {
  resetListingLogForTests()
  const posts: string[] = []
  configureListingLogTransport({
    post: async (_url, body) => {
      posts.push(body)
      return 200
    },
    beacon: () => false,
    online: () => true,
    schedule: (run) => run(),
  })
  return posts
}

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

test("a closed switch buffers nothing and sends nothing", async () => {
  const posts = capture()
  bindListingRows(BATCH, [ROW])
  listingLog({ module: "render", event: "render.end", rowId: ROW, durationMs: 4 })
  flushListingLogs("batch")
  await settled()
  assert.equal(posts.length, 0)
})

test("one flush carries the listing ids and drops secrets", async () => {
  const posts = capture()
  setListingLogCollect(true)
  bindListingRows(BATCH, [ROW], { psdId: PSD })
  noteListingRow(ROW, { offerId: "SKU-1", intentId: INTENT, jobId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" })
  listingLog({ module: "render", event: "render.end", rowId: ROW, durationMs: 12.6 })
  listingLog({ module: "upload", event: "upload.end", rowId: ROW, fields: { slices: 2, bytes: 100 } })
  noteListingRow(ROW, { offerId: "sku?X-Amz-Signature=abc" })
  listingLog({ module: "submit", event: "submit.end", rowId: ROW, level: "info", errorCode: "operation_failed", fields: { outcome: "accepted", refusal: "operation_failed" } })
  listingLog({ module: "prepare", event: "row.fail", rowId: ROW, level: "info", errorCode: "workflow_template_missing", fields: { refusal: "missing_template", stage: "render" } })
  flushListingLogs("batch")
  await settled()
  assert.equal(posts.length, 1)
  const body = JSON.parse(posts[0]!) as { records: Array<Record<string, unknown>> }
  assert.equal(body.records.length, 4)
  const render = body.records[0]!
  assert.equal(render.batchId, BATCH)
  assert.equal(render.rowId, ROW)
  assert.equal(render.offerId, "SKU-1")
  assert.equal(render.intentId, INTENT)
  assert.equal(render.psdId, PSD)
  assert.equal(render.durationMs, 13)
  assert.equal((body.records[1]!.fields as { slices: number }).slices, 2)
  const submit = body.records[2]!
  assert.equal(submit.offerId, "SKU-1")
  assert.equal(submit.errorCode, undefined)
  assert.equal((submit.fields as { outcome: string; refusal?: string }).outcome, "accepted")
  assert.equal((submit.fields as { refusal?: string }).refusal, undefined)
  const failed = body.records[3]!
  assert.equal(failed.errorCode, "workflow_template_missing")
  assert.equal((failed.fields as { refusal: string }).refusal, "missing_template")
  releaseListingBatch(BATCH)
  listingLog({ module: "verify", event: "verify.end", rowId: ROW })
  flushListingLogs("batch")
  await settled()
  const follow = JSON.parse(posts[1]!) as { records: Array<Record<string, unknown>> }
  assert.equal(follow.records[0]!.batchId, BATCH)
  assert.equal(follow.records[0]!.intentId, INTENT)
})

test("upload.end keeps phase times and drops an unknown network label", async () => {
  const posts = capture()
  setListingLogCollect(true)
  listingLog({
    module: "upload", event: "upload.end", rowId: ROW, durationMs: 11000,
    fields: {
      slices: 4, bytes: 2_300_000, presignMs: 300, putMs: 9000, completeMs: 1200,
      concurrency: 4, effectiveType: "4g",
    },
  })
  listingLog({
    module: "upload", event: "upload.end", rowId: ROW,
    fields: { effectiveType: "5g", concurrency: 0 },
  })
  flushListingLogs("batch")
  await settled()
  const body = JSON.parse(posts[0]!) as { records: Array<{ fields?: Record<string, unknown> }> }
  assert.equal(body.records.length, 2)
  const phases = body.records[0]!.fields!
  assert.equal(phases.presignMs, 300)
  assert.equal(phases.putMs, 9000)
  assert.equal(phases.completeMs, 1200)
  assert.equal(phases.concurrency, 4)
  assert.equal(phases.effectiveType, "4g")
  assert.equal(body.records[1]!.fields, undefined)
})

test("media failures keep the stage that actually stopped", () => {
  assert.equal(listingFailureModule("media.render", "workflow_template_missing"), "bind")
  assert.equal(listingFailureModule("media.render", "workflow_source_missing"), "bind")
  assert.equal(listingFailureModule("media.upload", "workflow_render_missing"), "upload")
  assert.equal(listingFailureModule("media.render", "workflow_render_incomplete"), "render")
})

test("an OCR contract failure is logged as recognition, not upload", () => {
  assert.equal(listingRowFailureStage("media.upload", "OCR_CONTRACT_VIOLATION"), "ai")
  assert.equal(listingRowFailureStage("media.upload", "cloud_ocr_contract_violation"), "ai")
  assert.equal(listingRowFailureStage("ai.recognize", "workflow_ai_result_unusable"), "ai")
  assert.equal(listingRowFailureStage("media.upload", "workflow_render_missing"), "media.upload")
})

test("sanitizeMessage removes urls and credential-shaped spans", () => {
  const text = sanitizeMessage("see https://cdn.example/a?sig=1 bearer abc\npassword=no")
  assert.ok(text)
  assert.equal(text!.includes("sig"), false)
  assert.equal(text!.includes("bearer"), false)
  assert.equal(text!.includes("password"), false)
  assert.equal(text!.includes("[omitted]"), true)
})

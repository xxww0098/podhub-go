import assert from "node:assert/strict"
import test from "node:test"
import { product } from "../cloud-fanout-tests/fixtures"
import { emptyListingWorkbench } from "../workbench/listing-workbench-store"
import type { ListingRow } from "../model/listing-row"
import { blockedPublishMessage, projectPublishResults } from "./publish-queue-results"
import type { OzonRowResult } from "./send-ozon-transport"

function state() {
  const rows: ListingRow[] = ["row", "different-offer", "other-store"].map((id) => ({ id, draftId: id, imageName: `${id}.png`,
    status: "ready", ai: "done", render: "done", upload: "done", log: "before" }))
  const bases = Object.fromEntries(rows.map((row) => [row.id, { ...product(row.id), target_store_id: row.id === "other-store" ? "other" : "store" }]))
  return { ...emptyListingWorkbench(), cardId: "card", rows, productBases: bases, productDrafts: bases, queueFrozenIds: ["row", "different-offer"] }
}
const error = { code: "cloud_offer_busy", message: "one offer conflicts", remediation: "check original operation",
  requestCause: { kind: "request_refusal" as const, scope: "request" as const, storeId: "store", rowIds: ["row", "different-offer"],
    status: 409, serverCode: "offer_busy", admission: "offer_busy" as const, traceId: "block-trace" } }

test("request-level 409 projects only attempted rows with whole-block evidence and preserves existing locks and budget membership", () => {
  const before = state()
  before.rows[1]!.publishUnconfirmed = true
  const results: OzonRowResult[] = ["row", "different-offer"].map((row_id) => ({ row_id, outcome: "blocked", blockers: [], error }))
  const logs = new Map(results.map((result) => [result.row_id, blockedPublishMessage(result)]))
  const projected = projectPublishResults(before, before, results, logs, before.queueFrozenIds)
  for (const row of projected.rows!.slice(0, 2)) {
    assert.match(row.log, /整块未入队.*不表示.*每个货号都冲突/)
    assert.deepEqual(row.publishRequestEvidence?.requestCause?.rowIds, ["row", "different-offer"])
    assert.equal(row.publishRequestEvidence?.identity.storeId, "store")
    assert.equal(row.publishRequestEvidence?.requestCause?.traceId, "block-trace")
  }
  assert.equal(projected.rows![1]!.publishUnconfirmed, true)
  assert.equal(projected.rows![2], before.rows[2])
  assert.deepEqual(projected.queueFrozenIds, before.queueFrozenIds)
  assert.equal(projected.productDrafts!['different-offer'], before.productBases['different-offer'])
})

test("unconfirmed transport projects lifecycle exception rather than failure and never opens another send", () => {
  const before = state()
  const result: OzonRowResult = { row_id: "row", outcome: "unknown", blockers: [], error: { ...error,
    requestCause: { kind: "result_unconfirmed", scope: "request", storeId: "store", rowIds: ["row"], traceId: "unknown-trace" } } }
  const projected = projectPublishResults(before, before, [result], new Map(), before.queueFrozenIds)
  assert.equal(projected.rows![0]!.status, "exception")
  assert.equal(projected.rows![0]!.stage, "outcome_unknown")
  assert.equal(projected.rows![0]!.publishUnconfirmed, true)
  assert.equal(projected.productDrafts!.row!.lifecycle.stage, "outcome_unknown")
  assert.equal(projected.rows![0]!.publishRequestEvidence?.requestCause?.traceId, "unknown-trace")
  assert.match(projected.rows![0]!.log, /未确认.*不要重复发送/)
  assert.equal(projected.rows![1], before.rows[1])
})

test("newer Cloud versions and foreign stores cannot receive a stale request error", () => {
  const before = state()
  for (const change of [{ view_revision: 2 }, { revision: 2 }]) {
    const current = { ...before, productBases: { ...before.productBases, row: { ...before.productBases.row!,
      lifecycle: { ...before.productBases.row!.lifecycle, ...change } } } }
    assert.equal(projectPublishResults(current, before, [{ row_id: "row", outcome: "blocked", blockers: [], error }], new Map(), ["row"]).rows![0], before.rows[0])
  }
  const current = { ...before, productBases: { ...before.productBases, row: { ...before.productBases.row!, target_store_id: "foreign" } } }
  assert.equal(projectPublishResults(current, before, [{ row_id: "row", outcome: "blocked", blockers: [], error }], new Map(), ["row"]).rows![0], before.rows[0])
})

test("the hook's own committed Cloud projection retains diagnostic evidence without allowing an unrelated SSE transition", () => {
  const before = state()
  const status = { target_store_id: "store", lifecycle: { ...before.productBases.row!.lifecycle, view_revision: 2 },
    readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish" as const] } }
  const result: OzonRowResult = { row_id: "row", outcome: "blocked", blockers: [], product: status, error }
  const current = { ...before, productBases: { ...before.productBases, row: { ...before.productBases.row!, lifecycle: status.lifecycle } } }
  const own = projectPublishResults(current, before, [result], new Map(), before.queueFrozenIds)
  assert.equal(own.rows![0]!.publishRequestEvidence?.identity.viewRevision, 2)
  assert.equal(own.rows![0]!.publishRequestEvidence?.requestCause?.traceId, "block-trace")
  const sse = { ...current, productBases: { ...current.productBases, row: { ...current.productBases.row!, lifecycle: { ...status.lifecycle } } } }
  assert.equal(projectPublishResults(sse, before, [result], new Map(), ["row"]).rows![0], before.rows[0])
})

test("a departed workbench cannot receive an old cohort or fabricated cross-Store request scope", () => {
  const before = state()
  assert.deepEqual(projectPublishResults(state(), before, [], new Map(), before.queueFrozenIds), {})
  const result: OzonRowResult = { row_id: "row", outcome: "blocked", blockers: [], error: { ...error,
    requestCause: { ...error.requestCause, rowIds: ["row", "other-store"] } } }
  const projected = projectPublishResults(before, before, [result], new Map(), ["row", "other-store"])
  assert.equal(projected.rows![0]!.publishRequestEvidence?.contractInvalid, true)
  assert.equal(projected.rows![0]!.publishRequestEvidence?.requestCause, undefined)
  assert.equal(projected.rows![2], before.rows[2])
})

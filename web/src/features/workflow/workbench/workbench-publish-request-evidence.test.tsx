import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { publishRepairFixture } from "../product-instances-test-fixtures"
import { nativeRowView, serve } from "../submit/send-test-support"
import { projectPublishResults, blockedPublishMessage } from "../submit/publish-queue-results"
import type { OzonRowResult } from "../submit/send-ozon-transport"
import { rowStatusView } from "../model/row-state"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { capturePublishRequestEvidence } from "../model/publish-request-evidence"
import { projectOzonListingIssue } from "../submit/ozon-admission-refusal"
import { PublishStateCell } from "./workbench-publish-state-cell"
import { patchListingWorkbench, peekListingWorkbench } from "./listing-workbench-store"
import { listingProjection } from "../../../../tests/listing-row-fixture"

function render(id: string) {
  const state = peekListingWorkbench(), row = state.rows.find((row) => row.id === id)!
  return renderToStaticMarkup(<PublishStateCell row={row} inView lifecycle={state.productBases[row.draftId]!.lifecycle}
    rowStoreLabel={state.productBases[row.draftId]!.target_store_id}
    onCancelIntent={() => {}} onReviewCandidates={() => {}} onRetryStage={() => {}} onRepairBrand={() => {}} />)
}
const busy = { code: "cloud_offer_busy", message: "one offer conflicts", remediation: "old per-offer retry",
  requestCause: { kind: "request_refusal" as const, scope: "request" as const, storeId: "store", rowIds: ["row", "different-offer"],
    status: 409, serverCode: "offer_busy", admission: "offer_busy" as const, traceId: "raw-safe-request-trace" } }

test("mixed-offer result evidence reaches both persistent cells with whole-block scope and identical trace; other Store stays unchanged", async () => {
  const fx = await publishRepairFixture()
  const cloud = serve(() => { throw new Error("presentation must stay local") })
  try {
    const other = nativeRowView("different-offer", { revision: 1, cardId: "card", storeId: "store" })
    const foreign = nativeRowView("other-store", { revision: 1, cardId: "card", storeId: "other" })
    rememberListingRows([other, foreign], rowCacheScope())
    patchListingWorkbench((state) => ({ rows: [...state.rows, { ...fx.row, id: other.id, draftId: other.id }, { ...fx.row, id: foreign.id, draftId: foreign.id }],
      productDrafts: { ...state.productBases, [other.id]: { ...state.productBases.row!, ...rowStatusView(other) },
        [foreign.id]: { ...state.productBases.row!, ...rowStatusView(foreign) } }, queueFrozenIds: [...busy.requestCause.rowIds] }))
    const before = peekListingWorkbench()
    const results: OzonRowResult[] = busy.requestCause.rowIds.map((row_id) => ({ row_id, outcome: "blocked", blockers: [], error: busy }))
    patchListingWorkbench(projectPublishResults(before, before, results, new Map(results.map((result) => [result.row_id, blockedPublishMessage(result)])), before.queueFrozenIds))
    for (const id of busy.requestCause.rowIds) {
      const html = render(id)
      assert.match(html, /<details[^>]*data-slot="publish-remediation"/)
      assert.match(html, /原因.*整块未入队.*不表示.*每个货号都冲突.*影响范围.*原店铺 store.*整块 2 件/s)
      assert.match(html, /已受理的商品.*在途发送.*结果未确认.*确切.*Intent ID.*重新读回.*原生校验.*用户明确发送/s)
      assert.match(html, /<dt[^>]*>请求追踪编号<\/dt><dd[^>]*>raw-safe-request-trace<\/dd>/)
      assert.match(html, /<button[^>]*>复制诊断信息<\/button>/)
      assert.doesNotMatch(html, /<dt[^>]*>诊断编号<\/dt>|完整 payload SHA-256|上报诊断/)
      assert.equal(peekListingWorkbench().rows.find((row) => row.draftId === id)?.publishDiagnostic?.diagnosticId, undefined)
      assert.doesNotMatch(html, /one offer conflicts|old per-offer retry|修复品牌字段|role="alert"/)
    }
    assert.equal(peekListingWorkbench().rows[2], before.rows[2])
    assert.doesNotMatch(render("other-store"), /整块未入队|raw-safe-request-trace/)
    assert.equal(cloud.calls.length, 0)
  } finally { cloud.restore(); fx.restore() }
})

test("request diagnostics without ListingIssue freshness never create a brand repair affordance", async () => {
  const fx = await publishRepairFixture()
  try {
    const state = peekListingWorkbench()
    const issue = fx.raw.projection.submission_issue!
    const evidence = capturePublishRequestEvidence({ code: issue.code, message: issue.summary, remediation: issue.remediation,
      // The transport hands the transport-local projection, not the raw wire issue, to this evidence.
      listingIssue: projectOzonListingIssue(issue) }, { scope: state.scope, mediaEpoch: state.mediaEpoch, cardId: "card", storeId: "store", rowId: "row", revision: 1, viewRevision: 1 })!
    // Even when a renderer holds an old repair callback, diagnostics are not permission.
    patchListingWorkbench({ rows: [{ ...fx.row, publishRequestEvidence: evidence }], productDrafts: {
      row: { ...state.productBases.row!, lifecycle: { ...state.productBases.row!.lifecycle, submission_issue: undefined } },
    } })
    const html = render("row")
    assert.match(html, /接口合同不符/)
    assert.match(html, /<dt[^>]*>请求追踪编号<\/dt><dd[^>]*>test-trace<\/dd>/)
    assert.match(html, /<button[^>]*>复制诊断信息<\/button>/)
    assert.doesNotMatch(html, /<dt[^>]*>诊断编号<\/dt>|完整 payload SHA-256|上报诊断/)
    assert.equal(peekListingWorkbench().rows[0]!.publishDiagnostic?.diagnosticId, undefined)
    assert.doesNotMatch(html, /修复品牌字段|role="alert"/)
    assert.equal(evidence.listingIssue?.summary, issue.summary)
    assert.equal(evidence.listingIssue?.remediation, issue.remediation)
  } finally { fx.restore() }
})

test("400 media group removal and save steps survive in persistent request details", async () => {
  const fx = await publishRepairFixture()
  try {
    const before = peekListingWorkbench()
    const result: OzonRowResult = { row_id: "row", outcome: "blocked", blockers: [], error: {
      code: "cloud_validation", message: "系统媒体组 product_video 不能加入默认字段", remediation: "从默认字段移除 product_video 组并重新保存",
      requestCause: { kind: "request_refusal", scope: "request", storeId: "store", rowIds: ["row"], status: 400, serverCode: "validation", traceId: "media-trace" },
    } }
    patchListingWorkbench(projectPublishResults(before, before, [result], new Map([["row", blockedPublishMessage(result)]]), before.queueFrozenIds))
    const html = render("row")
    assert.match(html, /原因.*系统媒体组 product_video 不能加入默认字段.*处理步骤.*移除 product_video 组并重新保存/s)
    assert.match(html, /<dt[^>]*>请求追踪编号<\/dt><dd[^>]*>media-trace<\/dd>/)
    assert.match(html, /<button[^>]*>复制诊断信息<\/button>/)
    assert.doesNotMatch(html, /<dt[^>]*>诊断编号<\/dt>|完整 payload SHA-256|上报诊断/)
    assert.equal(peekListingWorkbench().rows[0]!.publishDiagnostic?.diagnosticId, undefined)
    assert.doesNotMatch(html, /role="alert"|发送未提交，请重试/)
  } finally { fx.restore() }
})

test("unknown authority preserves its lock and diagnostics, then a newer accepted projection ignores old request evidence", async () => {
  const fx = await publishRepairFixture()
  try {
    const before = peekListingWorkbench()
    const result: OzonRowResult = { row_id: "row", outcome: "unknown", blockers: [], error: { ...busy,
      requestCause: { kind: "result_unconfirmed", scope: "request", storeId: "store", rowIds: ["row"], traceId: "unknown-trace" } } }
    patchListingWorkbench(projectPublishResults(before, before, [result], new Map(), before.queueFrozenIds))
    let html = render("row")
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    assert.equal(peekListingWorkbench().rows[0]!.status, "exception")
    assert.match(html, /未确认.*不要重新发送.*unknown-trace/s)
    assert.doesNotMatch(html, /修复品牌字段|重试切片|重试上传/)
    const accepted = { ...fx.raw, viewRevision: 2, projection: listingProjection({ stage: "accepted" }) }
    rememberListingRows([accepted], rowCacheScope())
    const acceptedStatus = rowStatusView(accepted)
    patchListingWorkbench((state) => ({
      rows: state.rows.map((row) => row.id === "row" ? projectListingRowLifecycle(row, acceptedStatus.lifecycle, acceptedStatus.readiness) : row),
      productDrafts: { row: { ...state.productBases.row!, ...acceptedStatus } },
    }))
    html = render("row")
    assert.doesNotMatch(html, /unknown-trace|解决此行发布问题|整块未入队/)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, false, "an accepted server stage clears the local fence")
  } finally { fx.restore() }
})

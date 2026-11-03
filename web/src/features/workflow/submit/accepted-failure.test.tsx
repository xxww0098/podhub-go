import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { readListingRowFresh } from "@/bindings/listing-row-cache"
import { listingProjection, listingRow } from "../../../../tests/listing-row-fixture"
import { preparationOpen, sendBatchEligible } from "../batch-actions"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { resolvePublishRemediation } from "../model/publish-remediation"
import { rowStatusView } from "../model/row-state"
import { PublishStateCell } from "../workbench/workbench-publish-state-cell"
import { factFromIntent } from "./queue/authority"
import { createSendQueue } from "./send-queue"
import { cloudRowResult } from "./send-ozon-transport"
import { finalQueueHarness, prepareQueueRows } from "./send-test-support"

const issue: NonNullable<ListingIntent["current_issue"]> = {
  phase: "submit", scope: "row", code: "OZON_ROW_REJECTED", summary: "Ozon 异步导入失败，请检查商品字段。",
  remediation: "请在卖家后台核对处理，勿重复发送。", allowed_actions: [], trace_id: "async-failure",
  endpoint: "/v1/product/import/info", safe_message: "", dispatch_evidence: "rejected",
  intent_id: "async-intent", input_revision: 7, request_hash: "digest", row_id: "async-row", store_id: "store",
  credential_revision: 1, retry_after_fallback: false, created_at_ms: 1,
}
const receipt = { batch_id: "accepted-batch", item_count: 1, http_status: 200, response_body: '{"result":{"task_id":42}}' }
const intent: ListingIntent = {
  id: issue.intent_id, listing_row_id: issue.row_id, store_id: issue.store_id, row_revision: 7,
  client_operation_id: "accepted-operation", state: "accepted", external_task_id: "42", can_resume: false,
  current_issue_status: "present", current_issue: issue, submission_issues: [issue], last_error_code: issue.code,
  submission_receipt_status: "valid", submission_receipt: receipt, updated_at_ms: 2,
}

test("a fresh accepted row readback shows its current async failure without unsealing or inventing on-sale state", async () => {
  const wire = listingRow({ id: issue.row_id, revision: 7, view_revision: 9, store_id: issue.store_id,
    submission_state: "accepted", projection: listingProjection({ stage: "accepted", current_issue_status: "present",
      submission_issue: issue, error_code: issue.code, error_detail: issue.summary, run_id: intent.id,
      task_id: "42", sku: 123, submission_receipt: receipt, submission_receipt_status: "valid", can_resume: false,
      readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [] },
    }),
  })
  const previous = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input, init) => {
    requests.push(String(input))
    assert.equal(init?.method ?? "GET", "GET", "readback must not dispatch")
    assert.equal(String(input), `${route("listingRows")}/${issue.row_id}`)
    return Response.json({ data: wire })
  }
  try {
    const status = rowStatusView(await readListingRowFresh(issue.row_id))
    const row = projectListingRowLifecycle({ id: issue.row_id, draftId: issue.row_id, imageName: "failed.jpg", status: "sent",
      ai: "done", render: "done", upload: "done", log: "" }, status.lifecycle, status.readiness)
    assert.equal(status.lifecycle.stage, "accepted")
    assert.deepEqual(status.lifecycle.submissionReceipt, receipt)
    assert.equal(status.lifecycle.taskId, "42")
    assert.equal(row.status, "sent", "the accepted receipt remains a fact")
    assert.equal(preparationOpen(status.lifecycle), false)
    assert.equal(sendBatchEligible(row, status.lifecycle), false)
    const remediation = resolvePublishRemediation({ lifecycle: status.lifecycle, rowLog: "", brandRepairable: true })!
    assert.equal(remediation.reason, issue.summary)
    assert.equal(remediation.action, undefined)
    assert.match(remediation.steps.join(""), /勿重复发送/)
    const html = renderToStaticMarkup(<PublishStateCell row={row} lifecycle={status.lifecycle} inView
      onCancelIntent={() => assert.fail("accepted cancellation")} onReviewCandidates={() => assert.fail("candidate action")}
      onRetryStage={() => assert.fail("accepted preparation retry")} onRepairBrand={() => assert.fail("accepted repair")} />)
    assert.match(html, /受理后未通过/)
    assert.match(html, /Ozon 异步导入失败，请检查商品字段。/)
    assert.match(html, /平台任务：42/)
    assert.match(html, /accepted-batch/)
    assert.match(html, /勿重复发送/)
    assert.doesNotMatch(html, /已在售|已上架|商品已创建|重试切片|修复品牌字段|取消发送/)
    const result = cloudRowResult({ row_id: issue.row_id, created: false, intent, row: wire })
    assert.equal(result.error?.message, issue.summary)
    assert.equal(result.product?.lifecycle.stage, "accepted")
    assert.equal(result.taskId, "42")
    assert.deepEqual(requests, [`${route("listingRows")}/${issue.row_id}`])
  } finally { globalThis.fetch = previous }
})

test("an accepted asynchronous failure retains the queue lock and never admits an explicit resend", async () => {
  const { rows, scope } = await finalQueueHarness()
  const current = { ...intent, listing_row_id: "r0", row_revision: 0, current_issue: { ...issue, row_id: "r0", input_revision: 0 } }
  const fact = factFromIntent(current)
  assert.equal(fact.state, "accepted")
  assert.equal(fact.code, "OZON_ROW_REJECTED")
  assert.equal(fact.taskId, 42)
  assert.equal(fact.canResume, false)
  assert.equal(fact.receipt, current)
  for (const revision of [undefined, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const invalid = factFromIntent({ ...current, row_revision: revision as unknown as number,
      current_issue: { ...current.current_issue, input_revision: revision as unknown as number } })
    assert.equal(invalid.state, "accepted", "the acceptance remains sealed")
    assert.equal(invalid.code, undefined, "invalid revisions cannot establish a current failure")
  }
  let sends = 0
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: {
    prepare: prepareQueueRows, bytes: () => 1, async send() { sends++; return new Map([["r0", fact]]) },
  } } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    const state = rows.cardState()!.publish!
    assert.equal(state.locks[0]?.state, "accepted")
    assert.equal(rows.get("r0")?.submission?.state, "accepted")
    await queue.retry(state.blocks[0]!.id)
    assert.equal(sends, 1)
    assert.equal(rows.cardState()!.publish!.locks[0]?.state, "accepted")
  } finally { await rows.close() }
})

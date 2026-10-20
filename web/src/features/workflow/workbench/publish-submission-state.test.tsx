import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { PublishSubmissionState, submissionStateCopy } from "./publish-submission-state"

const lifecycle: WorkflowProductLifecycle = {
  revision: 1, view_revision: 1, stage: "accepted", ai: "ready", media: "ready",
  fields: "valid", image_total: 1, image_completed: 1, images: [],
  failure_log: [], ai_candidates: [], product_videos: [],
}

test("business status follows durable phase, never HTTP success or a SKU alone", () => {
  for (const [stage, label, sku] of [
    ["accepted", "已受理", 0],
    ["accepted", "商品已创建", 123],
    ["publish_rejected", "发布失败", 123],
    ["outcome_unknown", "核对中", 123],
    ["operator_attested", "待核对", 123],
  ] as const) {
    assert.equal(submissionStateCopy({
      ...lifecycle, stage, ozon_sku: sku,
      submissionReceipt: { batch_id: "batch", item_count: 1, http_status: 200 },
    }).label, label)
  }
  assert.match(submissionStateCopy({ ...lifecycle, stage: "accepted", ozon_sku: 123 }).detail, /可售状态仍需核对/)
  const accepted = submissionStateCopy({ ...lifecycle, stage: "accepted" })
  assert.match(accepted.detail, /Ozon 已受理，后续审核与可售以卖家后台为准/)
  assert.doesNotMatch(accepted.detail, /正在处理/)
  assert.doesNotMatch(submissionStateCopy({ ...lifecycle, stage: "accepted", ozon_sku: 123 }).detail, /正在处理/)
})

test("raw receipt appears only in collapsed submission details", () => {
  const markup = renderToStaticMarkup(<PublishSubmissionState lifecycle={{
    ...lifecycle,
    submissionReceipt: {
      batch_id: "batch-uuid", item_count: 1, http_status: 200,
      response_body: '{"result":{"task_id":5666996254}}',
    },
  }} />)
  const beforeDetails = markup.slice(0, markup.indexOf("<details"))
  assert.match(beforeDetails, /已受理/)
  assert.doesNotMatch(beforeDetails, /HTTP|batch-uuid|5666996254/)
  assert.doesNotMatch(beforeDetails, /复制响应/)
  assert.match(markup.slice(markup.indexOf("<details")), /复制响应/)
  assert.doesNotMatch(markup, /<details[^>]*\bopen/)
  assert.match(markup, /查看提交详情/)
  assert.match(markup, /不代表商品已可售/)
  assert.doesNotMatch(markup, /解决此行发布问题/, "a normal acceptance stays concise")
})

test("an unresolved submission explains how to verify it and offers no send", () => {
  const markup = renderToStaticMarkup(<PublishSubmissionState
    rowLog="发送未执行：PSD 尚未云端保存或未绑定该类目，请重新绑定模板"
    lifecycle={{
      ...lifecycle, stage: "outcome_unknown", taskId: "5666996254", source_file_name: "SZ-0001.png",
      submissionReceipt: { batch_id: "batch-uuid", item_count: 1, http_status: 502, response_body: "gateway" },
    }}
  />)
  const first = markup.indexOf("<details")
  const guidance = markup.slice(first, markup.indexOf("<details", first + 1))
  assert.match(guidance, /解决此行发布问题/)
  assert.match(guidance, /影响范围/)
  assert.match(guidance, /按货号「SZ-0001」查找商品，并核对导入任务 5666996254/)
  assert.doesNotMatch(guidance, /PSD|<button/)
  assert.doesNotMatch(guidance, /gateway/, "the raw response stays in the receipt details")
  assert.equal((markup.match(/解决此行发布问题/g) ?? []).length, 1)
  // No automated correction exists: nothing may say the system will settle this row.
  assert.doesNotMatch(guidance, /等待系统对账|系统对账/)
  assert.match(guidance, /直接在 Ozon 卖家后台管理和核对该商品/)
  assert.match(guidance, /不会自动核实它是否可售/)
  assert.match(guidance, /保留此行及其提交记录.*不要重新发送/)
})

test("an attested submission gets the same manual steps and no action", () => {
  const markup = renderToStaticMarkup(<PublishSubmissionState lifecycle={{
    ...lifecycle, stage: "operator_attested", source_file_name: "SZ-0001.png",
    submissionReceipt: { batch_id: "batch-uuid", item_count: 1, http_status: 200, response_body: "{}" },
  }} />)
  const first = markup.indexOf("<details")
  const guidance = markup.slice(first, markup.indexOf("<details", first + 1))
  assert.match(guidance, /已人工封存，但尚未证明 Ozon 已上架/)
  assert.match(guidance, /按货号「SZ-0001」查找商品/)
  assert.match(guidance, /不会自动核实它是否可售/)
  assert.doesNotMatch(guidance, /<button|恢复待核对|系统对账/)
})

test("checking names the next read and does not offer another query", () => {
  const markup = renderToStaticMarkup(<PublishSubmissionState lifecycle={{
    ...lifecycle, stage: "outcome_unknown",
    last_error_detail: "已提交 Ozon，结果未返回。未取得响应；正在自动核对是否已创建，不会自动重发。已核对 2 次",
    importProbe: { phase: "checking", passes: 2, nextCheckAtMs: Date.UTC(2099, 0, 2, 3, 4) },
  }} />)
  assert.match(markup, /核对中/)
  assert.match(markup, /正在自动核对/)
  assert.match(markup, /下次核对/)
  assert.doesNotMatch(markup, /按货号再核对/)
  assert.doesNotMatch(markup, /需人工核对/)
})

test("a stopped probe asks for one read-only offer check", () => {
  const markup = renderToStaticMarkup(<PublishSubmissionState lifecycle={{
    ...lifecycle, stage: "outcome_unknown", run_id: "intent-1",
    last_error_detail: "需人工核对。已提交 Ozon，结果未返回，自动核对已停止。已核对 8 次，不会自动重发",
    importProbe: { phase: "needs_manual", passes: 8, nextCheckAtMs: Date.UTC(2099, 0, 2, 3, 4) },
  }} />)
  assert.match(markup, /需人工核对/)
  assert.match(markup, /自动核对已停止/)
  assert.doesNotMatch(markup, /下次核对/)
  assert.match(markup, /aria-label="按货号再核对一次，只查询不重发"/)
  const first = markup.indexOf("<details")
  const guidance = markup.slice(first, markup.indexOf("<details", first + 1))
  assert.doesNotMatch(guidance, /<button/)
})

test("a parent that owns the remediation suppresses the duplicate", () => {
  const rejected = { ...lifecycle, stage: "publish_rejected" as const, last_error_detail: "颜色属性无效" }
  assert.match(renderToStaticMarkup(<PublishSubmissionState lifecycle={rejected} />), /解决此行发布问题/)
  assert.doesNotMatch(
    renderToStaticMarkup(<PublishSubmissionState lifecycle={rejected} ownsRemediation={false} />),
    /解决此行发布问题/,
  )
})

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type {
  WorkflowOperationRowResult,
  WorkflowProductLifecycle,
} from "@/bindings/commands"
import { runWorkflowOperationBatch } from "../batch-operation"
import {
  canCancelPublishIntent,
  projectListingRowLifecycle,
} from "../model/listing-row-lifecycle"
import { FieldWorkbench } from "./field-workbench"
import { PublishStateCell } from "./workbench-publish-state-cell"
import {
  idleLifecycle,
  instance,
  needsPreparation,
  projection,
  row,
  schema,
  slice,
} from "./workbench-test-fixtures"
import { buttonMarkup, harness, workbenchProps } from "./workbench-test-harness"

test("only queued rows expose a real per-row send cancellation", () => {
  const queued = row(1, { status: "running" })
  const publishing = row(2, { status: "running" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[queued, publishing]}
      productDrafts={{
        [queued.draftId]: instance(queued, { ...idleLifecycle, stage: "queued" }),
        [publishing.draftId]: instance(publishing, { ...idleLifecycle, stage: "submitting" }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.equal(canCancelPublishIntent({ ...idleLifecycle, stage: "queued" }), true)
  assert.equal(canCancelPublishIntent({ ...idleLifecycle, stage: "submitting" }), false)
  assert.match(html, /aria-label="取消发送 SZ-0001\.png"/)
  assert.doesNotMatch(html, /aria-label="取消发送 SZ-0002\.png"/)
  assert.match(html, /已提交，等待 Ozon 回执/)
  assert.doesNotMatch(html, /正在发送，等待 Ozon 回执/)
})

test("an interrupted preparation shows its exact problem in the publish cell", () => {
  const target = row(1, {
    status: "failed",
    ai: "done",
    render: "failed",
    upload: "failed",
    log: "已恢复 · preparation_blocked",
    readiness: {
      ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["media_failed"],
      allowed_actions: ["retry_media", "edit_fields"],
    },
  })
  const interrupted: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "recognition_failed",
    media: "failed",
    last_error_code: "preparation_interrupted",
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[target]}
      productDrafts={{ [target.draftId]: instance(target, interrupted) }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, />图片准备被中断，请重试切片或上传</)
  const cell = publishCell(html, target.imageName)
  // 折叠的两行说明保留 aria-label，全文悬停走气泡：原生 title 已由同一句
  // Tooltip 全文接替，不再叠加两份迟到的系统提示。
  const detailLine = cell.match(/<p[^>]*aria-label="图片准备被中断，请重试切片或上传"[^>]*>/)?.[0]
  assert.ok(detailLine, "the clamped detail keeps its accessible name")
  assert.match(detailLine, /data-slot="tooltip-trigger"/)
  assert.doesNotMatch(detailLine, /title=/)
  assert.match(cell, /<p[^>]*data-slot="tooltip-trigger"[^>]*>图片准备被中断，请重试切片或上传<\/p>/)
  const details = cell.match(/<details\b[^>]*data-slot="publish-remediation"[^>]*>([\s\S]*?)<\/details>/)?.[1]
  assert.ok(details, "the row keeps its persistent solution in native accessible details")
  assert.match(details, /<summary[^>]*>解决此行发布问题<\/summary>/)
  assert.match(details, />原因<\/dt><dd[^>]*>图片准备被中断，请重试切片或上传<\/dd>/)
  assert.match(details, />影响范围<\/dt><dd[^>]*>仅此行的切片步骤；识别结果已完成并保留，尚未发送到 Ozon<\/dd>/)
  assert.match(details, />处理步骤<\/dt><dd[^>]*><ol/)
  for (const step of ["确认上架方案绑定的 PSD 模板仍可用", "点「重试切片」只重新切片此行", "切片完成后继续上传",
    "保存后通过字段校验；确认此行允许发送且没有未确认的旧操作，再明确发送"]) {
    assert.ok(details.includes(`>${step}</li>`), step)
  }
  assert.doesNotMatch(cell, /preparation_interrupted|preparation_blocked/)
  assert.match(buttonMarkup(cell, "切片：失败，重试切片"), /<svg/)
  assert.match(cell, /data-preparation-step="deliver" data-state="idle"/)
  assert.match(cell, /aria-label="上传：未开始"/)
  assert.doesNotMatch(cell, /aria-label="上传：失败，重试上传"/)
  assert.doesNotMatch(html, />需要处理</)
  assert.match(html, /aria-label="准备流程：识别 → 切片 → 上传"/)
  assert.match(html, /重试切片/)
})

test("each done or failed stage carries its own retry glyph, not a text button", () => {
  const ocrFailed = row(1, { status: "failed", ai: "failed", render: "done", upload: "done" })
  const uploadFailed = row(2, { status: "failed", ai: "done", render: "done", upload: "failed" })
  const ocrLifecycle: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "recognition_failed",
    ai: "failed",
    media: "ready",
  }
  const uploadLifecycle: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "recognition_failed",
    ai: "ready",
    media: "failed",
    media_failure_stage: "upload",
    image_total: 1,
    images: [slice(0, { phase: "failed" })],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[ocrFailed, uploadFailed]}
      productDrafts={{
        [ocrFailed.draftId]: instance(ocrFailed, ocrLifecycle),
        [uploadFailed.draftId]: instance(uploadFailed, uploadLifecycle),
      }}
      selectedRowIds={new Set()}
    />,
  )
  assert.match(html, /data-preparation-step="ai" data-state="failed"/)
  assert.match(html, /data-preparation-step="render" data-state="done"/)
  assert.match(html, /data-preparation-step="deliver" data-state="failed"/)
  // The state is the control: every done/failed stage names its own verb and
  // its state, and the check or exclamation swaps for a spinning refresh under
  // the pointer.
  assert.match(html, /aria-label="识别：失败，重试识别"/)
  assert.match(html, /aria-label="切片：已完成，重试切片"/)
  assert.match(html, /aria-label="上传：失败，重试上传"/)
  assert.doesNotMatch(html, />上传失败</, "the failed leg's sentence belongs to its glyph tooltip")
  const sliceRetry = buttonMarkup(html, "切片：已完成，重试切片")
  assert.match(sliceRetry, /lucide-check/, "a done stage keeps its check")
  assert.match(sliceRetry, /lucide-refresh-cw[^>]*animate-spin/, "the pointer swaps in a spinning refresh")
  assert.match(sliceRetry, /group-hover\/step-retry:hidden/)
  assert.match(
    buttonMarkup(html, "识别：失败，重试识别"),
    /lucide-circle-alert/,
    "a failed stage keeps its exclamation",
  )
  assert.doesNotMatch(html, />重试切片</, "no Chinese retry button beside the glyph")
  assert.doesNotMatch(buttonMarkup(html, "识别：失败，重试识别"), /一键准备/)
})

test("the failing leg keeps its icon and moves its sentence into the glyph", () => {
  const target = row(1, {
    status: "failed",
    render: "failed",
    log: "请在在线商库配置唯一的 PSD 模板。",
  })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[target]}
      productDrafts={{
        [target.draftId]: instance(target, { ...idleLifecycle, stage: "awaiting_content" }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.match(html, />待导入</)
  assert.match(html, /data-preparation-step="render" data-state="failed"/)
  // 切片失败 is what the ⚠ already says, and the row's own log sentence now
  // travels with it — neither is printed beside the icon.
  assert.doesNotMatch(html, />切片失败</)
  assert.doesNotMatch(html, /请在在线商库配置唯一的 PSD 模板/)
  assert.match(buttonMarkup(html, "切片：失败，重试切片"), /lucide-refresh-cw/)
})

test("a submitted row explains its state and keeps technical evidence in details", () => {
  const reconciled = row(1, { status: "sent" })
  const conflicted = row(2, { status: "exception" })
  const pending = row(3, { status: "ready" })
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[reconciled, conflicted, pending]}
      productDrafts={{
        [reconciled.draftId]: instance(reconciled, {
          ...idleLifecycle,
          stage: "accepted",
          ozon_sku: 123456789,
          submissionReceipt: { batch_id: "batch-200", item_count: 100, http_status: 200, response_body: "", received_at_ms: 1 },
        }),
        [conflicted.draftId]: instance(conflicted, {
          ...idleLifecycle,
          stage: "publish_rejected",
          ozon_sku: 4996083345,
          last_error_code: "OZON_RECONCILE_CONFLICT",
          last_error_detail: "本机标题与 Ozon 商品名不一致。本机：「30х40」· Ozon：「40х50」。",
        }),
        [pending.draftId]: instance(pending, {
          ...idleLifecycle,
          stage: "accepted",
        }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  assert.doesNotMatch(html, /打开 Ozon 商品 SKU/)
  assert.doesNotMatch(html, /已上架/)
  assert.doesNotMatch(html, /等待 Ozon 生成 SKU/)
  assert.match(html, /Ozon 已受理，后续审核与可售以卖家后台为准。/)
  assert.doesNotMatch(html, /正在处理/)
  assert.match(html, /查看提交详情/)
  assert.doesNotMatch(html, /<details[^>]*\sopen(?:=|>)/)
  assert.match(html, /响应正文为空/)
  assert.match(html, /batch-200/)
  assert.match(html, /发布结果与当前接口合同不符/)
  assert.doesNotMatch(html, /本机标题与 Ozon 商品名不一致|OZON_RECONCILE_CONFLICT/,
    "unclassified external errors require contract guidance instead of raw prose")
})

test("the table distinguishes waiting for uploads from computing slices", () => {
  const target = row(1, {
    status: "running", ai: "done", render: "running",
    preparationRender: { stage: "render", state: "waiting", message: "等待上传容量，上传完成后自动继续切片", since_ms: Date.now() - 65_000 },
  })
  const html = renderToStaticMarkup(<FieldWorkbench {...workbenchProps} schema={schema} rows={[target]}
    productDrafts={{ [target.draftId]: instance(target, { ...idleLifecycle, stage: "rendering", ai: "ready", media: "rendering" }) }}
    selectedRowIds={new Set()} />)
  assert.doesNotMatch(html, /等待上传容量，上传完成后自动继续切片|已等待 1:05/)
  assert.match(html, /识别：已完成.*切片：进行中.*上传：未开始/)
})

test("a failed preparation result remains visible over an unprepared product projection", async () => {
  const target = row(1)
  const scene = harness([target], { [target.draftId]: instance(target) })
  const message = "识别任务结果尚未确认，请重试核实"
  const result: WorkflowOperationRowResult = {
    row_id: target.draftId, outcome: "start", blockers: [],
    product: projection(target, idleLifecycle),
    error: { code: "workflow_job_uncertain", message, remediation: null },
    preparation_progress: [{ stage: "ai", state: "failed", message, since_ms: 1 }],
  }
  await runWorkflowOperationBatch([target], {
    ...scene.deps,
    settleRow: async (_target, log) => scene.deps.patchRow(target.id, {
      ...projectListingRowLifecycle(scene.row(target.id), idleLifecycle, needsPreparation), log,
    }),
  }, async (_request, onRow) => { onRow(result); return [result] }, { status: "running" }, "准备完成")
  const failed = scene.row(target.id)
  assert.equal(failed.preparationAi?.message, message)
  const html = renderToStaticMarkup(<FieldWorkbench {...workbenchProps} schema={schema} rows={[failed]}
    productDrafts={{ [target.draftId]: instance(target) }} selectedRowIds={new Set()} />)
  assert.match(html, /准备失败/)
  assert.match(html, /云端结果待确认/)
  assert.match(html, /刷新核对结果，请勿重复提交/)
  assert.match(failed.errorFeedback?.errorId ?? "", /^[0-9]{20}$/)
  // The strip's own state fact, and the retry that now rides on its glyph.
  assert.match(html, /data-preparation-step="ai" data-state="failed"/)
  assert.doesNotMatch(html, /aria-label="识别：失败，重试识别"/)
})

test("pending candidates expose the explicit review entry on their row", () => {
  const target = row(1)
  const product = instance(target, { ...idleLifecycle, ai_candidates: [{
    address: { kind: "plain", field_key: "name" }, value: { kind: "text", value: "Новое имя" },
    current_value: { kind: "text", value: "Старое имя" }, source: "ai", state: "proposed",
  }] })
  const html = renderToStaticMarkup(<FieldWorkbench {...workbenchProps} schema={schema} rows={[target]} productDrafts={{ [target.draftId]: product }} selectedRowIds={new Set()} />)
  assert.match(html, /审阅建议/)
})

/** One row's whole publish-state cell, cut at its own `<td>`. */
function publishCell(html: string, imageName: string): string {
  const checkbox = html.indexOf(`aria-label="选择 ${imageName}"`)
  assert.notEqual(checkbox, -1, `no row for ${imageName}`)
  const rowHtml = html.slice(html.lastIndexOf("<tr", checkbox), html.indexOf("</tr>", checkbox))
  const strip = rowHtml.indexOf('aria-label="准备流程：识别 → 切片 → 上传"')
  assert.notEqual(strip, -1, `${imageName} shows no preparation strip`)
  return rowHtml.slice(rowHtml.lastIndexOf("<td", strip), rowHtml.indexOf("</td>", strip))
}

/// The batch verbs skip a sealed row (`preparationOpen`), and a receipt means
/// Ozon already answered. The complete cell — not just the remediation block —
/// must stop offering the step glyph as a retry there, while an open row with
/// the same tracks keeps both glyphs as real, keyboard-reachable buttons.
test("a sealed or receipt-holding row keeps its step facts but invites no re-preparation", () => {
  const tracks = { ai: "failed", render: "done", upload: "idle" } as const
  const unknown = row(1, { ...tracks, status: "exception" })
  const accepted = row(2, { ...tracks, status: "exception" })
  const attested = row(3, { ...tracks, status: "exception" })
  const receipted = row(4, { ...tracks, status: "failed" })
  const open = row(5, { ...tracks, status: "failed" })
  const sliced: WorkflowProductLifecycle = {
    ...idleLifecycle,
    ai: "failed",
    media: "rendered",
    image_total: 1,
    images: [slice(0)],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[unknown, accepted, attested, receipted, open]}
      productDrafts={{
        [unknown.draftId]: instance(unknown, { ...sliced, stage: "outcome_unknown" }),
        [accepted.draftId]: instance(accepted, { ...sliced, stage: "accepted" }),
        [attested.draftId]: instance(attested, { ...sliced, stage: "operator_attested" }),
        [receipted.draftId]: instance(receipted, {
          ...sliced,
          stage: "publish_rejected",
          submissionReceipt: { batch_id: "batch-1", item_count: 1, http_status: 200, response_body: "", received_at_ms: 1 },
        }),
        [open.draftId]: instance(open, { ...sliced, stage: "recognition_failed" }),
      }}
      selectedRowIds={new Set()}
    />,
  )

  for (const fenced of [unknown, accepted, attested, receipted]) {
    const cell = publishCell(html, fenced.imageName)
    // The stage facts stay: the strip still names each leg's state.
    assert.match(cell, /data-preparation-step="ai" data-state="failed"/, fenced.imageName)
    assert.match(cell, /data-preparation-step="render" data-state="done"/, fenced.imageName)
    // …but no glyph is a control: nothing to click, tab to, or read as 重试.
    assert.doesNotMatch(cell, /group\/step-retry/, fenced.imageName)
    assert.doesNotMatch(cell, /，重试(?:识别|切片|上传)"/, fenced.imageName)
    assert.doesNotMatch(cell, /点击重试/, fenced.imageName)
    assert.match(cell, /aria-label="识别：失败(?: · [^"]*)?"/, fenced.imageName)
    assert.match(cell, /aria-label="切片：已完成"/, fenced.imageName)
  }

  const control = publishCell(html, open.imageName)
  assert.match(buttonMarkup(control, "识别：失败，重试识别"), /lucide-circle-alert/)
  assert.match(buttonMarkup(control, "切片：已完成，重试切片"), /lucide-check/)
})

/// A row can render before its Product Instance is in `productDrafts`, and its
/// own Cloud stage can already be sealed. Without an open lifecycle there is no
/// evidence the verbs would act, so the complete cell names the failed leg but
/// offers no retry; only a row whose projected lifecycle is open gets controls.
test("a row without an open lifecycle describes its failed leg but offers no retry", () => {
  const failedAi = {
    status: "failed", ai: "failed", render: "done", upload: "idle",
    preparationAi: { stage: "ai", state: "failed", message: "识图处理版本已变化，请刷新后重新准备", since_ms: 1 },
  } as const
  const unknown = row(1, { ...failedAi, stage: "outcome_unknown" })
  const accepted = row(2, { ...failedAi, stage: "accepted" })
  const attested = row(3, { ...failedAi, stage: "operator_attested" })
  const unprojected = row(4, { ...failedAi })
  // The row's own sealed stage outranks an older open lifecycle, and a receipt
  // keeps the row receipt-only whatever its stage says.
  const staleOpen = row(5, { ...failedAi, stage: "outcome_unknown" })
  const receipted = row(6, { ...failedAi, stage: "publish_rejected" })
  const open = row(7, { ...failedAi, stage: "recognition_failed" })
  const openLifecycle: WorkflowProductLifecycle = {
    ...idleLifecycle,
    stage: "recognition_failed",
    ai: "failed",
    media: "rendered",
    image_total: 1,
    images: [slice(0)],
  }
  const html = renderToStaticMarkup(
    <FieldWorkbench
      {...workbenchProps}
      schema={schema}
      rows={[unknown, accepted, attested, unprojected, staleOpen, receipted, open]}
      productDrafts={{
        [staleOpen.draftId]: instance(staleOpen, openLifecycle),
        [receipted.draftId]: instance(receipted, {
          ...openLifecycle,
          stage: "publish_rejected",
          submissionReceipt: { batch_id: "batch-1", item_count: 1, http_status: 200, response_body: "", received_at_ms: 1 },
        }),
        [open.draftId]: instance(open, openLifecycle),
      }}
      selectedRowIds={new Set()}
    />,
  )

  for (const passive of [unknown, accepted, attested, unprojected, staleOpen, receipted]) {
    const cell = publishCell(html, passive.imageName)
    assert.match(cell, /data-preparation-step="ai" data-state="failed"/, passive.imageName)
    assert.doesNotMatch(cell, /group\/step-retry/, passive.imageName)
    assert.doesNotMatch(cell, /，重试(?:识别|切片|上传)"/, passive.imageName)
    assert.doesNotMatch(cell, /点击重试/, passive.imageName)
    assert.match(cell, /aria-label="识别：失败(?: · [^"]*)?"/, passive.imageName)
  }

  const control = publishCell(html, open.imageName)
  assert.match(buttonMarkup(control, "识别：失败，重试识别"), /lucide-circle-alert/)
  assert.match(buttonMarkup(control, "切片：已完成，重试切片"), /lucide-check/)
})


test("a local Unknown fence stays visible and suppresses preparation retry after a ready projection", () => {
  const target = row(1, { publishUnconfirmed: true, status: "failed", render: "failed", upload: "failed" })
  const html = renderToStaticMarkup(<PublishStateCell row={target} inView
    lifecycle={{ ...idleLifecycle, stage: "ready_to_publish" }}
    onCancelIntent={() => undefined} onReviewCandidates={() => undefined} onRetryStage={() => undefined} />)
  assert.match(html, /核对中/)
  assert.match(html, /不能重新发送或重试/)
  assert.doesNotMatch(html, /<button/)
})


test("a legacy repair callback cannot expose a button without native capability and current Cloud permission", () => {
  const target = row(1, { status: "failed", ai: "done", render: "done", upload: "done",
    readiness: { ready_to_publish: false, can_start_publish_attempt: true, blockers: ["publish_conflict"], allowed_actions: ["publish"] } })
  for (const brandRepairAvailable of [false, true]) {
    const html = renderToStaticMarkup(<FieldWorkbench {...workbenchProps} schema={schema}
      rows={[target]} selectedRowIds={new Set()} brandRepairAvailable={brandRepairAvailable}
      onRepairRows={() => { throw new Error("render cannot repair") }}
      productDrafts={{ [target.draftId]: instance(target, { ...idleLifecycle, stage: "publish_rejected",
        ai: "ready", media: "ready", last_error_code: "BR_hashtag_brand" }) }} />)
    assert.doesNotMatch(html, /aria-label="修复标签并发送|aria-label="修复搜索标签|>修复品牌字段</)
    assert.match(html, /在此行「标签」列删除含品牌名的搜索标签并保存/)
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import type { components } from "@/api/schema"
import type { WorkflowProductLifecycle, WorkflowReadinessReport } from "@/bindings/commands"
import { brandRepairEligible, brandRepairIssueCurrent } from "../brand-repair"
import { NO_PREPARATION_ACTIVITY } from "../prepare/preparation-tracks"
import type { ListingRow } from "./listing-row"
import { brandRepairRowIds, resolvePublishRemediation, type PublishRemediation, type PublishRemediationFacts } from "./publish-remediation"
import { capturePublishRequestEvidence } from "./publish-request-evidence"

const rejected = {
  revision: 3, view_revision: 3, stage: "publish_rejected", ai: "ready", media: "ready",
  fields: "valid", image_total: 8, image_completed: 8, images: [], failure_log: [],
  ai_candidates: [], product_videos: [], source_file_name: "SZ-0001.png",
} satisfies WorkflowProductLifecycle

const report = (
  blockers: WorkflowReadinessReport["blockers"],
  allowed: WorkflowReadinessReport["allowed_actions"] = [],
): WorkflowReadinessReport => ({
  ready_to_publish: false,
  can_start_publish_attempt: allowed.includes("publish"),
  blockers,
  allowed_actions: allowed,
})

const PSD_REFUSAL = "发送未执行：PSD 尚未云端保存或未绑定该类目，请重新绑定模板"
const killed: WorkflowProductLifecycle = {
  ...rejected,
  last_error_code: "OZON_WRITES_DISABLED",
  last_error_detail: "上次发送：Ozon 写入已被暂停；等待维护解除后重新发送。此后草稿已修改，请核对后重新发送",
}

const text = (remediation: PublishRemediation) =>
  [remediation.reason, remediation.scope, ...remediation.steps].join("\n")

const brandIssue: components["schemas"]["ListingIssue"] = {
  allowed_actions: ["edit_row"], code: "OZON_ROW_REJECTED", phase: "submit",
  created_at_ms: 1, credential_revision: 1, dispatch_evidence: "rejected", endpoint: "import",
  input_revision: rejected.revision, intent_id: "brand-intent", request_hash: "digest",
  retry_after_fallback: false, row_id: "brand-row", store_id: "brand-store", safe_message: "",
  summary: "Cloud 指定的当前品牌拒绝原因", remediation: "Cloud 指定：清空违规搜索标签并重新校验",
  scope: "store", trace_id: "cloud-brand-trace",
}
const cloudBrand: WorkflowProductLifecycle = {
  ...rejected, last_error_code: "BR_hashtag_brand", last_error_detail: "旧品牌拒绝说明，不应覆盖 Cloud",
  submission_issue: brandIssue,
}
const cloudBrandFacts: PublishRemediationFacts = {
  lifecycle: cloudBrand, readiness: report(["publish_conflict"], ["edit_fields"]), rowLog: "", brandRepairable: true,
}

test("a current Cloud brand rejection keeps authoritative guidance and exposes only the authorized repair", () => {
  const row: ListingRow = { id: "brand-ui-row", draftId: brandIssue.row_id, imageName: "brand.png", status: "failed",
    ai: "done", render: "done", upload: "done", log: "" }
  assert.equal(brandRepairEligible(row, cloudBrand, cloudBrandFacts.readiness, NO_PREPARATION_ACTIVITY), true)
  assert.equal(brandRepairIssueCurrent(cloudBrand, row.draftId, brandIssue.store_id), true)
  const remediation = resolvePublishRemediation(cloudBrandFacts)!
  assert.equal(remediation.cause, "structured_issue")
  assert.equal(remediation.reason, brandIssue.summary)
  assert.equal(remediation.scope, "当前店铺及绑定该店铺的商品")
  assert.equal(remediation.steps[0], brandIssue.remediation)
  assert.equal(remediation.traceId, brandIssue.trace_id)
  assert.equal(remediation.reportable, false)
  assert.equal(remediation.diagnosticCode, null)
  assert.deepEqual(remediation.action, { kind: "repair_brand", label: "修复品牌字段" })
  assert.doesNotMatch(text(remediation), /旧品牌拒绝说明|重新识别|重新切片/)
})

test("Cloud brand repair requires current classified rejection, edit allowance and live capability", () => {
  const issues: [string, Partial<components["schemas"]["ListingIssue"]>][] = [
    ["edit_row denied", { allowed_actions: [] }],
    ["unrelated allowance", { allowed_actions: ["recover", "reconcile"] }],
    ["stale revision", { input_revision: rejected.revision - 1 }],
    ["resolved issue", { resolved_at_ms: 2 }],
    ["unknown code", { code: "UNCLASSIFIED_BRAND_FAILURE" }],
    ["other known issue", { code: "OZON_PERMISSION_DENIED" }],
    ["wrong phase", { phase: "pre_dispatch" }],
    ["invalid phase", { phase: "invalid-phase" }],
    ["unconfirmed dispatch", { dispatch_evidence: "unknown" }],
    ["not dispatched", { dispatch_evidence: "not_dispatched" }],
    ["missing Intent", { intent_id: "" }],
    ["missing Store", { store_id: "" }],
    ["invalid summary", { summary: " " }],
    ["invalid remediation", { remediation: " " }],
  ]
  for (const [name, patch] of issues) {
    const remediation = resolvePublishRemediation({ ...cloudBrandFacts,
      lifecycle: { ...cloudBrand, submission_issue: { ...brandIssue, ...patch } } })
    assert.equal(remediation?.action, undefined, name)
  }
  const facts: [string, Partial<PublishRemediationFacts>][] = [
    ["missing capability", { brandRepairable: undefined }],
    ["denied capability", { brandRepairable: false }],
    ["wrong platform", { platform: "wb" }],
    ["unknown platform", { platform: "unregistered" }],
    ["non-brand failure", { lifecycle: { ...cloudBrand, last_error_code: "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT" } }],
    ["wrong lifecycle stage", { lifecycle: { ...cloudBrand, stage: "fields_invalid" } }],
    ["local refusal", { rowLog: PSD_REFUSAL }],
    ["local Unknown", { localUnconfirmed: true }],
    ["Unknown blocker", { readiness: report(["outcome_unknown"], ["edit_fields", "publish"]) }],
    ["attested blocker", { readiness: report(["operator_attested"], ["edit_fields", "publish"]) }],
  ]
  for (const stage of ["queued", "submitting", "accepted", "outcome_unknown", "operator_attested"] as const) {
    facts.push([stage, { lifecycle: { ...cloudBrand, stage } }])
  }
  for (const [name, patch] of facts) {
    assert.equal(resolvePublishRemediation({ ...cloudBrandFacts, ...patch })?.action, undefined, name)
  }
})

test("a current request refusal outranks an otherwise repairable Cloud brand issue", () => {
  const identity = { scope: 1, mediaEpoch: 0, cardId: "card", storeId: brandIssue.store_id,
    rowId: brandIssue.row_id, revision: rejected.revision, viewRevision: rejected.view_revision }
  const requestEvidence = capturePublishRequestEvidence({ code: "cloud_offer_busy", message: "request refused", remediation: null,
    requestCause: { kind: "request_refusal", scope: "request", storeId: brandIssue.store_id,
      rowIds: [brandIssue.row_id, "other-offer"], status: 409, serverCode: "offer_busy", admission: "offer_busy", traceId: "current-request-trace" },
  }, identity)
  assert.ok(requestEvidence && !requestEvidence.contractInvalid)
  const remediation = resolvePublishRemediation({ ...cloudBrandFacts, requestEvidence, requestIdentity: identity })!
  assert.equal(remediation.cause, "request_offer_busy")
  assert.equal(remediation.action, undefined)
  assert.equal(remediation.traceId, "current-request-trace")
  assert.match(remediation.scope, /原店铺 brand-store.*整块 2 件商品/)
  assert.notEqual(remediation.reason, brandIssue.summary)
})

test("a current PSD refusal is the cause, not the older write pause", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: killed, readiness: report(["publish_rejected"]), rowLog: PSD_REFUSAL, imageName: "SZ-0001.png",
  })!
  assert.equal(remediation.cause, "send_refused_psd")
  assert.equal(remediation.reason, PSD_REFUSAL)
  assert.doesNotMatch(text(remediation), /OZON_WRITES_DISABLED|写入已被暂停|维护/)
  assert.match(remediation.scope, /未提交到 Ozon/)
  assert.match(remediation.scope, /8 张商品图片保留/)
  assert.match(remediation.steps.join(""), /上架方案.*同一个原始 PSD.*云端保存/s)
  assert.equal(remediation.action, undefined, "no callback can rebind a PSD, so none is offered")
})

test("without a newer refusal the write pause explains itself and never self-resolves", () => {
  const remediation = resolvePublishRemediation({ lifecycle: killed, readiness: report(["publish_rejected"]), rowLog: "" })!
  assert.equal(remediation.cause, "writes_disabled")
  assert.match(remediation.reason, /写入已被暂停/)
  assert.match(remediation.scope, /所有用户.*未发送到 Ozon/)
  assert.match(remediation.steps.join(""), /管理员.*不会自动恢复/)
  assert.equal(remediation.action, undefined)
})

test("dispatched, accepted and unresolved rows keep their durable truth over a stale refusal", () => {
  for (const stage of ["queued", "submitting", "accepted"] as const) {
    assert.equal(
      resolvePublishRemediation({ lifecycle: { ...killed, stage }, readiness: report([]), rowLog: PSD_REFUSAL }),
      undefined,
      `${stage} is not a failure`,
    )
  }
  for (const [lifecycle, blockers] of [
    [{ ...killed, stage: "outcome_unknown" as const }, ["outcome_unknown" as const]],
    [killed, ["outcome_unknown" as const]],
  ] as const) {
    const unknown = resolvePublishRemediation({
      lifecycle, readiness: report([...blockers], ["publish"]), rowLog: PSD_REFUSAL, brandRepairable: true,
    })!
    assert.equal(unknown.cause, "outcome_unknown")
    assert.equal(unknown.action, undefined, "Unknown never offers a send or retry")
    assert.doesNotMatch(text(unknown), /PSD/)
    assert.match(unknown.scope, /不能重新发送/)
    assert.match(unknown.steps.join(""), /卖家后台.*SZ-0001/s)
    assert.match(unknown.steps.join(""), /恢复待核对/)
  }
  const attested = resolvePublishRemediation({
    lifecycle: { ...killed, stage: "operator_attested" }, readiness: report(["operator_attested"]), rowLog: PSD_REFUSAL,
  })!
  assert.equal(attested.cause, "operator_attested")
  assert.equal(attested.action, undefined)
})

test("Unknown and attested rows get a manual path that promises no automatic correction", () => {
  const evidence: WorkflowProductLifecycle = {
    ...rejected, taskId: "5666996254", submissionReceipt: { batch_id: "batch", item_count: 1, http_status: 502 },
  }
  const unknown = resolvePublishRemediation({
    lifecycle: { ...evidence, stage: "outcome_unknown" }, readiness: report(["outcome_unknown"]), rowLog: "",
  })!
  const steps = unknown.steps.join("\n")
  // Card reconcile answers 410 and the worker never updates the Intent.
  assert.doesNotMatch(text(unknown), /等待系统对账|系统对账|自动对账|自动更新此行/)
  assert.match(steps, /卖家后台，按货号「SZ-0001」查找商品，并核对导入任务 5666996254/)
  assert.match(steps, /已查到商品：直接在 Ozon 卖家后台管理和核对该商品/)
  assert.match(steps, /不会自动核实它是否可售/)
  assert.match(steps, /保留此行及其提交记录作为本次提交的凭证.*不要重新发送/)
  assert.match(unknown.steps[unknown.steps.length - 1]!, /恢复待核对/)
  assert.equal(unknown.action, undefined)

  const attested = resolvePublishRemediation({
    lifecycle: { ...evidence, stage: "operator_attested" }, readiness: report(["operator_attested"]), rowLog: "",
  })!
  assert.deepEqual(attested.steps, unknown.steps.slice(0, -1), "the same manual steps, without the Unknown release")
  assert.doesNotMatch(text(attested), /恢复待核对|系统对账/)
  assert.equal(attested.action, undefined)
})

test("a failed device-local track is fenced by durable submission evidence", () => {
  const tracks = { id: "row-1", ai: "done", render: "failed", upload: "idle" } as const
  for (const stage of ["queued", "submitting", "accepted"] as const) {
    assert.equal(resolvePublishRemediation({ lifecycle: { ...rejected, stage }, rowLog: "", tracks }), undefined, stage)
  }
  for (const [stage, cause] of [["outcome_unknown", "outcome_unknown"], ["operator_attested", "operator_attested"]] as const) {
    const fenced = resolvePublishRemediation({
      lifecycle: { ...rejected, stage }, readiness: report([stage], ["publish", "retry_media"]), rowLog: "", tracks,
    })!
    assert.equal(fenced.cause, cause)
    assert.equal(fenced.action, undefined, "no retry or send leaks through the fence")
    assert.doesNotMatch(text(fenced), /重试切片/)
  }
})

test("a failed local track while Cloud awaits content still gets cause, scope, steps and a leg-only retry", () => {
  const awaiting: WorkflowProductLifecycle = { ...rejected, stage: "awaiting_content", ai: "ready" }
  const render = resolvePublishRemediation({
    lifecycle: awaiting,
    readiness: report(["media_pending"]),
    rowLog: "",
    tracks: { id: "row-1", ai: "done", render: "failed", upload: "idle" },
    hasSource: true,
  })!
  assert.equal(render.cause, "prepare_leg")
  assert.equal(render.reason, "此行的切片步骤在本机没有完成，且没有保存详细的异常信息")
  assert.doesNotMatch(render.reason, /尚未开始|仍需准备/, "a pending blocker is not what failed")
  assert.match(render.scope, /仅此行的切片步骤；识别结果已完成并保留/)
  assert.deepEqual(render.action, { kind: "retry_stage", verb: "render", label: "重试切片" })
  assert.match(render.steps[0]!, /切片步骤的 ⚠ 图标/)
  assert.match(render.steps.join(""), /只重新切片此行/)
  assert.doesNotMatch(render.steps.join(""), /重新识别|一键准备/)

  const upload = resolvePublishRemediation({
    lifecycle: { ...awaiting, stage: "uploading" },
    readiness: report(["media_running"]),
    rowLog: "",
    tracks: { id: "row-1", ai: "done", render: "done", upload: "failed" },
    hasSource: false,
  })!
  assert.equal(upload.cause, "prepare_leg", "delivery needs no source image")
  assert.deepEqual(upload.action, { kind: "retry_stage", verb: "deliver", label: "重试上传" })
  assert.match(upload.scope, /识别、切片结果已完成并保留/)
})

test("a local recognition failure without its source offers no paid retry, and stale wallet history is not its cause", () => {
  const recognizing: WorkflowProductLifecycle = {
    ...rejected, stage: "recognizing", ai: "running",
    failure_log: [{ stage: "ai", code: "workflow_quota_exceeded", message: "钱包余额不足", occurred_at_ms: 1 }],
  }
  const tracks = { id: "row-1", ai: "failed" } as const
  const lost = resolvePublishRemediation({ lifecycle: recognizing, readiness: report(["ai_running"]), rowLog: "", tracks, hasSource: false })!
  assert.equal(lost.cause, "missing_source")
  assert.equal(lost.action, undefined)
  assert.match(lost.reason, /识别步骤在本机没有完成/)

  const present = resolvePublishRemediation({ lifecycle: recognizing, readiness: report(["ai_running"]), rowLog: "", tracks, hasSource: true })!
  assert.equal(present.cause, "prepare_leg")
  assert.deepEqual(present.action, { kind: "retry_stage", verb: "ai", label: "重试识别" })
  assert.match(present.steps.join(""), /按次计费/)
})

test("guidance exists only for failure and Unknown states", () => {
  const ready = { ...rejected, stage: "ready_to_publish" as const }
  assert.equal(resolvePublishRemediation({ lifecycle: ready, readiness: report([], ["publish"]), rowLog: "" }), undefined)
  assert.equal(
    resolvePublishRemediation({ lifecycle: { ...killed, stage: "ready_to_publish" }, readiness: report([], ["publish"]), rowLog: "" }),
    undefined,
    "a code left over from an earlier attempt is not a current failure",
  )
  assert.equal(resolvePublishRemediation({ lifecycle: { ...rejected, stage: "accepted", ozon_sku: 9 }, rowLog: "" }), undefined)
  const refused = resolvePublishRemediation({ lifecycle: ready, readiness: report([], ["publish"]), rowLog: PSD_REFUSAL })
  assert.equal(refused?.cause, "send_refused_psd", "a refused click on a ready row is a failure")
})

test("brand repair is offered only when the existing policy admits the row", () => {
  const brand: WorkflowProductLifecycle = {
    ...rejected, last_error_code: "BR_hashtag_brand", last_error_detail: "搜索标签含品牌名",
  }
  const repairable = resolvePublishRemediation({
    lifecycle: brand, readiness: report(["publish_conflict"]), rowLog: "", brandRepairable: true,
  })!
  assert.deepEqual(repairable.action, { kind: "repair_brand", label: "修复品牌字段" })
  assert.match(repairable.steps.join(""), /发送到 Ozon/)
  assert.doesNotMatch(repairable.steps.join(""), /重新识别|重新切片|不自动发送/)

  const manual = resolvePublishRemediation({ lifecycle: brand, readiness: report(["publish_conflict"]), rowLog: "" })!
  assert.equal(manual.action, undefined)
  assert.match(manual.steps.join(""), /标签/)

  const row = (id: string, readiness: WorkflowReadinessReport): ListingRow => ({
    id, draftId: `draft-${id}`, imageName: `${id}.png`, status: "failed",
    ai: "done", render: "done", upload: "done", log: "", readiness,
  })
  const conflict = row("a", report(["publish_conflict"]))
  const plain = row("b", report(["publish_rejected"]))
  const drafts = { [conflict.draftId]: { lifecycle: brand }, [plain.draftId]: { lifecycle: brand } }
  assert.deepEqual([...brandRepairRowIds([conflict, plain], drafts, NO_PREPARATION_ACTIVITY)], ["a"])
  const preparing = { ...NO_PREPARATION_ACTIVITY, ai: new Set(["a"]) }
  assert.equal(brandRepairRowIds([conflict], drafts, preparing).size, 0)
})

test("an upload failure retries only that leg and keeps the finished legs", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: { ...rejected, stage: "media_failed", media: "failed", media_failure_stage: "upload" },
    readiness: report(["media_failed"], ["retry_media"]),
    rowLog: "",
    tracks: { id: "row-1", ai: "done", render: "done", upload: "failed" },
    hasSource: false,
  })!
  assert.equal(remediation.cause, "prepare_leg")
  assert.deepEqual(remediation.action, { kind: "retry_stage", verb: "deliver", label: "重试上传" })
  assert.match(remediation.scope, /上传步骤.*识别、切片结果已完成并保留/)
})

test("a lost source asks for the same original first instead of a blind paid retry", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: { ...rejected, stage: "recognition_failed", ai: "failed" },
    readiness: report(["ai_failed"], ["retry_ai"]),
    rowLog: "",
    tracks: { id: "row-1", ai: "failed", render: "done", upload: "done" },
    hasSource: false,
  })!
  assert.equal(remediation.cause, "missing_source")
  assert.equal(remediation.action, undefined)
  assert.match(remediation.steps[0]!, /重新导入同一张原图「SZ-0001\.png」/)
})

test("an empty wallet names the fix before any retry", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: {
      ...rejected, stage: "recognition_failed", ai: "failed",
      failure_log: [{ stage: "ai", code: "workflow_quota_exceeded", message: "钱包余额不足", occurred_at_ms: 1 }],
    },
    readiness: report(["ai_failed"], ["retry_ai"]),
    rowLog: "",
    tracks: { id: "row-1", ai: "failed", render: "done", upload: "done" },
    hasSource: true,
  })!
  assert.equal(remediation.cause, "wallet_balance")
  assert.equal(remediation.action, undefined)
  assert.match(remediation.reason, /钱包余额不足/)
})

test("a cross-account duplicate is a manual review with no retry", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: { ...rejected, last_error_code: "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT" },
    readiness: report(["publish_rejected"], ["publish"]),
    rowLog: "",
  })!
  assert.equal(remediation.cause, "duplicate_spu")
  assert.equal(remediation.action, undefined)
  assert.match(remediation.steps.join(""), /不会自动重试或生成新货号/)
})

test("an unrecorded rejection says what is missing and where to find it", () => {
  const remediation = resolvePublishRemediation({ lifecycle: rejected, readiness: report(["publish_rejected"]), rowLog: "" })!
  assert.equal(remediation.cause, "provider_rejected")
  assert.match(remediation.reason, /没有记录拒绝原因或错误代码/)
  assert.match(remediation.steps[0]!, /没有保存平台响应.*卖家后台.*SZ-0001/)
  assert.doesNotMatch(text(remediation), /未知错误|操作失败/)

  const coded = resolvePublishRemediation({
    lifecycle: { ...rejected, last_error_code: "attribute_invalid", last_error_detail: "颜色属性无效" },
    readiness: report(["publish_rejected"], ["publish", "edit_fields"]),
    rowLog: "",
  })!
  assert.equal(coded.cause, "contract_invalid")
  assert.equal(coded.action, undefined)
  assert.doesNotMatch(coded.reason, /attribute_invalid|颜色属性无效/)
  assert.match(coded.steps[coded.steps.length - 1]!, /确认前不要重发/)
})

test("unsettled candidates point at the existing review action", () => {
  const refused = resolvePublishRemediation({
    lifecycle: { ...rejected, stage: "ready_to_publish" },
    readiness: report([], ["publish"]),
    rowLog: "发送未执行：仍有 AI 候选未确认，请逐项确认或忽略后再发送",
  })!
  assert.equal(refused.cause, "send_refused_candidates")
  assert.deepEqual(refused.action, { kind: "review_candidates", label: "审阅建议" })

  const invalid = resolvePublishRemediation({
    lifecycle: {
      ...rejected, stage: "fields_invalid", fields: "invalid",
      failure_log: [{ stage: "validation", code: "required", message: "缺少品牌", occurred_at_ms: 1 }],
    },
    readiness: report(["fields_invalid"], ["edit_fields"]),
    rowLog: "",
  })!
  assert.equal(invalid.cause, "fields_invalid")
  assert.match(invalid.reason, /缺少品牌/)
  assert.equal(invalid.action, undefined)

  const named = resolvePublishRemediation({
    lifecycle: { ...rejected, stage: "fields_invalid", fields: "invalid" },
    readiness: report(["fields_invalid"], ["edit_fields"]),
    rowLog: "准备已完成",
    issues: [
      { message: "价格币种为必填项" },
      { message: "价格币种为必填项" },
      { message: "主题为必填项" },
    ],
  })!
  assert.equal(named.cause, "fields_invalid")
  assert.equal(named.reason, "价格币种为必填项、主题为必填项")
  assert.doesNotMatch(named.reason, /准备已完成/)
})


test("a restored source handle outranks the old missing-source failure sentence", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: { ...rejected, stage: "recognition_failed", ai: "failed",
      failure_log: [{ stage: "ai", code: "workflow_source_missing", message: "缺少源图，请重新导入原图", occurred_at_ms: 1 }] },
    rowLog: "", hasSource: true, tracks: { id: "row", ai: "failed" },
  })!
  assert.equal(remediation.cause, "prepare_leg")
  assert.deepEqual(remediation.action, { kind: "retry_stage", verb: "ai", label: "重试识别" })
  assert.doesNotMatch(remediation.scope, /本机已找不到原图/)
  assert.match(remediation.reason, /原图已恢复/)
  assert.doesNotMatch(remediation.reason, /缺少源图/)
})

test("PSD remediation reads the typed current attempt and ignores an old failure after rendering starts", async () => {
  const { psdTemplateFailure, psdTemplateFailurePatch } = await import("../prepare/psd-template-failure")
  const failure = psdTemplateFailure("template_unbound", 42)
  const patch = psdTemplateFailurePatch(failure)
  assert.deepEqual(patch.psdTemplateFailure, failure)
  const facts = { lifecycle: { ...rejected, stage: "awaiting_content" as const }, rowLog: "",
    psdTemplateFailure: failure,
    tracks: { id: "row", render: "failed" as const, preparationRender: patch.preparationRender } }
  const view = resolvePublishRemediation(facts)!
  assert.equal(view.reason, failure.message)
  assert.match(view.steps.join(""), /建卡页.*PSD 模板/)
  assert.equal(resolvePublishRemediation({ ...facts, tracks: { id: "row", render: "running" } }), undefined)
})

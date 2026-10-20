import assert from "node:assert/strict"
import test from "node:test"
import { Children, isValidElement } from "react"
import type { components } from "@/api/schema"
import { Button } from "@/components/ui/button"
import { UnknownReleaseStrip } from "./unknown-release-strip"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { resolvePublishRemediation, type PublishRemediationFacts, type PublishRemediation as PublishRemediationModel } from "../model/publish-remediation"
import type { PreparationVerb } from "../prepare/preparation-tracks"
import { PublishRemediation, RemediationDetails, remediationView } from "./publish-remediation"

const uploadFailure: PublishRemediationModel = {
  cause: "prepare_leg",
  reason: "上传被拒绝",
  scope: "仅此行的上传步骤；识别、切片结果已完成并保留",
  steps: ["点「重试上传」只重新上传此行未交付的切片"],
  action: { kind: "retry_stage", verb: "deliver", label: "重试上传" },
}

test("the details stay collapsed and carry reason, scope and ordered steps", () => {
  const markup = renderToStaticMarkup(
    <RemediationDetails view={{ reason: "原因 A", scope: "仅此行", steps: ["第一步", "第二步"] }} />,
  )
  assert.match(markup, /<details[^>]*data-slot="publish-remediation"/)
  assert.doesNotMatch(markup, /<details[^>]*\bopen/)
  assert.match(markup, /解决此行发布问题/)
  assert.match(markup, /原因.*原因 A.*影响范围.*仅此行.*处理步骤.*<ol[^>]*>.*第一步.*第二步/s)
  assert.doesNotMatch(markup, /<button/, "no action, no button")
  assert.doesNotMatch(markup, /role="alert"/)
})

test("a leg retry calls the row's own retry with only the failed leg", () => {
  const calls: PreparationVerb[] = []
  const view = remediationView(uploadFailure, { onRetryStage: (verb) => calls.push(verb) })
  assert.equal(view.action?.label, "重试上传")
  view.action!.run()
  assert.deepEqual(calls, ["deliver"])
  assert.match(renderToStaticMarkup(<RemediationDetails view={view} />), /<button[^>]*>重试上传<\/button>/)
})

test("an action whose callback the caller did not wire is never shown", () => {
  const brand: PublishRemediationModel = {
    ...uploadFailure,
    cause: "brand_hashtag",
    action: { kind: "repair_brand", label: "修复品牌字段" },
  }
  assert.equal(remediationView(brand, { onRetryStage: () => undefined }).action, undefined)
  assert.doesNotMatch(renderToStaticMarkup(<PublishRemediation remediation={brand} />), /修复品牌字段/)

  let repaired = 0
  const wired = remediationView(brand, { onRepairBrand: () => { repaired += 1 } })
  wired.action!.run()
  assert.equal(repaired, 1)
})

const awaiting: WorkflowProductLifecycle = {
  revision: 1, view_revision: 1, stage: "awaiting_content", ai: "ready", media: "ready",
  fields: "valid", image_total: 0, image_completed: 0, images: [], failure_log: [],
  ai_candidates: [], product_videos: [], source_file_name: "SZ-0001.png",
}

test("a bare local track failure renders collapsed guidance whose button retries only that leg", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: awaiting, rowLog: "", hasSource: true,
    tracks: { id: "row-1", ai: "done", render: "failed", upload: "idle" },
  })!
  const calls: PreparationVerb[] = []
  const markup = renderToStaticMarkup(
    <PublishRemediation remediation={remediation} onRetryStage={(verb) => calls.push(verb)} />,
  )
  assert.doesNotMatch(markup, /<details[^>]*\bopen/)
  assert.match(markup, /原因.*切片步骤在本机没有完成.*影响范围.*识别结果已完成并保留.*处理步骤/s)
  assert.equal((markup.match(/<button/g) ?? []).length, 1)
  assert.match(markup, /<button[^>]*>重试切片<\/button>/)
  remediationView(remediation, { onRetryStage: (verb) => calls.push(verb) }).action!.run()
  assert.deepEqual(calls, ["render"])
})

test("an Unknown row renders no button even when every row callback is wired", () => {
  const remediation = resolvePublishRemediation({
    lifecycle: { ...awaiting, stage: "outcome_unknown" }, rowLog: "",
    tracks: { id: "row-1", ai: "done", render: "failed", upload: "idle" },
  })!
  const markup = renderToStaticMarkup(
    <PublishRemediation
      remediation={remediation}
      onRetryStage={() => undefined}
      onRepairBrand={() => undefined}
      onReviewCandidates={() => undefined}
    />,
  )
  assert.doesNotMatch(markup, /<button/)
  assert.doesNotMatch(markup, /等待系统对账/)
  assert.match(markup, /不要重新发送/)
})


test("a structured diagnostic keeps the same trace in its details and copy affordance", () => {
  const markup = renderToStaticMarkup(<RemediationDetails view={{
    reason: "平台拒绝该行", scope: "原店铺", steps: ["按当前字段提示修改"], traceId: "same-trace-id",
  }} />)
  assert.match(markup, /请求追踪编号.*same-trace-id/s)
  assert.doesNotMatch(markup, /诊断编号|SHA-256|原文/)
  assert.match(markup, /复制诊断信息/)
  assert.doesNotMatch(markup, /role="alert"/)
})


test("an unknown strip without exact Intent capability supplies manual steps and no release button", () => {
  const markup = renderToStaticMarkup(<UnknownReleaseStrip rowIds={["row"]} facts={[{
    id: "row", offerId: "ART-9", taskId: "5666996254", missing: ["intent", "store", "permission"],
  }]} releasing={false} disabled={false}
    onRelease={() => { throw new Error("no release is available") }} />)
  assert.match(markup, /货号「ART-9」，任务号 5666996254。缺少Intent、店铺、释放权限/)
  assert.match(markup, /确认前不要重发/)
  assert.doesNotMatch(markup, /<button|恢复待核对|role="alert"/)
})

test("production manual Unknown fallback offers only explicit inspection, never release", () => {
  const markup = renderToStaticMarkup(<UnknownReleaseStrip rowIds={["row"]} releasing={false} disabled={false}
    onInspect={() => {}} onRelease={() => { throw new Error("release is unavailable") }} />)
  assert.match(markup, /核对原 Intent/)
  assert.match(markup, /确认前不要重发/)
  assert.doesNotMatch(markup, /释放原 Intent|恢复待核对|role="alert"/)
  assert.equal((markup.match(/<button/g) ?? []).length, 1)
})

test("inspected availability exposes an explicitly named confirmation entry and Stop disables it", () => {
  let releases = 0
  const props = {
    rowIds: ["row"], releasing: false, available: true, onRelease: () => { releases++ },
    facts: [{ id: "row", offerId: "ART-9", intentId: "intent-9", storeLabel: "主店", missing: [] }],
  }
  const available = renderToStaticMarkup(<UnknownReleaseStrip {...props} disabled={false} />)
  assert.match(available, /aria-label="核对后释放 1 件商品的确切未确认 Intent"/)
  assert.match(available, /货号「ART-9」，店铺「主店」，Intent intent-9/)
  assert.match(available, /释放不会发送/)
  assert.doesNotMatch(available, /缺少/)
  assert.doesNotMatch(available, /<button[^>]*\sdisabled=""/, "CSS disabled: utilities are not a disabled attribute")
  const stopped = renderToStaticMarkup(<UnknownReleaseStrip {...props} disabled />)
  assert.match(stopped, /<button[^>]*disabled=""[^>]*aria-label="核对后释放 1 件商品的确切未确认 Intent"/)
  assert.equal(releases, 0, "render / availability never invokes the mutation")
})

test("a diagnostic reference is forwarded safely without granting an Unknown row a business action", () => {
  const model: PublishRemediationModel = {
    ...resolvePublishRemediation({ lifecycle: { ...awaiting, stage: "outcome_unknown" }, rowLog: "" })!,
    diagnosticId: "exact-diagnostic-id", traceId: "original-request-trace",
  }
  let actions = 0
  const handlers = { onRepairBrand: () => { actions++ }, onRetryStage: () => { actions++ }, onReviewCandidates: () => { actions++ } }
  const view = remediationView(model, handlers)
  assert.equal(view.diagnosticId, model.diagnosticId)
  assert.equal(view.action, undefined)
  const markup = renderToStaticMarkup(<PublishRemediation remediation={model} {...handlers} />)
  assert.match(markup, /诊断编号.*exact-diagnostic-id/s)
  assert.match(markup, /复制诊断信息/)
  assert.match(markup, /不要重新发送/)
  assert.doesNotMatch(markup, /<button[^>]*>(?:修复品牌字段|重试|释放原 Intent)|role="alert"/)
  assert.equal((markup.match(/<button/g) ?? []).length, 1, "only the read-only copy gesture is available")
  assert.equal(actions, 0)
  for (const diagnosticId of ["", " ", "raw exception\ntext", "x".repeat(129)]) {
    assert.equal(remediationView({ ...model, diagnosticId }, handlers).diagnosticId, undefined)
  }
})

test("the normal Cloud brand remediation button keeps authoritative copy and invokes its row callback once", () => {
  const issue: components["schemas"]["ListingIssue"] = {
    allowed_actions: ["edit_row"], code: "OZON_ROW_REJECTED", phase: "submit",
    created_at_ms: 1, credential_revision: 1, dispatch_evidence: "rejected", endpoint: "import",
    input_revision: awaiting.revision, intent_id: "brand-intent", request_hash: "digest",
    retry_after_fallback: false, row_id: "brand-row", store_id: "brand-store", safe_message: "",
    summary: "Cloud 当前品牌字段原因", remediation: "Cloud 当前处理步骤：清空违规搜索标签并重新校验",
    scope: "store", trace_id: "cloud-brand-trace",
  }
  const lifecycle: WorkflowProductLifecycle = { ...awaiting, stage: "publish_rejected", last_error_code: "BR_hashtag_brand",
    last_error_detail: "旧品牌拒绝说明", submission_issue: issue }
  const facts: PublishRemediationFacts = {
    lifecycle,
    readiness: { ready_to_publish: false, can_start_publish_attempt: false,
      blockers: ["publish_conflict"], allowed_actions: ["edit_fields"] },
    rowLog: "", brandRepairable: true,
  }
  const remediation = resolvePublishRemediation(facts)!
  let repaired = 0, otherActions = 0, requests = 0
  const handlers = { onRepairBrand: () => { repaired++ }, onRetryStage: () => { otherActions++ }, onReviewCandidates: () => { otherActions++ } }
  let tree!: ReturnType<typeof RemediationDetails>
  function Capture() {
    const component = PublishRemediation({ remediation, ...handlers })
    tree = RemediationDetails(component.props)
    return tree
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => { requests++; throw new Error("render and repair binding must not submit or query") }
  try {
    const markup = renderToStaticMarkup(<Capture />)
    assert.match(markup, /原因.*Cloud 当前品牌字段原因.*影响范围.*当前店铺及绑定该店铺的商品.*处理步骤.*Cloud 当前处理步骤/s)
    assert.match(markup, /请求追踪编号.*cloud-brand-trace/s)
    assert.match(markup, /<button[^>]*>修复品牌字段<\/button>/)
    assert.doesNotMatch(markup, /旧品牌拒绝说明|重新识别|重新切片|role="alert"/)
    assert.equal(repaired, 0, "render never repairs")
    const button = Children.toArray(tree.props.children).find((node) =>
      isValidElement<{ children?: unknown }>(node) && node.type === Button && node.props.children === "修复品牌字段")
    assert.ok(isValidElement<Record<string, unknown>>(button), "the normal component emitted its built-in repair Button")
    const click = button.props.onClick
    assert.ok(typeof click === "function")
    let stopped = 0
    click({ stopPropagation() { stopped++ } })
    assert.equal(repaired, 1)
    assert.equal(stopped, 1, "the repair click does not select or focus the row")
    assert.equal(otherActions, 0, "repair never invokes retry or review")
    const unbound = renderToStaticMarkup(<PublishRemediation remediation={remediation} onRetryStage={handlers.onRetryStage} />)
    assert.doesNotMatch(unbound, /<button[^>]*>修复品牌字段<\/button>/)
    assert.match(unbound, /Cloud 当前品牌字段原因.*Cloud 当前处理步骤/s)
    const deniedCases: [string, Partial<WorkflowProductLifecycle>][] = [
      ["stale", { submission_issue: { ...issue, input_revision: awaiting.revision - 1 } }],
      ["resolved", { submission_issue: { ...issue, resolved_at_ms: 2 } }],
      ["denied", { submission_issue: { ...issue, allowed_actions: [] } }],
      ["unknown code", { submission_issue: { ...issue, code: "UNCLASSIFIED_BRAND_FAILURE" } }],
      ["non-brand", { last_error_code: "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT" }],
      ["Unknown", { stage: "outcome_unknown" }],
    ]
    for (const [name, patch] of deniedCases) {
      const denied = resolvePublishRemediation({ ...facts, lifecycle: { ...lifecycle, ...patch } })!
      assert.equal(denied.action, undefined, name)
      const blocked = renderToStaticMarkup(<PublishRemediation remediation={denied} {...handlers} />)
      assert.doesNotMatch(blocked, /<button[^>]*>修复品牌字段<\/button>/, `${name} cannot gain a button from a wired callback`)
    }
    assert.equal(repaired, 1, "the missing callback and rerender do not invoke repair")
    assert.equal(otherActions, 0)
    assert.equal(requests, 0)
  } finally { globalThis.fetch = originalFetch }
})

import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { components } from "@/api/schema"
import type { WorkflowProductStatusView } from "@/bindings/commands"
import { getDiagnosticDetail, setErrorTelemetryContext } from "@/lib/error-telemetry"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { product } from "../cloud-fanout-tests/fixtures"
import type { ListingRow } from "../model/listing-row"
import { rowStatusView } from "../model/row-state"
import { cloudRow } from "../cloud-fanout-tests/fixtures"
import { commitProductStatuses } from "./product-status"
import { captureWorkbenchPublishDiagnostics, currentWorkbenchDiagnostic } from "./publish-diagnostic-producer"
import { editListingProduct, listingWorkbenchScope, patchListingWorkbench, peekListingWorkbench, resetListingWorkbench, subscribeListingWorkbench } from "./listing-workbench-store"
import { PublishStateCell } from "./workbench-publish-state-cell"

const issue: components["schemas"]["ListingIssue"] = {
  allowed_actions: [], code: "OZON_ACCESS_UNCLASSIFIED", created_at_ms: 1, credential_revision: 1,
  dispatch_evidence: "rejected", endpoint: "import", input_revision: 1, intent_id: "original-intent",
  phase: "submit", remediation: "Cloud 的人工核对步骤", request_hash: "digest", retry_after_fallback: false,
  row_id: "a", safe_message: "", scope: "store", store_id: "store", summary: "Cloud 的未分类原因", trace_id: "shared-trace",
}
function fixture(ids = ["a"]): Array<{ draftId: string; status: WorkflowProductStatusView }> {
  resetListingWorkbench()
  const rows: ListingRow[] = ids.map((id) => ({ id, draftId: id, imageName: id + ".png", status: "ready",
    stage: "ready_to_publish", ai: "done", render: "done", upload: "done", log: "" }))
  patchListingWorkbench({ cardId: "card", rows, productDrafts: Object.fromEntries(ids.map((id) => [id, product(id)])) })
  return ids.map((id) => ({ draftId: id, status: { ...rowStatusView(cloudRow(id)),
    lifecycle: { ...product(id).lifecycle, stage: "publish_rejected" as const, submission_issue: { ...issue, rowId: id } } } }))
}
function settle(): Promise<void> {
  const settled = () => peekListingWorkbench().rows.every((row) => !row.publishDiagnostic || !!row.publishDiagnostic.diagnosticId)
  if (settled()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const unsubscribe = subscribeListingWorkbench(() => {
      if (!settled()) return
      clearTimeout(deadline); unsubscribe(); resolve()
    })
    const deadline = setTimeout(() => { unsubscribe(); reject(new Error("normalized diagnostics did not attach")) }, 2_000)
  })
}

test("a real 64-row normalized status batch uses two diagnostic commits and an identical poll uses none", async () => {
  const original = globalThis.fetch, log = console.log
  let requests = 0, commits = 0
  let unsubscribe = () => {}
  globalThis.fetch = async () => { requests++; throw new Error("status normalization cannot open a window") }
  console.log = () => {}
  setErrorTelemetryContext({ sessionKey: "batched-status-producer" })
  try {
    const items = fixture(Array.from({ length: 64 }, (_, index) => `row-${index}`))
    commitProductStatuses(items, listingWorkbenchScope(), false)
    unsubscribe = subscribeListingWorkbench(() => { commits++ })
    await captureWorkbenchPublishDiagnostics(items.map((item) => item.draftId))
    assert.equal(commits, 2, "reserve and completion are batched, not a commit for every row")
    assert.equal(peekListingWorkbench().rows.filter((row) => currentWorkbenchDiagnostic(row)?.diagnosticId).length, 64)
    await captureWorkbenchPublishDiagnostics(items.map((item) => item.draftId))
    assert.equal(commits, 2)
    assert.equal(requests, 0)
  } finally { unsubscribe(); setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench(); globalThis.fetch = original; console.log = log }
})

test("real status commit and repeated polls/renders preserve one diagnostic per problem, while two same-trace rows own distinct IDs", async () => {
  const before = globalThis.fetch, log = console.log
  let requests = 0
  const captures: string[] = []
  globalThis.fetch = async () => { requests++; throw new Error("pure status presentation cannot fetch") }
  console.log = (line) => { if (String(line).includes("[diagnostic] captured")) captures.push(String(line)) }
  setErrorTelemetryContext({ sessionKey: "status-producer-test" })
  try {
    const items = fixture(["a", "b"])
    assert.equal(commitProductStatuses(items), true)
    await settle()
    const ids = peekListingWorkbench().rows.map((row) => currentWorkbenchDiagnostic(row)?.diagnosticId)
    assert.ok(ids[0] && ids[1])
    assert.notEqual(ids[0], ids[1])
    assert.equal(getDiagnosticDetail(ids[0]!).event?.trace_id, "shared-trace")
    for (let poll = 0; poll < 3; poll++) {
      commitProductStatuses(structuredClone(items))
      await settle()
      const state = peekListingWorkbench(), row = state.rows[0]!
      const html = renderToStaticMarkup(createElement(PublishStateCell, {
        row, inView: true, lifecycle: state.productBases.a!.lifecycle,
        onCancelIntent() {}, onReviewCandidates() {}, onRetryStage() {},
      }))
      assert.match(html, new RegExp(ids[0]!))
      assert.match(html, /诊断编号.*请求追踪编号/)
      assert.match(html, /shared-trace/)
    }
    assert.deepEqual(peekListingWorkbench().rows.map((row) => row.publishDiagnostic?.diagnosticId), ids)
    assert.equal(captures.length, 2)
    assert.equal(requests, 0)
  } finally { setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench(); globalThis.fetch = before; console.log = log }
})

test("a distinct authoritative Intent issue sharing row, trace and timestamp receives a new diagnostic; polling that same issue does not", async () => {
  setErrorTelemetryContext({ sessionKey: "distinct-intent-same-trace" })
  try {
    const items = fixture()
    commitProductStatuses(items)
    await settle()
    const first = currentWorkbenchDiagnostic(peekListingWorkbench().rows[0]!)?.diagnosticId
    assert.ok(first)
    items[0]!.status.lifecycle.submission_issue = { ...issue, intent_id: "next-authoritative-intent" }
    commitProductStatuses(items)
    await settle()
    const second = currentWorkbenchDiagnostic(peekListingWorkbench().rows[0]!)?.diagnosticId
    assert.ok(second)
    assert.notEqual(first, second)
    assert.equal(getDiagnosticDetail(first).event?.trace_id, getDiagnosticDetail(second).event?.trace_id)
    commitProductStatuses(structuredClone(items))
    await settle()
    assert.equal(currentWorkbenchDiagnostic(peekListingWorkbench().rows[0]!)?.diagnosticId, second)
  } finally { setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench() }
})

for (const change of ["scope", "mediaEpoch", "card", "store", "revision", "viewRevision", "dirty", "removal", "identity"] as const) {
  test(`pending status diagnostic cannot attach across the real ${change} fence`, async () => {
    setErrorTelemetryContext({ sessionKey: "pending-" + change })
    try {
      const items = fixture()
      commitProductStatuses(items, listingWorkbenchScope(), false)
      const pending = captureWorkbenchPublishDiagnostics(["a"])
      const state = peekListingWorkbench(), base = state.productBases.a!
      switch (change) {
        case "scope": resetListingWorkbench(); break
        case "mediaEpoch": patchListingWorkbench({ mediaEpoch: state.mediaEpoch + 1 }); break
        case "card": patchListingWorkbench({ cardId: "foreign-card" }); break
        case "store": patchListingWorkbench({ productDrafts: { a: { ...base, target_store_id: "foreign-store" } } }); break
        case "revision": patchListingWorkbench({ productDrafts: { a: { ...base, lifecycle: { ...base.lifecycle, revision: 2 } } } }); break
        case "viewRevision": patchListingWorkbench({ productDrafts: { a: { ...base, lifecycle: { ...base.lifecycle, view_revision: 2 } } } }); break
        case "dirty": editListingProduct("a", { ...base, draft: { ...base.draft, values: {} } }); break
        case "removal": patchListingWorkbench({ pendingRemovalIds: new Set(["a"]) }); break
        case "identity": invalidateAllSessionCaches(); setErrorTelemetryContext({ sessionKey: "different-identity" }); break
      }
      await pending
      assert.equal(peekListingWorkbench().rows.find((row) => row.draftId === "a")?.publishDiagnostic?.diagnosticId, undefined)
    } finally {
      setErrorTelemetryContext({ sessionKey: null })
      // resetListingWorkbench deliberately keeps pendingRemovalIds so a real
      // background delete survives; this synthetic fence must not leak "a".
      patchListingWorkbench({ pendingRemovalIds: new Set() })
      resetListingWorkbench()
    }
  })
}

test("known Cloud field refusal and stale/resolved issue commits create no diagnostic reference", async () => {
  setErrorTelemetryContext({ sessionKey: "known-fields-test" })
  try {
    const items = fixture()
    items[0]!.status.lifecycle.submission_issue = { ...issue, code: "OZON_ROW_REJECTED", allowed_actions: ["edit_row"] }
    commitProductStatuses(items)
    await settle()
    assert.equal(peekListingWorkbench().rows[0]?.publishDiagnostic, undefined)
    items[0]!.status.lifecycle.submission_issue = { ...issue, input_revision: 0 }
    items[0]!.status.lifecycle.stage = "fields_invalid"
    commitProductStatuses(items)
    await settle()
    assert.equal(peekListingWorkbench().rows[0]?.publishDiagnostic, undefined)
  } finally { setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench() }
})

test("a fields_invalid status commit logs the field sentences", () => {
  const lines: string[] = []
  const original = console.log
  console.log = (line?: unknown) => { lines.push(String(line)) }
  try {
    const items = fixture(["field-row"])
    items[0]!.status.lifecycle.stage = "uploading"
    items[0]!.status.lifecycle.view_revision = 7
    commitProductStatuses(items, listingWorkbenchScope(), false)
    lines.length = 0
    const next = structuredClone(items[0]!.status)
    next.lifecycle.stage = "fields_invalid"
    next.lifecycle.view_revision = 15
    next.issues = [
      { field_key: "currency_code", code: "required", message: "价格币种为必填项" },
      { field_key: "currency_code", code: "required", message: "价格币种为必填项" },
    ]
    assert.equal(commitProductStatuses([{ draftId: "field-row", status: next }], listingWorkbenchScope(), false), true)
    assert.deepEqual(
      lines.filter((line) => line.includes("row.status")),
      ["[listing-send] row.status row=field-row stage=fields_invalid revision=15 issues=价格币种为必填项"],
    )
  } finally {
    console.log = original
    resetListingWorkbench()
  }
})

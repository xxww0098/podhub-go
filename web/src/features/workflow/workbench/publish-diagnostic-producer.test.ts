import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { getDiagnosticDetail, setErrorTelemetryContext } from "@/lib/error-telemetry"
import { product } from "../cloud-fanout-tests/fixtures"
import { captureWorkbenchPublishProblem, currentWorkbenchDiagnostic } from "./publish-diagnostic-producer"
import { editListingProduct, patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "./listing-workbench-store"
import { PublishStateCell } from "./workbench-publish-state-cell"

function fixture() {
  resetListingWorkbench()
  patchListingWorkbench({ cardId: "card", productDrafts: { row: product("row") }, rows: [{
    id: "row", draftId: "row", imageName: "row.png", stage: "ready_to_publish", status: "ready",
    ai: "done", render: "done", upload: "done", log: "",
  }] })
}
const nativeFailure = { platform: "ozon", stage: "repair", family: "control" as const, code: "wasm_failed", traceId: "same-trace" }

test("two distinct failed native actions sharing a trace own separate IDs; real ready row displays read-only diagnostic without business callbacks", async () => {
  const original = globalThis.fetch
  let calls = 0, actions = 0
  globalThis.fetch = async () => { calls++; throw new Error("a local native action cannot request diagnostic delivery") }
  setErrorTelemetryContext({ sessionKey: "native-explicit-producer" })
  try {
    fixture()
    const a = await captureWorkbenchPublishProblem("row", 1, nativeFailure, () => true)
    const firstReceipt = currentWorkbenchDiagnostic(peekListingWorkbench().rows[0]!)?.errorFeedback?.errorId
    const b = await captureWorkbenchPublishProblem("row", 1, nativeFailure, () => true)
    assert.ok(a?.event && b?.event)
    assert.notEqual(a.diagnosticId, b.diagnosticId)
    assert.equal(a.event.trace_id, b.event.trace_id)
    assert.equal(getDiagnosticDetail(b.diagnosticId).event?.payload_sha256, null)
    const state = peekListingWorkbench(), row = state.rows[0]!
    assert.equal(currentWorkbenchDiagnostic(row)?.diagnosticId, b.diagnosticId)
    const receipt = currentWorkbenchDiagnostic(row)?.errorFeedback
    assert.match(receipt!.errorId, /^[0-9]{20}$/)
    assert.notEqual(receipt!.errorId, firstReceipt)
    const html = renderToStaticMarkup(createElement(PublishStateCell, { row, inView: true, lifecycle: state.productBases.row!.lifecycle,
      onCancelIntent() { actions++ }, onReviewCandidates() { actions++ }, onRetryStage() { actions++ } }))
    assert.match(html, /技术详情.*诊断编号.*请求追踪编号/s)
    assert.ok(html.includes(b.diagnosticId))
    assert.ok(html.includes(receipt!.errorId))
    assert.doesNotMatch(html, /重新发送|释放未知|一键修复|上报诊断信息|role="alert"/)
    assert.equal(state.productBases.row!.lifecycle.stage, "ready_to_publish")
    assert.equal(row.publishUnconfirmed, undefined)
    assert.equal(calls + actions, 0)
  } finally { setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench(); globalThis.fetch = original }
})

for (const fence of ["scope", "revision", "media", "dirty", "action", "save"] as const) {
  test(`native diagnostic completion cannot patch across the current ${fence} boundary`, async () => {
    setErrorTelemetryContext({ sessionKey: "native-boundary-" + fence })
    let current = true
    try {
      fixture()
      const pending = captureWorkbenchPublishProblem("row", 1, nativeFailure, () => current)
      const state = peekListingWorkbench(), base = state.productBases.row!
      switch (fence) {
        case "scope": resetListingWorkbench(); break
        case "revision": patchListingWorkbench({ productDrafts: { row: { ...base, lifecycle: { ...base.lifecycle, revision: 2 } } } }); break
        case "media": patchListingWorkbench({ mediaEpoch: state.mediaEpoch + 1 }); break
        case "dirty": editListingProduct("row", { ...base, draft: { ...base.draft, values: {} } }); break
        case "action": current = false; break
        case "save": patchListingWorkbench({ rowSaveStates: { row: "saving" } }); break
      }
      await pending
      assert.equal(peekListingWorkbench().rows[0]?.publishDiagnostic?.diagnosticId, undefined)
      const row = peekListingWorkbench().rows[0]
      if (row) assert.equal(currentWorkbenchDiagnostic(row)?.diagnosticId, undefined)
    } finally { setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench() }
  })
}

test("known native fields cannot acquire a diagnostic reference or borrow the technical action's permission", async () => {
  setErrorTelemetryContext({ sessionKey: "known-native-producer" })
  try {
    fixture()
    assert.equal(await captureWorkbenchPublishProblem("row", 1, { platform: "ozon", stage: "validate", code: "required", field: "name" }, () => true), null)
    assert.equal(peekListingWorkbench().rows[0]!.publishDiagnostic, undefined)
  } finally { setErrorTelemetryContext({ sessionKey: null }); resetListingWorkbench() }
})

/** Actual hook + native send + mock HTTP. Only the final callback exception is
 * injected, so a thrown send cannot accidentally retain an editable lifecycle. */
import assert from "node:assert/strict"
import test, { before } from "node:test"
import { route } from "@/api/routes"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { toast } from "@/components/ui/toast"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { cloudRow, product } from "../cloud-fanout-tests/fixtures"
import { capturePublishQueue } from "../cloud-fanout-tests/publish-queue-harness"
import { workflowActions } from "../workflow-actions"
import { commitProductStatus } from "../workbench/product-status"
import { listingWorkbenchScope, patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { rowStatusView } from "../model/row-state"
import type { ListingRow } from "../model/listing-row"
import { nativeCardPayload, serve, warmProductionSend } from "./send-test-support"

before(warmProductionSend)

function fixture() {
  resetListingWorkbench()
  const row = cloudRow("thrown"), other = cloudRow("other-store")
  const hook = capturePublishQueue()
  rememberListingRows([row, other], rowCacheScope())
  const item = product(row.id), foreign = { ...product(other.id), target_store_id: "other" }
  const rows: ListingRow[] = [row, other].map((raw) => ({ id: raw.id, draftId: raw.id, imageName: raw.source.fileName,
    status: "ready", stage: "ready_to_publish", ai: "done", render: "done", upload: "done", log: "before" }))
  patchListingWorkbench({ cardId: "card", productDrafts: { [row.id]: item, [other.id]: foreign },
    rows, queueFrozenIds: [row.id] })
  const sendBefore = workflowActions.workflowSend, toastBefore = toast.add
  const notices: string[] = []
  toast.add = ((notice) => { notices.push(String(notice.title)); return "thrown-send-test" }) as typeof toast.add
  const rawCard = { id: "card", revision: 1, storeId: "store", title: "Test", payload: nativeCardPayload(), updatedAtMs: 1 }
  return { row, other, hook, item, foreign, rawCard, sendBefore, notices,
    restore() { workflowActions.workflowSend = sendBefore; toast.add = toastBefore; resetListingWorkbench() } }
}

test("a thrown post-dispatch hook callback projects both row and product as Unknown exception, preserves cohort and never resends", async () => {
  const fx = fixture()
  let sends = 0
  const cloud = serve(({ url, method, body }) => {
    if (url === route("listingCardsById", { id: "card" })) return method === "PATCH"
      ? { ...fx.rawCard, revision: 2, payload: body.payload } : fx.rawCard
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [fx.row], nextCursor: null }
    assert.equal(url, route("listingSubmit"))
    assert.equal(method, "POST")
    assert.deepEqual(body.rowIds, [fx.row.id])
    assert.deepEqual(body.expectedRevisions, [{ rowId: fx.row.id, revision: 1 }])
    throw new TypeError("simulated lost submit response")
  })
  workflowActions.workflowSend = async (...args) => {
    sends++
    const results = await fx.sendBefore(...args)
    assert.equal(results[0]?.outcome, "unknown", "the real native/HTTP rail handled the lost response")
    throw new Error("simulated completion callback exception")
  }
  try {
    await fx.hook.startPublish([fx.row.id])
    const state = peekListingWorkbench(), result = state.rows[0]!
    assert.equal(sends, 1)
    assert.equal(result.status, "exception")
    assert.equal(result.stage, "outcome_unknown")
    assert.equal(result.publishUnconfirmed, true)
    assert.equal(state.productBases[fx.row.id]!.lifecycle.stage, "outcome_unknown")
    assert.equal(state.productBases[fx.row.id]!.lifecycle.revision, 1)
    assert.equal(state.productBases[fx.row.id]!.lifecycle.view_revision, 1)
    assert.deepEqual(state.queueFrozenIds, [fx.row.id])
    assert.equal(state.productBases[fx.other.id], fx.foreign)
    assert.equal(state.rows[1]!.log, "before")
    assert.match(result.log, /未确认.*不要重复发送/)
    assert.doesNotMatch(result.log, /simulated completion|请重试/)
    assert.equal(state.queueRunning, false)
    assert.equal(cloud.calls.filter((call) => call.url === route("listingSubmit")).length, 1)
    assert.equal(cloud.calls.some((call) => call.url.startsWith(route("listingIntents")) || /cancel|release/.test(call.url)), false)
    assert.equal(fx.notices.length, 2, "one submitting notice and one command-error notification")
    const calls = cloud.calls.length
    await fx.hook.startPublish([fx.row.id])
    assert.equal(sends, 1)
    assert.equal(cloud.calls.length, calls, "an explicit repeat remains fenced locally")
  } finally { cloud.restore(); fx.restore() }
})

test("a pre-dispatch queue PATCH refusal restores the original lifecycle and keeps the concrete media removal steps", async () => {
  const fx = fixture()
  let sends = 0
  workflowActions.workflowSend = async (...args) => { sends++; return fx.sendBefore(...args) }
  const cloud = serve(({ url, method }) => {
    assert.equal(url, route("listingCardsById", { id: "card" }))
    if (method === "GET") return fx.rawCard
    assert.equal(method, "PATCH")
    return new Response(JSON.stringify({ code: "validation", error: "系统媒体组 product_video 不能加入默认字段；请移除该组并重新保存" }), { status: 400 })
  })
  try {
    await fx.hook.startPublish([fx.row.id])
    const state = peekListingWorkbench(), result = state.rows[0]!
    assert.equal(sends, 0)
    assert.equal(cloud.calls.filter((call) => call.method === "PATCH").length, 1)
    assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 0)
    assert.equal(result.status, "ready")
    assert.equal(result.stage, "ready_to_publish")
    assert.notEqual(result.publishUnconfirmed, true)
    assert.deepEqual(state.productBases[fx.row.id]!.lifecycle, fx.item.lifecycle)
    assert.match(result.log, /product_video.*移除.*重新保存/)
    assert.doesNotMatch(result.log, /发送未提交，请重试|结果未确认/)
    assert.equal(state.rows[1]!.log, "before")
    assert.equal(fx.notices.length, 2)
  } finally { cloud.restore(); fx.restore() }
})

test("a local preflight Unknown refusal never reaches Card save or the underlying send", async () => {
  const fx = fixture()
  let sends = 0
  patchListingWorkbench((state) => ({ rows: state.rows.map((row) => row.id === fx.row.id ? { ...row, publishUnconfirmed: true } : row) }))
  workflowActions.workflowSend = async (...args) => { sends++; return fx.sendBefore(...args) }
  const cloud = serve(() => { throw new Error("preflight must remain local") })
  try {
    await fx.hook.startPublish([fx.row.id])
    assert.equal(sends, 0)
    assert.equal(cloud.calls.length, 0)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    assert.equal(peekListingWorkbench().productBases[fx.row.id]!.lifecycle.stage, "ready_to_publish")
  } finally { cloud.restore(); fx.restore() }
})

for (const mode of ["accepted", "queued", "submitting", "newer-view", "revision", "store", "row", "removal", "route", "identity"] as const) {
  test(`a late thrown submit preserves ${mode} authority instead of smearing Unknown over it`, async () => {
    const fx = fixture()
    let release!: () => void, seen!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const sendSeen = new Promise<void>((resolve) => { seen = resolve })
    const cloud = serve(({ url, method, body }) => {
      if (url === route("listingCardsById", { id: "card" })) return method === "PATCH"
        ? { ...fx.rawCard, revision: 2, payload: body.payload } : fx.rawCard
      if (url.startsWith(`${route("listingRows")}?`)) return { items: [fx.row], nextCursor: null }
      assert.equal(url, route("listingSubmit"))
      throw new TypeError("simulated lost submit response")
    })
    workflowActions.workflowSend = async (...args) => {
      await fx.sendBefore(...args)
      seen()
      await gate
      throw new Error("late completion callback exception")
    }
    const sending = fx.hook.startPublish([fx.row.id])
    try {
      await sendSeen
      if (mode === "accepted" || mode === "queued" || mode === "submitting" || mode === "newer-view") {
        const status = rowStatusView({ ...fx.row, view_revision: mode === "newer-view" ? 2 : 1,
          projection: listingProjection({ stage: mode === "newer-view" ? "ready_to_publish" : mode }) })
        assert.equal(commitProductStatus(fx.row.id, status, listingWorkbenchScope(), "正在提交发送..."), true)
      }
      if (mode === "revision" || mode === "store") patchListingWorkbench((state) => ({ productDrafts: {
        [fx.row.id]: { ...state.productBases[fx.row.id]!,
          ...(mode === "store" ? { target_store_id: "different-store" } : {}),
          lifecycle: { ...state.productBases[fx.row.id]!.lifecycle, revision: mode === "revision" ? 2 : 1 },
        },
      } }))
      if (mode === "row") patchListingWorkbench((state) => ({ rows: state.rows.map((row) => row.id === fx.row.id ? { ...row, id: "replacement-ui-row" } : row) }))
      if (mode === "removal") patchListingWorkbench((state) => ({ rows: state.rows.filter((row) => row.id !== fx.row.id) }))
      if (mode === "route") resetListingWorkbench()
      if (mode === "identity") invalidateAllSessionCaches()
      const current = peekListingWorkbench(), currentProduct = current.productBases[fx.row.id], currentRow = current.rows[0]
      release()
      await sending
      assert.equal(peekListingWorkbench().productBases[fx.row.id], currentProduct)
      assert.equal(peekListingWorkbench().rows[0], currentRow)
      assert.notEqual(peekListingWorkbench().rows[0]?.publishUnconfirmed, true)
      assert.equal(cloud.calls.filter((call) => call.url === route("listingSubmit")).length, 1)
      assert.equal(cloud.calls.some((call) => call.url.startsWith(route("listingIntents")) || /cancel|release/.test(call.url)), false)
    } finally { release(); await sending; cloud.restore(); fx.restore() }
  })
}

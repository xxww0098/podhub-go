import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import { toast } from "@/components/ui/toast"
import { invalidateAccountOverview } from "@/features/account/account-overview-cache"
import { forgetListingRows } from "@/bindings/listing-row-cache"
import type { ListingRow } from "../model/listing-row"
import { resolvePublishRemediation } from "../model/publish-remediation"
import { publishPreflight } from "../submit/publish-policy"
import { nativeCardPayload, refusal, serve, warmProductionSend } from "../submit/send-test-support"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { PublishStateCell } from "../workbench/workbench-publish-state-cell"
import { cloudRow, product, SIGNED_IN } from "./fixtures"
import { capturePublishQueue } from "./publish-queue-harness"

/** UI counterpart of the separately owned real HTTP mixed-offer transaction test. */
for (const storedStore of [null, "old-store", "store"] as const) test(`offer_busy with stored Store ${storedStore} preserves refusal, current send Store and notice completion`, async () => {
  await warmProductionSend()
  resetListingWorkbench()
  const ids = ["older-offer", "different-offer"]
  forgetListingRows(ids)
  const rows = ids.map((id): ListingRow => ({ id, draftId: id, imageName: `${id}.png`, status: "ready",
    ai: "done", render: "done", upload: "done", log: "" }))
  patchListingWorkbench({ cardId: "card", rows, queueFrozenIds: ids,
    productDrafts: Object.fromEntries(ids.map((id) => [id, { ...product(id), target_store_id: storedStore ?? "" }])) })
  const hook = capturePublishQueue()
  const errors: string[] = []
  const descriptions: string[] = []
  const progressIds: string[] = [], closedIds: string[] = []
  const previous = toast.add
  const previousClose = toast.close
  toast.add = ((notice) => {
    if (notice.type === "error") { errors.push(String(notice.title)); descriptions.push(renderToStaticMarkup(createElement("div", null, notice.description))) }
    if (notice.type === "loading") progressIds.push(notice.id!)
    return notice.id ?? "notice"
  }) as typeof toast.add
  toast.close = ((id) => { if (id) closedIds.push(id) }) as typeof toast.close
  const cloud = serve(({ url, method, body }) => {
    if (url === route("listingCardsById", { id: "card" })) return { id: "card", revision: 1,
      payload: method === "PATCH" ? body.payload : nativeCardPayload(), updated_at_ms: 1 }
    if (url === route("listingSubmit")) {
      assert.deepEqual(body.row_ids, ids)
      return refusal(409, "offer_busy", "同一 offer 已有另一次未完成的发送")
    }
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [] }
    if (url.startsWith(`${route("listingRows")}/`)) return { ...cloudRow(url.split("/").at(-1)!), store_id: storedStore }
    if (url.startsWith(`${route("listingIntents")}?`)) return { items: [] }
    throw new Error(`unexpected ${method} ${url}`)
  })
  try {
    await hook.startPublish()
    const current = peekListingWorkbench()
    assert.equal(cloud.calls.filter((call) => call.url === route("listingSubmit")).length, 1, "no automatic replay")
    assert.equal(cloud.calls.some((call) => /release|recover|repair/.test(call.url)), false)
    assert.equal(errors.length, 1)
    assert.equal(progressIds.length, 1)
    assert.ok(closedIds.includes(progressIds[0]!))
    assert.match(errors[0]!, /已受理/)
    assert.doesNotMatch(errors[0]!, /释放|未完成发送/)
    assert.match(descriptions[0]!, /编号<\/dt><dd[^>]*>[0-9]{20}/)
    assert.doesNotMatch(descriptions[0]!, /错误代码|offer_busy/)
    for (const row of current.rows) {
      assert.match(row.log, /整块未入队.*不表示块内每个货号都冲突/)
      const lifecycle = current.productDrafts[row.draftId]!.lifecycle
      assert.equal(row.publishRequestEvidence?.contractInvalid, false)
      assert.equal(row.publishRequestEvidence?.identity.storeId, "store")
      const guidance = resolvePublishRemediation({ lifecycle, rowLog: row.log,
        requestEvidence: row.publishRequestEvidence, requestIdentity: row.publishRequestEvidence?.identity })!
      assert.equal(guidance.cause, "request_offer_busy")
      assert.match(guidance.scope, /整块.*其它货号/)
      assert.match(guidance.steps.join(""), /确切.*读回.*原生校验.*用户明确发送/)
      assert.equal(guidance.action, undefined)
      const markup = renderToStaticMarkup(createElement(PublishStateCell, {
        row, lifecycle, inView: true, onCancelIntent() {}, onReviewCandidates() {}, onRetryStage() {},
      }))
      assert.match(markup, /影响范围.*整块商品/s)
      assert.match(markup, /发送受阻/)
      assert.doesNotMatch(markup, /可发送|可以发送|确切未知|只有明确确认可释放/)
      assert.doesNotMatch(markup, /同一 offer 已有另一次未完成的发送|role="alert"/)
    }
  } finally { cloud.restore(); toast.add = previous; toast.close = previousClose; forgetListingRows(ids); invalidateAccountOverview(); resetListingWorkbench() }
})

test("older unknown and accepted operations stay fenced under a new request refusal", () => {
  for (const stage of ["outcome_unknown", "accepted", "queued", "submitting"] as const) {
    const row: ListingRow = { id: "row", draftId: "row", imageName: "offer.png", status: "failed", stage,
      ai: "done", render: "done", upload: "done", log: "发送未执行：本次整块未入队" }
    const view = product("row")
    const state = { rows: [row], queueFrozenIds: ["row"], productDrafts: { row: { ...view, lifecycle: { ...view.lifecycle, stage } } } }
    assert.equal(publishPreflight(state, new Set(["row"]), SIGNED_IN).ok, false, stage)
  }
})

import assert from "node:assert/strict"
import { afterEach, before, beforeEach, test } from "node:test"
import { route } from "@/api/routes"
import { readCategorySchema } from "@/bindings/listing-material-cache"
import type { ListingCore } from "@/listing-core/wasm"
import { sendPins } from "../prepare/executor-test-support"
import { patchListingWorkbench } from "../workbench/listing-workbench-store"
import { publishPreflight } from "./publish-policy"
import { sendRows } from "./send-rows"
import { accepted, CARD, CATEGORY, nativeRowView, openCard, resetSendState, residentRows, schemaData, serve, TYPE, wasmCore } from "./send-test-support"

let core: ListingCore
before(async () => { core = await wasmCore() })
beforeEach(resetSendState)
afterEach(resetSendState)

async function warm() {
  const stub = serve(() => schemaData())
  try { await readCategorySchema({ descriptionCategoryId: CATEGORY, typeId: TYPE, language: "default" }) }
  finally { stub.restore() }
}

test("send adopts the Card's current Store for existing unbound and previously bound rows without saving them first", async () => {
  const ids = ["unbound", "old-store"]
  residentRows(ids.map((id) => nativeRowView(id, { storeId: id === "unbound" ? "" : "store-old" })))
  openCard(CARD, TYPE, "store-current")
  await warm()
  const pins = sendPins(ids, (id) => id === "unbound" ? "" : "store-old")
  const stub = serve((call) => {
    assert.equal(call.url, route("listingSubmit"))
    assert.equal(call.method, "POST")
    return accepted(call.body)
  })
  try {
    const result = await sendRows({ row_ids: ids, expected_revisions: pins }, undefined, { core })
    assert.deepEqual(result.map((row) => row.outcome), ["start", "start"])
    assert.equal(stub.calls.length, 1)
    assert.deepEqual(stub.calls[0]!.body, { storeId: "store-current", row_ids: ids })
    assert.deepEqual(pins.map((pin) => pin.store_id), ["", "store-old"], "the click's original row pins remain unchanged")
  } finally { stub.restore() }
})

test("an explicitly unbound Card refuses a new send even when its row has an old Store", async () => {
  residentRows([nativeRowView("old-store", { storeId: "store-old" })])
  openCard(CARD, TYPE, "")
  const stub = serve(() => { throw new Error("an unbound Card must not send") })
  try {
    const [result] = await sendRows({ row_ids: ["old-store"], expected_revisions: sendPins(["old-store"], () => "store-old") }, undefined, { core })
    assert.equal(result!.error?.code, "target_store_missing")
    assert.equal(stub.calls.length, 0)
  } finally { stub.restore() }
})

test("new rows in a multi-Store Card adopt its current allocation during send", async () => {
  const ids = ["row-a", "row-b"]
  residentRows(ids.map((id) => nativeRowView(id, { storeId: "" })))
  openCard(CARD, TYPE, "store-a,store-b")
  await warm()
  const stub = serve((call) => accepted(call.body))
  try {
    const result = await sendRows({ row_ids: ids, expected_revisions: sendPins(ids, () => "") }, undefined, { core })
    assert.deepEqual(result.map((row) => row.outcome), ["start", "start"])
    // 两家 Store 是并发发送的（SEND_STORE_CONCURRENCY），请求到达顺序不定；
    // 用 Map 比较分配本身，不钉并发完成顺序。
    assert.deepEqual(new Map(stub.calls.map((call) => [call.body.storeId, call.body.row_ids])),
      new Map([["store-a", ["row-a"]], ["store-b", ["row-b"]]]))
  } finally { stub.restore() }
})

test("an accepted attempt keeps its original Store after its Card changes", async () => {
  residentRows([{ ...nativeRowView("accepted", { storeId: "store-original" }), submission_state: "accepted" }])
  openCard(CARD, TYPE, "store-new")
  await warm()
  const stub = serve((call) => ({ items: [{ row_id: call.body.row_ids[0], created: false, skipped: "already_accepted" }] }))
  try {
    const [result] = await sendRows({ row_ids: ["accepted"], expected_revisions: sendPins(["accepted"], () => "store-original") }, undefined, { core })
    assert.equal(stub.calls[0]!.body.storeId, "store-original")
    assert.equal(result!.noop_reason, "already_accepted")
  } finally { stub.restore() }
})

test("unassigned rows fill the remaining multi-Store quota without changing assigned rows", async () => {
  const ids = ["unbound", "assigned-a", "assigned-b"]
  const store = (id: string) => id === "assigned-a" ? "store-a" : id === "assigned-b" ? "store-b" : ""
  residentRows(ids.map((id) => nativeRowView(id, { storeId: store(id) })))
  openCard(CARD, TYPE, "store-a,store-b")
  await warm()
  const stub = serve((call) => accepted(call.body))
  try {
    const result = await sendRows({ row_ids: ids, expected_revisions: sendPins(ids, store) }, undefined, { core })
    assert.ok(result.every((row) => row.outcome === "start"))
    assert.deepEqual(new Map(stub.calls.map((call) => [call.body.storeId, call.body.row_ids])),
      new Map([["store-b", ["unbound", "assigned-b"]], ["store-a", ["assigned-a"]]]))
  } finally { stub.restore() }
})

test("selecting one unbound row keeps the multi-Store allocation of the whole Card", async () => {
  const ids = ["row-0", "row-1", "row-2", "row-3", "row-4"]
  patchListingWorkbench({ cardId: CARD, rows: ids.map((id) => ({ id, draftId: id, imageName: `${id}.png`, status: "ready", ai: "done", render: "done", upload: "done", log: "" })) })
  residentRows([nativeRowView("row-4", { storeId: "" })])
  openCard(CARD, TYPE, "store-a,store-b")
  await warm()
  const stub = serve((call) => accepted(call.body))
  try {
    await sendRows({ row_ids: ["row-4"], expected_revisions: sendPins(["row-4"], () => "") }, undefined, { core })
    assert.equal(stub.calls[0]!.body.storeId, "store-b")
  } finally { stub.restore() }
})

test("duplicate-offer preflight uses the Card's current targets instead of the row's old Store", () => {
  const ids = ["row-a", "row-b"]
  const workbench = { cardId: CARD, queueFrozenIds: ids,
    rows: ids.map((id) => ({ id, draftId: id, imageName: "shared.png", status: "ready" as const, ai: "done" as const, render: "done" as const, upload: "done" as const, log: "" })),
    productDrafts: Object.fromEntries(ids.map((id) => [id, { target_store_id: `old-${id}`, draft: { values: {}, complex_values: [] } }])) as never,
  }
  openCard(CARD, TYPE, "store-current")
  assert.equal(publishPreflight(workbench, undefined, { session: { authenticated: true } }).ok, false)
  openCard(CARD, TYPE, "store-a,store-b")
  assert.equal(publishPreflight(workbench, undefined, { session: { authenticated: true } }).ok, true)
})

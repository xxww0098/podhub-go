import assert from "node:assert/strict"
import test from "node:test"
import { acceptFactoryDispatch, downloadFactoryAsset, getFactoryDashboard, getFactoryDispatch, getFactoryMe, listFactoryDispatches, rejectFactoryDispatch } from "./api"
import { route } from "@/api/routes"

test("factory queue and detail consume the snake_case Go response, including permissions and assets", async () => {
  const previous = globalThis.fetch
  const row = { dispatch_id: "dispatch-1", dispatch_no: "D-1", posting_number: "P-1", state: "dispatched", nudge_count: 2, lines: [{ offer_id: "offer-1", name: "测试商品", quantity: 3 }] }
  globalThis.fetch = (async (input) => Response.json({ data: String(input).includes("/dispatch-1")
    ? { dispatch: { ...row, created_at_ms: 1, updated_at_ms: 2, seller_note: "备注", actions: { can_accept: true, can_reject: false, can_ship: false }, logistics: { shipment_date: "2026-10-30" }, receipt: { tracking_no: "tracking" }, lines: [{ ...row.lines[0], assets: [{ asset_id: "asset-1", file_name: "图.png", mime: "image/png", bytes: 4, sha256: "hash", url: "/authorized" }] }] } }
    : { dispatches: [row], has_more: true, cursor: "cursor-1" },
  })) as typeof fetch
  try {
    const list = await listFactoryDispatches("source-1", { view: "pending" })
    assert.equal(list.has_more, true)
    assert.equal(list.cursor, "cursor-1")
    assert.equal(list.dispatches[0]?.dispatch_id, "dispatch-1")
    assert.equal(list.dispatches[0]?.lines[0]?.offer_id, "offer-1")
    assert.equal(list.dispatches[0]?.nudge_count, 2)
    const detail = await getFactoryDispatch("dispatch-1")
    assert.equal(detail.dispatch_id, "dispatch-1")
    assert.equal(detail.posting_number, "P-1")
    assert.deepEqual(detail.actions, { can_accept: true, can_reject: false, can_ship: false })
    assert.equal(detail.logistics?.shipment_date, "2026-10-30")
    assert.equal(detail.receipt?.tracking_no, "tracking")
    assert.equal(detail.lines[0]?.assets[0]?.asset_id, "asset-1")
    assert.equal(detail.lines[0]?.assets[0]?.file_name, "图.png")
  } finally { globalThis.fetch = previous }
})

test("factory sources, dashboard and download grants keep the same snake_case contract", async () => {
  const previousFetch = globalThis.fetch
  const previousDocument = globalThis.document
  const source = { source_id: "source-1", name: "测试工厂", country: "CN", icon: "" }
  const row = { dispatch_id: "dispatch-1", dispatch_no: "D-1", posting_number: "P-1", state: "dispatched", nudge_count: 1, lines: [] }
  const grant = { url: "https://objects.example.invalid/production.png", expires_at_ms: Date.now() + 60_000, file_name: "生产图.png", content_type: "image/png", bytes: 4, sha256: "hash" }
  const events: string[] = []
  const anchor = { href: "", rel: "", referrerPolicy: "", click: () => events.push("click"), remove: () => events.push("remove") }
  Object.assign(globalThis, { document: { createElement: () => anchor, body: { appendChild: () => events.push("append") } } })
  globalThis.fetch = (async (input) => {
    const path = String(input)
    if (path === route("supplierMe")) return Response.json({ data: { sources: [source] } })
    if (path.endsWith("/dashboard")) return Response.json({ data: { counts: { pending: 1, producing: 0, urgent: 1, shipped: 0 }, urgent_orders: [row] } })
    assert.match(path, /dispatch-1\/assets\/asset-1$/)
    return Response.json({ data: grant })
  }) as typeof fetch
  try {
    assert.deepEqual((await getFactoryMe()).sources, [source])
    assert.deepEqual((await getFactoryDashboard(source.source_id)).urgent_orders, [row])
    await downloadFactoryAsset(row.dispatch_id, "asset-1")
    assert.equal(anchor.href, grant.url)
    assert.deepEqual(events, ["append", "click", "remove"])
  } finally {
    globalThis.fetch = previousFetch
    if (previousDocument === undefined) Reflect.deleteProperty(globalThis, "document")
    else globalThis.document = previousDocument
  }
})

test("factory actions address the selected dispatch, return its state, and preserve refusals", async () => {
  const previous = globalThis.fetch
  const calls: { path: string; method?: string; body?: string }[] = []
  globalThis.fetch = (async (input, init) => {
    calls.push({ path: String(input), method: init?.method, body: typeof init?.body === "string" ? init.body : undefined })
    if (String(input).endsWith("/reject")) return Response.json({ error: "不能拒绝", code: "conflict" }, { status: 409 })
    return Response.json({ data: { dispatch_id: "dispatch-1", state: "accepted" } })
  }) as typeof fetch
  try {
    assert.deepEqual(await acceptFactoryDispatch("dispatch-1"), { dispatch_id: "dispatch-1", state: "accepted" })
    await assert.rejects(rejectFactoryDispatch("dispatch-1", "产能不足"), /不能拒绝/)
    assert.match(calls[0]!.path, /dispatch-1\/accept$/)
    assert.equal(calls[0]!.method, "POST")
    assert.match(calls[1]!.path, /dispatch-1\/reject$/)
    assert.deepEqual(JSON.parse(calls[1]!.body!), { reason: "产能不足" })
  } finally { globalThis.fetch = previous }
})

test("factory list requests carry workspace, view, search and cursor", async () => {
  const previous = globalThis.fetch
  let address = ""
  globalThis.fetch = (async (input) => {
    address = String(input)
    return Response.json({ data: { dispatches: [], has_more: false, cursor: "" } })
  }) as typeof fetch
  try {
    await listFactoryDispatches("factory A", {
      view: "urgent", search: "帆布袋", cursor: "next|cursor",
      status: "accepted", reason: "nudge",
    })
    const url = new URL(address, "http://localhost")
    assert.equal(url.pathname, route("supplierWorkspacesBySourceIdDispatches", { source_id: "factory A" }))
    assert.equal(url.searchParams.get("view"), "urgent")
    assert.equal(url.searchParams.get("search"), "帆布袋")
    assert.equal(url.searchParams.get("cursor"), "next|cursor")
    assert.equal(url.searchParams.get("status"), "accepted")
    assert.equal(url.searchParams.get("reason"), "nudge")
  } finally { globalThis.fetch = previous }
})

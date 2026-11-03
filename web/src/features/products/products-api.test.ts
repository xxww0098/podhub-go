import assert from "node:assert/strict"
import test from "node:test"
import { exportFilteredProducts, loadProducts, loadProductsOverview, syncNow, verifyStoreProducts } from "./products-api"

test("product reads and write receipts consume the server's raw DTOs", async () => {
  const original = globalThis.fetch
  const row = { store_id: "store", store_name: "Shop", product_id: 7, offer_id: "offer", sku: "1234567890123456789", gone: false }
  const overview = { stores: [], totals: {}, coverage: { read: 0, total: 0 }, sync_disabled: false }
  const calls: { path: string; method: string; body: unknown }[] = []
  globalThis.fetch = (async (input, init) => {
    const path = String(input)
    calls.push({ path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    assert.equal(init?.credentials, "include")
    if (path.endsWith("/overview")) return Response.json(overview)
    if (path.endsWith("/sync")) return Response.json({ generation: 2, manual_next_allowed_at_ms: 1000, attached: false }, { status: 202 })
    return Response.json({ rows: [row] })
  }) as typeof fetch
  try {
    assert.deepEqual(await loadProductsOverview(), overview)
    assert.deepEqual((await loadProducts({ storeId: "store", q: " cup ", includeGone: true })).rows, [row])
    assert.deepEqual(await verifyStoreProducts("store", ["offer"]), [row])
    assert.deepEqual(await syncNow("store"), { generation: 2, manual_next_allowed_at_ms: 1000, attached: false })
    assert.match(calls[1]!.path, /storeId=store.*q=cup.*includeGone=true/)
    assert.deepEqual(calls[2]!.body, { offer_ids: ["offer"] })
    assert.equal(calls[3]!.method, "POST")
  } finally { globalThis.fetch = original }
})

test("failed product reads preserve the server error instead of returning empty data", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ code: "FORBIDDEN", error: "没有权限" }, { status: 403 })) as typeof fetch
  try {
    await assert.rejects(loadProducts({}), { code: "cloud_forbidden", status: 403, message: "没有权限" })
  } finally { globalThis.fetch = original }
})

test("filtered downloads preserve query scope", async () => {
  const original = globalThis.fetch
  const calls: { path: string; method: string }[] = []
  globalThis.fetch = (async (input, init) => {
    const path = String(input)
    calls.push({ path, method: init?.method ?? "GET" })
    assert.equal(init?.credentials, "include")
    return new Response("\uFEFFcsv", { headers: { "Content-Type": "text/csv" } })
  }) as typeof fetch
  try {
    const bytes = await exportFilteredProducts({ storeId: "store", q: " 杯子 ", status: "moderation_failed" })
    assert.equal(new TextDecoder().decode(bytes), "csv")
    assert.match(calls[0]!.path, /storeId=store&status=moderation_failed&q=%E6%9D%AF%E5%AD%90$/)
  } finally { globalThis.fetch = original }
})

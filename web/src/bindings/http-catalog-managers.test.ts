import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { catalogManagersHttp } from "./http-catalog-managers"

test("商品负责人授权使用目录公开标识，撤销绑定当前来源及授权行", async () => {
  const previous = globalThis.fetch
  const calls: { url: string; method: string; body: unknown }[] = []
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ data: {} })
  }) as typeof fetch
  try {
    await catalogManagersHttp.grant("src-1", "public-account")
    await catalogManagersHttp.revoke("src-1", "grant-1")
    assert.deepEqual(calls[0].body, { account_uuid: "public-account" })
    assert.equal(calls[0].url, route("adminSupplierDbsBySourceIdCatalogManagers", { source_id: "src-1" }))
    assert.equal(calls[1].url, route("adminSupplierDbsBySourceIdCatalogManagersByManagerId", { source_id: "src-1", manager_id: "grant-1" }))
    assert.equal(calls[1].method, "DELETE")
  } finally { globalThis.fetch = previous }
})

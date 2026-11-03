import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { sourceFulfillersHttp } from "./http-source-fulfillers"

test("履约绑定使用公开账号标识，读取与解除使用当前工厂路径", async () => {
  const previous = globalThis.fetch
  const calls: { url: string; method: string; body: unknown }[] = []
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return Response.json({ data: {} })
  }) as typeof fetch
  try {
    await sourceFulfillersHttp.list("src-1")
    await sourceFulfillersHttp.grant("src-1", "public-factory-account")
    await sourceFulfillersHttp.revoke("src-1", "grant-1")
    assert.deepEqual(calls, [
      { url: route("adminSupplierDbsBySourceIdFulfillers", { source_id: "src-1" }), method: "GET", body: undefined },
      { url: route("adminSupplierDbsBySourceIdFulfillers", { source_id: "src-1" }), method: "POST", body: { account_uuid: "public-factory-account" } },
      { url: route("adminSupplierDbsBySourceIdFulfillersByFulfillerId", { source_id: "src-1", fulfiller_id: "grant-1" }), method: "DELETE", body: undefined },
    ])
  } finally { globalThis.fetch = previous }
})

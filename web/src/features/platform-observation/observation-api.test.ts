import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { observationApi } from "./observation-api"
import { STORE_A, WORKSPACE_A } from "./observation-fixtures"

test("all observation reads use the specified admin GET routes and explicit scope/filter/cursor vocabulary", async () => {
  const previous = globalThis.fetch
  const requests: { url: URL; method: string }[] = []
  globalThis.fetch = (async (input, init) => {
    requests.push({ url: new URL(String(input), "http://localhost"), method: init?.method ?? "GET" })
    return new Response(JSON.stringify({ data: {} }), { status: 200, headers: { "Content-Type": "application/json" } })
  }) as typeof fetch
  try {
    const scope = { workspaceId: WORKSPACE_A, storeId: STORE_A }
    await observationApi.scopes()
    await observationApi.console(scope)
    await observationApi.overview(scope)
    await observationApi.products({ ...scope, status: "on_sale", q: " same ", includeGone: true, cursor: "opaque:a+/=", limit: 999 })
    assert.deepEqual(requests.map(({ method }) => method), ["GET", "GET", "GET", "GET"])
    assert.deepEqual(requests.map(({ url }) => url.pathname), [route("adminOpsScopes"), route("adminOpsConsoleSnapshot"), route("adminStoresProductsOverview"), route("adminStoresProducts")])
    for (const request of requests.slice(1)) {
      assert.equal(request.url.searchParams.get("workspaceId"), WORKSPACE_A)
      assert.equal(request.url.searchParams.get("storeId"), STORE_A)
    }
    const params = requests[3]!.url.searchParams
    assert.equal(params.get("q"), "same")
    assert.equal(params.get("status"), "on_sale")
    assert.equal(params.get("includeGone"), "true")
    assert.equal(params.get("cursor"), "opaque:a+/=")
    assert.equal(params.get("limit"), "200")
  } finally { globalThis.fetch = previous }
})

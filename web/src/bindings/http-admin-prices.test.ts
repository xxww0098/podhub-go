import assert from "node:assert/strict"
import test from "node:test"
import { adminHttp } from "./http-admin"
import type { components } from "@/api/schema"
import { route } from "@/api/routes"

test("admin model prices use the admin envelope without a workspace catalogue", async () => {
  const price: components["schemas"]["AiPriceView"] = {
    model: "test-model", billing_mode: "token",
    input_microfen_per_million: 10, cached_input_microfen_per_million: 5,
    output_microfen_per_million: 20, reasoning_microfen_per_million: 20,
    per_request_microfen: 0, max_request_microfen: 100,
    effective_from: "2026-10-25T10:00:00Z",
  }
  let prices = [price]
  const original = globalThis.fetch
  globalThis.fetch = (async (url, init) => {
    assert.equal(String(url), route("adminAiPrices"))
    assert.equal(init?.method, "GET")
    assert.equal(init?.credentials, "include")
    return Response.json({ data: { prices } } satisfies components["schemas"]["AIAdminPriceResponse"])
  }) as typeof fetch
  try {
    assert.deepEqual(await adminHttp.adminListAiPrices(), [price])
    prices = []
    assert.deepEqual(await adminHttp.adminListAiPrices(), [])
  } finally { globalThis.fetch = original }
})

test("a model price service refusal retains its server message and code", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ code: "INTERNAL", error: "服务暂不可用" }, { status: 500 })) as typeof fetch
  try {
    await assert.rejects(adminHttp.adminListAiPrices(), { code: "cloud_internal", message: "服务暂不可用", status: 500 })
  } finally { globalThis.fetch = original }
})

test("publishing and removing prices consume admin price-list receipts before reading the current list", async () => {
  const request = {
    model: "test-model", billing_mode: "token",
    input_microfen_per_million: 10, cached_input_microfen_per_million: 5,
    output_microfen_per_million: 20, reasoning_microfen_per_million: 20,
    per_request_microfen: 0, max_request_microfen: 100,
  } satisfies components["schemas"]["PublishAiPriceRequest"]
  const published: components["schemas"]["AIAdminPriceResponse"] = {
    data: { prices: [{ ...request, effective_from: "2026-10-25T10:00:00Z" }] },
  }
  const removed: components["schemas"]["AIAdminPriceResponse"] = { data: { prices: [] } }
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = (async (url, init) => {
    const method = init?.method ?? "GET"
    calls.push(`${method} ${String(url)}`)
    assert.equal(init?.credentials, "include")
    if (method === "PUT") {
      assert.deepEqual(JSON.parse(String(init?.body)), request)
      return Response.json(published)
    }
    if (method === "DELETE") {
      assert.deepEqual(JSON.parse(String(init?.body)), { model: request.model })
      return Response.json(removed)
    }
    return Response.json(removed)
  }) as typeof fetch
  try {
    assert.deepEqual(await adminHttp.adminPublishAiPrice(request), published.data)
    assert.deepEqual(await adminHttp.adminListAiPrices(), [])
    assert.deepEqual(await adminHttp.adminDeleteAiPrice(request.model), removed.data)
    assert.deepEqual(await adminHttp.adminListAiPrices(), [])
    assert.deepEqual(calls, [
      `PUT ${route("adminAiPrices")}`, `GET ${route("adminAiPrices")}`,
      `DELETE ${route("adminAiPrices")}`, `GET ${route("adminAiPrices")}`,
    ])
  } finally { globalThis.fetch = original }
})

test("an unwrapped admin response cannot provide prices or confirm a write", async () => {
  const original = globalThis.fetch
  globalThis.fetch = (async () => Response.json({ prices: [] })) as typeof fetch
  try {
    await assert.rejects(adminHttp.adminListAiPrices(), { code: "cloud_bad_response", status: 200 })
    await assert.rejects(adminHttp.adminDeleteAiPrice("test-model"), { code: "cloud_bad_response", status: 200 })
  } finally { globalThis.fetch = original }
})

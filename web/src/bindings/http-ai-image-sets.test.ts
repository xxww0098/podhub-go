import assert from "node:assert/strict"
import { test } from "node:test"
import { route } from "@/api/routes"
import { availableImageSetCapability, imageSetsHttp } from "./http-ai-image-sets"

test("capability admits only exact safe integer money and the three-image total", () => {
  const value = { available: true, account_id: "account", model: "qwen-image-2.1-pro" as const, count: 3 as const, unit_microfen: 25_000_000, set_microfen: 75_000_000 }
  assert.equal(availableImageSetCapability(value), true)
  for (const patch of [{ available: false }, { unit_microfen: 0 }, { unit_microfen: 0.1 }, { set_microfen: 1 }, { unit_microfen: Number.MAX_SAFE_INTEGER + 1 }, { account_id: "" }]) assert.equal(availableImageSetCapability({ ...value, ...patch }), false)
})
test("image DTOs stay raw; purchase keeps expected integer price and recovery uses only GET with the original key", async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = []
  const dto = { id: "set", items: [], status: "ready" }
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (path, init) => { calls.push({ path: String(path), init }); return Response.json(dto) }) as typeof fetch
  try {
    assert.deepEqual(await imageSetsHttp.create({ account_id: "a", model: "qwen-image-2.1-pro", source_base64: "eA==", expected_unit_microfen: 25_000_000 }, "original-key"), dto)
    assert.deepEqual(JSON.parse(String(calls[0]!.init!.body)).expected_unit_microfen, 25_000_000)
    await imageSetsHttp.find("original-key")
    await imageSetsHttp.find("original-key", "set")
    assert.deepEqual(calls.map((call) => call.init!.method), ["POST", "GET", "GET"])
    assert.deepEqual(calls.map((call) => (call.init!.headers as Record<string, string>)["Idempotency-Key"]), ["original-key", "original-key", "original-key"])
    assert.equal(calls[1]!.path, route("aiImageSets"))
    assert.equal(calls[2]!.path, route("aiImageSetsById", { id: "set" }))
  } finally { globalThis.fetch = previousFetch }
})

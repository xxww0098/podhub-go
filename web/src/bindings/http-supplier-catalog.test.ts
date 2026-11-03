import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { catalogRowInput, supplierCatalogHttp, type CatalogRow } from "./http-supplier-catalog"
import { EMPTY_ROW_REQUEST } from "@/features/supplier-dbs/supplier-dbs-model"

test("catalogue maintenance uses its own raw DTO routes and sends only manager-owned fields", async () => {
  const previous = globalThis.fetch
  const calls: { url: string; method: string; body?: Record<string, unknown> }[] = []
  globalThis.fetch = (async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    if (init?.method === "DELETE") return new Response(null, { status: 204 })
    return Response.json(init?.method === "PUT" ? { productId: "p1", revision: 8 } : { sources: [{ sourceId: "src-1" }] })
  }) as typeof fetch
  try {
    assert.deepEqual(await supplierCatalogHttp.sources(), { sources: [{ sourceId: "src-1" }] })
    const input = catalogRowInput({ ...EMPTY_ROW_REQUEST, revision: 7, platformPriceCents: 9999, promptContent: "private" } as unknown as CatalogRow)
    await supplierCatalogHttp.update("src-1", "p1", input)
    assert.equal(calls[1].url, route("supplierCatalogSourcesBySourceIdRowsByProductId", { source_id: "src-1", product_id: "p1" }))
    assert.equal(calls[1].body?.revision, 7)
    for (const field of ["platformPriceCents", "promptContent", "fixedTags", "expectedRevision"]) assert.equal(field in calls[1].body!, false)
    await supplierCatalogHttp.archive("src-1", "p1")
    assert.equal(calls[2].method, "DELETE")
  } finally { globalThis.fetch = previous }
})

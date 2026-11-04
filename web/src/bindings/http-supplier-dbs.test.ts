import assert from "node:assert/strict"
import test from "node:test"
import { supplierDbsHttp } from "./http-supplier-dbs"

test("supplier source and property upserts include the server's required nullable fields", async () => {
  const previous = globalThis.fetch
  const bodies: Record<string, unknown>[] = []
  globalThis.fetch = (async (_, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ data: {} })
  }) as typeof fetch
  try {
    const source = { name: "QA source", country: "", contact: "", internalNote: "", icon: "" }
    await supplierDbsHttp.supplierDbCreate(source)
    await supplierDbsHttp.supplierDbUpdate("source", source)
    const prop = { name: "QA property", type: "text" as const, options: [], sellerVisible: false }
    await supplierDbsHttp.supplierDbPropCreate("source", prop)
    await supplierDbsHttp.supplierDbPropUpdate("source", "prop", prop)
    assert.deepEqual(bodies.slice(0, 2), [source, source].map((body) => ({ ...body, template: null, viewPrefs: null })))
    assert.deepEqual(bodies.slice(2), [prop, prop].map((body) => ({ ...body, position: null })))
  } finally {
    globalThis.fetch = previous
  }
})

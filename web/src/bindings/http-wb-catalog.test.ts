import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { readWbCatalog } from "./http-wb-catalog"
import { wbCatalogFixture } from "../../tests/publish-pipeline-fixtures"

const coordinate = { subjectId: 105, language: "ru" as const }
test("WB C binding sends exact native coordinate and preserves empty and future issue evidence", async () => {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async (url, init) => {
    requests++
    assert.equal(String(url), `${route("catalogWbSubjectsBySubjectId", { subject_id: 105 })}?language=ru`)
    assert.equal(init?.method, "GET")
    assert.equal(init?.body, undefined)
    return Response.json({ ...wbCatalogFixture, catalog: null, defaults: null, usable: false,
      issues: [{ key: { platform: "wb", stage: "future", code: "future_code" }, field: "catalog", scope: "material", characteristicId: null }] })
  }
  try {
    const response = await readWbCatalog(coordinate)
    assert.equal(response.catalog, null)
    assert.equal(response.issues[0]!.key.code, "future_code")
    assert.equal(requests, 1)
  } finally { globalThis.fetch = original }
})

test("WB C binding rejects foreign coordinate, malformed fields and wrong scalar shape without retry", async () => {
  const original = globalThis.fetch
  try {
    for (const bad of [
      { ...wbCatalogFixture, subject_id: 106 }, { ...wbCatalogFixture, language: "en" },
      { ...wbCatalogFixture, catalog: { ...wbCatalogFixture.catalog, usable: "true" } },
      { ...wbCatalogFixture, catalog: { ...wbCatalogFixture.catalog, fetched_at_ms: null } },
      { ...wbCatalogFixture, catalog: { ...wbCatalogFixture.catalog, expires_at_ms: undefined } },
      { ...wbCatalogFixture, defaults: { ...wbCatalogFixture.defaults, values: { "100": "scalar" } } },
      { ...wbCatalogFixture, issues: [{ key: { platform: "wb", stage: "validate", code: 42 }, field: "catalog", scope: "material" }] },
      { data: wbCatalogFixture },
    ]) {
      let calls = 0
      globalThis.fetch = async () => { calls++; return Response.json(bad) }
      await assert.rejects(readWbCatalog(coordinate), { code: "wb_catalog_contract_invalid" })
      assert.equal(calls, 1)
    }
    let calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({ code: "internal" }, { status: 500 }) }
    await assert.rejects(readWbCatalog(coordinate), { status: 500 })
    assert.equal(calls, 1)
    await assert.rejects(readWbCatalog({ ...coordinate, subjectId: 2 ** 53 }), { code: "wb_catalog_contract_invalid" })
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})

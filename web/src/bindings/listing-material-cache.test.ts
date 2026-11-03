import assert from "node:assert/strict"
import { afterEach, test } from "node:test"

import type { components } from "@/api/schema"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { listingHttp } from "./http-listing"
import { cachedMaterial, loadMaterial, readCategorySchema } from "./listing-material-cache"

const BRAND = { descriptionCategoryId: 17_027_906, typeId: 91_976, language: "zh_hans" as const }
const OTHER = { descriptionCategoryId: 17_027_906, typeId: 91_977, language: "zh_hans" as const }

function schemaData(typeId: number): NonNullable<components["schemas"]["CatalogSchemaResponse"]> {
  return {
    description_category_id: BRAND.descriptionCategoryId,
    type_id: typeId,
    language: "zh_hans",
    fetched_at_ms: 1,
    fields: [{
      key: "attr_85",
      label: "品牌",
      group: "基础",
      editor: "dictionary_search",
      required: true,
      collection: false,
      dictionary_id: "28732849",
      attribute_id: "85",
      options: [{ id: "971082156", value: "Inline" }],
      options_truncated: true,
    }],
    native_material: {
      snapshot: {
        category_key: "k",
        label: "l",
        description_category_id: BRAND.descriptionCategoryId,
        type_id: typeId,
        schema_revision: `workflow:rev-${typeId}`,
        recipe_id: 0,
        recipe_revision: 0,
        catalog_schema_version: 0,
        fields: [],
      },
      search_materials: [{
        description_category_id: BRAND.descriptionCategoryId,
        attribute_id: 85,
        dictionary_id: 28_732_849,
        value_id: 126_745_801,
        label: "Нет бренда",
      }],
    },
  }
}

type Handler = (url: string, init?: RequestInit) => unknown | Promise<unknown>

function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } })
}

const previousFetch = globalThis.fetch
const calls: string[] = []

function serve(handler: Handler) {
  calls.length = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${url}`)
    const data = await handler(url, init)
    return init?.method === "GET" ? Response.json(data) : json(data)
  }) as typeof globalThis.fetch
}

const gets = () => calls.filter((call) => call.startsWith("GET ")).length

afterEach(() => {
  globalThis.fetch = previousFetch
  invalidateAllSessionCaches()
})

test("a normal schema read makes the material resident: later loads cost zero GETs", async () => {
  serve((url) => {
    const query = new URL(url, "http://x").searchParams
    assert.deepEqual([...query], [["description_category_id", String(BRAND.descriptionCategoryId)],
      ["type_id", String(BRAND.typeId)], ["language", BRAND.language]])
    return schemaData(Number(query.get("type_id")))
  })
  const entry = await readCategorySchema(BRAND)
  assert.equal(gets(), 1)
  assert.equal(entry.view.fields[0]?.key, "attr_85")
  const material = await loadMaterial(BRAND)
  assert.equal(cachedMaterial(BRAND), material)
  assert.equal(material, entry.material)
  assert.equal(material.input.snapshot.schema_revision, `workflow:rev-${BRAND.typeId}`)
  assert.match(material.signature, /^17027906:91976\|workflow:rev-91976#[0-9a-f]{64}$/)
  assert.equal(gets(), 1)
})

test("concurrent misses share one GET", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  serve(async () => { await gate; return schemaData(BRAND.typeId) })
  const pending = [loadMaterial(BRAND), loadMaterial(BRAND)]
  release()
  const [first, second] = await Promise.all(pending)
  assert.equal(first, second)
  assert.equal(gets(), 1)
})

test("an invalid coordinate is refused locally before any GET", async () => {
  serve(() => schemaData(BRAND.typeId))
  for (const coordinate of [
    { ...BRAND, descriptionCategoryId: 0 },
    { ...BRAND, typeId: Number.NaN },
    { ...BRAND, typeId: 1.5 },
    { ...BRAND, language: "xx" as never },
  ]) {
    await assert.rejects(loadMaterial(coordinate), { code: "workflow_category_coordinate_invalid" })
    assert.throws(() => cachedMaterial(coordinate), { code: "workflow_category_coordinate_invalid" })
  }
  assert.equal(calls.length, 0)
})

test("a confirmed search hit updates only its coordinate's material and signature", async () => {
  serve((url, init) => {
    if (init?.method === "POST") return [{ id: "5550001", value: "Searched" }]
    return schemaData(Number(new URL(url, "http://x").searchParams.get("type_id")))
  })
  const before = await loadMaterial(BRAND)
  const other = await loadMaterial(OTHER)
  const options = await listingHttp.listingCardSearchCategoryDictionary({
    description_category_id: BRAND.descriptionCategoryId,
    type_id: BRAND.typeId,
    language: "zh_hans",
    field_key: "attr_85",
    query: "Sea",
    limit: 20,
  })
  assert.deepEqual(options.map((option) => option.id), [5_550_001])
  assert.equal(gets(), 2, "search reuses the resident schema")
  const after = await loadMaterial(BRAND)
  assert.equal(gets(), 2)
  assert.notEqual(after.signature, before.signature)
  assert.equal(after.input.snapshot, before.input.snapshot)
  assert.deepEqual(after.input.searchMaterials.map((entry) => [entry.valueId, entry.label]), [
    [5_550_001, "Searched"],
    [126_745_801, "Нет бренда"],
  ])
  assert.equal(cachedMaterial(OTHER), other)
})

test("a reply in flight across an identity switch never refills the cache", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  serve(async () => { await gate; return schemaData(BRAND.typeId) })
  const material = loadMaterial(BRAND)
  const read = readCategorySchema(BRAND)
  invalidateAllSessionCaches()
  release()
  await assert.rejects(material, { code: "workflow_schema_material_stale" })
  await read
  assert.equal(cachedMaterial(BRAND), undefined)
})

test("a search reply after an identity switch is not folded into anyone's material", async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  serve(async (_url, init) => {
    if (init?.method !== "POST") return schemaData(BRAND.typeId)
    await gate
    return [{ id: "5550001", value: "Searched" }]
  })
  await loadMaterial(BRAND)
  const search = listingHttp.listingCardSearchCategoryDictionary({
    description_category_id: BRAND.descriptionCategoryId,
    type_id: BRAND.typeId,
    language: "zh_hans",
    field_key: "attr_85",
    query: "Sea",
    limit: 20,
  })
  await Promise.resolve()
  invalidateAllSessionCaches()
  const fresh = await loadMaterial(BRAND)
  release()
  await search
  assert.equal(cachedMaterial(BRAND), fresh)
  assert.equal(fresh.input.searchMaterials.length, 1)
})

test("a reply without native material is refused, never an empty passing bag", async () => {
  serve(() => {
    const malformed: Record<string, unknown> = { ...schemaData(BRAND.typeId) }
    delete malformed.native_material
    return malformed
  })
  const entry = await readCategorySchema(BRAND)
  assert.equal(entry.view.fields.length, 1)
  assert.equal(cachedMaterial(BRAND), undefined)
  await assert.rejects(loadMaterial(BRAND), { code: "workflow_schema_material_missing" })
})

test("a bare null schema miss is refused without a fabricated view or material", async () => {
  serve(() => null)
  await assert.rejects(readCategorySchema(BRAND), { code: "workflow_category_schema_missing" })
  assert.equal(cachedMaterial(BRAND), undefined)
})

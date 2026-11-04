import assert from "node:assert/strict"
import test from "node:test"

import type { SupplierDb, SupplierDbDetail, SupplierDbRow } from "@/bindings/http-supplier-dbs"

import { createSupplierDbsStore, type SupplierDbsClient } from "./supplier-dbs-store"
import { db, row, memoryClient } from "./supplier-dbs-screen-fixtures"
import type {
  PutSupplierOzonConfigBody,
  SupplierOzonConfigData,
  SupplierOzonConfigIO,
} from "./supplier-ozon-config"

const DB = { sourceId: "src-1", name: "厂" } as SupplierDb
const SOURCE_ROW = {
  productId: "p1",
  sourceId: "src-1",
  title: "圣诞帽",
  platformCode: "P001",
  descriptionCategoryId: 11,
  typeId: 101,
  promptContent: "PROMPT",
  fixedTags: ["#тег"],
  props: {},
  gallery: [],
  psd: [],
  productVideos: [],
  revision: 3,
} as unknown as SupplierDbRow

test("list and detail read failures preserve the original reason and clear it on retry", async () => {
  const reason = { code: "cloud_forbidden", serverCode: "FORBIDDEN", traceId: "supplier-trace", message: "访问被拒绝" }
  let failing = true
  const client = {
    supplierDbsList: async () => {
      if (failing) throw reason
      return { dbs: [DB] }
    },
    supplierDbGet: async () => {
      if (failing) throw reason
      return { db: DB, propDefs: [], rows: [] } as unknown as SupplierDbDetail
    },
  } as unknown as SupplierDbsClient
  const store = createSupplierDbsStore(client)
  await store.loadList()
  await store.loadDetail(DB.sourceId)
  assert.equal(store.getState().reason, reason)
  assert.equal(store.getState().details[DB.sourceId]?.reason, reason)
  failing = false
  await store.loadList()
  await store.loadDetail(DB.sourceId, { force: true })
  assert.equal(store.getState().reason, undefined)
  assert.equal(store.getState().details[DB.sourceId]?.reason, undefined)
})

function config(over: Partial<SupplierOzonConfigData>): SupplierOzonConfigData {
  return { complex_values: [], product_id: "p1", description_category_id: 11, type_id: 101, language: "zh_hans", values: {}, fixed_tags: ["#тег"], prompt_text: "PROMPT", ai_output: { title: true, description: true, tags: true }, revision: 1, state: "needs_reconfiguration", issues: [], usable: false, updated_at_ms: 0, ...over }
}

async function duplicate(put: SupplierOzonConfigIO["put"]) {
  const client = {
    supplierDbsList: async () => ({ dbs: [DB] }),
    supplierDbGet: async () => ({ db: DB, propDefs: [], rows: [SOURCE_ROW] }),
    supplierDbRowCreate: async () => ({
      row: { ...SOURCE_ROW, productId: "p2", revision: 1 },
    }),
  } as unknown as SupplierDbsClient
  const configs: Record<string, SupplierOzonConfigData> = {
    p1: config({ values: { "fixed:width": [{ kind: "integer", value: 400 }] }, ai_output: { title: false, description: true, tags: true }, revision: 6 }),
    p2: config({ product_id: "p2", revision: 1 }),
  }
  const store = createSupplierDbsStore(client, {
    get: async (_, productId) => configs[productId],
    put,
  })
  await store.loadList()
  await store.loadDetail("src-1")
  return store.duplicateRow("src-1", "p1")
}

test("复制行：默认字段随行复制，签新行配置的 revision", async () => {
  const puts: { productId: string; body: PutSupplierOzonConfigBody }[] = []
  const result = await duplicate(async (_, productId, body) => {
    puts.push({ productId, body })
    return config({ product_id: productId, revision: body.expected_revision + 1 })
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.value.configCopyError, undefined)
  assert.equal(puts.length, 1)
  assert.equal(puts[0].productId, "p2")
  assert.deepEqual(puts[0].body.values, {
    "fixed:width": [{ kind: "integer", value: 400 }],
  })
  assert.deepEqual(puts[0].body.ai_output, { title: false, description: true, tags: true })
  assert.equal(puts[0].body.prompt_text, "PROMPT")
  assert.equal(puts[0].body.expected_revision, 1)
  assert.equal(puts[0].body.validate, false)
})

test("复制行：配置复制失败保留新行并带回原因", async () => {
  const refusal = { code: "cloud_conflict", message: "冲突" }
  const result = await duplicate(async () => {
    throw refusal
  })
  assert.equal(result.ok, true)
  assert.equal(result.ok && result.value.row.productId, "p2")
  assert.equal(result.ok && result.value.configCopyError, refusal)
})

test("新增规格继承商品 Ozon 字段，不复制旧规格的识图事实和包装参数", async () => {
  const source = row("p1", "src", { size: "330ml", descriptionCategoryId: 11, typeId: 101, promptContent: "330ml facts", fixedTags: ["#кружка"], packWidthMm: 80, grossWeightG: 200 })
  const { client, calls } = memoryClient([{ db: db("src", "杯子"), rows: [source], propDefs: [] }])
  const puts: PutSupplierOzonConfigBody[] = []
  const store = createSupplierDbsStore(client, {
    get: async (_, id) => id === "p1" ? config({ description_category_id: 11, type_id: 101, values: { "fixed:width": [{ kind: "integer", value: 100 }] } }) : undefined,
    put: async (_, id, body) => { puts.push(body); return config({ ...body, product_id: id }) },
  })
  await store.loadList(); await store.loadDetail("src")
  const duplicate = await store.createVariant("src", "p1", { size: "330ml" })
  assert.equal(duplicate.ok, false)
  assert.equal(calls.updateRow.length, 0)
  const result = await store.createVariant("src", "p1", { size: "450ml", packWidthMm: 120 })
  assert.equal(result.ok, true)
  assert.equal(calls.createRow[0].promptContent, "")
  assert.equal(calls.createRow[0].packWidthMm, 120)
  assert.equal(calls.createRow[0].grossWeightG, null)
  assert.equal(calls.createRow[0].variantGroup, "p1")
  assert.equal(puts[0].prompt_text, "")
  assert.equal(puts[0].validate, false)
  assert.deepEqual(puts[0].values, { "fixed:width": [{ kind: "integer", value: 100 }] })
})

test("同步共享 Ozon 字段保留目标规格的事实、标签与识图开关", async () => {
  const first = row("p1", "src", { variantGroup: "g", size: "330ml", descriptionCategoryId: 11, typeId: 101 })
  const second = row("p2", "src", { variantGroup: "g", size: "450ml", descriptionCategoryId: 11, typeId: 101, promptContent: "450ml facts", fixedTags: ["#чашка"] })
  const { client } = memoryClient([{ db: db("src", "杯子"), rows: [first, second], propDefs: [] }])
  const puts: PutSupplierOzonConfigBody[] = []
  let invalid = false
  const store = createSupplierDbsStore(client, {
    get: async (_, id) => config(id === "p1" ? { values: { "fixed:width": [{ kind: "integer", value: 100 }] } } : { prompt_text: "450ml facts", fixed_tags: ["#чашка"], ai_output: { title: false, description: true, tags: false }, revision: 7 }),
    put: async (_, id, body) => { puts.push(body); return config({ ...body, product_id: id, state: body.validate && !invalid ? "valid" : "needs_reconfiguration" }) },
  })
  await store.loadList(); await store.loadDetail("src")
  assert.equal((await store.syncProductOzon("src", "p1")).ok, true)
  assert.equal(puts.length, 1)
  assert.equal(puts[0].prompt_text, "450ml facts")
  assert.deepEqual(puts[0].fixed_tags, ["#чашка"])
  assert.deepEqual(puts[0].ai_output, { title: false, description: true, tags: false })
  assert.equal(puts[0].expected_revision, 7)
  assert.equal(puts[0].validate, false)
  assert.equal((await store.syncProductOzon("src", "p1", true)).ok, true)
  assert.equal(puts[1].validate, true)
  invalid = true
  assert.equal((await store.syncProductOzon("src", "p1", true)).ok, false)
})

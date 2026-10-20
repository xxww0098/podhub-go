import assert from "node:assert/strict"
import test from "node:test"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import type { PutSupplierOzonConfigBody, SupplierOzonConfigData, SupplierOzonConfigIO } from "./supplier-ozon-config"
import { saveSupplierAiOutput } from "./supplier-row-ai-output"

const row = {
  productId: "product-one", sourceId: "source-one", descriptionCategoryId: 11, typeId: 101,
  promptContent: "row prompt", fixedTags: ["#рисунок"],
} as SupplierDbRow
const baseline: SupplierOzonConfigData = {
  product_id: row.productId, description_category_id: 11, type_id: 101, language: "ru",
  values: { "fixed:width": [{ kind: "integer", value: 200 }] }, prompt_text: "latest prompt", fixed_tags: ["#цветок"],
  ai_output: { title: true, description: false, tags: true }, revision: 7, state: "valid", issues: [], usable: true, updated_at_ms: 1,
}

test("AI switch reads latest config and preserves all sibling-owned fields using its CAS revision", async () => {
  const calls: string[] = []
  let written: PutSupplierOzonConfigBody | undefined
  const io: SupplierOzonConfigIO = {
    get: async (sourceId, productId) => {
      assert.equal(sourceId, row.sourceId); assert.equal(productId, row.productId)
      calls.push("get"); return baseline
    },
    put: async (sourceId, productId, body) => {
      assert.equal(sourceId, row.sourceId); assert.equal(productId, row.productId)
      calls.push("put"); written = body
      return { ...baseline, ...body, revision: 8 }
    },
  }
  const saved = await saveSupplierAiOutput(row, io, "title", false)
  assert.deepEqual(calls, ["get", "put"])
  assert.equal(written?.expected_revision, 7)
  assert.deepEqual(written?.values, baseline.values)
  assert.equal(written?.prompt_text, "latest prompt")
  assert.deepEqual(written?.fixed_tags, baseline.fixed_tags)
  assert.equal(written?.language, "ru")
  assert.deepEqual(saved.ai_output, { title: false, description: false, tags: true })
})

test("AI policy CAS conflict never silently retries or overwrites changed category", async () => {
  let writes = 0
  const conflict = { code: "cloud_conflict" }
  const io: SupplierOzonConfigIO = {
    get: async () => baseline,
    put: async () => { writes++; throw conflict },
  }
  await assert.rejects(saveSupplierAiOutput(row, io, "tags", false), (reason) => reason === conflict)
  assert.equal(writes, 1)
  await assert.rejects(saveSupplierAiOutput(row, { ...io, get: async () => ({ ...baseline, type_id: 102 }) }, "tags", false))
  assert.equal(writes, 1, "stale category must not issue a PUT")
})

test("first AI configuration preserves row prompt and tags with expectedRevision zero", async () => {
  let written: PutSupplierOzonConfigBody | undefined
  const io: SupplierOzonConfigIO = {
    get: async () => undefined,
    put: async (_, __, body) => { written = body; return { ...baseline, ...body, revision: 1 } },
  }
  await saveSupplierAiOutput(row, io, "description", false)
  assert.equal(written?.expected_revision, 0)
  assert.equal(written?.prompt_text, row.promptContent)
  assert.deepEqual(written?.fixed_tags, row.fixedTags)
  assert.deepEqual(written?.ai_output, { title: true, description: false, tags: true })
})

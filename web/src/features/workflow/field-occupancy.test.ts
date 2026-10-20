import assert from "node:assert/strict"
import test from "node:test"
import type { CategorySchemaView, WorkflowCategoryDraft } from "@/bindings/commands"
import {
  createWorkflowDraft,
  fieldOccupancy,
  occupiesField,
  occupancyLabel,
  writeWorkflowValue,
} from "./workflow-draft"

function field(
  overrides: Partial<CategorySchemaView["fields"][number]>,
): CategorySchemaView["fields"][number] {
  return {
    key: "price",
    name: "价格",
    description: "",
    group_name: "价格",
    source: "attribute",
    editor: "decimal",
    complex_group_collection: false,
    read_only: false,
    constraints: { required: false, collection: false },
    options: [],
    options_truncated: false,
    // A fixture states its variant stance explicitly: `null` is "unknown",
    // which is the honest default for a hand-built schema.
    aspect: null,
    ...overrides,
  }
}

function schema(): CategorySchemaView {
  return {
    description_category_id: 1,
    type_id: 2,
    language: "zh_hans",
    fields: [
      field({ key: "price", name: "价格", editor: "decimal", constraints: { required: true, collection: false } }),
      field({ key: "weight", name: "重量", editor: "integer", group_name: "尺寸" }),
      field({ key: "adult", name: "成人", editor: "boolean", group_name: "属性" }),
      field({ key: "offer_id", name: "货号", source: "fixed", editor: "text", read_only: true }),
    ],
    complex_groups: [],
  }
}

function emptyDraft(): WorkflowCategoryDraft {
  return { values: {}, complex_values: [] }
}

test("0 and false occupy a field; missing is unset; cleared is not a gap", () => {
  const zero = writeWorkflowValue(emptyDraft(), "weight", { kind: "integer", value: 0 })
  const falsy = writeWorkflowValue(emptyDraft(), "adult", { kind: "boolean", value: false })
  const cleared = writeWorkflowValue(emptyDraft(), "price", undefined)

  assert.equal(fieldOccupancy(zero, "weight"), "value")
  assert.equal(fieldOccupancy(falsy, "adult"), "value")
  assert.equal(fieldOccupancy(cleared, "price"), "cleared")
  assert.equal(fieldOccupancy(emptyDraft(), "price"), "unset")
  assert.equal(occupiesField(zero, "weight"), true)
  assert.equal(occupiesField(cleared, "price"), true)
  assert.equal(occupiesField(emptyDraft(), "price"), false)
  assert.equal(occupancyLabel("value"), "已填")
  assert.equal(occupancyLabel("cleared"), "已清空")
  assert.equal(occupancyLabel("unset"), "未填")
})

test("writing a value clears the cleared mark; clearing drops the value", () => {
  const filled = writeWorkflowValue(emptyDraft(), "price", { kind: "decimal", value: 0 })
  const cleared = writeWorkflowValue(filled, "price", undefined)
  const restored = writeWorkflowValue(cleared, "price", { kind: "decimal", value: 12 })

  assert.equal(cleared.values.price, undefined)
  assert.deepEqual(cleared.cleared, ["price"])
  assert.deepEqual(restored.values.price, { kind: "decimal", value: 12 })
  assert.equal(restored.cleared, undefined)
})

test("a blank new-card draft occupies only the pinned coordinate and fixed units", () => {
  const view = schema()
  view.fields.push(
    field({ key: "dimension_unit", name: "尺寸单位", source: "fixed", editor: "text", group_name: "尺寸" }),
    field({ key: "vat", name: "VAT", source: "fixed", editor: "text" }),
  )
  const draft = createWorkflowDraft(view)
  assert.equal(fieldOccupancy(draft, "vat"), "value")
  assert.equal(fieldOccupancy(draft, "price"), "unset")
})

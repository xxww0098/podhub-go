import assert from "node:assert/strict"
import test from "node:test"
import type { CategorySchemaView } from "@/bindings/commands"
import {
  createSupplierConfigDraft,
  createWorkflowDraft,
} from "./workflow-draft"

function schema(typeId: number, withTheme: boolean): CategorySchemaView {
  return {
    description_category_id: 17028964,
    type_id: typeId,
    language: "zh_hans",
    fields: [
      {
        key: "dimension_unit",
        name: "尺寸单位",
        description: "",
        group_name: "尺寸",
        source: "fixed",
        editor: "text",
        complex_group_collection: false,
        read_only: false,
        aspect: null,
        constraints: { required: false, collection: false },
        options: [],
        options_truncated: false,
      },
      ...(withTheme
        ? [
            {
              key: "attribute_7109",
              name: "主题",
              description: "",
              group_name: "属性",
              source: "attribute" as const,
              editor: "multi_select" as const,
              complex_group_collection: false,
              read_only: false,
              aspect: null,
              constraints: { required: false, collection: true },
              attribute_id: 7109,
              options: [],
              options_truncated: false,
            },
          ]
        : []),
    ],
    complex_groups: [],
  }
}

const painting = {
  kind: "multi_select" as const,
  value: [{ dictionary_value_id: 31229, value: "抽象化" }],
}

test("数字油画空白方案的默认主题是抽象化", () => {
  const draft = createWorkflowDraft(schema(94897, true))
  assert.deepEqual(draft.values.attribute_7109, painting)
  assert.notDeepEqual(draft.values.attribute_7109, {
    kind: "multi_select",
    value: [{ dictionary_value_id: 31208, value: "汽车和摩托车" }],
  })
})

test("没有主题属性或不是数字油画时不填主题", () => {
  assert.equal(createWorkflowDraft(schema(94897, false)).values.attribute_7109, undefined)
  assert.equal(createWorkflowDraft(schema(91976, true)).values.attribute_7109, undefined)
  assert.equal(
    createSupplierConfigDraft(schema(94897, true)).values.attribute_7109,
    undefined,
  )
  assert.deepEqual(createSupplierConfigDraft(schema(94897, true)).values.dimension_unit, {
    kind: "text",
    value: "mm",
  })
})

/**
 * `supplier_ozon_configs` ↔ `WorkflowCategoryDraft` 边界的确定性测试：
 * wire 键语法、值编码/投影、坐标重盖、以及 io 直连 `…/ozon-config` 路由。
 * 平铺旧 JSON 形状已退场，这里不再有任何兼容断言。
 */
import assert from "node:assert/strict"
import test from "node:test"

import { api } from "@/api/client"
import { route } from "@/api/routes"
import type {
  CategorySchemaView,
  WorkflowCategoryDraft,
} from "@/bindings/commands"
import { textValue } from "@/features/workflow/workflow-draft"
import {
  draftFromOzonConfigValues,
  draftToOzonConfigValues,
  seedSupplierRowDefaults,
  supplierOzonConfigIO,
  type PutSupplierOzonConfigBody,
  type SupplierOzonConfigData,
} from "./supplier-ozon-config"

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
    description_category_id: 11,
    type_id: 101,
    language: "zh_hans",
    fields: [
      field({ key: "currency_code", name: "币种", source: "fixed", editor: "text" }),
      field({ key: "vat", name: "税率", source: "fixed", editor: "decimal" }),
      field({ key: "width", name: "宽度", source: "fixed", editor: "integer" }),
      field({ key: "name", name: "名称", source: "fixed", editor: "text" }),
      field({ key: "attribute_4191", name: "简介", attribute_id: 4191, editor: "text" }),
      field({
        key: "attribute_8578",
        name: "尺码",
        attribute_id: 8578,
        editor: "single_select",
      }),
      field({
        key: "attribute_7787",
        name: "节日",
        attribute_id: 7787,
        complex_id: 4,
        editor: "multi_select",
        constraints: { required: false, collection: true },
      }),
    ],
    complex_groups: [
      { complex_id: 4, name: "属性", collection: false, field_keys: ["attribute_7787"] },
    ],
  }
}

const COORD = { description_category_id: 11, type_id: 101 }

function savedConfig(over: Partial<SupplierOzonConfigData> = {}): SupplierOzonConfigData {
  return {
    product_id: "p1",
    description_category_id: 11,
    type_id: 101,
    language: "zh_hans",
    values: {},
    fixed_tags: [],
    prompt_text: "",
    ai_output: { title: true, description: true, tags: true },
    revision: 4,
    state: "valid",
    issues: [],
    usable: false,
    updated_at_ms: 0,
    ...over,
  }
}

// ---------- io：分区与端点之间的唯一 HTTP 边界 ----------

test("io.get: 404 视为还没有配置，打的是 ozon-config 路由", async () => {
  const calls: string[] = []
  const original = api.get
  api.get = (async (path: string) => {
    calls.push(path)
    throw Object.assign(new Error("not found"), { status: 404 })
  }) as typeof api.get
  try {
    const got = await supplierOzonConfigIO.get("src-1", "p1")
    assert.equal(got, undefined)
    assert.deepEqual(calls, [
      route("adminSupplierDbsBySourceIdRowsByProductIdOzonConfig", {
        source_id: "src-1",
        product_id: "p1",
      }),
    ])
  } finally {
    api.get = original
  }
})

test("io.get: 非 404 失败照常抛出（重试按钮收到错误）", async () => {
  const original = api.get
  api.get = (async () => {
    throw Object.assign(new Error("boom"), { status: 500 })
  }) as typeof api.get
  try {
    await assert.rejects(() => supplierOzonConfigIO.get("src-1", "p1"), /boom/)
  } finally {
    api.get = original
  }
})

test("io.put: 同一 ozon-config 路由整配置写回并带 expectedRevision CAS", async () => {
  const calls: { path: string; body: PutSupplierOzonConfigBody }[] = []
  const original = api.put
  api.put = (async (path: string, body: unknown) => {
    calls.push({ path, body: body as PutSupplierOzonConfigBody })
    return { config: savedConfig() }
  }) as typeof api.put
  const body: PutSupplierOzonConfigBody = {
    description_category_id: 11,
    type_id: 101,
    language: "zh_hans",
    prompt_text: "识别红白配色",
    fixed_tags: ["#a"],
    ai_output: { title: true, description: true, tags: true },
    expected_revision: 3,
    values: { "fixed:currency_code": [{ kind: "text", value: "RUB" }] },
  }
  try {
    const got = await supplierOzonConfigIO.put("src-1", "p1", body)
    assert.equal(got.revision, 4, "返回的是服务端新配置")
    assert.equal(calls.length, 1)
    assert.equal(
      calls[0]?.path,
      route("adminSupplierDbsBySourceIdRowsByProductIdOzonConfig", {
        source_id: "src-1",
        product_id: "p1",
      }),
      "默认字段的保存走 ozon-config 而不是行 PUT",
    )
    assert.equal(calls[0]?.body.expected_revision, 3)
    assert.equal(calls[0]?.body.prompt_text, "识别红白配色")
    assert.deepEqual(calls[0]?.body.fixed_tags, ["#a"])
  } finally {
    api.put = original
  }
})

// ---------- wire → draft ----------

test("draftFromOzonConfigValues: fixed/attribute/complex 投成草稿，消失属性与非法键跳过", () => {
  const view = schema()
  const draft = draftFromOzonConfigValues(
    {
      "fixed:currency_code": [{ kind: "text", value: "RUB" }],
      "fixed:width": [{ kind: "integer", value: 300 }],
      "attribute:4191:0": [
        { kind: "text", value: "白色" },
        { kind: "text", value: "米色" },
      ],
      "attribute:7787:4": [
        { kind: "options", options: [{ option_id: 9, value: "圣诞" }] },
      ],
      "attribute:99999:0": [{ kind: "text", value: "已消失" }],
      junk: [{ kind: "text", value: "x" }],
      "fixed:notafield": [{ kind: "text", value: "y" }],
    },
    view,
  )
  assert.deepEqual(draft.values.currency_code, { kind: "text", value: "RUB" })
  assert.deepEqual(draft.values.width, { kind: "integer", value: 300 })
  assert.deepEqual(draft.values.attribute_4191, {
    kind: "text_list",
    value: ["白色", "米色"],
  })
  assert.deepEqual(draft.complex_values, [
    {
      complex_id: 4,
      items: [
        {
          values: {
            attribute_7787: {
              kind: "multi_select",
              value: [{ dictionary_value_id: 9, value: "圣诞" }],
            },
          },
        },
      ],
    },
  ])
  assert.equal(draft.values.attribute_99999, undefined, "类目已无的属性不投影")
  assert.equal(draft.values.junk, undefined)
})

test("draftFromOzonConfigValues: 单选选项按 editor 收敛成 single_select", () => {
  const draft = draftFromOzonConfigValues(
    {
      "attribute:8578:0": [
        { kind: "options", options: [{ option_id: 42, value: "XL" }] },
      ],
    },
    schema(),
  )
  assert.deepEqual(draft.values.attribute_8578, {
    kind: "single_select",
    value: { dictionary_value_id: 42, value: "XL" },
  })
})

// ---------- draft → wire ----------

test("draftToOzonConfigValues: 坐标键与行字段不写，fixed 按声明 kind 收编", () => {
  const view = schema()
  const draft: WorkflowCategoryDraft = {
    values: {
      description_category_id: { kind: "integer", value: 11 },
      type_id: { kind: "integer", value: 101 },
      currency_code: { kind: "text", value: "RUB" },
      // createWorkflowDraft 的 vat 默认是 text —— 写侧必须收编成 decimal。
      vat: { kind: "text", value: "0" },
      // 三边是 integer 槽位但草稿是 300.6 —— 不收编：原样写 text 让服务端
      // 挂 kind mismatch，而不是前端把 300.6 悄悄截断成 300。
      width: { kind: "decimal", value: 300.6 },
      attribute_4191: { kind: "text", value: "" },
      attribute_8578: {
        kind: "single_select",
        value: { dictionary_value_id: 42, value: "XL" },
      },
      // 行内生成的 fixed 字段（名称）不在 AdminFieldKey::Fixed 九名成员里。
      name: { kind: "text", value: "圣诞帽" },
    },
    complex_values: [
      {
        complex_id: 4,
        items: [
          {
            values: {
              attribute_7787: {
                kind: "multi_select",
                value: [{ dictionary_value_id: 9, value: "圣诞" }],
              },
            },
          },
        ],
      },
    ],
  }
  const out = draftToOzonConfigValues(draft, view)
  assert.deepEqual(out["fixed:currency_code"], [{ kind: "text", value: "RUB" }])
  assert.deepEqual(out["fixed:vat"], [{ kind: "decimal", value: "0" }])
  assert.deepEqual(
    out["fixed:width"],
    [{ kind: "text", value: "300.6" }],
    "非整数宽度原样写 text 等服务端挂错，不静默截断",
  )
  assert.deepEqual(out["attribute:8578:0"], [
    { kind: "options", options: [{ option_id: 42, value: "XL" }] },
  ])
  assert.deepEqual(out["attribute:7787:4"], [
    { kind: "options", options: [{ option_id: 9, value: "圣诞" }] },
  ])
  assert.equal(out["attribute:4191:0"], undefined, "空值即不写键")
  assert.equal(
    Object.keys(out).length,
    5,
    "坐标键与行内生成字段不进 values",
  )
})

test("draftToOzonConfigValues: 整数草稿在 integer 槽位无损收编；小数保持 text", () => {
  const out = draftToOzonConfigValues(
    {
      values: {
        width: { kind: "integer", value: 300 },
        height: { kind: "integer", value: 150.5 },
        depth: { kind: "text", value: "abc" },
      },
      complex_values: [],
    },
    schema(),
  )
  assert.deepEqual(out["fixed:width"], [{ kind: "integer", value: 300 }])
  assert.deepEqual(
    out["fixed:height"],
    [{ kind: "text", value: "150.5" }],
    "1.5 不能悄悄写成 1：非法文本原样留给服务端挂 kind issue",
  )
  assert.deepEqual(out["fixed:depth"], [{ kind: "text", value: "abc" }])
})

test("numeric attribute editors persist typed values without truncating invalid input", () => {
  const view = schema()
  const integer = field({ key: "attribute_500", attribute_id: 500, editor: "integer" })
  const decimal = field({ key: "attribute_501", attribute_id: 501, editor: "decimal" })
  const collection = field({
    key: "attribute_502",
    attribute_id: 502,
    editor: "integer",
    constraints: { required: false, collection: true },
  })
  view.fields.push(integer, decimal, collection)
  const out = draftToOzonConfigValues(
    {
      values: {
        attribute_500: textValue(integer, "42"),
        attribute_501: textValue(decimal, "0.1250"),
        attribute_502: textValue(collection, "1\n2.5"),
      },
      complex_values: [],
    },
    view,
  )
  assert.deepEqual(out["attribute:500:0"], [{ kind: "integer", value: 42 }])
  assert.deepEqual(out["attribute:501:0"], [{ kind: "decimal", value: "0.1250" }])
  assert.deepEqual(out["attribute:502:0"], [
    { kind: "text", value: "1" },
    { kind: "text", value: "2.5" },
  ])
  assert.deepEqual(
    draftToOzonConfigValues(
      { values: { attribute_500: { kind: "integer", value: 1.5 } }, complex_values: [] },
      view,
    )["attribute:500:0"],
    [{ kind: "text", value: "1.5" }],
  )
  assert.deepEqual(
    draftToOzonConfigValues(
      { values: { attribute_500: textValue(integer, "-0") }, complex_values: [] },
      view,
    )["attribute:500:0"],
    [{ kind: "text", value: "-0" }],
  )
})

test("draftToOzonConfigValues: 复杂组多条目没有 wire 槽位，直接拒绝不写", () => {
  const unrepresentable: WorkflowCategoryDraft = {
    values: {},
    complex_values: [
      {
        complex_id: 4,
        items: [
          {
            values: {
              attribute_7787: {
                kind: "multi_select",
                value: [{ dictionary_value_id: 9, value: "圣诞" }],
              },
            },
          },
          {
            values: {
              attribute_7787: {
                kind: "multi_select",
                value: [{ dictionary_value_id: 10, value: "新年" }],
              },
            },
          },
        ],
      },
    ],
  }
  assert.throws(
    () => draftToOzonConfigValues(unrepresentable, schema()),
    /复杂组 4 的多条目/,
    "末项覆盖会让前一项的值无声丢失 —— 宁可抛错不写",
  )
})

// ---------- 起稿与往返 ----------

test("seedSupplierRowDefaults: 有配置沿值且坐标重盖；无配置按 schema 起稿", () => {
  const view = schema()
  const reused = seedSupplierRowDefaults(
    view,
    { "fixed:currency_code": [{ kind: "text", value: "RUB" }] },
    COORD,
  )
  assert.deepEqual(reused.values.currency_code, { kind: "text", value: "RUB" })
  assert.deepEqual(reused.values.description_category_id, {
    kind: "integer",
    value: 11,
  })
  assert.deepEqual(reused.values.type_id, { kind: "integer", value: 101 })
  assert.equal(
    reused.values.vat,
    undefined,
    "配置稿按配置投，不补 schema 固定默认",
  )

  const seeded = seedSupplierRowDefaults(view, undefined, COORD)
  assert.equal(
    seeded.values.vat !== undefined,
    true,
    "无配置起稿带固定默认",
  )
  assert.deepEqual(seeded.values.description_category_id, {
    kind: "integer",
    value: 11,
  })
})

test("seed+write 往返：线上值进草稿再回写同一 wire 键", () => {
  const view = schema()
  const stored: SupplierOzonConfigData["values"] = {
    "fixed:currency_code": [{ kind: "text", value: "RUB" }],
    "attribute:8578:0": [
      { kind: "options", options: [{ option_id: 42, value: "XL" }] },
    ],
  }
  const out = draftToOzonConfigValues(
    seedSupplierRowDefaults(view, stored, COORD),
    view,
  )
  assert.deepEqual(out["fixed:currency_code"], stored["fixed:currency_code"])
  assert.deepEqual(out["attribute:8578:0"], stored["attribute:8578:0"])
})

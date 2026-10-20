import assert from "node:assert/strict"
import test from "node:test"
import type { CategoryFieldView, CategorySchemaView } from "@/bindings/commands"
import {
  WORKBENCH_COLUMNS,
  productInstanceDefaultExclusions,
  tableOwnedFields,
  workbenchColumn,
  workbenchColumnField,
} from "./workbench-columns"

const baseField: CategoryFieldView = {
  key: "name",
  name: "商品名称",
  description: "",
  group_name: "商品基础信息",
  source: "fixed",
  editor: "text",
  complex_group_collection: false,
  read_only: false,
  constraints: { required: true, collection: false },
  options: [],
  options_truncated: false,
  aspect: null,
}

function field(overrides: Partial<CategoryFieldView>): CategoryFieldView {
  return { ...baseField, ...overrides }
}

/** A live schema names an attribute `attribute_{id}`; only the id is stable. */
const schema: CategorySchemaView = {
  description_category_id: 17027906,
  type_id: 91955,
  language: "zh_hans",
  fields: [
    baseField,
    field({ key: "offer_id", name: "商家货号" }),
    field({ key: "price", name: "销售价", editor: "decimal" }),
    field({ key: "old_price", name: "划线价", editor: "decimal" }),
    field({ key: "attribute_4191", name: "简介", source: "attribute", attribute_id: 4191 }),
    field({ key: "attribute_9048", name: "型号名称", source: "attribute", attribute_id: 9048 }),
    field({ key: "attribute_9024", name: "卖家编码", source: "attribute", attribute_id: 9024 }),
    field({ key: "attribute_23171", name: "#主题标签", source: "attribute", attribute_id: 23171 }),
    field({ key: "attribute_11254", name: "JSON富内容", source: "attribute", attribute_id: 11254 }),
    field({ key: "attribute_7109", name: "主题", source: "attribute", attribute_id: 7109 }),
    field({ key: "images", name: "商品图片", editor: "url_list" }),
    field({ key: "images360", name: "360° 图片", editor: "url_list" }),
    field({ key: "primary_image", name: "主图", editor: "url" }),
    field({ key: "color_image", name: "颜色样本", editor: "url" }),
  ],
  complex_groups: [],
}

test("a column either writes a category field or is declared as one that cannot", () => {
  const fieldless = WORKBENCH_COLUMNS.filter((column) => !column.field).map((c) => c.id)

  // Not an omission: the source image is the file a row was built from,
  // 发布状态 is lifecycle, and the first column is selection. A new column
  // added without deciding which of the two it is fails here rather than
  // silently escaping the rule.
  assert.deepEqual(fieldless, ["select", "source", "publish_state"])
  assert.equal(workbenchColumnField(schema, "tags")?.attribute_id, 23171)

  for (const column of WORKBENCH_COLUMNS) {
    if (!column.field) continue
    assert.ok(
      column.lockReason,
      `${column.id} writes a field without saying what builds it`,
    )
    assert.ok(
      workbenchColumnField(schema, column.id),
      `${column.id} names a field this schema does not have`,
    )
  }
})

test("source identity and publish state stay together in the frozen first screen", () => {
  assert.deepEqual(
    WORKBENCH_COLUMNS.slice(0, 3).map((column) => column.id),
    ["select", "source", "publish_state"],
  )
  assert.equal(workbenchColumn("publish_state").sticky, "left-[7.5rem]")
  assert.equal(workbenchColumn("publish_state").edge, true)
})

test("the locked set is the columns themselves, resolved by attribute id", () => {
  const owned = tableOwnedFields(schema)

  assert.deepEqual(
    [...owned.keys()].sort(),
    [
      "attribute_23171",
      "attribute_4191",
      "attribute_9024",
      "attribute_9048",
      "color_image",
      "images",
      "images360",
      "name",
      "offer_id",
      "primary_image",
    ],
    "every column's fields, plus the identity attribute the injector writes",
  )

  // The reason names the column, so an operator reads where to edit it instead.
  // 货号 and 型号 are two columns now: each lock names its own column, and 型号
  // is not claimed by the 货号 column any more.
  assert.equal(workbenchColumn("offer_id").label, "货号")
  assert.equal(workbenchColumn("model").label, "型号")
  assert.equal(owned.get("offer_id"), `由原图文件名构建（表格列「${workbenchColumn("offer_id").label}」）`)
  assert.equal(owned.get("attribute_9048"), `由原图文件名构建（表格列「${workbenchColumn("model").label}」）`)
  assert.notEqual(owned.get("attribute_9048"), owned.get("offer_id"))
  assert.equal(workbenchColumnField(schema, "model")?.attribute_id, 9048)
  assert.equal(workbenchColumnField(schema, "offer_id")?.key, "offer_id")
  assert.equal(owned.get("name"), "由 AI 识图逐图构建（表格列「名称」）")
  assert.equal(owned.get("attribute_23171"), "由 AI 识图逐图构建（表格列「搜索标签」）")
  assert.equal(owned.get("images360"), "由 PSD 切片与公网交付构建（表格列「360° 图片」）")
  assert.equal(owned.get("attribute_4191"), "由 AI 识图逐图构建（表格列「简介」）")
  // JSON富内容 / 主题 are not in this set: they are tableInput columns whose
  // card default stays editable (see the next test).
  assert.equal(owned.has("attribute_11254"), false)
  assert.equal(owned.has("attribute_7109"), false)
})

test("a per-row input column writes its field without taking it from the defaults", () => {
  // 销售价 / 划线价 / 主题 / JSON富内容 are typed on the row while the card
  // 默认字段 keeps the batch value untouched rows inherit; Rust's hand-edited
  // diff is what makes the typed value win at send. Owning the key here would
  // lock that batch value away.
  for (const id of ["price", "old_price", "theme", "rich_content"] as const) {
    assert.equal(workbenchColumn(id).tableInput, true, `${id} is a tableInput column`)
  }
  assert.equal(workbenchColumnField(schema, "price")?.key, "price")
  assert.equal(workbenchColumnField(schema, "old_price")?.key, "old_price")
  assert.equal(workbenchColumnField(schema, "theme")?.key, "attribute_7109")
  assert.equal(workbenchColumnField(schema, "rich_content")?.key, "attribute_11254")

  const owned = tableOwnedFields(schema)
  for (const key of ["price", "old_price", "attribute_7109", "attribute_11254"]) {
    assert.equal(owned.has(key), false, `${key} stays editable in 默认字段`)
    assert.equal(productInstanceDefaultExclusions(schema).includes(key), false)
  }
})

test("AI permission never turns a required card default into instance-owned state", () => {
  const schemaWithType: CategorySchemaView = {
    ...schema,
    fields: [
      ...schema.fields,
      field({
        key: "attribute_8229",
        name: "类型",
        source: "attribute",
        attribute_id: 8229,
        editor: "single_select",
      }),
    ],
  }

  const excluded = productInstanceDefaultExclusions(schemaWithType)
  assert.equal(excluded.includes("name"), true)
  assert.equal(excluded.includes("attribute_4191"), true)
  assert.equal(excluded.includes("attribute_23171"), true)
  // 主题 / JSON富内容 are tableInput columns now: AI permission cannot take
  // their card default away either.
  assert.equal(excluded.includes("attribute_11254"), false)
  assert.equal(excluded.includes("attribute_7109"), false)
  assert.equal(
    excluded.includes("attribute_8229"),
    false,
    "类型 remains a reusable card default even when AI policy permits editing it",
  )
})

test("a field the injector writes with no column of its own does not claim to be one", () => {
  const reason = tableOwnedFields(schema).get("attribute_9024")

  // 卖家编码 is overwritten per row exactly like a column, but it is not in the
  // table; telling an operator to go edit a column that is not there is worse
  // than saying nothing.
  assert.match(reason ?? "", /管线注入/)
  assert.doesNotMatch(reason ?? "", /表格列/)
})

test("a category missing an attribute locks nothing on its account", () => {
  const withoutModelName: CategorySchemaView = {
    ...schema,
    fields: schema.fields.filter((candidate) => candidate.attribute_id !== 9048),
  }

  const owned = tableOwnedFields(withoutModelName)
  assert.equal(owned.has("attribute_9048"), false)
  assert.equal(owned.has("offer_id"), true)
  assert.equal(workbenchColumnField(withoutModelName, "offer_id")?.key, "offer_id")
  // 货号 keeps its own column and its own lock: a category without 9048 does
  // not turn the two back into one.
  assert.equal(workbenchColumnField(withoutModelName, "model"), undefined)
})

test("a category without 主题 has no theme column to fill", () => {
  const withoutTheme: CategorySchemaView = {
    ...schema,
    fields: schema.fields.filter((candidate) => candidate.attribute_id !== 7109),
  }

  assert.equal(tableOwnedFields(withoutTheme).has("attribute_7109"), false)
  assert.equal(workbenchColumnField(withoutTheme, "theme"), undefined)
})

test("a category without #主题标签 does not invent a lock for it", () => {
  const withoutTags: CategorySchemaView = {
    ...schema,
    fields: schema.fields.filter((candidate) => candidate.attribute_id !== 23171),
  }

  const owned = tableOwnedFields(withoutTags)
  assert.equal(owned.has("attribute_23171"), false)
  assert.equal(workbenchColumnField(withoutTags, "tags"), undefined)
})

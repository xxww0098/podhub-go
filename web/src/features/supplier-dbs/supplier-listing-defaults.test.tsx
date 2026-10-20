/**
 * 「默认字段」分区的草稿助手与 `SupplierRowDefaults` 的静态渲染检查 ——
 * wire ↔ 草稿转换与端点读写归 `supplier-ozon-config(.test).ts`；
 * 行上的默认字段 jsonb 槽位与平铺旧形状已退场。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { CategorySchemaView } from "@/bindings/commands"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { CategoryFieldsForm } from "@/features/workflow/category-fields-form"
import {
  rowDefaultsProgress,
  rowDefaultsSummary,
  rowOwnedFields,
} from "./supplier-listing-defaults"
import { seedSupplierRowDefaults } from "./supplier-ozon-config"
import { SupplierRowDefaults } from "./supplier-row-defaults"
import { SupplierRowDefaultsForm, supplierDefaultFields } from "./supplier-row-defaults-form"
import { SupplierRowPlatformTab } from "./supplier-row-platform-tab"

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
      field({ key: "price", name: "价格", editor: "decimal" }),
      field({ key: "currency_code", name: "币种", source: "fixed", editor: "text" }),
      field({ key: "dimension_unit", name: "尺寸单位", source: "fixed", editor: "text" }),
    ],
    complex_groups: [],
  }
}

const COORD = { description_category_id: 11, type_id: 101 }

test("rowDefaultsSummary: 草稿数已配置字段，坐标键不算", () => {
  assert.deepEqual(
    rowDefaultsSummary({
      values: {
        description_category_id: { kind: "integer", value: 11 },
        type_id: { kind: "integer", value: 101 },
        price: { kind: "decimal", value: 990 },
        currency_code: { kind: "text", value: "RUB" },
      },
      complex_values: [
        {
          complex_id: 9,
          items: [
            { values: { color: { kind: "text", value: "红" } } },
            { values: { color: { kind: "text", value: "蓝" } } },
          ],
        },
      ],
      cleared: ["vat"],
    }),
    ["price", "currency_code", "color"],
    "坐标键与 cleared 不计，复杂组字段跨项去重",
  )
  assert.deepEqual(rowDefaultsSummary({ values: {}, complex_values: [] }), [])
})

test("rowOwnedFields: 逐行生成字段的理由指到行内分区；售价指到上架表格", () => {
  const view = schema()
  view.fields.push(
    field({ key: "name", name: "名称", source: "fixed", editor: "text" }),
    field({ key: "images", name: "商品图片", source: "fixed", editor: "url_list" }),
    field({ key: "attribute_4191", name: "简介", attribute_id: 4191 }),
    field({ key: "offer_id", name: "商家货号", source: "fixed", editor: "text" }),
    field({ key: "attribute_9048", name: "型号名称", attribute_id: 9048 }),
  )
  const owned = rowOwnedFields(view)
  assert.match(owned.get("name") ?? "", /基本信息·名称/)
  assert.match(owned.get("images") ?? "", /「媒体」/)
  assert.match(owned.get("attribute_4191") ?? "", /描述/)
  // 型号列没写时回落到货号（原图名 stem），两列因此拿同一条锁理由。
  assert.match(owned.get("offer_id") ?? "", /「基本信息·编号」/)
  assert.equal(
    owned.get("attribute_9048"),
    owned.get("offer_id"),
    "型号名称与货号同源于原图文件名，锁理由指到同一块行内分区",
  )
  assert.equal(
    owned.get("price"),
    "在上架表格中逐行设置",
    "售价属于上架表格的逐行输入，不在行默认字段配置",
  )
})

test("rowOwnedFields: 主题指到上架表格的字典列，不在这里配置", () => {
  const view = schema()
  view.fields.push(
    field({
      key: "attribute_7109",
      name: "主题",
      attribute_id: 7109,
      editor: "multi_select",
      constraints: { required: false, collection: true, max_value_count: 5 },
    }),
  )
  const owned = rowOwnedFields(view)
  assert.equal(
    owned.get("attribute_7109"),
    "在上架表格中逐行选择主题",
    "主题属于上架表格的主题列，行默认字段只展示这条说明",
  )
})

test("rowOwnedFields: 类目没有售价字段时不凭空锁键", () => {
  const view = schema()
  view.fields = view.fields.filter((item) => item.key !== "price")
  assert.equal(rowOwnedFields(view).get("price"), undefined)
})

/** data-field-key="x" 起到下一个字段标记为止的片段 —— 与 field-workbench 同法。 */
function fieldMarkup(html: string, fieldKey: string): string {
  const start = html.indexOf(`data-field-key="${fieldKey}"`)
  assert.notEqual(start, -1, `no field named ${fieldKey}`)
  const next = html.indexOf("data-field-key=", start + 1)
  return html.slice(start, next === -1 ? undefined : next)
}

test("行默认字段把售价渲染成说明块，不给可编辑输入", () => {
  const view = schema()
  const html = renderToStaticMarkup(
    <CategoryFieldsForm
      schema={view}
      targetStoreId="store-1"
      draft={seedSupplierRowDefaults(view, {}, COORD)}
      issues={[]}
      initialFilter="all"
      lockedFields={rowOwnedFields(view)}
      onUpdateValue={() => undefined}
      onAddComplexItem={() => undefined}
      onRemoveComplexItem={() => undefined}
    />,
  )
  const price = fieldMarkup(html, "price")
  assert.match(price, /role="note"/)
  assert.match(price, /最终值不在此处配置/)
  assert.match(price, /在上架表格中逐行设置/)
  assert.doesNotMatch(price, /<input/)
})

test("行默认字段把型号名称渲染成说明块：与货号同源，不在这里配置", () => {
  const view = schema()
  view.fields.push(
    field({ key: "offer_id", name: "商家货号", source: "fixed", editor: "text" }),
    field({
      key: "attribute_9048",
      name: "型号名称（针对合并为一张商品卡片）",
      source: "attribute",
      editor: "text",
      attribute_id: 9048,
      complex_id: 4,
    }),
  )
  // 线上 schema 把 9048 放在复杂组里：锁必须穿过复杂组渲染路径。
  view.complex_groups = [
    { complex_id: 4, name: "属性", collection: false, field_keys: ["attribute_9048"] },
  ]
  const html = renderToStaticMarkup(
    <CategoryFieldsForm
      schema={view}
      targetStoreId="store-1"
      draft={seedSupplierRowDefaults(view, {}, COORD)}
      issues={[]}
      initialFilter="all"
      lockedFields={rowOwnedFields(view)}
      onUpdateValue={() => undefined}
      onAddComplexItem={() => undefined}
      onRemoveComplexItem={() => undefined}
    />,
  )
  const modelName = fieldMarkup(html, "attribute_9048")
  assert.match(modelName, /型号名称/)
  assert.match(modelName, /role="note"/)
  assert.match(modelName, /最终值不在此处配置/)
  assert.match(modelName, /生成方案时逐行写入，取自行内「基本信息·编号」/)
  assert.doesNotMatch(modelName, /<input/)

  const offerId = fieldMarkup(html, "offer_id")
  assert.match(offerId, /最终值不在此处配置/)
  assert.doesNotMatch(offerId, /<input/)
})

test("rowDefaultsProgress: 已配置按摘要口径，必填只数可在此编辑的", () => {
  const view = schema()
  view.fields.push(
    field({ key: "name", name: "名称", source: "fixed", editor: "text", constraints: { required: true, collection: false } }),
    field({ key: "price", constraints: { required: true, collection: false } }),
    field({ key: "barcode", name: "条码", source: "fixed", editor: "text", constraints: { required: true, collection: false } }),
    field({ key: "attribute_x", name: "只读必填", read_only: true, constraints: { required: true, collection: false } }),
  )
  const locked = rowOwnedFields(view)
  const draft = seedSupplierRowDefaults(view, {}, COORD)
  const progress = rowDefaultsProgress(view, draft, locked)
  assert.equal(progress.requiredTotal, 1, "锁定（名称/售价）+只读必填不算分母")
  assert.equal(progress.requiredFilled, 0)
  assert.equal(progress.configured, 1, "新稿只有尺寸单位固定默认")

  const filled = rowDefaultsProgress(
    view,
    { ...draft, values: { ...draft.values, barcode: { kind: "text", value: "460" } } },
    locked,
  )
  assert.equal(filled.requiredFilled, 1)
  assert.equal(filled.configured, 2)
})

// --- 分区静渲染：node 测试不跑 effect，schema 留在加载态 -----------------------

function row(over: Partial<SupplierDbRow> = {}): SupplierDbRow {
  return {
    productId: "p1",
    skuId: "p1-sku",
    sourceId: "src-1",
    title: "圣诞帽",
    platformCode: "P001",
    descriptionCategoryId: null,
    typeId: null,
    published: false,
    archived: false,
    readiness: {
      category: false,
      prompt: false,
      fixedTags: false,
      platformPrice: false,
      ozonConfig: false,
    },
    costCents: null,
    shippingCostCents: null,
    platformPriceCents: null,
    suggestedRetailCents: null,
    suggestedOldPriceCents: null,
    leadTime: "",
    size: "",
    material: "",
    craft: "",
    grossWeightG: null,
    brand: "",
    packWidthMm: null,
    packHeightMm: null,
    packDepthMm: null,
    packWeightG: null,
    contents: "",
    gallery: [],
    psd: [],
    productVideos: [],
    promptName: "",
    promptFileName: "",
    promptContent: "",
    fixedTags: [],
    description: "",
    internalNote: "",
    props: {},
    revision: 1,
    createdAtMs: 0,
    updatedAtMs: 0,
    createdBy: "tester",
    ...over,
  }
}

test("SupplierRowDefaults: 无类目坐标只留提示；有坐标静态渲染停在加载态", () => {
  const noCoord = renderToStaticMarkup(<SupplierRowDefaults row={row()} />)
  assert.match(noCoord, /先选择 Ozon 类目/)
  assert.match(noCoord, /去选择类目/)
  assert.doesNotMatch(noCoord, /data-category-fields-form/)
  assert.doesNotMatch(noCoord, /role="alert"/)

  const withCoord = renderToStaticMarkup(
    <SupplierRowDefaults row={row({ descriptionCategoryId: 11, typeId: 101 })} />,
  )
  assert.match(withCoord, /正在读取默认字段/)
  assert.doesNotMatch(withCoord, /data-category-fields-form/)
  assert.doesNotMatch(withCoord, /role="alert"/)
})


test("供应商字段筛选：零、false、字典与复杂组值计数，空白和逐图字段不计", () => {
  const view = schema()
  view.fields = [
    field({ key: "description_category_id", source: "fixed" }),
    field({ key: "name", source: "fixed", editor: "text" }),
    field({ key: "width", source: "fixed", editor: "integer" }),
    field({ key: "attribute_1", name: "布尔属性", editor: "boolean" }),
    field({ key: "attribute_2", name: "空文本", editor: "text" }),
    field({ key: "attribute_3", name: "复杂属性", complex_id: 8, constraints: { required: true, collection: false } }),
    field({ key: "attribute_4", name: "字典属性", editor: "single_select" }),
  ]
  const draft = { values: {
    description_category_id: { kind: "integer" as const, value: 11 },
    name: { kind: "text" as const, value: "逐图名称" },
    width: { kind: "integer" as const, value: 0 },
    attribute_1: { kind: "boolean" as const, value: false },
    attribute_2: { kind: "text" as const, value: "  " },
    attribute_4: { kind: "single_select" as const, value: { dictionary_value_id: 99, value: "" } },
  }, complex_values: [{ complex_id: 8, items: [{ values: { attribute_3: { kind: "text" as const, value: "组合" } } }] }] }
  const filled = supplierDefaultFields(view, draft, "filled", "")
  assert.deepEqual([filled.total, filled.filled], [5, 4])
  assert.deepEqual(filled.visible.map((item) => item.key), ["width", "attribute_1", "attribute_3", "attribute_4"])
  assert.deepEqual(supplierDefaultFields(view, draft, "empty", "").visible.map((item) => item.key), ["attribute_2"])
  assert.deepEqual(supplierDefaultFields(view, draft, "required", "复杂").visible.map((item) => item.key), ["attribute_3"])
  assert.equal(supplierDefaultFields(view, draft, "all", "不匹配").visible.length, 0)
})

test("供应商字段默认展示已填写，逐图来源只有说明，复用原字段控件", () => {
  const view = schema()
  view.fields.push(field({ key: "name", name: "名称", source: "fixed", editor: "text" }))
  const html = renderToStaticMarkup(<SupplierRowDefaultsForm schema={view}
    draft={seedSupplierRowDefaults(view, {}, COORD)} onUpdateValue={() => {}}
    onAddComplexItem={() => {}} onRemoveComplexItem={() => {}} />)
  assert.match(html, /搜索平台字段/)
  assert.match(html, /平台字段筛选/)
  assert.match(html, /1 项已填写 · 2 项可配置/)
  assert.match(html, /物流与税务/)
  assert.match(html, /逐图生成的字段/)
  assert.doesNotMatch(fieldMarkup(html, "price"), /<input/)
  assert.doesNotMatch(fieldMarkup(html, "name"), /<input/)
  assert.match(html, /data-field-key="dimension_unit"/)
})

test("平台页签：Ozon 类目独立且 WB 可进入准确空态", () => {
  const html = renderToStaticMarkup(<SupplierRowPlatformTab row={row()}
    onPatch={async () => true} onNavigateMedia={() => {}} />)
  assert.match(html, /aria-label="销售平台"/)
  assert.match(html, /aria-label="Ozon 类目"/)
  assert.match(html, /data-supplier-row-wb-empty/)
  assert.match(html, /暂未开放供应商商品的 WB 类目与字段配置/)
  assert.doesNotMatch(html, /aria-label="WB 类目"/)
  assert.match(html, /<button[^>]*aria-disabled="false"[^>]*>WB<\/button>/)
})


test("待填写与已填写筛选在字段失焦前保留正在编辑的控件", () => {
  const view = schema()
  view.fields = [field({ key: "barcode", name: "条码", source: "fixed", editor: "text" })]
  const draft = { values: { barcode: { kind: "text" as const, value: "" } }, complex_values: [] }
  for (const value of ["4", "46", "460123456789"]) {
    draft.values.barcode.value = value
    const focused = supplierDefaultFields(view, draft, "empty", "", "barcode")
    assert.equal(focused.visible.length, 1, "输入首字及后续字符期间不卸载字段")
    assert.equal(focused.filled, 1, "填写计数继续实时更新")
  }
  assert.equal(supplierDefaultFields(view, draft, "empty", "").visible.length, 0, "失焦后应用待填写筛选")
  draft.values.barcode.value = ""
  assert.equal(supplierDefaultFields(view, draft, "filled", "", "barcode").visible.length, 1, "清空仍保留聚焦字段")
  assert.equal(supplierDefaultFields(view, draft, "filled", "").visible.length, 0, "失焦后应用已填写筛选")
  assert.equal(supplierDefaultFields(view, draft, "all", "", "barcode").visible.length, 1)
  assert.equal(supplierDefaultFields(view, draft, "required", "", "barcode").visible.length, 0, "聚焦不扩大必填范围")
  assert.equal(supplierDefaultFields(view, draft, "all", "其他字段", "barcode").visible.length, 0, "搜索条件照常生效")
})

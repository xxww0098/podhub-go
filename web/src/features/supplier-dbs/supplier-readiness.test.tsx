import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { cloudRefusal } from "@/api/client"

import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"

import {
  SupplierReadinessBadge,
  computeReadiness,
  missingFromRefusal,
  missingReadiness,
} from "./supplier-readiness"

const NOW = Date.now()

test("a Cloud publish-gate refusal reaches the readiness copy mapping", () => {
  const reason = cloudRefusal(Response.json({}, { status: 400 }), {
    code: "VALIDATION", error: "上架前置条件未齐备",
    missing: ["category", "prompt", "ozonConfig"],
  }, "POST")
  assert.deepEqual(missingFromRefusal(reason), ["类目", "提示词", "Ozon 配置未校验"])
})

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
      ozonConfig: true,
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
    createdAtMs: NOW,
    updatedAtMs: NOW,
    createdBy: "tester",
    ...over,
  }
}

/** 服务端 readiness 的默认值（row() 同款）；提示词项只看这里。 */
const SERVER: SupplierDbRow["readiness"] = {
  category: false,
  prompt: false,
  fixedTags: false,
  platformPrice: false,
  ozonConfig: true,
}

/** validate_fixed_tags 契约下的合法 tag：`#` + 西里尔词身 + 数字。 */
const TAGS = Array.from({ length: 25 }, (_, i) => `#тег${i}`)

/**
 * 四项检查 × 缺失组合的表驱动：每行给出字段覆盖与期望 readiness。
 * 口径照 ADR-0095.7：类目坐标一对、服务端判定提示词（validate_brief）、前端固定 tags 1–25 个、
 * 存在平台价版本。
 */
const CASES: Array<{
  name: string
  over: Partial<SupplierDbRow>
  want: { category: boolean; prompt: boolean; fixedTags: boolean; platformPrice: boolean }
}> = [
  { name: "全缺", over: {}, want: { category: false, prompt: false, fixedTags: false, platformPrice: false } },
  {
    name: "仅类目齐（坐标一对）",
    over: { descriptionCategoryId: 11, typeId: 101 },
    want: { category: true, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "只有 descriptionCategoryId 不算坐标",
    over: { descriptionCategoryId: 11 },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "只有 typeId 也不算坐标",
    over: { typeId: 101 },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "提示词读服务端判定：正文非空但服务端未过（旧整篇）不过",
    over: { promptName: "圣诞通用", promptContent: "识别红白配色" },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "提示词读服务端判定：服务端过即过",
    over: { readiness: { ...SERVER, prompt: true } },
    want: { category: false, prompt: true, fixedTags: false, platformPrice: false },
  },
  {
    name: "单个合法 tag 过（至少 1）",
    over: { fixedTags: ["#тег0"] },
    want: { category: false, prompt: false, fixedTags: true, platformPrice: false },
  },
  {
    name: "上限 25 个过",
    over: { fixedTags: TAGS },
    want: { category: false, prompt: false, fixedTags: true, platformPrice: false },
  },
  {
    name: "26 个（超上限）不过",
    over: { fixedTags: [...TAGS, "#лишний"] },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "夹空白 tag 不过",
    over: { fixedTags: [...TAGS.slice(0, 2), "  "] },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "夹非西里尔 tag 不过（契约镜像）",
    over: { fixedTags: [...TAGS.slice(0, 2), "#latin"] },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "重复 tag（大小写不敏感）不过",
    over: { fixedTags: ["#тег0", "#ТЕГ0"] },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: false },
  },
  {
    name: "平台价存在即过（0 也算有版本）",
    over: { platformPriceCents: 1600 },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: true },
  },
  {
    name: "平台价 0 仍算存在（is_some 口径）",
    over: { platformPriceCents: 0 },
    want: { category: false, prompt: false, fixedTags: false, platformPrice: true },
  },
  {
    name: "类目+价 缺另外两项",
    over: { descriptionCategoryId: 11, typeId: 101, platformPriceCents: 1600 },
    want: { category: true, prompt: false, fixedTags: false, platformPrice: true },
  },
  {
    name: "全齐",
    over: {
      descriptionCategoryId: 11,
      typeId: 101,
      readiness: { ...SERVER, prompt: true },
      fixedTags: TAGS,
      platformPriceCents: 1600,
    },
    want: { category: true, prompt: true, fixedTags: true, platformPrice: true },
  },
]

test("computeReadiness 表驱动：四项检查 × 缺失组合", () => {
  for (const c of CASES) {
    assert.deepEqual(computeReadiness(row(c.over)), { ...c.want, ozonConfig: true }, c.name)
  }
})

test("missingReadiness 按声明顺序返回中文缺项名", () => {
  assert.deepEqual(missingReadiness(row({})), ["类目", "提示词", "固定 tags", "平台价"])
  assert.deepEqual(
    missingReadiness(row({ descriptionCategoryId: 1, typeId: 2, readiness: { ...SERVER, prompt: true } })),
    ["固定 tags", "平台价"],
  )
  assert.deepEqual(
    missingReadiness(
      row({
        descriptionCategoryId: 1,
        typeId: 2,
        readiness: { ...SERVER, prompt: true },
        fixedTags: TAGS,
        platformPriceCents: 100,
      }),
    ),
    [],
  )
})

test("就绪徽标两态：●就绪 / ◐ 缺 N 项，title 列缺项", () => {
  const ready = renderToStaticMarkup(
    <SupplierReadinessBadge
      row={row({
        descriptionCategoryId: 1,
        typeId: 2,
        readiness: { ...SERVER, prompt: true },
        fixedTags: TAGS,
        platformPriceCents: 100,
      })}
    />,
  )
  assert.match(ready, /●就绪/)
  assert.match(ready, /data-supplier-readiness=""/)

  const missing = renderToStaticMarkup(
    <SupplierReadinessBadge
      row={row({ platformPriceCents: 100 })}
    />,
  )
  assert.match(missing, /◐ 缺 3 项/)
  assert.match(missing, /title="缺：类目、提示词、固定 tags"/)
})

test("Ozon 配置未校验时，旧字段齐全也不能显示就绪", () => {
  const product = row({
    descriptionCategoryId: 1,
    typeId: 2,
    readiness: { ...SERVER, prompt: true },
    fixedTags: TAGS,
    platformPriceCents: 100,
  })
  product.readiness.ozonConfig = false
  assert.deepEqual(missingReadiness(product), ["Ozon 配置未校验"])
  assert.match(renderToStaticMarkup(<SupplierReadinessBadge row={product} />), /◐ 缺 1 项/)
  // 缓存的旧响应缺少新字段时也必须关闭就绪状态。
  Reflect.deleteProperty(product.readiness, "ozonConfig")
  assert.deepEqual(missingReadiness(product), ["Ozon 配置未校验"])
})

test("ozonConfig 缺项的 hover 文案按配置轴 denial 给管理级短语", () => {
  const configMissing = (
    ozonConfigDenial: SupplierDbRow["ozonConfigDenial"],
    denial: SupplierDbRow["denial"] = ozonConfigDenial,
  ) =>
    row({
      descriptionCategoryId: 1,
      typeId: 2,
      fixedTags: TAGS,
      platformPriceCents: 100,
      denial,
      ozonConfigDenial,
      readiness: {
        category: true,
        prompt: true,
        fixedTags: true,
        platformPrice: true,
        ozonConfig: false,
      },
    })

  // 四个配置类 denial 各有专属短语（口径 5：管理员看具体码，不复用卖家文案）。
  assert.deepEqual(missingReadiness(configMissing("config_needs_reconfiguration")), [
    "类目更新后待复核",
  ])
  assert.deepEqual(missingReadiness(configMissing("catalog_expired")), ["目录已过期"])
  assert.deepEqual(missingReadiness(configMissing("catalog_missing")), ["目录缺失"])
  assert.deepEqual(missingReadiness(configMissing("catalog_digest_mismatch")), [
    "目录摘要不一致",
  ])

  const badge = renderToStaticMarkup(
    <SupplierReadinessBadge row={configMissing("config_needs_reconfiguration")} />,
  )
  assert.match(badge, /◐ 缺 1 项/)
  assert.match(badge, /title="缺：类目更新后待复核"/)

  // 未发布行的整体 denial 停在销售态臂，配置轴的码仍然可见。
  assert.deepEqual(missingReadiness(configMissing("catalog_missing", "sku_not_published")), [
    "目录缺失",
  ])
  // 缺省（旧响应）时回退通用缺项名。
  assert.deepEqual(missingReadiness(configMissing(null)), ["Ozon 配置未校验"])
  assert.deepEqual(missingReadiness(configMissing(undefined)), ["Ozon 配置未校验"])
})

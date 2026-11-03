import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierDbPropDef, SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { SupplierRowInfoTab } from "./supplier-row-info-tab"

function row(productId: string, over: Partial<SupplierDbRow> = {}): SupplierDbRow {
  return {
    productId,
    skuId: `${productId}-sku`,
    sourceId: "src-1",
    title: `行 ${productId}`,
    platformCode: `P-${productId}`,
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

test("商品信息保留选品事实，移除内部资料、参考价、分组键和重复重量", () => {
  let writes = 0
  const prop = (propId: string, sellerVisible: boolean, sourceId = "src-1"): SupplierDbPropDef => ({
    propId, sourceId, name: propId, type: "text", sellerVisible, options: [],
    position: 0, createdAtMs: 0, updatedAtMs: 0,
  })
  const html = renderToStaticMarkup(
    <SupplierRowInfoTab
      row={row("p1", {
        platformPriceCents: 1250, variantGroup: "PAINT-01", internalNote: "内部结算备注",
        costCents: 98765, suggestedRetailCents: 88888, suggestedOldPriceCents: 99999, packWeightG: 12345,
        props: { 产地: "深圳", 合作模式: "内部代销", 其他货源: "不应出现" },
      })}
      propDefs={[prop("产地", true), prop("合作模式", false), prop("其他货源", true, "src-2")]}
      onPatch={async () => { writes++; return true }}
      canAdjustPrice
      onAdjustPrice={async () => { writes++; return true }}
    />,
  )
  for (const title of ["商品资料", "价格", "包装与清单", "素材", "商品说明"])
    assert.match(html, new RegExp(`<h3[^>]*>${title}`))
  assert.match(html, /¥12\.50/)
  assert.match(html, /aria-label="成本价（元）"[^>]*value="987\.65"/)
  assert.match(html, />调价<\/button>/)
  assert.doesNotMatch(html, /更多资料/)
  assert.doesNotMatch(html, /aria-label="平台价（元）"/)
  assert.doesNotMatch(html, /data-supplier-row-category|data-cell-editor="category"/)
  for (const label of ["名称", "编号", "规格", "运费（元）", "包装宽度（mm）", "毛重（g）", "商品清单", "商品描述", "自定义属性 产地"])
    assert.ok(html.includes(`aria-label="${label}"`), label)
  assert.match(html, /value="深圳"/)
  assert.match(html, /data-supplier-row-media="PSD"/)
  assert.doesNotMatch(html, /内部备注|补充价格|建议零售|平台划线价|包装重量|款号（同款分组）|合作模式|其他货源/)
  assert.doesNotMatch(html, /PAINT-01|内部结算备注|内部代销|不应出现|888\.88|999\.99|12345/)
  assert.equal(writes, 0)
})

test("平台价直接展示上一版历史价，并保留全部版本入口", () => {
  const html = renderToStaticMarkup(
    <SupplierRowInfoTab
      row={row("p1", {
        platformPriceCents: 2100,
        priceHistory: [
          { priceCents: 2100, createdAtMs: Date.UTC(2026, 10, 2, 12, 30) },
          { priceCents: 2000, createdAtMs: Date.UTC(2026, 9, 30, 9, 5) },
          { priceCents: 1800, createdAtMs: Date.UTC(2026, 9, 12, 8, 0) },
        ],
      })}
      propDefs={[]}
      onPatch={async () => true}
      onAdjustPrice={async () => true}
      canAdjustPrice
    />,
  )
  assert.match(html, /上次调价/)
  assert.match(html, /¥20\.00/)
  assert.match(html, /全部 2 次/)
  assert.doesNotMatch(html, /¥18\.00/, "折叠的历史版本不应挤在表单里")
})

test("核心选品字段标记建议，接口必填仍按真实条件展示", () => {
  for (const grouped of [false, true]) {
    const html = renderToStaticMarkup(<SupplierRowInfoTab
      row={row("p1", { variantGroup: grouped ? "PAINT-01" : "" })}
      propDefs={[]} onPatch={async () => true} onAdjustPrice={async () => true} />)
    const marker = (name: string) => {
      const start = html.indexOf(`>${name}</span>`)
      assert.ok(start >= 0, name)
      return html.slice(start, html.indexOf("</div>", start))
    }
    for (const name of ["名称", "编号", "规格", "平台价", "运费", "交期", "包装尺寸", "毛重", "商品清单"])
      assert.match(marker(name), />(建议|必填)</, name)
    assert.match(marker("平台价"), />必填</)
    assert.equal(marker("规格").includes(">必填<"), grouped)
    assert.doesNotMatch(marker("运费"), /必填|lucide-lock/)
    assert.doesNotMatch(marker("品牌"), /建议|必填/)
  }
})

import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
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

test("主要信息保留供货字段，平台价只读且类目归平台字段", () => {
  let writes = 0
  const html = renderToStaticMarkup(
    <SupplierRowInfoTab
      row={row("p1", { platformPriceCents: 1250, variantGroup: "PAINT-01" })}
      propDefs={[]}
      onPatch={async () => { writes++; return true }}
      onAdjustPrice={async () => { writes++; return true }}
    />,
  )
  for (const title of ["商品资料", "价格", "包装与清单", "素材", "描述与备注"])
    assert.match(html, new RegExp(`<h3[^>]*>${title}`))
  assert.match(html, /¥12\.50/)
  assert.match(html, />调价<\/button>/)
  assert.doesNotMatch(html, /aria-label="平台价（元）"/)
  assert.doesNotMatch(html, /data-supplier-row-category|data-cell-editor="category"/)
  for (const label of ["款号（同款分组）", "成本价（元）", "运费（元）", "包装宽度（mm）", "毛重（g）", "包装重量（g）", "商品清单", "商品描述", "内部备注"])
    assert.ok(html.includes(`aria-label="${label}"`), label)
  assert.match(html, /value="PAINT-01"/)
  assert.equal(writes, 0)
})

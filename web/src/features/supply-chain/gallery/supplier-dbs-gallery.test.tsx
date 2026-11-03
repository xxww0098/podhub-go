import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type {
  SellerSupplierDbCatalogData,
  SellerSupplierDbRowData,
} from "@/bindings/http-supplier-dbs-catalog"
import { toast } from "@/components/ui/toast"
import { row as supplierRow, propDef } from "@/features/supplier-dbs/supplier-dbs-screen-fixtures"
import { SupplierRowInfoTab } from "@/features/supplier-dbs/supplier-row-info-tab"

import { assertSellerSurfaceClean } from "../seller-leak"
import { GalleryCard } from "./gallery-card"
import { GalleryDetail } from "./gallery-detail"
import {
  EMPTY_FILTERS,
  categoryFacets,
  categoryIndex,
  propDefsFor,
  type CatalogListingIdentity,
  type GalleryFilters,
} from "./gallery-model"
import {
  importableQueueRows,
  resetCollectionForTests,
  toggleQueued,
} from "./listing-queue"
import { GalleryEmpty } from "./gallery-empty"
import { submitQueueImport } from "./listing-queue-tray"
import { SupplierDbsGallery } from "./supplier-dbs-gallery"

const DAY = 24 * 60 * 60 * 1000

function row(partial: Partial<SellerSupplierDbRowData>): SellerSupplierDbRowData {
  return {
    productId: "prd_x",
    sourceId: "src_1",
    title: "货品",
    platformCode: "P000",
    listable: true,
    descriptionCategoryId: 17030122,
    typeId: 971000156,
    platformPriceCents: 1600,
    suggestedRetailCents: null,
    suggestedOldPriceCents: null,
    leadTime: "2–3 天",
    gallery: [],
    productVideos: [],
    fixedTags: [],
    description: "",
    props: {},
    listedAtMs: Date.now() - 5 * DAY,
    ...partial,
  }
}

const catalog: SellerSupplierDbCatalogData = {
  dbs: [
    { source_id: "src_1", name: "美国3C厂", country: "US", icon: "🏭" },
    { source_id: "src_2", name: "美东厂", country: "US", icon: "" },
  ],
  propDefs: [
    {
      propId: "pp_1",
      sourceId: "src_1",
      name: "材质",
      type: "select",
      options: [{ value: "cotton", label: "棉" }],
      position: 1,
      sellerVisible: true,
      createdAtMs: 0,
      updatedAtMs: 0,
    },
    {
      propId: "pp_2",
      sourceId: "src_1",
      name: "内部选品备注",
      type: "text",
      options: [],
      position: 2,
      sellerVisible: false,
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ],
  rows: [
    row({
      productId: "prd_1",
      title: "圣诞帽",
      platformCode: "P001",
      platformPriceCents: 1600,
      suggestedRetailCents: 89000,
      suggestedOldPriceCents: 129000,
      shippingCostCents: 200,
      gallery: [
        { url: "https://img.example/1.jpg", w: 800, h: 600 },
        { url: "https://img.example/2.jpg", w: 800, h: 600 },
      ],
      productVideos: [
        { url: "https://img.example/v.mp4", coverUrl: "https://img.example/v.jpg", durationMs: 12000 },
      ],
      fixedTags: ["节日", "红色"],
      brand: "无品牌",
      description: "节日帽，保暖。",
      props: { pp_1: "cotton", pp_2: "hidden-value" },
    }),
    row({
      productId: "prd_2",
      title: "收纳盒",
      platformCode: "P002",
      descriptionCategoryId: 17030000,
      platformPriceCents: 800,
      leadTime: "5 天",
      fixedTags: ["家居"],
      listedAtMs: Date.now() - 40 * DAY,
    }),
    row({
      productId: "prd_3",
      sourceId: "src_2",
      title: "LED 灯带",
      platformCode: "P003",
      descriptionCategoryId: 20000000,
      platformPriceCents: 6000,
      leadTime: "当天",
      fixedTags: ["节日", "灯"],
      listedAtMs: Date.now() - 1 * DAY,
    }),
  ],
}

const tree: CategoryTreeNodeView[] = [
  {
    description_category_id: 1,
    category_name: "服饰",
    type_id: 0,
    type_name: "",
    disabled: false,
    children: [
      {
        description_category_id: 17030122,
        category_name: "节日用品",
        type_id: 0,
        type_name: "",
        disabled: false,
        children: [],
      },
    ],
  },
]

function gallery(filters: GalleryFilters = EMPTY_FILTERS): string {
  return renderToStaticMarkup(
    <SupplierDbsGallery
      catalog={catalog}
      filters={filters}
      onFiltersChange={() => {}}
      categoryTree={tree}
      onOpenDetail={() => {}}
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
}

test("平台商品库筛选对所有用户开放；单库时控件让位", () => {
  // 库筛选不再按角色收口：多库目录谁都看到「平台商品库」下拉；
  // 单库目录没有筛选意义，控件不渲染。
  const html = gallery()
  assert.match(html, /aria-label="平台商品库"/)
  assert.match(html, /全部平台商品库/)
  assert.match(html, /aria-label="搜索商品"/)
  assert.match(html, /aria-label="类目"/)
  assert.match(html, /aria-label="排序"/)

  const singleDb = renderToStaticMarkup(
    <SupplierDbsGallery
      catalog={{ ...catalog, dbs: [catalog.dbs[0]!] }}
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
      categoryTree={tree}
      onOpenDetail={() => {}}
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.doesNotMatch(singleDb, /aria-label="平台商品库"/)
})

test("toolbar row: search + 库/类目/价格区间/排序; 库 cascades 类目", () => {
  const html = gallery()
  // 图 1：筛选收进工具条下拉，没有左栏。
  assert.doesNotMatch(html, /data-gallery-rail/)
  assert.match(html, /aria-label="搜索商品"/)
  assert.match(html, /搜索名称、编号、标签或类目/)
  assert.match(html, /aria-label="平台商品库"/)
  assert.match(html, /全部平台商品库/)
  assert.match(html, /aria-label="类目"/)
  assert.match(html, /全部类目/)
  // 价格不是预制分段下拉，是卖家输入的最低/最高价。
  assert.match(html, /data-gallery-price-range/)
  assert.match(html, /aria-label="最低价"/)
  assert.match(html, /aria-label="最高价"/)
  assert.doesNotMatch(html, /全部价格/)
  assert.match(html, /aria-label="排序"/)
  assert.match(html, /最新上架/)
  assert.doesNotMatch(html, /data-gallery-density-toggle|刷新货源/)
  // 画廊只有卖家面形态：管理入口在侧栏「列表管理」屏，不在工具行。
  assert.doesNotMatch(html, /列表管理/)

  // 选中库：trigger 换成库名；类目下拉收窄由 facet scope 保证。
  const scoped = gallery({ ...EMPTY_FILTERS, db: "src_2" })
  assert.match(scoped, /美东厂/)
  const scopedCats = categoryFacets(catalog.rows, "src_2", categoryIndex(tree))
  assert.deepEqual(scopedCats.map((item) => item.value), ["20000000"])
})

test("默认的「全部」档不算已选条件：没有 chip，也没有清空筛选", () => {
  const resultbar = gallery().match(/data-gallery-resultbar[^]*?<\/p>\s*<\/div>/)?.[0] ?? ""
  assert.match(resultbar, /共 3 件商品/)
  assert.doesNotMatch(resultbar, /data-gallery-chip|已选条件|清空筛选/)
})

test("applied-filter chips + live count + 清空筛选", () => {
  const html = gallery({
    db: "src_1",
    cat: "17030122",
    priceMin: "10",
    priceMax: "20",
    tags: ["节日"],
    q: "圣诞",
  })
  assert.match(html, /aria-live="polite"[^>]*data-gallery-count|data-gallery-count[^>]*aria-live="polite"/)
  assert.match(html, /为「圣诞」找到 1 件/)
  // 库/类目 chip 镜像下拉的当前档；价格/标签/关键词只在生效时出现。
  const resultbar = html.match(/data-gallery-resultbar[^]*?<\/div>\s*<\/div>/)?.[0] ?? ""
  assert.match(resultbar, />美国3C厂</)
  assert.match(resultbar, />节日用品</)
  assert.match(resultbar, /价格 ¥10–20/)
  assert.match(resultbar, /标签 节日/)
  assert.match(resultbar, /关键词 圣诞/)
  assert.match(resultbar, /清空筛选/)
  // Each chip carries its own removal control.
  assert.match(html, /aria-label="移除筛选 美国3C厂"/)
})

test("搜索类目名称时保留该类目的商品，结果数量同步", () => {
  const html = gallery({ ...EMPTY_FILTERS, q: "日用品" })
  assert.match(html, /为「日用品」找到 1 件商品/)
  assert.match(html, /data-gallery-product="prd_1"/)
  assert.doesNotMatch(html, /data-gallery-product="prd_2"|data-gallery-product="prd_3"/)
})

test("商品卡片展示封面、类目、价格和配送信息，海报是详情入口", () => {
  const html = gallery()
  // 结果带只剩 N 件商品：库名由工具条下拉与 chip 交代，不再有「全部商品」标题。
  assert.match(html, /data-gallery-resultbar/)
  assert.match(html, /共 3 件商品/)
  assert.doesNotMatch(html, /data-gallery-heading/)
  assert.doesNotMatch(html, /全部商品/)
  assert.match(html, /data-gallery-grid/)
  assert.doesNotMatch(html, /<table/)
  const card = html.match(/<article[^>]*data-gallery-product="prd_1"[^]*?<\/article>/)?.[0] ?? ""
  assert.ok(card)
  assert.match(card, /圣诞帽/)
  assert.match(card, /¥16\.00/)
  assert.match(card, /运费 ¥2\.00/)
  assert.match(card, /2–3 天发货/)
  assert.match(card, /节日用品/)
  assert.match(card, /aria-label="查看 圣诞帽 的商品详情"[^]*?<img/)
  assert.doesNotMatch(card, /查看详情|编号：|P001|美国3C厂|1 个规格/)
  assert.match(card, /aria-label="加入上架清单 圣诞帽"/)
  assert.doesNotMatch(card, /hidden-value|>棉</)
  assert.doesNotMatch(html, /¥890\.00|采纳到店铺|>新</)
  assert.match(html, /loading="lazy"/)
  assertSellerSurfaceClean(catalog, html)
})

test("商品卡片展示实际尺寸，材质和编号留在详情", () => {
  const html = renderToStaticMarkup(
    <GalleryCard
      row={row({ size: "35×40cm", material: "棉" })}
      categoryLabel=""
      onOpen={() => {}}
    />,
  )
  assert.match(html, /35×40cm/)
  assert.match(html, /未分类/)
  assert.doesNotMatch(html, /P000|>棉</)
})

test("商品信息的同一份资料进入商品行和详情，更新后各处同步", () => {
  const propDefs = [
    propDef("origin", "src_1", { name: "产地" }),
    propDef("private", "src_1", { name: "内部属性", sellerVisible: false }),
  ]
  const initial = supplierRow("prd_info", "src_1", {
    title: "数字油画", platformCode: "PAINT-01", size: "40×50 cm", material: "棉麻画布",
    brand: "画材品牌", craft: "数字印刷", grossWeightG: 480,
    platformPriceCents: 1250, shippingCostCents: 230, leadTime: "3–5 天",
    packWidthMm: 420, packHeightMm: 520, packDepthMm: 30,
    contents: "画布 ×1、画笔 ×3", description: "按编号填色。",
    gallery: [{ url: "https://img.example/paint.jpg", w: 800, h: 1000 }],
    productVideos: [{ url: "https://img.example/paint.mp4", coverUrl: "", durationMs: 1000 }],
    props: { origin: "深圳", private: "不公开的资料" }, internalNote: "内部结算资料",
  })
  for (const product of [initial, { ...initial, title: "更新后的油画", size: "50×70 cm", platformPriceCents: 1890, shippingCostCents: 0 }]) {
    const seller = { ...product, listable: true, listedAtMs: product.updatedAtMs }
    const info = renderToStaticMarkup(<SupplierRowInfoTab row={product} propDefs={propDefs} onPatch={async () => true} onAdjustPrice={async () => true} />)
    const detail = renderToStaticMarkup(<GalleryDetail row={seller} propDefs={propDefsFor({ propDefs }, product.sourceId)} categoryLabel="" onOpenListing={() => {}} onOpenShipping={() => {}} />)
    for (const value of [product.title, product.platformCode, product.size, product.material, product.brand, product.craft, product.contents, product.description, "深圳"]) {
      assert.ok(info.includes(value), `商品信息缺少 ${value}`)
      assert.ok(detail.includes(value), `详情缺少 ${value}`)
    }
    assert.match(detail, /aria-label="毛重 480 g"/)
    assert.match(detail, /aria-label="包装尺寸 420×520×30 mm"/)
    assert.ok(detail.includes(product.gallery[0].url))
    assert.ok(detail.includes(product.productVideos[0].url))
    assert.doesNotMatch(detail, /不公开的资料|内部结算资料/)
    const card = renderToStaticMarkup(<GalleryCard row={seller} categoryLabel="" onOpen={() => {}} />)
    for (const value of [product.title, product.size, "3–5 天发货", product.gallery[0].url])
      assert.ok(card.includes(value), `商品卡片缺少 ${value}`)
    for (const value of [product.platformCode, product.material, product.brand, product.craft, "毛重 480 g"])
      assert.ok(!card.includes(value), `商品卡片不应堆叠详情字段 ${value}`)
    const price = `¥${(product.platformPriceCents! / 100).toFixed(2)}`
    const shipping = `运费 ¥${(product.shippingCostCents! / 100).toFixed(2)}`
    for (const html of [info, card, detail]) assert.ok(html.includes(price), price)
    for (const html of [card, detail]) assert.ok(html.includes(shipping), shipping)
    assert.doesNotMatch(card, /不公开的资料|内部结算资料/)
  }
})

test("商品行区分零运费与未知运费，视频封面只在没有图集时使用", () => {
  const render = (partial: Partial<SellerSupplierDbRowData>) => renderToStaticMarkup(<GalleryCard row={row(partial)} categoryLabel="" onOpen={() => {}} />)
  for (const shippingCostCents of [null, 0]) assert.match(render({ shippingCostCents }), /运费 ¥0\.00/)
  assert.match(render({}), /运费待定/)
  assert.doesNotMatch(render({}), /运费 ¥0\.00/)
  const productVideos = [{ url: "https://img.example/movie.mp4", coverUrl: "https://img.example/poster.jpg", durationMs: 1000 }]
  assert.match(render({ productVideos }), /src="https:\/\/img\.example\/poster\.jpg"/)
  const covered = render({ productVideos, gallery: [{ url: "https://img.example/cover.jpg", w: 800, h: 800 }] })
  assert.match(covered, /src="https:\/\/img\.example\/cover\.jpg"/)
  assert.doesNotMatch(covered, /poster\.jpg/)
  assert.match(render({}), /data-gallery-cover="none"/)
})

test("商品行的清单动作反映清单状态；多规格商品提示先选择规格", () => {
  const item = row({ productId: "prd_checkbox", title: "T 恤", variantGroup: "shirt" })
  const renderCard = (variantCount = 1) => renderToStaticMarkup(
    <GalleryCard row={item} categoryLabel="" onOpen={() => {}} variantCount={variantCount} />,
  )
  const action = (html: string) => html.match(/<button[^>]*data-gallery-queue[^>]*>/)?.[0] ?? ""
  resetCollectionForTests()
  // 海报上不摆选择框：清单动作只有卡里这一处，一个动作一个入口。
  assert.doesNotMatch(renderCard(), /data-slot="checkbox"|data-gallery-overlay/)
  assert.match(action(renderCard()), /aria-label="加入上架清单 T 恤"/)
  assert.match(action(renderCard()), /aria-pressed="false"/)
  toggleQueued(item)
  assert.match(action(renderCard()), /aria-label="移出上架清单 T 恤"/)
  assert.match(action(renderCard()), /aria-pressed="true"/)
  resetCollectionForTests()
  assert.match(action(renderCard(2)), /aria-label="选择规格后加入上架清单 T 恤"/)
  assert.match(renderCard(2), />选规格<\/button>/)
  toggleQueued({ ...item, productId: "prd_other_variant" })
  const variants = renderCard(2)
  assert.match(action(variants), /aria-label="查看已选规格 T 恤"/)
  assert.match(variants, />已选规格<\/button>/)
  resetCollectionForTests()
})

test("本页全选区分未选、部分选择与全部选择", () => {
  resetCollectionForTests()
  const selection = () => gallery().match(/<[^>]*aria-label="选择本页单规格商品"[^>]*>/)?.[0] ?? ""
  assert.match(selection(), /aria-checked="false"/)
  toggleQueued(catalog.rows[0])
  assert.match(selection(), /aria-checked="mixed"/)
  toggleQueued(catalog.rows[1])
  toggleQueued(catalog.rows[2])
  assert.match(selection(), /aria-checked="true"/)
  resetCollectionForTests()
})

test("选中库时不再另起标题，库名由下拉与 chip 交代", () => {
  const html = gallery({ ...EMPTY_FILTERS, db: "src_1" })
  assert.match(html, /美国3C厂/)
  assert.doesNotMatch(html, /data-gallery-heading/)
})

test("empty states: 无货品 / 筛选无结果 / 搜索无结果", () => {
  const emptyCatalog = renderToStaticMarkup(
    <SupplierDbsGallery
      catalog={{ dbs: [], propDefs: [], rows: [] }}
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
      categoryTree={[]}
      onOpenDetail={() => {}}
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(emptyCatalog, /data-gallery-empty="empty"/)
  assert.match(emptyCatalog, /平台还未上架货品/)

  const zero = gallery({ ...EMPTY_FILTERS, priceMin: "20", priceMax: "50" })
  assert.match(zero, /data-gallery-empty="zero"/)
  assert.match(zero, /没有符合筛选的货品/)

  const search = gallery({ ...EMPTY_FILTERS, q: "不存在的词" })
  assert.match(search, /data-gallery-empty="search"/)
  assert.match(search, /没有找到「不存在的词」相关的货品/)
  assert.match(search, /换个词试试/)
  for (const html of [emptyCatalog, zero, search]) {
    assert.match(html, /data-gallery-grid/)
    assert.doesNotMatch(html, /<table|<article|选择本页单规格商品/)
  }
})

test("详情只读展示商品事实与公开属性，媒体只包含真实图片和视频", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={catalog.rows[0]}
      propDefs={catalog.propDefs}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(detail, /data-gallery-detail/)
  for (const value of ["P001", "圣诞帽", "材质", "棉", "无品牌", "节日帽，保暖。", "¥16.00"]) {
    assert.ok(detail.includes(value), `详情缺少 ${value}`)
  }
  assert.match(detail, /<video[^>]*controls/)
  assert.match(detail, /aria-label="第 2 张"/)
  assert.match(detail, /aria-label="上一项"/)
  assert.match(detail, /aria-label="下一项"/)
  assert.doesNotMatch(detail, /内部选品备注|hidden-value|pp_2|建议零售|平台划线价|¥890\.00|¥1290\.00|₽/)
  assert.match(detail, /aria-label="商品参数"/)
  assert.match(detail, /aria-label="商品资料"/)
  assert.doesNotMatch(detail, /aria-label="媒体与参数"|role="tab"/)
  assert.doesNotMatch(detail, /返回货架|物流注入|采纳到店铺/)
  assert.doesNotMatch(detail, /<textarea|<input(?![^>]*type="radio")/)
  assertSellerSurfaceClean(catalog, detail)
})

test("图片与商品资料同时展示，价格和规格在上架动作之前", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail row={catalog.rows[0]} propDefs={catalog.propDefs} categoryLabel="节日用品" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  const positions = ['aria-label="媒体浏览"', "data-gallery-price", 'aria-label="规格"', "data-gallery-queue-toggle", 'aria-label="商品资料"'].map((marker) => detail.indexOf(marker))
  assert.ok(positions.every((index) => index >= 0))
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.match(detail, /data-gallery-stage[^]*?<video/)
  assert.match(detail, /aria-label="商品参数"[^]*?节日帽，保暖。/)
  assert.match(detail, /运费 ¥2\.00/)
  assert.match(detail, /2–3 天发货/)
  assert.match(detail, /data-gallery-open-listing/)
  assert.match(detail, /进入上架/)
  assert.match(detail, /加入上架清单/)
  assert.match(detail, /data-gallery-favorite/)
  assert.match(detail, /aria-label="收藏"/)
  assert.doesNotMatch(detail, /美国3C厂|源头供货|全场直发|data-gallery-price-banner/)
})

test("进入上架不依赖清单：当前规格可直接进入上架", () => {
  resetCollectionForTests()
  const variantA = row({
    productId: "prd_va",
    title: "油画",
    size: "40x50",
    variantGroup: "vg_1",
  })
  const variantB = row({
    productId: "prd_vb",
    title: "油画",
    size: "50x70",
    variantGroup: "vg_1",
  })
  const render = (current: SellerSupplierDbRowData) =>
    renderToStaticMarkup(
      <GalleryDetail
        row={current}
        variantRows={[variantA, variantB]}
        propDefs={[]}
        categoryLabel="手工"
        onOpenListing={() => {}}
        onOpenShipping={() => {}}
      />,
    )
  // React SSR 只在真置灰时落 `disabled=""` 属性；类名里的 `disabled:` 变体不算。
  const openListingTag = (html: string) =>
    html.match(/<button[^>]*data-gallery-open-listing[^>]*>/)?.[0] ?? ""

  // 未入清单仍可进入上架；规格选择保持可见。
  const idle = render(variantA)
  assert.doesNotMatch(openListingTag(idle), /disabled=""/)
  assert.doesNotMatch(idle, /data-gallery-listing-gate/)
  assert.doesNotMatch(idle, /加入清单后即可进入上架/)
  assert.doesNotMatch(idle, /选好规格加入清单后/)
  assert.match(idle, /role="radiogroup" aria-label="规格"/)

  // 规格 A 入清单：A 的规格项带「已在清单」标记，进入上架仍放开。
  toggleQueued(variantA)
  const queued = render(variantA)
  assert.doesNotMatch(openListingTag(queued), /disabled=""/)
  assert.match(queued, /40x50（已在清单）/)

  // 切到未入清单的规格 B：进入上架仍放开；清单标记只跟当前规格。
  const other = render(variantB)
  assert.doesNotMatch(openListingTag(other), /disabled=""/)
  assert.match(other, /50x70/)
  assert.doesNotMatch(other, /50x70（已在清单）/)
  resetCollectionForTests()
})

test("单规格也在动作条前显示规格选择", () => {
  const html = renderToStaticMarkup(
    <GalleryDetail row={row({ size: "" })} propDefs={[]} categoryLabel="手工" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  assert.match(html, /type="radio"[^>]*aria-label="默认规格"[^>]*checked=""/)
  assert.ok(html.indexOf('aria-label="规格"') < html.indexOf('data-gallery-queue-toggle'))
})

test("补充资料保留已填事实与公开属性，不重复名称和编号，不铺空字段", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        title: "油画", size: "40×50cm", material: "帆布", craft: "喷绘", brand: "无品牌",
        grossWeightG: 480, packWidthMm: 400, packHeightMm: 300, packDepthMm: 100,
        packWeightG: 350, contents: "画布 ×1、画笔 ×3", props: { pp_1: "cotton", origin: "深圳", amount: 0, waterproof: false, size_attr: "长边 500 mm", other: "外库数据" },
      })}
      propDefs={[
        ...catalog.propDefs,
        propDef("origin", "src_1", { name: "产地" }),
        propDef("amount", "src_1", { name: "起订量", type: "number" }),
        propDef("waterproof", "src_1", { name: "防水", type: "checkbox" }),
        propDef("size_attr", "src_1", { name: "尺寸说明" }),
        propDef("other", "src_2", { name: "外库属性" }),
      ]}
      categoryLabel="手工制作套件"
      typeLabel="数字油画"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.ok(detail.indexOf("data-gallery-queue-toggle") < detail.indexOf('aria-label="商品资料"'))
  for (const fact of ["品牌 无品牌", "材质 帆布", "工艺 喷绘", "毛重 480 g", "商品清单 画布 ×1、画笔 ×3", "包装尺寸 400×300×100 mm", "材质 棉", "产地 深圳", "起订量 0", "防水 否"]) {
    assert.ok(detail.includes(`aria-label="${fact}"`), `补充资料缺少 ${fact}`)
  }
  assert.match(detail, /手工制作套件 · 数字油画/)
  assert.doesNotMatch(detail, /外库数据|外库属性|包装重量|350 g|attribute_\d+/)
  const params = detail.match(/aria-label="商品资料"[^]*?<\/dl>/)?.[0] ?? ""
  for (const fact of ["类目 手工制作套件", "规格 40×50cm", "材质 帆布", "尺寸说明 长边 500 mm", "毛重 480 g", "包装尺寸 400×300×100 mm"])
    assert.ok(params.includes(fact), `商品参数缺少 ${fact}`)
  assert.equal((detail.match(/>油画</g) ?? []).length, 1)
  assert.equal((detail.match(/>P000</g) ?? []).length, 1)
  const bare = renderToStaticMarkup(
    <GalleryDetail row={row({ brand: "  " })} propDefs={[propDef("origin", "src_1", { name: "产地" })]} categoryLabel="家居" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  assert.match(bare, /aria-label="类目 家居"/)
  assert.doesNotMatch(bare, /aria-label="品牌 |aria-label="材质 |aria-label="产地 /)
})

test("详情区分零运费与未知运费，缺少价格或交期时明确显示未知", () => {
  const render = (partial: Partial<SellerSupplierDbRowData>) => renderToStaticMarkup(
    <GalleryDetail row={row(partial)} propDefs={[]} categoryLabel="" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  for (const shippingCostCents of [null, 0]) assert.match(render({ shippingCostCents }), /运费 ¥0\.00/)
  const unknown = render({ platformPriceCents: null, leadTime: "" })
  assert.match(unknown, /平台价 ¥—/)
  assert.match(unknown, /运费待定/)
  assert.match(unknown, /交期待定/)
  assert.match(unknown, /类目待定/)
  assert.doesNotMatch(unknown, /运费 ¥0\.00/)
})

test("工具行尾收收藏筛/上架清单入口；卡片海报打开详情并可加入清单", () => {
  const html = gallery()
  assert.match(html, /data-gallery-favonly/)
  assert.match(html, /只看收藏/)
  // 收藏筛在工具行里（搜索那一行），不单落一行、也不下沉到结果带。
  const toolbar = html.match(/<div[^>]*data-slot="gallery-toolbar"[^]*?data-gallery-resultbar/)?.[0]
  assert.ok(toolbar)
  assert.match(toolbar, /data-gallery-controls/)
  assert.match(toolbar, /data-gallery-favonly/)
  // 清单入口是工具行尾的常态按钮（图 1），不再盖在商品表格角。
  assert.match(toolbar, /data-gallery-queue-open/)
  assert.match(toolbar, /aria-label="上架清单"/)
  // 海报打开详情，收藏与加入清单保留独立操作。
  assert.match(html, /data-gallery-favorite/)
  assert.match(html, /aria-label="收藏 圣诞帽"/)
  assert.match(html, /data-gallery-queue/)
  assert.match(html, /aria-label="加入上架清单 圣诞帽"/)
  assert.match(html, /aria-label="查看 圣诞帽 的商品详情"/)
})

test("商品行只切换清单成员；清单浮窗不再带平台选择", () => {
  const hatRow = catalog.rows[0]!
  toggleQueued(hatRow)
  const html = gallery()
  assert.match(html, /aria-label="移出上架清单 圣诞帽"/)
  assert.doesNotMatch(html, /data-gallery-queue-scheme|data-gallery-queue-platform|上架到/)
  resetCollectionForTests()
})

test("工具行清单非空就能重新核对商品，不被缓存可上架状态锁死", () => {
  const directButton = () => gallery().match(/<button[^>]*data-gallery-queue-direct-submit[^>]*>/)?.[0] ?? ""
  resetCollectionForTests()
  assert.match(directButton(), /disabled=""/)
  toggleQueued(catalog.rows[0]!)
  assert.doesNotMatch(directButton(), /disabled=""/)
  resetCollectionForTests()
  toggleQueued(row({ productId: "prd_missing" }))
  assert.doesNotMatch(directButton(), /disabled=""/)
  resetCollectionForTests()
})

test("无媒体行显示简洁空态，不生成空的媒体入口", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail row={row({ title: "无图货" })} propDefs={[]} categoryLabel="节日用品" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  assert.match(detail, /暂无图片/)
  assert.match(detail, /无图货/)
  assert.match(detail, /进入上架/)
  assert.doesNotMatch(detail, /<video|媒体列表|上一项|下一项/)
  assert.doesNotMatch(detail, /role="tab"/)
  assert.match(detail, /aria-label="类目 节日用品"/)
  assert.match(detail, /aria-label="规格 默认规格"/)
  assertSellerSurfaceClean(catalog, detail)
})

test("单张图片也保留缩略图导航，多张图片提供翻页", () => {
  const render = (gallery: SellerSupplierDbRowData["gallery"]) => renderToStaticMarkup(
    <GalleryDetail row={row({ gallery })} propDefs={[]} categoryLabel="节日用品" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  const image = { url: "https://img.example/1.jpg", w: 800, h: 800 }
  const single = render([image])
  assert.match(single, /alt="货品 图片 1"/)
  assert.match(single, /aria-label="媒体列表"/)
  assert.match(single, /aria-label="第 1 张" aria-current="true"/)
  assert.doesNotMatch(single, /上一项|下一项|<video/)
  const multiple = render([image, { ...image, url: "https://img.example/2.jpg" }])
  assert.match(multiple, /aria-label="媒体列表"/)
  assert.match(multiple, /aria-label="第 1 张" aria-current="true"/)
  assert.match(multiple, /aria-label="第 2 张"/)
  assert.match(multiple, /aria-label="下一项"/)
  assert.doesNotMatch(multiple, /<video/)
})

test("包装三边齐全合并展示，缺边只显示已知尺寸，毛重保持独立", () => {
  const render = (partial: Partial<SellerSupplierDbRowData>) => renderToStaticMarkup(
    <GalleryDetail row={row(partial)} propDefs={[]} categoryLabel="节日用品" onOpenListing={() => {}} onOpenShipping={() => {}} />,
  )
  const complete = render({ grossWeightG: 480, packWidthMm: 400, packHeightMm: 300, packDepthMm: 100, packWeightG: 350 })
  assert.match(complete, /aria-label="毛重 480 g"/)
  assert.match(complete, /aria-label="包装尺寸 400×300×100 mm"/)
  assert.doesNotMatch(complete, /包装重量|350 g|默认字段/)
  const partial = render({ packWidthMm: 400 })
  assert.match(partial, /aria-label="包装宽度 400 mm"/)
  assert.doesNotMatch(partial, /aria-label="包装尺寸|包装高度|包装深度/)
})

test("打开的商品以详情页整页呈现，商品卡片让位而不是盖抽屉", () => {
  const html = renderToStaticMarkup(
    <SupplierDbsGallery
      catalog={catalog}
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
      categoryTree={tree}
      detail={catalog.rows[0]}
      onOpenDetail={() => {}}
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(html, /data-gallery-detail/)
  assert.match(html, /P001/)
  // 详情页是页面不是浮层：工具条、结果带与商品表格全部让位。
  assert.doesNotMatch(html, /data-gallery-grid|data-gallery-resultbar|aria-label="搜索商品"/)
})

test("pager is a minimal corner control; the count stands on its own", () => {
  const many: SellerSupplierDbCatalogData = {
    ...catalog,
    rows: Array.from({ length: 30 }, (_, i) =>
      row({ productId: `prd_${i}`, title: `货 ${i}` }),
    ),
  }
  const html = renderToStaticMarkup(
    <SupplierDbsGallery
      catalog={many}
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
      categoryTree={[]}
      onOpenDetail={() => {}}
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(html, /data-gallery-pager/)
  assert.match(html, /30 件商品/)
  assert.match(html, /aria-current="page"/)
  assert.match(html, /aria-label="下一页"/)
})


test("GalleryEmpty standalone kinds carry their next step", () => {
  const zero = renderToStaticMarkup(
    <GalleryEmpty kind="zero" query="" onClear={() => {}} />,
  )
  assert.match(zero, /清空筛选/)
  const search = renderToStaticMarkup(
    <GalleryEmpty kind="search" query="灯" onClear={() => {}} />,
  )
  assert.match(search, /「灯」/)
})

// ---------- 前置门：暂不可上架的行 ----------

test("暂不可上架的详情行仍可加入或移出清单，进入上架给出原因", () => {
  const blocked = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        productId: "prd_bl",
        title: "复核中挂画",
        listable: false,
        denial: "catalog_expired",
      })}
      propDefs={[]}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  const tag = (html: string, marker: string) =>
    html.match(new RegExp(`<button[^>]*${marker}[^>]*>`))?.[0] ?? ""
  const queueToggle = tag(blocked, "data-gallery-queue-toggle")
  const openListing = tag(blocked, "data-gallery-open-listing")
  assert.doesNotMatch(queueToggle, /disabled=""|aria-disabled="true"/)
  assert.match(openListing, /disabled=""/)
  assert.match(openListing, /aria-disabled="true"/)
  assert.match(openListing, /data-listability-blocked/)
  assert.match(openListing, /cursor-not-allowed/)
  assert.match(openListing, /opacity-45/)
  // 说明是陈述句——常驻 <p>，不是告警也不写错误 DOM。
  assert.match(
    blocked,
    /data-listability-note[^>]*>商品类目信息已过期，需平台更新后再上架/,
  )
  assert.doesNotMatch(blocked, /role="alert"/)
  // 收藏不属上架动作：不受影响、不带标记（Button 基础类自带 aria-disabled:
  // 工具类，所以断言的是属性不是类名）。
  const favorite = tag(blocked, "data-gallery-favorite")
  assert.ok(favorite)
  assert.doesNotMatch(favorite, /aria-disabled=|data-listability-blocked/)

  // 停售行读停售句；可上架行没有任何门。
  const archived = renderToStaticMarkup(
    <GalleryDetail
      row={row({ listable: false, denial: "product_archived" })}
      propDefs={[]}
      categoryLabel=""
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(archived, /该商品已停售，不可上架/)
  const clear = renderToStaticMarkup(
    <GalleryDetail
      row={row({})}
      propDefs={[]}
      categoryLabel=""
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.doesNotMatch(clear, /data-listability-blocked|data-listability-note/)
  for (const marker of ["data-gallery-queue-toggle", "data-gallery-open-listing"]) {
    assert.doesNotMatch(tag(clear, marker), /disabled=""|aria-disabled="true"/)
  }
})

test("详情页上架动作保留点击守卫", () => {
  const source = readFileSync(
    new URL("./gallery-detail.tsx", import.meta.url),
    "utf8",
  )
  // 清单允许暂存待处理商品，实际导入仍保留守卫。
  assert.equal(
    source.match(/if \(listingBlocked\) return/g)?.length,
    1,
    "进入上架须保留守卫",
  )
  assert.match(
    source,
    /if \(listingBlocked\) return\s*onOpenListing\(row\)/,
  )
})

test("暂不可上架的卡保留清晰的状态与可用的收藏、清单操作", () => {
  resetCollectionForTests()
  const html = renderToStaticMarkup(
    <SupplierDbsGallery
      catalog={{
        ...catalog,
        rows: [
          ...catalog.rows,
          row({
            productId: "prd_bl",
            title: "复核中挂画",
            listable: false,
            denial: "catalog_digest_mismatch",
          }),
          row({
            productId: "prd_dl",
            title: "旧款搪瓷杯",
            listable: false,
            denial: "product_archived",
          }),
        ],
      }}
      filters={EMPTY_FILTERS}
      onFiltersChange={() => {}}
      categoryTree={tree}
      onOpenDetail={() => {}}
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  for (const id of ["prd_bl", "prd_dl"]) {
    const card = html.match(new RegExp(`<article[^>]*data-gallery-product="${id}"[^]*?</article>`))?.[0] ?? ""
    assert.match(card, /data-gallery-listability/, `${id} 应显示受阻状态`)
    assert.doesNotMatch(card, /disabled=""/, `${id} 仍可浏览、收藏和加入本地清单`)
  }
  // 分类徽标：平台待处理 / 已停售各一枚。
  assert.match(html, /data-gallery-listability[^>]*>暂不可上架/)
  assert.match(html, /data-gallery-listability[^>]*>已停售/)
  assert.equal(html.match(/data-gallery-listability/g)?.length, 2)
  // 收藏与清单角标不属上架门——两枚都在。
  assert.match(html, /aria-label="收藏 复核中挂画"/)
  assert.match(html, /aria-label="加入上架清单 复核中挂画"/)
  // 可上架商品没有徽标、不置灰。
  const okCard = html.match(/<article[^>]*data-gallery-product="prd_2"[^]*?<\/article>/)?.[0] ?? ""
  assert.doesNotMatch(okCard, /data-gallery-listability/)
  resetCollectionForTests()
})

test("批量进入上架跳过暂不可上架的行：一次性报数，可达集照走", async () => {
  const present = [
    row({ productId: "prd_ok", title: "可上架" }),
    row({ productId: "prd_bl", title: "待复核", listable: false, denial: "catalog_expired" }),
    row({ productId: "prd_dl", title: "旧款杯", listable: false, denial: "product_archived" }),
  ]
  const { rows: importable, skipped } = importableQueueRows(present)
  assert.deepEqual(
    importable.map((item) => item.productId),
    ["prd_ok"],
  )
  assert.equal(skipped, 2)

  // 提交缝：toast.add 替身数条数——同一份 notifyInfo 报数落一次。
  const originalAdd = toast.add
  const toasts: Array<{ title?: string }> = []
  toast.add = ((options: { title?: string }) => {
    toasts.push(options)
    return "spy"
  }) as typeof toast.add
  const submitted: CatalogListingIdentity[] = []
  try {
    assert.equal(await submitQueueImport(present, (products) => { submitted.push(...products) }), true)
    assert.deepEqual(toasts.map((item) => item.title), [
      "已跳过 2 件暂不可上架的商品",
    ])
    assert.deepEqual(
      submitted.map((product) => product.productId),
      ["prd_ok"],
    )
    // 受阻行的身份随快照随行——入口兜底按它再过滤。
    assert.deepEqual(
      submitted,
      [{ productId: "prd_ok", sourceId: "src_1", title: "可上架", platformCode: "P000" }],
    )
    // 全部受阻：报数仍交代，空数组不进上架导航。
    toasts.length = 0
    let called = 0
    assert.equal(await submitQueueImport(present.slice(1), () => {
      called += 1
    }), false)
    assert.equal(called, 0)
    assert.deepEqual(toasts.map((item) => item.title), [
      "已跳过 2 件暂不可上架的商品",
    ])
  } finally {
    toast.add = originalAdd
  }
})

test("清单行的下架徽标与可上架性徽标互斥——同一行不出两枚", () => {
  const source = readFileSync(
    new URL("./listing-queue-tray.tsx", import.meta.url),
    "utf8",
  )
  // 行缺席 → 既有「已下架 · 不可上架」；行在但受阻 → LISTABILITY_BADGE。
  // 两枚徽标在同一条件分支的两侧，结构上不可能同现。
  assert.match(
    source,
    /!row \?[\s\S]*?已下架 · 不可上架[\s\S]*?:[\s\S]*?!rowListability\.listable[\s\S]*?LISTABILITY_BADGE\[rowListability\.class\]/,
  )
})

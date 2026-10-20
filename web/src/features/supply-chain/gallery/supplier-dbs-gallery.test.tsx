import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { isValidElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"

import type { CategoryTreeNodeView, OzonStoreView } from "@/bindings/commands"
import type {
  SellerSupplierDbCatalogData,
  SellerSupplierDbRowData,
} from "@/bindings/http-supplier-dbs-catalog"
import { toast } from "@/components/ui/toast"

import { assertSellerSurfaceClean } from "../seller-leak"
import { GalleryDetail } from "./gallery-detail"
import {
  EMPTY_FILTERS,
  categoryFacets,
  categoryIndex,
  type CatalogListingIdentity,
  type GalleryFilters,
} from "./gallery-model"
import {
  importableQueueRows,
  queueEntryById,
  queueEntryFromRow,
  resetCollectionForTests,
  setQueuedPsd,
  setQueuedStore,
  toggleQueued,
  type ListingQueueEntry,
} from "./listing-queue"
import { GalleryEmpty } from "./gallery-empty"
import { submitQueueImport } from "./listing-queue-tray"
import {
  QueueBindings,
  QueuePsdOptions,
  QueueStoreOptions,
} from "./queue-bindings"
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
    { sourceId: "src_1", name: "美国3C厂", country: "US", icon: "🏭" },
    { sourceId: "src_2", name: "美东厂", country: "US", icon: "" },
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

test("平台货源筛选对所有用户开放；单库时控件让位", () => {
  // 库筛选不再按角色收口：多库目录谁都看到「平台货源」下拉；
  // 单库目录没有筛选意义，控件不渲染。
  const html = gallery()
  assert.match(html, /aria-label="平台货源"/)
  assert.match(html, /全部平台货源/)
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
  assert.doesNotMatch(singleDb, /aria-label="平台货源"/)
})

test("toolbar row: search + 库/类目/价格区间/排序 + 刷新; 库 cascades 类目", () => {
  const html = gallery()
  // 图 1：筛选收进工具条下拉，没有左栏。
  assert.doesNotMatch(html, /data-gallery-rail/)
  assert.match(html, /aria-label="搜索商品"/)
  assert.match(html, /搜索商品名称、编号或标签/)
  assert.match(html, /aria-label="平台货源"/)
  assert.match(html, /全部平台货源/)
  assert.match(html, /aria-label="类目"/)
  assert.match(html, /全部类目/)
  // 价格不是预制分段下拉，是卖家输入的最低/最高价。
  assert.match(html, /data-gallery-price-range/)
  assert.match(html, /aria-label="最低价"/)
  assert.match(html, /aria-label="最高价"/)
  assert.doesNotMatch(html, /全部价格/)
  assert.match(html, /aria-label="排序"/)
  assert.match(html, /最新上架/)
  // 密度分段在标题行右端。
  assert.match(html, /data-gallery-density-toggle/)
  // 画廊只有卖家面形态：管理入口在侧栏「列表管理」屏，不在工具行。
  assert.doesNotMatch(html, /列表管理/)

  // 选中库：trigger 换成库名；类目下拉收窄由 facet scope 保证。
  const scoped = gallery({ ...EMPTY_FILTERS, db: "src_2" })
  assert.match(scoped, /美东厂/)
  const scopedCats = categoryFacets(catalog.rows, "src_2", categoryIndex(tree))
  assert.deepEqual(scopedCats.map((item) => item.value), ["20000000"])
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

test("card wall renders count, 4:3 cover, price, badges + actions", () => {
  const html = gallery()
  // 结果带只剩 N 件商品：库名由工具条下拉与 chip 交代，不再有「全部商品」标题。
  assert.match(html, /data-gallery-resultbar/)
  assert.match(html, /共 3 件商品/)
  assert.doesNotMatch(html, /data-gallery-heading/)
  assert.doesNotMatch(html, /全部商品/)
  assert.match(html, /data-gallery-wall/)
  const card = html.match(/<li[^>]*data-gallery-card="prd_1"[^]*?<\/li>/)?.[0] ?? ""
  assert.ok(card)
  assert.match(card, /圣诞帽/)
  assert.match(card, /¥16\.00/)
  assert.match(card, /2–3 天发货/)
  // 卡片徽标行：平台货源名 + 类目。卡面是瘦版——零售价/划线价（平台）/
  // 上架入口/固定 tags/自定义属性全在详情页，隐藏属性永远不上卖家面。
  assert.match(card, /美国3C厂/)
  assert.match(card, /节日用品/)
  assert.match(card, /查看详情/)
  assert.match(card, /加入清单/)
  assert.doesNotMatch(card, /hidden-value|>棉</)
  assert.doesNotMatch(html, /¥890\.00|采纳到店铺|>新</)
  assert.match(html, /loading="lazy"/)
  assert.match(html, /aspect-\[4\/3\]/)
  assertSellerSurfaceClean(catalog, html)
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
})

test("detail page is read-only: carousel, video, seller_visible props, defaults", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={catalog.rows[0]}
      propDefs={catalog.propDefs.filter(
        (def) => def.sourceId === "src_1" && def.sellerVisible,
      )}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(detail, /data-gallery-detail/)
  assert.match(detail, /P001/)
  // 回程走壳层面包屑模块段：详情页内不再放返回钮。
  assert.doesNotMatch(detail, /返回货架/)
  assert.match(detail, /圣诞帽/)
  // 舞台不再挂浮层计数（1 / 2）——当前项由左列缩略图高亮与底部分段 tab 交代。
  assert.doesNotMatch(detail, /\d+ \/ \d+/)
  assert.match(detail, /第 2 张/)
  // 翻页钮挂在舞台层，沿整条媒体序列走（视频→图集→参数→尺码），不是图集独占。
  assert.match(detail, /aria-label="上一项"/)
  assert.match(detail, /aria-label="下一项"/)
  assert.match(detail, /<video/)
  assert.match(detail, /controls/)
  // seller_visible prop renders through its option label; the hidden def
  // never reaches the page even though the row still carries its value.
  assert.match(detail, /材质/)
  assert.match(detail, /棉/)
  assert.doesNotMatch(detail, /内部选品备注|hidden-value|pp_2/)
  assert.match(detail, /节日帽，保暖。/)
  assert.match(detail, /无品牌/)
  assert.match(detail, /¥16\.00/)
  assert.match(detail, /建议零售 ¥890\.00/)
  // 建议零售与平台价、划线价（平台）同为 ¥——卖家面不出现 ₽。
  assert.match(detail, /平台划线价 ¥1290\.00/)
  assert.doesNotMatch(detail, /₽/)
  assert.match(detail, /data-gallery-open-listing/)
  assert.match(detail, /进入上架/)
  // 物流注入入口不在详情页（宿主在 catalog-screen 的 ProductShopView）。
  assert.doesNotMatch(detail, /物流注入/)
  assert.doesNotMatch(detail, /进店/)
  assert.doesNotMatch(detail, /采纳到店铺/)
  // 商品事实只读，规格使用单选控件。
  assert.doesNotMatch(detail, /<textarea|<input(?![^>]*type="radio")/)
  assertSellerSurfaceClean(catalog, detail)
})

test("detail page follows the taobao shape: 价盘横幅/服务条/规格格/动作条", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={catalog.rows[0]}
      propDefs={catalog.propDefs.filter(
        (def) => def.sourceId === "src_1" && def.sellerVisible,
      )}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  // 不设店铺条/页眉行：库名/国别/货号都不占页顶一块（库名走画廊工具行，
  // 货号落在「基本信息」）。
  assert.doesNotMatch(detail, /美国3C厂/)
  assert.doesNotMatch(detail, />US</)
  assert.match(detail, /节日用品/)
  // 价盘横幅：红橙渐变促销条上平台价大号等宽。
  assert.match(detail, /data-gallery-price-banner/)
  // 交付信息行只余上架日期——交期不再在此重复（只在基本信息表与参数面板）。
  // 标题下不再重复「图集 N 张」——看图器 tab 已承担。
  const deliveryStart = detail.indexOf('aria-label="交付信息"')
  assert.ok(deliveryStart > -1, "交付信息行应渲染")
  const deliveryBlock = detail.slice(
    deliveryStart,
    detail.indexOf("</ul>", deliveryStart),
  )
  assert.match(deliveryBlock, /上架 \d/)
  assert.doesNotMatch(deliveryBlock, /天发货/)
  assert.match(detail, /2–3 天发货/)
  assert.doesNotMatch(detail, /图集 \d+ 张/)
  // 规格选项格：select 属性的可选项全部铺 tile，行值（棉）高亮为已选。
  assert.match(detail, /aria-label="材质"/)
  assert.match(detail, /aria-current="true"[^>]*>\s*棉|>棉<\/li>/)
  // 动作条：加入上架清单 / 进入上架 / 收藏。
  assert.match(detail, /data-gallery-queue-toggle/)
  assert.match(detail, /加入上架清单/)
  assert.match(detail, /data-gallery-favorite/)
  assert.match(detail, />收藏</)
  // 竖排媒体缩略图列在主舞台左侧，舞台下挂分段 tab。
  assert.match(detail, /aria-label="媒体列表"/)
  assert.match(detail, /aria-label="第 2 张"/)
  // 有媒体时不留占位钮——缩略图自己就是入口。
  assert.doesNotMatch(detail, /data-gallery-media-rail="video"/)
  assert.doesNotMatch(detail, /data-gallery-media-rail="gallery"/)
  assert.match(detail, /data-gallery-media-tab="video"/)
  assert.match(detail, /data-gallery-media-tab="gallery"/)
  assert.match(detail, /data-gallery-media-tab="params"/)
  assert.match(detail, /data-gallery-media-tab="size"/)
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

  // 未入清单：进入上架可点，不挂门提示；规格格在场，提示词绑定正文也在
  // （正文只说明绑定关系，不下发提示词内容）。
  const idle = render(variantA)
  assert.doesNotMatch(openListingTag(idle), /disabled=""/)
  assert.doesNotMatch(idle, /data-gallery-listing-gate/)
  assert.doesNotMatch(idle, /加入清单后即可进入上架/)
  assert.doesNotMatch(idle, /选好规格加入清单后/)
  assert.match(idle, /role="radiogroup" aria-label="规格"/)
  assert.match(idle, /提示词随规格选择/)

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

test("单规格也在动作条前显示规格与提示词选择", () => {
  const html = renderToStaticMarkup(
    <GalleryDetail
      row={row({ size: "" })}
      propDefs={[]}
      categoryLabel="手工"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(html, /规格与提示词/)
  assert.match(html, /type="radio"[^>]*aria-label="默认规格"[^>]*checked=""/)
  assert.match(html, /提示词随规格选择/)
  assert.ok(html.indexOf('aria-label="基本信息"') < html.indexOf('aria-label="规格"'))
  assert.ok(html.indexOf('aria-label="规格"') < html.indexOf('data-gallery-queue-toggle'))
})

test("动作条上方列基本信息：名称/编号/类目/品牌/属性 + 包装/交期", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        size: "40×50cm",
        material: "帆布",
        craft: "喷绘",
        brand: "无品牌",
        packWidthMm: 400,
        packHeightMm: 300,
        packDepthMm: 100,
        packWeightG: 350,
        contents: "画布 ×1、颜料 ×1套、画笔 ×3",
        props: { pp_1: "cotton", pp_text: "深圳" },
      })}
      propDefs={[
        ...catalog.propDefs.filter(
          (def) => def.sourceId === "src_1" && def.sellerVisible,
        ),
        {
          propId: "pp_text",
          sourceId: "src_1",
          name: "产地",
          type: "text",
          options: [],
          position: 9,
          sellerVisible: true,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ]}
      categoryLabel="节日用品"
      typeLabel="数字油画"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  // 基本信息表在动作条（加入上架清单）之前。
  const specIndex = detail.indexOf('aria-label="基本信息"')
  const ctaIndex = detail.indexOf("data-gallery-queue-toggle")
  assert.ok(specIndex > -1, "基本信息块应渲染")
  assert.ok(ctaIndex > specIndex, "基本信息块应在动作条上方")
  const specBlock = detail.slice(specIndex, ctaIndex)
  // 字段单与行页面「基本信息」区一致：名称打头，编号（等宽）/类目
  // （L2 · 类型）/品牌/材质/工艺/毛重/包装/清单/交期——类目由类目坐标解析，
  // 不经默认字段；规格/运费/上架不在此表（分归变体 radio、价盘横幅、
  // 交付信息行）。
  assert.match(specBlock, /aria-label="名称 货品"/)
  assert.match(specBlock, /aria-label="编号 P000"/)
  assert.match(specBlock, /aria-label="类目 节日用品 · 数字油画"/)
  assert.match(specBlock, /aria-label="品牌 无品牌"/)
  assert.match(specBlock, /aria-label="材质 帆布"/)
  assert.match(specBlock, /aria-label="工艺 喷绘"/)
  assert.match(specBlock, /aria-label="清单 画布 ×1、颜料 ×1套、画笔 ×3"/)
  assert.match(specBlock, /aria-label="交期 2–3 天发货"/)
  assert.doesNotMatch(specBlock, /aria-label="规格 |aria-label="运费 |aria-label="上架 /)
  // 未铺选项格的文本属性进表；已铺格的 select 属性（材质 pp_1=棉）不重复，
  // 选项格本身仍在上方。
  assert.match(specBlock, /aria-label="产地 深圳"/)
  assert.doesNotMatch(specBlock, /aria-label="材质 棉"/)
  assert.match(detail, /aria-label="材质"[\s\S]*?aria-label="基本信息"/)
  // 包装三边合并成一行（毫米），包装重量一行（克）。
  assert.match(specBlock, /aria-label="包装尺寸 400×300×100 mm"/)
  assert.match(specBlock, /aria-label="包装重量 350 g"/)
  // 默认字段不进详情页：原始字段键不出现。
  assert.doesNotMatch(specBlock.split("</dl>")[0]!, /attribute_\d+|width|dimension_unit/)
  // 基本信息块整表常驻：裸行缺项不散行，统一「—」占位。
  const bare = renderToStaticMarkup(
    <GalleryDetail
      row={row({ title: "裸行" })}
      propDefs={[]}
      categoryLabel="家居"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(bare, /aria-label="基本信息"/)
  assert.match(bare, /aria-label="名称 裸行"/)
  assert.match(bare, /aria-label="编号 P000"/)
  assert.match(bare, /aria-label="类目 家居"/)
  for (const label of [
    "品牌",
    "材质",
    "工艺",
    "毛重",
    "包装尺寸",
    "包装重量",
  ]) {
    assert.match(bare, new RegExp(`aria-label="${label} —"`), `裸行缺 ${label} 占位行`)
  }
  // 已定义但未填的 seller_visible 属性同样留占位行，不随值散行。
  const bareProp = renderToStaticMarkup(
    <GalleryDetail
      row={row({ title: "裸行" })}
      propDefs={[
        {
          propId: "pp_text",
          sourceId: "src_1",
          name: "产地",
          type: "text",
          options: [],
          position: 9,
          sellerVisible: true,
          createdAtMs: 0,
          updatedAtMs: 0,
        },
      ]}
      categoryLabel="家居"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(bareProp, /aria-label="产地 —"/)
})

test("价盘横幅按内容收拢宽度：主价区 + metric 带，供货承诺竖向叠放贴右缘", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={catalog.rows[0]}
      propDefs={catalog.propDefs.filter(
        (def) => def.sourceId === "src_1" && def.sellerVisible,
      )}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  // 横幅按内容收拢宽度（w-fit），与下方收拢的 CTA 保持协调。
  const banner = detail.match(/<div[^>]*data-gallery-price-banner[^>]*>/)?.[0] ?? ""
  assert.match(banner, /w-fit/)
  assert.match(banner, /from-\[#ff5a1f\]/)
  // 主价区：平台价大号 + 同币种划线价锚点（aria-label 保留口径）。
  assert.match(detail, /平台价[\s\S]*?font-mono text-2xl/)
  assert.match(detail, /aria-label="平台划线价 ¥1290\.00"/)
  // metric 带：建议零售（¥）与平台价分行，运费紧随其后，缺项整行不渲染。
  assert.match(detail, /data-gallery-price-metrics=""/)
  assert.match(detail, /建议零售 ¥890\.00/)
  assert.match(detail, /运费 ¥2\.00/)
  // 供货承诺两行叠放：源头供货在上方，全场直发在下方。
  const promise = detail.match(/<div class="[^"]*"><span class="[^"]*">\s*源头供货/)?.[0] ?? ""
  assert.match(promise, /flex-col/)
  assert.match(promise, /items-end/)
  assert.match(detail, /全场直发/)
  // 空值或零值运费显示为 ¥0.00（零运费）。
  const zeroShipping = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        title: "零运费货",
        shippingCostCents: null,
      })}
      propDefs={[]}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(zeroShipping, /data-gallery-price-metrics=""/)
  assert.match(zeroShipping, /运费 ¥0\.00/)
  // 无建议零售且未定义运费的行不留空的 metric 带。
  const bare = renderToStaticMarkup(
    <GalleryDetail
      row={catalog.rows[1]}
      propDefs={[]}
      categoryLabel="家居"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.doesNotMatch(bare, /data-gallery-price-metrics/)
  assert.match(bare, /data-gallery-price-banner/)
})

test("工具行尾收密度/收藏筛/上架清单入口；卡片带查看详情与加入清单", () => {
  const html = gallery()
  assert.match(html, /data-gallery-favonly/)
  assert.match(html, /只看收藏/)
  // 收藏筛在工具行里（搜索那一行），不单落一行、也不下沉到结果带。
  const toolbar = html.match(/<div class="flex flex-wrap items-center gap-3"[^]*?data-gallery-resultbar/)?.[0]
  assert.ok(toolbar)
  assert.match(toolbar, /data-gallery-favonly/)
  // 清单入口是工具行尾的常态按钮（图 1），不再盖在卡墙角。
  assert.match(toolbar, /data-gallery-queue-open/)
  assert.match(toolbar, /上架清单/)
  // 卡片：封面常驻收藏心 + 动作带的查看详情/加入清单。
  assert.match(html, /data-gallery-card-favorite/)
  assert.match(html, /aria-label="收藏 圣诞帽"/)
  assert.match(html, /data-gallery-card-queue/)
  assert.match(html, /aria-label="加入上架清单 圣诞帽"/)
  assert.match(html, /查看详情/)
  assert.match(html, /加入清单/)
})

test("卡片只切换清单成员；清单浮窗不再带平台选择", () => {
  const hatRow = catalog.rows[0]!
  toggleQueued(hatRow)
  const html = gallery()
  assert.match(html, /aria-label="移出上架清单 圣诞帽"/)
  assert.doesNotMatch(html, /data-gallery-queue-scheme|data-gallery-queue-platform|上架到/)
  resetCollectionForTests()
})

test("无媒体行详情页也走看图器：默认参数页，图集如空态、视频入口隐藏", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        title: "无图货",
        gallery: [],
        productVideos: [],
        description: "",
      })}
      propDefs={[]}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  assert.match(detail, /data-gallery-detail/)
  assert.match(detail, /暂无图片/)
  assert.match(detail, /进入上架/)
  assert.match(detail, /无图货/)
  // 看图器常驻：图集/参数/尺码 tab + 参数/尺码列尾钮都在；图集面板给空态。
  assert.match(detail, /data-gallery-media-tab="gallery"/)
  assert.match(detail, /data-gallery-media-tab="params"/)
  assert.match(detail, /data-gallery-media-tab="size"/)
  assert.match(detail, /data-gallery-media-rail="params"/)
  // 无视频不设入口——左列占位钮与分段 tab 都不出「视频」，
  // 不给空面板留门。（舞台的视频 tabpanel 面板壳仍常驻挂 hidden，
  // 无入口时不可达。）
  assert.doesNotMatch(detail, /data-gallery-media-rail="video"/)
  assert.doesNotMatch(detail, /data-gallery-media-tab="video"/)
  assert.doesNotMatch(detail, /视频 \d+ 条/)
  // 图集空态仍保留占位钮——与视频位（随数据隐藏）是两种口径。
  assert.match(detail, /data-gallery-media-rail="gallery"/)
  const rail = detail.match(/aria-label="媒体列表"[^]*?<\/ul>/)?.[0] ?? ""
  assert.ok(rail, "媒体列表 should be present")
  const railOrder = ["gallery", "params", "size"].map((id) =>
    rail.indexOf(`data-gallery-media-rail="${id}"`),
  )
  assert.deepEqual(
    railOrder,
    [...railOrder].sort((a, b) => a - b),
    "rail keeps 图集/参数/尺码 order",
  )
  assert.ok(railOrder.every((index) => index >= 0), "rail entries present")
  assert.doesNotMatch(detail, /<video/)
  // 翻页序列与媒体列一一对位：空图集占位仍在列，翻页钮始终在场。
  assert.match(detail, /aria-label="上一项"/)
  assertSellerSurfaceClean(catalog, detail)
})

test("无视频有图集：视频 tab 与列位隐藏，图集照常", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        title: "只有图的货",
        gallery: [
          { url: "https://img.example/1.jpg", w: 800, h: 800 },
          { url: "https://img.example/2.jpg", w: 800, h: 800 },
        ],
        productVideos: [],
      })}
      propDefs={[]}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  // 有图集时默认 tab 是图集；视频入口两个位置都不出现。
  assert.doesNotMatch(detail, /data-gallery-media-tab="video"/)
  assert.doesNotMatch(detail, /data-gallery-media-rail="video"/)
  assert.doesNotMatch(detail, /data-gallery-media-rail="gallery"/)
  assert.match(detail, /data-gallery-media-tab="gallery"/)
  assert.match(detail, /aria-label="第 1 张"/)
  assert.doesNotMatch(detail, /<video/)
})

test("行级包装尺寸/重量进尺码卡，画廊不为默认字段另设页底区", () => {
  const detail = renderToStaticMarkup(
    <GalleryDetail
      row={row({
        gallery: [],
        productVideos: [],
        size: "40×50cm",
        grossWeightG: 480,
        packWidthMm: 400,
        packHeightMm: 300,
        packDepthMm: 100,
        packWeightG: 350,
      })}
      propDefs={[]}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  const sizePanel = detail.match(/role="tabpanel" aria-label="尺码"[^]*?<\/dl>/)?.[0]
  assert.ok(sizePanel, "尺码面板应列事实而不是空态")
  assert.doesNotMatch(sizePanel, /暂无尺码信息/)
  const labels = ["规格 40×50cm", "毛重 480 g", "包装尺寸 400×300×100 mm", "包装重量 350 g"]
  for (const label of labels) {
    assert.ok(sizePanel.includes(`aria-label="${label}"`), `尺码面板缺 ${label}`)
  }
  const order = labels.map((label) => sizePanel.indexOf(`aria-label="${label}"`))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "尺码卡按 规格/毛重/包装序")

  // 缺一条边时按已填的边逐条呈现，不凑「包装尺寸」行。
  const partial = renderToStaticMarkup(
    <GalleryDetail
      row={row({ packWidthMm: 400 })}
      propDefs={[]}
      categoryLabel="节日用品"
      onOpenListing={() => {}}
      onOpenShipping={() => {}}
    />,
  )
  const partialPanel = partial.match(/role="tabpanel" aria-label="尺码"[^]*?<\/dl>/)?.[0]
  assert.ok(partialPanel)
  assert.match(partialPanel, /aria-label="包装宽度 400 mm"/)
  assert.doesNotMatch(partialPanel, /aria-label="包装尺寸 \d/)

  // 不再有页底「默认字段」账目区——画廊详情不读默认字段。
  assert.doesNotMatch(detail, /aria-label="默认字段"/)
  assert.doesNotMatch(detail, /默认字段（\d+）/)
})

test("打开的行以详情页整页呈现，卡墙让位而不是盖抽屉", () => {
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
  // 详情页是页面不是浮层：工具条、结果带与卡墙全部让位。
  assert.doesNotMatch(html, /data-gallery-wall|data-gallery-resultbar|aria-label="搜索商品"/)
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


/** 工作区可用店铺（cloud uuid 口径）——清单行的目标店铺单选就列这一份。 */
const queueStores = [
  { id: "store-moscow", label: "莫斯科一店" },
  { id: "store-spb", label: "圣彼得堡店" },
] as OzonStoreView[]

function queueEntry(overrides: Partial<ListingQueueEntry> = {}): ListingQueueEntry {
  return { ...queueEntryFromRow(catalog.rows[0]!), ...overrides }
}

/** 触发钮连同内部回显的标记段：从 data 标记切到该钮闭合。 */
function controlMarkup(html: string, marker: string): string {
  const start = html.indexOf(marker)
  if (start < 0) return ""
  const end = html.indexOf("</button>", start)
  return end < 0 ? html.slice(start) : html.slice(start, end)
}

/** 某个单选/动作项的起始标签（从锚点往后找），用来看选中与禁用态。 */
function itemTag(html: string, label: string, after = ""): string {
  const from = after ? html.indexOf(after) : 0
  const at = html.indexOf(label, from < 0 ? 0 : from)
  if (at < 0) return ""
  const start = html.lastIndexOf("<button", at)
  const end = html.indexOf(">", start)
  return start < 0 || end < 0 ? "" : html.slice(start, end + 1)
}

/** 元素里的纯文本（穿过 span/svg 之类的壳）。 */
function elementText(value: ReactNode): string {
  if (typeof value === "string" || typeof value === "number") return String(value)
  if (Array.isArray(value)) return value.map(elementText).join("")
  if (isValidElement(value)) {
    return elementText((value.props as { children?: ReactNode }).children)
  }
  return ""
}

/**
 * 浮层内容走 portal，SSR 读不到、bun test 又没有 DOM；所以直接调用无 hook 的
 * 选项组件拿元素树，点它的按钮——同一条 onClick 闭包，测的是真实写回。
 */
function tapButton(node: ReactNode, label: string): void {
  if (Array.isArray(node)) {
    for (const child of node) tapButton(child, label)
    return
  }
  if (!isValidElement(node)) return
  const props = node.props as { children?: ReactNode; onClick?: () => void }
  if (node.type === "button" && elementText(props.children).trim() === label) {
    props.onClick?.()
    return
  }
  tapButton(props.children, label)
}

test("清单行就地绑目标店铺与 PSD：虚线待绑、绑上回显、清除回退", () => {
  resetCollectionForTests()
  const hat = catalog.rows[0]!
  toggleQueued(hat)
  // 从模块清单取条目渲染：和浮窗读的是同一份快照。
  const render = () =>
    renderToStaticMarkup(
      <QueueBindings
        entry={queueEntryById(hat.productId)!}
        available
        stores={queueStores}
      />,
    )

  // 未绑：两个虚线触发钮。
  const idle = render()
  assert.match(idle, /data-gallery-queue-bindings="prd_1"/)
  const storeIdle = controlMarkup(idle, 'data-gallery-queue-store=""')
  assert.match(storeIdle, /aria-label="绑定店铺 圣诞帽"/)
  assert.match(storeIdle, /绑定店铺/)
  assert.doesNotMatch(storeIdle, /目标店铺：/)
  assert.match(storeIdle, /border-dashed/)
  const psdIdle = controlMarkup(idle, 'data-gallery-queue-psd=""')
  assert.match(psdIdle, /aria-label="绑定 PSD 圣诞帽"/)
  assert.match(psdIdle, /border-dashed/)

  // 绑上：触发钮换成店铺徽标与等宽文件名（都能在浮窗里改回来）。
  setQueuedStore(hat.productId, "store-spb")
  setQueuedPsd(hat.productId, { sha256: "d".repeat(64), fileName: "油画模板.psd" })
  const bound = render()
  const storeBound = controlMarkup(bound, 'data-gallery-queue-store=""')
  assert.match(storeBound, /aria-label="目标店铺：圣彼得堡店"/)
  assert.match(storeBound, />圣彼得堡店</)
  assert.doesNotMatch(storeBound, /border-dashed/)
  const psdBound = controlMarkup(bound, 'data-gallery-queue-psd=""')
  assert.match(psdBound, /aria-label="PSD 模板：油画模板\.psd"/)
  assert.match(psdBound, /font-mono[^"]*">油画模板\.psd/)
  assert.doesNotMatch(psdBound, /border-dashed/)

  // 清除：字段摘掉，行回到待绑形态。
  setQueuedStore(hat.productId, "")
  setQueuedPsd(hat.productId, null)
  const cleared = render()
  const storeCleared = controlMarkup(cleared, 'data-gallery-queue-store=""')
  assert.match(storeCleared, /aria-label="绑定店铺 圣诞帽"/)
  assert.doesNotMatch(storeCleared, /圣彼得堡店/)
  const psdCleared = controlMarkup(cleared, 'data-gallery-queue-psd=""')
  assert.match(psdCleared, /aria-label="绑定 PSD 圣诞帽"/)
  assert.doesNotMatch(psdCleared, /油画模板\.psd/)
  resetCollectionForTests()
})

test("下架的行不给绑定控件：绑定落不了卡，就别攒草稿", () => {
  // 行不在最新货盘里（已下架）：整组控件不渲染。
  assert.equal(
    renderToStaticMarkup(
      <QueueBindings entry={queueEntry()} available={false} stores={queueStores} />,
    ),
    "",
  )
  assert.match(
    renderToStaticMarkup(
      <QueueBindings entry={queueEntry()} available stores={queueStores} />,
    ),
    /data-gallery-queue-bindings="prd_1"/,
  )
})

test("店铺浮层是「不绑定」+ 工作区店铺的单选；没有店铺时给引导出口", () => {
  const radios = 'role="radiogroup"'
  const list = renderToStaticMarkup(
    <QueueStoreOptions entry={queueEntry()} stores={queueStores} />,
  )
  assert.match(list, /role="radiogroup" aria-label="目标店铺"/)
  assert.match(list, /不绑定/)
  assert.match(itemTag(list, "不绑定", radios), /aria-checked="true"/)
  assert.match(itemTag(list, "莫斯科一店", radios), /aria-checked="false"/)
  assert.match(itemTag(list, "圣彼得堡店", radios), /aria-checked="false"/)

  // 已绑：那一项是选中的，其余（含「不绑定」）不是。
  const boundList = renderToStaticMarkup(
    <QueueStoreOptions entry={queueEntry({ storeId: "store-spb" })} stores={queueStores} />,
  )
  assert.match(itemTag(boundList, "圣彼得堡店", radios), /aria-checked="true"/)
  assert.match(itemTag(boundList, "莫斯科一店", radios), /aria-checked="false"/)
  assert.match(itemTag(boundList, "不绑定", radios), /aria-checked="false"/)

  // 没有可用店铺：给出「去店铺页添加」；没有出口回调就不画走不动的按钮。
  const guided = renderToStaticMarkup(
    <QueueStoreOptions entry={queueEntry()} stores={[]} onOpenStores={() => {}} />,
  )
  assert.match(guided, /还没有可用店铺/)
  assert.match(guided, /去店铺页添加/)
  assert.doesNotMatch(
    renderToStaticMarkup(<QueueStoreOptions entry={queueEntry()} stores={[]} />),
    /去店铺页添加/,
  )
})

test("点单选/清除钮就地写回清单条目", () => {
  resetCollectionForTests()
  const hat = catalog.rows[0]!
  toggleQueued(hat)

  const openStoreList = () =>
    QueueStoreOptions({ entry: queueEntryById(hat.productId)!, stores: queueStores })
  tapButton(openStoreList(), "圣彼得堡店")
  assert.equal(queueEntryById(hat.productId)?.storeId, "store-spb")
  tapButton(openStoreList(), "莫斯科一店") // 换绑覆盖前值
  assert.equal(queueEntryById(hat.productId)?.storeId, "store-moscow")
  tapButton(openStoreList(), "不绑定")
  assert.equal("storeId" in (queueEntryById(hat.productId) ?? {}), false)

  // 「选择 PSD 模板…」交给触发钮的选文件回调；这里只钉住接线。
  let picked = 0
  tapButton(
    QueuePsdOptions({ entry: queueEntryById(hat.productId)!, onPick: () => { picked += 1 } }),
    "选择 PSD 模板…",
  )
  assert.equal(picked, 1)

  setQueuedPsd(hat.productId, { sha256: "d".repeat(64), fileName: "油画模板.psd" })
  tapButton(
    QueuePsdOptions({ entry: queueEntryById(hat.productId)!, onPick: () => {} }),
    "恢复商库默认（清除）",
  )
  assert.equal(queueEntryById(hat.productId)?.psd, undefined)
  resetCollectionForTests()
})

test("PSD 浮层给「选择 PSD 模板…」与「恢复商库默认（清除）」", () => {
  const unbound = renderToStaticMarkup(
    <QueuePsdOptions entry={queueEntry()} onPick={() => {}} />,
  )
  assert.match(unbound, /选择 PSD 模板…/)
  assert.match(unbound, /恢复商库默认（清除）/)
  // 没绑过就没有可清的覆盖，清除项置灰；选文件进行中也不许重复点。
  assert.match(itemTag(unbound, "恢复商库默认（清除）"), /disabled=""/)
  assert.match(
    itemTag(
      renderToStaticMarkup(<QueuePsdOptions entry={queueEntry()} picking onPick={() => {}} />),
      "选择 PSD 模板…",
    ),
    /disabled=""/,
  )

  const bound = renderToStaticMarkup(
    <QueuePsdOptions
      entry={queueEntry({ psd: { sha256: "abc", fileName: "海报.psd" } })}
      onPick={() => {}}
    />,
  )
  assert.doesNotMatch(itemTag(bound, "恢复商库默认（清除）"), /disabled=""/)
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

test("暂不可上架的详情行：两键禁用 + 一行说明，收藏不受影响", () => {
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
  // 两枚自绘 button：aria-disabled + data-listability-blocked + 置灰光标。
  for (const button of [queueToggle, openListing]) {
    assert.match(button, /aria-disabled="true"/)
    assert.match(button, /data-listability-blocked/)
    assert.match(button, /cursor-not-allowed/)
    assert.match(button, /opacity-45/)
  }
  // 说明是陈述句——常驻 <p>，不是告警也不写错误 DOM。
  assert.match(
    blocked,
    /data-listability-note[^>]*>平台正在复核该商品的 Ozon 配置，暂不可上架/,
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
  assert.doesNotMatch(clear, /data-listability-blocked|data-listability-note|aria-disabled=/)
})

test("详情页两枚自绘 button 的 onClick 都带守卫——SSR 不派发事件", () => {
  const source = readFileSync(
    new URL("./gallery-detail.tsx", import.meta.url),
    "utf8",
  )
  // 守卫先于动作：listingBlocked 时 toggleQueued / onOpenListing 都不触发。
  assert.equal(
    source.match(/if \(listingBlocked\) return/g)?.length,
    2,
    "加入上架清单与进入上架两键都须带守卫",
  )
  assert.match(
    source,
    /if \(listingBlocked\) return\s*toggleQueued\(row\)/,
  )
  assert.match(
    source,
    /if \(listingBlocked\) return\s*onOpenListing\(row\)/,
  )
})

test("暂不可上架的卡整卡置灰并带分类徽标，收藏与清单角标照常在", () => {
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
  // 置灰：两张受阻卡的 <li> 带 opacity-60。
  for (const id of ["prd_bl", "prd_dl"]) {
    const card = html.match(new RegExp(`<li[^>]*data-gallery-card="${id}"[^>]*>`))?.[0] ?? ""
    assert.match(card, /opacity-60/, `${id} 应置灰`)
  }
  // 分类徽标：平台待处理 / 已停售各一枚。
  assert.match(html, /data-gallery-card-listability[^>]*>暂不可上架/)
  assert.match(html, /data-gallery-card-listability[^>]*>已停售/)
  assert.equal(html.match(/data-gallery-card-listability/g)?.length, 2)
  // 收藏与清单角标不属上架门——两枚都在。
  assert.match(html, /aria-label="收藏 复核中挂画"/)
  assert.match(html, /aria-label="加入上架清单 复核中挂画"/)
  // 可上架卡没有徽标、不置灰。
  const okCard = html.match(/<li[^>]*data-gallery-card="prd_2"[^>]*>/)?.[0] ?? ""
  assert.doesNotMatch(okCard, /opacity-60/)
  resetCollectionForTests()
})

test("批量进入上架跳过暂不可上架的行：一次性报数，可达集照走", () => {
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
    submitQueueImport(present, (products) => submitted.push(...products))
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
    submitQueueImport(present.slice(1), () => {
      called += 1
    })
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

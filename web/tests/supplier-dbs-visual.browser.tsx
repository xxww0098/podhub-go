// Dev-only 视觉检查页：?view=admin 挂三栏管理端（?panel=1 自动开行详情），
// ?view=gallery 挂卖家画廊。图片用内联 SVG 占位，截图不依赖外网。
import { useState } from "react"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import type { CatalogFetchConfigData } from "@/bindings/http-admin"
import type {
  SupplierDb,
  SupplierDbDetail,
  SupplierDbPropDef,
  SupplierDbRow,
} from "@/bindings/http-supplier-dbs"
import type {
  SellerSupplierDbCatalogData,
  SellerSupplierDbRowData,
} from "@/bindings/http-supplier-dbs-catalog"
import type {
  CategoryFieldOption,
  CategoryFieldView,
  CategorySchemaView,
  CategoryTreeNodeView,
} from "@/bindings/commands"
import { Toaster } from "@/components/ui/toast"
import { SupplierDbsScreen } from "@/features/supplier-dbs/supplier-dbs-screen"
import {
  createSupplierDbsStore,
  type SupplierDbsClient,
} from "@/features/supplier-dbs/supplier-dbs-store"
import { SupplierDbsGallery } from "@/features/supply-chain/gallery/supplier-dbs-gallery"
import { submitQueueImport } from "@/features/supply-chain/gallery/listing-queue-tray"
import { EMPTY_FILTERS } from "@/features/supply-chain/gallery/gallery-model"
import {
  clearQueue,
  isQueued,
  toggleQueued,
} from "@/features/supply-chain/gallery/listing-queue"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const params = new URLSearchParams(location.search)

// ---------- catalog schema stub（行页面「默认字段」分区走 GET /api/catalog/schema） ----------
// `CategorySchemaView` 线形：行坐标 17030122/971000156 对应的分组字段表。按
// 类型登记，形状漂移由 tsc 拦住。分区里的值不再来自行（行上的默认字段槽位
// 已退役），而是 GET …/ozon-config，fixture 是下面的 ADMIN_OZON_CONFIG。

const adminField = (
  field: Pick<
    CategoryFieldView,
    "key" | "name" | "group_name" | "source" | "editor"
  > &
    Partial<CategoryFieldView>,
): CategoryFieldView => ({
  description: "",
  complex_group_collection: false,
  read_only: false,
  constraints: { required: false, collection: false },
  options: [],
  options_truncated: false,
  aspect: null,
  ...field,
})

const option = (id: number, value: string): CategoryFieldOption => ({
  id,
  value,
  info: "",
  picture: "",
})

const ADMIN_SCHEMA: CategorySchemaView = {
  description_category_id: 17030122,
  type_id: 971000156,
  language: "zh_hans",
  fields: [
    adminField({ key: "name", name: "名称", group_name: "基本信息", source: "fixed", editor: "text", constraints: { required: true, collection: false } }),
    adminField({ key: "offer_id", name: "货号", group_name: "基本信息", source: "fixed", editor: "text", constraints: { required: true, collection: false } }),
    adminField({ key: "attribute_4191", name: "简介", group_name: "基本信息", source: "attribute", editor: "text", attribute_id: 4191, constraints: { required: true, collection: false }, description: "向买家展示的商品简介" }),
    adminField({ key: "price", name: "销售价", group_name: "售价与包装", source: "fixed", editor: "decimal", constraints: { required: true, collection: false } }),
    adminField({ key: "old_price", name: "划线价", group_name: "售价与包装", source: "fixed", editor: "decimal" }),
    adminField({ key: "premium_price", name: "会员价", group_name: "售价与包装", source: "fixed", editor: "decimal" }),
    adminField({ key: "vat", name: "VAT 税率", group_name: "售价与包装", source: "fixed", editor: "text", constraints: { required: true, collection: false } }),
    adminField({ key: "currency_code", name: "价格币种", group_name: "售价与包装", source: "fixed", editor: "text" }),
    adminField({ key: "dimension_unit", name: "尺寸单位", group_name: "售价与包装", source: "fixed", editor: "text" }),
    adminField({ key: "weight_unit", name: "重量单位", group_name: "售价与包装", source: "fixed", editor: "text" }),
    adminField({ key: "depth", name: "包装深度", group_name: "售价与包装", source: "fixed", editor: "decimal" }),
    adminField({ key: "weight", name: "重量", group_name: "售价与包装", source: "fixed", editor: "decimal" }),
    adminField({ key: "images", name: "商品图片", group_name: "媒体", source: "fixed", editor: "url_list", constraints: { required: false, collection: true } }),
    adminField({ key: "primary_image", name: "主图", group_name: "媒体", source: "fixed", editor: "text" }),
    adminField({ key: "attribute_10001", name: "材质", group_name: "外观", source: "attribute", editor: "single_select", attribute_id: 10001,
      options: [option(1, "棉"), option(2, "涤纶"), option(3, "羊毛")] }),
    adminField({ key: "attribute_10003", name: "帽檐形状", group_name: "外观", source: "attribute", editor: "single_select", attribute_id: 10003,
      constraints: { required: true, collection: false },
      options: [option(11, "弧形"), option(12, "平檐")] }),
    adminField({ key: "attribute_10004", name: "需要电池", group_name: "属性", source: "attribute", editor: "boolean", attribute_id: 10004 }),
    adminField({ key: "attribute_23171", name: "搜索标签", group_name: "属性", source: "attribute", editor: "text", attribute_id: 23171 }),
    adminField({ key: "attribute_10010", name: "配件名称", group_name: "配件", source: "attribute", editor: "text", attribute_id: 10010,
      complex_id: 1, complex_group_collection: true }),
    adminField({ key: "attribute_10011", name: "数量", group_name: "配件", source: "attribute", editor: "integer", attribute_id: 10011,
      complex_id: 1, complex_group_collection: true }),
  ],
  complex_groups: [
    { complex_id: 1, name: "配件", collection: true, field_keys: ["attribute_10010", "attribute_10011"] },
  ],
}

/** `SupplierOzonConfigData` 线形：p1 一行的线上配置，分区由它起稿。 */
const ADMIN_OZON_CONFIG = {
  productId: "p1",
  descriptionCategoryId: 17030122,
  typeId: 971000156,
  language: "zh_hans",
  values: {
    "fixed:vat": [{ kind: "text", value: "0" }],
    "fixed:dimension_unit": [{ kind: "text", value: "mm" }],
    "fixed:weight_unit": [{ kind: "text", value: "g" }],
    "fixed:depth": [{ kind: "integer", value: 200 }],
    "fixed:weight": [{ kind: "integer", value: 350 }],
    "attribute:4191:0": [{ kind: "text", value: "加厚针织圣诞帽，防风保暖。" }],
    "attribute:10001:0": [{ kind: "options", options: [{ optionId: 1, value: "棉" }] }],
    "attribute:10003:0": [{ kind: "options", options: [{ optionId: 11, value: "弧形" }] }],
    "attribute:10010:1": [{ kind: "text", value: "备用绒球" }],
  },
  fixedTags: [],
  promptText: "圣诞主图提示词：暖色背景、红金配色。",
  aiOutput: { title: true, description: true, tags: true },
  revision: 3,
  state: "valid",
  issues: [],
  usable: false,
  updatedAtMs: 0,
}

const ADMIN_TREE = [
  {
    description_category_id: 17030122,
    category_name: "家居饰品",
    type_id: 971000156,
    type_name: "装饰灯画",
    disabled: false,
    children: [],
  },
]

window.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : String(input)
  if (url.includes("/api/catalog/schema")) {
    return new Response(JSON.stringify({ data: ADMIN_SCHEMA }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (url.includes("/api/catalog/tree")) {
    return new Response(JSON.stringify({ data: { tree: ADMIN_TREE } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  if (url.includes("/ozon-config")) {
    return new Response(JSON.stringify({ data: { config: ADMIN_OZON_CONFIG } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }
  throw new Error(`Unexpected network request: ${url}`)
}
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

// 内联 SVG 封面 — 色块 + 品名水印，截图里有真实画面感。
function cover(hue: number, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},62%,72%)"/><stop offset="1" stop-color="hsl(${hue},52%,48%)"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/><circle cx="200" cy="130" r="56" fill="rgba(255,255,255,.35)"/><text x="200" y="252" font-size="26" text-anchor="middle" fill="rgba(255,255,255,.85)" font-family="sans-serif">${label}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

const NOW = Date.now()
const DAY = 86400000

// 规范六行说明种子：p1 进「分六行构建」模式，p4 作同类目复制源（反引号用字符码拼）。
const BT = String.fromCharCode(96)
const HAT_BRIEF = [
  "Товар: Вязаная шапка с принтом на внешней стороне; это НЕ кепка, НЕ берет и НЕ панама.",
  "Тема: Только принт, без манекена, рук и фона съёмки. Неясно → «Абстрактный принт».",
  "Заголовок: " + BT + 'Вязаная шапка с принтом "<тема>", для зимы' + BT,
  "Не пиши: «кепка», «берет», «панама».",
  "Описание: Вязаная шапка с принтом. Принт: <видимый принт>. Основные цвета: <цвет1> и <цвет2>. Подойдёт для зимних прогулок.",
  "Не выдумывай: состав пряжи, размер, вес, упаковку.",
].join("\n")
const SCARF_BRIEF = [
  "Товар: Тёплый шарф с принтом; это НЕ снуд и НЕ платок.",
  "Тема: Только принт, без манекена и фона съёмки. Неясно → «Абстрактный принт».",
  "Заголовок: " + BT + 'Шарф с принтом "<тема>", на зиму' + BT,
  "Не пиши: «снуд», «платок», «шаль».",
  "Описание: Тёплый шарф с принтом. Принт: <видимый принт>. Основные цвета: <цвет1> и <цвет2>. Подойдёт в подарок.",
  "Не выдумывай: состав ткани, длину, вес, упаковку.",
].join("\n")

// ---------- admin seed ----------

const db = (sourceId: string, name: string, icon = ""): SupplierDb => ({
  sourceId,
  name,
  country: "US",
  contact: "",
  internalNote: "",
  listed: true,
  icon,
  viewPrefs: {},
  rowCount: 0,
  publishedCount: 0,
  createdAtMs: NOW,
  updatedAtMs: NOW,
})

const propDefs: SupplierDbPropDef[] = [
  {
    propId: "prop-mat",
    sourceId: "src-1",
    name: "材质",
    type: "select",
    options: [
      { value: "cotton", label: "棉" },
      { value: "poly", label: "涤纶" },
    ],
    position: 1,
    sellerVisible: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    propId: "prop-pack",
    sourceId: "src-1",
    name: "整包装",
    type: "number",
    options: [],
    position: 2,
    sellerVisible: true,
    createdAtMs: 0,
    updatedAtMs: 0,
  },
]

// 16 个合法固定 tags（#+西里尔）——就绪口径按字段实时算，种子要真的就绪。
const READY_TAGS = Array.from({ length: 16 }, (_, i) => `#тег${i + 1}`)

const arow = (
  productId: string,
  partial: Partial<SupplierDbRow>,
): SupplierDbRow => ({
  productId,
  skuId: `${productId}-sku`,
  sourceId: "src-1",
  title: "货品",
  platformCode: "",
  descriptionCategoryId: 17030122,
  typeId: 971000156,
  published: false,
  archived: false,
  costCents: 800,
  shippingCostCents: null,
  platformPriceCents: null,
  suggestedRetailCents: 89000,
  suggestedOldPriceCents: 129000,
  leadTime: "2–3 天",
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
  promptName: "圣诞通用",
  promptFileName: "",
  promptContent: "圣诞主图提示词：暖色背景、红金配色。",
  fixedTags: READY_TAGS,
  description: "节日帽，保暖。",
  internalNote: "",
  props: {},
  readiness: {
    category: true,
    prompt: true,
    fixedTags: true,
    platformPrice: true,
    ozonConfig: true,
  },
  revision: 1,
  createdAtMs: NOW - 9 * DAY,
  updatedAtMs: NOW - 2 * DAY,
  createdBy: "tester",
  ...partial,
})

const adminDetail: SupplierDbDetail = {
  db: { ...db("src-1", "博雅达", "🧢"), rowCount: 5, publishedCount: 4 },
  propDefs,
  rows: [
    arow("p1", {
      variantGroup: "SDC", size: "成人款", promptName: "成人圣诞帽",
      title: "圣诞帽",
      platformCode: "SDC-001",
      published: true,
      platformPriceCents: 1600,
      gallery: [
        { url: cover(350, "圣诞帽"), w: 400, h: 300 },
        { url: cover(20, "圣诞帽 2"), w: 400, h: 300 },
      ],
      productVideos: [{ url: "https://img.example/v.mp4", coverUrl: cover(200, "视频"), durationMs: 12000 }],
      psd: [{ url: "https://cdn.invalid/hat.psd", name: "圣诞帽-主图.psd", bytes: 2400000 }],
      promptContent: HAT_BRIEF,
      internalNote: "首批走量款，别压价",
      props: { "prop-mat": "cotton", "prop-pack": 12 },
    }),
    arow("p2", {
      variantGroup: "SDC", size: "儿童款", promptName: "儿童圣诞帽",
      title: "收纳盒",
      platformCode: "SNH-002",
      published: true,
      platformPriceCents: 800,
      suggestedOldPriceCents: null,
      leadTime: "5 天",
      gallery: [{ url: cover(200, "收纳盒"), w: 400, h: 300 }],
      props: { "prop-mat": "poly" },
    }),
    arow("p3", {
      title: "LED 灯带",
      platformCode: "LED-003",
      published: true,
      platformPriceCents: 6000,
      leadTime: "当天",
      gallery: [{ url: cover(150, "LED 灯带"), w: 400, h: 300 }],
      fixedTags: ["节日"],
      internalNote: "",
      // S6：自动复核打成 needs_reconfiguration 的行——「待复核」筛选唯一命中的行。
      denial: "config_needs_reconfiguration",
      readiness: {
        category: true,
        prompt: true,
        fixedTags: false,
        platformPrice: true,
        ozonConfig: false,
      },
    }),
    arow("p4", {
      title: "节日围巾",
      platformCode: "SCF-004",
      published: true,
      platformPriceCents: 2200,
      gallery: [{ url: cover(10, "节日围巾"), w: 400, h: 300 }],
      promptContent: SCARF_BRIEF,
    }),
    arow("p5", {
      title: "雪花装饰灯",
      platformCode: "SNW-005",
      platformPriceCents: 3500,
      descriptionCategoryId: null,
      typeId: null,
      gallery: [{ url: cover(190, "雪花灯"), w: 400, h: 300 }],
      promptContent: "",
      fixedTags: [],
      // 无类目坐标 → 谓词归 catalog_missing；不进「待复核」，hover 显示目录缺失。
      denial: "catalog_missing",
      readiness: {
        category: false,
        prompt: false,
        fixedTags: false,
        platformPrice: true,
        ozonConfig: false,
      },
    }),
  ],
}

let rowSeq = 0
const adminClient: SupplierDbsClient = {
  supplierDbsList: async () => ({
    dbs: [
      adminDetail.db,
      { ...db("src-2", "杭州家居厂"), rowCount: 12, publishedCount: 9 },
      { ...db("src-3", "深圳数码厂"), rowCount: 8, publishedCount: 8 },
    ],
  }),
  supplierDbGet: async (sourceId) => {
    if (sourceId === "src-1") return adminDetail
    return { db: db(sourceId, "空库"), propDefs: [], rows: [] }
  },
  supplierDbCreate: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbUpdate: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbDelete: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbPropCreate: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbPropUpdate: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbPropDelete: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbRowCreate: async (sourceId, body) => {
    const row = arow(`new-${++rowSeq}`, { sourceId, title: body.title ?? "" })
    adminDetail.rows = [...adminDetail.rows, row]
    adminDetail.db.rowCount += 1
    return { row }
  },
  supplierDbRowUpdate: async (sourceId, productId, body) => {
    const prev = adminDetail.rows.find((r) => r.productId === productId)!
    const row = { ...prev, ...body, revision: prev.revision + 1 }
    adminDetail.rows = adminDetail.rows.map((r) =>
      r.productId === productId ? row : r,
    )
    return { row }
  },
  supplierDbRowDelete: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbRowAdjustPrice: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbRowPublish: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbRowUnpublish: async () => {
    throw { code: "noop", message: "visual stub" }
  },
  supplierDbUploadPresign: async () => {
    throw { code: "noop", message: "visual stub" }
  },
}

// ---------- seller gallery seed ----------

const grow = (partial: Partial<SellerSupplierDbRowData>): SellerSupplierDbRowData => ({
  productId: "prd_x",
  sourceId: "src_1",
  listable: true,
  title: "货品",
  platformCode: "P000",
  descriptionCategoryId: 17030122,
  typeId: 971000156,
  platformPriceCents: 1600,
  suggestedRetailCents: 89000,
  suggestedOldPriceCents: null,
  leadTime: "2–3 天",
  gallery: [],
  productVideos: [],
  fixedTags: [],
  description: "",
  props: {},
  listedAtMs: NOW - 5 * DAY,
  ...partial,
})

const gCatalog: SellerSupplierDbCatalogData = {
  dbs: [
    { sourceId: "src_1", name: "博雅达", country: "US", icon: "🧢" },
    { sourceId: "src_2", name: "杭州家居厂", country: "CN", icon: "" },
  ],
  propDefs: [
    {
      propId: "pp_1",
      sourceId: "src_1",
      name: "材质",
      type: "select",
      options: [{ value: "cotton", label: "棉" }, { value: "poly", label: "涤纶" }],
      position: 1,
      sellerVisible: true,
      createdAtMs: 0,
      updatedAtMs: 0,
    },
  ],
  rows: [
    grow({ productId: "g1", variantGroup: "SDC", size: "成人款", title: "圣诞帽", platformCode: "SDC-001", platformPriceCents: 1600, suggestedOldPriceCents: 129000, gallery: [{ url: cover(350, "圣诞帽"), w: 400, h: 300 }], fixedTags: ["节日", "红色"], props: { pp_1: "cotton" } }),
    grow({ productId: "g1-child", variantGroup: "SDC", size: "儿童款", title: "圣诞帽", platformCode: "SDC-001-C", platformPriceCents: 1200, gallery: [{ url: cover(350, "儿童圣诞帽"), w: 400, h: 300 }], props: { pp_1: "poly" } }),
    grow({ productId: "g2", title: "收纳盒", platformCode: "SNH-002", platformPriceCents: 800, suggestedRetailCents: 45000, gallery: [{ url: cover(200, "收纳盒"), w: 400, h: 300 }], leadTime: "5 天", fixedTags: ["家居"], listedAtMs: NOW - 40 * DAY }),
    grow({ productId: "g3", title: "LED 灯带", platformCode: "LED-003", platformPriceCents: 6000, suggestedRetailCents: 120000, gallery: [{ url: cover(150, "LED 灯带"), w: 400, h: 300 }], leadTime: "当天", fixedTags: ["节日", "灯"], listedAtMs: NOW - 1 * DAY }),
    grow({ productId: "g4", title: "节日围巾", platformCode: "SCF-004", platformPriceCents: 2200, gallery: [{ url: cover(10, "节日围巾"), w: 400, h: 300 }], listedAtMs: NOW - 2 * DAY }),
    grow({ productId: "g5", title: "雪花装饰灯", platformCode: "SNW-005", platformPriceCents: 3500, gallery: [{ url: cover(190, "雪花灯"), w: 400, h: 300 }], fixedTags: ["装饰"], listedAtMs: NOW - 3 * DAY }),
    grow({ productId: "g6", title: "玻璃挂饰", platformCode: "ORN-006", platformPriceCents: 1200, gallery: [{ url: cover(45, "玻璃挂饰"), w: 400, h: 300 }], listedAtMs: NOW - 8 * DAY }),
    grow({ productId: "g7", title: "针织手套", platformCode: "GLV-007", platformPriceCents: 950, gallery: [{ url: cover(30, "针织手套"), w: 400, h: 300 }], fixedTags: ["冬季"], listedAtMs: NOW - 12 * DAY }),
    grow({ productId: "g8", title: "蜡烛礼盒", platformCode: "CND-008", platformPriceCents: 4800, suggestedRetailCents: 99000, suggestedOldPriceCents: 139000, gallery: [{ url: cover(25, "蜡烛礼盒"), w: 400, h: 300 }], listedAtMs: NOW - 15 * DAY }),
    // S5 前置门 fixture：平台待处理（配置复核中）与已停售两类的徽标/置灰/详情页禁用。
    grow({ productId: "g9", title: "浮雕挂画", platformCode: "RLF-009", platformPriceCents: 3900, suggestedRetailCents: 129000, gallery: [{ url: cover(280, "浮雕挂画"), w: 400, h: 300 }], fixedTags: ["装饰"], listedAtMs: NOW - 4 * DAY, listable: false, denial: "catalog_digest_mismatch" }),
    grow({ productId: "g10", title: "旧款搪瓷杯", platformCode: "ENM-010", platformPriceCents: 1500, gallery: [{ url: cover(60, "搪瓷杯"), w: 400, h: 300 }], listedAtMs: NOW - 60 * DAY, listable: false, denial: "product_archived" }),
  ],
}

const gTree: CategoryTreeNodeView[] = [
  {
    description_category_id: 1,
    category_name: "服饰",
    type_id: 0,
    type_name: "",
    disabled: false,
    children: [
      { description_category_id: 17030122, category_name: "节日用品", type_id: 0, type_name: "", disabled: false, children: [] },
    ],
  },
]

function GalleryHost() {
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  // ?product=g9 → 开局即该行的详情页（S5 前置门截图）。
  const [detail, setDetail] = useState<SellerSupplierDbRowData | undefined>(() =>
    gCatalog.rows.find((row) => row.productId === params.get("product")),
  )
  return (
    <>
      <Toaster />
      <SupplierDbsGallery
        catalog={gCatalog}
        filters={filters}
        onFiltersChange={setFilters}
        categoryTree={gTree}
        detail={detail}
        onOpenDetail={setDetail}
        onOpenListing={(products) => { fixture.dataset.listingProducts = JSON.stringify(products) }}
        onOpenShipping={() => {}}
        onRefresh={() => {}}
        picking={params.has("pick")}
      />
    </>
  )
}

// S6 类目页截图：坐标时效汇总徽标（stale/expired/missing 由后端计数）。
const CATEGORY_CONFIG: CatalogFetchConfigData = {
  enabled: true,
  schedule_mode: "fixed",
  at_minute: 120,
  window_start_minute: 120,
  window_end_minute: 360,
  utc_offset_minutes: 480,
  language: "zh_hans",
  keys: [
    { client_id: "1234567", api_key_configured: true, disabled: false },
    { client_id: "7654321", api_key_configured: true, disabled: false },
  ],
  next_run_at_ms: NOW + 10 * 3_600_000,
  last_run_at_ms: NOW - 2 * 3_600_000,
  last_status: "ok",
  last_error: "",
  last_duration_ms: 42_000,
  last_key_client_id: "1234567",
  last_key_attempts: 1,
  last_root_nodes: 61,
  failure_streak: 0,
  running: false,
  coordinate_freshness: { total: 4, fresh: 2, stale: 1, expired: 1, missing: 0 },
  updated_at_ms: NOW - 3_600_000,
  wb_credential: { configured: false, credential_revision: 0 },
}

async function main() {
  const root = createRoot(fixture)
  if (params.get("view") === "gallery") {
    // ?queue=g1,g9 预置清单条目（可含暂不可上架行），?pick=1 摊开浮窗，
    // ?submit=1 直接走导出提交缝——不等 DOM 点击时序，跳过报数的 toast
    // 在 4s 生命周期内必被截到。
    const queueIds = (params.get("queue") ?? "").split(",").filter(Boolean)
    const queueRows = queueIds
      .map((id) => gCatalog.rows.find((item) => item.productId === id))
      .filter((row): row is SellerSupplierDbRowData => Boolean(row))
    if (queueIds.length) {
      clearQueue()
      for (const row of queueRows) {
        if (!isQueued(row.productId)) toggleQueued(row)
      }
    }
    flushSync(() => root.render(<GalleryHost />))
    await frame()
    await frame()
    if (params.has("submit")) {
      submitQueueImport(queueRows, (products) => {
        fixture.dataset.listingProducts = JSON.stringify(products)
      })
      await frame()
      await frame()
    }
    return
  }
  if (params.get("view") === "categories") {
    const { PlatformCategoryFetchScreen } = await import(
      "@/features/platform/category-fetch"
    )
    flushSync(() =>
      root.render(<PlatformCategoryFetchScreen initialConfig={CATEGORY_CONFIG} />),
    )
    return
  }
  const store = createSupplierDbsStore(adminClient)
  flushSync(() =>
    root.render(
      <>
        <Toaster />
        <SupplierDbsScreen role="admin" store={store} />
      </>,
    ),
  )
  // 注入式 store 不走 owned 的挂载拉取——这里手动拉。
  await store.loadList()
  await frame()
  await frame()
  // ?open=<sourceId> 由屏读地址打开库页；详情是自己的一次读取，等表格骨架落地。
  // 没有 ?open 时屏自动回落首库——详情同样等它落，截图不需要显式 open。
  for (let i = 0; i < 50; i++) {
    if (fixture.querySelector("[data-supplier-db-table]")) break
    await new Promise<void>((resolve) => setTimeout(resolve, 100))
  }
  // ?tab=<stat|status> → 选中行筛选：all/published/incomplete 走统计页签，
  // needs_review（S6 待复核）在状态下拉里。
  const tab = params.get("tab")
  if (tab === "needs_review") {
    flushSync(() =>
      fixture.querySelector<HTMLElement>('[data-filter="status"]')?.click(),
    )
    await frame()
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
      .find((el) => el.textContent?.trim() === "待复核")
    flushSync(() => option?.click())
    await frame()
    await frame()
  } else if (tab) {
    flushSync(() =>
      fixture.querySelector<HTMLElement>(`[data-stat="${tab}"]`)?.click(),
    )
    await frame()
    await frame()
  }
  // ?panel=1 → 自动打开首行详情，供第三栏截图；?row=p5 指定行。
  // 行点击是开面板的主路径（「更多 → 打开」是等价入口）。
  if (params.get("panel")) {
    const rowEl = fixture.querySelector<HTMLElement>(
      `tr[data-supplier-db-row="${params.get("row") ?? "p1"}"]`,
    )
    flushSync(() => rowEl?.click())
    await frame()
    // ?pane=<info|prompt|defaults> -> 打开行编辑器后切到对应页签再截图。
    const pane = params.get("pane")
    if (pane) {
      const paneTab = [...fixture.querySelectorAll<HTMLElement>("[data-row-tab]")].find(
        (el) => el.dataset.rowTab === pane,
      )
      flushSync(() => paneTab?.click())
      await frame()
      await frame()
    }
  }
  // ?defaults=1 → 等「默认字段」分区落地（表单或提示态）后滚进可视区。
  if (params.get("defaults")) {
    for (let i = 0; i < 40; i++) {
      const node = fixture.querySelector<HTMLElement>(
        "[data-supplier-row-defaults], [data-supplier-row-defaults-empty], [data-supplier-row-defaults-error]",
      )
      if (node?.querySelector("[data-category-fields-form]") || node?.hasAttribute("data-supplier-row-defaults-empty") || node?.hasAttribute("data-supplier-row-defaults-error")) {
        node.scrollIntoView({ block: "start" })
        break
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100))
    }
    await frame()
  }
}

void main()

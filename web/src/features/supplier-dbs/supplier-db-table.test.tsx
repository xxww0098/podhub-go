import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  SupplierDb,
  SupplierDbDetail,
  SupplierDbPropDef,
  SupplierDbRow,
} from "@/bindings/http-supplier-dbs"

import { SupplierProductsView } from "./supplier-db-table"
import { pageList, rowMatchesStatus } from "./supplier-db-filters"
import { formatCnyCents } from "./supplier-prop-editors"
import { missingReadiness } from "./supplier-readiness"
import type { SupplierDbsStore } from "./supplier-dbs-store"

const NOW = Date.now()

function db(over: Partial<SupplierDb> = {}): SupplierDb {
  return {
    sourceId: "src-1",
    name: "美国3C厂",
    country: "US",
    contact: "",
    internalNote: "",
    listed: true,
    icon: "🏭",
    viewPrefs: {},
    rowCount: 0,
    publishedCount: 0,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  }
}

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
    gallery: [{ url: "https://cdn.invalid/a.png", w: 100, h: 100 }],
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

function propDef(over: Partial<SupplierDbPropDef> = {}): SupplierDbPropDef {
  return {
    propId: "prop-x",
    sourceId: "src-1",
    name: "材质",
    type: "text",
    options: [],
    position: 0,
    sellerVisible: true,
    createdAtMs: NOW,
    updatedAtMs: NOW,
    ...over,
  }
}

/** A store that refuses every write — these tests only assert the markup. */
function stubStore(): SupplierDbsStore {
  const fail = async () => ({ ok: false as const, issues: [{ field: "", message: "stub" }] })
  return {
    reset: () => {},
    getState: () => ({ status: "ready", dbs: [], details: {}, pendingRows: [] }),
    subscribe: () => () => {},
    loadList: async () => {},
    loadDetail: async () => {},
    createDb: fail,
    updateDb: fail,
    deleteDb: fail,
    saveProp: fail,
    createProp: fail,
    updateProp: fail,
    insertPropAt: fail,
    reorderProps: fail,
    deleteProp: fail,
    createRow: fail,
    createVariant: fail,
    syncProductOzon: fail,
    updateRow: fail,
    patchCell: fail,
    duplicateRow: fail,
    archiveRow: fail,
    deleteRow: fail,
    publishRow: fail,
    unpublishRow: fail,
    adjustPrice: fail,
    presignUpload: fail,
  }
}

function renderDetail(detail: SupplierDbDetail) {
  return renderToStaticMarkup(
    <SupplierProductsView
      store={stubStore()}
      dbs={[detail.db]}
      details={[detail]}
      onManageFactories={() => {}}
      loadCategoryTree={async () => []}
    />,
  )
}

test("库页摘要列展示商品、类目、品牌、价格和更新时间", () => {
  const html = renderDetail({
    db: db({ rowCount: 1 }),
    propDefs: [propDef({ name: "尺码" })],
    rows: [row("p1")],
  })
  for (const label of ["商品", "商品库", "规格", "上架就绪", "平台供货价", "发布状态", "操作"]) {
    assert.ok(html.includes(`>${label}<`), `missing column ${label}`)
  }
  // 自定义属性不再是表格列——定义管理收在「库设置 → 自定义属性」。
  assert.doesNotMatch(html, /data-supplier-db-prop="prop-x"/)
  assert.doesNotMatch(html, /工厂配置|新增工厂/)
  assert.match(html, /美国3C厂/)
  assert.equal(html.match(/<table\b/g)?.length, 1)
  assert.doesNotMatch(html, /role="switch"|data-panel=/)
})

test("库摘要按商品分组计数，独立展示规格数", () => {
  const html = renderDetail({ db: db({ rowCount: 99 }), propDefs: [], rows: [
    row("p1", { variantGroup: "same" }), row("p2", { variantGroup: "same" }), row("p3"), row("p4", { archived: true }),
  ] })
  assert.match(html, /共 2 款商品，3 个规格/)
  assert.equal(html.match(/data-supplier-product=/g)?.length, 2)
})

test("行渲染商品摘要和内部成本输入：缩略图、编号、状态徽标、币种", () => {
  const html = renderDetail({
    db: db({ rowCount: 1, publishedCount: 1 }),
    propDefs: [],
    rows: [
      row("p1", {
        title: "圣诞帽",
        brand: "星辰服饰",
        platformCode: "P001",
        published: true,
        readiness: {
          category: true,
          prompt: true,
          fixedTags: true,
          platformPrice: true,
          ozonConfig: true,
        },
        // computeReadiness 从字段实时推导，齐备才亮 ●就绪。
        descriptionCategoryId: 11,
        typeId: 101,
        promptContent: "识别红白配色",
        fixedTags: Array.from({ length: 16 }, (_, i) => `#тег${i + 1}`),
        platformPriceCents: 1600,
        costCents: 800,
        suggestedRetailCents: 25000,
        gallery: [{ url: "https://cdn.invalid/a.png", w: 100, h: 100 }],
      }),
      row("p2", { title: "归档行", archived: true }),
      row("p3", { title: "时间未知", updatedAtMs: 0 }),
    ],
  })
  assert.match(html, /圣诞帽/)
  assert.match(html, /P001/)
  assert.match(html, /类目 11 \/ 类型 101/)
  assert.match(html, /¥16\.00/)
  assert.match(html, /已发布/)
  assert.match(html, /<img src="https:\/\/cdn\.invalid\/a\.png"/)
  assert.doesNotMatch(html, /aria-label="成本价/)
  // 归档行不进商品表
  assert.doesNotMatch(html, /归档行/)
  // 公开商品字段仍在行面板编辑。
  assert.doesNotMatch(html, /data-cell-display/)
  assert.match(html, /aria-label="编辑规格 P001"/)
  assert.match(html, /data-supplier-db-open="p1"/)
  assert.doesNotMatch(html, /role="alert"/)
})

test("统计页签按非归档口径计数：全部 / 已上架 / 待完善", () => {
  const html = renderDetail({
    db: db({ rowCount: 4 }),
    propDefs: [],
    rows: [
      // 已上架且就绪——不进待完善（就绪口径按字段实时算）。
      row("p1", {
        published: true,
        descriptionCategoryId: 11,
        typeId: 101,
        promptContent: "x",
        fixedTags: Array.from({ length: 16 }, (_, i) => `#тег${i + 1}`),
        platformPriceCents: 100,
        readiness: {
          category: true,
          prompt: true,
          fixedTags: true,
          platformPrice: true,
          ozonConfig: true,
        },
      }),
      row("p2"),
      row("p3"),
      row("p4", { archived: true }),
    ],
  })
  assert.match(html, /data-stat="all"[\s\S]*?>3</)
  assert.match(html, /data-stat="published"[\s\S]*?>1</)
  assert.match(html, /data-stat="incomplete"[\s\S]*?>2</)
  // 默认全部商品为激活预设
  assert.match(
    html,
    /data-stat="all"[^>]*aria-selected="true"|aria-selected="true"[^>]*data-stat="all"/,
  )
})

test("筛选行：搜索、类目和更多筛选按顺序排列", () => {
  const html = renderDetail({
    db: db({ rowCount: 2 }),
    propDefs: [],
    rows: [row("p1"), row("p2")],
  })
  const filterLabels = ["搜索商品", "类目筛选", "更多筛选"]
  let previousIndex = -1
  for (const label of filterLabels) {
    const index = html.indexOf(`aria-label="${label}"`)
    assert.ok(index > previousIndex, `${label} 应按顺序直接显示在筛选栏中`)
    previousIndex = index
  }
  assert.doesNotMatch(html, /aria-label="状态筛选"|aria-label="上架状态筛选"/)
  assert.match(
    html,
    /aria-label="每页条数"[\s\S]*?data-slot="select-value"[^>]*>10 条\/页</,
  )
  assert.match(html, /aria-label="新增商品"/)
  assert.doesNotMatch(html, /data-bulk-bar=/)
  assert.match(html, /共 2 款商品，2 个规格/)
})

test("空库仍有完整表头与分页脚，行区给引导文案", () => {
  const html = renderDetail({ db: db({ name: "" }), propDefs: [], rows: [] })
  assert.match(html, /data-supplier-db-table=""/)
  assert.match(html, />商品</)
  assert.match(html, /还没有商品/)
  assert.match(html, /从商品库创建一个规格，再补齐资料、定价并发布。/)
  assert.match(html, /共 0 款商品，0 个规格/)
  assert.match(html, /aria-label="每页条数"/)
  assert.doesNotMatch(html, /role="alert"/)
})

test("金额格式化统一人民币（¥），空值读作 —", () => {
  assert.equal(formatCnyCents(800), "¥8.00")
  assert.equal(formatCnyCents(null), "—")
  assert.deepEqual(
    // missingReadiness 按字段实时算（类目坐标 + 平台价齐 → 缺识图事实/固定 tags）。
    missingReadiness(row("p1", {
      descriptionCategoryId: 11,
      typeId: 101,
      platformPriceCents: 1600,
    })),
    ["识图事实", "固定 tags", "Ozon 配置未校验"],
  )
})

test("「待复核」留在状态筛选里，只认 config_needs_reconfiguration 行", () => {
  // 谓词口径：只有 denial === config_needs_reconfiguration 的行进该筛选——
  // 其它 denial（含销售态三分支与其余配置类码）与可上架行都不进。
  assert.equal(
    rowMatchesStatus(
      row("p1", { denial: "config_needs_reconfiguration" }),
      "needs_review",
    ),
    true,
  )
  for (const denial of [
    "source_not_listed",
    "product_archived",
    "sku_not_published",
    "catalog_missing",
    "catalog_expired",
    "catalog_digest_mismatch",
  ] as const) {
    assert.equal(
      rowMatchesStatus(row("p2", { denial }), "needs_review"),
      false,
      denial,
    )
  }
  assert.equal(rowMatchesStatus(row("p3"), "needs_review"), false)
  assert.equal(rowMatchesStatus(row("p4", { denial: null }), "needs_review"), false)

  // ready / incomplete 是同一把缺项刀的两个方向
  const ready = row("p5", {
    descriptionCategoryId: 11,
    typeId: 101,
    promptContent: "x",
    fixedTags: Array.from({ length: 16 }, (_, i) => `#тег${i + 1}`),
    platformPriceCents: 100,
    readiness: {
      category: true,
      prompt: true,
      fixedTags: true,
      platformPrice: true,
      ozonConfig: true,
    },
  })
  assert.equal(rowMatchesStatus(ready, "ready"), true)
  assert.equal(rowMatchesStatus(ready, "incomplete"), false)
  assert.equal(rowMatchesStatus(row("p6"), "incomplete"), true)
})

test("分页窗口：≤7 页全展示，更多页两端 + 当前页邻位", () => {
  assert.deepEqual(pageList(1, 3), [1, 2, 3])
  assert.deepEqual(pageList(7, 7), [1, 2, 3, 4, 5, 6, 7])
  assert.deepEqual(pageList(5, 20), [1, "…", 4, 5, 6, "…", 20])
  assert.deepEqual(pageList(1, 20), [1, 2, "…", 20])
  assert.deepEqual(pageList(20, 20), [1, "…", 19, 20])
})

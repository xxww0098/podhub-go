import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  SupplierDb,
  SupplierDbDetail,
  SupplierDbPropDef,
  SupplierDbRow,
} from "@/bindings/http-supplier-dbs"

import { SupplierDbDetailView } from "./supplier-db-table"
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
    <SupplierDbDetailView
      store={stubStore()}
      detail={detail}
      onExit={() => {}}
      onEditDb={() => {}}
      onOpenAccounts={() => {}}
      loadCategoryTree={async () => []}
    />,
  )
}

test("库页摘要列：商品/状态/成本价/平台价/操作，类目保留在商品上下文", () => {
  const html = renderDetail({
    db: db({ rowCount: 1 }),
    propDefs: [propDef({ name: "尺码" })],
    rows: [row("p1")],
  })
  for (const label of ["商品", "状态", "成本价", "平台价", "操作"]) {
    assert.ok(html.includes(`>${label}<`), `missing column ${label}`)
  }
  // 自定义属性不再是表格列——定义管理收在「库设置 → 自定义属性」。
  assert.doesNotMatch(html, /data-supplier-db-prop="prop-x"/)
  assert.match(html, /库设置/)
  assert.match(html, /美国3C厂/)
  assert.match(html, /美国/)
  assert.match(html, /id="supplier-db-header-listed"/)
  assert.match(html, />公开</)
  assert.doesNotMatch(html, /●公开|○未公开/)
})

test("库页公开开关跟随 listed", () => {
  const on = renderDetail({ db: db({ listed: true }), propDefs: [], rows: [] })
  const off = renderDetail({ db: db({ listed: false }), propDefs: [], rows: [] })
  // Base UI 把 id 放在隐藏 input 上，开关本体是 role=switch。
  const listedSwitch =
    /role="switch"[^>]*title="关闭后整库商品对卖家隐藏"/
  assert.match(on, listedSwitch)
  assert.match(on, /role="switch"[^>]*aria-checked="true"/)
  assert.match(off, /role="switch"[^>]*aria-checked="false"/)
})

test("行渲染只读摘要：缩略图、编号、状态徽标、币种", () => {
  const html = renderDetail({
    db: db({ rowCount: 1, publishedCount: 1 }),
    propDefs: [],
    rows: [
      row("p1", {
        title: "圣诞帽",
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
    ],
  })
  assert.match(html, /圣诞帽/)
  assert.match(html, /P001/)
  assert.match(html, /¥8\.00/)
  assert.match(html, /¥16\.00/)
  assert.match(html, /已上架/)
  assert.match(html, /●就绪/)
  assert.match(html, /<img src="https:\/\/cdn\.invalid\/a\.png"/)
  // 归档行不进商品表
  assert.doesNotMatch(html, /归档行/)
  // 行内不做编辑——表格是只读摘要，编辑全在行面板
  assert.doesNotMatch(html, /data-cell-display/)
  assert.match(html, /aria-label="行操作 圣诞帽"/)
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

test("筛选行：搜索 + 状态 + 类目 + 上架状态三个下拉", () => {
  const html = renderDetail({
    db: db({ rowCount: 2 }),
    propDefs: [],
    rows: [row("p1"), row("p2")],
  })
  assert.match(html, /aria-label="搜索商品"/)
  assert.match(html, /data-filter="status"/)
  assert.match(html, /data-filter="category"/)
  assert.match(html, /data-filter="publish"/)
  // 收起态显示中文标签，不回落成 all / incomplete
  assert.match(
    html,
    /data-filter="status"[\s\S]*?data-slot="select-value"[^>]*>全部状态</,
  )
  assert.match(
    html,
    /data-filter="category"[\s\S]*?data-slot="select-value"[^>]*>全部类目</,
  )
  assert.match(
    html,
    /data-filter="publish"[\s\S]*?data-slot="select-value"[^>]*>全部上架状态</,
  )
  assert.match(
    html,
    /aria-label="每页条数"[\s\S]*?data-slot="select-value"[^>]*>10 条\/页</,
  )
  assert.match(html, /新建商品/)
  assert.doesNotMatch(html, /data-bulk-bar=/)
  assert.match(html, /共 2 条/)
})

test("空库仍有完整表头与分页脚，行区给引导文案", () => {
  const html = renderDetail({ db: db({ name: "" }), propDefs: [], rows: [] })
  assert.match(html, /data-supplier-db-table=""/)
  assert.match(html, />商品</)
  assert.match(html, /库还没有商品——「＋ 新建商品」建行/)
  assert.match(html, /共 0 条/)
  assert.match(html, /aria-label="每页条数"/)
  assert.doesNotMatch(html, /role="alert"/)
})

test("金额格式化统一人民币（¥），空值读作 —", () => {
  assert.equal(formatCnyCents(800), "¥8.00")
  assert.equal(formatCnyCents(null), "—")
  assert.deepEqual(
    // missingReadiness 按字段实时算（类目坐标 + 平台价齐 → 缺提示词/固定 tags）。
    missingReadiness(row("p1", {
      descriptionCategoryId: 11,
      typeId: 101,
      platformPriceCents: 1600,
    })),
    ["提示词", "固定 tags", "Ozon 配置未校验"],
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

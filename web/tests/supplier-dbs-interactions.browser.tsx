// Dev-only 平台货源 interaction checks. Every supplierDbs call is mocked
// in-memory; fetch is a tripwire. Open supplier-dbs-interactions.html and press
// 运行检查.
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type {
  SupplierDb,
  SupplierDbDetail,
  SupplierDbPropDef,
  SupplierDbRow,
  UpsertSupplierDbRequest,
} from "@/bindings/http-supplier-dbs"
import { Toaster } from "@/components/ui/toast"
import { SupplierDbsScreen } from "@/features/supplier-dbs/supplier-dbs-screen"
import {
  createSupplierDbsStore,
  type SupplierDbsClient,
} from "@/features/supplier-dbs/supplier-dbs-store"
import { drawerDraftChecks } from "./supplier-dbs-drawer-checks"
import { supplierOzonConfigIO, type SupplierOzonConfigData } from "@/features/supplier-dbs/supplier-ozon-config"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const unexpectedRequests: string[] = []
window.fetch = async (input) => {
  unexpectedRequests.push(String(input))
  throw new Error(`Unexpected network request: ${input}`)
}
// 类目树走 localStorage 缓存——先种一棵最小的树，免得库页每个挂载都
// 打 GET /api/catalog/tree 撞 fetch tripwire。
window.localStorage.setItem(
  "podhub.workflow.category-tree.v1",
  JSON.stringify({
    language: "zh_hans",
    fetchedAt: new Date().toISOString(),
    tree: [
      {
        description_category_id: 17030122,
        category_name: "节日用品",
        type_id: 0,
        type_name: "",
        disabled: false,
        children: [],
      },
    ],
  }),
)
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  await frame()
  await frame()
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
function byText(text: string, root: ParentNode = document): HTMLElement {
  const xs = [...root.querySelectorAll<HTMLElement>("button")].filter(
    (x) => x.textContent?.trim() === text && !x.closest('[hidden], [inert], [aria-hidden="true"]'),
  )
  check(xs.length >= 1, `Expected button '${text}', got ${xs.length}`)
  return xs[0]!
}
async function click(el: HTMLElement) {
  check(!el.hasAttribute("disabled"), "Cannot click disabled control")
  flushSync(() => el.click())
  await settle()
}
/** pickFiles 临时挂载 hidden <input type=file>；测里拦 click，把文件灌进去。 */
function stubFilePicker(files: File[]) {
  const proto = HTMLInputElement.prototype
  const original = proto.click
  proto.click = function (this: HTMLInputElement) {
    if (this.type === "file") {
      const data = new DataTransfer()
      for (const file of files) data.items.add(file)
      Object.defineProperty(this, "files", { configurable: true, value: data.files })
      this.dispatchEvent(new Event("change"))
      return
    }
    original.call(this)
  }
  return () => {
    proto.click = original
  }
}
function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value)
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })))
}
async function pressEscape() {
  flushSync(() => {
    ;(document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    )
  })
  await settle()
}
async function pressKey(el: Element, key: string, shiftKey = false) {
  flushSync(() => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }),
    )
  })
  await settle()
}

// --- in-memory Cloud stand-in --------------------------------------------------

const NOW = Date.now()
const supplierDb = (sourceId: string, name: string): SupplierDb => ({
  sourceId,
  name,
  country: "CN",
  contact: "",
  internalNote: "",
  listed: true,
  icon: "🏭",
  viewPrefs: {},
  rowCount: 0,
  publishedCount: 0,
  createdAtMs: NOW,
  updatedAtMs: NOW,
})
const supplierRow = (productId: string, sourceId: string): SupplierDbRow => ({
  productId,
  skuId: `${productId}-sku`,
  sourceId,
  title: "",
  platformCode: "",
  descriptionCategoryId: null,
  typeId: null,
  published: false,
  archived: false,
  readiness: { category: false, prompt: false, fixedTags: false, platformPrice: false, ozonConfig: false },
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
})

function memoryClient(seed: SupplierDbDetail[]): SupplierDbsClient {
  const dbs = seed.map((detail) => ({ ...detail.db }))
  const details = new Map(
    seed.map((detail) => [
      detail.db.sourceId,
      {
        db: { ...detail.db },
        propDefs: [...detail.propDefs] as SupplierDbPropDef[],
        rows: [...detail.rows],
      },
    ]),
  )
  let seq = 0
  return {
    supplierDbsList: async () => ({ dbs: [...dbs] }),
    supplierDbGet: async (sourceId) => {
      const detail = details.get(sourceId)
      if (!detail) throw { code: "not_found", message: "库不存在" }
      return detail
    },
    supplierDbCreate: async (body: UpsertSupplierDbRequest) => {
      const next = supplierDb(`src-new-${++seq}`, body.name)
      dbs.push(next)
      details.set(next.sourceId, { db: next, propDefs: [], rows: [] })
      return { db: next }
    },
    supplierDbUpdate: async (sourceId, body) => {
      const detail = details.get(sourceId)!
      detail.db = { ...detail.db, ...body }
      const listDb = dbs.find((item) => item.sourceId === sourceId)
      if (listDb) Object.assign(listDb, detail.db)
      return { db: detail.db }
    },
    supplierDbDelete: async (sourceId) => {
      details.delete(sourceId)
      const index = dbs.findIndex((item) => item.sourceId === sourceId)
      if (index >= 0) dbs.splice(index, 1)
      return { sourceId }
    },
    supplierDbPropCreate: async (sourceId, body) => {
      const detail = details.get(sourceId)!
      const prop: SupplierDbPropDef = {
        propId: `prop-new-${++seq}`,
        sourceId,
        name: body.name,
        type: body.type,
        options: body.options,
        position: body.position ?? detail.propDefs.length,
        sellerVisible: body.sellerVisible,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      }
      detail.propDefs = [...detail.propDefs, prop]
      return { prop }
    },
    supplierDbPropUpdate: async (sourceId, propId, body) => {
      const detail = details.get(sourceId)!
      const prev = detail.propDefs.find((item) => item.propId === propId)
      if (!prev) throw { code: "not_found", message: "属性不存在" }
      const next = {
        ...prev,
        ...body,
        propId,
        position: body.position ?? prev.position,
      }
      detail.propDefs = detail.propDefs.map((item) =>
        item.propId === propId ? next : item,
      )
      return { prop: next }
    },
    supplierDbPropDelete: async (sourceId, propId) => {
      const detail = details.get(sourceId)!
      const rowsWithValues = detail.rows.filter(
        (item) => item.props[propId] !== undefined,
      ).length
      detail.propDefs = detail.propDefs.filter((item) => item.propId !== propId)
      return { propId, rowsWithValues }
    },
    supplierDbRowCreate: async (sourceId, body) => {
      const detail = details.get(sourceId)!
      const next = { ...supplierRow(`prod-new-${++seq}`, sourceId), title: body.title }
      detail.rows.push(next)
      detail.db = { ...detail.db, rowCount: detail.rows.length }
      return { row: next }
    },
    supplierDbRowUpdate: async (sourceId, productId, body) => {
      const detail = details.get(sourceId)!
      const prev = detail.rows.find((item) => item.productId === productId)!
      const next = {
        ...prev,
        ...body,
        archived:
          (body as { archived?: boolean }).archived ?? prev.archived,
        revision: prev.revision + 1,
      }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowDelete: async (sourceId, productId) => {
      const detail = details.get(sourceId)!
      detail.rows = detail.rows.filter((item) => item.productId !== productId)
      detail.db = { ...detail.db, rowCount: detail.rows.length }
      return { productId }
    },
    supplierDbRowAdjustPrice: async (sourceId, productId, body) => {
      const detail = details.get(sourceId)!
      const prev = detail.rows.find((item) => item.productId === productId)!
      const next = { ...prev, platformPriceCents: body.priceCents }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowPublish: async (sourceId, productId) => {
      const detail = details.get(sourceId)!
      const prev = detail.rows.find((item) => item.productId === productId)!
      const next = { ...prev, published: true }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbRowUnpublish: async (sourceId, productId) => {
      const detail = details.get(sourceId)!
      const prev = detail.rows.find((item) => item.productId === productId)!
      const next = { ...prev, published: false }
      detail.rows = detail.rows.map((item) =>
        item.productId === productId ? next : item,
      )
      return { row: next }
    },
    supplierDbUploadPresign: async () => {
      throw new Error("not implemented")
    },
  }
}

/**
 * 打开态是地址态（`?open=`），所以每次挂载都借一段真实地址：侧栏卡片点击写
 * 的就是它，刷新读的也是它。挂载前后的地址收回来，检查之间不互相串联。
 */
const checkPageHref = window.location.pathname + window.location.search
function atScreen(search = "?screen=supplier-dbs") {
  window.history.replaceState(null, "", window.location.pathname + search)
}

async function mounted(
  seed: SupplierDbDetail[],
  action: (root: Root, store: ReturnType<typeof createSupplierDbsStore>) => Promise<void>,
  search = "?screen=supplier-dbs",
) {
  const store = createSupplierDbsStore(memoryClient(seed))
  const previousIO = { ...supplierOzonConfigIO }
  const configs = new Map<string, SupplierOzonConfigData>()
  supplierOzonConfigIO.get = async (sourceId, productId) => configs.get(`${sourceId}:${productId}`)
  supplierOzonConfigIO.put = async (sourceId, productId, body) => {
    const key = `${sourceId}:${productId}`
    const previous = configs.get(key)
    if (body.expected_revision !== (previous?.revision ?? 0)) throw { code: "cloud_conflict" }
    const next: SupplierOzonConfigData = {
      ...body, product_id: productId, revision: body.expected_revision + 1,
      state: "valid", issues: [], usable: false, updated_at_ms: NOW,
    }
    configs.set(key, next)
    return next
  }
  await store.loadList()
  atScreen(search)
  const root = createRoot(fixture)
  try {
    flushSync(() =>
      root.render(
        <Toaster>
          <SupplierDbsScreen role="admin" store={store} />
        </Toaster>,
      ),
    )
    await settle()
    await action(root, store)
  } finally {
    flushSync(() => root.unmount())
    await settle()
    window.history.replaceState(null, "", checkPageHref)
    Object.assign(supplierOzonConfigIO, previousIO)
  }
}

const seedDetail: SupplierDbDetail = {
  db: { ...supplierDb("src-1", "美国3C厂"), rowCount: 1 },
  propDefs: [],
  rows: [{ ...supplierRow("p1", "src-1"), title: "圣诞帽", platformCode: "P001" }],
}

const seedWithProp: SupplierDbDetail = {
  db: { ...supplierDb("src-1", "美国3C厂"), rowCount: 1 },
  propDefs: [
    {
      propId: "prop-mat",
      sourceId: "src-1",
      name: "材质",
      type: "select",
      options: [{ value: "cotton", label: "棉" }],
      position: 0,
      sellerVisible: true,
      createdAtMs: NOW,
      updatedAtMs: NOW,
    },
  ],
  rows: [{ ...supplierRow("p1", "src-1"), title: "圣诞帽", platformCode: "P001" }],
}

// --- checks -------------------------------------------------------------------

/** 等右栏某个库的 detail 真落地（loadDetail 是异步跳数）。 */
async function waitForDb(sourceId: string, name: string) {
  for (let i = 0; i < 30; i++) {
    if (fixture.querySelector(`[aria-label="${name} 商品表"]`)) return
    await settle()
  }
  check(
    fixture.querySelector(`[aria-label="${name} 商品表"]`),
    `库 ${sourceId}（${name}）没出库页`,
  )
}

/** 侧栏卡片点选换库——点击只写地址，屏的选中逻辑接住后异步落 detail。 */
async function selectDb(sourceId: string, name: string) {
  await click(
    fixture.querySelector<HTMLElement>(`[data-supplier-dbs="list"] [data-supplier-db-row="${sourceId}"]`)!,
  )
  await waitForDb(sourceId, name)
}

/** 行点击是开面板的主路径；「更多 → 打开」是等价入口。 */
async function openRowPanel(productId: string, pane?: "info" | "prompt" | "defaults") {
  await click(
    fixture.querySelector<HTMLElement>(`tr[data-supplier-db-row="${productId}"]`)!,
  )
  for (let i = 0; i < 30; i++) {
    if (document.querySelector("[data-supplier-row-panel]")) break
    await settle()
  }
  check(
    document.querySelector("[data-supplier-row-panel]"),
    `行 ${productId} 没开详情面板`,
  )
  if (pane) {
    await click(
      document.querySelector<HTMLElement>(`[data-row-tab="${pane}"]`)!,
    )
  }
}

async function railSelectsAndAutoOpens() {
  const second: SupplierDbDetail = {
    db: { ...supplierDb("src-2", "美东厂"), rowCount: 1 },
    propDefs: [],
    rows: [{ ...supplierRow("p2", "src-2"), title: "收纳盒" }],
  }
  await mounted([seedDetail, second], async () => {
    // master-detail：没有「未选中」页——无 ?open= 进屏自动落首库并回写地址。
    await waitForDb("src-1", "美国3C厂")
    check(
      new URLSearchParams(window.location.search).get("open") === "src-1",
      `没自动回落首库，看到 ${window.location.search}`,
    )
    check(
      fixture
        .querySelector('[data-supplier-dbs="list"] [data-supplier-db-row="src-1"]')
        ?.getAttribute("aria-current") === "true",
      "首库卡片没标当前",
    )
    // 侧栏常驻 + 固定六列表头。
    check(fixture.querySelector('[data-supplier-dbs="list"]'), "库页缺库侧栏")
    for (const label of ["商品", "状态", "类目", "成本价", "零售价", "操作"]) {
      check(fixture.textContent?.includes(label), `缺列头「${label}」`)
    }
    check(fixture.textContent?.includes("圣诞帽"), "库页缺行")
    check(fixture.textContent?.includes("共 1 条"), "缺表尾计数")
    // 统计页签 = 筛选预设；筛选行三个下拉都在。
    for (const stat of ["all", "published", "incomplete"]) {
      check(fixture.querySelector(`[data-stat="${stat}"]`), `缺统计页签 ${stat}`)
    }
    for (const filter of ["status", "category", "publish"]) {
      check(fixture.querySelector(`[data-filter="${filter}"]`), `缺筛选 ${filter}`)
    }
    check(
      fixture.querySelector('[aria-label="选择本页全部行"]'),
      "缺表头全选",
    )

    // 点另一张卡片 → 换库，地址与当前卡片跟着走。
    await selectDb("src-2", "美东厂")
    check(
      new URLSearchParams(window.location.search).get("open") === "src-2",
      "换库没写回地址",
    )
    check(fixture.textContent?.includes("收纳盒"), "换库后没画新库的行")
    check(
      fixture
        .querySelector('[data-supplier-dbs="list"] [data-supplier-db-row="src-2"]')
        ?.getAttribute("aria-current") === "true",
      "换库后当前卡片没跟着走",
    )
  })
}

/** 刷新（同一地址重新挂载）后还停在打开的库页。 */
async function refreshKeepsOpenDb() {
  await mounted(
    [seedDetail],
    async () => {
      await waitForDb("src-1", "美国3C厂")
      check(fixture.textContent?.includes("圣诞帽"), "刷新后库页没画出商品行")
      // master-detail：侧栏常驻，库页不再独占整屏。
      check(
        fixture.querySelector('[data-supplier-dbs="list"]'),
        "刷新后丢了库侧栏",
      )
    },
    "?screen=supplier-dbs&open=src-1",
  )
}

/** `?open=` 指向已不存在的库——回落首库并把地址改写成有效值。 */
async function staleOpenFallsBack() {
  await mounted(
    [seedDetail],
    async () => {
      await waitForDb("src-1", "美国3C厂")
      check(
        new URLSearchParams(window.location.search).get("open") === "src-1",
        `失效 open 没回写首库，看到 ${window.location.search}`,
      )
    },
    "?screen=supplier-dbs&open=src-gone",
  )
}

async function rowOpensPanelAndEscReturns() {
  await mounted([seedDetail], async () => {
    await waitForDb("src-1", "美国3C厂")
    // 「更多 → 打开」入口。
    const menuButton = fixture.querySelector<HTMLElement>(
      '[data-supplier-db-open="p1"]',
    )!
    check(menuButton, "行上没有「更多」入口")
    check(
      menuButton.getAttribute("aria-label") === "行操作 圣诞帽",
      "行操作钮缺可访问名",
    )
    await click(menuButton)
    await click(
      document.querySelector<HTMLElement>('[data-row-menu="打开"]')!,
    )
    const dialog = document.querySelector<HTMLElement>(
      "[data-supplier-row-panel]",
    )
    check(dialog, "行详情面板没打开")
    check(getComputedStyle(dialog).position === "fixed", "详情未脱离表格布局")
    for (let i = 0; i < 30 && dialog.hasAttribute("data-starting-style"); i++) await settle()
    check(!dialog.hasAttribute("data-starting-style"), "抽屉仍处于初始动画状态")
    await Promise.all(dialog.getAnimations().map((animation) => animation.finished.catch(() => undefined)))
    const bounds = dialog.getBoundingClientRect()
    const viewport = { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight }
    const geometry = JSON.stringify({ left: bounds.left, right: bounds.right, top: bounds.top, height: bounds.height, viewport })
    check(Math.abs(bounds.right - viewport.width) < 1, `详情抽屉未贴右侧：${geometry}`)
    check(Math.abs(bounds.top) < 1 && Math.abs(bounds.height - viewport.height) < 1, `抽屉未占满视口高度：${geometry}`)
    if (innerWidth >= 900) check(bounds.width <= 600 && bounds.width >= 500, "桌面抽屉宽度不符合规格")
    check(!dialog.querySelector("[data-supplier-row-cover]"), "详情仍保留旧封面占位")
    for (const label of ["主要信息", "平台字段", "提示词"]) {
      check([...dialog.querySelectorAll('[role="tab"]')].some((tab) => tab.textContent === label), `缺页签 ${label}`)
    }
    for (const label of ["商品资料", "价格", "内部备注", "素材"]) {
      check(dialog.textContent?.includes(label), `面板缺 ${label} 区`)
    }
    check(dialog!.querySelector('[aria-label="名称"]'), "面板缺名称输入")
    await pressEscape()
    for (let i = 0; i < 30 && document.querySelector("[data-supplier-row-panel]"); i++) await settle()
    check(
      !document.querySelector("[data-supplier-row-panel]"),
      "Esc 没关掉面板",
    )
    await settle()
    check(
      document.activeElement === menuButton,
      "Esc 后焦点没回到触发行",
    )
  })
}

async function newProductCreatesRowAndOpensPanel() {
  await mounted(
    [{ db: supplierDb("src-2", "空库"), propDefs: [], rows: [] }],
    async () => {
      await waitForDb("src-2", "空库")
      check(
        fixture.textContent?.includes("库还没有商品"),
        "空库缺行区引导文案",
      )
      await click(fixture.querySelector<HTMLElement>("[data-new-row]")!)
      const dialog = document.querySelector<HTMLElement>(
        "[data-supplier-row-panel]",
      )
      check(dialog, "＋新建商品没开行页面")
      const titleInput = dialog!.querySelector<HTMLInputElement>(
        '[aria-label="名称"]',
      )!
      setInput(titleInput, "圣诞帽")
      // React 的 onBlur 挂在 focusout 上——派发 blur 打不到它。
      titleInput.dispatchEvent(new FocusEvent("focusout", { bubbles: true }))
      // 提交链是 commit → patchCell → client → store → 重渲，多跳异步——轮询等它落。
      for (let i = 0; i < 30; i++) {
        if (fixture.textContent?.includes("圣诞帽")) break
        await settle()
      }
      check(fixture.textContent?.includes("圣诞帽"), "名称提交没有回写表格")
      check(fixture.textContent?.includes("共 1 条"), "表尾计数没更新")
    },
  )
}

async function createDbDialogFlow() {
  await mounted([], async () => {
    check(fixture.textContent?.includes("还没有平台货源"), "缺建库空态")
    await click(byText("新建平台货源"))
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    check(dialog, "建库对话框没打开")
    check(
      dialog!.querySelector<HTMLInputElement>("#supplier-db-name"),
      "建库表单缺名称",
    )
    check(
      dialog!.querySelector<HTMLElement>("#supplier-db-template"),
      "建库表单缺厂家模板开关",
    )
    check(
      dialog!.querySelector("#supplier-db-contact"),
      "建库表单应与库设置同一组字段（缺联系方式）",
    )
    check(
      dialog!.querySelector("#supplier-db-account-email"),
      "建库表单缺厂家登录邮箱",
    )
    const name = dialog!.querySelector<HTMLInputElement>("#supplier-db-name")!
    setInput(name, "德国厂")
    setInput(
      dialog!.querySelector<HTMLInputElement>("#supplier-db-account-email")!,
      "factory@example.com",
    )
    await settle()
    await click(
      [...dialog!.querySelectorAll<HTMLButtonElement>('button[type="submit"]')][0],
    )
    await waitForDb("src-new-1", "德国厂")
    check(
      new URLSearchParams(window.location.search).get("open") === "src-new-1",
      "建库后没直达新库（地址里的打开态不是它）",
    )
    check(
      fixture
        .querySelector('[data-supplier-dbs="list"] [data-supplier-db-row="src-new-1"]')
        ?.getAttribute("aria-current") === "true",
      "新库卡片没标当前",
    )
  })
}

/** 统计页签点选 = 设行筛选预设，页签激活态跟筛选态同步。 */
async function statTabsFilter() {
  await mounted([seedDetail], async () => {
    await waitForDb("src-1", "美国3C厂")
    const stat = (key: string) =>
      fixture.querySelector<HTMLElement>(`[data-stat="${key}"]`)!
    check(
      stat("all").getAttribute("aria-selected") === "true",
      "默认激活不是「全部商品」",
    )
    // 唯一行未上架 → 「已上架」筛选把它滤掉。
    await click(stat("published"))
    check(
      fixture.textContent?.includes("没有匹配的商品"),
      "已上架预设没滤掉未上架行",
    )
    check(
      stat("published").getAttribute("aria-selected") === "true",
      "已上架页签没标激活",
    )
    check(fixture.textContent?.includes("共 0 条"), "筛选后计数没变")
    // 「待完善」命中缺项行；「全部商品」还原。
    await click(stat("incomplete"))
    check(fixture.textContent?.includes("圣诞帽"), "待完善预设漏掉缺项行")
    await click(stat("all"))
    check(fixture.textContent?.includes("共 1 条"), "回全部没还原计数")
  })
}

/** 状态下拉里留着「待复核」：只收 config_needs_reconfiguration 行。 */
async function statusFilterIncludesReview() {
  const seed: SupplierDbDetail = {
    ...seedDetail,
    rows: [
      seedDetail.rows[0]!,
      {
        ...supplierRow("p2", "src-1"),
        title: "待复核行",
        denial: "config_needs_reconfiguration",
      },
    ],
  }
  await mounted([seed], async () => {
    await waitForDb("src-1", "美国3C厂")
    await click(fixture.querySelector<HTMLElement>('[data-filter="status"]')!)
    const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')]
    for (const label of ["全部状态", "就绪", "待完善", "待复核"]) {
      check(
        options.some((el) => el.textContent?.trim() === label),
        `状态下拉缺「${label}」`,
      )
    }
    await click(options.find((el) => el.textContent?.trim() === "待复核")!)
    for (let i = 0; i < 30; i++) {
      if (!fixture.querySelector('tr[data-supplier-db-row="p1"]')) break
      await settle()
    }
    check(
      !fixture.querySelector('tr[data-supplier-db-row="p1"]'),
      "待复核筛选漏进了普通行",
    )
    check(
      fixture.querySelector('tr[data-supplier-db-row="p2"]'),
      "待复核筛选没收到 config_needs_reconfiguration 行",
    )
    check(fixture.textContent?.includes("共 1 条"), "筛选后计数不对")
  })
}

/** `/` 在非输入态下聚焦商品搜索。 */
async function slashFocusesSearch() {
  await mounted([seedDetail], async () => {
    await waitForDb("src-1", "美国3C厂")
    const anchor = fixture.querySelector<HTMLElement>("[data-new-row]")!
    anchor.focus()
    await pressKey(anchor, "/")
    check(
      (document.activeElement as HTMLElement)?.getAttribute("aria-label") ===
        "搜索商品",
      "`/` 没聚焦商品搜索框",
    )
    // 搜索收窄行集；清空还原。
    const search = document.activeElement as HTMLInputElement
    setInput(search, "别的")
    await settle()
    check(
      fixture.textContent?.includes("没有匹配的商品"),
      "搜索没滤掉不命中行",
    )
    setInput(search, "")
    await settle()
    check(fixture.textContent?.includes("圣诞帽"), "清空搜索没还原行")
  })
}

/** 状态格点击：未就绪先列缺项再拦上架。 */
async function statusCellListsMissingBeforePublish() {
  await mounted([seedDetail], async () => {
    await waitForDb("src-1", "美国3C厂")
    await click(
      fixture.querySelector<HTMLElement>('[aria-label="状态 未上架"]')!,
    )
    const missing = document.querySelector<HTMLElement>("[data-status-missing]")
    check(missing, "未就绪行点状态没开缺项弹层")
    for (const item of ["类目", "提示词", "固定 tags", "平台价"]) {
      check(missing!.textContent?.includes(item), `缺项清单少「${item}」`)
    }
    await pressEscape()
  })
}

async function rowMenuDuplicatesAndArchives() {
  await mounted([seedDetail], async () => {
    await waitForDb("src-1", "美国3C厂")
    await click(
      fixture.querySelector<HTMLElement>('[aria-label="行操作 圣诞帽"]')!,
    )
    await click(
      document.querySelector<HTMLElement>('[data-row-menu="复制行"]')!,
    )
    for (let i = 0; i < 30; i++) {
      if (fixture.textContent?.includes("圣诞帽 副本")) break
      await settle()
    }
    check(fixture.textContent?.includes("圣诞帽 副本"), "复制行没落「副本」")
    check(fixture.textContent?.includes("共 2 条"), "复制后计数没变")
    // 归档副本：确认 → 离开商品表。
    await click(
      fixture.querySelector<HTMLElement>('[aria-label="行操作 圣诞帽 副本"]')!,
    )
    await click(
      document.querySelector<HTMLElement>('[data-row-menu="归档"]')!,
    )
    const confirm = [...document.querySelectorAll<HTMLElement>("button")].find(
      (el) => el.textContent?.trim() === "归档" && el.closest('[role="dialog"]'),
    )
    check(confirm, "归档确认对话框没出现")
    await click(confirm!)
    for (let i = 0; i < 30; i++) {
      if (!fixture.textContent?.includes("圣诞帽 副本")) break
      await settle()
    }
    check(
      !fixture.textContent?.includes("圣诞帽 副本"),
      "归档行还在商品表",
    )
    check(fixture.textContent?.includes("共 1 条"), "归档后计数没变")
  })
}

async function markdownPromptImportsAtomically() {
  const configured = { ...seedDetail, rows: [{ ...seedDetail.rows[0]!, descriptionCategoryId: 11, typeId: 101 }] }
  await mounted([configured], async (_root, store) => {
    await waitForDb("src-1", "美国3C厂")
    await openRowPanel("p1", "prompt")
    const upload = document.querySelector<HTMLElement>('[aria-label="导入 Markdown 说明文件"]')!
    check(upload, "提示词缺 Markdown 导入入口")
    const pick = async (file: File) => {
      const restore = stubFilePicker([file])
      try { await click(upload) } finally { restore() }
      await settle()
    }
    const content = ['Товар: Картина на холсте.', 'Тема: Только видимое изображение.',
      'Заголовок: `Картина "<тема>"`', 'Не пиши: Рамка.',
      'Описание: Опиши видимый принт.', 'Не выдумывай: Материал рамы.'].join("\n")
    await pick(new File([content], "识图.MD", { type: "text/markdown" }))
    const row = () => store.getState().details["src-1"]!.detail!.rows[0]!
    check(row().promptFileName === "识图.MD", "未保存原始 Markdown 文件名")
    check(row().promptContent === content, "六行正文未按保存规则写入")
    check(row().promptName === "识图", "空提示词名称未由文件名补齐")
    check(upload.parentElement?.textContent?.includes("识图.MD"), "导入后未展示说明文件名")
    const revision = row().revision
    for (const file of [
      new File([content], "bad.txt"), new File(["   "], "empty.md"),
      new File(["# 非六行"], "invalid-brief.md"), new File(["字".repeat(1400)], "long.md"),
      new File([new Uint8Array([0xff, 0xfe])], "invalid.md"),
    ]) await pick(file)
    check(row().revision === revision && row().promptContent === content, "无效文件覆盖了已有提示词")
  })
}

async function fixedTagsEnterSavesAndRemoveSaves() {
  const fullTags = Array.from({ length: 27 }, (_, i) => `#тег${i}`)
  await mounted([{ ...seedDetail, rows: [{ ...seedDetail.rows[0]!, fixedTags: fullTags, descriptionCategoryId: 11, typeId: 101 }] }], async (_root, store) => {
    await waitForDb("src-1", "美国3C厂")
    await openRowPanel("p1", "prompt")
    const editor = document.querySelector<HTMLElement>("[data-supplier-row-fixed-tags]")!
    const row = () => store.getState().details["src-1"]!.detail!.rows[0]!
    await click(editor.querySelector<HTMLElement>('[aria-label="移除 #тег26"]')!)
    check(row().fixedTags.length === 27, "仍为 26 个时不应保存")
    await click(editor.querySelector<HTMLElement>('[aria-label="移除 #тег25"]')!)
    for (let i = 0; i < 30 && row().fixedTags.length !== 25; i++) await settle()
    check(row().fixedTags.length === 25, "删至 25 个时应保存")
    const input = editor.querySelector<HTMLInputElement>('[aria-label="添加固定标签"]')!
    setInput(input, "новый")
    await pressKey(input, "Enter")
    check(row().fixedTags.length === 25, "第 26 个固定 tag 不应保存")
    check(editor.textContent?.includes("25 / 25"), "计数应显示 25 / 25")
  })

  // 存量里塞一个写路径不验词身时留下的非法 tag —— 入库就要显形。
  const seedInvalid: SupplierDbDetail = {
    ...seedDetail,
    rows: [{ ...seedDetail.rows[0]!, fixedTags: ["#test"], descriptionCategoryId: 11, typeId: 101 }],
  }
  await mounted([seedInvalid], async (_root, store) => {
    await waitForDb("src-1", "美国3C厂")
    await openRowPanel("p1", "prompt")
    const editor = document.querySelector<HTMLElement>(
      "[data-supplier-row-fixed-tags]",
    )!
    check(editor, "行面板缺固定 tags 编辑区")
    check(
      ![...editor.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "保存",
      ),
      "固定 tags 还有保存按钮",
    )
    const row = () => store.getState().details["src-1"]!.detail!.rows[0]!
    const input = editor.querySelector<HTMLInputElement>('[aria-label="添加固定标签"]')!

    // 存量非法 tag 在徽标上显形，容器挂 aria-invalid。
    const badges = [...editor.querySelectorAll<HTMLElement>('[data-slot="badge"]')]
    const badBadge = badges.find((b) => b.textContent?.includes("#test"))
    check(
      badBadge?.getAttribute("aria-invalid") === "true",
      "存量非法 tag 没在徽标上显形",
    )
    check(
      editor.getAttribute("aria-invalid") === "true",
      "含非法 tag 时容器没标 invalid",
    )

    // 拉丁字母永远过不了 publish 闸 —— 入口拒存，原文留给用户改。
    setInput(input, "latin")
    await pressKey(input, "Enter")
    check(row().fixedTags.length === 1, "拉丁 tag 被存进去了")
    const rejected = input.value
    check(rejected === "latin", "被拒的输入被清掉了")

    setInput(input, "подарок")
    await pressKey(input, "Enter")
    for (let i = 0; i < 30 && row().fixedTags.length < 2; i++) await settle()
    check(row().fixedTags[1] === "#подарок", "回车没有立即保存 tag")
    check(editor.textContent?.includes("#подарок"), "新 tag 没渲染成 badge")
    check(input.value === "", "回车后输入框没清空")

    await click(editor.querySelector<HTMLElement>('[aria-label="移除 #test"]')!)
    for (let i = 0; i < 30 && row().fixedTags.length > 1; i++) await settle()
    check(
      row().fixedTags.length === 1 && row().fixedTags[0] === "#подарок",
      "移除存量非法 tag 没有立即保存",
    )
    check(
      !editor.hasAttribute("aria-invalid"),
      "非法 tag 移除后容器还标 invalid",
    )
    await click(editor.querySelector<HTMLElement>('[aria-label="移除 #подарок"]')!)
    for (let i = 0; i < 30 && row().fixedTags.length > 0; i++) await settle()
    check(row().fixedTags.length === 0, "移除 tag 没有立即保存")
    check(editor.textContent?.includes("尚未填写"), "移除后没回空态")
  })
}

/** 「库设置 → 编辑库信息」开屏级表单：联系/备注/可见/委托都在编辑分支。 */
async function editDbViaSettings() {
  await mounted([seedDetail], async (_root, store) => {
    await waitForDb("src-1", "美国3C厂")
    await click(byText("库设置"))
    await click(
      document.querySelector<HTMLElement>('[data-db-menu="编辑库信息"]')!,
    )
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    check(dialog, "编辑库对话框没打开")
    for (const id of [
      "supplier-db-name",
      "supplier-db-contact",
      "supplier-db-note",
      "supplier-db-listed",
      "supplier-db-accepts-delegate",
    ]) {
      check(dialog!.querySelector(`#${id}`), `编辑表单缺 ${id}`)
    }
    check(
      !dialog!.querySelector("#supplier-db-template"),
      "编辑表单不该带厂家模板",
    )
    // 对卖家可见开关直接写 listed。
    const listed = dialog!.querySelector<HTMLElement>("#supplier-db-listed")!
    check(listed instanceof HTMLInputElement ? listed.checked : listed.getAttribute("aria-checked") === "true", "种子库该已公开")
    await click(listed)
    await click(byText("保存", dialog!))
    for (let i = 0; i < 30; i++) {
      if (store.getState().dbs[0]?.listed === false) break
      await settle()
    }
    check(
      store.getState().dbs[0]?.listed === false,
      "可见开关没写回 listed",
    )
    check(
      fixture
        .querySelector('[data-supplier-dbs="list"] [data-supplier-db-row="src-1"]')
        ?.textContent?.includes("○未公开"),
      "侧栏卡片没回显未公开",
    )
  })
}

/** 「库设置 → 自定义属性」：定义管理在弹窗里闭环——排序与删除（带行数确认）。 */
async function propsManagerReorderAndDelete() {
  const seed: SupplierDbDetail = {
    ...seedWithProp,
    propDefs: [
      ...seedWithProp.propDefs,
      {
        propId: "prop-pack",
        sourceId: "src-1",
        name: "整包装",
        type: "number",
        options: [],
        position: 1,
        sellerVisible: true,
        createdAtMs: NOW,
        updatedAtMs: NOW,
      },
    ],
    rows: [
      {
        ...supplierRow("p1", "src-1"),
        title: "圣诞帽",
        props: { "prop-mat": "cotton" },
      },
    ],
  }
  await mounted([seed], async () => {
    await waitForDb("src-1", "美国3C厂")
    await click(byText("库设置"))
    await click(
      document.querySelector<HTMLElement>('[data-db-menu="自定义属性"]')!,
    )
    const dialog = () =>
      [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find(
        (el) => el.querySelector("[data-supplier-props]"),
      )
    check(dialog(), "自定义属性管理弹窗没打开")
    check(
      dialog()!.querySelector('[data-supplier-prop="prop-mat"]'),
      "属性列表缺既有定义",
    )
    // 下移首条 → 顺序调换。
    await click(
      dialog()!.querySelector<HTMLElement>('[aria-label="下移 材质"]')!,
    )
    for (let i = 0; i < 30; i++) {
      const first = dialog()?.querySelector("[data-supplier-prop]")
      if (first?.getAttribute("data-supplier-prop") === "prop-pack") break
      await settle()
    }
    check(
      dialog()!.querySelector("[data-supplier-prop]")?.getAttribute(
        "data-supplier-prop",
      ) === "prop-pack",
      "下移后属性顺序没换",
    )
    // 删除带行数确认；确认后定义离开列表。
    await click(
      dialog()!.querySelector<HTMLElement>('[aria-label="删除 材质"]')!,
    )
    const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((el) => el.textContent?.includes("行已有值"))
    check(confirm, "删除属性确认框没出现")
    check(confirm!.textContent?.includes("1 行已有值"), "确认框没带行数警告")
    await click(byText("删除属性", confirm!))
    for (let i = 0; i < 30; i++) {
      if (!dialog()?.querySelector('[data-supplier-prop="prop-mat"]')) break
      await settle()
    }
    check(
      !dialog()?.querySelector('[data-supplier-prop="prop-mat"]'),
      "确认后属性定义还在",
    )
  })
}

/** 「库设置 → 删除库」：确认后库从侧栏消失，选中回落到剩余首库。 */
async function deleteDbViaSettings() {
  const second: SupplierDbDetail = {
    db: { ...supplierDb("src-2", "美东厂"), rowCount: 1 },
    propDefs: [],
    rows: [{ ...supplierRow("p2", "src-2"), title: "收纳盒" }],
  }
  await mounted([seedDetail, second], async () => {
    await waitForDb("src-1", "美国3C厂")
    await click(byText("库设置"))
    await click(
      document.querySelector<HTMLElement>('[data-db-menu="删除库"]')!,
    )
    const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
      .find((el) => el.textContent?.includes("删除「美国3C厂」"))
    check(confirm, "删库确认框没出现")
    await click(byText("删除库", confirm!))
    for (let i = 0; i < 30; i++) {
      if (!fixture.querySelector('[data-supplier-db-row="src-1"]')) break
      await settle()
    }
    check(
      !fixture.querySelector('[data-supplier-dbs="list"] [data-supplier-db-row="src-1"]'),
      "删库后侧栏还留着该库",
    )
    // 删的是当前库 → 回落到剩余首库并重开 detail。
    await waitForDb("src-2", "美东厂")
    check(
      new URLSearchParams(window.location.search).get("open") === "src-2",
      "删库后没回落到剩余首库",
    )
  })
}

/** 勾选行 → 「更多操作」菜单：上架直走，归档先过确认框。 */
async function bulkMenuPublishesAndArchives() {
  await mounted([seedDetail], async () => {
    await waitForDb("src-1", "美国3C厂")
    const bulkMenu = fixture.querySelector<HTMLElement>("[data-bulk-menu]")!
    check(bulkMenu.hasAttribute("disabled"), "没勾选时更多操作不该可点")
    await click(
      fixture.querySelector<HTMLElement>('[aria-label="选择 圣诞帽"]')!,
    )
    check(!bulkMenu.hasAttribute("disabled"), "勾选后更多操作仍禁用")
    // 批量上架：逐行走行级端点，行回写已上架。
    await click(bulkMenu)
    await click(
      document.querySelector<HTMLElement>('[data-bulk-action="publish"]')!,
    )
    for (let i = 0; i < 30; i++) {
      if (fixture.textContent?.includes("已上架")) break
      await settle()
    }
    check(fixture.textContent?.includes("已上架"), "批量上架没落")
    // 批量归档是破坏面——先过确认框；确认后行离开商品表。
    await click(
      fixture.querySelector<HTMLElement>("[data-bulk-menu]")!,
    )
    await click(
      document.querySelector<HTMLElement>('[data-bulk-action="archive"]')!,
    )
    const dialog = [
      ...document.querySelectorAll<HTMLElement>('[role="dialog"]'),
    ].find((el) => el.textContent?.includes("归档 1 行"))
    check(dialog, "归档确认框没出现")
    await click(byText("归档 1 行", dialog!))
    for (let i = 0; i < 30; i++) {
      if (!fixture.textContent?.includes("圣诞帽")) break
      await settle()
    }
    check(!fixture.textContent?.includes("圣诞帽"), "归档行还在商品表")
    check(fixture.textContent?.includes("共 0 条"), "归档后计数没变")
  })
}

/** 侧栏搜索按库名收窄，清空还原。 */
async function railSearchNarrows() {
  const second: SupplierDbDetail = {
    db: { ...supplierDb("src-2", "美东厂"), rowCount: 4 },
    propDefs: [],
    rows: [],
  }
  await mounted([seedDetail, second], async () => {
    check(fixture.querySelector('[data-supplier-dbs="list"]'), "缺库侧栏")
    const search = fixture.querySelector<HTMLInputElement>(
      '[aria-label="搜索平台货源"]',
    )!
    setInput(search, "美东")
    await settle()
    check(
      !fixture.querySelector('[data-supplier-db-row="src-1"]'),
      "搜索没收窄库卡片",
    )
    check(
      fixture.querySelector('[data-supplier-db-row="src-2"]'),
      "搜索丢了命中库",
    )
    setInput(search, "")
    await settle()
    check(
      fixture.querySelector('[data-supplier-db-row="src-1"]'),
      "清空搜索没还原库卡片",
    )
    // 收窄不误伤右栏：命中库仍可点开。
    setInput(search, "美东")
    await settle()
    await selectDb("src-2", "美东厂")
    check(
      new URLSearchParams(window.location.search).get("open") === "src-2",
      "收窄后点选没换库",
    )
  })
}

async function staffGate() {
  const store = createSupplierDbsStore(memoryClient([seedDetail]))
  await store.loadList()
  const root = createRoot(fixture)
  try {
    flushSync(() =>
      root.render(
        <Toaster>
          <SupplierDbsScreen role="user" store={store} />
        </Toaster>,
      ),
    )
    await settle()
    check(
      fixture.textContent?.includes("仅平台管理员"),
      "非 staff 没看到拦截",
    )
    check(!fixture.textContent?.includes("美国3C厂"), "非 staff 看到了库数据")
  } finally {
    flushSync(() => root.unmount())
    await settle()
  }
}

run.addEventListener("click", async () => {
  results.textContent = "运行中…"
  unexpectedRequests.length = 0
  const checks: Array<[string, () => Promise<void>]> = [
    ...drawerDraftChecks({ mounted, seedDetail, supplierRow, waitForDb, openRowPanel, click, byText, setInput, settle, pressEscape, check }),
    ["侧栏选库 / 无打开态自动落首库", railSelectsAndAutoOpens],
    ["刷新停在打开的库页", refreshKeepsOpenDb],
    ["失效 ?open= 回落首库", staleOpenFallsBack],
    ["行 ⋯ 打开面板 / Esc 焦点回行", rowOpensPanelAndEscReturns],
    ["空库 ＋新建商品 建行并开面板", newProductCreatesRowAndOpensPanel],
    ["建库对话框", createDbDialogFlow],
    ["staff 门", staffGate],
    ["统计页签 = 筛选预设", statTabsFilter],
    ["状态下拉留「待复核」", statusFilterIncludesReview],
    ["`/` 聚焦商品搜索", slashFocusesSearch],
    ["状态格先列缺项", statusCellListsMissingBeforePublish],
    ["行 ⋯ 复制行 / 归档", rowMenuDuplicatesAndArchives],
    ["Markdown 提示词导入 / 无效文件保留原内容", markdownPromptImportsAtomically],
    ["固定 tags 回车即存 / 移除即存", fixedTagsEnterSavesAndRemoveSaves],
    ["库设置 → 编辑库信息：联系/可见/委托", editDbViaSettings],
    ["库设置 → 自定义属性：排序 / 删除带行数确认", propsManagerReorderAndDelete],
    ["库设置 → 删除库 / 回落剩余首库", deleteDbViaSettings],
    ["勾选 → 更多操作：上架 / 归档确认", bulkMenuPublishesAndArchives],
    ["侧栏搜索收窄", railSearchNarrows],
  ]
  const lines: string[] = []
  let failed = 0
  for (const [name, fn] of checks) {
    results.textContent = lines.join("\n") + `\n… ${name}`
    try {
      await fn()
      lines.push(`✓ ${name}`)
    } catch (error) {
      failed += 1
      lines.push(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (unexpectedRequests.length) {
    failed += 1
    lines.push(`✗ unexpected fetch: ${unexpectedRequests.join(", ")}`)
  }
  results.textContent = `${lines.join("\n")}\n${failed === 0 ? "全部通过" : `${failed} 项失败`}`
})

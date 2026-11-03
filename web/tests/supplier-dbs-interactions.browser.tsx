// Dev-only interaction checks; factories, schemas, permissions and row writes use memory APIs.
import { flushSync } from "react-dom"
import { useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { TrailContext, type TrailEntry } from "@/app/app-shell"
import type { CategorySchemaView } from "@/bindings/commands"
import type { SupplierDbDetail, SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { listingHttp } from "@/bindings/http-listing"
import { adminHttp } from "@/bindings/http-admin"
import { catalogManagersHttp, type CatalogManager } from "@/bindings/http-catalog-managers"
import { sourceFulfillersHttp, type SourceFulfiller } from "@/bindings/http-source-fulfillers"
import { Toaster } from "@/components/ui/toast"
import { CustomPropField } from "@/features/supplier-dbs/supplier-row-fields"
import { propDef, TREE } from "@/features/supplier-dbs/supplier-editing-fixtures"
import { SupplierDbsScreen } from "@/features/supplier-dbs/supplier-dbs-screen"
import { SupplierAccountsScreen } from "@/features/supplier/admin-supplier-accounts-screen"
import { db, row, memoryClient } from "@/features/supplier-dbs/supplier-dbs-screen-fixtures"
import { SupplierOcrImageTest } from "@/features/supplier-dbs/supplier-ocr-image-test"
import { supplierOcrTestsHttp, type SupplierOcrTestResult } from "@/bindings/http-supplier-ocr-tests"
import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { createSupplierDbsStore } from "@/features/supplier-dbs/supplier-dbs-store"
import { rowToUpsert } from "@/features/supplier-dbs/supplier-dbs-model"
import { supplierOzonConfigIO, type SupplierOzonConfigData } from "@/features/supplier-dbs/supplier-ozon-config"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const unexpectedRequests: string[] = []
const supplierRow = (id: string, sourceId: string) => row(id, sourceId)
sourceFulfillersHttp.list = async () => ({ fulfillers: [] })
catalogManagersHttp.list = async () => ({ catalogManagers: [] })
window.fetch = async (input) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.includes("/api/me/catalog/banned-tags")) return Response.json({ data: { rules: [] } })
  if (url.includes("/api/admin/supplier-withdrawals")) return Response.json({ data: { withdrawals: [] } })
  if (url.endsWith("/api/admin/factories")) return Response.json({ data: { factories: [{ factoryId: "fac-1", name: "杭州工厂", country: "CN", contact: "", internalNote: "", icon: "", createdAtMs: 1, updatedAtMs: 1 }] } })
  if (url.endsWith("/api/admin/supplier-accounts")) {
    const factory = { factoryId: "fac-1", name: "杭州工厂", country: "CN", icon: "" }
    return Response.json({ data: { groups: [{ factory, members: [
      { memberId: "member-1", accountUuid: "factory-account", factory, email: "factory@example.com", status: "active", createdAtMs: 1 },
      { memberId: "member-2", accountUuid: "disabled-account", factory, email: "disabled@example.com", status: "disabled", createdAtMs: 1 },
    ] }] } })
  }
  unexpectedRequests.push(url)
  throw new Error(`Unexpected network request: ${url}`)
}
listingHttp.listingCardLoadCategoryTree = async () => TREE
listingHttp.listingCardLoadCategorySchema = async (): Promise<CategorySchemaView> => ({
  description_category_id: 11, type_id: 101, language: "zh_hans", complex_groups: [],
  fields: [{ key: "width", name: "包装宽度", description: "", group_name: "物流与税务", source: "fixed", editor: "integer",
    complex_group_collection: false, read_only: false, constraints: { required: true, collection: false }, options: [], options_truncated: false, aspect: null }],
})
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(condition: () => unknown, message: string) {
  for (let index = 0; index < 90; index++) { if (condition()) return; await settle() }
  check(condition(), message)
}
function byText(text: string, root: ParentNode = document): HTMLElement {
  const element = [...root.querySelectorAll<HTMLElement>("button")].find((el) =>
    (el.textContent?.trim() === text || el.getAttribute("aria-label") === text) && !el.closest('[hidden], [inert], [aria-hidden="true"], .hidden'))
  check(element, `Expected button '${text}'`)
  return element
}
async function click(el: HTMLElement) {
  check(el && !el.hasAttribute("disabled"), "Missing or disabled control")
  flushSync(() => el.click()); await settle()
}
function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, value)
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })))
}
async function edit(input: HTMLInputElement | HTMLTextAreaElement, value: string) { input.focus(); setInput(input, value); await settle(); input.blur(); await settle() }
async function pressKey(el: Element, key: string, shiftKey = false) {
  flushSync(() => el.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }))); await settle()
}
async function pressEscape() { await pressKey(document.activeElement ?? document.body, "Escape") }
async function choose(text: string) {
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.includes(text))
  check(option, `Missing option ${text}`); await click(option)
}
const profile = (size: string) => JSON.stringify({ product_type_ru: "Подушка", facts_ru: size })
const product = (id = "p1", sourceId = "src-1", over: Partial<SupplierDbRow> = {}) => row(id, sourceId, {
  title: "靠枕", size: "40×40 cm", descriptionCategoryId: 11, typeId: 101, fixedTags: ["#подушка"], promptContent: profile("40 см"), ...over,
})
const seed = (): SupplierDbDetail[] => [{ db: db("src-1", "杭州工厂", { factoryId: "fac-1" }), propDefs: [], rows: [product()] }]

/** 壳层面包屑的替身：面板只通过 trail 发布返回入口。 */
function TrailHarness({ children }: { children: ReactNode }) {
  const [trail, setTrail] = useState<TrailEntry>()
  return <TrailContext.Provider value={setTrail}>
    <button type="button" hidden={!trail} onClick={() => trail?.onExit()}>返回商品表格</button>
    {children}
  </TrailContext.Provider>
}

async function mounted(seed: SupplierDbDetail[], action: (context: {
  store: ReturnType<typeof createSupplierDbsStore>
  calls: ReturnType<typeof memoryClient>["calls"]
  client: ReturnType<typeof memoryClient>["client"]
  configs: Map<string, SupplierOzonConfigData>
  showFactories: () => Promise<void>
  showProducts: () => Promise<void>
}) => Promise<void>, role = "admin") {
  const { client, calls } = memoryClient(seed)
  const previousIO = { ...supplierOzonConfigIO }
  const configs = new Map<string, SupplierOzonConfigData>()
  const syncRow = (item: SupplierDbRow) => {
    if (item.descriptionCategoryId == null || item.typeId == null) return
    const key = `${item.sourceId}:${item.productId}`
    const previous = configs.get(key)
    configs.set(key, { product_id: item.productId, description_category_id: item.descriptionCategoryId, type_id: item.typeId,
      language: "zh_hans", values: previous?.values ?? { "fixed:width": [{ kind: "integer", value: 300 }] }, complex_values: [],
      ai_output: previous?.ai_output ?? { title: true, description: true, tags: true }, fixed_tags: item.fixedTags, prompt_text: item.promptContent,
      revision: (previous?.revision ?? 0) + 1, state: "valid", issues: [], usable: false, updated_at_ms: Date.now() })
  }
  for (const detail of seed) for (const item of detail.rows) syncRow(item)
  const update = client.supplierDbRowUpdate
  client.supplierDbRowUpdate = async (...args) => { const result = await update(...args); syncRow(result.row); return result }
  const create = client.supplierDbRowCreate
  client.supplierDbRowCreate = async (...args) => { const result = await create(...args); syncRow(result.row); return result }
  supplierOzonConfigIO.get = async (sourceId, productId) => configs.get(`${sourceId}:${productId}`)
  supplierOzonConfigIO.put = async (sourceId, productId, body) => {
    const key = `${sourceId}:${productId}`
    if (body.expected_revision !== (configs.get(key)?.revision ?? 0)) throw { code: "cloud_conflict" }
    const saved: SupplierOzonConfigData = { ...body, product_id: productId, revision: body.expected_revision + 1, state: "valid", issues: [], usable: false, updated_at_ms: Date.now() }
    configs.set(key, saved)
    const current = (await client.supplierDbGet(sourceId)).rows.find((item) => item.productId === productId)
    if (current) await update(sourceId, productId, { ...rowToUpsert(current), expectedRevision: current.revision })
    return saved
  }
  const store = createSupplierDbsStore(client)
  await store.loadList()
  await Promise.all(store.getState().dbs.map((factory) => store.loadDetail(factory.sourceId)))
  const root = createRoot(fixture)
  const showProducts = async () => {
    flushSync(() => root.render(<Toaster><TrailHarness><SupplierDbsScreen role={role} store={store} /></TrailHarness></Toaster>))
    await settle()
  }
  const showFactories = async () => {
    flushSync(() => root.render(<Toaster><SupplierAccountsScreen overview={{ session: { authenticated: true, email: "admin@example.invalid", role }, owned_count: 0, owned_limit: 3, workspaces: [] }} /></Toaster>))
    await until(() => Boolean(fixture.querySelector('[aria-label="新增工厂"]:not([disabled])')), "工厂管理未加载")
  }
  try {
    await showProducts(); await action({ store, calls, client, configs, showFactories, showProducts })
  } finally { flushSync(() => root.unmount()); Object.assign(supplierOzonConfigIO, previousIO); await settle() }
}

async function factoryBeforeProduct() {
  await mounted([], async ({ store, calls }) => {
    check(byText("新增商品").hasAttribute("disabled"), "没有绑定工厂时仍能创建商品")
    await click(byText("工厂绑定")); await click(byText("绑定工厂"))
    await until(() => Boolean(document.querySelector("#bind-factory")), "绑定对话框未打开")
    await click(document.querySelector<HTMLElement>("#bind-factory")!); await choose("杭州工厂")
    setInput(document.querySelector<HTMLInputElement>("#library-name")!, "杭州商品库")
    await settle(); await click(byText("确认绑定"))
    await until(() => calls.createDb.length === 1 && !document.querySelector("#library-name"), "工厂未绑定")
    check(calls.createDb[0].factoryId === "fac-1", "没有绑定选定的工厂")
    await click(byText("返回平台商品库")); await click(byText("新增商品"))
    await click(byText("选择商品库")); await choose("杭州商品库")
    setInput(document.querySelector<HTMLInputElement>("#supplier-new-product-spec")!, "首个规格")
    await settle(); await click(byText("创建并填写"))
    await until(() => Boolean(fixture.querySelector('[data-supplier-row-panel]')), "商品流程未打开")
    check(calls.createDb.length === 1 && calls.createRow.length === 1, "绑定或创建商品重复提交")
    const detail = store.getState().details[store.getState().dbs[0].sourceId].detail!
    check(detail.rows.length === 1 && detail.rows[0].sourceId === detail.db.sourceId, "新商品未绑定选定商品库")
  }, "super_admin")
}

async function singleTableAndFactoryFilter() {
  const details = [...seed(), { db: db("src-2", "义乌工厂"), propDefs: [], rows: [product("p2", "src-2", { title: "帆布包" })] }]
  await mounted(details, async () => {
    check(fixture.querySelectorAll("table").length === 1 && !fixture.querySelector("[data-panel]"), "商品不是单表布局")
    check(fixture.querySelectorAll("[data-supplier-product]").length === 2, "没有跨工厂汇总商品")
    await click(byText("按商品库筛选")); await choose("义乌工厂")
    check(fixture.querySelectorAll("[data-supplier-product]").length === 1 && fixture.textContent?.includes("帆布包"), "工厂筛选无效")
    check(!fixture.querySelector('[data-supplier-product="p1"]'), "筛选仍暴露其他工厂商品")
  })
}

async function productStepsSaveAndGuard() {
  await mounted(seed(), async ({ store, client, configs }) => {
    await click(byText("编辑商品 靠枕"))
    const update = client.supplierDbRowUpdate
    let reject = true
    client.supplierDbRowUpdate = async (...args) => { if (reject) { reject = false; throw { code: "internal", message: "保存失败测试" } }; return update(...args) }
    const title = fixture.querySelector<HTMLInputElement>('input[aria-label="名称"]')!
    await edit(title, "靠枕草稿")
    check(title.value === "靠枕草稿" && title.getAttribute("aria-invalid") === "true", `保存失败丢失输入: value=${title.value}, invalid=${title.getAttribute("aria-invalid")}, committed=${store.getState().details["src-1"].detail!.rows[0].title}`)
    title.focus(); title.blur(); await settle()
    check(store.getState().details["src-1"].detail!.rows[0].title === "靠枕草稿", "重试未保存商品信息")
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="defaults"]')!)
    await until(() => fixture.querySelector('[data-field-key="width"] input'), "Ozon 字段未显示")
    setInput(fixture.querySelector<HTMLInputElement>('[data-field-key="width"] input')!, "400")
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="info"]')!)
    await until(() => fixture.querySelector('[data-active-tab="info"]'), "Ozon 修改未保存并继续")
    check(configs.get("src-1:p1")?.values["fixed:width"]?.[0]?.kind === "integer", "平台字段未保存")
    check(getComputedStyle(fixture.querySelector('[data-supplier-ozon-panel]')!).display === "none", "Ozon 旧面板仍覆盖当前步骤")
    check(fixture.querySelector('[aria-label="规格"]'), "规格输入缺失")
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="ocr"]')!)
    await until(() => fixture.querySelector('[data-supplier-row-copy-fields]'), "AI 配置未显示")
    setInput(fixture.querySelector<HTMLInputElement>('[aria-label="确认属性（俄文）"]')!, "45 см")
    await settle(); await click(byText("返回商品表格"))
    await until(() => document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes("配置尚未保存"), "离开确认未打开")
    check(document.querySelector('[data-slot="dialog-content"]')?.textContent?.includes("配置尚未保存"), "离开未保存配置缺少确认")
    await click(byText("取消", document.querySelector('[data-slot="dialog-content"]')!))
    check(fixture.querySelector<HTMLInputElement>('[aria-label="确认属性（俄文）"]')!.value === "45 см", "取消离开丢失草稿")
    await click(byText("保存并返回"))
    await until(() => !fixture.querySelector('[data-supplier-row-panel]'), "保存后未退出")
    check(store.getState().details["src-1"].detail!.rows[0].promptContent.includes("45 см"), "退出未保存 AI 草稿")
  })
}

async function configValidationFeedback() {
  await mounted(seed(), async ({ configs }) => {
    await click(byText("编辑商品 靠枕"))
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="defaults"]')!)
    await until(() => fixture.querySelector('[data-field-key="width"] input'), "Ozon 字段未显示")
    const notices = () => [...document.querySelectorAll('[data-slot="toast-title"]')].map((node) => node.textContent)
    const successes = () => notices().filter((title) => title === "配置校验通过").length
    const before = successes()
    const put = supplierOzonConfigIO.put

    setInput(fixture.querySelector<HTMLInputElement>('[data-field-key="width"] input')!, "400")
    await until(() => {
      const width = configs.get("src-1:p1")?.values["fixed:width"]?.[0]
      return width?.kind === "integer" && width.value === 400
    }, "字段未自动保存")
    check(successes() === before, "自动保存弹出了手动校验成功提示")
    for (let attempt = 1; attempt <= 2; attempt++) {
      await click(byText("校验配置"))
      await until(() => successes() === before + attempt, "已通过的配置再次校验没有明确提示")
    }

    supplierOzonConfigIO.put = async (...args) => {
      const saved = await put(...args)
      const invalid: SupplierOzonConfigData = { ...saved, state: "needs_reconfiguration", issues: [
        { issue: "field_validation", field_key: "width", code: "required", message: "请填写包装宽度" },
      ] }
      configs.set("src-1:p1", invalid)
      return invalid
    }
    await click(byText("校验配置"))
    await until(() => notices().includes("配置校验未通过"), "校验未通过缺少结果提示")
    check(successes() === before + 2, "未通过的配置误报校验成功")
    const summary = fixture.querySelector('[aria-label="Ozon 配置校验问题"]')
    check(summary === document.activeElement && summary?.textContent?.includes("请填写包装宽度"), "校验未定位到字段问题")

    const count = notices().length
    supplierOzonConfigIO.put = async () => { throw new Error("校验保存失败测试") }
    await click(byText("校验配置"))
    await until(() => fixture.querySelector('[aria-label="Ozon 配置操作"] [role="status"]')?.textContent?.includes("保存失败"), "保存失败缺少重试状态")
    check(successes() === before + 2 && notices().length === count + 1, "保存失败后仍提示了校验结果")
    supplierOzonConfigIO.put = put
    await click(byText("重试保存"))
    await until(() => fixture.querySelector('[aria-label="Ozon 配置操作"] [role="status"]')?.textContent?.includes("已保存"), "失败后重试未保存")
    check(successes() === before + 2, "重试保存弹出了手动校验成功提示")
  })
}

async function variantsInheritAndEditOzonFields() {
  await mounted(seed(), async ({ store, calls, configs, client }) => {
    await click(byText("新增规格"))
    const name = () => document.querySelector<HTMLInputElement>("#supplier-new-variant-name")!
    check(name() && !calls.createRow.length && !document.querySelector('[data-supplier-variant-create] table'), "命名前创建了规格或提前显示资料表格")
    check(byText("创建并填写").hasAttribute("disabled"), "空规格名仍可提交")
    setInput(name(), "取消的规格"); await pressEscape()
    await until(() => !document.querySelector('[data-supplier-variant-create]'), "取消命名没有回到表格")
    check(!calls.createRow.length && fixture.querySelector('[data-supplier-db-table]'), "取消命名创建了空草稿")
    await click(byText("新增规格"))
    setInput(name(), "40×40 cm"); await settle(); await click(byText("创建并填写"))
    check(document.querySelector('[data-supplier-variant-create] [role="alert"]')?.textContent?.includes("已存在") && !calls.createRow.length && name().value === "40×40 cm", "重名规格被提交或输入丢失")
    setInput(name(), "50×50 cm"); await settle()
    const createRow = client.supplierDbRowCreate
    client.supplierDbRowCreate = async () => { throw { code: "internal", message: "创建失败测试" } }
    await click(byText("创建并填写"))
    check(name().value === "50×50 cm" && !calls.createRow.length, "创建失败没有保留名称")
    client.supplierDbRowCreate = createRow
    const loadDetail = store.loadDetail
    store.loadDetail = async (...args) => {
      store.loadDetail = loadDetail
      const get = client.supplierDbGet
      client.supplierDbGet = async () => { throw new Error("读取失败测试") }
      try { await loadDetail(...args) } finally { client.supplierDbGet = get }
    }
    await click(byText("创建并填写"))
    check(calls.createRow.length === 1 && name().disabled && document.querySelector('[data-supplier-variant-create] [role="alert"]')?.textContent?.includes("已创建"), "创建后的读取失败没有保留草稿身份")
    await click(byText("重新读取并继续"))
    await until(() => fixture.querySelector('[data-editor-mode="variant"][data-active-tab="info"]'), "命名后没有进入平台商品信息")
    check(calls.createRow.length === 1 && fixture.querySelectorAll('[data-row-tab]').length === 3, "读取重试重复创建或表单不是三步")
    check(fixture.querySelector('[aria-label="规格"]') && fixture.querySelector('[aria-label="包装宽度（mm）"]') && fixture.querySelector('[data-supplier-row-media]'), "平台商品信息缺少规格、包装或素材")
    await edit(fixture.querySelector<HTMLInputElement>('[aria-label="包装宽度（mm）"]')!, "500")
    await click(byText("保存并继续"))
    await until(() => fixture.querySelector('[data-editor-mode="variant"] [data-field-key="width"] input'), "Ozon 字段编辑未显示")
    const first = store.getState().details["src-1"].detail!.rows[1]
    const width = fixture.querySelector<HTMLInputElement>('[data-field-key="width"] input')!
    check(first.packWidthMm === 500 && width.value === "300" && !width.disabled && !width.readOnly, "实物参数未保存或继承的 Ozon 字段不可编辑")
    setInput(width, "550"); await click(byText("保存并继续"))
    await until(() => fixture.querySelector('[data-active-tab="ocr"] [data-supplier-row-copy-fields]'), "Ozon 修改未保存并进入 AI 配置")
    check(JSON.stringify(["p1", first.productId].map((id) => configs.get(`src-1:${id}`)?.values["fixed:width"])) === JSON.stringify([300, 550].map((value) => [{ kind: "integer", value }])), "本规格的 Ozon 修改覆盖了原规格")
    setInput(fixture.querySelector<HTMLInputElement>('[aria-label="俄文商品类型"]')!, "Подушка")
    setInput(fixture.querySelector<HTMLInputElement>('[aria-label="确认属性（俄文）"]')!, "50 см")
    await settle(); await click(byText("保存并返回"))
    await until(() => !fixture.querySelector('[data-supplier-row-panel]'), "三步表单没有保存并返回")
    await click(byText("2 个规格")); await click(byText("编辑规格 50×50 cm"))
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="ocr"]')!)
    await until(() => fixture.querySelector<HTMLInputElement>('[aria-label="确认属性（俄文）"]')?.value === "50 см", "表格 AI 入口没有打开已保存的规格配置")
    await click(byText("保存并返回"))
    await click(byText("新增规格"))
    setInput(name(), "60×60 cm"); await settle(); await click(byText("创建并填写"))
    await until(() => fixture.querySelector('[data-editor-mode="variant"][data-active-tab="info"]'), "第二个规格没有进入平台商品信息")
    await click(byText("保存并退出"))
    await until(() => !fixture.querySelector('[data-supplier-row-panel]'), "规格配置没有保存退出")
    const saved = store.getState().details["src-1"].detail!.rows
    check(saved.length === 3 && saved.every((item) => item.sourceId === "src-1" && item.variantGroup === "p1"), "新规格的工厂或商品分组错误")
    check(saved[0].promptContent === profile("40 см") && saved[1].promptContent.includes("50 см") && saved[2].promptContent === "", "规格 AI 事实相互覆盖")
    check(fixture.querySelectorAll("table").length === 1, "展开规格产生了第二张表")
    await click(byText("3 个规格")); await click(byText("编辑规格 50×50 cm"))
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="defaults"]')!)
    await until(() => fixture.querySelector<HTMLInputElement>('[data-field-key="width"] input')?.value === "550", "表格 Ozon 入口丢失独立配置")
    setInput(fixture.querySelector<HTMLInputElement>('[data-field-key="width"] input')!, "560")
    await click(byText("Ozon 类目")); await click(byText("清除类目"))
    await until(() => document.querySelector('[data-slot="dialog-description"]')?.textContent?.includes("当前规格"), "类目确认没有说明本规格范围")
    await click(byText("确认更改"))
    await until(() => store.getState().details["src-1"].detail?.rows[1].descriptionCategoryId === null, "Ozon 保存后未能修改当前规格类目")
    const cleared = store.getState().details["src-1"].detail!.rows
    check(cleared[1].descriptionCategoryId === null && cleared[0].descriptionCategoryId === 11 && cleared[2].descriptionCategoryId === 11, "规格类目修改覆盖了同款")
    check(JSON.stringify(configs.get(`src-1:${saved[1].productId}`)?.values["fixed:width"]) === JSON.stringify([{ kind: "integer", value: 560 }]), "更改类目前没有保存 Ozon 字段")
    await click(fixture.querySelector<HTMLElement>('[data-row-tab="ocr"]')!)
    await click(byText("去选择 Ozon 类目"))
    check(fixture.querySelector('[data-editor-mode="variant"][data-active-tab="defaults"]'), "缺少类目时跳到了其他规格")
  })
}

async function bulkKeepsFactory() {
  await mounted([...seed(), { db: db("src-2", "义乌工厂"), propDefs: [], rows: [product("p2", "src-2")] }], async ({ client }) => {
    const published: string[] = []
    const publish = client.supplierDbRowPublish
    client.supplierDbRowPublish = async (sourceId, productId) => { published.push(`${sourceId}:${productId}`); return publish(sourceId, productId) }
    await click(fixture.querySelector<HTMLElement>('[role="checkbox"][aria-label="选择本页全部规格"]')!)
    await click(byText("发布所选"))
    await until(() => published.length === 2, "批量操作未完成")
    check(published.join(",") === "src-1:p1,src-2:p2", "跨工厂操作写入了错误工厂")
  }, "super_admin")
}

async function factoryPermissions() {
  const previous = { ...catalogManagersHttp }
  const listUsers = adminHttp.adminListUsers
  let managers: CatalogManager[] = []
  catalogManagersHttp.list = async () => ({ catalogManagers: managers })
  catalogManagersHttp.grant = async (sourceId, accountUuid) => {
    check(accountUuid === "account-7", "授权未使用公开账号标识")
    const catalogManager = { managerId: "grant-7", sourceId, userId: 7, email: "manager@example.com", name: "商品负责人", status: "active", createdAtMs: 1 }
    managers = [catalogManager]; return { catalogManager }
  }
  catalogManagersHttp.revoke = async (sourceId, id) => { check(sourceId === "src-1" && id === "grant-7", "撤销了其他工厂授权"); managers = managers.map((item) => ({ ...item, status: "disabled" })); return { revoked: true } }
  adminHttp.adminListUsers = async () => ({ workspace_count: 0, user_count: 1, workspaces: [], unaffiliated: [{ account_kind: "platform", uuid: "account-7", email: "manager@example.com", name: "商品负责人", role: "user", kind: "user", role_label: "用户", is_admin: false, created_at: "", status: "active", disabled: false, manageable: true, editable: true }] })
  try {
    await mounted(seed(), async () => {
      await click(byText("工厂绑定")); await click(byText("权限"))
      await until(() => fixture.textContent?.includes("还没有商品负责人"), "负责人未读取")
      await click(byText("添加")); await click(byText("选择商品负责人账号")); await choose("manager@example.com")
      await click(byText("授予本库维护权限")); await until(() => fixture.textContent?.includes("manager@example.com") && managers.length, "授权未生效")
      await click(byText("撤销"))
      await until(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "撤销授权"), "撤销确认未打开")
      await click(byText("撤销授权"))
      await until(() => managers[0].status === "disabled" && fixture.textContent?.includes("已撤销"), "撤销未生效")
    }, "super_admin")
  } finally { Object.assign(catalogManagersHttp, previous); adminHttp.adminListUsers = listUsers }
}

async function factoryFulfillmentBinding() {
  const previous = { ...sourceFulfillersHttp }
  let grants: SourceFulfiller[] = []
  let grantCalls = 0
  sourceFulfillersHttp.list = async () => ({ fulfillers: grants })
  sourceFulfillersHttp.grant = async (sourceId, accountUuid) => {
    check(sourceId === "src-1" && accountUuid === "factory-account", "履约绑定跨工厂或使用了内部数字账号")
    grantCalls++
    const fulfiller = { fulfillerId: "fulfillment-1", sourceId, userId: 1, email: "factory@example.com", name: "验收工厂", status: "active", createdAtMs: 1 }
    grants = [fulfiller]
    throw { code: "cloud_network", message: "response lost after commit" }
  }
  sourceFulfillersHttp.revoke = async (sourceId, id) => {
    check(sourceId === "src-1" && id === "fulfillment-1", "解除其他工厂的履约授权")
    grants = grants.map((grant) => ({ ...grant, status: "disabled" }))
    return { revoked: true }
  }
  try {
    await mounted(seed(), async ({ client, store }) => {
      const get = client.supplierDbGet
      let rejectDetail = false
      client.supplierDbGet = async (sourceId) => {
        if (rejectDetail) { rejectDetail = false; throw { code: "cloud_network", message: "readback unavailable" } }
        const detail = await get(sourceId)
        return { ...detail, db: { ...detail.db, fulfillerEmail: grants.find((grant) => grant.status === "active")?.email } }
      }
      await click(byText("工厂绑定")); await click(byText("权限"))
      await until(() => fixture.querySelector('[aria-label="选择履约账号"]'), "履约账号选择未加载")
      await click(byText("选择履约账号"))
      const choices = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent)
      check(choices.includes("factory@example.com") && !choices.some((text) => text?.includes("disabled@") || text?.includes("other-factory@")), "可选账号未限制本工厂有效成员")
      await choose("factory@example.com"); await click(byText("绑定履约账号"))
      await until(() => fixture.textContent?.includes("绑定结果待核实"), "结果未知仍标记绑定成功")
      check(grantCalls === 1, "未知结果触发重复授权")
      await click(byText("重新读取履约绑定"))
      await until(() => fixture.textContent?.includes("已绑定：factory@example.com"), "未恢复实际已绑定状态")
      check(store.getState().details["src-1"].detail?.db.fulfillerEmail === "factory@example.com", "绑定回读未同步工厂表")
      await click(byText("解除履约绑定"))
      await until(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "解除绑定"), "解除绑定确认未打开")
      rejectDetail = true
      await click(byText("解除绑定"))
      await until(() => fixture.textContent?.includes("解绑结果待核实"), "回读失败仍标记解绑成功")
      await click(byText("重新读取履约绑定"))
      await until(() => fixture.querySelector('[aria-label="选择履约账号"]') && grants[0].status === "disabled", "解绑后仍显示已绑定")
      await click(byText("返回商品库绑定"))
      await until(() => fixture.textContent?.includes("履约：待绑定"), "工厂表未回读待绑定状态")
    }, "super_admin")
  } finally { Object.assign(sourceFulfillersHttp, previous) }
}
export async function ocrResultRecovery() {
  const previousIO = { ...supplierOcrTestsHttp }
  const profile = { product_type_ru: "Кружка", facts_ru: "330 мл" }
  const sourceId = "ocr-ui-review"
  const productId = crypto.randomUUID()
  const id = crypto.randomUUID()
  const overview = peekAccountOverview()
  const scope = `${overview?.session.email ?? ""}:${overview?.active_workspace?.id ?? ""}`
  const key = `podhub.ocr-test:${scope}:${sourceId}:${productId}`
  const saved: SupplierOcrTestResult = {
    id, input: { source_id: sourceId, product_id: productId, profile, fixed_tags: ["#кружка"], image: { bytes: 100, sha256: "a".repeat(64), content_type: "image/png" } },
    state: "succeeded", billing: { request_id: "receipt", model: "vendor-model-debug", status: "settled", charged_microfen: 15400 },
    answer: { ru: 'Кружка 330 мл "Кот"', description: "Кружка 330 мл. Сюжет: Кот.", tags: ["#кружка", "#кот"] },
  }
  let reads = 0
  let purchases = 0
  const refusePurchase = async (): Promise<never> => { purchases++; throw new Error("读取结果不应发起上传或购买") }
  Object.assign(supplierOcrTestsHttp, {
    get: async (readId: string) => { check(readId === id, "读取了其他测试记录"); reads++; return saved },
    upload: refusePurchase, confirm: refusePurchase, run: refusePurchase,
  })
  let currentProfile = profile
  let blocked = false
  let restored = false
  const root = createRoot(fixture)
  const paint = async () => {
    flushSync(() => root.render(<Toaster><SupplierOcrImageTest key={restored ? id : "fresh"}
      sourceId={sourceId} productId={productId} profile={currentProfile} fixedTags={blocked ? [] : saved.input.fixed_tags} disabled={blocked} /></Toaster>))
    await settle()
  }
  try {
    await paint()
    check(!fixture.textContent?.includes("读取本次结果"), "没有记录时仍展示无效的读取入口")
    localStorage.setItem(key, id)
    restored = true
    await paint()
    await click(byText("读取本次结果"))
    check(fixture.textContent?.includes(saved.answer!.ru) && fixture.textContent.includes("实际扣费 ¥0.00015400"), "缺少必要结果或实际扣费")
    check(!fixture.textContent?.includes("vendor-model-debug") && !fixture.textContent?.includes("本次使用"), "仍展示技术模型名或重复输入摘要")
    currentProfile = { ...profile, product_type_ru: "Коврик для мыши" }
    blocked = true
    await paint()
    check(fixture.textContent?.includes("本次结果仅对应测试时输入：Кружка 330 мл"), "配置变化后没有保留旧结果的输入提示")
    await click(byText("读取本次结果"))
    check(reads === 2, "配置未就绪时不能恢复已有付费结果")
    check(purchases === 0, "读取已有结果触发了上传或重新购买")
    check(unexpectedRequests.length === 0, "读取结果触发了未模拟的网络请求")
  } finally {
    flushSync(() => root.unmount())
    localStorage.removeItem(key)
    Object.assign(supplierOcrTestsHttp, previousIO)
    await settle()
  }
}

export async function customPropertyInputs() {
  let current = supplierRow("property-inputs", "src-1")
  let rejectNext = false
  const verify: (condition: unknown, message: string) => void = check
  const writes: Record<string, unknown>[] = []
  function Form() {
    const [row, setRow] = useState({ ...current, props: { text: "原产地", number: 1, long_text: "原备注", select: "a", multi_select: ["a"], checkbox: false } as Record<string, unknown> })
    const [defs, setDefs] = useState(() => (["text", "number", "long_text", "select", "multi_select", "checkbox"] as const).map((type, index) => propDef({
      propId: type, type, name: ["产地", "起订量", "备注", "合作模式", "主营类目", "支持定制"][index],
      options: [{ value: "a", label: "甲" }, { value: "b", label: "乙" }],
    })))
    current = row
    return <div className="flex flex-col gap-3">{defs.map(def => <CustomPropField key={def.propId} def={def} row={row}
      onPatch={async patch => {
        writes.push(patch.props ?? {})
        if (rejectNext) { rejectNext = false; return false }
        setRow(value => ({ ...value, props: patch.props ?? value.props }))
        return true
      }}
      onUpdateProp={async (def, patch) => {
        setDefs(values => values.map(value => value.propId === def.propId ? { ...value, options: patch.options ?? value.options } : value))
        return true
      }} />)}</div>
  }
  const root = createRoot(fixture)
  const field = (name: string) => fixture.querySelector<HTMLElement>(`[aria-label="自定义属性 ${name}"]`)!
  const edit = async (input: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    input.focus(); setInput(input, value); await settle(); input.blur(); await settle()
  }
  try {
    flushSync(() => root.render(<Form />))
    await settle()
    verify(!fixture.querySelector("[data-cell-display]"), "属性仍需先进入单元格编辑态")
    const text = field("产地") as HTMLInputElement
    const number = field("起订量") as HTMLInputElement
    const notes = field("备注") as HTMLTextAreaElement
    verify(text.tagName === "INPUT" && number.tagName === "INPUT" && notes.tagName === "TEXTAREA", "输入控件没有直接显示")
    rejectNext = true
    await edit(text, "新产地")
    verify(text.value === "新产地" && text.getAttribute("aria-invalid") === "true" && !text.disabled,
      `保存失败丢失草稿或未解除禁用：value=${text.value}, invalid=${text.getAttribute("aria-invalid")}, disabled=${text.disabled}, writes=${writes.length}`)
    text.focus(); text.blur(); await settle()
    verify(current.props.text === "新产地", "失焦重试未保存草稿")
    const beforeInvalid = writes.length
    await edit(number, "abc")
    verify(writes.length === beforeInvalid && number.value === "abc" && number.getAttribute("aria-invalid") === "true", "非法数字被写入或草稿丢失")
    await edit(number, "0")
    verify(current.props.number === 0, "零值被当作清空")
    number.focus(); setInput(number, "99"); await pressKey(number, "Escape")
    verify(number.value === "0", "Esc 没有还原数字")
    number.blur(); await settle()
    text.focus(); setInput(text, "输入中")
    const beforeComposition = writes.length
    flushSync(() => text.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })))
    await settle()
    verify(writes.length === beforeComposition && document.activeElement === text, "输入法确认误触保存")
    await pressKey(text, "Escape")
    text.focus(); setInput(text, "回车保存")
    await settle()
    const beforeEnter = writes.length
    await pressKey(text, "Enter")
    verify(writes.length === beforeEnter + 1 && current.props.text === "回车保存", "回车未保存或重复提交")
    rejectNext = true
    await edit(notes, "第一行\n第二行")
    verify(notes.value === "第一行\n第二行" && notes.getAttribute("aria-invalid") === "true", "多行文本失败时丢失草稿")
    notes.focus(); notes.blur(); await settle()
    verify(current.props.long_text === "第一行\n第二行", "多行文本未保存")
    await click(field("合作模式"))
    await click(document.querySelector<HTMLElement>('[data-select-panel] [data-option-value="b"]')!)
    verify(current.props.select === "b", "单选未保存")
    await click(field("合作模式")); await click(byText("清除选项"))
    verify(current.props.select === undefined && field("合作模式").textContent?.includes("请选择"), "单选清空没有显示占位提示")
    await click(field("合作模式"))
    setInput(document.querySelector<HTMLInputElement>("[data-select-panel] input")!, "自营")
    await settle()
    await click(byText("新建「自营」"))
    verify(field("合作模式").textContent?.includes("自营") && current.props.select != null, "新建选项后未选中")
    await click(field("主营类目"))
    await click(document.querySelector<HTMLElement>('[data-multi-select-panel] [data-option-value="b"]')!)
    verify((current.props.multi_select as string[]).length === 2, "多选未追加")
    await click(byText("清除全部"))
    verify((current.props.multi_select as string[]).length === 0, "多选未清空")
    await pressEscape()
    const option = (label: string) => [...document.querySelectorAll<HTMLElement>('[data-slot="select-content"] [role="option"]')].find(value => value.textContent?.trim() === label)!
    await click(field("支持定制")); await click(option("未填写"))
    verify(current.props.checkbox === undefined, "布尔值清空没有删除键")
    await click(field("支持定制")); await click(option("否"))
    verify(current.props.checkbox === false, "布尔 false 未保留")
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
    field("合作模式").dispatchEvent(tab)
    verify(!tab.defaultPrevented, "表单下拉框拦截了 Tab")
    verify(unexpectedRequests.length === 0, "属性编辑触发了未模拟的网络请求")
  } finally { flushSync(() => root.unmount()); await settle() }
}


run.addEventListener("click", async () => {
  run.disabled = true
  unexpectedRequests.length = 0
  const cacheKey = "podhub.workflow.category-tree.v2"
  const previousTree = localStorage.getItem(cacheKey)
  const checks: Array<[string, () => Promise<void>]> = [
    ["先配置工厂 / 新增商品绑定既有工厂", factoryBeforeProduct],
    ["一张商品表 / 工厂筛选", singleTableAndFactoryFilter],
    ["三步流程 / Ozon 隐藏 / 保存失败保稿 / 离开确认", productStepsSaveAndGuard],
    ["手动校验结果 / 重复校验 / 自动保存静默 / 保存失败不误报", configValidationFeedback],
    ["先命名规格 / 失败重试不重复创建 / Ozon 与 AI 独立编辑", variantsInheritAndEditOzonFields],
    ["跨工厂批量操作保留归属", bulkKeepsFactory],
    ["工厂负责人授权与撤销", factoryPermissions],
    ["工厂履约绑定 / 账号隔离 / 结果回读 / 解除绑定", factoryFulfillmentBinding],
    ["AI 图片结果恢复不重复购买", ocrResultRecovery],
    ["自定义属性输入 / 保存失败 / 键盘交互", customPropertyInputs],
  ]
  const lines: string[] = []
  let failed = 0
  try {
    for (const [name, action] of checks) {
      results.textContent = [...lines, `… ${name}`].join("\n")
      try { await action(); lines.push(`✓ ${name}`) }
      catch (reason) { failed++; lines.push(`✗ ${name}: ${reason instanceof Error ? reason.message : String(reason)}`) }
    }
    if (unexpectedRequests.length) { failed++; lines.push(`✗ unexpected fetch: ${unexpectedRequests.join(", ")}`) }
    results.textContent = `${lines.join("\n")}\n${failed ? `${failed} 项失败` : "全部通过"}`
  } finally {
    if (previousTree === null) localStorage.removeItem(cacheKey); else localStorage.setItem(cacheKey, previousTree)
    run.disabled = false
  }
})

run.disabled = false

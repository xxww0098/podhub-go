/** Production surface tested against an ownership-enforcing in-memory server. */
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { SupplierDbsScreen } from "@/features/supplier-dbs/supplier-dbs-screen"
import { createSupplierDbsStore } from "@/features/supplier-dbs/supplier-dbs-store"
import { supplierOzonConfigIO } from "@/features/supplier-dbs/supplier-ozon-config"
import { Toaster } from "@/components/ui/toast"
import { managementClient, managementSeed } from "./supplier-dbs-management.fixtures"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const unexpectedRequests: string[] = []
window.fetch = async (input) => { unexpectedRequests.push(String(input)); throw new Error("Unexpected fixture network request") }
localStorage.setItem("podhub.workflow.category-tree.v1", JSON.stringify({ language: "zh_hans", fetchedAt: new Date().toISOString(), tree: [{ description_category_id: 1, category_name: "测试类目", type_id: 0, type_name: "", disabled: false, children: [] }] }))
supplierOzonConfigIO.get = async () => undefined
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function element(selector: string, root: ParentNode = document): HTMLElement {
  const node = root.querySelector<HTMLElement>(selector)
  check(node, `Missing ${selector}`)
  return node
}
function byText(text: string, root: ParentNode = document): HTMLElement {
  const node = [...root.querySelectorAll<HTMLElement>("button")].find((button) => button.textContent?.trim() === text && !button.closest('[hidden], [inert], [aria-hidden="true"]'))
  check(node, `Missing button ${text}`)
  return node
}
async function click(node: HTMLElement) { check(!node.hasAttribute("disabled"), "Clicked disabled button"); flushSync(() => node.click()); await settle() }
function input(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value)
  flushSync(() => node.dispatchEvent(new Event("input", { bubbles: true })))
}
async function waitFor(predicate: () => boolean, message: string) { for (let i = 0; i < 35; i++) { if (predicate()) return; await settle() } throw new Error(message) }
const panel = () => document.querySelector<HTMLElement>("[data-supplier-row-panel]")
const confirmation = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].find((node) => !node.hasAttribute("data-supplier-row-panel") && node.textContent?.includes("提示词尚未保存"))
const draft = () => element('[data-brief-line="goods"] textarea', panel()!) as HTMLTextAreaElement
async function openRow(productId: string, prompt = false) {
  await click(element(`[data-supplier-db-open="${productId}"]`, fixture))
  check(panel(), "商品详情未打开")
  if (prompt) await click(element('[data-row-tab="prompt"]', panel()!))
}
async function chooseCreator(label: string) {
  await click(element('[aria-label="按库创建人筛选"]', fixture))
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.trim() === label)
  check(option, `Missing owner ${label}`)
  await click(option)
}
async function waitForLibrary(sourceId: string) {
  await waitFor(() => Boolean(fixture.querySelector(`tr[data-supplier-db-row="${sourceId}-1"]`)) || (sourceId === "legacy" && fixture.textContent?.includes("库还没有商品") === true), `Library ${sourceId} 未加载`)
}

type Authority = { role: string; accountUuid: string }
async function mounted(action: (h: { store: ReturnType<typeof createSupplierDbsStore>; calls: ReturnType<typeof managementClient>["calls"]; switchAccount: (authority: Authority) => Promise<void> }) => Promise<void>, initial: Authority = { role: "super_admin", accountUuid: "root" }) {
  let authority = initial
  const { client, calls } = managementClient(managementSeed(), () => authority)
  const store = createSupplierDbsStore(client)
  await store.loadList()
  history.replaceState(null, "", location.pathname + "?screen=supplier-dbs")
  const root = createRoot(fixture)
  const render = () => flushSync(() => root.render(<Toaster><SupplierDbsScreen role={authority.role} accountUuid={authority.accountUuid} store={store} /></Toaster>))
  render()
  await settle()
  try { await action({ store, calls, switchAccount: async (next) => { authority = next; render(); await settle() } }) }
  finally { flushSync(() => root.unmount()); await settle() }
}

const checks: Array<[string, () => Promise<void>]> = [
  ["普通管理员：服务端只给自己的库，切换账号清旧数据", () => mounted(async ({ switchAccount }) => {
    await waitForLibrary("lin")
    check(fixture.textContent?.includes("仅我创建"), "缺少范围说明")
    check(!fixture.textContent?.includes("陈的服装厂"), "普通管理员看到他人库")
    check(!fixture.querySelector('[aria-label="按库创建人筛选"]'), "普通管理员出现跨管理员筛选")
    await openRow("lin-1", true)
    input(draft(), "старый аккаунт"); await settle()
    await switchAccount({ role: "admin", accountUuid: "admin-chen" })
    await waitForLibrary("chen")
    check(!fixture.textContent?.includes("林的印刷厂") && !panel(), "切账号泄露旧详情")
  }, { role: "admin", accountUuid: "admin-lin" })],
  ["旧 root 会话降为普通 admin：全库缓存、计数和旧编辑会话收窄", () => mounted(async ({ switchAccount, store, calls }) => {
    await waitForLibrary("lin")
    await click(element('[data-supplier-db-row="chen"]', fixture)); await waitForLibrary("chen")
    await openRow("chen-1", true)
    input(draft(), "старый root черновик"); await settle()
    const oldPanel = panel()!
    await switchAccount({ role: "admin", accountUuid: "admin-lin" })
    await waitForLibrary("lin")
    check(!panel() && !fixture.textContent?.includes("陈的服装厂"), "降权保留他人库或旧编辑会话")
    check(store.getState().dbs.length === 1 && store.getState().dbs[0].rowCount === 2, "降权沿用旧库计数")
    check(!store.getState().details.chen, "降权保留他人 rows 缓存")
    const before = calls.length
    oldPanel.querySelector<HTMLButtonElement>('[aria-label="关闭行详情"]')?.click()
    await settle()
    check(calls.length === before && !panel(), "旧编辑会话可继续影响新会话")
  }, { role: "super_admin", accountUuid: "admin-lin" })],
  ["超级管理员：按创建人落库，范围切换清详情，迟到响应不能露旧库", () => mounted(async ({ store }) => {
    await waitForLibrary("lin")
    check(fixture.textContent?.includes("陈的服装厂") && fixture.textContent?.includes("历史归属库"), "超级管理员未看到全部")
    await openRow("lin-1")
    await chooseCreator("陈管理员创建"); await waitForLibrary("chen")
    check(!panel() && !fixture.textContent?.includes("林的印刷厂"), "筛选范围没有清旧详情")
    await store.loadDetail("lin", { force: true }); await settle()
    check(!fixture.textContent?.includes("印花帆布袋"), "旧库响应恢复到了新范围")
    check(new URLSearchParams(location.search).get("open") === "chen", "范围切换没有自动落库")
    await chooseCreator("历史归属未知"); await waitForLibrary("legacy")
    check(fixture.textContent?.includes("新建商品") && fixture.textContent?.includes("库设置"), "超级管理员维护能力被删除")
  })],
  ["范围与库切换：提示词草稿取消保留，确认丢弃", () => mounted(async () => {
    await waitForLibrary("lin"); await openRow("lin-1", true)
    input(draft(), "черновик范围"); await settle()
    await chooseCreator("陈管理员创建")
    check(confirmation(), "范围切换绕过草稿确认")
    await click(byText("取消", confirmation()!))
    check(draft().value === "черновик范围", "取消范围切换丢草稿")
    await click(element('[data-supplier-db-row="chen"]', fixture))
    check(confirmation(), "库切换绕过草稿确认")
    await click(byText("取消", confirmation()!))
    check(draft().value === "черновик范围", "取消换库丢草稿")
    await chooseCreator("陈管理员创建")
    await click(byText("丢弃草稿并切换", confirmation()!)); await waitForLibrary("chen")
    check(!panel(), "确认换范围仍保留旧详情")
  })],
  ["上一件／下一件：取消保留草稿，确认切换不串稿", () => mounted(async () => {
    await waitForLibrary("lin"); await openRow("lin-1", true)
    check(byText("上一件", panel()!).hasAttribute("disabled"), "首件上一件未禁用")
    input(draft(), "Локальный черновик"); await settle()
    await click(byText("下一件", panel()!)); check(confirmation(), "下一件绕过提示词草稿确认")
    await click(byText("取消", confirmation()!)); check(draft().value === "Локальный черновик", "取消下一件丢草稿")
    await click(byText("下一件", panel()!)); await click(byText("丢弃草稿并离开", confirmation()!))
    check(panel()?.getAttribute("aria-label")?.includes("棉质手提袋"), "下一件没切换")
    check(byText("下一件", panel()!).hasAttribute("disabled"), "末件下一件未禁用")
    await click(element('[data-row-tab="prompt"]', panel()!)); check(draft().value === "", "上一件草稿串进新商品")
    await click(byText("上一件", panel()!)); check(panel()?.getAttribute("aria-label")?.includes("印花帆布袋"), "上一件没切换")
  })],
  ["批量操作条：上架／下架／归档／删除保留，筛选清隐藏选择", () => mounted(async ({ calls }) => {
    await waitForLibrary("lin"); check(!fixture.querySelector("[data-bulk-bar]"), "未选择就显示批量条")
    await click(element('[aria-label="选择本页全部行"]', fixture))
    check(fixture.querySelector("[data-bulk-bar]")?.textContent?.includes("已选择 2 件"), "缺少选择数量")
    await click(element('[data-bulk-action="publish"]', fixture)); check(calls.filter((call) => call.kind === "publish").length === 2, "批量上架没写两行")
    await click(element('[data-bulk-action="unpublish"]', fixture)); check(calls.filter((call) => call.kind === "unpublish").length === 2, "批量下架丢失")
    input(element('[aria-label="搜索商品"]', fixture) as HTMLInputElement, "棉质"); await settle()
    check(!fixture.querySelector("[data-bulk-bar]"), "筛选后仍批量作用隐藏行")
    await click(element('[aria-label="选择本页全部行"]', fixture)); await click(element('[data-bulk-menu]', fixture)); await click(element('[data-bulk-action="archive"]')); await click(byText("归档 1 行"))
    check(calls.some((call) => call.kind === "archive" && call.productId === "lin-2"), "批量归档没写选择行")
    input(element('[aria-label="搜索商品"]', fixture) as HTMLInputElement, ""); await settle()
    await click(element('[aria-label="选择本页全部行"]', fixture)); await click(element('[data-bulk-menu]', fixture)); await click(element('[data-bulk-action="delete"]')); await click(byText("删除 1 行"))
    check(calls.some((call) => call.kind === "delete" && call.productId === "lin-1"), "批量删除丢失")
  })],
  ["编辑保持行 CAS 和库设置入口", () => mounted(async ({ calls }) => {
    await waitForLibrary("lin"); await click(byText("库设置", fixture))
    for (const label of ["编辑库信息", "自定义属性", "厂家账号", "删除库"]) check(document.querySelector(`[data-db-menu="${label}"]`), `丢失库设置 ${label}`)
    await click(byText("库设置", fixture)); await openRow("lin-1")
    const name = element('[aria-label="名称"]', panel()!) as HTMLInputElement
    name.focus(); input(name, "改名帆布袋"); name.blur(); await settle()
    check(calls.some((call) => call.kind === "CAS" && call.revision === 1), "编辑没有沿用 expectedRevision")
    await click(byText("完成", panel()!)); check(fixture.textContent?.includes("改名帆布袋"), "编辑结果未更新商品表")
  })],
]
document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  results.textContent = "运行中…"; unexpectedRequests.length = 0
  const lines: string[] = []; let failed = 0
  for (const [name, action] of checks) {
    try { await action(); lines.push(`✓ ${name}`) }
    catch (error) { failed++; lines.push(`✗ ${name}: ${error instanceof Error ? error.message : String(error)}`) }
    results.textContent = lines.join("\n")
  }
  if (unexpectedRequests.length) { failed++; lines.push(`✗ ${unexpectedRequests.length} unexpected requests`) }
  results.textContent = `${lines.join("\n")}\n${failed ? `${failed} 项失败` : "全部通过"}`
})

// Visual QA renders the shipped components, with sample photography only in this fixture.
const previewStore = createSupplierDbsStore(managementClient(managementSeed()).client)
await previewStore.loadList()
history.replaceState(null, "", location.pathname + "?screen=supplier-dbs")
createRoot(document.querySelector<HTMLDivElement>("#preview")!).render(<Toaster><SupplierDbsScreen role="super_admin" accountUuid="root" store={previewStore} /></Toaster>)

/** Real drawer interactions against the parent fixture's in-memory Cloud client. */
import type { SupplierDbDetail, SupplierDbRow } from "@/bindings/http-supplier-dbs"

type Harness = {
  mounted: (seed: SupplierDbDetail[], action: () => Promise<void>) => Promise<void>
  seedDetail: SupplierDbDetail
  supplierRow: (productId: string, sourceId: string) => SupplierDbRow
  waitForDb: (sourceId: string, name: string) => Promise<void>
  openRowPanel: (productId: string, pane?: "info" | "prompt" | "defaults") => Promise<void>
  click: (element: HTMLElement) => Promise<void>
  byText: (text: string, root?: ParentNode) => HTMLElement
  setInput: (input: HTMLInputElement | HTMLTextAreaElement, value: string) => void
  settle: () => Promise<void>
  pressEscape: () => Promise<void>
  check: (value: unknown, message: string) => asserts value
}

export function drawerDraftChecks(h: Harness): Array<[string, () => Promise<void>]> {
  const check: Harness["check"] = h.check
  const panel = () => document.querySelector<HTMLElement>("[data-supplier-row-panel]")
  const goods = () => panel()?.querySelector<HTMLTextAreaElement>('[data-brief-line="goods"] textarea')
  const confirmation = () => [...document.querySelectorAll<HTMLElement>('[role="dialog"]')]
    .find((element) => !element.hasAttribute("data-supplier-row-panel") && element.textContent?.includes("提示词尚未保存"))
  const setup = async (action: () => Promise<void>) => {
    const seed = { ...h.seedDetail, db: { ...h.seedDetail.db, rowCount: 2 }, rows: [
      h.seedDetail.rows[0]!, { ...h.supplierRow("p2", "src-1"), title: "收纳盒", platformCode: "P002" },
    ] }
    await h.mounted([seed], async () => {
      await h.waitForDb("src-1", "美国3C厂")
      await h.openRowPanel("p1", "prompt")
      await action()
    })
  }
  return [
    ["去选择类目直接打开选择器，Escape 保留商品详情", () => setup(async () => {
      await h.click(panel()!.querySelector<HTMLElement>('[data-row-tab="defaults"]')!)
      const openCategory = () => h.byText("去选择类目", panel()!)
      check(!document.querySelector("[data-category-picker]"), "类目选择器提前打开")
      await h.click(openCategory())
      const picker = document.querySelector<HTMLElement>("[data-category-picker]")
      check(picker, "去选择类目只聚焦控件，没有打开选择器")
      check(picker.querySelector('[aria-label="搜索类目"]'), "缺少类目搜索输入")
      await h.pressEscape()
      check(panel(), "关闭类目选择器时关闭了商品详情")
      check(panel()!.querySelector('[aria-label="Ozon 类目"]')?.getAttribute("aria-expanded") === "false", "Escape 未关闭类目选择器")
      await h.click(openCategory())
      check(panel()!.querySelector('[aria-label="Ozon 类目"]')?.getAttribute("aria-expanded") === "true", "类目选择器关闭后无法再次打开")
      await h.pressEscape()
    })],
    ["空提示词保持 pristine，关闭不误报草稿", () => setup(async () => {
      check(goods(), "六行构建器未挂载")
      const save = panel()!.querySelector<HTMLButtonElement>("[data-brief-save]")!
      check(save.disabled, "未编辑的空稿启用了保存")
      check(!panel()!.textContent?.includes("提示词草稿待保存"), "未编辑的空稿被标记 dirty")
      await h.click(panel()!.querySelector<HTMLElement>('[aria-label="关闭行详情"]')!)
      check(!confirmation(), "未编辑空稿出现丢弃确认")
      check(!panel(), "未编辑空稿未直接关闭")
    })],
    ["提示词跨主页签保留草稿", () => setup(async () => {
      h.setInput(goods()!, "Картина на холсте")
      await h.settle()
      await h.click(panel()!.querySelector<HTMLElement>('[data-row-tab="info"]')!)
      await h.click(panel()!.querySelector<HTMLElement>('[data-row-tab="prompt"]')!)
      check(goods()?.value === "Картина на холсте", "切页签丢失六行草稿")
      check(panel()!.textContent?.includes("提示词草稿待保存"), "切页签丢失 dirty 标记")
    })],
    ["背景切商品先确认：取消保留，确认切换", () => setup(async () => {
      h.setInput(goods()!, "Локальный черновик")
      await h.settle()
      const other = document.querySelector<HTMLElement>('tr[data-supplier-db-row="p2"]')!
      await h.click(other)
      check(confirmation(), "背景切行绕过草稿确认")
      await h.click(h.byText("取消", confirmation()!))
      check(panel()?.getAttribute("aria-label")?.includes("圣诞帽"), "取消后切到了另一商品")
      check(goods()?.value === "Локальный черновик", "取消后草稿丢失")
      await h.click(other)
      check(confirmation(), "再次切行未确认")
      await h.click(h.byText("丢弃草稿并切换", confirmation()!))
      check(panel()?.getAttribute("aria-label")?.includes("收纳盒"), "确认后未切商品")
      await h.click(panel()!.querySelector<HTMLElement>('[data-row-tab="prompt"]')!)
      check(goods()?.value === "", "旧商品草稿串入新商品")
    })],
    ["输入框与正文 Escape 只撤销，不关闭抽屉", () => setup(async () => {
      await h.click(panel()!.querySelector<HTMLElement>('[data-row-tab="info"]')!)
      const title = panel()!.querySelector<HTMLInputElement>('[aria-label="名称"]')!
      title.focus()
      h.setInput(title, "未保存名称")
      await h.pressEscape()
      check(panel(), "输入框 Escape 关闭了抽屉")
      check(title.value === "圣诞帽", "Escape 未撤销名称草稿")
      const description = panel()!.querySelector<HTMLTextAreaElement>('[aria-label="商品描述"]')!
      description.focus()
      h.setInput(description, "未保存描述")
      await h.pressEscape()
      check(panel(), "正文 Escape 关闭了抽屉")
      check(description.value === "", "Escape 未撤销正文草稿")
    })],
  ]
}

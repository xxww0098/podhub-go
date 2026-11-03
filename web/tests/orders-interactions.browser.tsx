import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { AdminPaymentOrderView } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { OrdersScreen } from "@/features/orders/orders-screen"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

run.onclick = async () => {
  run.disabled = true
  delete results.dataset.result
  const original = { list: adminHttp.adminListOrders, confirm: adminHttp.adminConfirmOrder, cancel: adminHttp.adminCancelOrder, fetch: window.fetch }
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  const root = createRoot(fixture)
  const all: AdminPaymentOrderView[] = Array.from({ length: 12 }, (_, index) => ({
    public_id: `ORDER-${String(index + 1).padStart(2, "0")}`,
    org_id: index % 2 + 1,
    workspace_name: `工作空间 ${index % 2 + 1}`,
    created_by_email: "fixture@example.invalid",
    plan: "pro",
    months: 1,
    amount_cents: 2000,
    currency: "CNY",
    provider: "manual",
    status: index % 3 === 0 ? "pending" : index % 3 === 1 ? "paid" : "canceled",
    created_at: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
  } as AdminPaymentOrderView))
  let rows = all
  let reads = 0
  let failNext = false
  let writes = 0
  let copied = ""
  const settle = async (predicate: () => boolean, message: string) => {
    const deadline = performance.now() + 3000
    while (!predicate()) { check(performance.now() < deadline, message); await frame() }
  }
  const findButton = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === name)
  const setInput = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value)
    element.dispatchEvent(new Event("input", { bubbles: true }))
  }
  try {
    window.fetch = async () => { throw new Error("unexpected network request") }
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (value: string) => { copied = value } } })
    adminHttp.adminListOrders = async () => {
      if (++reads === 1 || failNext) { failNext = false; throw new Error("fixture read failed") }
      return rows
    }
    adminHttp.adminConfirmOrder = async () => { writes++; throw new Error("unexpected confirmation") }
    adminHttp.adminCancelOrder = async () => { writes++; throw new Error("unexpected cancellation") }
    flushSync(() => root.render(<OrdersScreen />))
    await settle(() => !!findButton("重试"), "failed load did not offer retry")
    check(!fixture.textContent?.includes("暂无订单"), "failed load was presented as empty")
    findButton("重试")!.click()
    await settle(() => !!fixture.querySelector('[title="ORDER-12"]'), "ledger did not load")
    check(!fixture.querySelector('[title="ORDER-01"]') && fixture.textContent?.includes("本次筛选 12 条"), "first page/count incorrect")
    const select = fixture.querySelector<HTMLButtonElement>('[aria-label="选择订单 ORDER-12"]')!
    select.click()
    await settle(() => fixture.textContent?.includes("复制已选订单号（1）") === true, "selection has no action")
    findButton("复制已选订单号（1）")!.click()
    await settle(() => copied === "ORDER-12", "selected order number was not copied")
    fixture.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()
    await settle(() => !!fixture.querySelector('[title="ORDER-01"]'), "next page did not load")
    await settle(() => !fixture.textContent?.includes("复制已选订单号"), "selection stayed after changing page")
    fixture.querySelector<HTMLButtonElement>('[aria-label="按时间升序排列"]')!.click()
    await settle(() => !!fixture.querySelector('[title="ORDER-01"]') && !!fixture.querySelector('[aria-label="按时间降序排列"]'), "sort did not reset to first page")
    check(fixture.querySelector('th[aria-sort="ascending"]') && !fixture.querySelector('[title="ORDER-12"]'), "ascending sort incorrect")
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选已支付，4 个"]')!.click()
    await settle(() => fixture.textContent?.includes("本次筛选 4 条") === true, "status filter incorrect")
    check(fixture.querySelectorAll('tbody tr').length === 4, "status filter returned wrong rows")
    const search = fixture.querySelector<HTMLInputElement>('input[aria-label^="搜索单号"]')!
    setInput(search, "ORDER-05")
    await settle(() => !!fixture.querySelector('[title="ORDER-05"]') && fixture.textContent?.includes("本次筛选 1 条") === true, "combined search incorrect")
    fixture.querySelector<HTMLButtonElement>('[aria-label="清空搜索"]')!.click()
    fixture.querySelector<HTMLButtonElement>('[aria-label="筛选全部，12 个"]')!.click()
    await settle(() => !!fixture.querySelector('[title="ORDER-01"]'), "filters did not reset")
    const firstRow = fixture.querySelector('[title="ORDER-01"]')!.closest("tr")!
    firstRow.querySelector<HTMLButtonElement>('[aria-label="订单 ORDER-01 的更多操作"]')!.click()
    await settle(() => !![...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "确认收款"), "order menu did not open")
    ;[...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent?.trim() === "确认收款")!.click()
    await settle(() => !!findButton("确认入账"), "confirmation did not open")
    ;[...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent?.trim() === "取消")!.click()
    await settle(() => !findButton("确认入账"), "confirmation did not close")
    check(writes === 0, "cancel triggered a write")
    failNext = true
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新订单"]')!.click()
    await settle(() => fixture.textContent?.includes("刷新失败，当前显示上次读取的数据。") === true, "failed refresh not shown")
    check(!!fixture.querySelector('[title="ORDER-01"]'), "failed refresh discarded ledger")
    check(firstRow.querySelector<HTMLButtonElement>('[aria-label="订单 ORDER-01 的更多操作"]')?.disabled, "write actions remain enabled after failed refresh")
    fixture.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click()
    await settle(() => !!fixture.querySelector('[title="ORDER-12"]'), "second page unavailable")
    rows = all.slice(0, 3)
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新订单"]')!.click()
    await settle(() => fixture.textContent?.includes("本次筛选 3 条") === true, "refresh did not shrink list")
    check(fixture.querySelector('[aria-label="第 1 页，共 1 页"]'), "page did not clamp after refresh")
    rows = all
    fixture.querySelector<HTMLButtonElement>('[aria-label="刷新订单"]')!.click()
    await settle(() => fixture.textContent?.includes("本次筛选 12 条") === true, "refresh did not restore list")
    check(fixture.querySelector('[aria-label="第 1 页，共 2 页"]') && !!fixture.querySelector('[title="ORDER-01"]'), "stale page returned after list expanded")
    results.textContent = "PASS: failed load/retry, selection, sorting, filters, paging, cancel without writes, and stale write protection"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = `FAIL: ${reason instanceof Error ? reason.message : String(reason)}`
    results.dataset.result = "fail"
  } finally {
    flushSync(() => root.unmount())
    adminHttp.adminListOrders = original.list
    adminHttp.adminConfirmOrder = original.confirm
    adminHttp.adminCancelOrder = original.cancel
    window.fetch = original.fetch
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
    run.disabled = false
  }
}

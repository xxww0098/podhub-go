import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { delegateHttp, type DelegateOrder } from "@/features/delegate/delegate-http"
import { DelegateOrdersView } from "@/features/delegate/delegate-orders-view"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const root = createRoot(fixture)
const originalList = delegateHttp.listOrders
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
let copied = ""
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
function button(label: string) {
  const element = fixture.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  check(element, `缺少按钮 ${label}`)
  return element
}
function checkbox(label: string) {
  const element = fixture.querySelector<HTMLElement>(`[role="checkbox"][aria-label="${label}"]`)
  check(element, `缺少复选框 ${label}`)
  return element
}
async function click(element: HTMLElement) { flushSync(() => element.click()); await settle() }
const order = (posting: string): DelegateOrder => ({
  order_id: posting, store_id: "test-store", posting_number: posting, state: "ready", cancel_requested: false,
  created_at_ms: 1, updated_at_ms: 1, posting_snapshot: {}, seller_note: "", lines: [],
})

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  const calls: Parameters<typeof delegateHttp.listOrders>[0][] = []
  let failNext = true
  let showSecond = true
  delegateHttp.listOrders = async (params) => {
    calls.push(params)
    if (params.cursor === "next" && failNext) { failNext = false; throw new Error("测试读取失败") }
    if (params.search) return { orders: [order("SEARCH-1")], has_next: false, cursor: "" }
    return params.cursor
      ? { orders: [order("PAGE-2")], has_next: false, cursor: "" }
      : { orders: showSecond ? [order("PAGE-1"), order("PAGE-1B")] : [order("PAGE-1")], has_next: true, cursor: "next" }
  }
  try {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
    flushSync(() => root.render(<DelegateOrdersView storeId="test-store" refreshKey={0} />))
    await settle()
    check(fixture.textContent?.includes("PAGE-1"), "未显示第一页")
    check(calls.at(-1)?.limit === 10, "默认每页数量应为 10")
    await click(checkbox("选择委托单 PAGE-1"))
    check(fixture.textContent?.includes("复制所选单号（1）"), "选中后未显示批量操作")
    check(!fixture.querySelector('[role="dialog"]'), "勾选不应打开详情")
    await click(checkbox("选择本页全部委托单"))
    check(fixture.textContent?.includes("复制所选单号（2）"), "全选未包含本页订单")
    const copy = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.includes("复制所选单号"))
    check(copy, "缺少复制按钮")
    await click(copy)
    check(copied === "PAGE-1\nPAGE-1B", "复制结果没有按列表顺序包含已选单号")
    showSecond = false
    await click(button("刷新委托单"))
    check(fixture.textContent?.includes("复制所选单号（1）") && !fixture.textContent?.includes("PAGE-1B"), "刷新后消失的订单仍留在选择中")
    await click(button("下一页"))
    check(fixture.textContent?.includes("PAGE-1") && !fixture.textContent?.includes("PAGE-2"), "失败后未保留第一页")
    check(fixture.textContent?.includes("读取失败，显示上次结果"), "刷新失败未标明数据已过时")
    check(fixture.querySelector('[aria-label="第 1 页"]'), "失败后页码发生变化")
    await click(button("下一页"))
    check(fixture.textContent?.includes("PAGE-2") && fixture.querySelector('[aria-label="第 2 页"]'), "重试后未进入第二页")
    const input = fixture.querySelector<HTMLInputElement>('input[aria-label="搜索物流单号或厂家"]')
    check(input, "缺少搜索输入")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  厂家%  ")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    input.dispatchEvent(new Event("change", { bubbles: true }))
    flushSync(() => input.form!.requestSubmit())
    await settle()
    check(calls.at(-1)?.search === "厂家%" && !calls.at(-1)?.cursor, "搜索未发送完整关键词或未回到第一页")
    check(fixture.textContent?.includes("SEARCH-1") && fixture.querySelector('[aria-label="第 1 页"]'), "未显示搜索结果")
    const size = fixture.querySelector<HTMLElement>('[aria-label="每页条数"]')
    check(size, "缺少每页条数")
    await click(size)
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("20 条/页"))
    check(option, "缺少 20 条选项")
    await click(option)
    check(calls.at(-1)?.limit === 20 && !calls.at(-1)?.cursor, "更改条数未重置游标或请求数量")
    results.textContent = "PASS: 选中复制、失败保留并标记旧页、重试翻页、搜索及每页条数"
  } catch (error) {
    results.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    delegateHttp.listOrders = originalList
    if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
    else Reflect.deleteProperty(navigator, "clipboard")
    flushSync(() => root.render(null))
  }
})

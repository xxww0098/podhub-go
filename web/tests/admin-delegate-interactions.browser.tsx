import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { AdminDelegateOrdersScreen } from "@/features/delegate/admin-delegate-orders-screen"
import type { AdminDelegateOrderRow } from "@/bindings/http-delegate-admin"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const root = createRoot(fixture)
const originalFetch = window.fetch
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() { await frame(); await frame() }
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function waitFor(predicate: () => unknown, message: string) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (predicate()) return
    await frame()
  }
  throw new Error(message)
}
function button(label: string) {
  const element = fixture.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  check(element, `缺少按钮 ${label}`)
  return element
}
async function click(element: HTMLElement) { flushSync(() => element.click()); await settle() }
const row = (posting: string): AdminDelegateOrderRow => ({
  order_id: posting, org_id: 1, store_id: "store-1", posting_number: posting, state: "ready",
  cancel_requested: false, line_count: 1, source_names: ["一厂"], created_at_ms: 1, updated_at_ms: 1,
})
const response = (orders: AdminDelegateOrderRow[], hasNext = false) => Response.json({
  data: { orders, has_next: hasNext, cursor: hasNext ? "next" : "" },
})

document.querySelector<HTMLButtonElement>("#run")!.addEventListener("click", async () => {
  let first = true
  let sourceCalls = 0
  const requests: URL[] = []
  let releaseOld: ((value: Response) => void) | undefined
  let releaseOldSource: ((value: Response) => void) | undefined
  window.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href)
    if (url.pathname === "/api/admin/factories") {
      sourceCalls += 1
      if (sourceCalls === 3) return new Promise<Response>((resolve) => { releaseOldSource = resolve })
      return sourceCalls === 1 ? Response.json({ code: "INTERNAL", message: "厂家读取失败" }, { status: 500 }) : Response.json({ data: { factories: [{ factory_id: "f1", name: "一厂", country: "CN", contact: "", internal_note: "", icon: "", created_at_ms: 1, updated_at_ms: 1, libraries: [{ source_id: "s1", name: "一号库", country: "CN", icon: "" }, { source_id: "s2", name: "二号库", country: "CN", icon: "" }] }] } })
    }
    if (url.pathname === "/api/admin/delegate-orders/NEW") return Response.json({ code: "INTERNAL", message: "详情读取失败" }, { status: 500 })
    if (url.pathname !== "/api/admin/delegate-orders") throw new Error(`unexpected request ${url.pathname}`)
    requests.push(url)
    if (first) { first = false; return Response.json({ code: "INTERNAL", message: "读取失败" }, { status: 500 }) }
    if (url.searchParams.get("orgId") === "1") return new Promise<Response>((resolve) => { releaseOld = resolve })
    if (url.searchParams.get("orgId") === "2") return response([row("NEW")])
    return url.searchParams.has("cursor") ? response([row("PAGE-2")]) : response([row("PAGE-1")], true)
  }
  try {
    flushSync(() => root.render(<AdminDelegateOrdersScreen />))
    await waitFor(() => fixture.textContent?.includes("无法读取委托单"), "读取失败被显示为空列表")
    const retry = [...fixture.querySelectorAll("button")].find((item) => item.textContent === "重试")
    check(retry, "缺少重试")
    await click(retry)
    await waitFor(() => fixture.textContent?.includes("PAGE-1"), "重试未显示第一页")
    check(fixture.textContent?.includes("商品库列表读取失败"), "厂家列表错误未显示")
    await click(button("刷新委托单"))
    await waitFor(() => sourceCalls === 2 && !fixture.textContent?.includes("商品库列表读取失败"), "刷新未重试厂家列表")
    await click(button("刷新委托单"))
    await waitFor(() => releaseOldSource && fixture.querySelector('button[aria-label="刷新委托单"]:not(:disabled)'), "旧厂家请求未发出")
    await click(button("刷新委托单"))
    await waitFor(() => sourceCalls === 4, "新厂家请求未发出")
    check(releaseOldSource, "旧厂家请求缺少回调")
    releaseOldSource(Response.json({ code: "INTERNAL", message: "旧请求失败" }, { status: 500 }))
    await settle()
    check(!fixture.textContent?.includes("商品库列表读取失败"), "旧厂家响应覆盖了新结果")
    await click(button("按商品库过滤"))
    await waitFor(() => document.body.textContent?.includes("一号库") && document.body.textContent?.includes("二号库"), "同一工厂的两本商品库未出现在筛选中")
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    await settle()
    check(requests.at(-1)?.searchParams.get("limit") === "10", "默认页大小没有传给接口")
    const selectFirst = fixture.querySelector<HTMLElement>('[aria-label="选择委托单 PAGE-1"]')
    check(selectFirst, "缺少行选择框")
    await click(selectFirst)
    await waitFor(() => fixture.textContent?.includes("复制已选单号（1）"), "勾选没有产生可用操作")
    check(button("查看委托单 PAGE-1"), "勾选误打开了详情")
    await click(button("下一页"))
    await waitFor(() => fixture.textContent?.includes("PAGE-2"), "未显示第二页")
    check(!fixture.textContent?.includes("复制已选单号"), "换页后保留了不可见的选中项")
    await click(button("每页条数"))
    await waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((item) => item.textContent?.trim() === "20 条/页"), "页大小选项未展开")
    const size20 = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.trim() === "20 条/页")!
    await click(size20)
    await waitFor(() => requests.at(-1)?.searchParams.get("limit") === "20" && fixture.textContent?.includes("PAGE-1"), "调整页大小未返回第一页")
    check(!requests.at(-1)?.searchParams.has("cursor"), "调整页大小仍携带旧游标")
    await click(button("下一页"))
    await waitFor(() => fixture.textContent?.includes("PAGE-2"), "调整页大小后无法进入下一页")
    await click(button("上一页"))
    await waitFor(() => fixture.textContent?.includes("PAGE-1"), "上一页未恢复")
    const search = fixture.querySelector<HTMLInputElement>('input[aria-label="搜索本页物流单号"]')
    check(search, "缺少本页搜索")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "不存在")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() => fixture.textContent?.includes("本页没有匹配的物流单号"), "本页搜索未过滤")
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(search, "")
    search.dispatchEvent(new Event("input", { bubbles: true }))
    const org = fixture.querySelector<HTMLInputElement>("#admin-delegate-org")
    check(org, "缺少工作空间筛选")
    for (const value of ["1", "2"]) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(org, value)
      org.dispatchEvent(new Event("input", { bubbles: true }))
      await settle()
      if (value === "1") {
        await waitFor(() => fixture.querySelector('button[aria-label="正在刷新委托单"][aria-busy="true"][disabled] [data-slot="spinner"]'), "读取期间未显示刷新状态")
      }
    }
    await waitFor(() => releaseOld && fixture.textContent?.includes("NEW"), "新工作空间数据未显示")
    check(releaseOld, "旧请求未发出")
    releaseOld(response([row("OLD")]))
    await settle()
    check(fixture.textContent?.includes("NEW") && !fixture.textContent?.includes("OLD"), "旧响应覆盖了新筛选结果")
    check(button("查看委托单 NEW"), "缺少键盘可用的详情入口")
    await click(button("查看委托单 NEW"))
    await waitFor(() => fixture.textContent?.includes("无法读取委托单详情"), "详情错误被显示为无限加载")
    const back = [...fixture.querySelectorAll("button")].find((item) => item.textContent === "返回队列")
    check(back, "详情错误没有返回入口")
    await click(back)
    await waitFor(() => fixture.textContent?.includes("PAGE-1"), "详情错误后无法返回队列")
    results.textContent = "PASS: 失败重试、选择、游标与页大小、本页搜索、筛选竞态和详情错误"
  } catch (error) {
    results.textContent = `FAIL: ${error instanceof Error ? error.message : String(error)}`
  } finally {
    window.fetch = originalFetch
    flushSync(() => root.render(null))
  }
})

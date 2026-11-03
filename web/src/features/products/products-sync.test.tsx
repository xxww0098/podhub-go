/** Browser regression over the production screen; every business request is fake. */
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { route } from "@/api/routes"
import { ScreenPane } from "@/components/screen-pane"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { StoreProductOverviewRow } from "./products-api"
import { PRODUCTS_POLL_INTERVAL_MS, ProductsScreen } from "./products-screen"

export async function runProductsSyncRegression(host: HTMLElement) {
  const originalFetch = globalThis.fetch
  const originalInterval = window.setInterval
  const originalClearInterval = window.clearInterval
  const calls: string[] = []
  let poll: (() => void) | undefined
  let completed = false
  let failOverview = false
  let cooldown = 0
  const initialStamp = Date.now() - 60_000
  const storeIDs = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]
  const overviewPath = route("workspacesProductsOverview")
  const productsPath = route("workspacesProducts")
  const check = (value: unknown, message: string) => { if (!value) throw new Error(message) }
  async function until(predicate: () => boolean, message: string) {
    const deadline = performance.now() + 4_000
    while (!predicate()) {
      check(performance.now() < deadline, message)
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }
  const overviewReads = () => calls.filter((call) => call === `GET ${overviewPath}`).length
  const listReads = () => calls.filter((call) => call.startsWith(`GET ${productsPath}?`) || call === `GET ${productsPath}`).length
  const updateButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("全部更新"))
  const singleUpdateButton = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "立即更新")
  async function chooseStore(label: string) {
    host.querySelector<HTMLButtonElement>('[aria-label="当前店铺"]')!.click()
    const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes(label))
    await until(() => Boolean(option()), "store options did not open")
    option()!.click()
  }
  const stores = (): StoreProductOverviewRow[] => storeIDs.map((store_id, index) => ({
    store_id, name: `店铺 ${index + 1}`, status: "active", freshness: "fresh", currency: "CNY",
    count_total: 1, count_on_sale: 1, count_hidden: 0, count_moderation_failed: 0, count_zero_stock: 0, count_archived: 0,
    pass: completed ? "none" : cooldown ? "detail" : "none",
    last_full_sync_at_ms: initialStamp + (completed ? 1_000 : 0), manual_next_allowed_at_ms: cooldown || null,
  }))
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url.pathname}${url.search}`)
    check(url.origin === location.origin, "a request escaped the fixture origin")
    if (method === "GET" && url.pathname === overviewPath) {
      if (failOverview) return Response.json({ code: "UNAVAILABLE", error: "fixture offline" }, { status: 503 })
      return Response.json({ stores: stores(), totals: { total: 2, on_sale: 2 }, coverage: { read: 2, total: 2 }, sync_disabled: false })
    }
    if (method === "GET" && url.pathname === productsPath) {
      return Response.json({ rows: [{ store_id: storeIDs[0], store_name: "店铺 1", product_id: 1, offer_id: "SYNC-ROW", name: completed ? "同步后的商品" : "同步前的商品", price: "80.00", old_price: "160.00", gone: false }], next_cursor: null })
    }
    if (method === "POST" && storeIDs.some((id) => url.pathname === route("workspacesStoresByUuidProductsSync", { uuid: id }))) {
      cooldown ||= Date.now() + 2_000
      return Response.json({ generation: 2, manual_next_allowed_at_ms: cooldown, attached: false }, { status: 202 })
    }
    throw new Error(`unexpected fixture request: ${method} ${url.pathname}`)
  }
  window.setInterval = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === PRODUCTS_POLL_INTERVAL_MS && typeof handler === "function") {
      poll = () => handler(...args)
      return -7731
    }
    return originalInterval(handler, delay, ...args)
  }) as typeof window.setInterval
  window.clearInterval = (id) => {
    if (id === -7731) poll = undefined
    else originalClearInterval(id)
  }
  const root = createRoot(host)
  const render = (active: boolean) => flushSync(() => root.render(<TooltipProvider><ScreenPane active={active}><ProductsScreen workspaceId={777} /></ScreenPane></TooltipProvider>))
  try {
    render(true)
    await until(() => Boolean(updateButton() && host.textContent?.includes("同步前的商品")), "initial products did not load")
    updateButton()!.click()
    await until(() => calls.filter((call) => call.startsWith("POST ")).length === 2 && Boolean(updateButton()?.disabled), "accepted syncs did not enter cooldown")
    const before = listReads()
    check(poll, "visible products did not register a poll")
    failOverview = true
    poll!()
    await until(() => Boolean(host.textContent?.includes("商品汇总读取失败")), "poll failure was hidden")
    check(host.textContent?.includes("同步前的商品"), "poll failure discarded the last product list")
    failOverview = false
    completed = true
    poll!()
    await until(() => Boolean(host.textContent?.includes("同步后的商品")), "a finished sync did not reread products")
    check(listReads() === before + 1, "a completed sync must refresh the product list once")
    await chooseStore("店铺 1")
    await until(() => Boolean(singleUpdateButton()?.disabled), "the selected store did not retain its cooldown")
    await until(() => Boolean(singleUpdateButton() && !singleUpdateButton()!.disabled), "cooldown did not unlock the single-store button")
    await chooseStore("全部店铺")
    await until(() => Boolean(updateButton() && !updateButton()!.disabled && updateButton()!.textContent?.includes("2")), "cooldown did not unlock the bulk update button")
    const reads = overviewReads()
    render(false)
    check(poll === undefined, "an inactive product pane kept polling")
    render(true)
    await until(() => overviewReads() === reads + 1, "reactivation did not refresh the overview")
    return { status: "passed", checks: ["sync acceptance", "failed poll retains rows", "completed sync rereads rows", "single and bulk cooldown unlock", "inactive pause and reactivation"], calls }
  } finally {
    flushSync(() => root.unmount())
    globalThis.fetch = originalFetch
    window.setInterval = originalInterval
    window.clearInterval = originalClearInterval
  }
}

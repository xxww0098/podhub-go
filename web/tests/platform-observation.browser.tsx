/** Browser-only acceptance: real effects and DOM expansion, no service started.
 * Open tests/platform-observation.html?autorun=1 on the Lead's existing Web.
 */
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { ScreenCatalog } from "@/app/screen-catalog"
import type { AccountOverview } from "@/bindings/commands"
import { replaceAddress } from "@/lib/address"
import { ObservationProductsTable } from "@/features/platform-observation/observation-products-table"
import { observedConsole, observedOverview, observedProduct, observedScopes, observedStore, STORE_A, STORE_B, WORKSPACE_A, WORKSPACE_B } from "@/features/platform-observation/observation-fixtures"
import { AdminConsoleScreen } from "@/features/platform-observation/admin-console-screen"
import { ObservationScopeProvider } from "@/features/platform-observation/observation-scope-provider"
import type { ObservationProducts } from "@/features/platform-observation/observation-types"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
const writes: string[] = []
const unexpected: string[] = []
const originalFetch = window.fetch

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}
async function waitFor(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 5000
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(message)
    await frame()
  }
}
function json(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "Content-Type": "application/json" } })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { resolve, promise }
}
async function mounted(action: (root: Root) => Promise<void>) {
  const root = createRoot(fixture)
  try { await action(root) }
  finally { flushSync(() => root.unmount()); await frame() }
}
const readonlyItems = () => [observedProduct(), observedProduct(WORKSPACE_B, STORE_B)].map((item) => ({
  ...item, product: { ...item.product, image_url: null },
}))

async function expandedRowIsLocalOnly() {
  const calls: string[] = []
  window.fetch = async (input, init) => {
    calls.push((init?.method ?? "GET") + " " + String(input))
    if ((init?.method ?? "GET") !== "GET") writes.push(String(input))
    throw new Error("Readonly row must not read any runtime source")
  }
  await mounted(async (root) => {
    flushSync(() => root.render(<ObservationProductsTable items={readonlyItems()} stores={[observedStore(), observedStore(STORE_B)]} loading={false} failed={false} hasMore={false} onLoadMore={() => {}} onRetry={() => {}} />))
    const toggle = fixture.querySelector<HTMLButtonElement>('button[aria-label="展开 SAME-OFFER 的详情"]')!
    check(toggle, "readonly expand button is present")
    flushSync(() => toggle.click())
    await waitFor(() => fixture.textContent!.includes("销售漏斗"), "expanded snapshot never appeared")
    check(fixture.textContent!.includes("1 CNY = 10 RUB"), "snapshot FX explanation is preserved")
    check(!fixture.querySelector('[aria-label*="修改"]'), "readonly expansion mounted an editor")
    flushSync(() => toggle.click())
    await frame()
    check(!fixture.textContent!.includes("销售漏斗"), "collapse did not remove detail")
    check(calls.length === 0, "readonly row/expansion issued requests: " + calls.join(", "))
  })
}

async function switchingScopeFencesPaginationAndDetail() {
  const oldPage = deferred<ObservationProducts>()
  let oldPageRequested = false
  const a = readonlyItems()[0]!
  const b = readonlyItems()[1]!
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    const method = init?.method ?? "GET"
    if (method !== "GET") { writes.push(url.pathname); throw new Error("No POST is authorized") }
    if (url.pathname === "/api/admin/ops/scopes") return json(observedScopes())
    const isA = url.searchParams.get("workspaceId") === WORKSPACE_A
    if (url.pathname === "/api/admin/stores/products/overview") return json({
      ...observedOverview(), totals: { ...observedOverview().totals, total: 1, on_sale: 1 }, coverage: { read: 1, total: 1 },
      stores: [observedStore(isA ? STORE_A : STORE_B)],
    })
    if (url.pathname === "/api/admin/stores/products") {
      if (isA && url.searchParams.has("cursor")) {
        oldPageRequested = true
        return json(await oldPage.promise)
      }
      return json(isA ? { items: [a], next_cursor: "a-page-2" } : { items: [b] })
    }
    unexpected.push(url.pathname)
    throw new Error("Unexpected route")
  }
  await mounted(async (root) => {
    const render = (role: string) => {
      const overview = { session: { role }, active_workspace: { id: 77 }, account_mode: "owner" } as unknown as AccountOverview
      flushSync(() => root.render(<ScreenCatalog screen="admin-products" visited={["admin-products"]} overview={overview} onOverviewChange={() => {}} onSignedOut={() => {}} onNavigate={() => {}} onRefreshOverview={async () => {}} />))
    }
    flushSync(() => replaceAddress("/admin?screen=admin-products&workspaceId=" + WORKSPACE_A))
    render("super_admin")
    await waitFor(() => Boolean(fixture.querySelector("table")?.textContent?.includes("甲空间")), "first scope did not load")
    flushSync(() => fixture.querySelector<HTMLButtonElement>('button[aria-label="展开 SAME-OFFER 的详情"]')!.click())
    check(fixture.textContent!.includes("销售漏斗"), "first scope detail is missing")
    const input = fixture.querySelector<HTMLInputElement>('input[aria-label="搜索商品名称、货号或 SKU"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, "scope-a")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    const more = fixture.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')!
    flushSync(() => more.click())
    await waitFor(() => oldPageRequested, "pagination was not requested")
    flushSync(() => replaceAddress({ search: "?screen=admin-products&workspaceId=" + WORKSPACE_B }))
    check(!fixture.querySelector("table")?.textContent?.includes("甲空间"), "scope switch briefly retained old rows")
    check(!fixture.textContent!.includes("销售漏斗"), "scope switch retained old detail")
    check(fixture.querySelector<HTMLInputElement>('input[aria-label="搜索商品名称、货号或 SKU"]')?.value === "", "scope switch retained old filters")
    await waitFor(() => Boolean(fixture.querySelector("table")?.textContent?.includes("乙空间")), "new scope did not load")
    oldPage.resolve({ items: [{ ...a, product: { ...a.product, product_id: 102, name: "迟到旧商品" } }], next_cursor: "old-page-3" })
    await frame(); await frame()
    check(!fixture.querySelector("table")?.textContent?.includes("迟到旧商品"), "old page contaminated the new scope")
    check(fixture.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')?.disabled, "old cursor was restored")
    render("admin")
    check(!fixture.querySelector('section[aria-label="全部 Ozon 商品"]') && !fixture.querySelector("table"), "downgrade left the observation pane mounted")
  })
}

async function pageSizeAndSelectionReset() {
  const first = readonlyItems()[0]!
  const blank = { ...first, product: { ...first.product, product_id: 102, offer_id: "", name: "无货号商品" } }
  const second = { ...first, product: { ...first.product, product_id: 103, offer_id: "SECOND", name: "第二页商品" } }
  const requests: string[] = []
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if ((init?.method ?? "GET") !== "GET") { writes.push(url.pathname); throw new Error("Observation cannot write") }
    if (url.pathname === "/api/admin/ops/scopes") return json(observedScopes())
    if (url.pathname === "/api/admin/stores/products/overview") return json(observedOverview())
    if (url.pathname === "/api/admin/stores/products") {
      requests.push(url.search)
      return json(url.searchParams.has("cursor") ? { items: [second] } : { items: [first, blank], next_cursor: "page-2" })
    }
    unexpected.push(url.pathname)
    throw new Error("Unexpected route")
  }
  await mounted(async (root) => {
    const overview = { session: { role: "super_admin" }, active_workspace: { id: 77 }, account_mode: "owner" } as unknown as AccountOverview
    flushSync(() => replaceAddress("/admin?screen=admin-products&workspaceId=" + WORKSPACE_A))
    flushSync(() => root.render(<ScreenCatalog screen="admin-products" visited={["admin-products"]} overview={overview} onOverviewChange={() => {}} onSignedOut={() => {}} onNavigate={() => {}} onRefreshOverview={async () => {}} />))
    await waitFor(() => Boolean(fixture.querySelector('[aria-label="选择 无货号商品"]')), "first page never appeared")
    flushSync(() => fixture.querySelector<HTMLButtonElement>('[aria-label="选择 无货号商品"]')!.click())
    const copy = () => [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("复制选中货号"))
    check(copy()?.disabled, "blank offer id enabled copy")
    flushSync(() => fixture.querySelector<HTMLButtonElement>('[aria-label="选择本页全部商品"]')!.click())
    check(copy() && !copy()!.disabled, "select all did not include a copyable offer")
    flushSync(() => fixture.querySelector<HTMLButtonElement>('button[aria-label="下一页"]')!.click())
    await waitFor(() => fixture.textContent!.includes("第二页商品"), "next cursor page never appeared")
    check(!copy(), "page change retained old selection")
    check(requests.some((request) => new URLSearchParams(request).get("cursor") === "page-2"), "next cursor was not sent")
    flushSync(() => fixture.querySelector<HTMLButtonElement>('button[aria-label="上一页"]')!.click())
    await waitFor(() => Boolean(fixture.querySelector('[aria-label="选择 无货号商品"]')), "previous page never returned")
    flushSync(() => fixture.querySelector<HTMLButtonElement>('[aria-label="选择 SAME-OFFER"]')!.click())
    const size = fixture.querySelector<HTMLButtonElement>('[aria-label="每页商品数量"]')!
    flushSync(() => size.click())
    await waitFor(() => [...document.querySelectorAll('[role="option"]')].some((node) => node.textContent?.trim() === "20 条/页"), "page size options did not open")
    const twenty = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((node) => node.textContent?.trim() === "20 条/页")!
    flushSync(() => twenty.click())
    await waitFor(() => requests.some((request) => new URLSearchParams(request).get("limit") === "20"), "new page size was not sent")
    check(!copy(), "page-size change retained old selection")
    const latest = new URLSearchParams(requests.at(-1)!)
    check(latest.get("limit") === "20" && !latest.has("cursor"), "page size did not reset cursor")
    const input = fixture.querySelector<HTMLInputElement>('input[aria-label="搜索商品名称、货号或 SKU"]')!
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
    setter.call(input, "match")
    input.dispatchEvent(new Event("input", { bubbles: true }))
    await waitFor(() => requests.some((request) => new URLSearchParams(request).get("q") === "match"), "filter query was not sent")
    const filtered = new URLSearchParams(requests.at(-1)!)
    check(filtered.get("limit") === "10" && !filtered.has("cursor"), "filter change did not reset page size and cursor")
  })
}

function metric(label: string): string | undefined {
  return [...fixture.querySelectorAll('dl[aria-label="核心指标"] dt')].find((node) => node.textContent === label)?.nextElementSibling?.firstChild?.firstChild?.textContent ?? undefined
}

async function dashboardReadsFailIndependently() {
  for (const failedSource of ["console", "products"] as const) {
    let failed = true
    const calls = { console: 0, products: 0 }
    window.fetch = async (input, init) => {
      const url = new URL(String(input), window.location.origin)
      if ((init?.method ?? "GET") !== "GET") { writes.push(url.pathname); throw new Error("Observation cannot write") }
      if (url.pathname === "/api/admin/ops/scopes") return json(observedScopes())
      const source = url.pathname === "/api/admin/ops/console/snapshot" ? "console"
        : url.pathname === "/api/admin/stores/products/overview" ? "products" : null
      if (!source) { unexpected.push(url.pathname); throw new Error("Unexpected dashboard route") }
      calls[source]++
      if (failed && source === failedSource) return new Response(JSON.stringify({ error: { code: "snapshot_unavailable", message: "合成读取失败" } }), { status: 503, headers: { "Content-Type": "application/json" } })
      return json(source === "console" ? observedConsole() : observedOverview())
    }
    await mounted(async (root) => {
      flushSync(() => replaceAddress({ search: "?screen=admin-console" }))
      flushSync(() => root.render(<ObservationScopeProvider enabled><AdminConsoleScreen onOpenProducts={() => {}} /></ObservationScopeProvider>))
      const retryLabel = failedSource === "console" ? "重试经营快照" : "重试商品快照"
      const retry = () => [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === retryLabel)
      await waitFor(() => Boolean(retry()), retryLabel + " is missing")
      check(metric(failedSource === "console" ? "30 日出单" : "在售商品") === "—", "missing snapshot was presented as zero")
      check(metric(failedSource === "console" ? "在售商品" : "30 日出单") === (failedSource === "console" ? "170" : "115"), "one failed read blanked the independent snapshot")
      const otherCalls = calls[failedSource === "console" ? "products" : "console"]
      failed = false
      flushSync(() => retry()!.click())
      await waitFor(() => metric("30 日出单") === "115" && metric("在售商品") === "170", "independent retry never recovered")
      check(calls[failedSource === "console" ? "products" : "console"] === otherCalls, "retry re-read an unrelated source")
      check(!fixture.textContent!.includes("NaN"), "dashboard displayed an invalid number")
    })
  }
}

async function dashboardControlsAndBounds() {
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if ((init?.method ?? "GET") !== "GET") { writes.push(url.pathname); throw new Error("Observation cannot write") }
    if (url.pathname === "/api/admin/ops/scopes") return json(observedScopes())
    if (url.pathname === "/api/admin/ops/console/snapshot") return json(observedConsole())
    if (url.pathname === "/api/admin/stores/products/overview") return json(observedOverview())
    unexpected.push(url.pathname)
    throw new Error("Unexpected dashboard route")
  }
  await mounted(async (root) => {
    let navigated = 0
    flushSync(() => replaceAddress({ search: "?screen=admin-console" }))
    flushSync(() => root.render(<ObservationScopeProvider enabled><AdminConsoleScreen onOpenProducts={() => { navigated++ }} /></ObservationScopeProvider>))
    await waitFor(() => metric("30 日出单") === "115" && metric("在售商品") === "170", "dashboard metrics never appeared")
    const chart = fixture.querySelector<HTMLElement>('[role="img"][aria-label*="出单与上架提交走势"]')
    check(chart, "daily trend is missing")
    await waitFor(() => [...chart.querySelectorAll<SVGPathElement>('path[stroke-width="2"]')].some((path) => path.getBBox().height > 5), "trend contains no drawn data line")
    check(!fixture.querySelector('[aria-label="账本结果结构"]'), "detailed ledger should start folded")
    const ledger = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent!.includes("条记录 · 查看趋势与结果"))!
    flushSync(() => ledger.click())
    await waitFor(() => Boolean(fixture.querySelector('[aria-label="账本结果结构"]')), "ledger disclosure did not open")
    check(fixture.textContent!.includes("73.1%"), "exact ledger rate was lost")
    flushSync(() => ledger.click())
    flushSync(() => [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "全部 Ozon 商品")!.click())
    check(navigated === 1, "product navigation did not work")
    check(document.documentElement.scrollWidth <= window.innerWidth + 1, "dashboard overflows the viewport horizontally")
    const metricFont = Number.parseFloat(getComputedStyle(fixture.querySelector('dl[aria-label="核心指标"] dd > span')!).fontSize)
    check(metricFont >= 20 && metricFont <= 30, "metric typography is outside the compact scale")
    check(fixture.querySelector("[data-slot=page-toolbar]")!.getBoundingClientRect().height <= 140, "scope toolbar consumes too much height")
  })
}

async function dashboardScopeFencesBothSources() {
  const oldOverview = deferred<ReturnType<typeof observedOverview>>()
  let oldOverviewRequested = false
  window.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin)
    if ((init?.method ?? "GET") !== "GET") { writes.push(url.pathname); throw new Error("Observation cannot write") }
    if (url.pathname === "/api/admin/ops/scopes") return json(observedScopes())
    const isA = url.searchParams.get("workspaceId") === WORKSPACE_A
    const id = isA ? STORE_A : STORE_B
    if (url.pathname === "/api/admin/ops/console/snapshot") {
      const snapshot = observedConsole()
      return json({ ...snapshot, roster: { ...snapshot.roster, stores: snapshot.roster.stores.filter((store) => store.id === id) }, metrics: snapshot.metrics.filter((row) => row.store_id === id) })
    }
    if (url.pathname === "/api/admin/stores/products/overview") {
      if (isA) { oldOverviewRequested = true; return json(await oldOverview.promise) }
      const overview = observedOverview()
      return json({ ...overview, totals: { ...overview.totals, on_sale: 60 }, stores: overview.stores.filter((store) => store.store_id === id), coverage: { read: 1, total: 1 } })
    }
    unexpected.push(url.pathname)
    throw new Error("Unexpected dashboard route")
  }
  await mounted(async (root) => {
    flushSync(() => replaceAddress({ search: "?screen=admin-console&workspaceId=" + WORKSPACE_A }))
    flushSync(() => root.render(<ObservationScopeProvider enabled><AdminConsoleScreen onOpenProducts={() => {}} /></ObservationScopeProvider>))
    await waitFor(() => metric("30 日出单") === "42" && oldOverviewRequested, "first dashboard scope never loaded")
    flushSync(() => replaceAddress({ search: "?screen=admin-console&workspaceId=" + WORKSPACE_B }))
    check(metric("30 日出单") === "—" && metric("在售商品") === "—", "scope change retained previous dashboard metrics")
    await waitFor(() => metric("30 日出单") === "73" && metric("在售商品") === "60", "new dashboard scope never loaded")
    oldOverview.resolve(observedOverview())
    await frame(); await frame()
    check(metric("在售商品") === "60", "late overview contaminated a different workspace")
    check(!fixture.textContent!.includes("同名店 · 甲空间"), "ranking retained another workspace")
  })
}

run.onclick = async () => {
  run.disabled = true
  results.textContent = "运行中"
  const originalHref = window.location.href
  writes.length = 0; unexpected.length = 0
  const lines: string[] = []
  try {
    for (const [name, test] of [
      ["readonly expansion has zero requests/POSTs", expandedRowIsLocalOnly],
      ["scope clears rows/details/filters/cursor and fences old page", switchingScopeFencesPaginationAndDetail],
      ["product paging and selection reset on scope and filters", pageSizeAndSelectionReset],
      ["dashboard keeps each snapshot and retries only the failed source", dashboardReadsFailIndependently],
      ["dashboard chart, ledger, navigation and viewport bounds", dashboardControlsAndBounds],
      ["dashboard scope clears both sources and fences late overview", dashboardScopeFencesBothSources],
    ] as const) {
      try { await test(); lines.push("PASS " + name) }
      catch (reason) { lines.push("FAIL " + name + ": " + String(reason)) }
    }
    if (writes.length) lines.push("FAIL POSTs: " + writes.join(", "))
    if (unexpected.length) lines.push("FAIL routes: " + unexpected.join(", "))
  } finally {
    window.fetch = originalFetch
    replaceAddress(originalHref)
  }
  results.textContent = lines.join("\n")
  results.dataset.result = lines.some((line) => line.startsWith("FAIL")) ? "failed" : "passed"
  run.disabled = false
}
const preview = new URLSearchParams(window.location.search).get("preview")
if (preview) {
  run.hidden = true
  results.textContent = "合成数据，只读展示预览"
  try {
    const { previewObservation } = await import("./platform-observation.preview")
    previewObservation(preview, fixture)
  } catch (reason) {
    results.textContent = "FAIL preview: " + String(reason)
  }
} else if (new URLSearchParams(window.location.search).get("autorun") === "1") run.click()

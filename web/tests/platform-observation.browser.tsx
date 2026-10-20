/** Browser-only acceptance: real effects and DOM expansion, no service started.
 * Open tests/platform-observation.html?autorun=1 on the Lead's existing Web.
 */
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import { ScreenCatalog } from "@/app/screen-catalog"
import type { AccountOverview } from "@/bindings/commands"
import { replaceAddress } from "@/lib/address"
import { ObservationProductsTable } from "@/features/platform-observation/observation-products-table"
import { observedProduct, observedStore, STORE_A, STORE_B, WORKSPACE_A, WORKSPACE_B } from "@/features/platform-observation/observation-fixtures"
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
  ...item, product: { ...item.product, imageUrl: null },
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
    if (url.pathname === "/api/admin/ops/scopes") return json({
      workspaces: [
        { id: WORKSPACE_A, name: "甲空间", ownerUuid: WORKSPACE_A, ownerName: "甲所有者" },
        { id: WORKSPACE_B, name: "乙空间", ownerUuid: WORKSPACE_B, ownerName: "乙所有者" },
      ],
      stores: [a, b].map((item) => ({ storeId: item.product.store_id, storeName: "同名店", workspaceId: item.workspace_id, workspaceName: item.workspace_name, ownerUuid: item.owner_uuid, ownerName: item.owner_name })),
    })
    const isA = url.searchParams.get("workspaceId") === WORKSPACE_A
    if (url.pathname === "/api/admin/stores/products/overview") return json({
      totals: { total: 1, onSale: 1 }, coverage: { read: 1, total: 1 }, syncDisabled: true,
      stores: [observedStore(isA ? STORE_A : STORE_B)],
    })
    if (url.pathname === "/api/admin/stores/products") {
      if (isA && url.searchParams.has("cursor")) {
        oldPageRequested = true
        return json(await oldPage.promise)
      }
      return json(isA ? { items: [a], nextCursor: "a-page-2" } : { items: [b] })
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
    const more = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "加载更多")!
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
    check(![...fixture.querySelectorAll("button")].some((button) => button.textContent === "加载更多"), "old cursor was restored")
    render("admin")
    check(!fixture.querySelector('section[aria-label="平台店铺商品"]') && !fixture.querySelector("table"), "downgrade left the observation pane mounted")
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
  const { previewObservation } = await import("./platform-observation.preview")
  previewObservation(preview, fixture)
} else if (new URLSearchParams(window.location.search).get("autorun") === "1") run.click()

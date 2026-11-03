import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { TooltipProvider } from "@/components/ui/tooltip"
import { ProductsScreen } from "@/features/products/products-screen"
import type { StoreProductOverviewRow, StoreProductRow, StoreProductsOverviewData } from "@/features/products/products-api"
import { productsCsv } from "@/features/products/products-export"
import "../src/index.css"

// Test-only fake mirror. Every API request is intercepted; no real write can leave.
const now = 1_790_000_000_000
const names = ["经典 T 恤", "帆布包", "陶瓷杯", "手机壳", "卫衣", "海报", "帽子", "靠枕", "抱枕套", "婴儿连体衣"]
const images = ["/site/product-shirt.jpg", "/site/product-tote.jpg", "/site/product-mug.jpg"]
const stores: StoreProductOverviewRow[] = Array.from({length: 5}, (_, index) => ({
  store_id: "00000000-0000-4000-8000-00000000000" + index,
  name: "测试店 " + (index + 1), status: "active", freshness: "fresh", currency: "USD",
  count_total: 2, count_on_sale: 1, count_processing: 0, count_hidden: 0,
  count_moderation_failed: index === 1 ? 1 : 0, count_zero_stock: 0,
  count_archived: 0, count_delisted: 0, last_full_sync_at_ms: now,
}))
const rows: StoreProductRow[] = names.map((name, index) => ({
  store_id: stores[index % stores.length]!.store_id,
  store_name: stores[index % stores.length]!.name,
  product_id: index + 1,
  offer_id: "TEST-" + (index + 1),
  sku: String(100000 + index),
  name,
  image_url: images[index % images.length],
  price: (12 + index).toFixed(2),
  stock_present: index + 2,
  state: index === 1 ? "moderation_failed" : "on_sale",
  gone: false,
  refreshed_at_ms: now,
  model_id: index === 0 ? 77 : null,
  model_count: index === 0 ? 2 : null,
  metrics: index === 0 ? {hits_view: 30, session_view: 20, hits_tocart: 4, conv_tocart: 13.3, ordered_units: 1, revenue: 1200, revenue_currency: "RUB", period_days: 14, through_day: "2026-10-28", fetched_at_ms: now} : null,
}))
const overview: StoreProductsOverviewData = {
  stores,
  totals: {total: 10, on_sale: 9, processing: 0, hidden: 0, moderation_failed: 1, zero_stock: 0, archived: 0, delisted: 0},
  coverage: {read: 5, total: 5},
  newest_sync_at_ms: now,
  sync_disabled: false,
}
const unexpected: string[] = []
let failNextList = false
globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), location.href)
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  if (url.origin !== location.origin) {
    unexpected.push(method + " " + url.pathname)
    return new Response(JSON.stringify({code: "fixture_refused", error: "blocked"}), {status: 403})
  }
  if (method !== "GET") {
    unexpected.push(method + " " + url.pathname)
    return Response.json({ code: "fixture_refused", error: "blocked" }, { status: 403 })
  }
  if (method === "GET" && url.pathname === "/api/workspaces/products/export") {
    const state = url.searchParams.get("status")
    return new Response(productsCsv(rows.filter((row) => !state || row.state === state), () => "USD", () => now), { headers: { "Content-Type": "text/csv; charset=utf-8" } })
  }
  if (url.pathname === "/api/workspaces/products/overview") return Response.json(overview)
  if (url.pathname === "/api/workspaces/products") {
    if (failNextList) { failNextList = false; return Response.json({code: "fixture_error", error: "offline"}, {status: 503}) }
    const storeId = url.searchParams.get("storeId")
    const status = url.searchParams.get("status")
    const query = (url.searchParams.get("q") ?? "").toLowerCase()
    return Response.json({
      rows: rows.filter((row) => (!storeId || row.store_id === storeId) && (!status || row.state === status) && (!query || [row.name ?? "", row.offer_id, String(row.sku ?? "")].some((item) => item.toLowerCase().includes(query)))),
      next_cursor: null,
    })
  }
  unexpected.push(method + " " + url.pathname)
  return Response.json({code: "fixture_refused", error: "blocked"}, {status: 403})
}

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const root = createRoot(fixture)
const blobs: Blob[] = []
URL.createObjectURL = (blob) => { blobs.push(blob as Blob); return "blob:products-fixture" }
URL.revokeObjectURL = () => {}
HTMLAnchorElement.prototype.click = function () {}
flushSync(() => root.render(<TooltipProvider><ProductsScreen /></TooltipProvider>))

function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function waitFor(predicate: () => boolean, message: string) {
  const deadline = performance.now() + 3000
  while (!predicate()) { check(performance.now() < deadline, message); await frame() }
}
function button(text: string) {
  return [...fixture.querySelectorAll<HTMLButtonElement>("button")].find((item) => item.textContent?.trim() === text)
}

run.onclick = async () => {
  run.disabled = true
  try {
    await waitFor(() => !!fixture.querySelector('[aria-label="选择 TEST-1"]'), "fixture rows did not load")
    fixture.querySelector<HTMLElement>('[aria-label="选择 TEST-1"]')!.click()
    await waitFor(() => !!fixture.textContent?.includes("已选 1 件"), "selection did not appear")
    const download = button("导出已选 CSV（1）")
    check(download && !download.disabled, "CSV stayed disabled after selection")
    download.click()
    await waitFor(() => blobs.length === 1, "CSV was not created")
    const csv = await blobs[0]!.text()
    check(csv.includes("TEST-1") && !csv.includes("TEST-2"), "CSV did not contain only the selected product")
    fixture.querySelector<HTMLButtonElement>('[aria-label="展开 TEST-1 的详情"]')!.click()
    await waitFor(() => !!fixture.textContent?.includes("销售漏斗") && !!fixture.textContent?.includes("同款"), "detail did not expand")
    check(fixture.textContent?.includes("2 件同款"), "mirror grouping fact did not appear")
    check(!fixture.querySelector('[aria-label="查看 TEST-1 的同款规格"]'), "unverified grouping preview was exposed")
    check(button("改价格") && button("改库存"), "existing price or stock action was removed")
    fixture.querySelector<HTMLButtonElement>('[aria-label="商品状态筛选"]')!.click()
    await waitFor(() => !![...document.querySelectorAll('[role="option"]')].find((el) => el.textContent?.trim() === "审核失败"), "status options did not open")
    ;([...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent?.trim() === "审核失败"))!.click()
    await waitFor(() => !!fixture.querySelector('[aria-label="选择 TEST-2"]') && !fixture.querySelector('[aria-label="选择 TEST-1"]'), "status filter did not update rows")
    check(!fixture.textContent?.includes("已选 1 件"), "selection survived a filter change")
    button("导出筛选 CSV")!.click()
    await waitFor(() => blobs.length === 2, "filtered CSV was not downloaded")
    const filtered = await blobs[1]!.text()
    check(filtered.includes("TEST-2") && !filtered.includes("TEST-1"), "filtered export ignored the current status")
    failNextList = true
    const all = [...fixture.querySelectorAll<HTMLElement>('[role="tab"]')].find((el) => el.textContent?.includes("全部商品"))
    check(all, "all tab missing")
    all.click()
    await waitFor(() => !!fixture.textContent?.includes("商品列表读取失败"), "failed read looked like empty results")
    fixture.querySelector<HTMLButtonElement>('[role="alert"] button')!.click()
    await waitFor(() => !!fixture.querySelector('[aria-label="选择 TEST-1"]'), "retry did not restore rows")
    check(unexpected.length === 0, "unexpected request: " + unexpected.join(", "))
    results.textContent = "PASS：非空表格、选择、CSV、只读同款、价格与库存入口、筛选、失败和重试"
    results.dataset.result = "pass"
  } catch (reason) {
    results.textContent = "FAIL: " + String(reason)
    results.dataset.result = "fail"
  } finally { run.disabled = false }
}

// Dev-only product-mirror checks. The real ProductsScreen mounts against a
// mocked fetch; `role` swaps the roster/visibility the mock hands back.
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"

import { rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { ProductsScreen } from "@/features/products/products-screen"
import type { StoreProductOverviewRow, StoreProductRow } from "@/features/products/products-api"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLPreElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!
const params = new URLSearchParams(location.search)
const role = params.get("role") ?? "owner"
const demo = params.get("demo")

const NOW = Date.now()
const H = 3_600_000
const D = 24 * H

// --- mock data ---------------------------------------------------------------
// Owner sees every store including never-synced and expired ones; the member
// roster narrows the mock to the single assigned store — the same answer the
// Cloud API computes from workspace_stores.

const ROW_DEFAULTS = { syncDisabled: false } as const

const STORES: StoreProductOverviewRow[] = [
  {
    ...ROW_DEFAULTS,
    store_id: "11111111-aaaa-4000-8000-000000000001",
    name: "杯具旗舰店",
    assignee_name: "张三",
    status: "active",
    freshness: "fresh",
    count_total: 42,
    count_on_sale: 31,
    count_hidden: 6,
    count_moderation_failed: 1,
    count_zero_stock: 4,
    count_archived: 2,
    last_full_sync_at_ms: NOW - 26 * H,
    pass: "none",
    next_due_at_ms: NOW + 4 * H,
  },
  {
    ...ROW_DEFAULTS,
    store_id: "22222222-bbbb-4000-8000-000000000002",
    name: "居家生活馆",
    assignee_name: "李四",
    status: "active",
    freshness: "stale",
    count_total: 17,
    count_on_sale: 12,
    count_hidden: 3,
    count_moderation_failed: 0,
    count_zero_stock: 2,
    count_archived: 0,
    last_full_sync_at_ms: NOW - 4 * D,
    pass: "none",
  },
  {
    ...ROW_DEFAULTS,
    store_id: "33333333-cccc-4000-8000-000000000003",
    name: "新店（待同步）",
    assignee_name: "张三",
    status: "active",
    freshness: "never",
    pass: "none",
  },
  {
    ...ROW_DEFAULTS,
    store_id: "44444444-dddd-4000-8000-000000000004",
    name: "旧店（密钥过期）",
    status: "active",
    freshness: "expired",
    count_total: 9,
    count_on_sale: 7,
    count_hidden: 1,
    count_moderation_failed: 0,
    count_zero_stock: 1,
    count_archived: 1,
    last_full_sync_at_ms: NOW - 9 * D,
    pass: "none",
    hold: "cooldown",
    hold_reason: "rate_limited",
    hold_until_ms: NOW + 12 * H,
  },
]

const PRODUCTS: StoreProductRow[] = [
  {
    ...ROW_DEFAULTS,
    store_id: STORES[0].store_id,
    store_name: STORES[0].name,
    product_id: 101,
    offer_id: "A-1001",
    name: "陶瓷杯垫（圆）",
    sku: 7,
    image_url: "https://picsum.photos/seed/ozon-101/160/160.jpg",
    price: "199.00",
    old_price: "299.00",
    status_name: "在售",
    state: "on_sale",
    stock_present: 3,
    stock_reserved: 1,
    gone: false,
  },
  {
    ...ROW_DEFAULTS,
    store_id: STORES[0].store_id,
    store_name: STORES[0].name,
    product_id: 102,
    offer_id: "A-1002",
    name: "马克杯 350ml",
    sku: 8,
    price: "89.50",
    status_name: "在售",
    state: "on_sale",
    stock_present: 0,
    stock_reserved: 0,
    gone: false,
  },
  {
    ...ROW_DEFAULTS,
    store_id: STORES[1].store_id,
    store_name: STORES[1].name,
    product_id: 201,
    offer_id: "B-2001",
    name: "亚麻桌布",
    sku: 21,
    price: "129.00",
    status_name: "隐藏",
    state: "hidden",
    stock_present: 15,
    stock_reserved: 0,
    gone: false,
  },
]

const visible = (storeId: string) =>
  role === "member"
    ? storeId === STORES[1].store_id
      ? STORES[1]
      : undefined
    : STORES.find((s) => s.store_id === storeId)

const memberStores = [STORES[1]]
const memberTotals = {
  total: 17, onSale: 12, hidden: 3, moderationFailed: 0, zeroStock: 2, archived: 0,
}

const syncDisabled = params.get("state") === "disabled"

const overview = {
  syncDisabled,
  stores: role === "member" ? memberStores : STORES,
  totals:
    role === "member"
      ? memberTotals
      : {
          total: 59, onSale: 43, hidden: 9, moderationFailed: 1, zeroStock: 6, archived: 2,
        },
  coverage: role === "member" ? { read: 1, total: 1 } : { read: 2, total: 4 },
  newestSyncAtMs: NOW - 2 * H,
}

// --- fetch mock: the three Cloud routes this screen speaks --------------------
const hits: string[] = []

window.fetch = async (input, init) => {
  const url = String(input)
  hits.push(url)
  if (url.startsWith("/api/workspaces/products/overview")) {
    return json({ data: overview })
  }
  if (url.includes("/products/sync-tonight")) {
    // The store's slot inside tomorrow's 02:00–06:00 Moscow window.
    const windowStart = Date.parse("2026-09-21T02:40:00+03:00")
    return new Response(
      JSON.stringify({ data: { windowStartAtMs: windowStart } }),
      { status: 202, headers: { "content-type": "application/json" } },
    )
  }
  if (url.includes("/api/ops/products/mutate")) {
    ;(window as unknown as { __mutate?: string }).__mutate = String(init?.body ?? "")
    return json({
      data: {
        operation_id: "op-archive",
        items: [{ identity: "102", succeeded: true, message: "" }],
      },
    })
  }
  if (url.includes("/products/verify")) {
    const storeId = url.split("/api/workspaces/stores/")[1]?.split("/")[0]
    const row = PRODUCTS.find((r) => r.store_id === storeId)
    return json({
      data: {
        rows: [
          {
            ...row,
            price: "219.00",
            stockPresent: 5,
            stockReserved: 0,
                  },
        ],
      },
    })
  }
  if (url.startsWith("/api/workspaces/products")) {
    const all = PRODUCTS.filter((r) => visible(r.store_id))
    const hasCursor = new URL(url, location.origin).searchParams.has("cursor")
    return json(
      hasCursor
        ? { data: { rows: all.slice(2), nextCursor: null } }
        : { data: { rows: all.slice(0, 2), nextCursor: "next" } },
    )
  }
  return json({ error: { code: "unexpected", message: url } }, 404)
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

// --- harness ------------------------------------------------------------------
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
async function settle() {
  // Overview lands first; the table waits until that read picks a store.
  for (let i = 0; i < 20; i++) {
    await frame()
    if (rowMenu() || fixture.textContent?.includes("没有商品")) return
  }
}
function rowMenu(): HTMLButtonElement | undefined {
  return fixture.querySelector<HTMLButtonElement>('button[aria-label$=" 的操作"]') ?? undefined
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

createRoot(fixture).render(<ProductsScreen workspaceId={1} />)

async function main() {
  const lines: string[] = []
  const pass = (name: string) => lines.push(`PASS ${name}`)
  const fail = (name: string, why: unknown) => lines.push(`FAIL ${name}: ${why}`)

  await settle()

  try {
    check(fixture.textContent?.includes("全部"), "status tabs missing")
    check(fixture.textContent?.includes("已统计"), "coverage line missing")
    check(rowMenu(), "product table missing")
    pass("status tabs + product table")
  } catch (why) {
    fail("overview cards + coverage", why)
  }

  try {
    if (role === "owner") {
      check(fixture.textContent?.includes("暂无数据"), "never-synced store label missing")
      check(fixture.textContent?.includes("失效"), "expired store label missing")
      pass("never → 暂无数据 / expired → 失效")
    } else {
      check(!fixture.textContent?.includes("杯具旗舰店"), "member saw an unassigned store")
      check(fixture.textContent?.includes("居家生活馆"), "member's store missing")
      pass("member sees only the assigned store")
    }
  } catch (why) {
    fail("freshness / visibility", why)
  }

  try {
    check(
      hits.every((u) => u.startsWith("/api/workspaces/")),
      `page load hit a non-workspace route: ${hits.join(", ")}`,
    )
    pass("page load never touched a Seller/upstream route")
  } catch (why) {
    fail("no Seller reads on load", why)
  }

  if (demo === "verify") {
    try {
      const trigger = rowMenu()
      check(trigger, "row menu missing")
      flushSync(() => trigger.click())
      await frame()
      // 菜单弹层挂在 body 的 portal 里，不在 fixture 内。
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) =>
        el.textContent?.startsWith("核实最新数据"),
      )
      check(item, "核实最新数据 menu item missing")
      flushSync(() => item.click())
      await settle()
      await frame()
      check(
        hits.some((u) => u.includes("/products/verify")),
        "verify call missing",
      )
      // 价格以店铺币种格式显示（formatStoreMoney），219.00 RUB → 「219,00 ₽」。
      check(fixture.textContent?.includes("219,00"), "verified row did not update")
      pass("verify call → row updated in place")
    } catch (why) {
      fail("verify", why)
    }
  }

  if (demo === "tonight") {
    try {
      const button = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.trim() === "加入同步窗口",
      )
      check(button, "加入同步窗口 button missing")
      flushSync(() => button.click())
      await settle()
      check(
        hits.some((u) => u.includes("/products/sync-tonight")),
        "sync-tonight call missing",
      )
      check(fixture.textContent?.includes("已排入"), "scheduled state missing")
      pass("sync-tonight → 已排入 HH:MM")
    } catch (why) {
      fail("sync-tonight", why)
    }
  }

  if (syncDisabled) {
    try {
      check(fixture.textContent?.includes("自动更新已停用"), "disabled reason missing")
      const button = [...fixture.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent?.trim() === "加入同步窗口",
      )
      check(button?.disabled, "schedule button still enabled under the kill switch")
      check(
        !hits.some((u) => u.includes("sync-tonight") || u.includes("verify")),
        "a disabled page still spent a Seller read",
      )
      pass("kill switch disables every spend")
    } catch (why) {
      fail("kill switch", why)
    }
  }

  results.textContent = `${lines.join("\n")}\n\nfetch calls:\n${hits.join("\n")}`
}

run.addEventListener("click", () => void main())

// Seed the roster so `useStoreRoster` answers without a fetch, then auto-run.
rememberStoreRoster({
  stores: (role === "member" ? memberStores : STORES).map((s) => ({
    id: 0,
    uuid: s.store_id,
    name: s.name,
    configured: true,
    cloud_store_uuid: s.store_id,
    cloud_status: "active",
    status: "active",
    assignee_name: s.assignee_name ?? null,
  })),
} as never, 1)
void main()

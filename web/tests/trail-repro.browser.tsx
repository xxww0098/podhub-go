import { StrictMode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { AuthenticatedApp } from "@/app/authenticated-app"
import type { AccountOverview } from "@/bindings/commands"
import type { SupplierDbDetail } from "@/bindings/http-supplier-dbs"
import type { SellerSupplierDbCatalogData } from "@/bindings/http-supplier-dbs-catalog"
import { installAddressSync, replaceAddress } from "@/lib/address"
import "../src/index.css"

const fixture = document.querySelector<HTMLDivElement>("#fixture")!
const results = document.querySelector<HTMLElement>("#results")!
const run = document.querySelector<HTMLButtonElement>("#run")!

const catalog: SellerSupplierDbCatalogData = {
  dbs: [{ sourceId: "src_1", name: "数字油画厂家", country: "CN", icon: "🏭" }],
  propDefs: [],
  rows: [
    {
      productId: "prd_paint",
      sourceId: "src_1",
      listable: true,
      title: "数字油画",
      platformCode: "P-015158826C2B",
      descriptionCategoryId: 1,
      leadTime: "3-5 天发货",
      gallery: [],
      productVideos: [],
      fixedTags: [],
      description: "",
      props: {},
      listedAtMs: Date.now(),
    },
  ],
}

const NOW = Date.now()
const adminDb: SupplierDbDetail = {
  db: {
    sourceId: "src_1",
    name: "数字油画厂家",
    country: "CN",
    contact: "",
    internalNote: "",
    listed: true,
    icon: "🏭",
    viewPrefs: {},
    rowCount: 1,
    publishedCount: 1,
    createdAtMs: NOW,
    updatedAtMs: NOW,
  },
  propDefs: [],
  rows: [
    {
      productId: "prd_paint",
      skuId: "sku_1",
      sourceId: "src_1",
      title: "数字油画",
      platformCode: "P-015158826C2B",
      descriptionCategoryId: null,
      typeId: null,
      published: true,
      archived: false,
      readiness: {
        category: false,
        prompt: false,
        fixedTags: false,
        platformPrice: false,
        ozonConfig: false,
      },
      costCents: null,
      shippingCostCents: null,
      platformPriceCents: 1100,
      suggestedRetailCents: null,
      suggestedOldPriceCents: null,
      leadTime: "3-5 天发货",
      size: "",
      material: "",
      craft: "",
      grossWeightG: null,
      brand: "",
      packWidthMm: null,
      packHeightMm: null,
      packDepthMm: null,
      packWeightG: null,
      contents: "",
      gallery: [],
      psd: [],
      productVideos: [],
      promptName: "",
      promptFileName: "",
      promptContent: "",
      fixedTags: [],
      description: "",
      internalNote: "",
      props: {},
      revision: 1,
      createdAtMs: NOW,
      updatedAtMs: NOW,
      createdBy: "tester",
    },
  ],
}

const requested: string[] = []
window.fetch = async (input) => {
  const url = String(input)
  requested.push(url)
  const ok = (data: unknown) =>
    new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  if (url.includes("/api/supplier-dbs/catalog")) return ok(catalog)
  if (url.includes("/api/view/account-overview")) return ok(overview)
  if (url.includes("/api/notifications")) return ok({ notifications: [], unread: 0 })
  if (url === "/api/admin/supplier-dbs") return ok({ dbs: [adminDb.db] })
  if (url === "/api/admin/supplier-dbs/src_1") return ok(adminDb)
  throw new Error("repro harness: refused " + url)
}

const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))
const settle = async () => { await frame(); await frame(); await frame() }
const breadcrumb = () =>
  document.querySelector('nav[aria-label="面包屑"]')?.textContent ?? "<none>"
const log = (lines: string[], tag: string) =>
  lines.push(`${tag}: url=${window.location.search} crumb=${JSON.stringify(breadcrumb())}`)

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message + " — crumb=" + JSON.stringify(breadcrumb()))
}

async function waitFor(cond: () => boolean, message: string, timeoutMs = 8000) {
  const deadline = performance.now() + timeoutMs
  while (!cond()) {
    if (performance.now() > deadline) {
      throw new Error(message + " — crumb=" + JSON.stringify(breadcrumb()) + " url=" + window.location.search)
    }
    await frame()
  }
}

const overview = {
  session: { authenticated: true, email: "t@x", name: "t", role: "admin" },
  active_workspace: { id: 1, uuid: "u", name: "w", plan: "pro", role: "owner", is_owned: true },
  workspaces: [], account_mode: "owner", owned_count: 1, owned_limit: 3,
} as AccountOverview

function App() {
  return (
    <StrictMode>
      <AuthenticatedApp
        overview={overview}
        onOverviewChange={() => {}}
        onSignedOut={() => {}}
        onAddAccount={() => {}}
      />
    </StrictMode>
  )
}

async function clickNav(label: string) {
  const btn = [...document.querySelectorAll<HTMLElement>("button, [role='tab'], a")]
    .find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.textContent?.trim() === label,
    )
  if (!btn) throw new Error("no nav button " + label)
  btn.click()
  await settle()
  await settle()
}

run.onclick = async () => {
  run.disabled = true
  const lines: string[] = []
  const stop = installAddressSync()
  const root = createRoot(fixture)
  try {
    // Start on 列表管理 (supplier-dbs) with a db open — the second trail publisher.
    window.history.replaceState(null, "", "/?screen=supplier-dbs&open=src_1")
    flushSync(() => root.render(<App />))
    await waitFor(
      () => breadcrumb().includes("数字油画厂家"),
      "supplier-dbs trail never published",
    )
    log(lines, "on supplier-dbs with db open")

    // Switch to the seller gallery and open the product detail.
    await clickNav("工作台")
    await clickNav("平台货源")
    await waitFor(
      () => !!fixture.querySelector('[data-gallery-card="prd_paint"]'),
      "card never painted",
    )
    log(lines, "on catalog wall")
    const cardBtn = fixture.querySelector<HTMLButtonElement>(
      '[data-gallery-card="prd_paint"] h3 button',
    )!
    flushSync(() => cardBtn.click())
    await settle()
    await settle()
    log(lines, "opened detail")
    check(breadcrumb().includes("数字油画"), "detail open but trail missing")

    // Churn: url writes + settling while the inactive manage pane holds openId.
    replaceAddress({ hash: "#x" })
    await settle()
    replaceAddress({ hash: "" })
    await settle()
    log(lines, "hash churn")
    check(breadcrumb().includes("数字油画"), "after churn, trail missing")

    // Back out via the trail: module segment click must return to the wall.
    const moduleBtn = document.querySelector<HTMLButtonElement>(
      'nav[aria-label="面包屑"] button',
    )
    check(!!moduleBtn, "module segment is not a button — no way back")
    flushSync(() => moduleBtn!.click())
    await settle()
    log(lines, "clicked module segment")
    check(
      !!fixture.querySelector('[data-gallery-card="prd_paint"]'),
      "module segment click did not return to the wall",
    )
    check(!breadcrumb().includes("数字油画"), "trail did not clear after exit")

    // Re-open the detail, leave via the sidebar, then come back: 平台货源
    // must land on the gallery, not the last product page.
    flushSync(() => cardBtn.click())
    await settle()
    await settle()
    check(breadcrumb().includes("数字油画"), "re-opened detail missing trail")
    check(
      new URLSearchParams(window.location.search).get("product") === "prd_paint",
      "detail did not write product=",
    )
    await clickNav("数据大屏")
    await waitFor(
      () => new URLSearchParams(window.location.search).get("screen") === "console",
      "did not leave catalog",
    )
    check(
      !new URLSearchParams(window.location.search).has("product"),
      "product= leaked onto the other screen",
    )
    await clickNav("平台货源")
    await waitFor(
      () => !!fixture.querySelector('[data-gallery-card="prd_paint"]'),
      "returning to catalog did not show the gallery",
    )
    check(
      !new URLSearchParams(window.location.search).has("product"),
      "returning to catalog restored product=",
    )
    check(!breadcrumb().includes("数字油画"), "returning to catalog restored the detail")

    lines.push("ALL PASS")
    results.textContent = lines.join("\n")
  } catch (error) {
    lines.push("FAIL " + String(error))
    lines.push("requested: " + requested.join(" | "))
    results.textContent = lines.join("\n")
  } finally {
    flushSync(() => root.unmount())
    window.history.replaceState(null, "", "/")
    stop()
    run.disabled = false
  }
}

if (new URLSearchParams(window.location.search).get("autorun") === "1") {
  run.click()
}

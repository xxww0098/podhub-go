import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToString } from "react-dom/server"
import type { AccountOverview } from "@/bindings/commands"
import { ScreenCatalog } from "@/app/screen-catalog"

const overview = (role: string): AccountOverview => ({
  session: { role, authenticated: true, email: "test@example.invalid", name: "Test" },
  workspaces: [],
  account_mode: "unaffiliated",
  owned_count: 0,
  owned_limit: 1,
})

const props = (role: string, screen: "usage") => ({
  screen,
  visited: [screen],
  overview: overview(role),
  onOverviewChange: () => {},
  onSignedOut: () => {},
  onNavigate: () => {},
  onRefreshOverview: async () => {},
})

test("ordinary screens keep the shared lazy fallback", () => {
  const html = renderToString(<ScreenCatalog {...props("owner", "usage")} />)
  assert.match(html, /正在加载模块/)
})

test("supplier catalog enters listing through the app navigation seam", () => {
  const source = readFileSync(new URL("../app/screen-catalog.tsx", import.meta.url), "utf8")
  const start = source.indexOf('case "catalog"')
  const end = source.indexOf('case "supplier-dbs"', start)
  const catalog = source.slice(start, end)
  assert.match(catalog, /onOpenListing=\{\(products\) =>/)
  // The seam landed: supplier products become listing cards, then the app
  // navigates to the listing surface.
  assert.match(catalog, /importCatalogProducts\(products, \{/)
  assert.match(catalog, /onNavigate\("listing"\)/)
  // 绑定落地在导入例程里：建卡后按清单条目先店铺、后 PSD。
  const routine = source.slice(
    source.indexOf("export async function importCatalogProducts"),
    source.indexOf("function ScreenFallback"),
  )
  assert.match(routine, /listingCardCreateFromSupplier\(product\.productId\)/)
  assert.match(routine, /listingCardSaveStore\(cardId, entry\.storeId\)/)
  assert.match(routine, /listingCardSavePsd\(cardId, entry\.psd\.sha256, entry\.psd\.fileName\)/)
})

test("「从商库添加」带选品意图进商库，壳层离开时收口", () => {
  const source = readFileSync(new URL("../app/screen-catalog.tsx", import.meta.url), "utf8")
  // 上架列表的工具行不是平跳：pick 先落地址，screen 再交给壳层。
  const listing = source.slice(source.indexOf('case "listing"'), source.indexOf('case "catalog"'))
  assert.match(listing, /withCatalogPick\(window\.location\.search\)/)
  assert.match(listing, /onNavigate\("catalog"\)/)
  // 商库屏的回程只说「回哪儿」，pick 由壳层收。
  const catalog = source.slice(source.indexOf('case "catalog"'), source.indexOf('case "supplier-dbs"'))
  assert.match(catalog, /onExitPick=\{\(\) => onNavigate\("listing"\)\}/)

  // 意图只在商库屏成立：其余换屏一律收掉，免得多天后再进商库还停在选品模式。
  const shell = readFileSync(new URL("../app/authenticated-app.tsx", import.meta.url), "utf8")
  assert.match(shell, /next === "catalog" \? search : withoutCatalogPick\(search\)/)
  assert.match(shell, /const search = nextSearch\(withScreen\(window\.location\.search, next\)\)/)
})

test("进度条先把 cardId 写进地址，换屏才带进批量上架的那张卡", () => {
  const shell = readFileSync(new URL("../app/app-shell.tsx", import.meta.url), "utf8")
  assert.match(shell, /peekListingWorkbench\(\)\.cardId/)
  assert.match(shell, /withWorkflowCardId\(window\.location\.search, cardId\)/)
  // 反向口径：从批量上架起跳的换屏收掉 cardId，导航落点是主列表而不是上次的卡。
  const surface = readFileSync(new URL("../lib/admin-surface.ts", import.meta.url), "utf8")
  assert.match(surface, /from === "listing"\) params\.delete\("cardId"\)/)
})
test("platform administration lives behind the settings sheet's super_admin gate", () => {
  const source = readFileSync(
    new URL("../app/settings-dialog.tsx", import.meta.url),
    "utf8",
  )
  // The sheet consumes the vocabulary's own rank filter; which rows that is
  // is pinned behaviourally in settings-sections.test.ts.
  assert.match(source, /settingsRowsFor\(overview\?\.session\.role\)/)
  // The section table itself lives in the React-free vocabulary module now;
  // the sheet keeps the role filter and the pane bodies.
  const sections = readFileSync(
    new URL("./settings-sections.ts", import.meta.url),
    "utf8",
  )
  assert.match(sections, /group: "平台管理"/)
  for (const id of [
    "users",
    "ocr",
    "media",
    "payment",
    "proxy",
    "prompts",
    "banned-tags",
    "categories",
    "redeem-codes",
    "agents",
    "admin-logs",
    "plan-orders",
  ]) {
    assert.match(sections, new RegExp(`id: "${id}"`))
  }
})

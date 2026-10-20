import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { AppShell } from "@/app/app-shell"
import { NotificationsProvider } from "@/features/notifications/notifications"
import { NAVIGATION } from "@/lib/app-navigation"
import { SCREEN_LABELS } from "@/lib/app-screens"

import type { AccountOverview, OzonStoreView } from "@/bindings/commands"
import type {
  SellerPlatformProduct,
  SellerShippingReadiness,
} from "@/bindings/http-supply-chain"
import type { SellerSupplierDbCatalogData } from "@/bindings/http-supplier-dbs-catalog"

import {
  CatalogScreen,
  catalogListingIdentity,
  loadCatalogOnce,
  type CatalogHttp,
} from "./catalog-screen"
import { assertSellerSurfaceClean } from "./seller-leak"
import { ShippingInjectPanel } from "./shipping-inject-panel"

const product: SellerPlatformProduct = {
  product_id: "prd_1",
  title: "平台短袖",
  publication: "published",
  media: [],
  specs: {},
  skus: [
    {
      sku_id: "sku_1",
      title: "白色 M",
      platform_code: "SHIP-E",
      platform_price_cents: 1250,
      publication: "published",
      available: true,
      media: [],
      specs: {},
    },
  ],
}

const catalog: SellerSupplierDbCatalogData = {
  dbs: [{ sourceId: "src_1", name: "美国3C厂", country: "US", icon: "🏭" }],
  propDefs: [],
  rows: [
    {
      productId: "prd_1",
      sourceId: "src_1",
      listable: true,
      title: "平台短袖",
      platformCode: "SHIP-E",
      descriptionCategoryId: 17030122,
      typeId: 971000156,
      platformPriceCents: 1250,
      suggestedRetailCents: null,
      suggestedOldPriceCents: null,
      leadTime: "2–3 天",
      gallery: [],
      productVideos: [],
      fixedTags: ["节日"],
      description: "",
      props: {},
      listedAtMs: Date.now(),
    },
  ],
}

const store = {
  id: "store-uuid",
  label: "注入店",
  configured: true,
  cloud_status: "active",
  cloud_store_uuid: "store-uuid",
} as OzonStoreView

const unknown: SellerShippingReadiness = {
  sku_id: "sku_1",
  status: "blocked",
  inject_ready: false,
  reasons: ["result_unknown"],
  inject_status: "unknown",
  preset_display_name: "莫斯科快递",
}

function http(row: SellerShippingReadiness): CatalogHttp {
  return {
    listSupplierDbCatalog: async () => catalog,
    getPlatformProduct: async () => product,
    getShippingReadiness: async () => row,
    ensureShipping: async () => row,
    loadCategoryTree: async () => [],
  }
}

const shellOverview = (role: string) =>
  ({
    session: {
      role,
      authenticated: true,
      email: "test@example.invalid",
      name: "Test",
    },
    workspaces: [],
    account_mode: "unaffiliated",
    owned_count: 0,
    owned_limit: 1,
  }) as AccountOverview

test("平台货源 is a workspace screen and not ops or suppliers", () => {
  const html = renderToStaticMarkup(
    <NotificationsProvider>
      <AppShell screen="catalog" onScreenChange={() => {}} onSignedOut={() => {}}>{null}</AppShell>
    </NotificationsProvider>,
  )
  assert.match(html, /平台货源/)
  assert.match(html, /批量上架/)
  assert.doesNotMatch(html, /订单发货|入仓供货/)
  assert.doesNotMatch(html, new RegExp(SCREEN_LABELS["supplier-dbs"]))
  // 工作台屏「平台货源」含管理模式文案「平台」子串，模式 tab 断言须锚定
  // NavModeSwitcher 的 aria-label 属性，不能拿裸标签当子串匹配。
  assert.doesNotMatch(html, new RegExp(`aria-label="${NAVIGATION.admin.label}"`))
})

test("主菜单只给 staff 渲染「平台管理」模式，列表管理在其下", () => {
  const shell = (role: string, screen: "catalog" | "supplier-dbs" = "catalog") =>
    renderToStaticMarkup(
      <NotificationsProvider>
        <AppShell
          screen={screen}
          overview={shellOverview(role)}
          onScreenChange={() => {}}
          onSignedOut={() => {}}
        >
          {null}
        </AppShell>
      </NotificationsProvider>,
    )
  // 模式与屏的名字归导航权威（app-navigation / app-screens），测试只读不拼。
  // 模式 tab 断言锚定 aria-label：catalog 屏「平台货源」含「平台」子串。
  const modeLabel = NAVIGATION.admin.label
  const modeTab = `aria-label="${modeLabel}"`
  const screenLabel = SCREEN_LABELS["supplier-dbs"]
  for (const role of ["admin", "super_admin"]) {
    assert.match(shell(role), new RegExp(modeTab), `${role} 看不到平台管理模式`)
    assert.doesNotMatch(shell(role), new RegExp(screenLabel), `${role} 停在 catalog 时不该看到管理屏条目`)
  }
  for (const role of ["user", "owner", "manager"]) {
    assert.doesNotMatch(shell(role), new RegExp(modeTab), `${role} 不该看到平台管理模式`)
    assert.doesNotMatch(shell(role), new RegExp(screenLabel), `${role} 不该看到管理屏条目`)
  }
  // 切进 supplier-dbs 屏：模式 tab 与其唯一条目一起画出。
  const deepLink = shell("admin", "supplier-dbs")
  assert.match(deepLink, new RegExp(screenLabel))
  assert.match(deepLink, new RegExp(modeTab))
  // 非 staff 深链同一屏：侧栏留在工作台，不出现平台管理模式。
  assert.doesNotMatch(shell("user", "supplier-dbs"), new RegExp(modeTab))
})

test("平台货源页面就是画廊：管理入口已迁到主菜单", () => {
  const html = renderToStaticMarkup(
    <NotificationsProvider>
      <CatalogScreen http={http(unknown)} stores={[store]} onOpenListing={() => {}} />
    </NotificationsProvider>,
  )
  // 画廊只有卖家面形态：没有视图切换、没有管理入口、没有目标店铺选择器。
  assert.doesNotMatch(
    html,
    new RegExp(`${SCREEN_LABELS["supplier-dbs"]}|返回画廊|平台货源视图|role="tablist"`),
  )
  assert.doesNotMatch(html, /aria-label="目标店铺"/)
  // 管理面不再从画廊路由：没有 supplier-dbs 的入口/视图状态/面包屑段。
  // 顶部文档注释点名了迁走的屏——按代码行过滤后再断言。
  const source = readFileSync(new URL("./catalog-screen.tsx", import.meta.url), "utf8")
  const codeLines = source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith("*") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")
    })
    .join("\n")
  assert.doesNotMatch(
    codeLines,
    /SupplierDbsScreen|supplier-db-nav|openSupplierDbId|setTab|manageEntry|isPlatformStaffRole/,
  )
  assert.match(source, /useTrailSegment\(shippingProduct\?\.title \?\? selected\?\.title, exitDrill\)/)
})

test("catalog screen source stays on supply-chain APIs", () => {
  const source = readFileSync(new URL("./catalog-screen.tsx", import.meta.url), "utf8")
  const http = readFileSync(new URL("../../bindings/http-supply-chain.ts", import.meta.url), "utf8")
  const galleryHttp = readFileSync(
    new URL("../../bindings/http-supplier-dbs-catalog.ts", import.meta.url),
    "utf8",
  )
  assert.match(source, /supplyChainHttp/)
  assert.match(http, /workspacesStoresByUuidShippingEnsure/)
  assert.match(http, /workspacesStoresByUuidShippingReadiness/)
  assert.match(galleryHttp, /supplier-dbs\/catalog/)
  assert.doesNotMatch(source, /from "@\/features\/ops|opsHttp|supplierHttp|\/api\/admin\//)
  assert.doesNotMatch(source, /再创建一次/)
  assert.doesNotMatch(http, /\/api\/admin\//)
  assert.doesNotMatch(galleryHttp, /\/api\/admin\//)
})

test("选品模式给模式条与回程：从「批量上架」进来不迷路", () => {
  const picking = renderToStaticMarkup(
    <CatalogScreen
      picking
      stores={[store]}
      http={http(unknown)}
      onOpenListing={() => {}}
      onExitPick={() => {}}
    />,
  )
  assert.match(picking, /data-catalog-picking=""/)
  assert.match(picking, /选品模式：把商品加进「上架清单」，再一次批量导入。/)
  assert.match(picking, /返回批量上架/)
  // 模式条不是错误面：不抢 role="alert"，也不另开一个工具行。
  assert.doesNotMatch(picking, /data-catalog-picking=""[^>]*role="alert"/)

  // 平进商库（侧边栏/深链）不留模式条，也不给「返回批量上架」。
  const browsing = renderToStaticMarkup(
    <CatalogScreen
      stores={[store]}
      http={http(unknown)}
      onOpenListing={() => {}}
      onExitPick={() => {}}
    />,
  )
  assert.doesNotMatch(browsing, /data-catalog-picking|选品模式|返回批量上架/)
})

test("选品模式的事实源是地址：屏读 ?pick=1，画廊据此摊开清单", () => {
  const source = readFileSync(new URL("./catalog-screen.tsx", import.meta.url), "utf8")
  assert.match(source, /const picking = pickingProp \?\? readCatalogPick\(search\)/)
  assert.match(source, /\{picking \? <CatalogPickingBar onExit=\{onExitPick\} \/> : null\}/)
  assert.match(source, /picking=\{picking\}/)

  const gallery = readFileSync(
    new URL("./gallery/supplier-dbs-gallery.tsx", import.meta.url),
    "utf8",
  )
  assert.match(gallery, /useEffect\(\(\) => \{\s*setQueueOpen\(picking\)\s*\}, \[picking\]\)/)
})

test("清单行的店铺列表与「去店铺页添加」出口由屏透传给画廊", () => {
  const screen = readFileSync(new URL("./catalog-screen.tsx", import.meta.url), "utf8")
  // 画廊不自己读 roster、也不自己找路：店铺与出口都从屏上递下去。
  assert.match(screen, /stores={configured}/)
  assert.match(screen, /onOpenStores={onOpenStores}/)
  const gallery = readFileSync(
    new URL("./gallery/supplier-dbs-gallery.tsx", import.meta.url),
    "utf8",
  )
  assert.match(gallery, /stores={stores}/)
  assert.match(gallery, /onOpenStores={onOpenStores}/)
})

test("product → shop inject snapshot stays leak-free", () => {
  const markup = renderToStaticMarkup(
    <ShippingInjectPanel readiness={unknown} shopName={store.label} />,
  )
  assert.match(markup, /平台物流配置/)
  assert.match(markup, /莫斯科快递/)
  assert.match(markup, /注入店/)
  assert.match(markup, /物流配置状态待核对，请勿重复提交/)
  assert.doesNotMatch(markup, /再创建一次/)
  assertSellerSurfaceClean(unknown, markup)
})

test("catalog host renders without leaking supplier chrome", () => {
  const markup = renderToStaticMarkup(
    <CatalogScreen workspaceId={1} stores={[store]} http={http(unknown)} onOpenListing={() => {}} />,
  )
  assert.match(markup, /data-catalog-screen/)
  assert.doesNotMatch(markup, /供货来源|再创建一次|operationId|supplier_id/)
  assertSellerSurfaceClean({ catalog, readiness: unknown }, markup)
})

test("同一次货盘读取合并进行中的请求", async () => {
  let calls = 0
  const load = () => {
    calls += 1
    return Promise.resolve(catalog)
  }
  const [first, second] = await Promise.all([loadCatalogOnce(load), loadCatalogOnce(load)])
  assert.equal(first, second)
  assert.equal(calls, 1)
  await loadCatalogOnce(load)
  assert.equal(calls, 2)
})

test("进入上架只传递最小商品身份，不携带物流或管理配置", () => {
  const rowWithBaggage = { ...catalog.rows[0]!, platforms: ["ozon", "wb"], readiness: "x" }
  const identity = catalogListingIdentity(rowWithBaggage)
  assert.deepEqual(identity, {
    productId: "prd_1",
    sourceId: "src_1",
    title: "平台短袖",
    platformCode: "SHIP-E",
  })
})

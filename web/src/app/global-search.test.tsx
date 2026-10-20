/**
 * 全局搜索 provider 纯函数 — 命中/排序/分组上限/降级/键盘游标/高亮切分，以及
 * 选中后落到地址的导航目标。数据 fixtures 全部走 buildSearchProviders 的纯数据
 * 缝（不碰 HTTP，不发请求）；组件 markup 断言走 renderToStaticMarkup。
 */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type { OzonStoreView } from "@/bindings/commands"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import {
  buildSearchProviders,
  catalogProductSearch,
  GlobalSearch,
  highlightParts,
  listingCardSearch,
  SEARCH_GROUP_LIMIT,
  searchGroups,
  SearchResultListbox,
  stepActive,
  supplierDbOpenSearch,
  type SearchProviderDeps,
} from "./global-search"

const audience = { isAgent: false, isStaff: true }
const noop = () => {}

function db(overrides: Partial<SupplierDb> = {}): SupplierDb {
  return {
    sourceId: "src_1",
    name: "星途",
    country: "CN",
    contact: "",
    internalNote: "",
    listed: true,
    icon: "",
    viewPrefs: null,
    rowCount: 12,
    publishedCount: 8,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...overrides,
  }
}

function store(overrides: Partial<OzonStoreView> = {}): OzonStoreView {
  return {
    active: false,
    advertising_client_id: "",
    advertising_configured: false,
    assignee_key_manage: false,
    can_edit_credential: true,
    can_manage: true,
    client_id: "4877007",
    configured: true,
    id: "uuid-store-1",
    label: "Ozon 4877007",
    needs_reentry: false,
    permissions: {
      delete_store: true,
      edit_name: true,
      manage_key: true,
      manage_key_grants: false,
      manage_store: true,
      manage_tags: true,
      test_key: true,
    },
    ref_id: "123456",
    secret_status: "present",
    updated_at_ms: 0,
    watermark_name: "",
    ...overrides,
  }
}

function deps(overrides: Partial<SearchProviderDeps> = {}): SearchProviderDeps {
  return {
    audience,
    adminSurface: false,
    supplierDbCatalogRows: [
      { productId: "scp_1", title: "15盎司白色马克杯", dbName: "星途" },
      { productId: "scp_2", title: "陶瓷马克杯（大）", dbName: "星途" },
      { productId: "scp_3", title: "纯棉T恤", dbName: "星途" },
    ],
    supplierDbs: [db()],
    workspaceStores: [store()],
    listingPlan: { cardId: "card_9", cardName: "圣诞马克杯方案" },
    onScreenChange: noop,
    onOpenSettings: noop,
    ...overrides,
  }
}

test("searchGroups 命中五类来源并按组返回：商库商品/页面/店铺/上架方案", () => {
  const groups = searchGroups("马克", buildSearchProviders(deps()))
  assert.deepEqual(
    groups.map((group) => group.id),
    ["catalog-products", "listing-plans"],
  )
  const products = groups[0]
  assert.equal(products.label, "商库商品")
  assert.deepEqual(
    products.hits.map((hit) => hit.key),
    ["catalog-product-scp_1", "catalog-product-scp_2"],
  )
  assert.equal(products.hits[0].hint, "星途")
  const plans = groups[1]
  assert.deepEqual(
    plans.hits.map((hit) => hit.key),
    ["listing-plan-card_9"],
  )
})

test("searchGroups 前缀命中排在该组前面，组内其余保持输入顺序", () => {
  const source = deps({
    supplierDbCatalogRows: [
      { productId: "scp_a", title: "15盎司白色马克杯", dbName: "星途" },
      { productId: "scp_b", title: "马克杯-白瓷", dbName: "星途" },
      { productId: "scp_c", title: "陶瓷马克杯", dbName: "星途" },
    ],
  })
  const [products] = searchGroups("马克杯", buildSearchProviders(source))
  assert.deepEqual(
    products.hits.map((hit) => hit.key),
    ["catalog-product-scp_b", "catalog-product-scp_a", "catalog-product-scp_c"],
  )
})

test("searchGroups 每组最多五条", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    productId: `scp_${i}`,
    title: `马克杯 ${i + 1} 号`,
    dbName: "星途",
  }))
  const [products] = searchGroups(
    "马克杯",
    buildSearchProviders(deps({ supplierDbCatalogRows: rows })),
  )
  assert.equal(products.hits.length, SEARCH_GROUP_LIMIT)
  assert.equal(products.hits.length, 5)
  assert.deepEqual(
    products.hits.map((hit) => hit.key),
    ["catalog-product-scp_0", "catalog-product-scp_1", "catalog-product-scp_2", "catalog-product-scp_3", "catalog-product-scp_4"],
  )
})

test("降级：数据源未加载的组不注册不出现", () => {
  const providers = buildSearchProviders(
    deps({
      supplierDbCatalogRows: undefined,
      supplierDbs: undefined,
      workspaceStores: undefined,
      listingPlan: undefined,
    }),
  )
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["pages"],
  )
  // 页面语义保留：搜「订单」命中「订单发货」与「委托订单」，选中走换屏。
  const [pages] = searchGroups("订单", providers)
  assert.ok(pages)
  assert.deepEqual(
    pages.hits.map((hit) => hit.label),
    ["订单发货", "委托订单"],
  )
  const screens: string[] = []
  const withSpy = deps({ onScreenChange: (screen) => screens.push(screen) })
  searchGroups("订单发货", buildSearchProviders(withSpy))[0].hits[0].open()
  assert.deepEqual(screens, ["ops-shipping"])
})

test("降级：/admin 管理面只保留页面导航（员工屏 + 设置面板），不掺业务数据", () => {
  const settings: string[] = []
  const providers = buildSearchProviders(
    deps({
      adminSurface: true,
      adminSections: [
        {
          id: "users",
          group: "workspace",
          label: "成员与席位",
          account: false,
          admin: false,
          wide: false,
          title: "成员与席位",
          description: "Workspace 的成员与席位",
        },
      ],
      onOpenSettings: (section) => settings.push(section),
    }),
  )
  assert.deepEqual(
    providers.map((provider) => provider.id),
    ["pages"],
  )
  const groups = searchGroups("成员", providers)
  assert.deepEqual(
    groups[0].hits.map((hit) => hit.key),
    ["settings-users"],
  )
  groups[0].hits[0].open()
  assert.deepEqual(settings, ["users"])
  // 管理面上业务词不再命中任何组。
  assert.deepEqual(searchGroups("马克杯", providers), [])
})

test("店铺组沿用 roster 的匹配口径（名称/Client ID/指派人/标签）", () => {
  const groups = searchGroups(
    "4877007",
    buildSearchProviders(
      deps({
        supplierDbCatalogRows: undefined,
        supplierDbs: undefined,
        listingPlan: undefined,
      }),
    ),
  )
  assert.deepEqual(
    groups.map((group) => group.id),
    ["stores"],
  )
  assert.equal(groups[0].hits[0].label, "Ozon 4877007")
  assert.equal(groups[0].hits[0].hint, "4877007")
  const screens: string[] = []
  searchGroups(
    "4877007",
    buildSearchProviders(
      deps({
        supplierDbCatalogRows: undefined,
        supplierDbs: undefined,
        listingPlan: undefined,
        onScreenChange: (screen) => screens.push(screen),
      }),
    ),
  )[0].hits[0].open()
  assert.deepEqual(screens, ["stores"])
})

test("命中子串高亮：首处、大小写不敏感、无命中返回 null", () => {
  assert.deepEqual(highlightParts("15盎司白色马克杯", "马克"), [
    "15盎司白色",
    "马克",
    "杯",
  ])
  assert.deepEqual(highlightParts("Ozon POD Store", "pod"), [
    "Ozon ",
    "POD",
    " Store",
  ])
  assert.equal(highlightParts("纯棉T恤", "马克"), null)
  assert.equal(highlightParts("任意", "  "), null)
})

test("键盘游标：上下移动并在整组扁平结果上循环，其他键不接手", () => {
  assert.equal(stepActive("ArrowDown", 0, 3), 1)
  assert.equal(stepActive("ArrowDown", 2, 3), 0)
  assert.equal(stepActive("ArrowUp", 0, 3), 2)
  assert.equal(stepActive("ArrowUp", 2, 3), 1)
  assert.equal(stepActive("Enter", 1, 3), null)
  assert.equal(stepActive("ArrowDown", 0, 0), null)
})

test("带参数导航目标：钻取键骑在目标屏自己的地址上", () => {
  // 商库商品：product 是 catalog 屏的钻取键，跨屏跳转时外来键被收掉。
  assert.equal(
    catalogProductSearch("?screen=listing&cardId=card-1", "scp_1"),
    "?screen=catalog&product=scp_1",
  )
  // 已在商库屏：屏自己的过滤键保留，仅换详情。
  assert.equal(
    catalogProductSearch("?screen=catalog&product=scp_0&db=src_1", "scp_2"),
    "?screen=catalog&db=src_1&product=scp_2",
  )
  // 平台货源：open 是库页的地址渲染键。
  assert.equal(supplierDbOpenSearch("", "src_9"), "?screen=supplier-dbs&open=src_9")
  assert.equal(
    supplierDbOpenSearch("?screen=console&q=hat", "src_9"),
    "?screen=supplier-dbs&open=src_9",
  )
  // 上架方案：从批量上调离时旧 cardId 被换新。
  assert.equal(
    listingCardSearch("?screen=listing&cardId=old", "card-2"),
    "?screen=listing&cardId=card-2",
  )
  assert.equal(listingCardSearch("?screen=stores", "card-2"), "?screen=listing&cardId=card-2")
})

test("选中数据项把带参数地址写进当前历史（replaceState），页面项走换屏回调", () => {
  const replaced: string[] = []
  const screens: string[] = []
  const previousWindow = (globalThis as { window?: unknown }).window
  ;(globalThis as { window?: unknown }).window = {
    location: { href: "http://localhost/?screen=console" },
    history: {
      replaceState: (_a: unknown, _b: unknown, url: string) =>
        replaced.push(String(url)),
    },
  }
  try {
    const providers = buildSearchProviders(
      deps({ onScreenChange: (screen) => screens.push(screen) }),
    )
    const flat = (q: string) =>
      searchGroups(q, providers).flatMap((group) => group.hits)
    flat("马克杯").find((hit) => hit.key === "catalog-product-scp_1")!.open()
    assert.deepEqual(replaced, ["/?screen=catalog&product=scp_1"])
    flat("星途").find((hit) => hit.key === "supplier-db-src_1")!.open()
    assert.deepEqual(replaced, [
      "/?screen=catalog&product=scp_1",
      "/?screen=supplier-dbs&open=src_1",
    ])
    flat("圣诞").find((hit) => hit.key === "listing-plan-card_9")!.open()
    assert.deepEqual(replaced, [
      "/?screen=catalog&product=scp_1",
      "/?screen=supplier-dbs&open=src_1",
      "/?screen=listing&cardId=card_9",
    ])
    // 店铺项不带参数，走壳层换屏。
    flat("4877007").find((hit) => hit.key === "store-uuid-store-1")!.open()
    assert.deepEqual(screens, ["stores"])
  } finally {
    ;(globalThis as { window?: unknown }).window = previousWindow
  }
})

test("GlobalSearch 初始 markup：combobox 语义与全站 placeholder，未聚焦不出 listbox", () => {
  const html = renderToStaticMarkup(
    <GlobalSearch
      audience={audience}
      onScreenChange={noop}
      onOpenSettings={noop}
    />,
  )
  assert.match(html, /placeholder="搜索页面与业务数据"/)
  assert.match(html, /aria-label="搜索页面与业务数据"/)
  assert.match(html, /role="combobox"/)
  assert.match(html, /aria-expanded="false"/)
  assert.doesNotMatch(html, /role="listbox"/)
})

test("SearchResultListbox：分组表头 + 连续 option id + 单个 aria-selected + 高亮", () => {
  const groups = searchGroups("马克杯", buildSearchProviders(deps()))
  const html = renderToStaticMarkup(
    <SearchResultListbox
      listboxId="sb"
      query="马克杯"
      groups={groups}
      activeIndex={1}
      onHover={noop}
      onOpen={noop}
    />,
  )
  assert.match(html, /role="listbox"/)
  assert.match(html, /aria-label="搜索结果"/)
  // 分组表头是 presentation 行，不抢 option 语义。
  assert.match(html, /role="presentation"[^>]*>商库商品</)
  assert.match(html, /id="sb-option-0"/)
  assert.match(html, /id="sb-option-1"/)
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.match(html, /15盎司白色<span class="text-brand">马克杯<\/span>/)
  // hint（库名）与页面之外的组不出现页面表头。
  assert.doesNotMatch(html, /role="presentation"[^>]*>页面</)
})

test("SearchResultListbox：无匹配保留「无匹配」行且没有 option", () => {
  const html = renderToStaticMarkup(
    <SearchResultListbox
      listboxId="sb"
      query="不存在的词"
      groups={[]}
      activeIndex={0}
      onHover={noop}
      onOpen={noop}
    />,
  )
  assert.match(html, /无匹配/)
  assert.doesNotMatch(html, /role="option"/)
})

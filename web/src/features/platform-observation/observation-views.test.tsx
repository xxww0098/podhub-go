import assert from "node:assert/strict"
import { route } from "@/api/routes"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { countLabel } from "@/features/products/products-status"
import { observationStatusReading } from "./admin-products-screen"
import { ObservationProductsTable, observationThumbnail } from "./observation-products-table"
import { observationProductKey } from "./observation-scope"
import { observedOverview, observedProduct, observedStore, STORE_B, WORKSPACE_B } from "./observation-fixtures"

function table(expanded = false) {
  const a = observedProduct()
  return renderToStaticMarkup(<ObservationProductsTable items={[a, observedProduct(WORKSPACE_B, STORE_B)]} stores={[observedStore(), observedStore(STORE_B)]} loading={false} failed={false} hasMore={false} onLoadMore={() => {}} onRetry={() => {}} initialExpandedKey={expanded ? observationProductKey(a) : null} />)
}

test("admin status counts map API fields and keep unread totals unknown", () => {
  const overview = observedOverview()
  overview.totals.on_sale = 0
  overview.totals.moderation_failed = 3
  const reading = observationStatusReading(overview)
  assert.equal(countLabel(reading.counts.onSale, reading.freshness), "0")
  assert.equal(countLabel(reading.counts.moderationFailed, reading.freshness), "3")
  const unread = observationStatusReading({ ...overview, coverage: { read: 0, total: 2 } })
  assert.equal(countLabel(unread.counts.total, unread.freshness), "—")
  const missing = observationStatusReading(undefined)
  assert.equal(countLabel(missing.counts.onSale, missing.freshness), "—")
})

test("readonly row and the actual ProductExpand subtree contain no write affordances or requests", () => {
  const previous = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = (async (_url, init) => { calls.push(init?.method ?? "GET"); throw new Error("unexpected request") }) as typeof fetch
  try {
    const collapsed = table()
    const expanded = table(true)
    assert.match(collapsed, /甲空间/)
    assert.match(collapsed, /乙空间/)
    assert.match(collapsed, /甲所有者/)
    assert.match(collapsed, /乙所有者/)
    assert.match(expanded, /销售漏斗/)
    assert.match(expanded, /FX：/)
    assert.match(expanded, /1 CNY = 10 RUB/)
    assert.match(expanded, /只读快照/)
    assert.match(collapsed, /选择本页全部商品/)
    assert.match(collapsed, /选择 SAME-OFFER/)
    assert.doesNotMatch(collapsed + expanded, /修改 .*库存|修改 .*价格|修改 .*促销|核实最新数据|保存库存|退出活动|归档|删除/)
    assert.deepEqual(calls, [])
  } finally { globalThis.fetch = previous }
})

test("compact observation rows keep identity and expanded price and grouping facts", () => {
  const collapsed = table()
  const expanded = table(true)
  for (const label of ["商品信息", "工作空间 / 所有者", "店铺", "货号", "状态", "库存", "新鲜度 / 更新"]) {
    assert.match(collapsed, new RegExp(label))
  }
  assert.match(collapsed, /SAME-OFFER/)
  assert.match(collapsed, /在 Ozon 打开 SKU 7/)
  assert.match(collapsed, /甲空间/)
  assert.match(collapsed, /甲所有者/)
  assert.match(collapsed, /aria-describedby="observation-context-/)
  assert.match(expanded, /同款：/)
  assert.match(expanded, /现价 \/ 原价：/)
  assert.match(expanded, /销售漏斗/)
})

test("admin snapshot images cannot accidentally request a Workspace-only or external thumbnail", () => {
  assert.equal(observationThumbnail(route("workspacesStoresByUuidProductsByProductIdThumbnail", { uuid: "x", product_id: "101" })), null)
  assert.equal(observationThumbnail("https://cdn.ozon.ru/image.jpg"), null)
  assert.equal(observationThumbnail("//foreign.invalid" + route("adminOpsScopes")), null)
  assert.equal(observationThumbnail(route("adminOpsScopes").replace("/ops/", "/../workspace/")), null)
  assert.equal(observationThumbnail(observedProduct().product.image_url), observedProduct().product.image_url!)
  const item = observedProduct()
  item.product.image_url = "https://foreign.invalid/secret.jpg"
  const markup = renderToStaticMarkup(<ObservationProductsTable items={[item]} stores={[]} loading={false} failed={false} hasMore={false} onLoadMore={() => {}} onRetry={() => {}} />)
  assert.doesNotMatch(markup, /foreign\.invalid/)
})

test("loading/empty/retry states never render error text or an alert block", () => {
  const render = (loading: boolean, failed: boolean) => renderToStaticMarkup(<ObservationProductsTable items={[]} stores={[]} loading={loading} failed={failed} hasMore={false} onLoadMore={() => {}} onRetry={() => {}} />)
  const loading = render(true, false)
  const empty = render(false, false)
  const failed = render(false, true)
  for (const state of [loading, empty, failed]) {
    assert.match(state, /<thead/)
    assert.match(state, /商品信息/)
    assert.match(state, /工作空间 \/ 所有者/)
    assert.match(state, /新鲜度 \/ 更新/)
  }
  assert.match(loading, /skeleton/)
  assert.match(empty, /暂无商品快照/)
  assert.match(failed, /aria-label="重试商品"/)
  assert.doesNotMatch(failed, /role="alert"/)
})

import assert from "node:assert/strict"
import { route } from "@/api/routes"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ObservationProductsTable, observationThumbnail } from "./observation-products-table"
import { observationProductKey } from "./observation-scope"
import { observedProduct, observedStore, STORE_B, WORKSPACE_B } from "./observation-fixtures"

function table(expanded = false) {
  const a = observedProduct()
  return renderToStaticMarkup(<ObservationProductsTable items={[a, observedProduct(WORKSPACE_B, STORE_B)]} stores={[observedStore(), observedStore(STORE_B)]} loading={false} failed={false} hasMore={false} onLoadMore={() => {}} onRetry={() => {}} initialExpandedKey={expanded ? observationProductKey(a) : null} />)
}

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
    assert.doesNotMatch(collapsed + expanded, /修改 .*库存|修改 .*价格|修改 .*促销|核实最新数据|保存库存|退出活动|归档|删除|type="checkbox"/)
    assert.deepEqual(calls, [])
  } finally { globalThis.fetch = previous }
})

test("admin snapshot images cannot accidentally request a Workspace-only or external thumbnail", () => {
  assert.equal(observationThumbnail(route("workspacesStoresByUuidProductsByProductIdThumbnail", { uuid: "x", product_id: "101" })), null)
  assert.equal(observationThumbnail("https://cdn.ozon.ru/image.jpg"), null)
  assert.equal(observationThumbnail("//foreign.invalid" + route("adminOpsScopes")), null)
  assert.equal(observationThumbnail(route("adminOpsScopes").replace("/ops/", "/../workspace/")), null)
  assert.equal(observationThumbnail(observedProduct().product.image_url), observedProduct().product.image_url!)
})

test("loading/empty/retry states never render error text or an alert block", () => {
  const render = (loading: boolean, failed: boolean) => renderToStaticMarkup(<ObservationProductsTable items={[]} stores={[]} loading={loading} failed={failed} hasMore={false} onLoadMore={() => {}} onRetry={() => {}} />)
  assert.match(render(true, false), /skeleton/)
  assert.match(render(false, false), /未同步的店铺不是零商品/)
  assert.match(render(false, true), /重试商品/)
  assert.doesNotMatch(render(false, true), /role="alert"/)
})

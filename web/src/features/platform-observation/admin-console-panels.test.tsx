import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { summarizeStoreRoster } from "@/features/console/console-metrics"
import type { OzonStoreView } from "@/bindings/commands"
import { AdminConsoleAttention, AdminConsoleMetrics, AdminProductStates, AdminSalesTrendPanel, AdminStoreRanking } from "./admin-console-panels"
import { observationLedgerSummary, observationProductsSummary, observationRosterSnapshots } from "./observation-console-model"
import { observedConsole, observedOverview, STAMP, STORE_A, STORE_B } from "./observation-fixtures"

test("absent and unread snapshots stay unknown even when old counts are present", () => {
  const overview = observedOverview()
  const products = observationProductsSummary({ ...overview, coverage: { read: 0, total: 2 } }, { stores: [] })
  const missing = renderToStaticMarkup(<AdminConsoleMetrics />)
  assert.match(missing, /30 日出单<\/dt><dd[^>]*><span[^>]*>—/)
  assert.match(missing, /7 日上架提交<\/dt><dd[^>]*><span[^>]*>—/)
  assert.match(renderToStaticMarkup(<AdminConsoleMetrics products={products} />), /在售商品<\/dt><dd[^>]*><span[^>]*>—/)
  const attention = renderToStaticMarkup(<AdminConsoleAttention products={products} onOpenProducts={() => {}} />)
  assert.match(attention, /隐藏 \/ 审核失败<\/dt><dd[^>]*>—/)
  assert.match(attention, /零库存<\/dt><dd[^>]*>—/)
  assert.match(attention, /连续 5 日断单<\/dt><dd[^>]*>—/)
})

test("readable zero sales and exact server ledger values remain visible", () => {
  const snapshot = observedConsole()
  const roster = summarizeStoreRoster(observationRosterSnapshots(snapshot.roster.stores, snapshot.metrics.map((row) => ({ ...row, ordered_units_30d: 0, day_series_14d: Array(14).fill(0) }))), STAMP)
  const ledger = observationLedgerSummary(snapshot.ledger)
  const markup = renderToStaticMarkup(<AdminConsoleMetrics roster={roster} ledger={ledger} />)
  assert.match(markup, /30 日出单<\/dt><dd[^>]*><span[^>]*>0<span/)
  assert.match(markup, /7 日上架提交<\/dt><dd[^>]*><span[^>]*>11<span/)
  assert.match(markup, /7 日已收敛<\/dt><dd[^>]*><span[^>]*>7<span/)
})

test("daily mini bars only appear when their real series has values", () => {
  const trend = [{ day: "2026-10-11", orderedUnits: 2, listedUnits: 0 }, { day: "2026-10-12", orderedUnits: 3, listedUnits: 0 }]
  const snapshot = observedConsole()
  const roster = summarizeStoreRoster(observationRosterSnapshots(snapshot.roster.stores, snapshot.metrics), STAMP)
  const withTrend = renderToStaticMarkup(<AdminConsoleMetrics roster={roster} trend={trend} />)
  const withoutTrend = renderToStaticMarkup(<AdminConsoleMetrics trend={trend} />)
  assert.match(withTrend, /近 2 日每日出单量走势/)
  assert.doesNotMatch(withoutTrend, /每日出单量走势/)
})

test("rank shares use all readable stores and stay unknown when the total is zero", () => {
  const rows = Array.from({ length: 6 }, (_, index) => ({ storeId: String(index), name: `店 ${index + 1}`, units: 10, deltaPct: null }))
  const markup = renderToStaticMarkup(<AdminStoreRanking rows={rows} />)
  assert.match(markup, /6 家可读店铺/)
  assert.equal((markup.match(/16\.7%/g) ?? []).length, 5)
  assert.doesNotMatch(markup, /店 6/)
  const zero = renderToStaticMarkup(<AdminStoreRanking rows={[{ ...rows[0]!, units: 0 }]} />)
  assert.doesNotMatch(zero, /NaN|Infinity|0\.0%/)
})

test("trend controls expose only the available windows and keep the empty state honest", () => {
  const markup = renderToStaticMarkup(<AdminSalesTrendPanel points={[]} coverageRead={0} coverageTotal={1} active={false} />)
  assert.match(markup, /近 7 日/)
  assert.match(markup, /近 14 日/)
  assert.match(markup, /暂无可绘制的每日数据/)
  assert.doesNotMatch(markup, /近 30 日|近 90 日/)
})

test("a non-overlapping ledger is never described as zero submissions", () => {
  const markup = renderToStaticMarkup(<AdminSalesTrendPanel points={[{ day: "2026-09-01", orderedUnits: 0, listedUnits: 0 }]} includeListings={false} coverageRead={1} coverageTotal={1} active={false} />)
  assert.match(markup, /上架日期不完整，未绘制/)
  assert.match(markup, /连续 1 日无出单/)
  assert.doesNotMatch(markup, /无出单和上架提交/)
})

test("quota card explains a mix of limited and unlimited stores", () => {
  const store = (id: string, limit: number) => ({ id, cloud_store_uuid: id, product_quota: { total: { limit, usage: 10 } } } as OzonStoreView)
  const mixed = observationProductsSummary(observedOverview(), { stores: [store(STORE_A, -1), store(STORE_B, 100)] })
  const unlimited = observationProductsSummary(observedOverview(), { stores: [store(STORE_A, -1)] })
  const mixedMarkup = renderToStaticMarkup(<AdminConsoleMetrics products={mixed} />)
  const unlimitedMarkup = renderToStaticMarkup(<AdminConsoleMetrics products={unlimited} />)
  assert.match(mixedMarkup, /20 \/ —/)
  assert.match(mixedMarkup, /2\/2 家提供额度 · 1 家不限/)
  assert.match(unlimitedMarkup, /10 \/ 不限/)
  assert.match(unlimitedMarkup, /1\/2 家提供额度/)
})

test("partial product counts are displayed as unknown", () => {
  const overview = observedOverview()
  const products = observationProductsSummary({ ...overview, stores: [overview.stores[0]!, { ...overview.stores[1]!, count_on_sale: null, count_hidden: null }] }, { stores: [] })
  const metrics = renderToStaticMarkup(<AdminConsoleMetrics products={products} />)
  const attention = renderToStaticMarkup(<AdminConsoleAttention products={products} onOpenProducts={() => {}} />)
  assert.match(metrics, /在售商品<\/dt><dd[^>]*><span[^>]*>—/)
  assert.match(attention, /隐藏 \/ 审核失败<\/dt><dd[^>]*>—/)
})

test("zero stock is unknown when a readable store lacks its count", () => {
  const overview = observedOverview()
  const products = observationProductsSummary({ ...overview, stores: [overview.stores[0]!, { ...overview.stores[1]!, count_zero_stock: null }] }, { stores: [] })
  const markup = renderToStaticMarkup(<AdminConsoleAttention products={products} onOpenProducts={() => {}} />)
  assert.match(markup, /零库存<\/dt><dd[^>]*>—/)
})

test("product state bars exclude expired and never-synced stores and handle real zero", () => {
  const overview = observedOverview()
  const stores = overview.stores.map((store, index) => ({ ...store, freshness: index ? "never" as const : "expired" as const }))
  const unread = observationProductsSummary({ ...overview, stores, coverage: { read: 0, total: 2 } }, { stores: [] })
  const zero = observationProductsSummary({ ...overview, totals: { ...overview.totals, total: 0 }, stores: overview.stores.map((store) => ({ ...store, count_total: 0, count_on_sale: 0, count_hidden: 0, count_moderation_failed: 0, count_archived: 0 })) }, { stores: [] })
  const noSnapshot = renderToStaticMarkup(<AdminProductStates summary={unread} active={false} />)
  const noProducts = renderToStaticMarkup(<AdminProductStates summary={zero} active={false} />)
  assert.match(noSnapshot, /该范围尚无可用商品镜像/)
  assert.match(noProducts, /在售、隐藏、审核失败及归档均为 0/)
  assert.doesNotMatch(noSnapshot + noProducts, /NaN|Infinity|85\.0%/)
})

test("product distribution only counts readable snapshots", () => {
  const products = observationProductsSummary(observedOverview(), { stores: [] })
  const markup = renderToStaticMarkup(<AdminProductStates summary={products} active={false} />)
  assert.match(markup, /商品生命周期分布，共 200 件/)
  assert.match(markup, /在售 170/)
  assert.match(markup, /85\.0%/)
  assert.match(markup, /未同步与失效快照不计入/)
  assert.match(markup, /bg-st-good[^>]*><\/span><span[^>]*>在售<\/span>/)
  assert.match(markup, /bg-st-flight[^>]*><\/span><span[^>]*>已隐藏<\/span>/)
})

test("an incomplete fresh snapshot is not included in the distribution", () => {
  const overview = observedOverview()
  const products = observationProductsSummary({ ...overview, coverage: { read: 1, total: 2 }, stores: [overview.stores[0]!, { ...overview.stores[1]!, count_hidden: null }] }, { stores: [] })
  const markup = renderToStaticMarkup(<AdminProductStates summary={products} active={false} />)
  assert.match(markup, /商品状态快照不完整，无法计算分布/)
  assert.doesNotMatch(markup, /商品生命周期分布，共|85\.0%/)
})

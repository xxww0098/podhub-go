import { useMemo } from "react"
import { ArrowRight, Gauge, Package, PackageSearch, TrendingUp } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useScreenActive } from "@/components/screen-pane"
import { MetricCard, MiniBars, QuotaMeter, Sparkline } from "@/features/console/console-kpi"
import { ConsoleSkeleton } from "@/features/console/console-skeleton"
import { LedgerSummaryPanel } from "@/features/console/console-ledger-panel"
import { LifecyclePanel, RankingPanel, SalesTrendPanel } from "@/features/console/console-panels"
import { summarizeStoreRoster, summarizeStoreSales } from "@/features/console/console-metrics"
import { storeRankings } from "@/features/console/console-board"
import { formatInteger } from "@/features/console/console-format"
import { observationApi } from "./observation-api"
import { observationLedgerSummary, observationProductsSummary, observationRosterSnapshots, utcSnapshotStamp } from "./observation-console-model"
import { ObservationScopeBar } from "./observation-scope-bar"
import { useObservationScope } from "./observation-scope-provider"
import { useObservationRead } from "./use-observation-read"

/** Separate orchestration: no ConsoleScreen refresh/reconciliation side effects. */
export function AdminConsoleScreen({ onOpenProducts }: { onOpenProducts: () => void }) {
  const { scope, scopeKey, scopes } = useObservationScope()
  const read = useObservationRead(scopeKey, () => observationApi.console(scope), "无法读取平台概览快照。")
  const overview = useObservationRead(scopeKey, () => observationApi.overview(scope), "无法读取平台商品同步覆盖。")
  const reload = () => { void read.load(); void overview.load() }
  const active = useScreenActive()
  const snapshot = read.data
  const model = useMemo(() => {
    if (!snapshot || !overview.data) return null
    const now = snapshot.generated_at_ms
    const roster = summarizeStoreRoster(observationRosterSnapshots(snapshot.roster.stores, snapshot.metrics), now)
    const sales = summarizeStoreSales(roster).dailyTrend
    const ledger = observationLedgerSummary(snapshot.ledger)
    const listed = new Map(ledger.series.map((point) => [point.key, point.intake]))
    return {
      roster, ledger,
      trend: sales.map((point) => ({ ...point, listedUnits: listed.get(point.day) ?? 0 })),
      products: observationProductsSummary(overview.data, snapshot.roster),
      ranking: storeRankings(roster.rows).map((row) => ({
        ...row, name: row.name + " · " + (scopes?.stores.find((store) => store.store_id === row.storeId)?.workspace_name ?? row.storeId.slice(0, 8)),
      })),
    }
  }, [snapshot, overview.data, scopes])
  const products = model?.products
  const quotaRatio = products?.quotaUsage && products.quotaUsage.limit > 0 ? products.quotaUsage.used / products.quotaUsage.limit : null
  return <div className="flex min-h-0 w-full flex-1 flex-col gap-4" aria-label="平台数据大屏">
    <ObservationScopeBar title="平台数据大屏" loading={read.loading || overview.loading} onReload={reload}>
      <Button variant="ghost" size="sm" onClick={onOpenProducts}>查看店铺商品<ArrowRight data-icon="inline-end" /></Button>
    </ObservationScopeBar>
    {!model || !snapshot || !products ? read.failed || overview.failed ? <div className="grid min-h-52 place-items-center"><Button variant="outline" onClick={reload}>重试快照</Button></div> : <ConsoleSkeleton /> : <>
      <p className="text-meta text-muted-foreground">统计于 {utcSnapshotStamp(snapshot.generated_at_ms)} · 经营统计活跃店铺快照 · 账本按 UTC 日口径 · 商品同步覆盖 {products.coverage.read}/{products.coverage.total} 家 · 未同步/失效不计入已知总量</p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard icon={PackageSearch} label="30 日出单" tone="brand" value={model.roster.coverage.read ? formatInteger(model.roster.totals.orderedUnits) : "暂无读数"} unit={model.roster.coverage.read ? "件" : ""} footnote={"成功读取 " + model.roster.coverage.read + "/" + model.roster.coverage.total + " 家 · 共同 UTC 口径"} visual={<Sparkline values={model.trend.map((point) => point.orderedUnits)} className="text-st-flight" />} />
        <MetricCard icon={Package} label="在售商品" tone="good" value={products.coverage.read ? formatInteger(products.totals.onSale) : "尚未同步"} unit={products.coverage.read ? "件" : ""} footnote={"同步覆盖 " + products.coverage.read + "/" + products.coverage.total + " 家"} visual={<MiniBars values={products.perStore.filter((store) => store.status === "fresh" || store.status === "stale").map((store) => store.onSale ?? 0).slice(0, 12)} className="text-st-good" />} />
        <MetricCard icon={TrendingUp} label="7 日上架与收效" tone="flight" value={formatInteger(model.ledger.createdIn7Days) + " / " + formatInteger(model.ledger.settledIn7Days)} unit="新上架 / 已收敛" footnote={"全部账本 " + formatInteger(model.ledger.total) + " 条 · UTC"} visual={<MiniBars values={model.ledger.series.slice(-7).map((point) => point.intake)} className="text-st-attest" />} />
        <MetricCard icon={Gauge} label="额度占用" value={products.quotaUsage ? formatInteger(products.quotaUsage.used) + " / " + formatInteger(products.quotaUsage.limit) : "—"} unit={products.quotaUsage ? "已用/上限（件）" : ""} footnote="云端已落地 Ozon 额度快照" visual={quotaRatio == null ? null : <QuotaMeter ratio={quotaRatio} />} />
      </div>
      <LedgerSummaryPanel summary={model.ledger} active={active} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <SalesTrendPanel points={model.trend} coverageRead={model.roster.coverage.read} coverageTotal={model.roster.coverage.total} active={active} />
        <div className="flex min-w-0 flex-col gap-4">
          <LifecyclePanel summary={products} active={active} />
          <RankingPanel rows={model.ranking} onNavigate={onOpenProducts} />
        </div>
      </div>
    </>}
  </div>
}

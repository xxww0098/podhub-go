import { useMemo } from "react"
import { ChevronDown } from "lucide-react"
import { Collapsible } from "@base-ui/react/collapsible"
import { useScreenActive } from "@/components/screen-pane"
import { LedgerSummaryPanel } from "@/features/console/console-ledger-panel"
import { summarizeStoreRoster, summarizeStoreSales } from "@/features/console/console-metrics"
import { storeRankings } from "@/features/console/console-board"
import { formatInteger } from "@/features/console/console-format"
import { observationApi } from "./observation-api"
import { alignObservationTrend, observationLedgerSummary, observationProductsSummary, observationRosterSnapshots, utcSnapshotStamp } from "./observation-console-model"
import { ObservationScopeBar } from "./observation-scope-bar"
import { useObservationScope } from "./observation-scope-provider"
import { useObservationRead } from "./use-observation-read"
import { AdminConsoleAttention, AdminConsoleMetrics, AdminProductStates, AdminSalesTrendPanel, AdminSnapshotPending, AdminStoreRanking } from "./admin-console-panels"

/** Separate orchestration: no ConsoleScreen refresh/reconciliation side effects. */
export function AdminConsoleScreen({ onOpenProducts }: { onOpenProducts: () => void }) {
  const { scope, scopeKey, scopes } = useObservationScope()
  const read = useObservationRead(scopeKey, () => observationApi.console(scope), "无法读取平台概览快照。")
  const overview = useObservationRead(scopeKey, () => observationApi.overview(scope), "无法读取平台商品同步覆盖。")
  const reload = () => { void read.load(); void overview.load() }
  const active = useScreenActive()
  const snapshot = read.data
  const model = useMemo(() => {
    if (!snapshot) return null
    const now = snapshot.generated_at_ms
    const roster = summarizeStoreRoster(observationRosterSnapshots(snapshot.roster.stores, snapshot.metrics), now)
    const sales = summarizeStoreSales(roster).dailyTrend
    const ledger = observationLedgerSummary(snapshot.ledger)
    const trend = alignObservationTrend(sales, ledger)
    return {
      roster, ledger,
      trend: trend.points, listingsComplete: trend.listingsComplete,
      ranking: storeRankings(roster.rows).map((row) => ({
        ...row, name: row.name + " · " + (scopes?.stores.find((store) => store.store_id === row.storeId)?.workspace_name ?? row.storeId.slice(0, 8)),
      })),
    }
  }, [snapshot, scopes])
  const products = useMemo(() => overview.data ? observationProductsSummary(overview.data, { stores: snapshot?.roster.stores ?? [] }) : undefined, [overview.data, snapshot])
  return <div className="flex min-h-0 w-full flex-1 flex-col gap-4" aria-label="平台数据大屏">
    <ObservationScopeBar title="平台数据大屏" loading={read.loading || overview.loading} onReload={reload} />
    <AdminConsoleMetrics roster={model?.roster} ledger={model?.ledger} products={products} trend={model?.trend} />
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {model ? <AdminSalesTrendPanel key={scopeKey} points={model.trend} includeListings={model.listingsComplete} hasLedgerActivity={model.ledger.series.some((point) => point.intake > 0)} coverageRead={model.roster.coverage.read} coverageTotal={model.roster.coverage.total} active={active} />
        : <AdminSnapshotPending title="经营趋势" failed={read.failed} onRetry={() => { void read.load() }} />}
      {products ? <AdminProductStates summary={products} active={active} /> : <AdminSnapshotPending title="商品状态" failed={overview.failed} onRetry={() => { void overview.load() }} />}
    </div>
    <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      {model ? <AdminStoreRanking rows={model.ranking} /> : <AdminSnapshotPending title="店铺出单排行" failed={read.failed} onRetry={() => { void read.load() }} />}
      <AdminConsoleAttention roster={model?.roster} ledger={model?.ledger} products={products} onOpenProducts={onOpenProducts} />
    </div>
    {model ? <Collapsible.Root key={scopeKey} className="group/ledger border-t border-border pt-1">
      <Collapsible.Trigger className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-md py-3 text-left hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-left"><span className="font-medium">上架账本</span><span className="text-meta font-normal text-muted-foreground">{formatInteger(model.ledger.total)} 条记录 · 查看趋势与结果</span></span>
        <ChevronDown aria-hidden className="size-4 shrink-0 group-data-[open]/ledger:rotate-180" />
      </Collapsible.Trigger>
      <Collapsible.Panel><LedgerSummaryPanel summary={model.ledger} active={active} /></Collapsible.Panel>
    </Collapsible.Root> : null}
    <p className="text-meta text-muted-foreground">经营快照 {utcSnapshotStamp(snapshot?.generated_at_ms)} · 商品快照 {utcSnapshotStamp(products?.newestSyncMs)} · 账本按 UTC 日统计</p>
  </div>
}

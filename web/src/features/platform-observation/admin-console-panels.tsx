import { useState } from "react"
import { ArrowRight, Bell, ChartNoAxesCombined, Clock3, Package, PackageX, RefreshCw, RotateCcw, ShieldAlert } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptySalesTrendChart, LifecycleDonutChart, lifecycleColorTone, SalesTrendChart, type SalesTrendPoint } from "@/features/console/console-charts"
import { MiniBars, QuotaMeter } from "@/features/console/console-kpi"
import { Panel } from "@/features/console/console-panels"
import { formatAge, formatInteger, formatSignedPercent } from "@/features/console/console-format"
import type { StoreRankRow } from "@/features/console/console-board"
import type { LedgerSummary, StoreRosterSummary } from "@/features/console/console-metrics"
import { lifecycleScope, type StoreProductsSummary } from "@/features/console/console-products"
import { cn } from "@/lib/utils"
import type { ObservationProductsSummary } from "./observation-console-model"

export function AdminConsoleMetrics({ roster, ledger, products, trend = [] }: {
  roster?: StoreRosterSummary
  ledger?: LedgerSummary
  products?: ObservationProductsSummary
  trend?: SalesTrendPoint[]
}) {
  const quota = products?.quotaUsage
  const quotaCoverage = products?.quotaCoverage
  const quotaLimit = quota?.limit === -1 ? quotaCoverage?.unlimited === quotaCoverage?.read ? "不限" : "—" : quota ? formatInteger(quota.limit) : ""
  const stats = [
    { label: "30 日出单", value: roster?.coverage.read ? formatInteger(roster.totals.orderedUnits) : "—", unit: roster?.coverage.read ? "件" : "", detail: roster ? `覆盖 ${roster.coverage.read}/${roster.coverage.total} 家活跃店铺` : "经营快照未读取", bars: roster?.coverage.read ? trend.map((point) => point.orderedUnits) : undefined, barsLabel: "出单量" },
    { label: "在售商品", value: products?.countsKnown.onSale ? formatInteger(products.totals.onSale) : "—", unit: products?.countsKnown.onSale ? "件" : "", detail: products ? `同步覆盖 ${products.coverage.read}/${products.coverage.total} 家` : "商品快照未读取" },
    { label: "7 日上架提交", value: ledger ? formatInteger(ledger.createdIn7Days) : "—", unit: ledger ? "条" : "", detail: "上架账本 · UTC", bars: ledger?.series.slice(-7).map((point) => point.intake), barsLabel: "上架提交" },
    { label: "7 日已收敛", value: ledger ? formatInteger(ledger.settledIn7Days) : "—", unit: ledger ? "条" : "", detail: "上架账本 · UTC", bars: ledger?.series.slice(-7).map((point) => point.settled), barsLabel: "收敛" },
    { label: "商品额度", value: quota ? `${formatInteger(quota.used)} / ${quotaLimit}` : "—", detail: quotaCoverage ? `已用 / 上限 · ${quotaCoverage.read}/${quotaCoverage.total} 家提供额度${quotaCoverage.unlimited ? ` · ${quotaCoverage.unlimited} 家不限` : ""}` : "额度快照未读取" },
  ]
  return <dl aria-label="核心指标" className="grid grid-cols-2 gap-3 xl:grid-cols-5">
    {stats.map((stat, index) => <div key={stat.label} className={cn("flex min-h-36 min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4", index === 4 && "col-span-2 xl:col-span-1")}>
      <dt className="text-compact font-medium">{stat.label}</dt>
      <dd className="flex min-w-0 items-end justify-between gap-2">
        <span className="break-words text-3xl font-semibold leading-tight tracking-tight tabular-nums">{stat.value}{stat.unit ? <span className="ml-1.5 text-meta font-normal tracking-normal text-muted-foreground">{stat.unit}</span> : null}</span>
        {stat.bars && stat.bars.length > 1 && stat.bars.some((value) => value > 0) ? <div role="img" aria-label={`近 ${stat.bars.length} 日每日${stat.barsLabel}走势`} className="shrink-0 text-st-flight">
          <MiniBars values={stat.bars} />
          <p className="mt-1 text-right text-meta text-muted-foreground">近 {stat.bars.length} 日</p>
        </div> : null}
      </dd>
      {index === 4 && products?.quotaUsage && products.quotaUsage.limit > 0 ? <QuotaMeter ratio={products.quotaUsage.used / products.quotaUsage.limit} /> : null}
      <dd className="mt-auto text-meta text-muted-foreground">{stat.detail}</dd>
    </div>)}
  </dl>
}

export function AdminSalesTrendPanel({ points, coverageRead, coverageTotal, active, includeListings = true, hasLedgerActivity = false }: {
  points: SalesTrendPoint[]
  coverageRead: number
  coverageTotal: number
  active: boolean
  includeListings?: boolean
  hasLedgerActivity?: boolean
}) {
  const [days, setDays] = useState<7 | 14>(14)
  const windowed = points.slice(-days)
  const hasAny = windowed.some((point) => point.orderedUnits > 0 || (includeListings && point.listedUnits > 0))
  return <Panel
    title={`近 ${days} 日出单与上架提交趋势`}
    icon={ChartNoAxesCombined}
    subtitle={points.length ? `${coverageRead}/${coverageTotal} 家共同口径 · 截至 ${points.at(-1)?.day}${includeListings ? "" : " · 上架日期不完整，未绘制"}` : hasLedgerActivity ? "暂无可读出单趋势，上架记录见下方账本" : "仅汇总成功读取且日期口径一致的店铺订单"}
    className="min-h-76"
    action={<div role="group" aria-label="趋势窗口" className="flex rounded-md border border-border p-0.5">
      {([7, 14] as const).map((window) => <Button key={window} type="button" size="sm" variant={days === window ? "secondary" : "ghost"} aria-pressed={days === window} onClick={() => setDays(window)}>近 {window} 日</Button>)}
    </div>}
  >
    <div className="mb-2 flex flex-wrap justify-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-st-flight" />出单量（件）</span>
      {includeListings || !points.length ? <span className="inline-flex items-center gap-1.5"><span aria-hidden className="size-2 rounded-full bg-st-unknown" />上架提交（次）</span> : null}
    </div>
    {windowed.length === 0 ? <EmptySalesTrendChart active={active} />
      : hasAny ? <SalesTrendChart points={windowed} active={active} salesStyle="bar" includeListings={includeListings} />
        : <div className="grid min-h-48 flex-1 place-items-center text-center"><div><strong className="text-3xl font-semibold tabular-nums">0 <span className="text-sm font-normal text-muted-foreground">件</span></strong><p className="mt-2 text-sm text-muted-foreground">连续 {windowed.length} 日无出单{includeListings ? "和上架提交" : ""}</p></div></div>}
  </Panel>
}

export function AdminStoreRanking({ rows }: { rows: StoreRankRow[] }) {
  const total = rows.reduce((sum, row) => sum + row.units, 0)
  return <Panel icon={ChartNoAxesCombined} title="店铺出单排行" subtitle={rows.length ? `近 30 日 · ${rows.length} 家可读店铺` : "按近 30 日出单量排序"}>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[34rem] text-left text-sm">
        <thead className="bg-muted/60 text-xs text-muted-foreground"><tr>
          <th scope="col" className="px-3 py-2 font-medium">排名</th>
          <th scope="col" className="px-3 py-2 font-medium">店铺</th>
          <th scope="col" className="px-3 py-2 text-right font-medium">30 日出单</th>
          <th scope="col" className="px-3 py-2 text-right font-medium">较上次更新</th>
          <th scope="col" className="px-3 py-2 font-medium">可读店铺占比</th>
        </tr></thead>
        <tbody>{rows.length === 0 ? <tr><td colSpan={5} className="py-8 text-center text-sm text-muted-foreground">暂无可读店铺</td></tr> : rows.slice(0, 5).map((row, index) => {
          const share = total > 0 ? row.units / total * 100 : null
          return <tr key={row.storeId} className="border-b border-border/40 last:border-b-0">
            <td className="px-3 py-2.5 tabular-nums text-muted-foreground">{index + 1}</td>
            <td className="px-3 py-2.5">{row.name}</td>
            <td className="px-3 py-2.5 text-right tabular-nums">{formatInteger(row.units)}</td>
            <td className={cn("px-3 py-2.5 text-right tabular-nums", row.deltaPct === null || row.deltaPct === 0 ? "text-muted-foreground" : row.deltaPct > 0 ? "text-st-good" : "text-st-bad")}>{formatSignedPercent(row.deltaPct)}</td>
            <td className="px-3 py-2.5"><div className="flex items-center gap-3"><span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">{share === null ? "—" : `${share.toFixed(1)}%`}</span><span aria-hidden className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-muted"><span className="block h-full rounded-full bg-st-flight/70" style={{ width: `${share ?? 0}%` }} /></span></div></td>
          </tr>
        })}</tbody>
      </table>
    </div>
  </Panel>
}

export function AdminConsoleAttention({ roster, ledger, products, onOpenProducts }: {
  roster?: StoreRosterSummary
  ledger?: LedgerSummary
  products?: ObservationProductsSummary
  onOpenProducts: () => void
}) {
  const items = [
    { label: "上架待介入", value: ledger?.needsAction, unit: "项", icon: ShieldAlert, tone: "bg-st-bad-soft text-st-bad-ink" },
    { label: "上架进行中", value: ledger?.inFlight, unit: "项", icon: Clock3, tone: "bg-st-flight-soft text-st-flight-ink" },
    { label: "隐藏 / 审核失败", value: products?.countsKnown.pending ? products.totals.pending : null, unit: "件", icon: PackageX, tone: "bg-st-attest-soft text-st-attest-ink" },
    { label: "零库存", value: products?.countsKnown.zeroStock ? products.totals.zeroStock : null, unit: "件", icon: Package, tone: "bg-st-attest-soft text-st-attest-ink" },
    { label: "连续 5 日断单", value: roster?.coverage.read ? roster.stalled.length : null, unit: "家", icon: RefreshCw, tone: "bg-muted text-muted-foreground" },
  ]
  const freshness = products ? [
    { label: "待更新", count: products.perStore.filter((store) => store.status === "stale").length },
    { label: "已失效", count: products.perStore.filter((store) => store.status === "expired").length },
    { label: "未同步", count: products.perStore.filter((store) => store.status === "never").length },
  ].filter((item) => item.count > 0) : []
  return <Panel title="需要关注" icon={Bell} action={<Button type="button" variant="ghost" size="sm" onClick={onOpenProducts}>全部 Ozon 商品<ArrowRight data-icon="inline-end" /></Button>}>
    <dl className="divide-y divide-border/60">
      {items.map((item) => <div key={item.label} className="flex items-center gap-3 py-1 first:pt-0">
        <span aria-hidden className={cn("grid size-8 shrink-0 place-items-center rounded-md", item.tone)}><item.icon className="size-4" /></span>
        <dt className="min-w-0 flex-1 text-compact">{item.label}</dt>
        <dd className={cn("shrink-0 text-compact font-semibold tabular-nums", item.value != null && item.value > 0 && item.label !== "上架进行中" && "text-st-attest-ink")}>
          {item.value == null ? "—" : formatInteger(item.value)}{item.value == null ? "" : <span className="ml-1 text-meta font-normal text-muted-foreground">{item.unit}</span>}
        </dd>
      </div>)}
    </dl>
    {ledger?.oldestActionHours != null ? <p className="mt-2 text-meta text-muted-foreground">待介入最久 {formatAge(ledger.oldestActionHours)}</p> : null}
    <div className="mt-2 border-t border-border pt-2">
      <h3 className="mb-1 text-meta font-medium">数据覆盖</h3>
      <dl className="grid gap-x-4 gap-y-1 text-meta min-[1200px]:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">经营数据 · 活跃店铺</dt><dd className="tabular-nums">{roster ? `${roster.coverage.read} / ${roster.coverage.total} 家` : "—"}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">商品镜像</dt><dd className="tabular-nums">{products ? `${products.coverage.read} / ${products.coverage.total} 家` : "—"}</dd></div>
      </dl>
      {freshness.length ? <p className="mt-1 text-meta text-muted-foreground">{freshness.map((item) => `${item.label} ${item.count} 家`).join(" · ")}</p> : null}
    </div>
  </Panel>
}

const stateColor: Record<ReturnType<typeof lifecycleColorTone>, string> = { good: "bg-st-good", flight: "bg-st-flight", unknown: "bg-st-unknown", bad: "bg-st-bad", idle: "bg-st-idle" }

export function AdminProductStates({ summary, active }: { summary: StoreProductsSummary; active: boolean }) {
  const recent = summary.perStore.filter((store) => store.status === "fresh" || store.status === "stale")
  const incomplete = summary.coverage.read > 0 && (recent.length !== summary.coverage.read || recent.some((store) =>
    store.onSale == null || store.hidden == null || store.moderationFailed == null || store.archived == null))
  const state = incomplete ? null : lifecycleScope(summary, null)
  return <Panel title="商品状态分布" icon={Package} action={<span className="text-meta text-muted-foreground">{state?.status === "ready" ? `已知 ${formatInteger(state.total)} 件` : state?.status === "empty" ? "已知 0 件" : "尚无完整快照"}</span>}>
    {state?.status === "ready" ? <div className="flex flex-1 flex-wrap items-center justify-center gap-6 py-2">
      <div className="relative shrink-0">
        <LifecycleDonutChart slices={state.slices} total={state.total} active={active} paletteMode="platform" className="size-40" />
        <div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-center"><div><p className="text-lg font-semibold tabular-nums">{formatInteger(state.total)}</p><p className="text-meta text-muted-foreground">商品总数</p></div></div>
      </div>
      <ul className="grid min-w-0 flex-1 gap-3">
        {state.slices.map((slice) => <li key={slice.key} className="flex items-center gap-2 text-compact">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", stateColor[lifecycleColorTone(slice.tone, "platform")])} />
          <span className="min-w-0 flex-1 text-muted-foreground">{slice.label}</span>
          <span className="tabular-nums">{formatInteger(slice.value)}</span>
          <span className="w-12 text-right text-meta tabular-nums text-muted-foreground">{(slice.value / state.total * 100).toFixed(1)}%</span>
        </li>)}
      </ul>
    </div> : <div className="flex flex-1 flex-wrap items-center justify-center gap-6 py-2">
      <div role="status" className="grid size-40 shrink-0 place-items-center rounded-full border-8 border-muted text-center text-compact text-muted-foreground">
        <span>{state == null ? "数据不完整" : state.status === "empty" ? "暂无商品" : "尚未同步"}</span>
      </div>
      <ul className="grid min-w-0 flex-1 gap-3" aria-label="商品状态数据">
        {["在售", "已隐藏", "审核失败", "已归档"].map((label, index) => <li key={label} className="flex items-center gap-2 text-compact">
          <span aria-hidden className={cn("size-2 shrink-0 rounded-full", ["bg-st-good", "bg-st-flight", "bg-st-bad", "bg-st-idle"][index])} />
          <span className="min-w-0 flex-1 text-muted-foreground">{label}</span>
          <span className="tabular-nums">{state?.status === "empty" ? "0" : "—"}</span>
          <span className="w-12 text-right text-meta text-muted-foreground">—</span>
        </li>)}
      </ul>
      <p className="w-full text-center text-compact text-muted-foreground">{state == null ? "商品状态快照不完整，无法计算分布" : state.status === "unsynced" ? "该范围尚无可用商品镜像" : "在售、隐藏、审核失败及归档均为 0"}</p>
    </div>}
    <p className="mt-4 text-meta text-muted-foreground">占比按四种状态合计；未同步与失效快照不计入。</p>
  </Panel>
}

export function AdminSnapshotPending({ title, failed, onRetry }: { title: string; failed: boolean; onRetry: () => void }) {
  return <Panel title={title} icon={title === "商品状态" ? Package : ChartNoAxesCombined}>
    <div role="status" className="grid min-h-62.5 flex-1 place-items-center">
      {failed ? <Button variant="outline" size="sm" onClick={onRetry}><RotateCcw data-icon="inline-start" />重试{title === "商品状态" ? "商品" : "经营"}快照</Button>
        : <div className="grid w-full gap-4" aria-label={`正在读取${title}`}><Skeleton className="h-28 w-full" /><Skeleton className="h-3 w-2/3" /></div>}
    </div>
  </Panel>
}

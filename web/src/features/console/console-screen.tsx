import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Bell, CalendarDays, ChartNoAxesCombined, ChevronRight, Package, PackageX, RefreshCw, ShieldAlert } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type { ConsoleSnapshot } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import type { AppScreen } from "@/lib/app-screens"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifyInfo } from "@/lib/notify"
import { cn } from "@/lib/utils"

import { cohortPercentDelta, CONSOLE_LEDGER_ROW_CAP, ledgerMayBeTruncated, listingDailySeries, ordersFootnote, storeRankings } from "./console-board"
import { EmptySalesTrendChart, LifecycleDonutChart, SalesTrendChart } from "./console-charts"
import { formatInteger, formatSignedPercent } from "./console-format"
import { MiniBars } from "./console-kpi"
import { refreshableStoreIds, rosterSnapshotsFromStores, summarizeLedger, summarizeStoreRoster, summarizeStoreSales } from "./console-metrics"
import { Panel } from "./console-panels"
import { lifecycleScope, summarizeStoreProducts } from "./console-products"

type ReadState = { workspaceId: number; snapshot: ConsoleSnapshot }

export const ConsoleScreen = memo(function ConsoleScreen({ workspaceId, onNavigate }: {
  workspaceId?: number
  onNavigate: (screen: AppScreen) => void
}) {
  const active = useScreenActive()
  const [read, setRead] = useState<ReadState>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const [error, setError] = useState("")
  const [storeId, setStoreId] = useState("all")
  const [days, setDays] = useState<7 | 14>(14)
  const version = useRef(0)
  const wasActive = useRef(active)
  const snapshot = read && read.workspaceId === workspaceId ? read.snapshot : undefined

  const load = useCallback(async (foreground: boolean) => {
    if (!workspaceId) return
    const request = ++version.current
    if (foreground) setLoading(true)
    try {
      const result = await opsHttp.consoleGetSnapshot()
      if (request !== version.current) return
      setRead({ workspaceId, snapshot: result })
      setError("")
    } catch (reason) {
      if (request === version.current) setError(errorMessage(reason, "无法读取工作空间经营数据。"))
    } finally {
      if (request === version.current) setLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    setStoreId("all")
    setError("")
    setRefreshing(false)
    setReconciling(false)
    void load(true)
    return () => { version.current += 1 }
  }, [load])

  useEffect(() => {
    if (active && !wasActive.current && snapshot && !refreshing && !reconciling) void load(false)
    wasActive.current = active
  }, [active, load, reconciling, refreshing, snapshot])

  const stores = snapshot?.roster.stores ?? []
  const selectedStores = storeId === "all" ? stores : stores.filter((store) => (store.cloud_store_uuid?.trim() || store.id) === storeId)
  const selectedProducts = (snapshot?.products ?? []).filter((row) => storeId === "all" || row.store_id === storeId)
  const snapshots = useMemo(() => rosterSnapshotsFromStores(selectedStores, snapshot?.metrics ?? []), [selectedStores, snapshot?.metrics])
  const roster = useMemo(() => summarizeStoreRoster(snapshots, Date.now()), [snapshots])
  const products = useMemo(() => summarizeStoreProducts(selectedProducts, selectedStores, Date.now()), [selectedProducts, selectedStores])
  const ledger = useMemo(() => summarizeLedger(snapshot?.ledger ?? [], Date.now()), [snapshot?.ledger])
  const ledgerPartial = ledgerMayBeTruncated(snapshot?.ledger ?? [])
  const sales = useMemo(() => summarizeStoreSales(roster).dailyTrend, [roster])
  const trend = useMemo(() => {
    const listed = listingDailySeries(snapshot?.ledger ?? [], sales.map((point) => point.day))
    return sales.map((point, index) => ({ ...point, listedUnits: listed[index] ?? 0 })).slice(-days)
  }, [snapshot?.ledger, sales, days])
  const ranking = useMemo(() => storeRankings(roster.rows), [roster])
  const refreshable = refreshableStoreIds(rosterSnapshotsFromStores(stores, snapshot?.metrics ?? [])).length
  const countedProducts = products.perStore.filter((row) => row.status === "fresh" || row.status === "stale")
  const onSaleKnown = products.coverage.read > 0 && countedProducts.length === products.coverage.read && countedProducts.every((row) => row.onSale != null)
  const lifecycleComplete = products.coverage.read > 0 && countedProducts.length === products.coverage.read && countedProducts.every((row) => row.onSale != null && row.hidden != null && row.moderationFailed != null && row.archived != null)
  const lifecycle = lifecycleComplete ? lifecycleScope(products, null) : null
  const orderDelta = cohortPercentDelta(roster.cohortDelta)
  const failedProducts = lifecycleComplete ? countedProducts.reduce((sum, row) => sum + (row.moderationFailed ?? 0), 0) : null

  useEffect(() => {
    if (storeId !== "all" && snapshot && !snapshot.roster.stores.some((store) => (store.cloud_store_uuid?.trim() || store.id) === storeId)) setStoreId("all")
  }, [snapshot, storeId])

  const refresh = async () => {
    if (!workspaceId || !refreshable || refreshing || reconciling) return
    const request = ++version.current
    setRefreshing(true)
    try {
      const result = await opsHttp.consoleRefreshMetrics()
      if (request !== version.current) return
      setRead((current) => current?.workspaceId === workspaceId ? { ...current, snapshot: { ...current.snapshot, metrics: result.metrics } } : current)
      notifyInfo("经营指标刷新已返回，请核对各店状态。")
    } catch (reason) {
      if (request === version.current) notifyCommandError(reason, "无法刷新经营指标。")
    } finally {
      if (request === version.current) setRefreshing(false)
    }
  }

  const reconcile = async () => {
    if (!workspaceId || refreshing || reconciling) return
    const request = ++version.current
    setReconciling(true)
    try {
      const result = await opsHttp.consoleReconcileActiveWorkspace()
      if (request !== version.current) return
      notifyInfo(`已对账 ${result.reconciled}，冲突 ${result.conflicted}，仍未知 ${result.still_unknown}，跳过 ${result.skipped}`)
      try {
        const next = await opsHttp.consoleGetSnapshot()
        if (request === version.current) { setRead({ workspaceId, snapshot: next }); setError("") }
      } catch (reason) {
        if (request === version.current) notifyCommandError(reason, "对账完成，但概览重载失败。")
      }
    } catch (reason) {
      if (request === version.current) notifyCommandError(reason, "无法完成对账。")
    } finally {
      if (request === version.current) setReconciling(false)
    }
  }

  if (!workspaceId) return <div role="status" className="rounded-lg border bg-card p-8 text-sm text-muted-foreground">尚未选择工作空间。</div>
  if (!snapshot) return <div role="status" className="rounded-lg border bg-card p-8 text-sm text-muted-foreground">
    {loading ? "正在读取经营数据…" : <><p>{error || "暂无经营数据"}</p><Button className="mt-3" variant="outline" size="sm" onClick={() => void load(true)}>重试</Button></>}
  </div>

  const lifecycleRows = lifecycle?.status === "ready" ? lifecycle.slices : [
    { key: "on_sale", label: "在售", value: lifecycle?.status === "empty" ? 0 : null },
    { key: "hidden", label: "已隐藏", value: lifecycle?.status === "empty" ? 0 : null },
    { key: "moderation_failed", label: "审核失败", value: lifecycle?.status === "empty" ? 0 : null },
    { key: "archived", label: "已归档", value: lifecycle?.status === "empty" ? 0 : null },
  ]
  const attention = [
    { label: failedProducts != null && products.coverage.read < products.coverage.total ? `审核失败商品（已读 ${products.coverage.read}/${products.coverage.total} 店）` : "审核失败的商品", value: failedProducts, icon: ShieldAlert, tone: "bg-st-bad-soft text-st-bad-ink", target: "products" as const },
    { label: "待介入操作（全部店铺）", value: ledger.needsAction, icon: ShieldAlert, tone: "bg-st-attest-soft text-st-attest-ink", target: null },
    { label: products.totals.zeroStock != null && products.coverage.read < products.coverage.total ? `已知零库存（已读 ${products.coverage.read}/${products.coverage.total} 店）` : "已知零库存商品", value: products.totals.zeroStock, icon: PackageX, tone: "bg-st-attest-soft text-st-attest-ink", target: "products" as const },
    { label: "商品镜像待同步", value: products.perStore.filter((row) => row.status === "never" || row.status === "expired").length, icon: RefreshCw, tone: "bg-st-flight-soft text-st-flight-ink", target: "products" as const },
    ...(roster.rows.some((row) => row.status === "read_failed" || row.status === "rate_limited") ? [{ label: "店铺读取异常", value: roster.rows.filter((row) => row.status === "read_failed" || row.status === "rate_limited").length, icon: ShieldAlert, tone: "bg-st-bad-soft text-st-bad-ink", target: "stores" as const }] : []),
  ]

  return <div className="flex min-h-0 w-full flex-1 flex-col gap-4" aria-label="数据大屏">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-xs text-muted-foreground">{error ? `刷新失败：${error}` : `经营指标覆盖 ${roster.coverage.read}/${roster.coverage.total} 家店铺`}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={storeId} onValueChange={(value) => setStoreId(value ?? "all")}>
          <SelectTrigger size="sm" aria-label="经营数据店铺范围"><StoreIcon aria-hidden className="size-4" /><SelectValue>{storeId === "all" ? "全部店铺" : selectedStores[0]?.label ?? "未知店铺"}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">全部店铺</SelectItem>{stores.map((store) => <SelectItem key={store.cloud_store_uuid?.trim() || store.id} value={store.cloud_store_uuid?.trim() || store.id}>{store.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(days)} onValueChange={(value) => setDays(value === "7" ? 7 : 14)}>
          <SelectTrigger size="sm" aria-label="趋势窗口"><CalendarDays aria-hidden className="size-4" /><SelectValue>{`近 ${days} 日`}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="14">近 14 日</SelectItem><SelectItem value="7">近 7 日</SelectItem></SelectContent>
        </Select>
        <Button variant="outline" size="sm" aria-label="刷新全部店铺经营指标" disabled={!refreshable || refreshing || reconciling} onClick={() => void refresh()}>{refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}刷新</Button>
      </div>
    </div>

    <dl aria-label="核心指标" className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {[
        { label: "30 日出单", value: roster.coverage.read ? formatInteger(roster.totals.orderedUnits) : "—", unit: roster.coverage.read ? "件" : "", detail: ordersFootnote(roster), delta: orderDelta, bars: sales.map((point) => point.orderedUnits) },
        { label: "在售商品", value: onSaleKnown ? formatInteger(products.totals.onSale) : "—", unit: onSaleKnown ? "件" : "", detail: `商品镜像覆盖 ${products.coverage.read}/${products.coverage.total}`, bars: countedProducts.map((row) => row.onSale ?? 0) },
        { label: "7 日上架提交", value: `${ledgerPartial ? "≥ " : ""}${formatInteger(ledger.createdIn7Days)}`, unit: "次", detail: ledgerPartial ? `最近 ${formatInteger(CONSOLE_LEDGER_ROW_CAP)} 条及全部异常 · 可能不完整` : "全部店铺 · 仅统计上架提交", bars: ledgerPartial ? undefined : ledger.series.slice(-7).map((point) => point.intake) },
        { label: "待介入操作", value: formatInteger(ledger.needsAction), unit: "项", detail: "全部店铺 · 包含上架及其他操作" },
      ].map((metric) => <div key={metric.label} className="flex min-h-35 min-w-0 flex-col justify-between gap-3 rounded-lg border border-border bg-card p-4">
        <dt className="text-sm font-medium">{metric.label}</dt>
        <dd className="flex items-end justify-between gap-3"><span className="text-4xl font-semibold leading-9 tracking-tight tabular-nums">{metric.value}<span className="ml-1 text-xs font-normal text-muted-foreground">{metric.unit}</span></span>{metric.bars ? <MiniBars values={metric.bars} className="text-st-flight" /> : null}</dd>
        <dd className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">{metric.detail}{metric.delta != null ? <span className={cn("font-medium", metric.delta > 0 ? "text-st-good" : metric.delta < 0 ? "text-st-bad" : "text-muted-foreground")}>{formatSignedPercent(metric.delta)}</span> : null}</dd>
      </div>)}
    </dl>

    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(20rem,1fr)]">
      <Panel title={`近 ${days} 日出单与上架提交趋势`} icon={ChartNoAxesCombined} subtitle={ledgerPartial ? "上架提交记录可能不完整，未绘制" : storeId === "all" ? "仅汇总可读店铺；上架提交按全部店铺统计" : "出单按所选店铺；上架提交为全部店铺"} className="min-h-96">
        <div className="mb-2 flex flex-wrap gap-5 text-xs text-muted-foreground"><span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-st-flight" />出单量（件）</span>{ledgerPartial ? null : <span className="flex items-center gap-1.5"><span className="size-2 rounded-full bg-st-unknown" />上架提交（次）</span>}</div>
        {trend.length ? <SalesTrendChart points={trend} active={active} includeListings={!ledgerPartial} /> : <EmptySalesTrendChart active={active} />}
      </Panel>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel title="商品生命周期分布" icon={Package} subtitle={products.coverage.read < products.coverage.total ? `已同步 ${products.coverage.read}/${products.coverage.total} 家店铺` : undefined} className="min-h-46">
          <div className="flex flex-1 flex-wrap items-center justify-between gap-3">
            <ul className="grid min-w-32 flex-1 gap-2">{lifecycleRows.map((row, index) => <li key={row.key} className="flex items-center gap-2 text-xs"><span className={cn("size-2 rounded-full", ["bg-st-flight", "bg-st-unknown", "bg-st-bad", "bg-st-idle"][index])} /><span className="flex-1 text-muted-foreground">{row.label}</span><span className="tabular-nums">{row.value == null ? "—" : formatInteger(row.value)}</span></li>)}</ul>
            {lifecycle?.status === "ready" ? <div className="relative"><LifecycleDonutChart slices={lifecycle.slices} total={lifecycle.total} active={active} className="size-32" /><div aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-center text-xs text-muted-foreground"><div><strong className="block text-lg text-foreground">{formatInteger(lifecycle.total)}</strong>全部商品</div></div></div> : <div role="status" className="grid size-32 place-items-center rounded-full border-8 border-muted text-center text-xs text-muted-foreground"><span className="px-1">{lifecycle?.status === "empty" ? "暂无商品" : "尚未同步"}</span></div>}
          </div>
        </Panel>
        <Panel title="需要关注" icon={Bell}>
          <ul className="divide-y divide-border/60">{attention.map((item) => <li key={item.label}>
            {item.target ? <button type="button" onClick={() => onNavigate(item.target)} className="flex min-h-10 w-full items-center gap-3 text-left text-sm hover:text-brand"><span className={cn("grid size-8 place-items-center rounded-md", item.tone)}><item.icon aria-hidden className="size-4" /></span><span className="flex-1">{item.label}</span><span className="tabular-nums text-muted-foreground">{item.value == null ? "未同步" : formatInteger(item.value)}</span><ChevronRight aria-hidden className="size-4 text-muted-foreground" /></button> : <div className="flex min-h-10 items-center gap-3 text-sm"><span className={cn("grid size-8 place-items-center rounded-md", item.tone)}><item.icon aria-hidden className="size-4" /></span><span className="flex-1">{item.label}</span><span className="tabular-nums text-muted-foreground">{item.value == null ? "未同步" : formatInteger(item.value)}</span></div>}
          </li>)}</ul>
          {snapshot.ledger.some((entry) => entry.status === "result_unknown") ? <Button variant="outline" size="sm" className="mt-3 self-start" disabled={refreshing || reconciling} onClick={() => void reconcile()}>{reconciling ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}核实未知结果</Button> : null}
        </Panel>
      </div>
    </div>

    <Panel title="店铺出单排行" icon={ChartNoAxesCombined} action={<Button variant="ghost" size="sm" onClick={() => onNavigate("stores")}>查看全部<ChevronRight data-icon="inline-end" /></Button>}>
      <div className="overflow-x-auto"><table className="w-full min-w-[48rem] text-left text-sm"><thead className="bg-muted/60 text-xs text-muted-foreground"><tr>
        <th scope="col" className="px-3 py-2 font-medium">#</th><th scope="col" className="px-3 py-2 font-medium">店铺</th><th scope="col" className="px-3 py-2 text-right font-medium">30 日出单（件）</th><th scope="col" className="px-3 py-2 text-right font-medium">较上次更新</th><th scope="col" className="px-3 py-2 text-right font-medium">在售商品（件）</th><th scope="col" className="px-3 py-2 text-right font-medium">7 日上架提交（次）</th><th scope="col" className="px-3 py-2 text-right font-medium">待介入操作</th><th scope="col" className="px-3 py-2 text-right font-medium">操作</th>
      </tr></thead><tbody>{ranking.length ? ranking.slice(0, 5).map((row, index) => {
        const product = products.perStore.find((item) => item.storeId === row.storeId)
        const onSale = product && (product.status === "fresh" || product.status === "stale") ? product.onSale : null
        return <tr key={row.storeId} className="border-b border-border/40 last:border-0"><td className="px-3 py-2.5">{index + 1}</td><td className="px-3 py-2.5">{row.name}</td><td className="px-3 py-2.5 text-right tabular-nums">{formatInteger(row.units)}</td><td className={cn("px-3 py-2.5 text-right tabular-nums", row.deltaPct == null ? "text-muted-foreground" : row.deltaPct > 0 ? "text-st-good" : row.deltaPct < 0 ? "text-st-bad" : "text-muted-foreground")}>{formatSignedPercent(row.deltaPct)}</td><td className="px-3 py-2.5 text-right tabular-nums">{onSale == null ? "—" : formatInteger(onSale)}</td><td className="px-3 py-2.5 text-right text-muted-foreground" title="接口未提供按店铺统计"><span aria-label="按店铺统计未提供">—</span></td><td className="px-3 py-2.5 text-right text-muted-foreground" title="接口未提供按店铺统计"><span aria-label="按店铺统计未提供">—</span></td><td className="px-3 py-2.5 text-right"><Button variant="link" size="sm" aria-label="查看店铺列表" onClick={() => onNavigate("stores")}>查看</Button></td></tr>
      }) : <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">暂无可读店铺</td></tr>}</tbody></table></div>
    </Panel>
  </div>
})

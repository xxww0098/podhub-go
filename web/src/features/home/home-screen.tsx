import { useEffect, useId, useMemo, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ArrowRight, ArrowUpRight, ChartNoAxesCombined, CircleAlert, FileText, Grid2X2, Layers3, MessageCircle, Pin, Plus, RefreshCw, Tag, Truck, Upload, Warehouse, type LucideIcon } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type { AccountOverview, ConsoleSnapshot } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MiniBars } from "@/features/console/console-kpi"
import { summarizeStoreProducts } from "@/features/console/console-products"
import type { AppScreen } from "@/lib/app-screens"
import { cn } from "@/lib/utils"
import { findHomeModules, homeListingCount, homeListingEmptyMessage, homeListingHeadline, homeListingSummary } from "./home-model"
import { RecentPlans } from "./recent-plans"
import { RecentSubmissions } from "./recent-submissions"

const MODULE_ICONS: Partial<Record<AppScreen, LucideIcon>> = {
  listing: Upload, catalog: Layers3, "ops-shipping": Truck, console: ChartNoAxesCombined,
  stores: StoreIcon, "message-center": MessageCircle,
  "delegate-orders": FileText, "ops-supply": Warehouse,
}

type OverviewRead = { workspaceId: number; phase: "loading" | "ready" | "error"; snapshot?: ConsoleSnapshot }

export function HomeScreen({ overview, onNavigate, onOpenListingCard }: {
  overview: AccountOverview
  onNavigate: (screen: AppScreen) => void
  onOpenListingCard: (cardId: string) => void
}) {
  const workspaceId = overview.active_workspace?.id
  const active = useScreenActive()
  const [read, setRead] = useState<OverviewRead>()
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState("")
  const [storeId, setStoreId] = useState("")
  const [selection, setSelection] = useState(0)
  const resultsId = useId()
  const reduceMotion = useReducedMotion()
  const matches = findHomeModules(query)
  const results = matches.slice(0, 5)
  const searching = query.trim().length > 0
  const current = read?.workspaceId === workspaceId ? read : undefined
  const snapshot = current?.phase === "ready" ? current.snapshot : undefined
  const ledger = useMemo(() => snapshot ? homeListingSummary(snapshot.ledger, Date.now()) : null, [snapshot])
  const products = useMemo(() => snapshot ? summarizeStoreProducts(snapshot.products, snapshot.roster.stores, Date.now()) : null, [snapshot])
  const selectedStore = snapshot?.roster.stores.find((store) => (store.cloud_store_uuid || store.id) === storeId)
  const selectedStoreId = selectedStore ? storeId : ""

  useEffect(() => {
    if (!active || !workspaceId) return
    let cancelled = false
    setRead({ workspaceId, phase: "loading" })
    void opsHttp.consoleGetSnapshot().then((value) => {
      if (!cancelled) setRead({ workspaceId, phase: "ready", snapshot: value })
    }).catch(() => {
      if (!cancelled) setRead({ workspaceId, phase: "error" })
    })
    return () => { cancelled = true }
  }, [active, workspaceId, retry])

  function openResult() {
    const result = results[selection] ?? results[0]
    if (result) onNavigate(result.id)
  }

  const attention = ledger ? [
    { label: "结果未知", count: ledger.unknown },
    { label: "失败或冲突", count: ledger.failed },
  ].filter((item) => item.count > 0) : []

  return <motion.div data-home-screen className="flex min-w-0 w-full flex-1 flex-col gap-3" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
    <section className="flex min-w-0 flex-wrap items-center justify-between gap-3" aria-label="工作台快捷入口">
      <h1 className="sr-only">工作台</h1>
      <form className="relative flex min-w-0 max-w-md flex-1 basis-64 items-center gap-1 rounded-lg border border-border bg-card px-1.5 focus-within:ring-2 focus-within:ring-ring" onSubmit={(event) => { event.preventDefault(); openResult() }}>
        <label htmlFor={`${resultsId}-input`} className="sr-only">搜索工作台功能</label>
        <IconButton icon={Plus} label="从平台商品库添加商品" variant="ghost" size="icon-xs" className="size-8" onClick={() => onNavigate("catalog")} />
        <input id={`${resultsId}-input`} role="combobox" aria-autocomplete="list" aria-expanded={searching} aria-controls={searching ? resultsId : undefined} aria-activedescendant={searching && results[selection] ? `${resultsId}-${selection}` : undefined} autoComplete="off" value={query}
          onChange={(event) => { setQuery(event.target.value); setSelection(0) }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) { event.preventDefault(); return }
            if (event.key === "Escape") { setQuery(""); setSelection(0) }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              setSelection((value) => Math.max(0, Math.min(results.length - 1, value + (event.key === "ArrowDown" ? 1 : -1))))
            }
          }} placeholder="搜索功能，例如上架、订单、店铺" className="h-10 min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground max-md:h-11" />
        <IconButton type="submit" icon={ArrowRight} label="打开所选功能" variant="default" size="icon-xs" className="size-8" disabled={!matches.length} />
        {searching ? <div id={resultsId} role="listbox" aria-label="功能搜索结果" className="absolute inset-x-0 top-full z-20 mt-2 rounded-xl border border-border bg-popover p-1 shadow-overlay">
          {results.length ? results.map((module, index) => {
            const Icon = MODULE_ICONS[module.id] ?? Grid2X2
            return <button type="button" id={`${resultsId}-${index}`} key={module.id} role="option" aria-selected={index === selection} onMouseEnter={() => setSelection(index)} onClick={() => onNavigate(module.id)} className={cn("flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring", index === selection && "bg-accent")}><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="flex-1">{module.label}</span><ArrowUpRight className="size-3 text-muted-foreground" aria-hidden /></button>
          }) : <p role="status" className="px-3 py-4 text-xs text-muted-foreground">没有找到相关功能，试试“上架”“订单”或“店铺”。</p>}
        </div> : null}
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={selectedStoreId || "all"} onValueChange={(value) => setStoreId(value === "all" ? "" : value ?? "")} disabled={!snapshot?.roster.stores.length}>
          <SelectTrigger aria-label="筛选最近上架提交店铺" title="筛选下方最近上架提交" className="min-w-40"><StoreIcon className="size-4" aria-hidden /><span className="text-muted-foreground">任务</span><SelectValue>{selectedStore?.label ?? "全部店铺"}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">全部店铺</SelectItem>{snapshot?.roster.stores.map((store) => <SelectItem key={store.id} value={store.cloud_store_uuid || store.id}>{store.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" onClick={() => onNavigate("console")}><ChartNoAxesCombined aria-hidden />数据大屏</Button><Button onClick={() => onNavigate("listing")}><Plus aria-hidden />批量上架</Button>
      </div>
    </section>

    <section className="grid gap-5 rounded-xl bg-[linear-gradient(110deg,#243957,#375ff2)] p-5 text-white md:grid-cols-[minmax(0,1fr)_minmax(16rem,0.92fr)] md:items-center md:px-6 md:py-7" aria-label="上架概况">
      <div className="flex min-w-0 items-start gap-4">
        <span className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-white/15"><Tag className="size-7" aria-hidden /></span>
        <div className="min-w-0 space-y-3">
          <p className="inline-flex items-center gap-1 rounded-full bg-white/10 px-2 py-1 text-xs font-medium text-white/80"><Pin className="size-3" aria-hidden />上架任务</p>
          <h2 className="text-xl font-semibold md:text-2xl">{!workspaceId ? "选择工作空间后查看上架概况" : current?.phase === "error" ? "上架概况读取失败" : !ledger ? "正在读取上架概况" : homeListingHeadline(ledger)}</h2>
          <p className="text-sm text-white/85">{ledger ? "请核对未知、失败或冲突的结果；平台受理不代表商品已在售。" : "查看提交进度，并在结果未知时继续核对。"}</p>
          {current?.phase === "error" ? <Button variant="secondary" onClick={() => setRetry((value) => value + 1)}><RefreshCw aria-hidden />重试</Button> : <Button variant="secondary" onClick={() => onNavigate("listing")}>查看上架方案<ArrowRight aria-hidden /></Button>}
        </div>
      </div>
      <div className="space-y-2 border-white/20 md:border-l md:pl-6">
        <p className="flex items-center gap-2 text-xs font-medium text-white/80"><Pin className="size-3.5" aria-hidden />建议处理的任务</p>
        {attention.length ? attention.map((item) => <button key={item.label} type="button" className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg bg-white/10 px-3 text-left text-sm hover:bg-white/20 focus-visible:outline-2 focus-visible:outline-white md:min-h-10" onClick={() => onNavigate("listing")}><span>{item.label}</span><span className="flex items-center gap-2 tabular-nums">{homeListingCount(item.count, ledger?.mayBeTruncated ?? false)}<ArrowRight className="size-4" aria-hidden /></span></button>) : <p className="rounded-lg bg-white/10 px-3 py-3 text-sm text-white/85">{ledger ? homeListingEmptyMessage(ledger.mayBeTruncated) : "结果将在读取后显示"}</p>}
      </div>
    </section>

    <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="上架统计">
      {[
        { label: "近 7 日上架提交", value: ledger ? homeListingCount(ledger.createdIn7Days, ledger.mayBeTruncated) : undefined, note: "近期操作记录", color: "bg-st-good", trend: ledger?.series.slice(-7).map((point) => point.intake), trendLabel: "近 7 日提交" },
        { label: "近期上架进行中", value: ledger ? homeListingCount(ledger.inFlight, ledger.mayBeTruncated) : undefined, note: "排队或发送中", color: "bg-st-flight" },
        { label: "上架待核对", value: ledger ? homeListingCount(ledger.needsAction, ledger.mayBeTruncated) : undefined, note: "未知、失败或冲突", color: "bg-st-bad", trend: ledger?.series.slice(-7).map((point) => point.exceptions), trendLabel: "近 7 日异常更新" },
        { label: "商品镜像覆盖", value: products ? `${products.coverage.read} / ${products.coverage.total}` : undefined, note: "已读取 / 可见店铺", color: "bg-st-good" },
      ].map((item) => <div key={item.label} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-22 flex-1 items-end justify-between gap-2 px-4 py-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{item.label}</p><p className="mt-2 text-3xl font-semibold leading-none tabular-nums">{item.value ?? "—"}</p></div>{item.trend?.some((value) => value > 0) ? <span title={item.trendLabel} className="text-primary"><MiniBars values={item.trend} /></span> : null}</div>
        <p className="flex min-h-8 items-center gap-2 border-t border-border px-4 text-xs text-muted-foreground"><span className={cn("size-2 shrink-0 rounded-full", item.color)} aria-hidden />{item.note}</p>
      </div>)}
    </section>
    {ledger ? <p className="-mt-2 text-xs text-muted-foreground">{ledger.mayBeTruncated ? "账本达到读取上限，统计可能不完整；上架数量为已读记录的下界。" : "统计基于已读取的操作记录。"}</p> : null}

    <div className="grid min-w-0 items-start gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(18rem,0.44fr)]">
      <div className="min-w-0 space-y-3">
        <RecentSubmissions workspaceId={workspaceId} stores={snapshot?.roster.stores} storeId={selectedStoreId} onOpen={onOpenListingCard} />
        <RecentPlans workspaceId={workspaceId} stores={snapshot?.roster.stores} onOpen={onOpenListingCard} onOpenLibrary={() => onNavigate("listing")} />
      </div>
      <div className="space-y-3">
        <section className="rounded-xl border border-border bg-card" aria-labelledby="home-attention">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3"><h2 id="home-attention" className="flex items-center gap-2 text-base font-semibold"><CircleAlert className="size-4" aria-hidden />需要关注{ledger?.needsAction ? <span className="rounded-md bg-destructive px-1.5 py-0.5 text-xs text-white tabular-nums">{homeListingCount(ledger.needsAction, ledger.mayBeTruncated)}</span> : null}</h2><Button variant="ghost" size="sm" onClick={() => onNavigate("listing")}>查看全部<ArrowRight aria-hidden /></Button></div>
          <div className="divide-y divide-border px-3">{attention.length ? attention.map((item) => <button key={item.label} type="button" onClick={() => onNavigate("listing")} className="flex min-h-11 w-full items-center justify-between gap-3 text-left text-sm hover:text-primary focus-visible:outline-2 focus-visible:outline-ring"><span className="flex items-center gap-2"><CircleAlert className="size-4 text-destructive" aria-hidden />{item.label}</span><span className="flex items-center gap-2 font-medium tabular-nums">{homeListingCount(item.count, ledger?.mayBeTruncated ?? false)}<ArrowRight className="size-4" aria-hidden /></span></button>) : <p className="py-3 text-sm text-muted-foreground">{ledger ? homeListingEmptyMessage(ledger.mayBeTruncated) : current?.phase === "error" ? "读取失败，请重试。" : "暂无可显示的数据。"}</p>}</div>
        </section>
        <section className="rounded-xl border border-border bg-card" aria-labelledby="home-stores">
          <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3"><h2 id="home-stores" className="flex items-center gap-2 text-base font-semibold"><StoreIcon className="size-4" aria-hidden />店铺商品概况</h2></div>
          <div className="divide-y divide-border px-3">{products?.perStore.length ? products.perStore.slice(0, 5).map((store) => <div key={store.storeId} className="flex min-w-0 items-center justify-between gap-3 py-2.5 text-sm"><span className="truncate">{store.name}</span><span className="shrink-0 text-muted-foreground">{store.status === "never" ? "未同步" : store.status === "expired" ? "数据已过期" : store.onSale == null ? "在售未知" : `${store.onSale} 件在售${store.status === "stale" ? " · 待更新" : ""}`}</span></div>) : <p className="py-3 text-sm text-muted-foreground">{snapshot ? "暂无店铺商品数据。" : "暂无可显示的数据。"}</p>}</div>
        </section>
      </div>
    </div>
  </motion.div>
}

import { useCallback, useEffect, useId, useMemo, useState } from "react"
import { motion, useReducedMotion } from "motion/react"
import { ArrowRight, ArrowUpRight, ChartNoAxesCombined, FileText, Grid2X2, Layers3, MessageCircle, PackagePlus, Plus, Truck, Upload, Warehouse, type LucideIcon } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type { AccountOverview, ConsoleSnapshot } from "@/bindings/commands"
import type { IntentReviewCounts } from "@/bindings/http-listing-intents"
import { opsHttp } from "@/bindings/http-ops"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { MiniBars } from "@/features/console/console-kpi"
import { summarizeStoreProducts } from "@/features/console/console-products"
import type { AppScreen } from "@/lib/app-screens"
import { cn } from "@/lib/utils"
import { findHomeModules, homeListingCount, homeListingSummary, homeSearchTarget } from "./home-model"
import { HomeStatusBar } from "./home-status-bar"
import { RecentPlans } from "./recent-plans"
import { RecentSubmissions, type ReviewFocus } from "./recent-submissions"
import type { ReviewKind, ReviewRead } from "./recent-submissions-read"

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
  const [review, setReview] = useState<{ workspaceId?: number; phase: ReviewRead["phase"]; counts?: IntentReviewCounts }>()
  const [retry, setRetry] = useState(0)
  const [reviewRetry, setReviewRetry] = useState(0)
  const [queueFocus, setQueueFocus] = useState<ReviewFocus>()
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
    const target = homeSearchTarget(query, selection)
    if (target) onNavigate(target)
  }

  const openQueue = useCallback((kind: ReviewKind | "all") => {
    setQueueFocus((previous) => ({ kind, token: (previous?.token ?? 0) + 1 }))
  }, [])

  const handleReview = useCallback((id: number | undefined, next: ReviewRead) => {
    setReview({ workspaceId: id, ...next })
  }, [])
  const retryReview = useCallback(() => {
    setReviewRetry((value) => value + 1)
  }, [])
  const reviewCurrent = review && review.workspaceId === workspaceId ? review : undefined
  const reviewCounts = reviewCurrent?.phase === "ready" ? reviewCurrent.counts : undefined
  const reviewFailed = reviewCurrent?.phase === "error"
  // A dot states an outcome; an informational metric or a zero count must not
  // borrow success or failure color.
  const inFlightDot = ledger?.inFlight ? "bg-st-flight" : "bg-muted-foreground/40"
  const coverageDot = products && products.coverage.total > 0 && products.coverage.read === products.coverage.total ? "bg-st-good" : "bg-muted-foreground/40"

  return <motion.div data-home-screen className="flex min-w-0 w-full flex-1 flex-col gap-3" initial={reduceMotion ? false : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22 }}>
    <section className="flex min-w-0 flex-wrap items-center justify-between gap-3" aria-label="工作台快捷入口">
      <h1 className="sr-only">工作台</h1>
      <form className="relative flex min-w-0 max-w-md flex-1 basis-64 items-center gap-1 rounded-lg border border-border bg-card px-1.5 focus-within:ring-2 focus-within:ring-ring" onSubmit={(event) => { event.preventDefault(); openResult() }}>
        <label htmlFor={`${resultsId}-input`} className="sr-only">搜索工作台功能</label>
        <input id={`${resultsId}-input`} role="combobox" aria-autocomplete="list" aria-expanded={searching} aria-controls={searching ? resultsId : undefined} aria-activedescendant={searching && results[selection] ? `${resultsId}-${selection}` : undefined} autoComplete="off" value={query}
          onChange={(event) => { setQuery(event.target.value); setSelection(0) }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && event.nativeEvent.isComposing) { event.preventDefault(); return }
            if (event.key === "Escape") { setQuery(""); setSelection(0) }
            if (!searching) return
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault()
              setSelection((value) => Math.max(0, Math.min(results.length - 1, value + (event.key === "ArrowDown" ? 1 : -1))))
            }
          }} placeholder="搜索功能，例如上架、订单、店铺" className="h-10 min-w-0 flex-1 bg-transparent px-3 text-sm outline-none placeholder:text-muted-foreground max-md:h-11" />
        <IconButton type="submit" icon={ArrowRight} label="打开所选功能" variant="default" size="icon-xs" className="size-8" disabled={!searching || !matches.length} />
        {searching ? <div id={resultsId} role="listbox" aria-label="功能搜索结果" className="absolute inset-x-0 top-full z-20 mt-2 rounded-xl border border-border bg-popover p-1 shadow-overlay">
          {results.length ? results.map((module, index) => {
            const Icon = MODULE_ICONS[module.id] ?? Grid2X2
            return <button type="button" id={`${resultsId}-${index}`} key={module.id} role="option" aria-selected={index === selection} onMouseEnter={() => setSelection(index)} onClick={() => onNavigate(module.id)} className={cn("flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-lg px-3 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring", index === selection && "bg-accent")}><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="flex-1">{module.label}</span><ArrowUpRight className="size-3 text-muted-foreground" aria-hidden /></button>
          }) : <p role="status" className="px-3 py-4 text-xs text-muted-foreground">没有找到相关功能，试试“上架”“订单”或“店铺”。</p>}
        </div> : null}
      </form>
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => onNavigate("listing")}><Plus aria-hidden />批量上架</Button>
        <Button variant="outline" onClick={() => onNavigate("catalog")}><PackagePlus aria-hidden />从商品库添加</Button>
        <Select value={selectedStoreId || "all"} onValueChange={(value) => setStoreId(value === "all" ? "" : value ?? "")} disabled={!snapshot?.roster.stores.length}>
          <SelectTrigger aria-label="筛选最近上架提交店铺" title="筛选下方最近上架提交" className="min-w-40"><StoreIcon className="size-4" aria-hidden /><span className="text-muted-foreground">提交店铺</span><SelectValue>{selectedStore?.label ?? "全部店铺"}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">全部店铺</SelectItem>{snapshot?.roster.stores.map((store) => <SelectItem key={store.id} value={store.cloud_store_uuid || store.id}>{store.label}</SelectItem>)}</SelectContent>
        </Select>
        <Button variant="outline" onClick={() => onNavigate("console")}><ChartNoAxesCombined aria-hidden />经营数据</Button>
      </div>
    </section>

    <HomeStatusBar workspaceSelected={Boolean(workspaceId)} counts={reviewCounts} overviewFailed={current?.phase === "error"} reviewFailed={reviewFailed} onOpenQueue={openQueue}
      onRetry={() => { if (current?.phase === "error") setRetry((value) => value + 1); if (reviewFailed) retryReview() }} />

    <section className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="上架统计">
      {[
        { label: "近 7 日上架提交", value: ledger ? homeListingCount(ledger.createdIn7Days, ledger.mayBeTruncated) : undefined, note: "近期操作记录", color: "bg-muted-foreground/40", trend: ledger?.series.slice(-7).map((point) => point.intake), trendLabel: "近 7 日提交" },
        { label: "近期上架进行中", value: ledger ? homeListingCount(ledger.inFlight, ledger.mayBeTruncated) : undefined, note: "排队或发送中", color: inFlightDot },
        { label: "店铺商品同步", value: products ? `${products.coverage.read} / ${products.coverage.total}` : undefined, note: "已同步 / 可见店铺", color: coverageDot },
      ].map((item) => <div key={item.label} className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex min-h-22 flex-1 items-end justify-between gap-2 px-4 py-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{item.label}</p><p className="mt-2 text-3xl font-semibold leading-none tabular-nums">{item.value ?? "—"}</p></div>{item.trend?.some((value) => value > 0) ? <span title={item.trendLabel} className="text-primary"><MiniBars values={item.trend} /></span> : null}</div>
        <p className="flex min-h-8 items-center gap-2 border-t border-border px-4 text-xs text-muted-foreground"><span className={cn("size-2 shrink-0 rounded-full", item.color)} aria-hidden />{item.note}</p>
      </div>)}
    </section>
    <p className="-mt-2 text-xs text-muted-foreground">平台受理不代表商品已在售；{ledger?.mayBeTruncated ? "趋势与进行中统计达到读取上限，可能不完整。" : "统计基于已读取的操作记录。"}</p>

    <div className="min-w-0 space-y-3">
      <RecentSubmissions workspaceId={workspaceId} stores={snapshot?.roster.stores} storeId={selectedStoreId} onOpen={onOpenListingCard} onReview={handleReview} reviewCounts={reviewCounts} reviewFocus={queueFocus} reviewRetry={reviewRetry} />
      <RecentPlans workspaceId={workspaceId} stores={snapshot?.roster.stores} onOpen={onOpenListingCard} onOpenLibrary={() => onNavigate("listing")} />
      <section className="rounded-xl border border-border bg-card" aria-labelledby="home-stores">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3"><h2 id="home-stores" className="flex items-center gap-2 text-base font-semibold"><StoreIcon className="size-4" aria-hidden />店铺商品概况</h2></div>
        <div className="grid gap-x-8 gap-y-2 px-4 py-3 sm:grid-cols-2 xl:grid-cols-3">{products?.perStore.length ? products.perStore.slice(0, 5).map((store) => <div key={store.storeId} className="flex min-w-0 items-center justify-between gap-3 text-sm"><span className="truncate">{store.name}</span><span className="shrink-0 text-muted-foreground">{store.status === "never" ? "未同步" : store.status === "expired" ? "数据已过期" : store.onSale == null ? "在售未知" : `${store.onSale} 件在售${store.status === "stale" ? " · 待更新" : ""}`}</span></div>) : <p className="py-2 text-sm text-muted-foreground">{current?.phase === "loading" ? "正在读取店铺商品数据" : current?.phase === "error" ? "店铺商品数据读取失败。" : "暂无店铺商品数据。"}</p>}</div>
      </section>
    </div>
  </motion.div>
}

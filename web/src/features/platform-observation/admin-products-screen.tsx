import { useEffect, useState } from "react"
import { RotateCcw, Search } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { CoverageNote, StatusTabs, type ProductCounts } from "@/features/products/products-status"
import type { ProductFreshness } from "@/features/products/freshness"
import type { StoreProductsOverviewData, StoreProductStatusFilter } from "@/features/products/products-api"
import { observationApi } from "./observation-api"
import { ObservationProductsTable } from "./observation-products-table"
import { ObservationScopeBar } from "./observation-scope-bar"
import { useObservationScope } from "./observation-scope-provider"
import { useObservationRead } from "./use-observation-read"

/** Adapt the API totals to the status tabs without treating unread stores as zero. */
export function observationStatusReading(overview: StoreProductsOverviewData | undefined, storeId?: string): {
  counts: ProductCounts
  freshness: ProductFreshness | "totals"
} {
  const totals = overview?.totals
  const store = overview?.stores.find((item) => item.store_id === storeId)
  const unread = overview && overview.coverage.total > 0 && overview.coverage.read === 0
  return {
    counts: {
      total: totals?.total,
      onSale: totals?.on_sale,
      processing: totals?.processing,
      hidden: totals?.hidden,
      moderationFailed: totals?.moderation_failed,
      zeroStock: totals?.zero_stock,
      archived: totals?.archived,
      delisted: totals?.delisted,
    },
    freshness: unread ? (store?.freshness === "expired" ? "expired" : "never") : store?.freshness ?? "totals",
  }
}

/** No ProductRow editors, ProductDetailSheet, verify, sync or promotion readers. */
export function AdminProductsScreen() {
  const { scope, scopeKey } = useObservationScope()
  const [status, setStatus] = useState<StoreProductStatusFilter>()
  const [input, setInput] = useState("")
  const [search, setSearch] = useState("")
  const [includeGone, setIncludeGone] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setSearch(input.trim()), 300)
    return () => clearTimeout(timer)
  }, [input])
  const overview = useObservationRead(scopeKey, () => observationApi.overview(scope), "无法读取平台商品统计。")
  const query = { ...scope, status, q: search, includeGone: includeGone || status === "delisted" }
  const filterKey = JSON.stringify([scopeKey, status, search, query.includeGone])
  const [savedPage, setSavedPage] = useState<{ key: string; size: number; index: number; cursors: (string | undefined)[] }>({ key: "", size: 10, index: 0, cursors: [undefined] })
  const page = savedPage.key === filterKey ? savedPage : { key: filterKey, size: 10, index: 0, cursors: [undefined] }
  const cursor = page.cursors[page.index]
  const listKey = JSON.stringify([filterKey, page.size, cursor])
  const list = useObservationRead(listKey, () => observationApi.products({ ...query, cursor, limit: page.size }), "无法读取平台商品快照。")
  const statusReading = observationStatusReading(overview.data, scope.storeId)
  const reload = () => { void overview.load(); void list.load() }
  const next = () => {
    const nextCursor = list.data?.next_cursor
    if (!nextCursor || list.loading) return
    setSavedPage({ ...page, index: page.index + 1, cursors: [...page.cursors.slice(0, page.index + 1), nextCursor] })
  }
  return <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-3 overflow-hidden" aria-label="全部 Ozon 商品">
    <ObservationScopeBar title="全部 Ozon 商品" loading={overview.loading || list.loading} onReload={reload} showLabels>
      <div className="w-full min-w-0 sm:w-72">
        <InputGroup>
          <InputGroupAddon align="inline-start"><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput aria-label="搜索商品名称、货号或 SKU" placeholder="搜索商品名、货号或 SKU…" value={input} onChange={(event) => setInput(event.target.value)} />
        </InputGroup>
      </div>
      <label className="flex items-center gap-2 text-compact"><Checkbox checked={includeGone} onCheckedChange={(checked) => setIncludeGone(checked === true)} />包含已下架</label>
    </ObservationScopeBar>
    <div className="flex min-w-0 shrink-0 flex-col gap-1 md:flex-row md:items-center md:gap-3">
      <StatusTabs counts={statusReading.counts} freshness={statusReading.freshness} status={status} onStatus={setStatus} />
      {overview.data ? <CoverageNote overview={overview.data} className="md:shrink-0" /> : overview.failed ? <IconButton icon={RotateCcw} label="重试统计" variant="outline" size="icon-sm" onClick={() => { void overview.load() }} /> : <p className="text-meta text-muted-foreground">正在读取商品同步覆盖…</p>}
    </div>
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-card">
      <ObservationProductsTable key={listKey} items={list.data?.items ?? []} stores={overview.data?.stores ?? []} loading={list.loading} failed={list.failed} hasMore={Boolean(list.data?.next_cursor)} onLoadMore={next} onRetry={() => { void list.load() }} page={page.index + 1} pageSize={page.size} onPrevious={() => setSavedPage({ ...page, index: page.index - 1 })} onPageSize={(size) => setSavedPage({ key: filterKey, size, index: 0, cursors: [undefined] })} />
    </div>
  </div>
}

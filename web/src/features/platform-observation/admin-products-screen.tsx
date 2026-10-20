import { useEffect, useState } from "react"
import { Search } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { CoverageNote, StatusTabs } from "@/features/products/products-status"
import type { StoreProductStatusFilter } from "@/features/products/products-api"
import { observationApi } from "./observation-api"
import { mergeObservationProducts } from "./observation-scope"
import { ObservationProductsTable } from "./observation-products-table"
import { ObservationScopeBar } from "./observation-scope-bar"
import { useObservationScope } from "./observation-scope-provider"
import { useObservationRead } from "./use-observation-read"

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
  const listKey = JSON.stringify([scopeKey, status, search, query.includeGone])
  const list = useObservationRead(listKey, () => observationApi.products(query), "无法读取平台商品快照。")
  const singleStore = overview.data?.stores.find((store) => store.store_id === scope.storeId)
  const reload = () => { void overview.load(); void list.load() }
  const loadMore = () => {
    const cursor = list.data?.next_cursor
    if (!cursor || list.loading) return
    void list.load(() => observationApi.products({ ...query, cursor }), (previous, incoming) => ({
      ...incoming, items: mergeObservationProducts(previous?.items ?? [], incoming.items),
    }))
  }
  return <div className="flex min-h-0 w-full flex-1 flex-col gap-4" aria-label="平台店铺商品">
    <ObservationScopeBar title="平台店铺商品" loading={overview.loading || list.loading} onReload={reload} />
    <div className="flex flex-wrap items-center gap-3">
      <div className="w-full sm:w-72">
        <InputGroup>
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput aria-label="搜索商品名称、货号或 SKU" placeholder="商品名称、货号或 SKU" value={input} onChange={(event) => setInput(event.target.value)} />
        </InputGroup>
      </div>
      <label className="flex items-center gap-2 text-compact"><Checkbox checked={includeGone} onCheckedChange={(checked) => setIncludeGone(checked === true)} />包含已下架</label>
      <p className="ml-auto text-meta text-muted-foreground">服务端筛选与分页 · 每页最多 200 件 · 促销不属于商品镜像</p>
    </div>
    <div className="overflow-x-auto">
      <StatusTabs counts={overview.data?.totals ?? {}} freshness={singleStore?.freshness ?? "totals"} status={status} onStatus={setStatus} />
    </div>
    {overview.data ? <CoverageNote overview={overview.data} /> : overview.failed ? <div><Button variant="outline" size="sm" onClick={() => { void overview.load() }}>重试统计</Button></div> : <p className="text-meta text-muted-foreground">正在读取商品同步覆盖…</p>}
    <ObservationProductsTable key={listKey} items={list.data?.items ?? []} stores={overview.data?.stores ?? []} loading={list.loading} failed={list.failed} hasMore={Boolean(list.data?.next_cursor)} onLoadMore={loadMore} onRetry={() => { void list.load() }} />
  </div>
}

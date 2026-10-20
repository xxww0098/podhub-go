import { Fragment, useState } from "react"
import { PackageSearch } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableExpandedRow, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ProductReadRow } from "@/features/products/product-read-row"
import { ProductExpand } from "@/features/products/product-expand"
import { freshnessLabel } from "@/features/products/freshness"
import { analyticsRevenue } from "@/features/products/analytics-money"
import type { StoreProductOverviewRow } from "@/features/products/products-api"
import { observationProductKey } from "./observation-scope"
import { utcSnapshotStamp } from "./observation-console-model"
import type { ObservationProduct } from "./observation-types"

/** Never use Workspace-authorized thumbnails or direct external images here.
 * The backend projection supplies its independently guarded admin GET URL.
 */
export function observationThumbnail(src: string | null | undefined): string | null {
  if (!src) return null
  return /^\/api\/admin\/stores\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/products\/[1-9][0-9]*\/thumbnail(?:\?v=[0-9a-f]{16})?$/i.test(src) ? src : null
}

export function ObservationProductsTable({ items, stores, loading, failed, hasMore, onLoadMore, onRetry, initialExpandedKey = null }: {
  items: ObservationProduct[]
  stores: StoreProductOverviewRow[]
  loading: boolean
  failed: boolean
  hasMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  /** Also permits snapshot render tests to exercise the real expanded subtree. */
  initialExpandedKey?: string | null
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(initialExpandedKey)
  const byStore = new Map(stores.map((store) => [store.store_id, store]))
  const columns = 14
  return <Table className="min-w-6xl table-fixed" containerClassName="min-h-0 flex-1 overflow-auto" aria-label="只读店铺商品镜像">
    <TableHeader className="sticky top-0 z-10 bg-card">
      <TableRow>
        <TableHead className="w-12"><span className="sr-only">展开</span></TableHead>
        <TableHead className="w-16">照片</TableHead>
        <TableHead className="w-36">货号 / SKU</TableHead>
        <TableHead className="w-56">商品名称</TableHead>
        <TableHead className="w-28">同款</TableHead>
        <TableHead className="w-28">状态</TableHead>
        <TableHead className="w-48">工作空间 / 所有者</TableHead>
        <TableHead className="w-40">店铺</TableHead>
        <TableHead className="w-32 text-right">价格</TableHead>
        <TableHead className="w-24 text-right">库存</TableHead>
        <TableHead className="w-24 text-right">浏览</TableHead>
        <TableHead className="w-20 text-right">加购</TableHead>
        <TableHead className="w-28 text-right">销售额</TableHead>
        <TableHead className="w-44">新鲜度 / 更新</TableHead>
      </TableRow>
    </TableHeader>
    <TableBody>
      {items.map((item) => {
        const row = item.product
        const key = observationProductKey(item)
        const store = byStore.get(row.store_id)
        const currency = store?.currency ?? null
        const expanded = key === expandedKey
        const revenue = row.metrics ? analyticsRevenue(row.metrics, currency) : null
        return <Fragment key={key}>
          <ProductReadRow row={row} currency={currency} imageUrl={observationThumbnail(row.image_url)} expanded={expanded} onToggle={() => setExpandedKey(expanded ? null : key)} attributionCells={<>
            <TableCell><div className="flex min-w-0 flex-col gap-1"><span className="truncate" title={item.workspace_name}>{item.workspace_name}</span><span className="truncate text-meta text-muted-foreground" title={item.owner_name}>{item.owner_name} · {item.workspace_id.slice(0, 8)}</span></div></TableCell>
            <TableCell><div className="flex min-w-0 flex-col gap-1"><span className="truncate" title={row.store_name}>{row.store_name}</span><span className="truncate font-mono text-meta text-muted-foreground" title={row.store_id}>{row.store_id.slice(0, 8)}</span></div></TableCell>
          </>} endCells={<TableCell><div className="flex flex-col gap-1 text-meta"><span>{store ? freshnessLabel(store.freshness) : "新鲜度未知"}</span><span className="text-muted-foreground">{utcSnapshotStamp(store?.last_full_sync_at_ms)}</span></div></TableCell>} />
          {expanded ? <TableExpandedRow colSpan={columns}>
            <p className="text-meta text-muted-foreground">{item.workspace_name} / {row.store_name} · 只读快照 · 不核实、不读取促销</p>
            <ProductExpand row={row} currency={currency} />
            {revenue?.title ? <p className="text-meta text-muted-foreground">FX：{revenue.title}</p> : null}
          </TableExpandedRow> : null}
        </Fragment>
      })}
      {items.length === 0 ? <TableRow><TableCell colSpan={columns}>
        {loading ? <div className="flex flex-col gap-2 py-4">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-8" />)}</div> : failed ? <div className="flex justify-center py-8"><Button variant="outline" onClick={onRetry}>重试商品</Button></div> : <div className="flex flex-col items-center gap-2 py-16 text-center">
          <PackageSearch className="size-8 text-muted-foreground" aria-hidden />
          <p className="text-sm font-medium">当前范围与筛选下没有商品快照</p>
          <p className="max-w-sm text-meta text-muted-foreground">可切换范围、状态或清空搜索。未同步的店铺不是零商品；此页不触发同步。</p>
        </div>}
      </TableCell></TableRow> : null}
      {hasMore ? <TableRow><TableCell colSpan={columns} className="text-center">
        <Button variant="outline" size="sm" disabled={loading} onClick={onLoadMore}>{loading ? "正在读取…" : "加载更多"}</Button>
      </TableCell></TableRow> : null}
    </TableBody>
  </Table>
}

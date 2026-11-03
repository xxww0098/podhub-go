import { Fragment, useState } from "react"
import { ChevronLeft, ChevronRight, Copy, PackageSearch, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableExpandedRow, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ProductExpand } from "@/features/products/product-expand"
import { ozonProductUrl, ProductPriceReading, ProductStatusCell, ProductStockReading } from "@/features/products/product-read-cells"
import { ProductThumb } from "@/features/products/product-thumb"
import { ProductVariantCell } from "@/features/products/products-variant-column"
import { freshnessLabel } from "@/features/products/freshness"
import { analyticsRevenue } from "@/features/products/analytics-money"
import type { StoreProductOverviewRow } from "@/features/products/products-api"
import { cn } from "@/lib/utils"
import { copyToClipboard } from "@/lib/clipboard"
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

export function ObservationProductsTable({ items, stores, loading, failed, hasMore, onLoadMore, onRetry, page = 1, pageSize = 10, onPrevious, onPageSize, initialExpandedKey = null }: {
  items: ObservationProduct[]
  stores: StoreProductOverviewRow[]
  loading: boolean
  failed: boolean
  hasMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  page?: number
  pageSize?: number
  onPrevious?: () => void
  onPageSize?: (size: number) => void
  /** Also permits snapshot render tests to exercise the real expanded subtree. */
  initialExpandedKey?: string | null
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(initialExpandedKey)
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const byStore = new Map(stores.map((store) => [store.store_id, store]))
  const selectedItems = items.filter((item) => selected.has(observationProductKey(item)))
  const copyable = selectedItems.map((item) => item.product.offer_id.trim()).filter(Boolean)
  const allSelected = items.length > 0 && selectedItems.length === items.length
  const columns = 8
  return <div className="flex min-h-0 flex-1 flex-col">
  <Table className="min-w-4xl table-fixed" containerClassName="@container min-h-0 flex-1 overflow-auto" aria-label="只读 Ozon 商品镜像">
    <TableHeader className="sticky top-0 z-10 bg-muted">
      <TableRow>
        <TableHead className="w-10"><Checkbox aria-label="选择本页全部商品" checked={allSelected} indeterminate={selectedItems.length > 0 && !allSelected} disabled={loading || items.length === 0} onCheckedChange={(checked) => setSelected(checked ? new Set(items.map(observationProductKey)) : new Set())} /></TableHead>
        <TableHead className="w-[27%]">商品信息</TableHead>
        <TableHead className="w-[14%]">工作空间 / 所有者</TableHead>
        <TableHead className="w-[11%]">店铺</TableHead>
        <TableHead className="w-[12%]">货号</TableHead>
        <TableHead className="w-[9%]">状态</TableHead>
        <TableHead className="w-[8%] text-right">库存</TableHead>
        <TableHead>新鲜度 / 更新</TableHead>
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
        const imageUrl = observationThumbnail(row.image_url)
        const contextId = `observation-context-${item.workspace_id}-${row.store_id}-${row.product_id}`
        return <Fragment key={key}>
          <TableRow className="text-sm md:[&>td]:py-2">
            <TableCell><Checkbox aria-label={`选择 ${row.offer_id || row.name || "未命名商品"}`} aria-describedby={contextId} checked={selected.has(key)} onCheckedChange={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(key); else next.delete(key); return next })} /></TableCell>
            <TableCell>
              <div className="flex min-w-0 items-center gap-1.5">
                <IconButton icon={ChevronRight} iconClassName={expanded ? "rotate-90" : undefined} size="icon-sm" label={(expanded ? "收起 " : "展开 ") + row.offer_id + " 的详情"} tip={expanded ? "收起详情" : "展开详情"} tooltipSide="right" aria-expanded={expanded} aria-describedby={contextId} onClick={() => setExpandedKey(expanded ? null : key)} />
                <span id={contextId} className="sr-only">{item.workspace_name} / {row.store_name}</span>
                {imageUrl ? <ProductThumb src={imageUrl} name={row.name} className="size-14" /> : <span className="flex size-14 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/60 text-muted-foreground"><PackageSearch className="size-4" aria-hidden /></span>}
                <div className="flex min-w-0 flex-col gap-1">
                  <span className={cn("truncate font-medium leading-snug", row.gone && "text-muted-foreground")} title={row.name ?? undefined}>{row.name ?? "未命名商品"}</span>
                  {row.sku ? <a href={ozonProductUrl(row.sku)} target="_blank" rel="noreferrer" aria-label={"在 Ozon 打开 SKU " + row.sku} className="w-fit text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">SKU: {row.sku}</a> : <span className="text-xs text-muted-foreground">SKU: —</span>}
                </div>
              </div>
            </TableCell>
            <TableCell><div className="flex min-w-0 flex-col gap-1"><span className="truncate" title={item.workspace_name}>{item.workspace_name}</span><span className="truncate text-meta text-muted-foreground" title={item.owner_name}>{item.owner_name} · {item.workspace_id.slice(0, 8)}</span></div></TableCell>
            <TableCell><div className="flex min-w-0 flex-col gap-1"><span className="truncate" title={row.store_name}>{row.store_name}</span><span className="truncate font-mono text-meta text-muted-foreground" title={row.store_id}>{row.store_id.slice(0, 8)}</span></div></TableCell>
            <TableCell className="break-words font-mono text-xs" title={row.offer_id}>{row.offer_id}</TableCell>
            <ProductStatusCell row={row} />
            <TableCell className="whitespace-nowrap text-right font-mono tabular-nums"><ProductStockReading row={row} /></TableCell>
            <TableCell><div className="flex flex-col gap-1 text-meta"><span>{store ? freshnessLabel(store.freshness) : "新鲜度未知"}</span><span className="text-muted-foreground">{utcSnapshotStamp(store?.last_full_sync_at_ms)}</span></div></TableCell>
          </TableRow>
          {expanded ? <TableExpandedRow colSpan={columns}>
            <p className="text-meta text-muted-foreground">{item.workspace_name} / {row.store_name} · 只读快照 · 不核实、不读取促销</p>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-3 text-xs"><div>同款：<ProductVariantCell row={row} /></div><div className="flex items-center gap-2">现价 / 原价：<ProductPriceReading row={row} currency={currency} /></div></div>
            <ProductExpand row={row} currency={currency} />
            {revenue?.title ? <p className="text-meta text-muted-foreground">FX：{revenue.title}</p> : null}
          </TableExpandedRow> : null}
        </Fragment>
      })}
      {items.length === 0 ? <TableRow><TableCell colSpan={columns}>
        <div className="sticky left-0 w-[calc(100cqw-1.5rem)] max-w-full">
          {loading ? <div className="flex flex-col gap-2 py-4">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} className="h-8" />)}</div> : failed ? <div className="flex justify-center py-8"><IconButton icon={RotateCcw} label="重试商品" variant="outline" onClick={onRetry} /></div> : <div className="flex flex-col items-center gap-2 py-16 text-center">
            <PackageSearch className="size-8 text-muted-foreground" aria-hidden />
            <p className="text-sm font-medium">暂无商品快照</p>
          </div>}
        </div>
      </TableCell></TableRow> : null}
    </TableBody>
  </Table>
  <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2 text-compact text-muted-foreground">
    <span>{loading ? "正在读取…" : failed ? "读取失败" : `本页 ${items.length} 条`}</span>
    {selectedItems.length > 0 ? <Button variant="outline" size="sm" disabled={copyable.length === 0} onClick={() => void copyToClipboard(copyable.join("\n"), { success: `已复制 ${copyable.length} 个货号`, failure: "无法复制货号" })}><Copy data-icon="inline-start" />复制选中货号（{selectedItems.length}）</Button> : null}
    <div className="ml-auto flex flex-wrap items-center gap-2">
      <IconButton icon={ChevronLeft} label="上一页" variant="outline" size="icon-sm" disabled={loading || page <= 1} onClick={onPrevious} />
      <span aria-current="page" className="min-w-8 text-center tabular-nums">{page}</span>
      <IconButton icon={ChevronRight} label="下一页" variant="outline" size="icon-sm" disabled={loading || !hasMore} onClick={onLoadMore} />
      <Select value={String(pageSize)} onValueChange={(value) => { if (value) onPageSize?.(Number(value)) }} disabled={loading || !onPageSize}>
        <SelectTrigger size="sm" aria-label="每页商品数量"><SelectValue>{`${pageSize} 条/页`}</SelectValue></SelectTrigger>
        <SelectContent>{[10, 20, 50].map((size) => <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>)}</SelectContent>
      </Select>
    </div>
  </div>
  </div>
}

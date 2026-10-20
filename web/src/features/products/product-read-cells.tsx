/** Static mirror cells shared by writable rows and the platform read-only row.
 * No writes, realtime readers, promotion board or capability-bearing imports.
 */
import type { ReactNode } from "react"
import { PackageSearch } from "lucide-react"
import { TableCell } from "@/components/ui/table"
import { StateChip } from "@/components/state-chip"
import { formatCount, formatPercentPoint, formatStoreMoney } from "@/lib/format"
import type { StateTone } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import { analyticsRevenue } from "./analytics-money"
import { ProductThumb } from "./product-thumb"
import type { StoreProductRow } from "./products-api"
import { ProductVariantCell } from "./products-variant-column"

/** Ozon public pages address SKU, not a tenant offer id. */
export function ozonProductUrl(sku: number): string {
  return "https://www.ozon.ru/product/" + sku + "/"
}

const STATE_VIEW: Record<string, { label: string; tone: StateTone }> = {
  on_sale: { label: "在售", tone: "good" },
  processing: { label: "处理中", tone: "attest" },
  moderation_failed: { label: "审核失败", tone: "bad" },
  hidden: { label: "隐藏", tone: "idle" },
  archived: { label: "已归档", tone: "idle" },
}

function productStatus(row: StoreProductRow): { label: string; tone: StateTone } {
  if (row.gone) return { label: "已下架", tone: "bad" }
  return (row.state ? STATE_VIEW[row.state] : undefined) ?? { label: "未知", tone: "unknown" }
}

function NumberStack({ main, sub, dim }: { main: ReactNode; sub?: ReactNode; dim?: boolean }) {
  return <div className="flex flex-col items-end leading-tight">
    <span className={cn(dim && "text-muted-foreground")}>{main}</span>
    {sub ? <span className="font-sans text-xs text-muted-foreground">{sub}</span> : null}
  </div>
}

/** nameContent is a presentation slot, not a promotion/detail reader. */
export function ProductSnapshotCells({ row, showStore, nameContent, onOpenVariant, imageUrl = row.image_url }: {
  row: StoreProductRow
  showStore: boolean
  nameContent?: ReactNode
  onOpenVariant?: (row: StoreProductRow) => void
  imageUrl?: string | null
}) {
  const status = productStatus(row)
  return <>
    <TableCell>
      {imageUrl ? <ProductThumb src={imageUrl} name={row.name} /> :
        <div className="flex size-9 items-center justify-center rounded-md border border-border/60 bg-muted/60 text-muted-foreground"><PackageSearch className="size-4" aria-hidden /></div>}
    </TableCell>
    <TableCell className="overflow-hidden">
      <div className="flex w-0 min-w-full flex-col gap-1">
        <span className="break-words font-mono text-xs leading-snug" title={row.offer_id}>{row.offer_id}</span>
        {row.sku ? <a href={ozonProductUrl(row.sku)} target="_blank" rel="noreferrer" title="在 Ozon 打开商品页" aria-label={"在 Ozon 打开 SKU " + row.sku} className="w-fit cursor-pointer font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">{row.sku}</a> : <span className="text-xs text-muted-foreground">—</span>}
      </div>
    </TableCell>
    <TableCell className="overflow-hidden">
      <div className="flex w-0 min-w-full flex-col gap-1">
        {nameContent ?? <span className={cn("line-clamp-2 text-left font-medium leading-snug", row.gone && "text-muted-foreground")} title={row.name ?? undefined}>{row.name ?? "未命名商品"}</span>}
        {showStore ? <span className="truncate text-xs text-muted-foreground" title={row.store_name}>{row.store_name}</span> : null}
      </div>
    </TableCell>
    <TableCell className="overflow-hidden">
      <ProductVariantCell row={row} onOpen={onOpenVariant} />
    </TableCell>
    <TableCell className="overflow-hidden">
      <div className="flex min-w-0 max-w-full" title={status.label}>
        <StateChip status={status.label} label={status.label} tone={status.tone} className="max-w-full overflow-hidden" />
      </div>
    </TableCell>
  </>
}

/** A crossed-out price is only a higher, finite historical price. */
export function ProductPriceReading({ row, currency }: { row: StoreProductRow; currency?: string | null }) {
  const old = row.old_price == null ? NaN : Number(row.old_price)
  const price = row.price == null ? NaN : Number(row.price)
  const strike = Number.isFinite(old) && Number.isFinite(price) && old > price
  return <NumberStack main={formatStoreMoney(row.price, currency)} dim={row.price == null} sub={strike ? <>
    <span className="line-through">{formatStoreMoney(row.old_price, currency)}</span>
    <span className="ml-1 text-st-bad-ink">-{Math.round((1 - price / old) * 100)}%</span>
  </> : undefined} />
}

export function ProductStockReading({ row }: { row: StoreProductRow }) {
  const soldOut = row.stock_present === 0
  return <NumberStack main={<span className={cn(soldOut && "font-semibold text-st-bad-ink")}>{row.stock_present ?? "—"}</span>} dim={row.stock_present == null} sub={soldOut ? "售罄" : row.stock_reserved ? "占用 " + row.stock_reserved : undefined} />
}

function FunnelCell({ main, sub, title }: { main: string | null; sub?: string; title?: string | null }) {
  return <TableCell className="whitespace-nowrap text-right font-mono tabular-nums" title={title ?? undefined}>
    <NumberStack main={main ?? "—"} sub={main == null ? undefined : sub} dim={main == null} />
  </TableCell>
}

export function ProductMetricCells({ row, currency }: { row: StoreProductRow; currency?: string | null }) {
  const metrics = row.metrics
  const revenue = metrics ? analyticsRevenue(metrics, currency) : null
  return <>
    <FunnelCell main={metrics ? formatCount(metrics.hits_view) : null} sub={metrics ? "访客 " + formatCount(metrics.session_view) : undefined} />
    <FunnelCell main={metrics ? formatCount(metrics.hits_tocart) : null} sub={metrics ? formatPercentPoint(metrics.conv_tocart) : undefined} />
    <FunnelCell main={revenue ? revenue.text : null} title={revenue?.title} sub={metrics ? "出单 " + formatCount(metrics.ordered_units) : undefined} />
  </>
}

/** Static mirror cells shared by writable rows and the platform read-only row.
 * No writes, realtime readers, promotion board or capability-bearing imports.
 */
import type { ReactNode } from "react"
import { TableCell } from "@/components/ui/table"
import { StateChip } from "@/components/state-chip"
import { formatStoreMoney } from "@/lib/format"
import type { StateTone } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import type { StoreProductRow } from "./products-api"

/** Ozon public pages address SKU, not a tenant offer id. */
export function ozonProductUrl(sku: string): string {
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

export function ProductStatusCell({ row }: { row: StoreProductRow }) {
  const status = productStatus(row)
  return <TableCell className="overflow-hidden">
    <div className="flex min-w-0 max-w-full" title={status.label}>
      <StateChip status={status.label} label={status.label} tone={status.tone} className="max-w-full overflow-hidden" />
    </div>
  </TableCell>
}

function NumberStack({ main, sub, dim }: { main: ReactNode; sub?: ReactNode; dim?: boolean }) {
  return <div className="flex flex-col items-end leading-tight">
    <span className={cn(dim && "text-muted-foreground")}>{main}</span>
    {sub ? <span className="font-sans text-xs text-muted-foreground">{sub}</span> : null}
  </div>
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

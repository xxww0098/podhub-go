/** A seller product row keeps the draft's compact columns and the real actions. */
import { PackageSearch, Pencil } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { TableCell, TableRow } from "@/components/ui/table"
import { formatDateTimeShort } from "@/lib/format"
import { cn } from "@/lib/utils"

import { ozonProductUrl, ProductPriceReading, ProductStatusCell } from "./product-read-cells"
import { ProductStockCell } from "./product-stock-cell"
import { ProductThumb } from "./product-thumb"
import type { StoreProductRow } from "./products-api"
import { RowActionsMenu } from "./products-actions"
import { actionBlockReason, type ProductAction } from "./products-mutation"

export function ProductRow({
  row,
  showStore,
  currency,
  selected,
  onSelect,
  verifying,
  verifyDisabled,
  onAction,
  onOpen,
  onApplied,
  expanded = false,
  onToggle,
  lastFullSyncAt,
}: {
  row: StoreProductRow
  showStore: boolean
  currency?: string | null
  selected?: boolean
  onSelect?: (checked: boolean) => void
  verifying: boolean
  verifyDisabled: boolean
  onAction: (action: ProductAction, row: StoreProductRow) => void
  onOpen?: (row: StoreProductRow) => void
  onApplied?: (row: StoreProductRow) => void
  expanded?: boolean
  onToggle?: () => void
  lastFullSyncAt?: number | null
}) {
  const name = row.name ?? "未命名商品"
  const sku = row.sku
  const priceBlocked = actionBlockReason("price", row)
  const refreshedAt = validTimestamp(row.refreshed_at_ms)
  const snapshotAt = validTimestamp(lastFullSyncAt)
  const timestamp = refreshedAt ?? snapshotAt
  return (
    <TableRow data-state={selected ? "selected" : undefined} className="text-sm">
      <TableCell>
        {onSelect ? <Checkbox aria-label={"选择 " + row.offer_id} checked={selected ?? false}
          onCheckedChange={(checked) => onSelect(checked === true)} /> : null}
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 items-center gap-3">
          {row.image_url ? <ProductThumb src={row.image_url} name={row.name} className="size-12" /> :
            <span className="grid size-12 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
              <PackageSearch className="size-4" aria-hidden />
            </span>}
          <div className="flex min-w-0 flex-col gap-0.5">
            {onOpen ? <button type="button" title={name} aria-label={"打开 " + name + " 的促销活动"} onClick={() => onOpen(row)}
              className={cn("truncate text-left font-semibold hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", row.gone && "text-muted-foreground")}>{name}</button>
              : <span className="truncate font-semibold" title={name}>{name}</span>}
            <span className="truncate text-xs text-muted-foreground" title={row.offer_id}>货号：{row.offer_id}</span>
            {sku ? <a href={ozonProductUrl(sku)} target="_blank" rel="noreferrer"
              aria-label={"在 Ozon 打开 SKU " + sku} className="w-fit text-xs text-muted-foreground hover:underline">SKU：{sku}</a> :
              <span className="text-xs text-muted-foreground">SKU：—</span>}
          </div>
        </div>
      </TableCell>
      <TableCell><div className="flex min-w-0 items-center gap-1.5" title={row.store_name}>
        <StoreIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{row.store_name}</span>
        {showStore ? <span className="sr-only">，全部店铺视图</span> : null}
      </div></TableCell>
      <TableCell className="whitespace-nowrap text-right tabular-nums" title={priceBlocked ?? undefined}>
        {priceBlocked ? <ProductPriceReading row={row} currency={currency} /> :
          <button type="button" aria-label={"修改 " + row.offer_id + " 的价格"} onClick={() => onAction("price", row)}
            className="group/edit ml-auto flex items-center gap-1 rounded-sm hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <Pencil className="size-3 opacity-0 group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100" aria-hidden />
            <ProductPriceReading row={row} currency={currency} />
          </button>}
      </TableCell>
      <ProductStockCell row={row} onApplied={onApplied ?? (() => {})} />
      <ProductStatusCell row={row} />
      <TableCell className="text-xs text-muted-foreground" title={refreshedAt ? "单件核实时间" : snapshotAt ? "整店快照时间" : "更新时间未知"}>
        {timestamp ? <time dateTime={new Date(timestamp).toISOString()}>{formatDateTimeShort(timestamp)}</time> : "—"}
      </TableCell>
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          {onToggle ? <Button type="button" variant="outline" size="xs" aria-expanded={expanded}
            aria-label={(expanded ? "收起 " : "展开 ") + row.offer_id + " 的详情"} onClick={onToggle}>{expanded ? "收起" : "查看"}</Button> : null}
          <RowActionsMenu row={row} verifying={verifying} verifyDisabled={verifyDisabled} onAction={onAction} />
        </div>
      </TableCell>
    </TableRow>
  )
}

function validTimestamp(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && !Number.isNaN(new Date(value).getTime()) ? value : null
}

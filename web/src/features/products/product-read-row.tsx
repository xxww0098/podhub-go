/** A capability-free mirror row. Its only interaction reveals local snapshots. */
import type { ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import type { StoreProductRow } from "./products-api"
import { ProductMetricCells, ProductPriceReading, ProductSnapshotCells, ProductStockReading } from "./product-read-cells"

export function ProductReadRow({ row, currency, imageUrl, expanded, onToggle, attributionCells, endCells }: {
  row: StoreProductRow
  currency: string | null
  imageUrl: string | null
  expanded: boolean
  onToggle: () => void
  attributionCells?: ReactNode
  endCells?: ReactNode
}) {
  return <TableRow>
    <TableCell>
      <button type="button" aria-expanded={expanded} aria-label={(expanded ? "收起 " : "展开 ") + row.offer_id + " 的详情"} onClick={onToggle} className="grid size-6 cursor-pointer place-items-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
        <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden />
      </button>
    </TableCell>
    <ProductSnapshotCells row={row} showStore={false} imageUrl={imageUrl} />
    {attributionCells}
    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums"><ProductPriceReading row={row} currency={currency} /></TableCell>
    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums"><ProductStockReading row={row} /></TableCell>
    <ProductMetricCells row={row} currency={currency} />
    {endCells}
  </TableRow>
}

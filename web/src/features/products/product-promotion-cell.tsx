/** 促销列：点开才读这一件的活动。编辑留在列上，不放进展开详情，也不为每一行预取。 */
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TableCell } from "@/components/ui/table"

import { ProductPromotionBoard } from "./products-detail"
import type { StoreProductRow } from "./products-api"
import { actionBlockReason } from "./products-mutation"

export function ProductPromotionCell({
  row,
  currency,
  onApplied,
}: {
  row: StoreProductRow
  currency: string | null
  onApplied: (row: StoreProductRow) => void
}) {
  const [open, setOpen] = useState(false)
  const blocked = actionBlockReason("promotion", row)
  if (blocked) {
    return (
      <TableCell className="whitespace-nowrap text-right text-sm text-muted-foreground" title={blocked}>
        —
      </TableCell>
    )
  }
  return (
    <TableCell className="whitespace-nowrap text-right">
      <Popover open={open} onOpenChange={setOpen}>
        <div className="flex justify-end">
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="xs"
                aria-label={`修改 ${row.offer_id} 的促销`}
              />
            }
          >
            活动
          </PopoverTrigger>
        </div>
        <PopoverContent align="end" className="w-96">
          <div className="grid max-h-96 gap-2 overflow-auto">
            <div className="grid gap-0.5">
              <h3 className="text-sm font-medium">促销活动</h3>
              <p className="text-xs text-muted-foreground">只改这一件的活动价，或让它退出。</p>
            </div>
            {open ? (
              <ProductPromotionBoard row={row} currency={currency} onApplied={onApplied} />
            ) : null}
          </div>
        </PopoverContent>
      </Popover>
    </TableCell>
  )
}

/** 店铺商品表的一行：照片、货号/SKU、名称、状态、价格、库存、促销、销售漏斗与行尾操作。 */
import type { ReactNode } from "react"
import { ChevronRight, Pencil } from "lucide-react"

import { Checkbox } from "@/components/ui/checkbox"
import { TableCell, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"

import { ProductMetricCells, ProductPriceReading, ProductSnapshotCells } from "./product-read-cells"
import { ProductPromotionCell } from "./product-promotion-cell"
import { ProductStockCell } from "./product-stock-cell"
import type { StoreProductRow } from "./products-api"
import { RowActionsMenu } from "./products-actions"
import { actionBlockReason, type ProductAction } from "./products-mutation"

/** 价格 / 库存格即编辑入口：可写时整格是按钮，悬停出现铅笔；不可写时是
 * 纯文本并在 title 里说明原因。 */
function EditableCell({
  label,
  blocked,
  onEdit,
  children,
}: {
  label: string
  blocked: string | null
  onEdit: () => void
  children: ReactNode
}) {
  if (blocked) {
    return (
      <TableCell className="whitespace-nowrap text-right font-mono tabular-nums" title={blocked}>
        {children}
      </TableCell>
    )
  }
  return (
    <TableCell className="whitespace-nowrap text-right font-mono tabular-nums">
      <button
        type="button"
        aria-label={label}
        onClick={onEdit}
        className="group/edit ml-auto flex cursor-pointer items-center gap-1 rounded-md outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        <Pencil
          className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100"
          aria-hidden
        />
        {children}
      </button>
    </TableCell>
  )
}

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
  onOpenVariant,
  onApplied,
  expanded = false,
  onToggle,
}: {
  row: StoreProductRow
  showStore: boolean
  /** 行所属店铺的合同币种。标价用它；漏斗销售额另按卢布原值与记录的汇率换算。 */
  currency?: string | null
  selected?: boolean
  onSelect?: (checked: boolean) => void
  verifying: boolean
  verifyDisabled: boolean
  onAction: (action: ProductAction, row: StoreProductRow) => void
  /** 点商品名打开这一件的促销详情；不传时名字仍是纯文本，行测试不用改。 */
  onOpen?: (row: StoreProductRow) => void
  /** 点同款格打开这一件的同款规格详情；不传时这一格是纯文本。 */
  onOpenVariant?: (row: StoreProductRow) => void
  /** 库存列、促销列写入落地后回读这一行。 */
  onApplied?: (row: StoreProductRow) => void
  /** 展开这一行的销售详情。不传时行测试仍是单行。 */
  expanded?: boolean
  onToggle?: () => void
}) {
  const name = row.name ?? "未命名商品"
  const nameClass = cn(
    "line-clamp-2 text-left font-medium leading-snug",
    row.gone && "text-muted-foreground",
    onOpen &&
      "cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  )
  return (
    <TableRow data-state={selected ? "selected" : undefined}>
      <TableCell>
        {onSelect ? (
          <Checkbox
            aria-label={`选择 ${row.offer_id}`}
            checked={selected ?? false}
            onCheckedChange={(checked) => onSelect(checked === true)}
          />
        ) : null}
      </TableCell>
      <TableCell>
        {onToggle ? (
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={`${expanded ? "收起" : "展开"} ${row.offer_id} 的详情`}
            onClick={onToggle}
            className={cn(
              "grid size-6 cursor-pointer place-items-center rounded-sm outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              expanded ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", expanded && "rotate-90")} aria-hidden />
          </button>
        ) : null}
      </TableCell>
      <ProductSnapshotCells row={row} showStore={showStore} onOpenVariant={onOpenVariant} nameContent={onOpen ? (
        <button type="button" className={nameClass} title={row.name ?? undefined}
          aria-label={"打开 " + name + " 的促销活动"} onClick={() => onOpen(row)}>
          {name}
        </button>
      ) : undefined} />
      <EditableCell
        label={`修改 ${row.offer_id} 的价格`}
        blocked={actionBlockReason("price", row)}
        onEdit={() => onAction("price", row)}
      >
        <ProductPriceReading row={row} currency={currency} />
      </EditableCell>
      <ProductStockCell row={row} onApplied={onApplied ?? (() => {})} />
      <ProductPromotionCell row={row} currency={currency ?? null} onApplied={onApplied ?? (() => {})} />
      <ProductMetricCells row={row} currency={currency} />
      <TableCell className="text-right">
        <RowActionsMenu
          row={row}
          verifying={verifying}
          verifyDisabled={verifyDisabled}
          onAction={onAction}
        />
      </TableCell>
    </TableRow>
  )
}

/**
 * 店铺商品表的两处操作入口，共用同一份动作词表：
 * 行尾「⋯」菜单（单件）与勾选后的批量操作栏。
 */
import { ExternalLink, MoreHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

import type { StoreProductRow } from "./products-api"
import { ozonProductUrl } from "./product-read-cells"
import { actionBlockReason, type ProductAction } from "./products-mutation"
import { VARIANT_PRODUCT_ACTIONS } from "./products-variant-model"

export const ACTION_LABEL: Record<ProductAction, string> = {
  price: "改价格",
  stock: "改库存",
  promotion: "促销活动",
  verify: "核实最新数据",
  archive: "归档",
  unarchive: "恢复",
  delete: "删除",
  "variant-merge": "合并为同款",
  "variant-split": "拆出规格",
  "variant-move": "移入已有同款",
}

/** 前台商品页地址：Ozon 公开页面只按 SKU 寻址（本部署面向 ozon.ru 店面）。 */

function MenuAction({
  action,
  row,
  disabledReason,
  onAction,
}: {
  action: ProductAction
  row: StoreProductRow
  disabledReason?: string | null
  onAction: (action: ProductAction, row: StoreProductRow) => void
}) {
  const blocked = disabledReason ?? actionBlockReason(action, row)
  return (
    <DropdownMenuItem
      disabled={blocked !== null}
      variant={action === "delete" ? "destructive" : "default"}
      onClick={() => onAction(action, row)}
    >
      <span className="flex flex-col">
        <span>{ACTION_LABEL[action]}</span>
        {blocked ? <span className="text-xs text-muted-foreground">{blocked}</span> : null}
      </span>
    </DropdownMenuItem>
  )
}

export function RowActionsMenu({
  row,
  verifying,
  verifyDisabled,
  onAction,
}: {
  row: StoreProductRow
  verifying: boolean
  verifyDisabled: boolean
  onAction: (action: ProductAction, row: StoreProductRow) => void
}) {
  const archived = row.state === "archived"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`${row.offer_id} 的操作`}
          />
        }
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <MenuAction action="price" row={row} onAction={onAction} />
        <MenuAction action="stock" row={row} onAction={onAction} />
        <MenuAction action="promotion" row={row} onAction={onAction} />
        <MenuAction
          action="verify"
          row={row}
          onAction={onAction}
          disabledReason={
            verifying ? "核实中…" : verifyDisabled ? "自动更新已停用" : undefined
          }
        />
        {row.sku ? (
          <DropdownMenuItem
            render={<a href={ozonProductUrl(row.sku)} target="_blank" rel="noreferrer" />}
          >
            在 Ozon 前台查看
            <ExternalLink className="ml-auto size-3.5" aria-hidden />
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <MenuAction action={archived ? "unarchive" : "archive"} row={row} onAction={onAction} />
        {archived ? <MenuAction action="delete" row={row} onAction={onAction} /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 勾选后的批量栏：常用三项直接露出，其余收进「更多」。 */
export function SelectionActions({
  count,
  verifyDisabled,
  onAction,
}: {
  count: number
  verifyDisabled: boolean
  onAction: (action: ProductAction) => void
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">已选 {count} 件</span>
      {(["price", "stock", "promotion"] as const).map((action) => (
        <Button
          key={action}
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onAction(action)}
        >
          {ACTION_LABEL[action]}
        </Button>
      ))}
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button type="button" variant="outline" size="sm" aria-label="更多批量操作" />}
        >
          更多
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {VARIANT_PRODUCT_ACTIONS.map((action) => (
            <DropdownMenuItem key={action} onClick={() => onAction(action)}>
              {ACTION_LABEL[action]}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={verifyDisabled} onClick={() => onAction("verify")}>
            {ACTION_LABEL.verify}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => onAction("archive")}>{ACTION_LABEL.archive}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onAction("unarchive")}>
            {ACTION_LABEL.unarchive}
          </DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => onAction("delete")}>
            {ACTION_LABEL.delete}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

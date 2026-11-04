/** 店铺商品表本体：表头勾选、商品行、加载 / 空状态与分页。每一行可展开详情。 */
import { Fragment, useRef, useState } from "react"
import { PackageSearch } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableExpandedRow,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

import type { ProductFreshness } from "./freshness"
import { ProductExpand } from "./product-expand"
import { ProductRow } from "./product-row"
import { ProductVariantCell } from "./products-variant-column"
import type { StoreProductRow } from "./products-api"
import { rowKey, type ProductAction } from "./products-mutation"

export function ProductsTable({
  rows,
  showStore,
  currencyOf,
  snapshotAtOf,
  selectedKeys,
  onSelectedKeys,
  verifying,
  verifyDisabled,
  onAction,
  onOpen,
  onApplied,
  loading,
  failed,
  noStores,
  onRetry,
  onOpenStores,
  freshness,
  hasMore,
  onLoadMore,
}: {
  rows: StoreProductRow[]
  showStore: boolean
  currencyOf: (storeId: string) => string | null
  snapshotAtOf: (storeId: string) => number | null
  selectedKeys: Set<string>
  onSelectedKeys: (next: Set<string>) => void
  verifying: Set<string>
  verifyDisabled: boolean
  onAction: (action: ProductAction, row: StoreProductRow) => void
  onOpen?: (row: StoreProductRow) => void
  onApplied: (row: StoreProductRow) => void
  loading: boolean
  failed: boolean
  noStores: boolean
  onRetry: () => void
  onOpenStores?: () => void
  /** 当前单店的新鲜度；全部店铺视图为 null。 */
  freshness: ProductFreshness | null
  hasMore: boolean
  onLoadMore: () => void
}) {
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  // 收起不是瞬时卸载：TableExpandedRow 先播 110ms 收拢，再真正移除
  // 这一行。closingKey 记录正在收拢的是哪一行。
  const [closingKey, setClosingKey] = useState<string | null>(null)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const columnCount = 8
  const selectedCount = rows.filter((row) => selectedKeys.has(rowKey(row))).length
  const toggle = (row: StoreProductRow, checked: boolean) => {
    const key = rowKey(row)
    if (checked === selectedKeys.has(key)) return
    const next = new Set(selectedKeys)
    if (checked) next.add(key)
    else next.delete(key)
    onSelectedKeys(next)
  }
  const never = freshness === "never"
  const collapse = () => {
    const key = expandedKey
    if (key == null) return
    setClosingKey(key)
    if (closeTimer.current) clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => {
      setExpandedKey(null)
      setClosingKey(null)
      closeTimer.current = null
    }, 110)
  }
  const expand = (key: string) => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current)
      closeTimer.current = null
    }
    setClosingKey(null)
    setExpandedKey(key)
  }

  return (
    <Table aria-label="我的商品" className={rows.length ? "min-w-[760px] table-fixed" : "table-fixed"} containerClassName="@container min-h-0 flex-1 overflow-auto">
      <TableHeader className="sticky top-0 z-10 bg-card">
        <TableRow>
          <TableHead className="w-10">
            <Checkbox
              aria-label="选择本页全部商品"
              disabled={loading || rows.length === 0}
              checked={rows.length > 0 && selectedCount === rows.length}
              indeterminate={selectedCount > 0 && selectedCount < rows.length}
              onCheckedChange={(checked) =>
                onSelectedKeys(checked === true ? new Set(rows.map(rowKey)) : new Set())
              }
            />
          </TableHead>
          <TableHead className="w-[30%]">商品信息 / 货号</TableHead>
          <TableHead className="w-[14%]">店铺</TableHead>
          <TableHead className="w-[12%] text-right">价格</TableHead>
          <TableHead className="w-[8%] text-right">库存</TableHead>
          <TableHead className="w-[11%]">商品状态</TableHead>
          <TableHead className="w-[15%]">快照更新时间</TableHead>
          <TableHead className="w-[10%] text-right">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => {
          const key = rowKey(row)
          const expanded = expandedKey === key
          return (
            <Fragment key={key}>
              <ProductRow
                row={row}
                showStore={showStore}
                currency={currencyOf(row.store_id)}
                lastFullSyncAt={snapshotAtOf(row.store_id)}
                selected={selectedKeys.has(key)}
                onSelect={(checked) => toggle(row, checked)}
                verifying={verifying.has(`${row.store_id}:${row.product_id}`)}
                verifyDisabled={verifyDisabled}
                onAction={onAction}
                onOpen={onOpen}
                onApplied={onApplied}
                expanded={expanded}
                onToggle={() => (expanded ? collapse() : expand(key))}
              />
              {expanded ? (
                <TableExpandedRow colSpan={columnCount} closing={closingKey === key}>
                  <div className="flex flex-wrap items-center gap-4 text-sm">
                    <div className="flex items-center gap-2">同款：<ProductVariantCell row={row} /></div>
                    {onOpen ? <Button type="button" variant="outline" size="xs" onClick={() => onOpen(row)}>促销详情</Button> : null}
                  </div>
                  <ProductExpand row={row} currency={currencyOf(row.store_id)} />
                </TableExpandedRow>
              ) : null}
            </Fragment>
          )
        })}
        {rows.length === 0 ? (
          <TableRow>
            <TableCell colSpan={columnCount}>
              {loading ? (
                <div className="flex flex-col gap-2 py-4">
                  {Array.from({ length: 6 }, (_, index) => (
                    <Skeleton key={index} className="h-8" />
                  ))}
                </div>
              ) : failed ? (
                <div role="alert" className="flex flex-col items-center gap-2 py-16 text-center">
                  <p className="text-sm font-medium">商品列表读取失败</p>
                  <Button type="button" variant="outline" size="sm" onClick={onRetry}>重试</Button>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2 py-16 text-center">
                  <PackageSearch className="size-8 text-muted-foreground" aria-hidden />
                  <p className="text-sm font-medium">
                    {noStores ? "还没有可见店铺" : never ? "本店暂无商品数据" : "当前条件下没有商品"}
                  </p>
                  <p className="max-w-sm text-xs text-muted-foreground">
                    {noStores ? "先去店铺页登记 Seller 凭据。" : never
                      ? "「立即更新」会从 Ozon 拉取最新商品并写入这张表。"
                      : "换一个状态页签，或清空搜索。数据由后台自动更新。"}
                  </p>
                  {noStores && onOpenStores ? <Button type="button" variant="outline" size="sm" onClick={onOpenStores}>打开店铺</Button> : null}
                </div>
              )}
            </TableCell>
          </TableRow>
        ) : null}
        {hasMore ? (
          <TableRow>
            <TableCell colSpan={columnCount} className="text-center">
              <Button type="button" variant="outline" size="sm" disabled={loading} onClick={onLoadMore}>
                加载更多
              </Button>
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  )
}

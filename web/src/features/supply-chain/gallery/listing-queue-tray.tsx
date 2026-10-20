/**
 * 上架清单悬浮面板——触发钮 + 向上/向下展开的清单浮窗：点行回详情页（已下架
 * 行只读），尾部「批量进入上架」把整组最小身份递给上架导航。清单本体在
 * listing-queue.ts 的模块 store，卡片/详情页/本面板读写同一份。
 *
 * 两种落点：`toolbar` 形态嵌进画廊工具行尾（对位选品页的清单入口），
 * `fab` 形态是详情页/空态上盖在右下角的悬浮钮。
 */
import { useEffect, useMemo } from "react"
import { Image as ImageIcon, ListChecks, X } from "lucide-react"

import type { OzonStoreView } from "@/bindings/commands"
import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"
import { useScreenActive } from "@/components/screen-pane"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { notifyInfo } from "@/lib/notify"
import { cn } from "@/lib/utils"

import {
  LISTABILITY_BADGE,
  listabilitySkippedNotice,
} from "../listability-copy"
import {
  catalogListingIdentity,
  formatCny,
  listabilityOf,
  type CatalogListingIdentity,
} from "./gallery-model"
import {
  availableQueueRows,
  importableQueueRows,
  useGalleryCollection,
} from "./listing-queue"
import { marketImageSrc } from "./market-image"
import { QueueBindings } from "./queue-bindings"

export function ListingQueueTray({
  open,
  onOpenChange,
  rows,
  refreshing,
  onOpenDetail,
  onOpenListing,
  stores,
  onOpenStores,
  variant = "fab",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: SellerSupplierDbRowData[]
  refreshing?: boolean
  onOpenDetail: (row: SellerSupplierDbRowData) => void
  onOpenListing: (products: CatalogListingIdentity[]) => void
  stores: readonly OzonStoreView[]
  onOpenStores?: () => void
  /**
   * `toolbar`：工具行尾的常态按钮，面板向下展开；
   * `fab`：右下角圆形悬浮钮，面板向上展开（详情页/空态用）。
   */
  variant?: "fab" | "toolbar"
}) {
  const { queue, removeQueued, clearQueue } = useGalleryCollection()
  // 浮窗 portal 在 body——宿主屏切走时强制合上，与 Sheet 的 screenActive 约定一致。
  const screenActive = useScreenActive()
  useEffect(() => {
    if (!screenActive && open) onOpenChange(false)
  }, [onOpenChange, open, screenActive])
  const rowsById = useMemo(
    () => new Map(rows.map((row) => [row.productId, row] as const)),
    [rows],
  )
  const ordered = useMemo(
    () => [...queue].sort((a, b) => b.addedAtMs - a.addedAtMs),
    [queue],
  )

  // 前置门：在最新货盘里仍暂不可上架的行不进批量导入——跳过的行留在
  // 清单里（平台复核/恢复后下次再导），计数由提交时一次性报数交代。
  const present = availableQueueRows(ordered, rowsById)
  const importable = importableQueueRows(present)

  const toolbar = variant === "toolbar"

  return (
    <Popover open={screenActive ? open : false} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={toolbar ? "brand" : "default"}
            aria-expanded={open}
            data-gallery-queue-open=""
            className={
              toolbar
                ? "cursor-pointer"
                : "z-30 mx-4 my-3 h-11 shrink-0 cursor-pointer gap-2 self-end rounded-full px-4 shadow-lg sm:absolute sm:right-4 sm:bottom-4 sm:m-0"
            }
          />
        }
      >
        <ListChecks aria-hidden />
        上架清单
        {queue.length ? (
          <span
            className={cn(
              "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 font-mono text-meta leading-none tabular-nums",
              toolbar
                ? "bg-brand-foreground text-brand"
                : "bg-brand text-brand-foreground",
            )}
          >
            {queue.length}
          </span>
        ) : null}
      </PopoverTrigger>
      <PopoverContent
        side={toolbar ? "bottom" : "top"}
        align="end"
        sideOffset={10}
        className="flex max-h-[min(32rem,calc(100dvh-8rem))] w-96 flex-col overflow-hidden p-0"
        data-gallery-queue-tray=""
      >
        <div className="flex items-start gap-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">
              上架清单（{queue.length}）
            </p>
            <p className="text-meta text-muted-foreground">
              挑好的商品在这里集合，批量导入为上架方案。
            </p>
          </div>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="关闭上架清单"
            className="cursor-pointer"
            onClick={() => onOpenChange(false)}
          >
            <X aria-hidden />
          </Button>
        </div>
        {ordered.length ? (
          <ul className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {ordered.map((entry) => {
              const row = rowsById.get(entry.productId)
              const rowListability = row ? listabilityOf(row) : null
              return (
                <li
                  key={entry.productId}
                  className={cn(
                    "flex min-w-0 items-center gap-3 border-b border-border/70 px-4 py-2.5 last:border-b-0",
                    !row && "bg-muted/40",
                  )}
                  data-gallery-queue-item={entry.productId}
                >
                  {entry.coverUrl ? (
                    <img
                      src={marketImageSrc(entry.coverUrl, 256)}
                      alt=""
                      width={44}
                      height={44}
                      loading="lazy"
                      decoding="async"
                      className="size-11 shrink-0 rounded-md border border-border/60 object-cover"
                    />
                  ) : (
                    <div className="grid size-11 shrink-0 place-items-center rounded-md border border-dashed border-border text-muted-foreground">
                      <ImageIcon className="size-4" aria-hidden />
                    </div>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <button
                      type="button"
                      disabled={!row}
                      className="truncate text-left text-compact font-medium text-foreground enabled:cursor-pointer enabled:hover:text-brand-ink disabled:cursor-not-allowed disabled:text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                      onClick={() => { if (row) onOpenDetail(row) }}
                    >
                      {entry.title}
                    </button>
                    {!row ? (
                      <Badge variant="secondary" className="self-start">已下架 · 不可上架</Badge>
                    ) : rowListability && !rowListability.listable ? (
                      // 行还在货盘但当前不可上架：徽标预告「批量导入会跳过它」。
                      <Badge variant="secondary" className="self-start" data-queue-listability="">
                        {LISTABILITY_BADGE[rowListability.class]}
                      </Badge>
                    ) : null}
                    <p className="flex min-w-0 items-baseline gap-2 text-meta text-faint-foreground">
                      <span className="min-w-0 truncate font-mono">
                        {entry.platformCode}
                      </span>
                      {entry.size ? <span className="truncate">规格 {entry.size}</span> : null}
                      <span className="font-mono tabular-nums">
                        {formatCny(entry.platformPriceCents)}
                      </span>
                    </p>
                    {/* 已下架的行不能导入，绑定控件也就不给（避免攒下一笔落不了卡的草稿）。 */}
                    <QueueBindings
                      entry={entry}
                      available={Boolean(row)}
                      stores={stores}
                      onOpenStores={onOpenStores}
                    />
                  </div>
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`移出清单 ${entry.title}`}
                    className="cursor-pointer"
                    onClick={() => removeQueued(entry.productId)}
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              )
            })}
          </ul>
        ) : (
          <div className="flex min-h-44 flex-1 flex-col items-center justify-center gap-1.5 px-6 py-8 text-center">
            <div className="mb-1 grid size-9 place-items-center rounded-lg border border-dashed border-border-strong text-muted-foreground">
              <ListChecks className="size-4" aria-hidden />
            </div>
            <p className="text-sm font-medium text-foreground">清单还是空的</p>
            <p className="text-meta text-muted-foreground">
              在卡片或详情页点「加入上架清单」。
            </p>
          </div>
        )}
        {ordered.length ? (
          <div className="flex items-center gap-2 border-t border-border px-3 py-2.5">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="cursor-pointer"
              onClick={clearQueue}
            >
              清空
            </Button>
            <Button
              type="button"
              size="sm"
              className="flex-1 cursor-pointer"
              disabled={refreshing || !importable.rows.length}
              data-gallery-queue-submit=""
              onClick={() => {
                if (refreshing) return
                submitQueueImport(present, onOpenListing)
                onOpenChange(false)
              }}
            >
              {refreshing ? "正在核对规格…" : `批量进入上架（${importable.rows.length} 件）`}
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/**
 * 清单浮窗「批量进入上架」的提交：暂不可上架的行跳过并一次性报数
 * （`已跳过 N 件…`，条目留在清单），可达集照走最小身份交接。没有可达行
 * 时什么都不递——空数组不进上架导航。
 */
export function submitQueueImport(
  present: SellerSupplierDbRowData[],
  onOpenListing: (products: CatalogListingIdentity[]) => void,
): void {
  const { rows, skipped } = importableQueueRows(present)
  if (skipped > 0) notifyInfo(listabilitySkippedNotice(skipped))
  if (!rows.length) return
  onOpenListing(rows.map(catalogListingIdentity))
}

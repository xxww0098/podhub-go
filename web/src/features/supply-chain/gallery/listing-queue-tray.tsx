/**
 * 上架清单悬浮面板——触发钮 + 向上/向下展开的清单浮窗：点行回详情页（已下架
 * 行只读），尾部「批量进入上架」把整组最小身份递给上架导航。清单本体在
 * listing-queue.ts 的模块 store，列表/详情页/本面板读写同一份。
 *
 * 两种落点：`toolbar` 形态嵌进画廊工具行尾（对位选品页的清单入口），
 * `fab` 形态是详情页/空态上盖在右下角的悬浮钮。
 */
import { useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, Eraser, Image as ImageIcon, ListChecks, X } from "lucide-react"

import type { SellerSupplierDbRowData } from "@/bindings/http-supplier-dbs-catalog"
import { useScreenActive } from "@/components/screen-pane"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { notifyCommandError, notifyInfo } from "@/lib/notify"
import { cn } from "@/lib/utils"

import {
  LISTABILITY_BADGE,
  listabilityExplanation,
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

export function ListingQueueTray({
  open,
  onOpenChange,
  rows,
  refreshing,
  refreshRows,
  onOpenDetail,
  onOpenListing,
  variant = "fab",
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  rows: SellerSupplierDbRowData[]
  refreshing?: boolean
  refreshRows?: () => Promise<SellerSupplierDbRowData[] | undefined>
  onOpenDetail: (row: SellerSupplierDbRowData) => void
  onOpenListing: (products: CatalogListingIdentity[]) => void | Promise<void>
  /**
   * `toolbar`：工具行尾的常态按钮，面板向下展开；
   * `fab`：右下角圆形悬浮钮，面板向上展开（详情页/空态用）。
   */
  variant?: "fab" | "toolbar"
}) {
  const { queue, removeQueued, clearQueue } = useGalleryCollection()
  // 浮窗 portal 在 body——宿主屏切走时强制合上，与 Sheet 的 screenActive 约定一致。
  const screenActive = useScreenActive()
  const activeRef = useRef(screenActive)
  activeRef.current = screenActive
  const queueRef = useRef(queue)
  queueRef.current = queue
  const [preparing, setPreparing] = useState(false)
  useEffect(() => {
    activeRef.current = screenActive
    return () => { activeRef.current = false }
  }, [screenActive])
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

  async function openListing() {
    if (refreshing || preparing || !queueRef.current.length) return
    setPreparing(true)
    try {
      const freshRows = refreshRows ? await refreshRows() : rows
      if (!freshRows || !activeRef.current) return
      const freshById = new Map(freshRows.map((row) => [row.productId, row] as const))
      const currentQueue = [...queueRef.current].sort((a, b) => b.addedAtMs - a.addedAtMs)
      if (!currentQueue.length) return
      const present = availableQueueRows(currentQueue, freshById)
      if (!present.length) {
        notifyInfo("清单中的商品已下架，请移除后重新选品")
        onOpenChange(true)
        return
      }
      const submitted = await submitQueueImport(present, onOpenListing)
      if (activeRef.current) onOpenChange(!submitted)
    } catch (reason) {
      notifyCommandError(reason, "读不到货源，无法进入上架")
    } finally {
      setPreparing(false)
    }
  }

  const submitButton = (
    <Button
      type="button"
      size={toolbar ? "default" : "sm"}
      className={toolbar ? "cursor-pointer" : "flex-1 cursor-pointer"}
      disabled={refreshing || preparing || !queue.length}
      aria-busy={preparing || undefined}
      data-gallery-queue-direct-submit={toolbar ? "" : undefined}
      data-gallery-queue-submit={!toolbar ? "" : undefined}
      onClick={openListing}
    >
      {preparing ? "正在准备…" : refreshing ? "正在核对…" : "前往上架"}
    </Button>
  )

  const popover = (
    <Popover open={screenActive ? open : false} onOpenChange={onOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={toolbar ? "outline" : "default"}
            size="default"
            aria-expanded={open}
            aria-label={queue.length ? `上架清单，${queue.length} 件` : "上架清单"}
            title="上架清单"
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
            aria-hidden
            className={cn(
              "inline-flex min-w-5 items-center justify-center rounded-full px-1.5 py-0.5 text-meta leading-none tabular-nums",
              toolbar
                ? "bg-brand-soft text-brand-ink"
                : "bg-brand text-brand-foreground",
            )}
          >
            {queue.length}
          </span>
        ) : null}
        {toolbar ? <ChevronDown aria-hidden /> : null}
      </PopoverTrigger>
      <PopoverContent
        side={toolbar ? "bottom" : "top"}
        align="end"
        sideOffset={10}
        aria-label="上架清单"
        className="flex max-h-[min(32rem,calc(100dvh-8rem))] w-[min(26rem,calc(100vw-2rem))] flex-col overflow-hidden p-0"
        data-gallery-queue-tray=""
      >
        {!toolbar || !ordered.length ? <div className="flex items-start gap-2 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p className="text-sm font-medium text-foreground">
              上架清单（{queue.length}）
            </p>
          </div>
          <IconButton
            icon={X}
            label="关闭上架清单"
            size="icon-xs"
            variant="ghost"
            tooltipSide="left"
            onClick={() => onOpenChange(false)}
          />
        </div> : null}
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
                    {rowListability && !rowListability.listable ? (
                      <p className="text-meta text-muted-foreground" data-queue-blocked-reason="">
                        {listabilityExplanation(row?.denial)}
                      </p>
                    ) : null}
                  </div>
                  <IconButton
                    icon={X}
                    label={`移出清单 ${entry.title}`}
                    tip="移出清单"
                    size="icon-xs"
                    variant="ghost"
                    tooltipSide="left"
                    onClick={() => removeQueued(entry.productId)}
                  />
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
              在商品行或详情页点「加入上架清单」。
            </p>
          </div>
        )}
        {ordered.length ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-border px-3 py-2.5">
            <p className="mr-auto text-meta text-muted-foreground" role="status">
              {importable.rows.length} 件可上架
              {queue.length > importable.rows.length ? ` · ${queue.length - importable.rows.length} 件不可上架` : ""}
            </p>
            <Button type="button" variant="ghost" size="sm" aria-label="清空上架清单" onClick={clearQueue}>
              <Eraser aria-hidden />清空
            </Button>
            {!toolbar ? submitButton : null}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )

  if (!toolbar) return popover
  return (
    <>
      {popover}
      {submitButton}
    </>
  )
}

/**
 * 清单浮窗「批量进入上架」的提交：暂不可上架的行跳过并一次性报数
 * （`已跳过 N 件…`，条目留在清单），可达集照走最小身份交接。没有可达行
 * 时什么都不递——空数组不进上架导航。
 */
export async function submitQueueImport(
  present: SellerSupplierDbRowData[],
  onOpenListing: (products: CatalogListingIdentity[]) => void | Promise<void>,
): Promise<boolean> {
  const { rows, skipped } = importableQueueRows(present)
  if (skipped > 0) notifyInfo(listabilitySkippedNotice(skipped))
  if (!rows.length) return false
  await onOpenListing(rows.map(catalogListingIdentity))
  return true
}

/** Bounded serial bulk commands retain the factory of each selected specification. */
import { useEffect, useRef, useState } from "react"
import { CheckCircle2, CirclePause, Ellipsis, X } from "lucide-react"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { notifyError, notifySuccess } from "@/lib/notify"
import type { SupplierDbsStore } from "./supplier-dbs-store"

type BulkKind = "publish" | "unpublish" | "archive" | "delete"
export function useSupplierDbActions({ rows, store, selectedIds, setSelectedIds, canPublish = false }: {
  rows: SupplierDbRow[]
  store: SupplierDbsStore
  selectedIds: ReadonlySet<string>
  setSelectedIds: (ids: ReadonlySet<string>) => void
  canPublish?: boolean
}) {
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [bulkBusy, setBulkBusy] = useState<BulkKind | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState<"archive" | "delete" | null>(null)
  /**
   * 批量行写 — 后端没有批量端点，逐行串行调既有行级写（每行自带
   * withRowPending 置灰），一次 toast 汇总落/拦。归档/删除走完清选择：
   * 那些行已离开商品表，留着勾选只会误导下一次操作。
   */
  const runBulk = async (
    kind: "publish" | "unpublish" | "archive" | "delete",
  ) => {
    if ((kind === "publish" || kind === "unpublish") && !canPublish) return
    const selected = rows.filter((row) => selectedIds.has(row.productId))
    if (!selected.length || bulkBusy) return
    setBulkBusy(kind)
    let ok = 0
    let refused = 0
    let firstReason: unknown
    try {
      for (const { sourceId, productId } of selected) {
        if (!active.current) break
        const result =
          kind === "publish"
            ? await store.publishRow(sourceId, productId)
            : kind === "unpublish"
              ? await store.unpublishRow(sourceId, productId)
              : kind === "archive"
                ? await store.archiveRow(sourceId, productId)
                : await store.deleteRow(sourceId, productId)
        if (result.ok) ok += 1
        else {
          if (refused === 0) firstReason = result.reason
          refused += 1
        }
      }
    } finally {
      setBulkBusy(null)
      setBulkConfirm(null)
    }
    if (!active.current) return
    const label =
      kind === "publish"
        ? "发布"
        : kind === "unpublish"
          ? "停用"
          : kind === "archive"
            ? "归档"
            : "删除"
    if (refused === 0) {
      notifySuccess(`已${label} ${ok} 个规格`)
    } else {
      notifyError(
        ok > 0 ? `已${label} ${ok} 个规格，${refused} 行被拒` : `${refused} 个规格${label}失败`,
        {
          reason: firstReason,
          description:
            kind === "publish"
              ? "被拒的行缺上架前置（类目 / 提示词 / 固定 tags / 平台价），在商品流程中补齐。"
              : kind === "delete"
                ? "被拒的行仍被上架记录或订单行引用——先下架，或改用归档。"
                : undefined,
        },
      )
    }
    if (kind === "archive" || kind === "delete") setSelectedIds(new Set())
  }

  return { selectedIds, setSelectedIds, bulkBusy, bulkConfirm, setBulkConfirm, runBulk, canPublish }
}
type Actions = ReturnType<typeof useSupplierDbActions>

export function SupplierDbBulkBar({ actions }: { actions: Actions }) {
  const { selectedIds, bulkBusy, runBulk, setBulkConfirm, setSelectedIds, canPublish } = actions
  if (selectedIds.size === 0) return null
  return (
    <div className="mx-4 mb-3 flex flex-wrap items-center gap-2 border-y border-border py-2" role="region" aria-label="批量操作" data-bulk-bar="" aria-busy={bulkBusy !== null}>
      <span className="text-compact font-medium">已选择 {selectedIds.size} 个规格</span>
      {canPublish ? <><Button type="button" aria-label="发布所选" variant="default" size="sm" disabled={bulkBusy !== null} data-bulk-action="publish" onClick={() => void runBulk("publish")}><CheckCircle2 aria-hidden />发布所选</Button>
      <IconButton icon={CirclePause} label="停用所选" variant="outline" size="icon-sm" disabled={bulkBusy !== null} data-bulk-action="unpublish" onClick={() => void runBulk("unpublish")} /></> : null}
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger
            render={
              <DropdownMenuTrigger
                render={<Button type="button" variant="outline" size="icon-sm" aria-label="更多操作" disabled={bulkBusy !== null} data-bulk-menu="" />}
              />
            }
          >
            <Ellipsis aria-hidden />
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>更多操作</TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-bulk-action="archive" onClick={() => setBulkConfirm("archive")}>归档所选</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" data-bulk-action="delete" onClick={() => setBulkConfirm("delete")}>删除所选</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-bulk-action="clear" onClick={() => setSelectedIds(new Set())}>清除选择</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton icon={X} label="清除选择" size="icon-sm" disabled={bulkBusy !== null} onClick={() => setSelectedIds(new Set())} />
    </div>
  )
}

export function SupplierDbConfirmations({ actions }: { actions: Actions }) {
  const { selectedIds, bulkConfirm, setBulkConfirm, bulkBusy, runBulk } = actions
  return <>
      <ConfirmDialog
        open={bulkConfirm === "archive"}
        onOpenChange={(open) => !open && setBulkConfirm(null)}
        title={`归档 ${selectedIds.size} 行？`}
        description="归档后这些行离开商品表与画廊，数据保留。仍被引用的行只能归档不能删除。"
        confirmText={`归档 ${selectedIds.size} 行`}
        busy={bulkBusy === "archive"}
        onConfirm={() => void runBulk("archive")}
      />

      <ConfirmDialog
        open={bulkConfirm === "delete"}
        onOpenChange={(open) => !open && setBulkConfirm(null)}
        title={`删除 ${selectedIds.size} 行？`}
        description="被上架记录或订单行引用的行不能直接删除——请先下架；仍被引用时只能归档。删除后不可恢复。"
        confirmText={`删除 ${selectedIds.size} 行`}
        busy={bulkBusy === "delete"}
        onConfirm={() => void runBulk("delete")}
      />

  </>
}

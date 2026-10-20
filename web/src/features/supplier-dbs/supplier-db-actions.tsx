/** Public visibility, library deletion and bounded serial bulk row commands. */
import { useEffect, useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import type { SupplierDbsStore } from "./supplier-dbs-store"
import { commandFailure } from "./supplier-dbs-errors"

type BulkKind = "publish" | "unpublish" | "archive" | "delete"
export function useSupplierDbActions({ db, store, selectedIds, setSelectedIds, onExit }: {
  db: SupplierDb
  store: SupplierDbsStore
  selectedIds: ReadonlySet<string>
  setSelectedIds: (ids: ReadonlySet<string>) => void
  onExit: () => void
}) {
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const [deleteDbOpen, setDeleteDbOpen] = useState(false)
  const [deleteDbBusy, setDeleteDbBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState<BulkKind | null>(null)
  const [bulkConfirm, setBulkConfirm] = useState<"archive" | "delete" | null>(null)
  const listedLock = useRef(false)
  const [listedBusy, setListedBusy] = useState(false)
  const [pendingListed, setPendingListed] = useState<{ sourceId: string; value: boolean } | null>(null)
  const listed = pendingListed && pendingListed.sourceId === db.sourceId ? pendingListed.value : db.listed
  const setListed = async (next: boolean) => {
    if (next === listed || listedLock.current) return
    listedLock.current = true
    setListedBusy(true)
    setPendingListed({ sourceId: db.sourceId, value: next })
    try {
      const result = await store.updateDb(db.sourceId, { listed: next })
      if (!active.current) return
      setPendingListed(null)
      if (!result.ok) {
        notifyCommandError(
          commandFailure(result),
          "保存公开状态失败",
        )
      }
    } finally {
      listedLock.current = false
      setListedBusy(false)
    }
  }

  const confirmDeleteDb = async () => {
    setDeleteDbBusy(true)
    const result = await store.deleteDb(db.sourceId)
    if (!active.current) return
    setDeleteDbBusy(false)
    if (result.ok) {
      notifySuccess(`已删除「${db.name || "未命名库"}」`)
      setDeleteDbOpen(false)
      if (active.current) onExit()
    } else {
      notifyCommandError(commandFailure(result), "删除平台货源失败")
    }
  }

  /**
   * 批量行写 — 后端没有批量端点，逐行串行调既有行级写（每行自带
   * withRowPending 置灰），一次 toast 汇总落/拦。归档/删除走完清选择：
   * 那些行已离开商品表，留着勾选只会误导下一次操作。
   */
  const runBulk = async (
    kind: "publish" | "unpublish" | "archive" | "delete",
  ) => {
    const ids = [...selectedIds]
    if (!ids.length) return
    setBulkBusy(kind)
    let ok = 0
    let refused = 0
    let firstReason: unknown
    try {
      for (const productId of ids) {
        if (!active.current) break
        const result =
          kind === "publish"
            ? await store.publishRow(db.sourceId, productId)
            : kind === "unpublish"
              ? await store.unpublishRow(db.sourceId, productId)
              : kind === "archive"
                ? await store.archiveRow(db.sourceId, productId)
                : await store.deleteRow(db.sourceId, productId)
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
        ? "上架"
        : kind === "unpublish"
          ? "下架"
          : kind === "archive"
            ? "归档"
            : "删除"
    if (refused === 0) {
      notifySuccess(`已${label} ${ok} 行`)
    } else {
      notifyError(
        ok > 0 ? `已${label} ${ok} 行，${refused} 行被拒` : `${refused} 行${label}失败`,
        {
          reason: firstReason,
          description:
            kind === "publish"
              ? "被拒的行缺上架前置（类目 / 提示词 / 固定 tags / 平台价），逐行进库页面补齐。"
              : kind === "delete"
                ? "被拒的行仍被上架记录或订单行引用——先下架，或改用归档。"
                : undefined,
        },
      )
    }
    if (kind === "archive" || kind === "delete") setSelectedIds(new Set())
  }

  return { db, selectedIds, setSelectedIds, listed, listedBusy, setListed, deleteDbOpen, setDeleteDbOpen, deleteDbBusy, confirmDeleteDb, bulkBusy, bulkConfirm, setBulkConfirm, runBulk }
}
type Actions = ReturnType<typeof useSupplierDbActions>

export function SupplierDbBulkBar({ actions }: { actions: Actions }) {
  const { selectedIds, bulkBusy, runBulk, setBulkConfirm, setSelectedIds } = actions
  if (selectedIds.size === 0) return null
  return (
    <div className="mx-4 mb-3 flex flex-wrap items-center gap-2 border-y border-border py-2" role="region" aria-label="批量操作" data-bulk-bar="" aria-busy={bulkBusy !== null}>
      <span className="text-compact font-medium">已选择 {selectedIds.size} 件</span>
      <Button variant="outline" size="sm" disabled={bulkBusy !== null} data-bulk-action="publish" onClick={() => void runBulk("publish")}>上架所选</Button>
      <Button variant="outline" size="sm" disabled={bulkBusy !== null} data-bulk-action="unpublish" onClick={() => void runBulk("unpublish")}>下架所选</Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="outline" size="sm" disabled={bulkBusy !== null} data-bulk-menu="" />}>
          更多操作<ChevronDown aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem data-bulk-action="archive" onClick={() => setBulkConfirm("archive")}>归档所选</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" data-bulk-action="delete" onClick={() => setBulkConfirm("delete")}>删除所选</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-bulk-action="clear" onClick={() => setSelectedIds(new Set())}>清除选择</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="sm" disabled={bulkBusy !== null} onClick={() => setSelectedIds(new Set())}>清除选择</Button>
    </div>
  )
}

export function SupplierDbConfirmations({ actions }: { actions: Actions }) {
  const { db, selectedIds, bulkConfirm, setBulkConfirm, bulkBusy, runBulk, deleteDbOpen, setDeleteDbOpen, deleteDbBusy, confirmDeleteDb } = actions
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

      <ConfirmDialog
        open={deleteDbOpen}
        onOpenChange={setDeleteDbOpen}
        title={`删除「${db.name || "未命名库"}」？`}
        description={
          db.rowCount > 0
            ? `库内还有 ${db.rowCount} 行，删除会被拒绝——请先清空或归档其中的行。删除后不可恢复。`
            : "删除后不可恢复；库内行、属性定义与供货成本一并移除。"
        }
        confirmText="删除库"
        busy={deleteDbBusy}
        onConfirm={confirmDeleteDb}
      />
  </>
}

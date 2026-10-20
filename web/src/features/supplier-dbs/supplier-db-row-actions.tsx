/** Row commands retain store CAS, copy config and sibling deletion behavior. */
import { useEffect, useRef, useState } from "react"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { missingFromRefusal } from "./supplier-readiness"
import type { SupplierDbsStore } from "./supplier-dbs-store"
import { commandFailure } from "./supplier-dbs-errors"

export function useSupplierDbRowActions({ store, sourceId, rows, openRowId, setOpenRowId, requestOpenRow }: {
  store: SupplierDbsStore
  sourceId: string
  rows: SupplierDbRow[]
  openRowId: string | null
  setOpenRowId: (id: string | null) => void
  requestOpenRow: (id: string) => void
}) {
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  const db = { sourceId }
  const [creating, setCreating] = useState(false)
  const [rowBusyId, setRowBusyId] = useState<string | null>(null)
  const [deleteRowId, setDeleteRowId] = useState<string | null>(null)
  const [deleteRowBusy, setDeleteRowBusy] = useState(false)
  const [archiveRowId, setArchiveRowId] = useState<string | null>(null)
  const [archiveRowBusy, setArchiveRowBusy] = useState(false)
  const deletingRow = rows.find((row) => row.productId === deleteRowId) ?? null
  const archivingRow = rows.find((row) => row.productId === archiveRowId) ?? null
  // 同款组内存活规格（含删除目标，按行序）— 规格删除后跳到相邻 tab
  // 而不是关掉面板；无同款兄弟时退回普通行删除的语义与文案。
  const deletingRowGroup = deletingRow?.variantGroup?.trim()
    ? rows.filter(
        (item) => !item.archived && item.variantGroup === deletingRow.variantGroup,
      )
    : []
  const deletingRowSiblings = deletingRowGroup.filter(
    (item) => item.productId !== deletingRow?.productId,
  )

  const toggleStatus = async (
    row: SupplierDbRow,
  ): Promise<{ ok: boolean; missing: string[]; reason?: unknown }> => {
    if (row.published) {
      const result = await store.unpublishRow(db.sourceId, row.productId)
      if (!active.current) return { ok: false, missing: [] }
      if (result.ok) {
        notifySuccess("已下架")
        return { ok: true, missing: [] }
      }
      notifyCommandError(commandFailure(result), "下架失败")
      return { ok: false, missing: [] }
    }
    const result = await store.publishRow(db.sourceId, row.productId)
    if (!active.current) return { ok: false, missing: [] }
    if (result.ok) {
      notifySuccess("已上架")
      return { ok: true, missing: [] }
    }
    const missing = missingFromRefusal(result.reason)
    if (!missing.length) {
      notifyCommandError(commandFailure(result), "上架失败")
    }
    return { ok: false, missing, reason: result.reason }
  }

  /** 行菜单的上下架入口 — 没有缺项弹层可挂，被拒时把缺项并进 toast。 */
  const toggleStatusFromMenu = async (row: SupplierDbRow) => {
    const result = await toggleStatus(row)
    if (!result.ok && result.missing.length) {
      notifyError(`还差 ${result.missing.join("、")} 才能上架`, {
        reason: result.reason,
        description: "在行页面补齐后重试。",
      })
    }
  }

  const duplicateRow = async (row: SupplierDbRow) => {
    setRowBusyId(row.productId)
    const result = await store.duplicateRow(db.sourceId, row.productId)
    if (!active.current) return
    setRowBusyId(null)
    if (!result.ok) {
      notifyCommandError(commandFailure(result), "复制行失败")
      return
    }
    const title = result.value.row.title || "未命名 副本"
    if (result.value.configCopyError === undefined) {
      notifySuccess(`已复制为「${title}」`)
    } else {
      // 行已建好，只是默认字段没跟过来：新行保留，提示去新行里重新配置。
      notifySuccess(`已复制为「${title}」，默认字段未复制`)
      notifyCommandError(result.value.configCopyError, "默认字段未复制，请在新行里重新配置")
    }
  }

  const newPage = async () => {
    setCreating(true)
    const result = await store.createRow(db.sourceId)
    if (!active.current) return
    setCreating(false)
    if (result.ok) {
      requestOpenRow(result.value.productId)
    } else {
      notifyCommandError(commandFailure(result), "新建行失败")
    }
  }

  const confirmDeleteRow = async () => {
    if (!deletingRow) return
    const groupIndex = deletingRowGroup.findIndex(
      (item) => item.productId === deletingRow.productId,
    )
    const nextRowId =
      deletingRowGroup[groupIndex + 1]?.productId ??
      deletingRowGroup[groupIndex - 1]?.productId ??
      null
    setDeleteRowBusy(true)
    const result = await store.deleteRow(db.sourceId, deletingRow.productId)
    if (!active.current) return
    setDeleteRowBusy(false)
    if (result.ok) {
      notifySuccess(
        deletingRowSiblings.length
          ? `规格「${deletingRow.size.trim() || "未填写"}」已删除`
          : "行已删除",
      )
      setDeleteRowId(null)
      if (openRowId === deletingRow.productId) setOpenRowId(nextRowId)
    } else {
      notifyCommandError(commandFailure(result), "删除行失败")
    }
  }

  const confirmArchiveRow = async () => {
    if (!archivingRow) return
    setArchiveRowBusy(true)
    const result = await store.archiveRow(db.sourceId, archivingRow.productId)
    if (!active.current) return
    setArchiveRowBusy(false)
    if (result.ok) {
      notifySuccess(`「${archivingRow.title || "未命名"}」已归档`)
      setArchiveRowId(null)
      if (openRowId === archivingRow.productId) setOpenRowId(null)
    } else {
      notifyCommandError(commandFailure(result), "归档行失败")
    }
  }

  return { creating, rowBusyId, deleteRowId, setDeleteRowId, archiveRowId, setArchiveRowId, deletingRow, archivingRow, deletingRowSiblings,
    deleteRowBusy, archiveRowBusy, toggleStatus, toggleStatusFromMenu, duplicateRow, newPage, confirmDeleteRow, confirmArchiveRow }
}

export function SupplierDbRowConfirmations({ actions }: { actions: ReturnType<typeof useSupplierDbRowActions> }) {
  const { deletingRow, archivingRow, deletingRowSiblings, deleteRowBusy, archiveRowBusy, setDeleteRowId, setArchiveRowId, confirmDeleteRow, confirmArchiveRow } = actions
  return <>
      <ConfirmDialog
        open={deletingRow !== null}
        onOpenChange={(open) => !open && setDeleteRowId(null)}
        title={
          deletingRowSiblings.length
            ? `删除规格「${deletingRow?.size.trim() || "未填写"}」？`
            : `删除「${deletingRow?.title || "未命名"}」？`
        }
        description={
          deletingRowSiblings.length
            ? `「${deletingRow?.title || "未命名"}」的这个规格连同其提示词、媒体与供货信息一并删除，其余规格保留。被上架记录或订单行引用的规格不能直接删除——请先停用；仍被引用时只能归档。删除后不可恢复。`
            : "被上架记录或订单行引用的行不能直接删除——请先下架；仍被引用时只能归档。删除后不可恢复。"
        }
        confirmText={deletingRowSiblings.length ? "删除规格" : "删除行"}
        busy={deleteRowBusy}
        onConfirm={confirmDeleteRow}
      />

      <ConfirmDialog
        open={archivingRow !== null}
        onOpenChange={(open) => !open && setArchiveRowId(null)}
        title={`归档「${archivingRow?.title || "未命名"}」？`}
        description="归档后该行离开商品表与画廊，数据保留。仍被引用的行只能归档不能删除。"
        confirmText="归档"
        busy={archiveRowBusy}
        onConfirm={confirmArchiveRow}
      />

  </>
}

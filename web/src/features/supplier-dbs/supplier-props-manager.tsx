/**
 * 自定义属性管理 — 「库设置 → 自定义属性」打开的弹窗。库页表格收敛为固定
 * 六列后，属性定义（增 / 改 / 删 / 排序）在这里闭环；行上的值仍按属性 id
 * 键存，改定义不掉值。编辑与新建复用 PropEditorDialog，删除过屏内
 * ConfirmDialog（服务端回 rowsWithValues 进提示文案）。
 */
import { useState } from "react"
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react"

import type {
  SupplierDbPropDef,
  SupplierDbRow,
} from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

import { PropEditorDialog, type PropEditorTarget } from "./supplier-prop-dialog"
import {
  SUPPLIER_PROP_TYPE_LABELS,
  SupplierPropIcon,
} from "./supplier-prop-icon"
import type { SupplierDbsStore } from "./supplier-dbs-store"
import { commandFailure } from "./supplier-dbs-errors"

/** 行上仍持有该属性值的数量 — 删除确认的提示依据。 */
function rowsWithValue(rows: readonly SupplierDbRow[], propId: string): number {
  return rows.filter(
    (row) =>
      row.props[propId] !== undefined &&
      row.props[propId] !== null &&
      row.props[propId] !== "",
  ).length
}

export function SupplierPropManagerDialog({
  store,
  sourceId,
  propDefs,
  rows,
  open,
  onOpenChange,
}: {
  store: SupplierDbsStore
  sourceId: string
  /** 已按 position 排序的定义表。 */
  propDefs: readonly SupplierDbPropDef[]
  rows: readonly SupplierDbRow[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [editor, setEditor] = useState<PropEditorTarget | null>(null)
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [moveBusy, setMoveBusy] = useState(false)

  const deletingProp = propDefs.find((def) => def.propId === deleteId) ?? null
  const deletingRowsWithValues = deletingProp
    ? rowsWithValue(rows, deletingProp.propId)
    : 0

  const move = async (def: SupplierDbPropDef, delta: -1 | 1) => {
    const index = propDefs.findIndex((item) => item.propId === def.propId)
    const target = index + delta
    if (index < 0 || target < 0 || target >= propDefs.length) return
    const order = propDefs.map((item) => item.propId)
    ;[order[index], order[target]] = [order[target]!, order[index]!]
    setMoveBusy(true)
    const result = await store.reorderProps(sourceId, order)
    setMoveBusy(false)
    if (!result.ok) {
      notifyCommandError(
        commandFailure(result),
        "调整属性顺序失败",
      )
    }
  }

  const confirmDelete = async () => {
    if (!deletingProp) return
    setDeleteBusy(true)
    const result = await store.deleteProp(sourceId, deletingProp.propId)
    setDeleteBusy(false)
    if (result.ok) {
      notifySuccess(
        result.value.rowsWithValues > 0
          ? `已删除「${deletingProp.name}」；${result.value.rowsWithValues} 行仍存有其值（不再展示）`
          : `已删除「${deletingProp.name}」`,
      )
      setDeleteId(null)
    } else {
      notifyCommandError(commandFailure(result), "删除属性失败")
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>自定义属性</DialogTitle>
            <DialogDescription>
              属性定义按此顺序出现在行页面；行上的值按属性 id 键存，改名不掉值。
            </DialogDescription>
          </DialogHeader>
          <ul
            data-supplier-props=""
            className="flex max-h-72 flex-col divide-y divide-border overflow-y-auto overscroll-contain rounded-lg border border-border"
          >
            {propDefs.map((def, index) => (
              <li
                key={def.propId}
                data-supplier-prop={def.propId}
                className="flex items-center gap-2.5 px-3 py-2"
              >
                <SupplierPropIcon
                  type={def.type}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1 truncate text-compact font-medium">
                  {def.name}
                </span>
                <span className="shrink-0 text-meta text-muted-foreground">
                  {SUPPLIER_PROP_TYPE_LABELS[def.type]}
                  {def.options.length > 0 ? ` · ${def.options.length} 选项` : ""}
                </span>
                {!def.sellerVisible ? (
                  <Badge variant="outline">内部</Badge>
                ) : null}
                <span className="flex shrink-0 items-center">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`上移 ${def.name}`}
                    disabled={moveBusy || index === 0}
                    className="cursor-pointer"
                    onClick={() => void move(def, -1)}
                  >
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`下移 ${def.name}`}
                    disabled={moveBusy || index === propDefs.length - 1}
                    className="cursor-pointer"
                    onClick={() => void move(def, 1)}
                  >
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`编辑 ${def.name}`}
                    className="cursor-pointer"
                    onClick={() => setEditor({ mode: "edit", def })}
                  >
                    <Pencil aria-hidden />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`删除 ${def.name}`}
                    className="cursor-pointer"
                    onClick={() => setDeleteId(def.propId)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              </li>
            ))}
            {propDefs.length === 0 ? (
              <li className="px-3 py-6 text-center text-compact text-faint-foreground">
                还没有自定义属性——添一条就会在行页面出现
              </li>
            ) : null}
          </ul>
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="cursor-pointer"
              onClick={() => setEditor({ mode: "create" })}
            >
              <Plus aria-hidden />
              添加属性
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <PropEditorDialog
        store={store}
        sourceId={sourceId}
        target={editor}
        onClose={() => setEditor(null)}
      />

      <ConfirmDialog
        open={deletingProp !== null}
        onOpenChange={(next) => !next && setDeleteId(null)}
        title={`删除属性「${deletingProp?.name || ""}」？`}
        description={
          deletingRowsWithValues > 0
            ? `${deletingRowsWithValues} 行已有值，删除后这些行的该属性值一并移除，不可恢复。`
            : "删除后该属性从行页面移除，不可恢复。"
        }
        confirmText="删除属性"
        busy={deleteBusy}
        onConfirm={confirmDelete}
      />
    </>
  )
}

/** 供应商商品详情：右侧非模态抽屉，沿用行 CAS 与平台配置保存路径。 */
import { useCallback, useRef, useState } from "react"
import {
  Archive,
  ChevronLeft,
  ChevronRight,
  Copy,
  Ellipsis,
  Trash2,
  X,
} from "lucide-react"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type {
  SupplierDbPropDef,
  SupplierDbRow,
  UpsertSupplierDbPropRequest,
} from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { warmCategorySchemaOnce } from "@/features/category-schema/schema-sync"

import { PropEditorDialog } from "./supplier-prop-dialog"
import { commandFailure } from "./supplier-dbs-errors"
import { missingReadiness } from "./supplier-readiness"
import { SupplierRowBody } from "./supplier-row-body"
import type { SupplierDbsStore } from "./supplier-dbs-store"
import type { Patch } from "./supplier-row-fields"

export function SupplierRowPanel({
  store,
  sourceId,
  row,
  rows = [],
  onSelectRow,
  previousRowId,
  nextRowId,
  position,
  total,
  propDefs,
  categoryTree = [],
  categoryLoading,
  onEnsureCategoryTree,
  pending = false,
  onClose,
  onDuplicate,
  onArchive,
  onDelete,
  onDirtyChange,
}: {
  store: SupplierDbsStore
  sourceId: string
  row: SupplierDbRow
  rows?: readonly SupplierDbRow[]
  onSelectRow?: (productId: string) => void
  previousRowId?: string
  nextRowId?: string
  position?: number
  total?: number
  propDefs: SupplierDbPropDef[]
  categoryTree?: CategoryTreeNodeView[]
  categoryLoading?: boolean
  /** 类目选择器空树开弹时补拉共享类目缓存（宿主接 GET /api/catalog/tree）。 */
  onEnsureCategoryTree?: () => Promise<boolean>
  /** 行写在途 — 面板置灰，与表格行同步。 */
  pending?: boolean
  onClose: () => void
  /** 行 ⋯ 菜单动作——复制/归档/删除由库页提供（确认对话框在库页）。 */
  onDuplicate?: () => void
  onArchive?: () => void
  onDelete?: () => void
  onDirtyChange?: (dirty: boolean) => void
}) {
  const [addPropOpen, setAddPropOpen] = useState(false)
  const closeRef = useRef<HTMLButtonElement>(null)

  const [promptDirty, setPromptDirty] = useState(false)
  const reportDirty = useCallback((dirty: boolean) => {
    setPromptDirty(dirty)
    onDirtyChange?.(dirty)
  }, [onDirtyChange])
  const [discardAction, setDiscardAction] = useState<(() => void) | null>(null)
  const requestAction = (action: () => void) => {
    if (promptDirty) setDiscardAction(() => action)
    else action()
  }

  const patchRow = async (patch: Patch): Promise<boolean> => {
    const result = await store.patchCell(sourceId, row.productId, patch)
    if (!result.ok) {
      notifyCommandError(commandFailure(result), "保存行失败")
      return false
    }
    // 类目落盘即暖一次 schema 缓存——冷坐标借工作区店铺密钥自动同步。
    warmCategorySchemaOnce(patch)
    return true
  }

  const updateProp = async (
    def: SupplierDbPropDef,
    patch: Partial<UpsertSupplierDbPropRequest>,
  ): Promise<boolean> => {
    const result = await store.updateProp(sourceId, def.propId, {
      name: def.name,
      type: def.type,
      options: def.options,
      position: def.position,
      sellerVisible: def.sellerVisible,
      ...patch,
    })
    if (!result.ok) {
      notifyCommandError(commandFailure(result), "保存属性失败")
      return false
    }
    return true
  }

  const togglePublish = async () => {
    if (pending) return
    if (!row.published) {
      const missing = missingReadiness(row)
      if (missing.length) {
        notifyError(`还差 ${missing.join("、")} 才能上架`)
        return
      }
      const result = await store.publishRow(sourceId, row.productId)
      if (result.ok) notifySuccess("已上架")
      else notifyCommandError(commandFailure(result), "上架失败")
    } else {
      const result = await store.unpublishRow(sourceId, row.productId)
      if (result.ok) notifySuccess("已下架")
      else notifyCommandError(commandFailure(result), "下架失败")
    }
  }

  const hasRowMenu = onDuplicate || onArchive || onDelete

  return (
    <>
      <Sheet open modal={false} disablePointerDismissal onOpenChange={(open) => { if (!open) requestAction(onClose) }}>
      <SheetContent size="detail" showOverlay={false} showCloseButton={false} initialFocus={closeRef} finalFocus={false}
        aria-label={`商品详情 ${row.title.trim() || "未命名"}`}
        aria-busy={pending || undefined}
        data-supplier-row-panel=""
      >
        {/* 窄屏导航保留图标和可访问名称，避免标题与位置换行。 */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
          <SheetTitle>商品详情</SheetTitle>
          {onSelectRow && total !== undefined ? <div className="ml-auto flex items-center gap-1" aria-label="商品导航">
            <Button type="button" variant="ghost" size="sm" aria-label="上一件" disabled={!previousRowId} title={previousRowId ? "上一件商品" : "已经是第一件"} onClick={() => previousRowId && requestAction(() => onSelectRow(previousRowId))}><ChevronLeft aria-hidden /><span className="hidden sm:inline">上一件</span></Button>
            <span className="whitespace-nowrap font-mono text-meta text-muted-foreground tabular-nums">{position} / {total}</span>
            <Button type="button" variant="ghost" size="sm" aria-label="下一件" disabled={!nextRowId} title={nextRowId ? "下一件商品" : "已经是最后一件"} onClick={() => nextRowId && requestAction(() => onSelectRow(nextRowId))}><span className="hidden sm:inline">下一件</span><ChevronRight aria-hidden /></Button>
          </div> : null}
          {hasRowMenu ? (
            <RowMenu
              title={row.title.trim() || "未命名"}
              onDuplicate={onDuplicate ? () => requestAction(onDuplicate) : undefined}
              onArchive={onArchive ? () => requestAction(onArchive) : undefined}
              onDelete={onDelete ? () => requestAction(onDelete) : undefined}
            />
          ) : null}
          <Button
            ref={closeRef}
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="关闭行详情"
            className="ml-auto cursor-pointer"
            onClick={() => requestAction(onClose)}
          >
            <X aria-hidden />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          <SupplierRowBody
            key={row.productId}
            row={row}
            onDirtyChange={reportDirty}
            rows={rows}
            onSelectRow={(productId) => { if(productId !== row.productId) requestAction(() => { setPromptDirty(false); onSelectRow?.(productId) }) }}
            onCreateVariant={async (size) => {
              if (promptDirty) { notifyError("请先保存当前规格的提示词草稿，再新增规格"); return false }
              const variantGroup = row.variantGroup?.trim() || row.productId
              if (!row.variantGroup?.trim() && !(await patchRow({ variantGroup }))) return false
              const result = await store.createRow(sourceId, {
                title: row.title,
                size,
                variantGroup,
                descriptionCategoryId: row.descriptionCategoryId,
                typeId: row.typeId,
              })
              if (!result.ok) {
                notifyCommandError(commandFailure(result), "新增规格失败")
                return false
              }
              onSelectRow?.(result.value.productId)
              return true
            }}
            onDeleteVariant={onDelete ? () => requestAction(onDelete) : undefined}
            propDefs={propDefs}
            categoryTree={categoryTree}
            categoryLoading={categoryLoading}
            onEnsureCategoryTree={onEnsureCategoryTree}
            onPatch={patchRow}
            onPromptPublished={() => { void store.loadDetail(sourceId, { force: true }) }}
            onUpdateProp={updateProp}
            onAddProp={() => setAddPropOpen(true)}
            onTogglePublish={togglePublish}
            onAdjustPrice={async (priceCents, note) => {
              const result = await store.adjustPrice(
                sourceId,
                row.productId,
                priceCents,
                note,
              )
              if (result.ok) {
                notifySuccess("平台价已写入新版本")
                return true
              }
              notifyCommandError(
                commandFailure(result),
                "调价失败",
              )
              return false
            }}
          />
        </div>

        <PropEditorDialog
          store={store}
          sourceId={sourceId}
          target={addPropOpen ? { mode: "create" } : null}
          onClose={() => setAddPropOpen(false)}
        />
        <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-5 py-3">
          <span className="text-meta text-muted-foreground">{promptDirty ? "提示词草稿待保存" : pending ? "正在保存…" : "字段失焦保存 · 提示词单独保存"}</span>
          <Button variant="outline" size="sm" onClick={() => requestAction(onClose)}>完成</Button>
        </div>
      </SheetContent>
      </Sheet>
      <ConfirmDialog open={discardAction !== null} onOpenChange={(open) => { if(!open) setDiscardAction(null) }}
        title="提示词尚未保存" description="离开会丢弃当前规格未保存的提示词草稿。" confirmText="丢弃草稿并离开"
        onConfirm={() => { const action = discardAction; setDiscardAction(null); reportDirty(false); action?.() }}
      />
    </>
  )
}

function RowMenu({
  title,
  onDuplicate,
  onArchive,
  onDelete,
}: {
  title: string
  onDuplicate?: () => void
  onArchive?: () => void
  onDelete?: () => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`行操作 ${title}`}
            className="cursor-pointer"
          />
        }
      >
        <Ellipsis aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onDuplicate ? (
          <DropdownMenuItem
            className="cursor-pointer"
            data-row-menu="复制行"
            onClick={onDuplicate}
          >
            <Copy aria-hidden />
            复制行
          </DropdownMenuItem>
        ) : null}
        {onArchive ? (
          <DropdownMenuItem
            className="cursor-pointer"
            data-row-menu="归档"
            onClick={onArchive}
          >
            <Archive aria-hidden />
            归档
          </DropdownMenuItem>
        ) : null}
        {onDelete ? (
          <DropdownMenuItem
            variant="destructive"
            className="cursor-pointer"
            data-row-menu="删除"
            onClick={onDelete}
          >
            <Trash2 aria-hidden />
            删除
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

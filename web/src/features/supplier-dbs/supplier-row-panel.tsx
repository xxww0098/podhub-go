import { useCallback, useRef, useState } from "react"
import { Archive, Ellipsis, Trash2 } from "lucide-react"
import { useTrailSegment } from "@/app/app-shell"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbPropDef, SupplierDbRow, UpsertSupplierDbPropRequest } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { warmCategorySchemaOnce } from "@/features/category-schema/schema-sync"
import { PropEditorDialog } from "./supplier-prop-dialog"
import { commandFailure } from "./supplier-dbs-errors"
import { SupplierRowBody, type SupplierRowTab } from "./supplier-row-body"
import type { SupplierDbsStore } from "./supplier-dbs-store"
import type { Patch } from "./supplier-row-fields"

export function SupplierRowPanel({ store, sourceId, row, rows = [], onSelectRow, propDefs, categoryTree = [], categoryLoading, onEnsureCategoryTree, pending = false, onClose, onArchive, onDelete, onDirtyChange, mode = "product", initialTab = "info", canAdjustPrice = false, onAddVariant }: {
  store: SupplierDbsStore
  sourceId: string
  row: SupplierDbRow
  rows?: readonly SupplierDbRow[]
  onSelectRow?: (productId: string, tab?: SupplierRowTab) => void
  propDefs: SupplierDbPropDef[]
  categoryTree?: CategoryTreeNodeView[]
  categoryLoading?: boolean
  onEnsureCategoryTree?: () => Promise<boolean>
  pending?: boolean
  onClose: () => void
  onArchive?: () => void
  onDelete?: () => void
  onDirtyChange?: (dirty: boolean) => void
  mode?: "product" | "variant"
  initialTab?: SupplierRowTab
  canAdjustPrice?: boolean
  onAddVariant?: () => void
}) {
  const [addPropOpen, setAddPropOpen] = useState(false)
  const [promptDirty, setPromptDirty] = useState(false)
  const [discardAction, setDiscardAction] = useState<(() => void | Promise<void>) | null>(null)
  const [saving, setSaving] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const invalidInfo = () => panelRef.current?.querySelector<HTMLElement>('[data-supplier-row-info-tab] [aria-invalid="true"]')
  const platformFlushRef = useRef<((validate?: boolean) => Promise<boolean>) | null>(null)
  const aiFlushRef = useRef<(() => Promise<boolean>) | null>(null)
  const sharedDirty = useRef(false)
  const group = rows.filter((item) => !item.archived && item.sourceId === row.sourceId && (item.productId === row.productId || Boolean(row.variantGroup?.trim()) && item.variantGroup?.trim() === row.variantGroup?.trim()))
  const sharedRow = group[0] ?? row
  const reportDirty = useCallback((dirty: boolean) => { setPromptDirty(dirty); onDirtyChange?.(dirty) }, [onDirtyChange])
  const syncShared = async (validate = false) => {
    if (mode === "variant") {
      // Ozon 配置保存会推进行版本，后续写入先回读。
      await store.loadDetail(sourceId, { force: true })
      const detail = store.getState().details[sourceId]
      if (detail?.status !== "ready") { notifyCommandError(detail?.reason, "无法更新规格资料，请重试"); return false }
      return true
    }
    if (!sharedDirty.current) return true
    const result = await store.syncProductOzon(sourceId, sharedRow.productId, validate)
    if (!result.ok) { notifyCommandError(commandFailure(result), "Ozon 字段未全部同步，请重试"); return false }
    sharedDirty.current = false
    return true
  }
  const saveShared = async () => {
    if (platformFlushRef.current && !await platformFlushRef.current()) return false
    return syncShared()
  }
  const requestAction = async (action: () => void | Promise<void>) => {
    if (promptDirty || invalidInfo()) { setDiscardAction(() => action); return }
    if (await saveShared()) await action()
  }
  // 详情标题只放在壳层面包屑里；返回也走面包屑模块段，离开前仍走未保存拦截。
  const trailLabel = mode === "variant"
    ? row.size || row.title || "新增规格"
    : row.title || row.size || "新增商品"
  const exitRef = useRef<() => void>(() => {})
  exitRef.current = () => { if (!saving) void requestAction(onClose) }
  const exitToLibrary = useCallback(() => exitRef.current(), [])
  useTrailSegment(trailLabel, exitToLibrary)
  const saveAndExit = async () => {
    if (saving) return
    const invalid = invalidInfo()
    if (invalid) { invalid.focus(); notifyError("商品信息尚未保存，请重试标红字段"); return }
    setSaving(true)
    try {
      if (aiFlushRef.current && !await aiFlushRef.current()) return
      if (!await saveShared()) return
      reportDirty(false)
      onClose()
    } finally { setSaving(false) }
  }
  const patchRow = async (patch: Patch) => {
    if (("descriptionCategoryId" in patch || "typeId" in patch) && !await saveShared()) return false
    const result = await store.patchCell(sourceId, row.productId, patch)
    if (!result.ok) { notifyCommandError(commandFailure(result), "保存商品信息失败"); return false }
    return true
  }
  return <div ref={panelRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-row-panel="" aria-label={`商品详情 ${row.title || "未命名"}`} aria-busy={pending || saving || undefined}>
    <SupplierRowBody row={row} rows={rows} sharedRow={sharedRow} mode={mode} initialTab={initialTab} pending={pending || saving} canAdjustPrice={canAdjustPrice}
      status={row.published
        ? <Badge variant="good" className="shrink-0">已发布</Badge>
        : <span className="inline-flex shrink-0 items-center gap-1.5 text-compact text-muted-foreground"><span aria-hidden className="size-1.5 rounded-full bg-border-strong" />草稿</span>}
      trailing={<RowMenu title={row.title || "未命名"} onArchive={onArchive ? () => void requestAction(onArchive) : undefined} onDelete={onDelete ? () => void requestAction(onDelete) : undefined} />}
      platformFlushRef={platformFlushRef} aiFlushRef={aiFlushRef} onDirtyChange={reportDirty} onExit={() => void saveAndExit()}
      onSelectRow={(productId, tab) => void requestAction(() => onSelectRow?.(productId, tab))}
      onAddVariant={onAddVariant ? () => void requestAction(onAddVariant) : undefined}
      propDefs={propDefs} categoryTree={categoryTree} categoryLoading={categoryLoading} onEnsureCategoryTree={onEnsureCategoryTree} onPatch={patchRow}
      onSharedConfigSaved={() => { sharedDirty.current = true; onDirtyChange?.(true) }} onSyncShared={async (validate) => { const saved = await syncShared(validate); if (saved) onDirtyChange?.(promptDirty); return saved }}
      onPatchShared={async (patch) => {
        for (const item of group.length ? group : [row]) {
          const result = await store.patchCell(sourceId, item.productId, patch)
          if (!result.ok) { notifyCommandError(commandFailure(result), "类目未全部应用到规格，请重试"); return false }
        }
        warmCategorySchemaOnce(patch)
        return true
      }}
      onAddProp={() => setAddPropOpen(true)}
      onUpdateProp={async (def, patch: Partial<UpsertSupplierDbPropRequest>) => {
        const result = await store.updateProp(sourceId, def.propId, { name: def.name, type: def.type, options: def.options, position: def.position, sellerVisible: def.sellerVisible, ...patch })
        if (!result.ok) notifyCommandError(commandFailure(result), "保存属性失败")
        return result.ok
      }}
      onAdjustPrice={async (priceCents, note) => {
        if (!canAdjustPrice) return false
        const result = await store.adjustPrice(sourceId, row.productId, priceCents, note)
        if (!result.ok) notifyCommandError(commandFailure(result), "调价失败")
        else notifySuccess("平台供货价已保存")
        return result.ok
      }}
    />
    <PropEditorDialog store={store} sourceId={sourceId} target={addPropOpen ? { mode: "create", position: propDefs.length } : null} onClose={() => setAddPropOpen(false)} />
    <ConfirmDialog open={discardAction !== null} onOpenChange={(open) => { if (!open) setDiscardAction(null) }} title="配置尚未保存" description="离开会丢弃尚未保存的商品信息或 AI 识图配置。" confirmText="放弃修改并离开" onConfirm={async () => {
      const action = discardAction; setDiscardAction(null)
      if (!await saveShared()) return
      reportDirty(false); await action?.()
    }} />
  </div>
}

function RowMenu({
  title,
  onArchive,
  onDelete,
}: {
  title: string
  onArchive?: () => void
  onDelete?: () => void
}) {
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger
          render={
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`规格操作 ${title}`}
                />
              }
            />
          }
        >
          <Ellipsis aria-hidden />
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>规格操作</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
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

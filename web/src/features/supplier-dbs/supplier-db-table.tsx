/** Library products controller: filters, commands and the nonmodal row editor. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbDetail } from "@/bindings/http-supplier-dbs"
import { useScreenActive } from "@/components/screen-pane"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { loadCategoryTree as loadSharedCategoryTree } from "@/features/category-schema/category-tree-load"
import { readCategoryTreeCache, writeCategoryTreeCache } from "@/features/category-schema/category-tree-cache"
import { SupplierPropManagerDialog } from "./supplier-props-manager"
import { SupplierRowPanel } from "./supplier-row-panel"
import { useSupplierDbsStore, type SupplierDbsStore } from "./supplier-dbs-store"
import { SupplierDbFilterBar, SupplierDbPagination, useSupplierDbFilters } from "./supplier-db-filters"
import { SupplierDbProductsTable } from "./supplier-db-products-table"
import { SupplierDbHeader, SupplierDbStats } from "./supplier-db-header"
import { useSupplierDbRowActions, SupplierDbRowConfirmations } from "./supplier-db-row-actions"
import { useSupplierDbActions, SupplierDbBulkBar, SupplierDbConfirmations } from "./supplier-db-actions"

const defaultLoadCategoryTree = () => loadSharedCategoryTree()
export function SupplierDbDetailView({ store, detail, onExit, onEditDb, onOpenAccounts, showCreator = false, onDirtyChange, loadCategoryTree = defaultLoadCategoryTree }: {
  store: SupplierDbsStore
  detail: SupplierDbDetail
  onExit: () => void
  onEditDb: () => void
  onOpenAccounts: () => void
  showCreator?: boolean
  onDirtyChange?: (dirty: boolean) => void
  loadCategoryTree?: () => Promise<CategoryTreeNodeView[]>
}) {
  const { db, propDefs, rows } = detail
  const storeState = useSupplierDbsStore(store)
  const screenActive = useScreenActive()
  const pendingSet = useMemo(() => new Set(storeState.pendingRows), [storeState.pendingRows])
  const sortedPropDefs = useMemo(() => [...propDefs].sort((a, b) => a.position - b.position), [propDefs])
  const [categoryTree, setCategoryTree] = useState<CategoryTreeNodeView[]>(() => readCategoryTreeCache() ?? [])
  const [categoryLoading, setCategoryLoading] = useState(false)
  const [propsManagerOpen, setPropsManagerOpen] = useState(false)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [openRowId, setOpenRowId] = useState<string | null>(null)
  const [promptDirty, setPromptDirty] = useState(false)
  const [requestedRowId, setRequestedRowId] = useState<string | null>(null)
  const requestOpenRow = (productId: string) => {
    if (productId !== openRowId && promptDirty) setRequestedRowId(productId)
    else setOpenRowId(productId)
  }
  useEffect(() => { setPromptDirty(false) }, [openRowId])
  useEffect(() => { onDirtyChange?.(promptDirty) }, [promptDirty, onDirtyChange])
  // 类目树回答「类目」列标签与筛选选项 — best-effort，有缓存就不抢网络；
  // 行面板选择器开弹经同一回调直调共享缓存（GET /api/catalog/tree），不留死面板。
  const categoryInFlight = useRef(false)
  const ensureCategoryTree = useCallback(async (): Promise<boolean> => {
    if (categoryInFlight.current) return true
    categoryInFlight.current = true
    setCategoryLoading(true)
    try {
      const tree = await loadCategoryTree()
      if (tree.length === 0) return false
      setCategoryTree(tree)
      writeCategoryTreeCache(tree)
      return true
    } catch {
      return false
    } finally {
      categoryInFlight.current = false
      setCategoryLoading(false)
    }
  }, [loadCategoryTree])

  useEffect(() => {
    if (categoryTree.length > 0 || !screenActive) return
    void ensureCategoryTree()
  }, [screenActive, categoryTree.length, ensureCategoryTree])

  const filters = useSupplierDbFilters(rows, categoryTree)
  const { pageRows, liveRows, filteredRows, searchRef } = filters
  // Selection never carries hidden rows into a bulk action after filtering or paging.
  useEffect(() => { setSelectedIds(new Set()) }, [filters.query, filters.statusFilter, filters.publishFilter, filters.categoryFilter, filters.page, filters.pageSize])
  useEffect(() => {
    const visible = new Set(pageRows.map((row) => row.productId))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [pageRows])
  const toggleSelectRow = (productId: string, checked: boolean) => setSelectedIds((current) => {
    const next = new Set(current)
    if (checked) next.add(productId)
    else next.delete(productId)
    return next
  })
  const toggleSelectAll = (checked: boolean) => setSelectedIds(checked ? new Set(pageRows.map((row) => row.productId)) : new Set())
  const actions = useSupplierDbActions({ db, store, selectedIds, setSelectedIds, onExit })
  const rowActions = useSupplierDbRowActions({ store, sourceId: db.sourceId, rows, openRowId, setOpenRowId, requestOpenRow })
  const openRow = liveRows.find((row) => row.productId === openRowId) ?? null
  const navigationRows = filteredRows.some((row) => row.productId === openRowId) ? filteredRows : liveRows
  const rowIndex = navigationRows.findIndex((row) => row.productId === openRowId)
  const previousRowId = navigationRows[rowIndex - 1]?.productId
  const nextRowId = navigationRows[rowIndex + 1]?.productId
  const closeSheet = () => {
    const closingId = openRowId
    setOpenRowId(null)
    // 关面板后焦点回到当前商品的编辑入口。
    const trigger =
      (closingId
        ? document.querySelector<HTMLElement>(
            `[data-supplier-db-open="${closingId}"]`,
          )
        : null)
    if (trigger) requestAnimationFrame(() => trigger.focus())
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-dbs="detail" onKeyDown={(event) => {
      const target = event.target as HTMLElement
      const typing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable
      if (event.key === "/" && !typing) { event.preventDefault(); searchRef.current?.focus() }
    }}>
      <SupplierDbHeader db={db} listed={actions.listed} listedBusy={actions.listedBusy} setListed={actions.setListed}
        showCreator={showCreator} onEditDb={onEditDb} onOpenAccounts={onOpenAccounts} onOpenProps={() => setPropsManagerOpen(true)} onDeleteDb={() => actions.setDeleteDbOpen(true)} />
      <SupplierDbStats counts={filters.statCounts} activeStat={filters.activeStat} applyStat={filters.applyStat} creating={rowActions.creating} newPage={rowActions.newPage} />
      <SupplierDbFilterBar filters={filters} />
      <SupplierDbBulkBar actions={actions} />
      <div className="relative mx-4 mb-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
        <SupplierDbProductsTable db={db} pageRows={pageRows} liveRows={liveRows} categoryTree={categoryTree} pendingSet={pendingSet} openRowId={openRowId} selectedIds={selectedIds}
          rowBusyId={rowActions.rowBusyId} showCreator={showCreator} toggleSelectAll={toggleSelectAll} toggleSelectRow={toggleSelectRow} onOpen={requestOpenRow}
          toggleStatus={rowActions.toggleStatus} onToggleFromMenu={rowActions.toggleStatusFromMenu} onDuplicate={rowActions.duplicateRow} onArchive={rowActions.setArchiveRowId} onDelete={rowActions.setDeleteRowId} />
        <SupplierDbPagination filters={filters} />
      </div>
      {openRow ? <SupplierRowPanel key={openRow.productId} onDirtyChange={setPromptDirty} store={store} sourceId={db.sourceId} row={openRow} rows={rows}
        onSelectRow={setOpenRowId} previousRowId={previousRowId} nextRowId={nextRowId} position={rowIndex + 1} total={navigationRows.length}
        propDefs={sortedPropDefs} categoryTree={categoryTree} categoryLoading={categoryLoading} onEnsureCategoryTree={ensureCategoryTree} pending={pendingSet.has(openRow.productId)}
        onClose={closeSheet} onDuplicate={() => void rowActions.duplicateRow(openRow)} onArchive={() => rowActions.setArchiveRowId(openRow.productId)} onDelete={() => rowActions.setDeleteRowId(openRow.productId)} /> : null}
      <ConfirmDialog open={requestedRowId !== null} onOpenChange={(open) => { if (!open) setRequestedRowId(null) }} title="提示词尚未保存"
        description="切换商品会丢弃当前规格未保存的提示词草稿。" confirmText="丢弃草稿并切换" onConfirm={() => { setOpenRowId(requestedRowId); setRequestedRowId(null) }} />
      <SupplierPropManagerDialog store={store} sourceId={db.sourceId} propDefs={sortedPropDefs} rows={rows} open={propsManagerOpen} onOpenChange={setPropsManagerOpen} />
      <SupplierDbRowConfirmations actions={rowActions} />
      <SupplierDbConfirmations actions={actions} />
    </div>
  )
}

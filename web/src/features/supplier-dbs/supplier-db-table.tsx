import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Plus, RotateCcw } from "lucide-react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDb, SupplierDbDetail } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useScreenActive } from "@/components/screen-pane"
import { loadCategoryTree as loadSharedCategoryTree } from "@/features/category-schema/category-tree-load"
import { readCategoryTreeCache, writeCategoryTreeCache } from "@/features/category-schema/category-tree-cache"
import { notifyCommandError } from "@/lib/notify"
import { SupplierRowPanel } from "./supplier-row-panel"
import type { SupplierRowTab } from "./supplier-row-body"
import { SupplierVariantCreate } from "./supplier-variant-create"
import { useSupplierDbsStore, type SupplierDbsStore } from "./supplier-dbs-store"
import { SupplierDbProductsTable } from "./supplier-db-products-table"
import { SupplierDbFilterBar, SupplierDbPagination, useSupplierDbFilters } from "./supplier-db-filters"
import { SupplierDbStats } from "./supplier-db-header"
import { useSupplierDbRowActions, SupplierDbRowConfirmations } from "./supplier-db-row-actions"
import { useSupplierDbActions, SupplierDbBulkBar, SupplierDbConfirmations } from "./supplier-db-actions"

const defaultLoadCategoryTree = () => loadSharedCategoryTree()
export function SupplierProductsView({ store, dbs, details, onManageFactories, showCreator = false, loading = false, failedFactories = [], onRetry, loadCategoryTree = defaultLoadCategoryTree }: {
  store: SupplierDbsStore
  dbs: SupplierDb[]
  details: SupplierDbDetail[]
  onManageFactories: () => void
  showCreator?: boolean
  loading?: boolean
  failedFactories?: SupplierDb[]
  onRetry?: () => void
  loadCategoryTree?: () => Promise<CategoryTreeNodeView[]>
}) {
  const state = useSupplierDbsStore(store)
  const screenActive = useScreenActive()
  const pendingSet = useMemo(() => new Set(state.pendingRows), [state.pendingRows])
  const [factoryId, setFactoryId] = useState("all")
  const [newFactoryId, setNewFactoryId] = useState<string | null>(null)
  const [newSpecName, setNewSpecName] = useState("")
  const [openRowId, setOpenRowId] = useState<string | null>(null)
  const [editorMode, setEditorMode] = useState<"product" | "variant">("product")
  const [initialTab, setInitialTab] = useState<SupplierRowTab>("info")
  const [variantParentId, setVariantParentId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const [categoryTree, setCategoryTree] = useState<CategoryTreeNodeView[]>(() => readCategoryTreeCache() ?? [])
  const [categoryLoading, setCategoryLoading] = useState(false)
  const categoryInFlight = useRef(false)
  const ensureCategoryTree = useCallback(async (): Promise<boolean> => {
    if (categoryInFlight.current) return true
    categoryInFlight.current = true
    setCategoryLoading(true)
    try {
      const tree = await loadCategoryTree()
      if (!tree.length) return false
      setCategoryTree(tree); writeCategoryTreeCache(tree)
      return true
    } catch { return false }
    finally { categoryInFlight.current = false; setCategoryLoading(false) }
  }, [loadCategoryTree])
  useEffect(() => { if (!categoryTree.length && screenActive) void ensureCategoryTree() }, [screenActive, categoryTree.length, ensureCategoryTree])

  const currentFactory = dbs.some((db) => db.sourceId === factoryId) ? factoryId : "all"
  const allRows = useMemo(() => details.flatMap((detail) => detail.rows), [details])
  const rows = useMemo(() => currentFactory === "all" ? allRows : allRows.filter((row) => row.sourceId === currentFactory), [allRows, currentFactory])
  const filters = useSupplierDbFilters(rows, categoryTree)
  const { pageRows, liveRows, searchRef } = filters
  useEffect(() => { setSelectedIds(new Set()) }, [currentFactory, filters.query, filters.statusFilter, filters.publishFilter, filters.categoryFilter, filters.page, filters.pageSize])
  useEffect(() => {
    const visible = new Set(pageRows.map((row) => row.productId))
    setSelectedIds((current) => {
      const next = new Set([...current].filter((id) => visible.has(id)))
      return next.size === current.size ? current : next
    })
  }, [pageRows])
  const toggleSelectRow = (productId: string, checked: boolean) => setSelectedIds((current) => {
    const next = new Set(current)
    if (checked) next.add(productId); else next.delete(productId)
    return next
  })
  const actions = useSupplierDbActions({ rows: allRows, store, selectedIds, setSelectedIds, canPublish: showCreator })
  const rowActions = useSupplierDbRowActions({ store, rows: allRows, openRowId, setOpenRowId, requestOpenRow: setOpenRowId, canPublish: showCreator })
  const openRow = allRows.find((row) => row.productId === openRowId && !row.archived)
  const rowDetail = details.find((detail) => detail.db.sourceId === openRow?.sourceId)
  const variantParent = allRows.find((row) => row.productId === variantParentId && !row.archived)
  const openProduct = (productId: string, tab?: "defaults") => { setEditorMode("product"); setInitialTab(tab ?? "info"); setOpenRowId(productId) }
  const closeEditor = () => {
    const productId = openRowId
    setOpenRowId(null)
    if (productId) requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-supplier-db-open="${productId}"]`)?.focus())
  }
  const addVariant = (productId: string) => setVariantParentId(productId)
  const factoryItems = dbs.map((db) => ({ value: db.sourceId, label: db.name || "未命名商品库" }))
  const filterItems = [{ value: "all", label: "全部商品库" }, ...factoryItems]
  const openNewProduct = () => {
    setNewSpecName("")
    setNewFactoryId(currentFactory === "all" ? "" : currentFactory)
  }

  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-products="" onKeyDown={(event) => {
    const target = event.target as HTMLElement
    if (event.key === "/" && !(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable)) { event.preventDefault(); searchRef.current?.focus() }
  }}>
    {openRow && rowDetail ? <SupplierRowPanel key={`${editorMode}:${openRow.productId}:${initialTab}`} mode={editorMode} initialTab={initialTab} canAdjustPrice={showCreator}
      store={store} sourceId={openRow.sourceId} row={openRow} rows={allRows} propDefs={[...rowDetail.propDefs].sort((a, b) => a.position - b.position)}
      categoryTree={categoryTree} categoryLoading={categoryLoading} onEnsureCategoryTree={ensureCategoryTree} pending={pendingSet.has(openRow.productId)}
      onSelectRow={(productId, tab) => { setInitialTab(tab ?? "info"); setOpenRowId(productId) }} onClose={closeEditor}
      onArchive={!openRow.published || showCreator ? () => rowActions.setArchiveRowId(openRow.productId) : undefined} onDelete={!openRow.published || showCreator ? () => rowActions.setDeleteRowId(openRow.productId) : undefined} onAddVariant={() => addVariant(openRow.productId)} /> : <>
      <div className="supplier-db-toolbar flex min-w-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
        {!loading ? <SupplierDbStats counts={filters.statCounts} activeStat={filters.activeStat} applyStat={filters.applyStat} /> : null}
        <SupplierDbFilterBar filters={filters} />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">
          <Button variant="outline" size="sm" onClick={onManageFactories}>工厂绑定</Button>
          <Select items={filterItems} value={currentFactory} onValueChange={(next) => { if (next) { setFactoryId(next); filters.setPage(1) } }}><SelectTrigger size="sm" aria-label="按商品库筛选"><SelectValue /></SelectTrigger><SelectContent>{filterItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select>
          <Button variant="brand" size="sm" disabled={!dbs.length || rowActions.creating} aria-label="新增商品" onClick={openNewProduct}><Plus aria-hidden />新增商品</Button>
        </div>
      </div>
      <SupplierDbBulkBar actions={actions} />
      {failedFactories.length ? <div role="alert" className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2 text-compact text-destructive">{failedFactories.map((db) => db.name).join("、")} 的商品读取失败<Button variant="outline" size="sm" onClick={onRetry}><RotateCcw aria-hidden />重试</Button></div> : null}
      {loading ? <div className="flex flex-1 items-center justify-center gap-2 text-muted-foreground" role="status"><Spinner />正在读取商品库…</div>
        : <div className="supplier-db-products relative flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border">
          <SupplierDbProductsTable dbs={dbs} pageRows={pageRows} liveRows={liveRows} categoryTree={categoryTree} pendingSet={pendingSet} selectedIds={selectedIds} showCreator={showCreator} canPublish={showCreator}
            toggleSelectAll={(checked) => setSelectedIds(checked ? new Set(pageRows.map((row) => row.productId)) : new Set())} toggleSelectRow={toggleSelectRow}
            onOpen={(productId, tab) => { setEditorMode("variant"); setInitialTab(tab ?? "info"); setOpenRowId(productId) }} onOpenProduct={openProduct} onAddVariant={(row) => addVariant(row.productId)}
            toggleStatus={rowActions.toggleStatus} onToggleFromMenu={rowActions.toggleStatusFromMenu} onArchive={rowActions.setArchiveRowId} onDelete={rowActions.setDeleteRowId}
            onCreateProduct={openNewProduct} onClearFilters={filters.resetFilters} onManageFactories={onManageFactories} />
          <SupplierDbPagination filters={filters} />
        </div>}
    </>}
    {variantParent ? <SupplierVariantCreate key={variantParent.productId} row={variantParent} rows={allRows} store={store} onBack={() => setVariantParentId(null)} onCreated={(productId) => {
      setVariantParentId(null); setEditorMode("variant"); setInitialTab("info"); setOpenRowId(productId)
    }} /> : null}
    <Dialog open={newFactoryId !== null} onOpenChange={(open) => { if (!open && !rowActions.creating) setNewFactoryId(null) }}>
      <DialogContent><DialogHeader><DialogTitle>新增商品</DialogTitle><DialogDescription>选择商品库并命名首个规格，再填写商品资料。</DialogDescription></DialogHeader>
        <form onSubmit={async (event) => {
          event.preventDefault()
          if (!newFactoryId || !newSpecName.trim() || rowActions.creating || !dbs.some((db) => db.sourceId === newFactoryId)) return
          await store.loadDetail(newFactoryId)
          const detail = store.getState().details[newFactoryId]
          if (!detail?.detail || detail.status !== "ready") { notifyCommandError(detail?.reason, "商品库资料未读到，请重试"); return }
          setEditorMode("product"); setInitialTab("info")
          if (await rowActions.newPage(newFactoryId, newSpecName)) setNewFactoryId(null)
        }}>
          <Field><FieldLabel htmlFor="supplier-new-product-factory">商品库</FieldLabel><Select items={factoryItems} value={newFactoryId || null} onValueChange={(next) => setNewFactoryId(next ?? "")} disabled={rowActions.creating}>
            <SelectTrigger id="supplier-new-product-factory" aria-label="选择商品库"><SelectValue placeholder="选择商品库" /></SelectTrigger><SelectContent>{factoryItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select></Field>
          <Field className="mt-4"><FieldLabel htmlFor="supplier-new-product-spec">规格名称</FieldLabel><Input id="supplier-new-product-spec" name="size" required value={newSpecName} placeholder="如 40×50 cm" disabled={rowActions.creating} onChange={(event) => setNewSpecName(event.target.value)} /></Field>
          <DialogFooter><Button type="button" variant="outline" disabled={rowActions.creating} onClick={() => setNewFactoryId(null)}>取消</Button><Button type="submit" variant="brand" disabled={!newFactoryId || !newSpecName.trim() || rowActions.creating}>{rowActions.creating ? <Spinner /> : null}创建并填写</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
    <SupplierDbRowConfirmations actions={rowActions} /><SupplierDbConfirmations actions={actions} />
  </div>
}

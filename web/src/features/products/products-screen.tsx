/**
 * Workspace「我的商品」— one table of the product mirror, and the place the
 * operator runs the store from.
 *
 * Pick a store (or 全部店铺, the default once there are several keys) and the
 * rows are that mirror. Status tabs are the totals: they filter the same
 * table. Every Seller write — price, stock, promotions, archive, restore,
 * delete — starts from the row's 「⋯」 menu or the selection bar and goes
 * through the ops write ledger (`useProductWrites`); 核实 is the only read
 * that reaches Ozon.
 *
 * The expanded row shows grouping facts already present in the product mirror.
 *
 * Freshness is a state, not a number: a store that never synced says 「暂无数据」,
 * never a zero, and expired stores stay listed but outside the totals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useScreenActive } from "@/components/screen-pane"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { useStoreRoster } from "@/features/stores/store-roster-cache"

import { SelectionActions } from "./products-actions"
import {
  loadProducts,
  loadProductsOverview,
  exportFilteredProducts,
  syncNow as syncNowRequest,
  type StoreProductOverviewRow,
  type StoreProductRow,
  type StoreProductsOverviewData,
  type StoreProductStatusFilter,
} from "./products-api"
import { ProductDetailSheet } from "./products-detail"
import { downloadProductsCsv, productsCsv } from "./products-export"
import { archiveCountDelta, productScopeKey, rowKey, shiftOverviewForArchive } from "./products-mutation"
import { CoverageNote, FunnelNote, StatusTabs, type ProductCounts } from "./products-status"
import { ProductsTable } from "./products-table"
import { ProductsPromotions } from "./products-promotions"
import { ALL_STORES, ProductsToolbar } from "./products-toolbar"
import { nextScheduleUnlockAt, scheduleBlockedReason } from "./store-sync-actions"
import { useProductWrites } from "./use-product-writes"

type ProductsScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const SEARCH_DEBOUNCE_MS = 300
export const PRODUCTS_POLL_INTERVAL_MS = 15_000

/** Title after accepted 「立即更新」 presses. `attached` joined a walk already running. */
export function manualSyncNotice(scheduled: number, attached: number): string {
  if (scheduled === 0) {
    return attached === 1 ? "已接入正在进行的同步" : `已接入 ${attached} 家店铺正在进行的同步`
  }
  if (attached === 0) {
    return scheduled === 1 ? "立即更新已开始" : `已开始更新 ${scheduled} 家店铺`
  }
  return `已开始更新 ${scheduled} 家店铺，${attached} 家已接入正在进行的同步`
}

export function ProductsScreen({ workspaceId, onOpenStores }: ProductsScreenProps) {
  const active = useScreenActive()
  const [overview, setOverview] = useState<StoreProductsOverviewData | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewFailed, setOverviewFailed] = useState(false)
  // `null` until the first overview picks a store. `"all"` is the operator's choice.
  const [storeId, setStoreId] = useState<string | null>(null)
  const [rows, setRows] = useState<StoreProductRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [listFailed, setListFailed] = useState(false)
  const [status, setStatus] = useState<StoreProductStatusFilter | undefined>(undefined)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [scheduling, setScheduling] = useState<Set<string>>(new Set())
  const [clock, setClock] = useState(Date.now)
  const [exporting, setExporting] = useState(false)
  const [promotionsOpen, setPromotionsOpen] = useState(false)
  const exportScope = useRef("")
  // 勾选键是 `${storeId}:${productId}`——productId 是镜像行身份，offerId 会重名。
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // 点开的商品详情，键与勾选相同；列表回读替换行对象后仍能对上这一件。
  const [detailKey, setDetailKey] = useState<string | null>(null)
  // 只认最后一次列表请求的回包：快速切换筛选时，慢回包不能覆盖新结果。
  const listSeq = useRef(0)
  const overviewSeq = useRef(0)
  const overviewInFlight = useRef(false)
  const syncStamps = useRef(new Map<string, number | null>())
  // The roster's answer is the visibility predicate: an assignee change must
  // repaint this screen, so a roster refresh (cachedAt moves) refetches both
  // reads — the same shared snapshot every store screen subscribes to.
  const rosterCachedAt = useStoreRoster(workspaceId)?.cachedAt

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const reloadOverview = useCallback(async (options?: { quiet?: boolean }) => {
    const seq = ++overviewSeq.current
    overviewInFlight.current = true
    setOverviewLoading(true)
    try {
      const data = await loadProductsOverview()
      if (seq !== overviewSeq.current) return
      setOverview(data)
      setOverviewFailed(false)
      setStoreId((current) => {
        if (current === ALL_STORES) return current
        if (current && data.stores.some((store) => store.store_id === current)) return current
        // 多个店铺密钥时默认看全部；只有一家时直接落在这家店上。
        return data.stores.length === 1 ? data.stores[0]!.store_id : ALL_STORES
      })
    } catch (reason) {
      if (seq !== overviewSeq.current) return
      setOverviewFailed(true)
      if (!options?.quiet) notifyCommandError(reason, "商品汇总加载失败，请稍后重试。")
      setStoreId((current) => current ?? ALL_STORES)
    } finally {
      if (seq === overviewSeq.current) {
        overviewInFlight.current = false
        setOverviewLoading(false)
      }
    }
  }, [])

  const scopedStoreId = storeId === ALL_STORES || storeId === null ? undefined : storeId
  exportScope.current = `${workspaceId ?? "session"}:${storeId ?? ""}:${status ?? ""}:${searchInput}`
  useEffect(() => () => { exportScope.current = "" }, [])

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const seq = ++listSeq.current
      setListLoading(true)
      if (!cursor) {
        setRows([])
        setNextCursor(null)
      }
      setListFailed(false)
      try {
        const page = await loadProducts({
          storeId: scopedStoreId,
          status,
          q: search,
          cursor,
        })
        if (seq !== listSeq.current) return
        setRows((prev) => (cursor ? [...prev, ...page.rows] : page.rows))
        setNextCursor(page.next_cursor ?? null)
        // 重载的名单换了——勾选只认还在这张表里的行。
        if (!cursor) setSelectedKeys(new Set())
      } catch (reason) {
        if (seq !== listSeq.current) return
        setListFailed(true)
        notifyCommandError(
          reason,
          cursor ? "加载更多失败，请稍后重试。" : "商品列表加载失败，请稍后重试。",
        )
      } finally {
        if (seq === listSeq.current) setListLoading(false)
      }
    },
    [scopedStoreId, status, search],
  )

  const reloadList = useCallback(async () => {
    if (storeId === null) return
    await fetchPage()
  }, [storeId, fetchPage])

  useVisiblePolling({
    enabled: active,
    intervalMs: PRODUCTS_POLL_INTERVAL_MS,
    restartKey: `${workspaceId ?? "session"}:${rosterCachedAt ?? ""}`,
    onPoll: (trigger) => {
      if (!overviewInFlight.current) void reloadOverview({ quiet: trigger !== "mount" })
    },
  })

  useEffect(() => {
    if (!active || storeId === null) return
    void reloadList()
  }, [active, reloadList, rosterCachedAt, storeId])

  const patchStore = useCallback(
    (id: string, patch: Partial<StoreProductOverviewRow>) =>
      setOverview((current) =>
        current
          ? {
              ...current,
              stores: current.stores.map((item) =>
                item.store_id === id ? { ...item, ...patch } : item,
              ),
            }
          : current,
      ),
    [],
  )

  /** Starts one store's pull; the caller owns the success copy. */
  const startSync = useCallback(
    async (store: StoreProductOverviewRow): Promise<"scheduled" | "attached" | null> => {
      setScheduling((prev) => new Set(prev).add(store.store_id))
      try {
        const { manual_next_allowed_at_ms, attached } = await syncNowRequest(store.store_id)
        const now = Date.now()
        patchStore(store.store_id, {
          next_due_at_ms: now,
          manual_requested_at_ms: now,
          manual_next_allowed_at_ms,
        })
        return attached ? "attached" : "scheduled"
      } catch (reason) {
        notifyCommandError(reason, `${store.name} 无法开始立即更新，请稍后重试。`)
        return null
      } finally {
        setScheduling((prev) => {
          const next = new Set(prev)
          next.delete(store.store_id)
          return next
        })
      }
    },
    [patchStore],
  )

  const stores = useMemo(() => overview?.stores ?? [], [overview])
  const syncDisabled = overview?.sync_disabled ?? false
  const syncableStores = stores.filter((store) => scheduleBlockedReason(store, syncDisabled, Date.now()) === null)

  useEffect(() => {
    if (!active) return
    const unlockAt = nextScheduleUnlockAt(stores, Date.now())
    if (unlockAt === null) return
    const timer = window.setTimeout(() => setClock(Date.now()), Math.min(unlockAt - Date.now() + 1, 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [active, stores, clock])

  useEffect(() => {
    if (!active || !overview) return
    const previous = syncStamps.current
    syncStamps.current = new Map(stores.map((store) => [store.store_id, store.last_full_sync_at_ms ?? null]))
    if (stores.some((store) => previous.has(store.store_id) && previous.get(store.store_id) !== (store.last_full_sync_at_ms ?? null))) {
      void reloadList()
    }
  }, [active, overview, stores, reloadList])

  const syncStores = useCallback(
    async (targets: StoreProductOverviewRow[]) => {
      // 顺序发起：每家店各自受手动间隔限制，并发只会把 429 叠在一起。
      let scheduled = 0
      let attached = 0
      for (const store of targets) {
        const outcome = await startSync(store)
        if (outcome === "scheduled") scheduled += 1
        if (outcome === "attached") attached += 1
      }
      if (scheduled + attached === 0) return
      notifySuccess(manualSyncNotice(scheduled, attached), {
        description: "更新完成后，商品表会展示最新数据。",
      })
    },
    [startSync],
  )


  const clearSelection = useCallback(() => setSelectedKeys(new Set()), [])
  // 换店铺 = 换范围：勾选、促销详情与同款详情一起作废。工作空间切换由
  // screen-catalog 的 key 重挂载整个屏，比这里的清理更彻底。
  const resetScope = useCallback(() => {
    setSelectedKeys(new Set())
    setDetailKey(null)
  }, [])
  const scopeKey = productScopeKey(workspaceId, storeId)
  const noteArchived = useCallback((archived: StoreProductRow[]) => {
    const storeId = archived[0]?.store_id
    if (!storeId) return
    const delta = archiveCountDelta(archived)
    setOverview((current) =>
      current ? shiftOverviewForArchive(current, storeId, delta) : current,
    )
  }, [])
  const { verifying, runAction, refreshAfterWrite, dialogs } = useProductWrites({
    stores,
    syncDisabled,
    setRows,
    clearSelection,
    reloadOverview,
    reloadList,
    listStatus: status,
    onArchived: noteArchived,
    scopeKey,
  })

  const selected = stores.find((store) => store.store_id === storeId) ?? null
  // 金额按行所属店铺的币种渲染——全部店铺视图里各行走各的币种。
  const storeCurrency = useMemo(
    () => new Map(stores.map((store) => [store.store_id, store.currency ?? null])),
    [stores],
  )
  const storeSyncTime = useMemo(
    () => new Map(stores.map((store) => [store.store_id, store.last_full_sync_at_ms ?? null])),
    [stores],
  )
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedKeys.has(rowKey(row))),
    [rows, selectedKeys],
  )
  const detailRow =
    detailKey === null ? null : (rows.find((row) => rowKey(row) === detailKey) ?? null)
  const tabCounts: ProductCounts = selected
    ? {
        total: selected.count_total,
        onSale: selected.count_on_sale,
        processing: selected.count_processing,
        hidden: selected.count_hidden,
        moderationFailed: selected.count_moderation_failed,
        zeroStock: selected.count_zero_stock,
        archived: selected.count_archived,
        delisted: selected.count_delisted,
      }
    : {
        total: overview?.totals.total,
        onSale: overview?.totals.on_sale,
        processing: overview?.totals.processing,
        hidden: overview?.totals.hidden,
        moderationFailed: overview?.totals.moderation_failed,
        zeroStock: overview?.totals.zero_stock,
        archived: overview?.totals.archived,
        delisted: overview?.totals.delisted,
      }
  const noStores = !overviewLoading && overview !== null && stores.length === 0

  if (promotionsOpen) return <ProductsPromotions stores={stores} initialStoreId={storeId} onBack={() => setPromotionsOpen(false)} onApplied={() => { void reloadOverview(); void reloadList() }} />

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
      <h1 className="sr-only">我的商品</h1>
      <ProductsToolbar
        storeId={storeId}
        stores={stores}
        selected={selected}
        syncDisabled={syncDisabled}
        scheduling={scheduling}
        syncableStores={syncableStores}
        onValueChange={(next) => {
          if (!next || next === storeId) return
          resetScope()
          setStoreId(next)
        }}
        syncStores={syncStores}
        reloadOverview={reloadOverview}
        reloadList={reloadList}
        search={searchInput}
        onSearch={(value) => { resetScope(); setSearchInput(value) }}
        status={status}
        onStatus={(value) => { resetScope(); setStatus(value) }}
        selectedCount={selectedRows.length}
        exporting={exporting}
        onPromotions={() => setPromotionsOpen(true)}
        onExportFiltered={() => {
          if (exporting || storeId === null) return
          const scope = exportScope.current
          setExporting(true)
          void exportFilteredProducts({ storeId: scopedStoreId, status, q: searchInput }).then((content) => {
            if (exportScope.current !== scope) return
            downloadProductsCsv(content)
          }).catch((reason) => {
            if (exportScope.current === scope) notifyCommandError(reason, "导出失败，请缩小筛选范围后重试。")
          }).finally(() => { if (exportScope.current) setExporting(false) })
        }}
        onExport={() => {
          try {
            downloadProductsCsv(productsCsv(selectedRows, (id) => storeCurrency.get(id) ?? null, (id) => storeSyncTime.get(id) ?? null))
          } catch (reason) {
            notifyCommandError(reason, "导出失败，请稍后重试。")
          }
        }}
      />
      {overviewFailed ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
        商品汇总读取失败{overview ? "，显示上次读取结果" : ""}。
        <Button type="button" size="xs" variant="outline" onClick={() => void reloadOverview()}>重试汇总</Button>
      </div> : null}
        <>
          {/* 状态页签独占一行——合计数就是筛选入口；覆盖率注脚贴右端，省一整行。 */}
          <div className="flex flex-wrap items-end justify-between gap-x-4 border-b border-border">
            <StatusTabs
              counts={tabCounts}
              freshness={selected ? selected.freshness : "totals"}
              status={status}
              onStatus={(value) => { resetScope(); setStatus(value) }}
            />
            {overview ? <CoverageNote overview={overview} className="pb-1.5" /> : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
            {selectedRows.length > 0 ? <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
              {selectedRows.length > 0 ? (
                <SelectionActions
                  count={selectedRows.length}
                  verifyDisabled={syncDisabled}
                  onAction={(action) => runAction(action, selectedRows)}
                />
              ) : null}
              {/* 漏斗口径只对本店成立：全部店铺视图下各店窗口不一，宁缺毋滥。 */}
              <FunnelNote
                metrics={
                  selected
                    ? (rows.find((row) => row.store_id === selected.store_id && row.metrics)
                        ?.metrics ?? null)
                    : null
                }
                metricsError={selected?.metrics_error ?? null}
              />
            </div> : null}
            {listFailed && rows.length > 0 ? <div role="alert" className="flex items-center gap-2 px-3 py-2 text-sm text-destructive">
              后续商品读取失败。
              <Button type="button" variant="outline" size="xs" onClick={() => void fetchPage(nextCursor ?? undefined)}>重试</Button>
            </div> : null}
            <ProductsTable
              rows={rows}
              showStore={storeId === ALL_STORES}
              currencyOf={(id) => storeCurrency.get(id) ?? null}
              snapshotAtOf={(id) => storeSyncTime.get(id) ?? null}
              selectedKeys={selectedKeys}
              onSelectedKeys={setSelectedKeys}
              verifying={verifying}
              verifyDisabled={syncDisabled}
              onAction={(action, row) => runAction(action, [row])}
              onOpen={(row) => setDetailKey(rowKey(row))}
              onApplied={(row) => refreshAfterWrite([row])}
              loading={listLoading || storeId === null}
              failed={listFailed}
              noStores={noStores}
              onRetry={() => void reloadList()}
              onOpenStores={onOpenStores}
              freshness={selected?.freshness ?? null}
              hasMore={nextCursor !== null}
              onLoadMore={() => {
                if (nextCursor) void fetchPage(nextCursor)
              }}
            />
          </div>
        </>

      {dialogs}
      <ProductDetailSheet
        row={detailRow}
        currency={detailRow ? (storeCurrency.get(detailRow.store_id) ?? null) : null}
        onClose={() => setDetailKey(null)}
        onApplied={(row) => refreshAfterWrite([row])}
      />
    </div>
  )
}

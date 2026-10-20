/**
 * Workspace「店铺商品」— one table of the product mirror, and the place the
 * operator runs the store from.
 *
 * Pick a store (or 全部店铺, the default once there are several keys) and the
 * rows are that mirror. Status tabs are the totals: they filter the same
 * table. Every Seller write — price, stock, promotions, archive, restore,
 * delete — starts from the row's 「⋯」 menu or the selection bar and goes
 * through the ops write ledger (`useProductWrites`); 核实 is the only read
 * that reaches Ozon.
 *
 * The 「同款」 column and its 详情 drawer are the grouping surface: they read
 * the grouping preview (a targeted mirror read) and never write. The three
 * grouping actions on the selection bar go through the same `runAction` →
 * open-state seam, then through `use-product-writes`' preview-digest dialog.
 *
 * Freshness is a state, not a number: a store that never synced says 「暂无数据」,
 * never a zero, and expired stores stay listed but outside the totals.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Search, Store } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group"
import { useScreenActive } from "@/components/screen-pane"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { useStoreRoster } from "@/features/stores/store-roster-cache"

import { SelectionActions } from "./products-actions"
import {
  loadProducts,
  loadProductsOverview,
  syncNow as syncNowRequest,
  type StoreProductOverviewRow,
  type StoreProductRow,
  type StoreProductsOverviewData,
  type StoreProductStatusFilter,
} from "./products-api"
import { ProductDetailSheet } from "./products-detail"
import { archiveCountDelta, rowKey, shiftOverviewForArchive } from "./products-mutation"
import { ProductVariantDetailSheet } from "./products-variant-detail"
import { variantScopeKey, variantTargetOptions } from "./products-variant-model"
import { CoverageNote, FunnelNote, StatusTabs, type ProductCounts } from "./products-status"
import { ProductsTable } from "./products-table"
import { ALL_STORES, ProductsToolbar } from "./products-toolbar"
import { scheduleBlockedReason } from "./store-sync-actions"
import { useProductWrites } from "./use-product-writes"

type ProductsScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const SEARCH_DEBOUNCE_MS = 300

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
  // `null` until the first overview picks a store. `"all"` is the operator's choice.
  const [storeId, setStoreId] = useState<string | null>(null)
  const [rows, setRows] = useState<StoreProductRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listLoading, setListLoading] = useState(true)
  const [status, setStatus] = useState<StoreProductStatusFilter | undefined>(undefined)
  const [searchInput, setSearchInput] = useState("")
  const [search, setSearch] = useState("")
  const [scheduling, setScheduling] = useState<Set<string>>(new Set())
  // 勾选键是 `${storeId}:${productId}`——productId 是镜像行身份，offerId 会重名。
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  // 点开的商品详情，键与勾选相同；列表回读替换行对象后仍能对上这一件。
  const [detailKey, setDetailKey] = useState<string | null>(null)
  // 「同款规格」详情同理：换店铺后这一键在名单里找不到，抽屉自然关闭。
  const [variantKey, setVariantKey] = useState<string | null>(null)
  // 只认最后一次列表请求的回包：快速切换筛选时，慢回包不能覆盖新结果。
  const listSeq = useRef(0)
  // The roster's answer is the visibility predicate: an assignee change must
  // repaint this screen, so a roster refresh (cachedAt moves) refetches both
  // reads — the same shared snapshot every store screen subscribes to.
  const rosterCachedAt = useStoreRoster(workspaceId)?.cachedAt

  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  const reloadOverview = useCallback(async () => {
    setOverviewLoading(true)
    try {
      const data = await loadProductsOverview()
      setOverview(data)
      setStoreId((current) => {
        if (current === ALL_STORES) return current
        if (current && data.stores.some((store) => store.store_id === current)) return current
        // 多个店铺密钥时默认看全部；只有一家时直接落在这家店上。
        return data.stores.length === 1 ? data.stores[0]!.store_id : ALL_STORES
      })
    } catch (reason) {
      notifyCommandError(reason, "商品汇总加载失败，请稍后重试。")
      setStoreId((current) => current ?? ALL_STORES)
    } finally {
      setOverviewLoading(false)
    }
  }, [])

  const scopedStoreId = storeId === ALL_STORES || storeId === null ? undefined : storeId

  const fetchPage = useCallback(
    async (cursor?: string) => {
      const seq = ++listSeq.current
      setListLoading(true)
      if (!cursor) {
        setRows([])
        setNextCursor(null)
      }
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

  useEffect(() => {
    void reloadOverview()
  }, [reloadOverview, rosterCachedAt])

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
  const syncableStores = useMemo(
    () => stores.filter((store) => scheduleBlockedReason(store, syncDisabled, Date.now()) === null),
    [stores, syncDisabled],
  )

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
    setVariantKey(null)
  }, [])
  const scopeKey = variantScopeKey(workspaceId, storeId)
  const variantTargets = useMemo(() => variantTargetOptions(rows), [rows])
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
    variantTargets,
  })

  const selected = stores.find((store) => store.store_id === storeId) ?? null
  // 金额按行所属店铺的币种渲染——全部店铺视图里各行走各的币种。
  const storeCurrency = useMemo(
    () => new Map(stores.map((store) => [store.store_id, store.currency ?? null])),
    [stores],
  )
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedKeys.has(rowKey(row))),
    [rows, selectedKeys],
  )
  const detailRow =
    detailKey === null ? null : (rows.find((row) => rowKey(row) === detailKey) ?? null)
  const variantRow =
    variantKey === null ? null : (rows.find((row) => rowKey(row) === variantKey) ?? null)
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

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden p-3">
      <h1 className="sr-only">店铺商品</h1>
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
      />

      {noStores ? (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Store />
            </EmptyMedia>
            <EmptyTitle>还没有可见店铺</EmptyTitle>
            <EmptyDescription>先去店铺页登记 Client ID / API Key。</EmptyDescription>
          </EmptyHeader>
          {onOpenStores ? (
            <EmptyContent>
              <Button size="sm" variant="outline" onClick={onOpenStores}>
                打开店铺
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : (
        <>
          {/* 状态页签独占一行——合计数就是筛选入口；覆盖率注脚贴右端，省一整行。 */}
          <div className="flex flex-wrap items-end justify-between gap-x-4 border-b border-border">
            <StatusTabs
              counts={tabCounts}
              freshness={selected ? selected.freshness : "totals"}
              status={status}
              onStatus={setStatus}
            />
            {overview ? <CoverageNote overview={overview} className="pb-1.5" /> : null}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card">
            <div className="flex min-h-11 flex-wrap items-center gap-2 border-b border-border px-2.5 py-1.5">
              {/* 勾选后批量栏接管这一行；取消勾选用表头复选框。 */}
              {selectedRows.length > 0 ? (
                <SelectionActions
                  count={selectedRows.length}
                  verifyDisabled={syncDisabled}
                  onAction={(action) => runAction(action, selectedRows)}
                />
              ) : (
                <>
                  <InputGroup className="w-64">
                    <InputGroupAddon align="inline-start">
                      <Search aria-hidden />
                    </InputGroupAddon>
                    <InputGroupInput
                      value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      placeholder="搜索商品名、货号或 SKU"
                      aria-label="搜索商品"
                    />
                  </InputGroup>
                </>
              )}
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
            </div>
            <ProductsTable
              rows={rows}
              showStore={storeId === ALL_STORES}
              currencyOf={(id) => storeCurrency.get(id) ?? null}
              selectedKeys={selectedKeys}
              onSelectedKeys={setSelectedKeys}
              verifying={verifying}
              verifyDisabled={syncDisabled}
              onAction={(action, row) => runAction(action, [row])}
              onOpen={(row) => setDetailKey(rowKey(row))}
              onOpenVariant={(row) => setVariantKey(rowKey(row))}
              onApplied={(row) => refreshAfterWrite([row])}
              loading={listLoading || storeId === null}
              freshness={selected?.freshness ?? null}
              hasMore={nextCursor !== null}
              onLoadMore={() => {
                if (nextCursor) void fetchPage(nextCursor)
              }}
            />
          </div>
        </>
      )}

      {dialogs}
      <ProductDetailSheet
        row={detailRow}
        currency={detailRow ? (storeCurrency.get(detailRow.store_id) ?? null) : null}
        onClose={() => setDetailKey(null)}
        onApplied={(row) => refreshAfterWrite([row])}
      />
      <ProductVariantDetailSheet
        row={variantRow}
        scopeKey={scopeKey}
        onClose={() => setVariantKey(null)}
      />
    </div>
  )
}

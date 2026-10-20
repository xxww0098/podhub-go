import { useCallback, useEffect, useRef, useState } from "react"
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  Warehouse,
} from "lucide-react"

import type { SupplyListView, SupplyOrderView, SupplyWarehouseStockView } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import {
  loadStoreRoster,
  peekStoreRoster,
  rosterHasUnavailableStores,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import {
  OpsStoreSelect,
  opsStoresFromRoster,
  preferredStoreUid,
  type OpsStore,
} from "@/features/ops/ops-store-roster"
import { IdCode } from "@/components/id-code"
import { PageToolbar } from "@/components/page-toolbar"
import { useScreenActive } from "@/components/screen-pane"
import { KeyValue, KeyValueGrid, Section } from "@/components/section"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { errorMessage } from "@/lib/error-message"
import { clearLive, notifyInfo, notifyLive } from "@/lib/notify"
import { TONE_INK, toneFor } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"
import { StoreGate } from "@/features/stores/store-gate"

import {
  ALL_STATE,
  DEFAULT_STATE,
  EMPTY_SUPPLY_LIST,
  QUEUE_STATES,
  formatCount,
  formatInstant,
  formatTimeslot,
  orderIdentity,
  supplyStateLabel,
  runSupplyRead,
  warehouseDisplayName,
  type SupplyReadState,
} from "./supply-model"

type SupplyScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const EMPTY_LIST_READ: SupplyReadState<SupplyListView> = {
  view: EMPTY_SUPPLY_LIST,
  loading: false,
  error: "",
}

const EMPTY_WAREHOUSE_READ: SupplyReadState<SupplyWarehouseStockView[]> = {
  view: [],
  loading: false,
  error: "",
}

const SUPPLY_READ_LIVE = "supply-read"

/**
 * 供货 — inbound supply orders to an Ozon warehouse, plus leftover FBO
 * stock by warehouse. Per-SKU FBS edits stay on 商品.
 */
export function SupplyScreen({ workspaceId, onOpenStores }: SupplyScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [stores, setStores] = useState<OpsStore[]>([])
  const [storesLoading, setStoresLoading] = useState(true)
  const [storesError, setStoresError] = useState("")
  const [storesReason, setStoresReason] = useState<unknown>()
  const [rosterRetry, setRosterRetry] = useState(0)
  const [storeUid, setStoreUid] = useState("")
  const [hasUnavailableStores, setHasUnavailableStores] = useState(false)
  const [ordersRead, setOrdersRead] = useState(EMPTY_LIST_READ)
  const [warehouseRead, setWarehouseRead] = useState(EMPTY_WAREHOUSE_READ)
  const [stateFilter, setStateFilter] = useState(DEFAULT_STATE)
  const [openOrder, setOpenOrder] = useState<SupplyOrderView | null>(null)
  const [search, setSearch] = useState("")
  const [appliedSearch, setAppliedSearch] = useState("")
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const ordersSequence = useRef(0)
  const warehousesSequence = useRef(0)
  const storesSequence = useRef(0)
  const storesRef = useRef(stores)
  const storeUidRef = useRef(storeUid)
  storesRef.current = stores
  storeUidRef.current = storeUid

  const loadStores = useCallback(async () => {
    const sequence = ++storesSequence.current
    ordersSequence.current += 1
    warehousesSequence.current += 1
    setStoresLoading(storesRef.current.length === 0)
    setStoresError("")
    setStoresReason(undefined)
    try {
      await loadStoreRoster({ workspaceId })
      if (sequence !== storesSequence.current) return
      setStoresError("")
    } catch (reason) {
      if (sequence !== storesSequence.current) return
      setStoresError(errorMessage(reason, "无法读取店铺配置。"))
      setStoresReason(() => reason)
      if (!peekStoreRoster(workspaceId) && storesRef.current.length === 0) {
        setStoreUid("")
        setOrdersRead(EMPTY_LIST_READ)
        setWarehouseRead(EMPTY_WAREHOUSE_READ)
      }
    } finally {
      if (sequence === storesSequence.current) setStoresLoading(false)
    }
  }, [workspaceId])

  useEffect(() => {
    if (!roster) return
    const configured = opsStoresFromRoster(roster.overview.stores)
    setHasUnavailableStores(rosterHasUnavailableStores(roster.overview))
    setStores(configured)
    const current = storeUidRef.current
    const selected = configured.some((store) => store.storeUid === current)
      ? current
      : preferredStoreUid(configured, roster.overview.active_id)
    if (selected !== current) {
      ordersSequence.current += 1
      warehousesSequence.current += 1
      setOrdersRead({ ...EMPTY_LIST_READ, loading: Boolean(selected) })
      setWarehouseRead({ ...EMPTY_WAREHOUSE_READ, loading: Boolean(selected) })
      setStoreUid(selected)
    }
  }, [roster])

  const loadOrders = useCallback(
    async (
      nextStore: string,
      lastId: string,
      states: string[],
      query: string,
      terminalProbe = false,
    ) => {
      if (!nextStore.trim()) return false
      const sequence = ++ordersSequence.current
      return runSupplyRead({
        request: () =>
          opsHttp.opsSupplyList({
            store_id: nextStore,
            last_id: lastId || undefined,
            states: states.filter(Boolean),
            document_number_search: query.trim() || undefined,
          }),
        isCurrent: () => sequence === ordersSequence.current,
        setState: setOrdersRead,
        fallback: "读取供货单失败",
        accept: terminalProbe ? (next) => next.orders.length > 0 : undefined,
        reject: terminalProbe
          ? (current) => ({ ...current, has_more: false })
          : undefined,
      })
    },
    [],
  )

  const loadWarehouses = useCallback((nextStore: string) => {
    if (!nextStore.trim()) return
    const sequence = ++warehousesSequence.current
    return runSupplyRead({
      request: async () =>
        (await opsHttp.opsSupplyWarehouseStocks({ store_id: nextStore })).warehouses,
      isCurrent: () => sequence === warehousesSequence.current,
      setState: setWarehouseRead,
      fallback: "读取仓库存失败",
    })
  }, [])

  const refresh = useCallback(
    (nextStore: string) => {
      void loadOrders(nextStore, "", stateFilter ? [stateFilter] : [], appliedSearch).then(
        (loaded) => {
          if (!loaded) return
          setCursorStack([])
          setPage(1)
        },
      )
      void loadWarehouses(nextStore)
    },
    [appliedSearch, loadOrders, loadWarehouses, stateFilter],
  )
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const readError = ordersRead.error || warehouseRead.error
  const readReason = ordersRead.error ? ordersRead.reason : warehouseRead.reason

  useEffect(() => {
    if (!readError) {
      clearLive(SUPPLY_READ_LIVE)
      return
    }
    notifyLive({
      id: SUPPLY_READ_LIVE,
      type: "error",
      reason: readReason,
      title: readError,
      action: {
        label: "重试",
        onClick: () => refreshRef.current(storeUidRef.current),
      },
    })
    return () => clearLive(SUPPLY_READ_LIVE)
  }, [ordersRead.error, warehouseRead.error, readReason])

  useEffect(() => {
    if (!active) return
    void loadStores()
    return () => {
      storesSequence.current += 1
      ordersSequence.current += 1
      warehousesSequence.current += 1
    }
  }, [active, loadStores, rosterRetry])

  useEffect(() => {
    if (!active || !storeUid.trim()) return
    void loadOrders(storeUid, "", stateFilter ? [stateFilter] : [], appliedSearch).then(
      (loaded) => {
        if (!loaded) return
        setCursorStack([])
        setPage(1)
      },
    )
    void loadWarehouses(storeUid)
    // Re-entry refreshes page one without erasing the operator's filters.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activation/store switch only
  }, [active, loadOrders, loadWarehouses, storeUid])

  function applyState(next: string) {
    void loadOrders(storeUid, "", next ? [next] : [], appliedSearch).then((loaded) => {
      if (!loaded) return
      setStateFilter(next)
      setCursorStack([])
      setPage(1)
    })
  }

  function applySearch() {
    const next = search.trim()
    void loadOrders(storeUid, "", stateFilter ? [stateFilter] : [], next).then(
      (loaded) => {
        if (!loaded) return
        setAppliedSearch(next)
        setCursorStack([])
        setPage(1)
      },
    )
  }

  async function goNext() {
    const current = ordersRead.view
    if (!current.has_more || !current.last_id.trim()) return
    const nextCursor = current.last_id
    const loaded = await loadOrders(
      storeUid,
      nextCursor,
      stateFilter ? [stateFilter] : [],
      appliedSearch,
      true,
    )
    if (!loaded) return
    setCursorStack((prev) => [...prev, nextCursor])
    setPage((prev) => prev + 1)
  }

  async function goPrev() {
    if (page <= 1) return
    const stack = cursorStack.slice(0, -1)
    const lastId = stack[stack.length - 1] ?? ""
    const loaded = await loadOrders(
      storeUid,
      lastId,
      stateFilter ? [stateFilter] : [],
      appliedSearch,
    )
    if (!loaded) return
    setCursorStack(stack)
    setPage((prev) => Math.max(1, prev - 1))
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <PageToolbar
        primary={
          <OpsStoreSelect
            value={storeUid}
            stores={stores}
            onChange={(next) => {
              if (next === storeUid) return
              const store = stores.find((item) => item.storeUid === next)
              notifyInfo(`已切换店铺 · ${store?.name ?? next}`)
              ordersSequence.current += 1
              warehousesSequence.current += 1
              setOrdersRead({ ...EMPTY_LIST_READ, loading: true })
              setWarehouseRead({ ...EMPTY_WAREHOUSE_READ, loading: true })
              setCursorStack([])
              setPage(1)
              setStoreUid(next)
            }}
          />
        }
        secondary={
          <Button
            size="sm"
            variant="default"
            disabled={!storeUid.trim() || ordersRead.loading || warehouseRead.loading}
            onClick={() => refresh(storeUid)}
          >
            <RefreshCw
              className={cn(
                (ordersRead.loading || warehouseRead.loading) && "animate-spin",
              )}
            />
            {ordersRead.loading || warehouseRead.loading ? "正在读取…" : "刷新"}
          </Button>
        }
      />

      <StoreGate
        loading={storesLoading}
        error={storesError}
        reason={storesReason}
        storeCount={stores.length}
        hasUnavailableStores={hasUnavailableStores}
        onRetry={() => setRosterRetry((value) => value + 1)}
        onOpenStores={onOpenStores}
        icon={<Warehouse />}
      >
        <>
          <Section
            title="供货单"
            action={
              <div className="flex flex-wrap items-end gap-2">
                <Tabs
                  value={stateFilter || "all"}
                  onValueChange={(next) => applyState(next === "all" ? ALL_STATE : next)}
                >
                  <TabsList aria-label="供货队列">
                    <TabsIndicator />
                    {QUEUE_STATES.map((item) => (
                      <TabsTrigger
                        key={item.label}
                        value={item.value || "all"}
                        className="h-7 px-2.5"
                      >
                        {item.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
                <Field className="w-[220px] gap-1">
                  <FieldLabel htmlFor="ops-supply-number">供货单号</FieldLabel>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="ops-supply-number"
                      value={search}
                      aria-label="供货单号"
                      className="h-8 pl-8"
                      onChange={(event) => setSearch(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") applySearch()
                      }}
                    />
                  </div>
                </Field>
                <nav
                  aria-label="分页"
                  className="flex items-center gap-0.5 text-xs text-muted-foreground tabular-nums"
                >
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-7 px-0"
                          disabled={page <= 1 || ordersRead.loading}
                          aria-label="上一页"
                          onClick={() => void goPrev()}
                        />
                      }
                    >
                      <ChevronLeft aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>上一页</TooltipContent>
                  </Tooltip>
                  <span aria-live="polite" aria-atomic="true" className="font-mono">
                    {page}
                  </span>
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          className="size-7 px-0"
                          disabled={
                            !ordersRead.view.has_more ||
                            !ordersRead.view.last_id.trim() ||
                            ordersRead.loading
                          }
                          aria-label="下一页"
                          onClick={() => void goNext()}
                        />
                      }
                    >
                      <ChevronRight aria-hidden />
                    </TooltipTrigger>
                    <TooltipContent>下一页</TooltipContent>
                  </Tooltip>
                </nav>
              </div>
            }
          >
            <SupplyOrdersTable
              orders={ordersRead.view.orders}
              loading={ordersRead.loading}
              onOpen={setOpenOrder}
            />
          </Section>

          <Section title="各仓库存">
            <WarehouseStocksTable
              warehouses={warehouseRead.view}
              loading={warehouseRead.loading}
            />
          </Section>
          <SupplyDetailDialog
            order={openOrder}
            onOpenChange={(next) => {
              if (!next) setOpenOrder(null)
            }}
          />
        </>
      </StoreGate>
    </section>
  )
}

export function SupplyOrdersTable({
  orders,
  loading,
  onOpen,
}: {
  orders: SupplyOrderView[]
  loading: boolean
  onOpen?: (order: SupplyOrderView) => void
}) {
  return (
    <div
      aria-busy={loading}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      {loading ? (
        <span role="status" className="sr-only">
          正在读取供货单…
        </span>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>供货单号</TableHead>
            <TableHead>目标仓库</TableHead>
            <TableHead className="w-36">状态</TableHead>
            <TableHead className="hidden xl:table-cell">时间窗</TableHead>
            <TableHead className="w-24 text-right">件数</TableHead>
            <TableHead className="w-20">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {orders.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="px-4 py-6">
                <Empty className="border-0 bg-transparent py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      {loading ? <Spinner className="size-4" /> : <Warehouse />}
                    </EmptyMedia>
                    <EmptyTitle>
                      {loading ? "正在读取供货单…" : "没有供货单"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {loading
                        ? "正在向 Ozon 拉取发往仓库的供货单。"
                        : "当前店铺没有匹配的供货单。"}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          ) : null}
          {orders.map((order) => (
            <TableRow
              key={order.order_id || order.order_number}
              className={cn(onOpen && "cursor-pointer", "align-top")}
              onClick={() => onOpen?.(order)}
            >
              <TableCell>
                <IdCode value={orderIdentity(order)} className="text-foreground" />
                <p className="mt-1 font-mono text-meta text-muted-foreground">
                  创建 {formatInstant(order.created_date) || "—"}
                </p>
              </TableCell>
              <TableCell className="min-w-0">
                <Disclose value={order.target_warehouse_name || "—"} />
                {order.target_warehouse_id ? (
                  <IdCode value={order.target_warehouse_id} className="mt-1" />
                ) : null}
                {order.dropoff_warehouse_name &&
                order.dropoff_warehouse_name !== order.target_warehouse_name ? (
                  <p className="mt-1 line-clamp-1 text-meta text-muted-foreground">
                    发货点 {order.dropoff_warehouse_name}
                  </p>
                ) : null}
                <p className="mt-1 font-mono text-meta break-words text-muted-foreground xl:hidden">
                  时间窗 {formatTimeslot(order)}
                </p>
              </TableCell>
              <TableCell>
                <StateChip
                  status={order.state || "UNSPECIFIED"}
                  label={supplyStateLabel(order.state)}
                />
              </TableCell>
              <TableCell className="hidden xl:table-cell">
                <span className="font-mono text-xs tabular-nums break-words">
                  {formatTimeslot(order)}
                </span>
              </TableCell>
              <TableCell className="text-right">
                {order.item_count_error ? (
                  <Disclose
                    value={order.item_count_error}
                    className={cn("text-xs", TONE_INK[toneFor("failed")])}
                  />
                ) : (
                  <>
                    <span className="block font-mono text-sm tabular-nums">
                      {formatCount(order.item_count)}
                    </span>
                    <span className="text-meta text-muted-foreground">
                      {formatCount(order.sku_count)} SKU
                    </span>
                  </>
                )}
              </TableCell>
              <TableCell>
                <Button
                  size="xs"
                  variant="outline"
                  aria-label={`详情 ${orderIdentity(order)}`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpen?.(order)
                  }}
                >
                  详情
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function WarehouseStocksTable({
  warehouses,
  loading,
}: {
  warehouses: SupplyWarehouseStockView[]
  loading: boolean
}) {
  return (
    <div
      role="region"
      aria-label="各仓库存表"
      aria-busy={loading}
      tabIndex={0}
      className="max-h-[32rem] overflow-auto rounded-xl border border-border bg-card"
    >
      {loading ? (
        <span role="status" className="sr-only">
          正在读取仓库存…
        </span>
      ) : null}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>仓库</TableHead>
            <TableHead className="w-28 text-right">在库</TableHead>
            <TableHead className="w-28 text-right">预留</TableHead>
            <TableHead className="w-28 text-right">在途供货</TableHead>
            <TableHead className="w-24 text-right">SKU</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {warehouses.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="px-4 py-6">
                <Empty className="border-0 bg-transparent py-8">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      {loading ? <Spinner className="size-4" /> : <Warehouse />}
                    </EmptyMedia>
                    <EmptyTitle>
                      {loading ? "正在读取仓库存…" : "没有仓库存"}
                    </EmptyTitle>
                    <EmptyDescription>
                      {loading
                        ? "正在按 Ozon 仓汇总在库数量。"
                        : "Ozon 未返回任何仓库的在库数量。"}
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </TableCell>
            </TableRow>
          ) : null}
          {warehouses.map((warehouse) => (
            <TableRow key={`${warehouse.warehouse_id}-${warehouse.name}`}>
              <TableCell className="min-w-0">
                <Disclose value={warehouseDisplayName(warehouse)} />
                {warehouse.warehouse_id ? (
                  <IdCode value={warehouse.warehouse_id} className="mt-1" />
                ) : null}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCount(warehouse.present)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCount(warehouse.reserved)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCount(warehouse.promised)}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">
                {formatCount(warehouse.sku_count)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

function SupplyDetailDialog({
  order,
  onOpenChange,
}: {
  order: SupplyOrderView | null
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={Boolean(order)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="font-mono text-sm break-all">
            {order ? orderIdentity(order) : "供货单"}
          </DialogTitle>
          <DialogDescription>
            供货写入（创建、预约时间窗、改件数）尚未接入。这是发往 Ozon 仓的只读队列。
          </DialogDescription>
        </DialogHeader>
        {order ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <KeyValueGrid className="sm:grid-cols-2">
              <KeyValue
                label="状态"
                value={
                  <StateChip
                    status={order.state || "UNSPECIFIED"}
                    label={supplyStateLabel(order.state)}
                  />
                }
              />
              <KeyValue
                label="目标仓库"
                value={order.target_warehouse_name || "—"}
              />
              <KeyValue label="时间窗" value={formatTimeslot(order)} mono />
              <KeyValue
                label="件数"
                value={
                  order.item_count_error ||
                  `${formatCount(order.item_count)} · ${formatCount(order.sku_count)} SKU`
                }
                mono
              />
            </KeyValueGrid>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Disclose({
  value,
  className,
}: {
  value: string
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "line-clamp-2 max-w-[36ch] cursor-pointer break-words text-left text-compact focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
              className,
            )}
          />
        }
      >
        {value}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm">{value}</TooltipContent>
    </Tooltip>
  )
}

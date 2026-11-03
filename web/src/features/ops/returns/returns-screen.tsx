import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, Copy, ListFilter, RefreshCw, Search, SlidersHorizontal, Undo2 } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type { OzonStoreView, OpsCancellationRowView, OpsCancellationsListView, OpsReturnRowView, OpsReturnsListView } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import {
  cloudConfiguredStores,
  rosterHasUnavailableStores,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import {
  OpsStoreSelect,
  useOpsStoreRoster,
} from "@/features/ops/ops-store-roster"
import { PageToolbar } from "@/components/page-toolbar"
import { useScreenActive } from "@/components/screen-pane"
import { KeyValue, KeyValueGrid } from "@/components/section"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clearLive, notifyError, notifyLive, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { StoreGate } from "@/features/stores/store-gate"

import {
  EMPTY_CANCELLATIONS,
  EMPTY_RETURNS,
  cancellationStatusLabel,
  displayReason,
  formatOccurredAt,
  isAuthError,
  initiatorLabel,
  loadOpsListPage,
  statusLabel,
  type OpsListError,
  type OpsListState,
} from "./returns-model"

type ReturnsScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const EMPTY_RETURN_STATE: OpsListState<OpsReturnsListView> = {
  loading: false,
  loadingMore: false,
  error: null,
  view: EMPTY_RETURNS,
}

const EMPTY_CANCELLATION_STATE: OpsListState<OpsCancellationsListView> = {
  loading: false,
  loadingMore: false,
  error: null,
  view: EMPTY_CANCELLATIONS,
}

const RETURNS_READ_LIVE = "returns-read"

export function ReturnsScreen({ workspaceId, onOpenStores }: ReturnsScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [stores, setStores] = useState<OzonStoreView[]>([])
  const [hasUnavailableStores, setHasUnavailableStores] = useState(false)
  const [storeId, setStoreId] = useState("")
  const [returnPosting, setReturnPosting] = useState("")
  const [returnSchema, setReturnSchema] = useState("")
  const [returnStatus, setReturnStatus] = useState("")
  const [cancelPosting, setCancelPosting] = useState("")
  const [cancelState, setCancelState] = useState("ON_APPROVAL")
  const [cancelInitiator, setCancelInitiator] = useState("")
  const [returns, setReturns] = useState(EMPTY_RETURN_STATE)
  const [cancellations, setCancellations] = useState(EMPTY_CANCELLATION_STATE)
  const appliedReturns = useRef({ posting: "", schema: "", status: "" })
  const appliedCancellations = useRef({ posting: "", state: "ON_APPROVAL", initiator: "" })
  const returnsSequence = useRef(0)
  const cancellationsSequence = useRef(0)
  const storesRef = useRef(stores)
  const storeIdRef = useRef(storeId)
  storesRef.current = stores
  storeIdRef.current = storeId

  const { storesLoading, storesError, storesReason, retryStores } =
    useOpsStoreRoster({
      workspaceId,
      active,
      hasStores: () => storesRef.current.length > 0,
      onInvalidate: () => {
        returnsSequence.current += 1
        cancellationsSequence.current += 1
      },
      onRosterMiss: () => {
        if (storesRef.current.length === 0) setStoreId("")
      },
    })

  useEffect(() => {
    if (!roster) return
    const configured = cloudConfiguredStores(roster.overview)
    setHasUnavailableStores(rosterHasUnavailableStores(roster.overview))
    setStores(configured)
    const current = storeIdRef.current
    const selected = configured.some((store) => store.id === current)
      ? current
      : (roster.overview.active_id &&
          configured.find((store) => store.id === roster.overview.active_id)?.id) ||
        configured[0]?.id ||
        ""
    if (selected !== current) {
      returnsSequence.current += 1
      cancellationsSequence.current += 1
      setReturns({ ...EMPTY_RETURN_STATE, loading: Boolean(selected) })
      setCancellations({
        ...EMPTY_CANCELLATION_STATE,
        loading: Boolean(selected),
      })
      setStoreId(selected)
    }
  }, [roster])

  const loadReturns = useCallback(
    async (targetStore: string, append: boolean) => {
      if (!targetStore) return
      const filters = append ? appliedReturns.current : {
        posting: returnPosting.trim(),
        schema: returnSchema,
        status: returnStatus.trim(),
      }
      if (!append) appliedReturns.current = filters
      const sequence = ++returnsSequence.current
      await loadOpsListPage({
        append,
        request: () =>
          opsHttp.opsReturnsList({
            store_id: targetStore,
            posting_number: filters.posting,
            visual_status_name: filters.status,
            return_schema: filters.schema,
            last_id: append ? returns.view.last_id : undefined,
          }),
        isCurrent: () => sequence === returnsSequence.current,
        setState: setReturns,
        fallback: "无法读取退货单。",
      })
    },
    [returnPosting, returnSchema, returnStatus, returns.view.last_id],
  )

  const loadCancellations = useCallback(
    async (targetStore: string, append: boolean, state = cancelState) => {
      if (!targetStore) return
      const filters = append ? appliedCancellations.current : {
        posting: cancelPosting.trim(),
        state,
        initiator: cancelInitiator,
      }
      if (!append) appliedCancellations.current = filters
      const sequence = ++cancellationsSequence.current
      await loadOpsListPage({
        append,
        request: () =>
          opsHttp.opsCancellationsList({
            store_id: targetStore,
            posting_number: filters.posting,
            state: filters.state,
            initiator: filters.initiator,
            last_id: append ? cancellations.view.last_id : undefined,
          }),
        isCurrent: () => sequence === cancellationsSequence.current,
        setState: setCancellations,
        fallback: "无法读取取消申请。",
      })
    },
    [cancelInitiator, cancelPosting, cancelState, cancellations.view.last_id],
  )

  const readError = returns.error ?? cancellations.error
  // Refs keep the live notice's retry pointed at the latest loaders without
  // re-firing the effect (and re-toasting) whenever filters rebuild them.
  const loadReturnsRef = useRef(loadReturns)
  const loadCancellationsRef = useRef(loadCancellations)
  loadReturnsRef.current = loadReturns
  loadCancellationsRef.current = loadCancellations

  useEffect(() => {
    if (!readError) {
      clearLive(RETURNS_READ_LIVE)
      return
    }
    notifyLive({
      id: RETURNS_READ_LIVE,
      type: "error",
      reason: readError.reason,
      title: [readError.message, readError.remediation].filter(Boolean).join(" "),
      action: {
        label: "重试",
        onClick: () => {
          if (returns.error) {
            void loadReturnsRef.current(storeIdRef.current, returns.error.retry === "append")
          }
          if (cancellations.error) {
            void loadCancellationsRef.current(
              storeIdRef.current,
              cancellations.error.retry === "append",
            )
          }
        },
      },
    })
    return () => clearLive(RETURNS_READ_LIVE)
  }, [returns.error, cancellations.error])

  useEffect(() => {
    if (!active || !storeId) return
    void loadReturns(storeId, false)
    void loadCancellations(storeId, false)
    // First paint for a store: posting/status filters are applied when the
    // operator clicks 筛选, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store switch only
  }, [active, storeId])

  return (
    <ReturnsScreenView
      storesLoading={storesLoading}
      storesError={storesError}
      storesReason={storesReason}
      stores={stores}
      hasUnavailableStores={hasUnavailableStores}
      storeId={storeId}
      onStoreChange={(next) => {
        if (next === storeId) return
        returnsSequence.current += 1
        cancellationsSequence.current += 1
        setReturns({ ...EMPTY_RETURN_STATE, loading: true })
        setCancellations({ ...EMPTY_CANCELLATION_STATE, loading: true })
        setStoreId(next)
      }}
      onRetryStores={retryStores}
      onOpenStores={onOpenStores}
      returnPosting={returnPosting}
      returnSchema={returnSchema}
      returnStatus={returnStatus}
      onReturnPostingChange={setReturnPosting}
      onReturnSchemaChange={setReturnSchema}
      onReturnStatusChange={setReturnStatus}
      onApplyReturnFilters={() => void loadReturns(storeId, false)}
      onRefreshReturns={() => void loadReturns(storeId, false)}
      onLoadMoreReturns={() => void loadReturns(storeId, true)}
      returnsFiltersDirty={returnPosting.trim() !== appliedReturns.current.posting ||
        returnSchema !== appliedReturns.current.schema || returnStatus.trim() !== appliedReturns.current.status}
      returns={returns}
      cancelPosting={cancelPosting}
      cancelState={cancelState}
      cancelInitiator={cancelInitiator}
      onCancelPostingChange={setCancelPosting}
      onCancelStateChange={(next) => {
        setCancelState(next)
        void loadCancellations(storeId, false, next)
      }}
      onCancelInitiatorChange={setCancelInitiator}
      onApplyCancelFilters={() => void loadCancellations(storeId, false)}
      onRefreshCancellations={() => void loadCancellations(storeId, false)}
      onLoadMoreCancellations={() => void loadCancellations(storeId, true)}
      cancellationsFiltersDirty={cancelPosting.trim() !== appliedCancellations.current.posting ||
        cancelState !== appliedCancellations.current.state || cancelInitiator !== appliedCancellations.current.initiator}
      cancellations={cancellations}
    />
  )
}

export type ReturnsScreenViewProps = {
  storesLoading: boolean
  storesError: string
  storesReason?: unknown
  stores: OzonStoreView[]
  hasUnavailableStores: boolean
  storeId: string
  onStoreChange: (id: string) => void
  onRetryStores: () => void
  onOpenStores?: () => void
  returnPosting: string
  returnSchema: string
  returnStatus: string
  onReturnPostingChange: (value: string) => void
  onReturnSchemaChange: (value: string) => void
  onReturnStatusChange: (value: string) => void
  onApplyReturnFilters: () => void
  onRefreshReturns: () => void
  onLoadMoreReturns: () => void
  returnsFiltersDirty: boolean
  returns: OpsListState<OpsReturnsListView>
  cancelPosting: string
  cancelState: string
  cancelInitiator: string
  onCancelPostingChange: (value: string) => void
  onCancelStateChange: (value: string) => void
  onCancelInitiatorChange: (value: string) => void
  onApplyCancelFilters: () => void
  onRefreshCancellations: () => void
  onLoadMoreCancellations: () => void
  cancellationsFiltersDirty: boolean
  cancellations: OpsListState<OpsCancellationsListView>
}

type ClaimDialogState =
  | { kind: "return"; row: OpsReturnRowView }
  | { kind: "cancellation"; row: OpsCancellationRowView }

export function ReturnsScreenView(props: ReturnsScreenViewProps) {
  const [tab, setTab] = useState("returns")
  const [sheet, setSheet] = useState<ClaimDialogState | null>(null)
  const storeName = props.stores.find((store) => store.id === props.storeId)?.label || "—"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden scroll-pt-14">
      <StoreGate
        loading={props.storesLoading}
        error={props.storesError}
        reason={props.storesReason}
        storeCount={props.stores.length}
        hasUnavailableStores={props.hasUnavailableStores}
        onRetry={props.onRetryStores}
        onOpenStores={props.onOpenStores}
      >
        <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1">
          <div className="border-b border-border">
            <TabsList variant="line" aria-label="退货队列" className="w-full">
              <TabsIndicator variant="line" />
              <TabsTrigger variant="line" value="returns">
                退货单
              </TabsTrigger>
              <TabsTrigger variant="line" value="cancellations">
                取消申请
                {props.cancellations.view.counter > 0 ? (
                  <span className="font-mono tabular-nums">
                    {props.cancellations.view.counter.toLocaleString()}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>
          </div>
          <PageToolbar
            primary={
              <>
                <div className="w-56 rounded-lg border border-border bg-card p-2 max-md:w-full">
                  <Field>
                    <FieldLabel>Ozon 店铺</FieldLabel>
                    <OpsStoreSelect
                      value={props.storeId}
                      stores={props.stores.map((store) => ({
                        storeUid: store.id,
                        name: store.label,
                        clientId: store.client_id,
                      }))}
                      onChange={props.onStoreChange}
                      triggerClassName="w-full"
                    />
                  </Field>
                </div>
                <div hidden={tab !== "returns"} className="flex flex-wrap items-center gap-2 max-md:w-full">
                  <div className="w-52 rounded-lg border border-border bg-card p-2 max-md:w-[calc(50%-0.25rem)]">
                    <Field>
                      <FieldLabel htmlFor="ops-return-posting">发货单号</FieldLabel>
                      <div className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="ops-return-posting"
                          value={props.returnPosting}
                          aria-label="按发货单号搜索退货单"
                          placeholder="输入发货单号"
                          className="h-8 pl-8 font-mono max-md:min-h-11"
                          onChange={(event) => props.onReturnPostingChange(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") props.onApplyReturnFilters()
                          }}
                        />
                      </div>
                    </Field>
                  </div>
                  <div className="w-36 rounded-lg border border-border bg-card p-2 max-md:w-[calc(50%-0.25rem)]">
                    <Field>
                      <FieldLabel>履约模式</FieldLabel>
                      <Select
                        value={props.returnSchema || "all"}
                        onValueChange={(next) =>
                          props.onReturnSchemaChange(next === "all" ? "" : (next ?? ""))
                        }
                      >
                        <SelectTrigger className="min-w-28" size="sm" aria-label="退货履约模式">
                          <SelectValue>{() => props.returnSchema || "全部履约模式"}</SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">全部履约模式</SelectItem>
                          <SelectItem value="FBO">FBO</SelectItem>
                          <SelectItem value="FBS">FBS</SelectItem>
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div className="w-52 rounded-lg border border-border bg-card p-2 max-md:w-[calc(50%-0.25rem)]">
                    <Field>
                      <FieldLabel htmlFor="ops-return-status">退货状态</FieldLabel>
                      <div className="relative min-w-0 flex-1">
                        <SlidersHorizontal className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                        <Input
                          id="ops-return-status"
                          value={props.returnStatus}
                          aria-label="按退货状态搜索"
                          placeholder="Ozon 状态名称"
                          className="h-8 pl-8 max-md:min-h-11"
                          onChange={(event) => props.onReturnStatusChange(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") props.onApplyReturnFilters()
                          }}
                        />
                      </div>
                    </Field>
                  </div>
                  <Button
                    aria-label="筛选退货单"
                    size="sm"
                    variant="outline"
                    onClick={props.onApplyReturnFilters}
                  >
                    <ListFilter data-icon="inline-start" /> 筛选
                  </Button>
                  <Button
                    aria-label={props.returns.loading ? "正在刷新退货单" : "刷新退货单"}
                    aria-busy={props.returns.loading}
                    size="sm"
                    variant="outline"
                    disabled={!props.storeId || props.returns.loading}
                    onClick={props.onRefreshReturns}
                  >
                    <RefreshCw data-icon="inline-start" className={cn(props.returns.loading && "animate-spin")} /> 刷新
                  </Button>
                </div>
                <div hidden={tab !== "cancellations"} className="flex flex-wrap items-center gap-2 max-md:w-full">
                  <Tabs
                    value={props.cancelState === "ON_APPROVAL" ? "pending" : "all"}
                    onValueChange={(next) =>
                      props.onCancelStateChange(next === "pending" ? "ON_APPROVAL" : "")
                    }
                  >
                    <TabsList aria-label="取消申请队列">
                      <TabsIndicator />
                      <TabsTrigger value="pending" className="h-7">
                        待处理
                      </TabsTrigger>
                      <TabsTrigger value="all" className="h-7">
                        全部
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                    <div className="w-52 rounded-lg border border-border bg-card p-2 max-md:w-[calc(50%-0.25rem)]">
                      <Field>
                        <FieldLabel htmlFor="ops-cancel-posting">发货单号</FieldLabel>
                        <div className="relative min-w-0 flex-1">
                          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                          <Input
                            id="ops-cancel-posting"
                            value={props.cancelPosting}
                            aria-label="按发货单号搜索取消申请"
                            placeholder="输入发货单号"
                            className="h-8 pl-8 font-mono max-md:min-h-11"
                            onChange={(event) => props.onCancelPostingChange(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") props.onApplyCancelFilters()
                            }}
                          />
                        </div>
                      </Field>
                    </div>
                    <div className="w-36 rounded-lg border border-border bg-card p-2 max-md:w-[calc(50%-0.25rem)]">
                      <Field>
                        <FieldLabel>发起方</FieldLabel>
                        <Select
                          value={props.cancelInitiator || "all"}
                          onValueChange={(next) =>
                            props.onCancelInitiatorChange(next === "all" ? "" : (next ?? ""))
                          }
                        >
                          <SelectTrigger className="min-w-32" size="sm" aria-label="取消申请发起方">
                            <SelectValue>
                              {() =>
                                props.cancelInitiator
                                  ? initiatorLabel(props.cancelInitiator)
                                  : "全部发起方"
                              }
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="all">全部发起方</SelectItem>
                            <SelectItem value="OZON">{initiatorLabel("OZON")}</SelectItem>
                            <SelectItem value="SELLER">{initiatorLabel("SELLER")}</SelectItem>
                            <SelectItem value="CLIENT">{initiatorLabel("CLIENT")}</SelectItem>
                            <SelectItem value="SYSTEM">{initiatorLabel("SYSTEM")}</SelectItem>
                            <SelectItem value="DELIVERY">{initiatorLabel("DELIVERY")}</SelectItem>
                          </SelectContent>
                        </Select>
                      </Field>
                    </div>
                    <Button
                      aria-label="筛选取消申请"
                      size="sm"
                      variant="outline"
                      onClick={props.onApplyCancelFilters}
                    >
                      <ListFilter data-icon="inline-start" /> 筛选
                    </Button>
                    <Button
                      aria-label={props.cancellations.loading ? "正在刷新取消申请" : "刷新取消申请"}
                      aria-busy={props.cancellations.loading}
                      size="sm"
                      variant="outline"
                      disabled={!props.storeId || props.cancellations.loading}
                      onClick={props.onRefreshCancellations}
                    >
                      <RefreshCw data-icon="inline-start" className={cn(props.cancellations.loading && "animate-spin")} /> 刷新
                    </Button>
                  </div>
                </>
              }
            />

            <div
              hidden={tab !== "returns"}
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto"
            >
              <ReturnsTable
                key={props.storeId}
                state={props.returns}
                storeName={storeName}
                filtersDirty={props.returnsFiltersDirty}
                onRetry={props.onRefreshReturns}
                onLoadMore={props.onLoadMoreReturns}
                onOpen={(row) => setSheet({ kind: "return", row })}
              />
            </div>

            <div
              hidden={tab !== "cancellations"}
              className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto"
            >
              <CancellationsTable
                state={props.cancellations}
                storeName={storeName}
                filtersDirty={props.cancellationsFiltersDirty}
                onRetry={props.onRefreshCancellations}
                onLoadMore={props.onLoadMoreCancellations}
                onOpen={(row) => setSheet({ kind: "cancellation", row })}
              />
            </div>
        </Tabs>
      </StoreGate>

      <ClaimDialog
        sheet={sheet}
        onOpenChange={(next) => {
          if (!next) setSheet(null)
        }}
      />
    </div>
  )
}

function ReturnsTable({
  state,
  storeName,
  filtersDirty,
  onRetry,
  onLoadMore,
  onOpen,
}: {
  state: OpsListState<OpsReturnsListView>
  storeName: string
  filtersDirty: boolean
  onRetry: () => void
  onLoadMore: () => void
  onOpen: (row: OpsReturnRowView) => void
}) {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const rowsWithIds = state.view.items.filter((row) => Boolean(row.id))
  const selectedRows = rowsWithIds.filter((row) => selectedIds.has(row.id))
  const allSelected = rowsWithIds.length > 0 && selectedRows.length === rowsWithIds.length

  useEffect(() => {
    if (filtersDirty || state.loading) setSelectedIds(new Set())
  }, [filtersDirty, state.loading])

  const copySelected = async () => {
    try {
      await navigator.clipboard.writeText(selectedRows.map((row) => row.id).join("\n"))
      notifySuccess(`已复制 ${selectedRows.length} 条退货单号`)
    } catch {
      notifyError("无法复制退货单号，请检查浏览器剪贴板权限。")
    }
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={state.loading || state.loadingMore}
    >
      <Table className="min-w-[62rem]" containerClassName="@container min-h-0 flex-1 overflow-auto">
        <TableHeader className="sticky top-0 z-10">
          <TableRow>
            <TableHead className="w-10">
              <Checkbox
                aria-label="选择已加载的全部退货单"
                checked={allSelected}
                indeterminate={selectedRows.length > 0 && !allSelected}
                disabled={filtersDirty || state.loading || rowsWithIds.length === 0}
                onCheckedChange={(checked) => setSelectedIds(checked ? new Set(rowsWithIds.map((row) => row.id)) : new Set())}
              />
            </TableHead>
            <TableHead className="w-40">退货单号</TableHead>
            <TableHead className="w-48">发货单号</TableHead>
            <TableHead className="w-36">Ozon 店铺</TableHead>
            <TableHead>原因</TableHead>
            <TableHead className="w-40">退货状态</TableHead>
            <TableHead className="w-40">申请时间</TableHead>
            <TableHead className="w-24">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.loading && state.view.items.length === 0 ? (
            <StatusRow colSpan={8} spinning>
              正在读取退货单…
            </StatusRow>
          ) : state.error && state.view.items.length === 0 ? (
            <StatusRow colSpan={8} error={state.error} onRetry={onRetry} />
          ) : state.view.items.length === 0 ? (
            <StatusRow colSpan={8} icon>
              没有退货单
            </StatusRow>
          ) : (
            state.view.items.map((row) => (
              <ReturnRow
                key={row.id || row.posting_number}
                row={row}
                storeName={storeName}
                selected={selectedIds.has(row.id)}
                selectionDisabled={filtersDirty || state.loading}
                onSelect={(checked) => setSelectedIds((current) => {
                  const next = new Set(current)
                  if (checked) next.add(row.id)
                  else next.delete(row.id)
                  return next
                })}
                onOpen={onOpen}
              />
            ))
          )}
        </TableBody>
      </Table>
      {selectedRows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2">
          <span className="text-compact text-muted-foreground">已选择 {selectedRows.length} 条</span>
          <Button size="sm" variant="outline" disabled={filtersDirty || state.loading} onClick={() => void copySelected()}>
            <Copy data-icon="inline-start" /> 复制退货单号
          </Button>
        </div>
      ) : null}
      <ListPageTail
        hasNext={state.view.has_next}
        hasRows={state.view.items.length > 0}
        rowCount={state.view.items.length}
        filtersDirty={filtersDirty}
        loading={state.loading}
        loadingMore={state.loadingMore}
        error={state.error}
        onRetry={onRetry}
        onLoadMore={onLoadMore}
      />
    </div>
  )
}

function CancellationsTable({
  state,
  storeName,
  filtersDirty,
  onRetry,
  onLoadMore,
  onOpen,
}: {
  state: OpsListState<OpsCancellationsListView>
  storeName: string
  filtersDirty: boolean
  onRetry: () => void
  onLoadMore: () => void
  onOpen: (row: OpsCancellationRowView) => void
}) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={state.loading || state.loadingMore}
    >
      <Table className="min-w-[62rem]" containerClassName="@container min-h-0 flex-1 overflow-auto">
        <TableHeader className="sticky top-0 z-10">
          <TableRow>
            <TableHead className="w-40">申请单号</TableHead>
            <TableHead className="w-48">发货单号</TableHead>
            <TableHead className="w-36">店铺</TableHead>
            <TableHead>原因</TableHead>
            <TableHead className="w-40">状态</TableHead>
            <TableHead className="w-40">时间</TableHead>
            <TableHead className="w-40">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.loading && state.view.items.length === 0 ? (
            <StatusRow colSpan={7} spinning>
              正在读取取消申请…
            </StatusRow>
          ) : state.error && state.view.items.length === 0 ? (
            <StatusRow colSpan={7} error={state.error} onRetry={onRetry} />
          ) : state.view.items.length === 0 ? (
            <StatusRow colSpan={7} icon>
              没有取消申请
            </StatusRow>
          ) : (
            state.view.items.map((row) => (
              <CancellationRow
                key={row.cancellation_id || row.posting_number}
                row={row}
                storeName={storeName}
                onOpen={onOpen}
              />
            ))
          )}
        </TableBody>
      </Table>
      <ListPageTail
        hasNext={state.view.has_next}
        hasRows={state.view.items.length > 0}
        rowCount={state.view.items.length}
        filtersDirty={filtersDirty}
        loading={state.loading}
        loadingMore={state.loadingMore}
        error={state.error}
        onRetry={onRetry}
        onLoadMore={onLoadMore}
      />
    </div>
  )
}

export function ListPageTail({
  hasNext,
  hasRows,
  rowCount,
  filtersDirty,
  loading,
  loadingMore,
  error,
  onRetry,
  onLoadMore,
}: {
  hasNext: boolean
  hasRows: boolean
  rowCount: number
  filtersDirty: boolean
  loading: boolean
  loadingMore: boolean
  error: OpsListError | null
  onRetry: () => void
  onLoadMore: () => void
}) {
  if (loading || (!hasRows && !hasNext) || (error && !hasRows)) return null
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/20 px-4 py-2.5">
      <span className="mr-auto text-compact text-muted-foreground">已加载 {rowCount} 条</span>
      {hasNext || error ? <Button
        size="sm"
        variant="ghost"
        disabled={loadingMore || (filtersDirty && (!error || error.retry === "append"))}
        onClick={error && error.retry !== "append" ? onRetry : onLoadMore}
      >
        {loadingMore
          ? "正在加载…"
          : filtersDirty && (!error || error.retry === "append")
            ? "请先筛选"
          : error?.retry === "append"
            ? "重试下一页"
            : error
              ? "重试"
              : "加载下一页"}
      </Button> : null}
    </div>
  )
}

function ReturnRow({
  row,
  storeName,
  selected,
  selectionDisabled,
  onSelect,
  onOpen,
}: {
  row: OpsReturnRowView
  storeName: string
  selected: boolean
  selectionDisabled: boolean
  onSelect: (checked: boolean) => void
  onOpen: (row: OpsReturnRowView) => void
}) {
  return (
    <TableRow data-state={selected ? "selected" : undefined} className="cursor-pointer align-top [&>td]:py-1.5" onClick={() => onOpen(row)}>
      <TableCell>
        <Checkbox
          aria-label={`选择退货单 ${row.id || row.posting_number}`}
          checked={selected}
          disabled={selectionDisabled || !row.id}
          onClick={(event) => event.stopPropagation()}
          onCheckedChange={onSelect}
        />
      </TableCell>
      <TableCell>
        {row.id ? <Button
          variant="link"
          size="xs"
          className="-ml-2 h-auto min-h-6 max-w-full justify-start whitespace-normal"
          aria-label={`查看退货单 ${row.id}`}
          onClick={(event) => { event.stopPropagation(); onOpen(row) }}
        ><span className="font-mono text-compact break-all select-all tabular-nums">{row.id}</span></Button> : "—"}
      </TableCell>
      <TableCell>
        <p className="font-mono text-compact font-medium break-all select-all tabular-nums">
          {row.posting_number || "—"}
        </p>
        {row.offer_id || row.sku ? (
          <p className="mt-1 font-mono text-meta text-muted-foreground">
            {row.offer_id}
            {row.sku ? ` · SKU ${row.sku}` : ""}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="text-compact break-words"><span className="flex items-center gap-2"><StoreIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />{storeName}</span></TableCell>
      <TableCell>
        <Disclose value={displayReason(row.reason)} />
      </TableCell>
      <TableCell>
        <StateChip status={row.status || "unknown"} label={statusLabel(row)} />
        {row.schema ? (
          <p className="mt-1 font-mono text-meta text-muted-foreground">{row.schema}</p>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-compact tabular-nums text-muted-foreground whitespace-nowrap">
        {formatOccurredAt(row.occurred_at)}
      </TableCell>
      <TableCell>
        <Button
          aria-label={`查看 ${row.posting_number || row.id}`}
          variant="outline"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            onOpen(row)
          }}
        >查看</Button>
      </TableCell>
    </TableRow>
  )
}

function CancellationRow({
  row,
  storeName,
  onOpen,
}: {
  row: OpsCancellationRowView
  storeName: string
  onOpen: (row: OpsCancellationRowView) => void
}) {
  return (
    <TableRow className="cursor-pointer align-top [&>td]:py-1.5" onClick={() => onOpen(row)}>
      <TableCell>
        {row.cancellation_id ? <Button
          variant="link"
          size="xs"
          className="-ml-2 h-auto min-h-6 max-w-full justify-start whitespace-normal"
          aria-label={`查看取消申请 ${row.cancellation_id}`}
          onClick={(event) => { event.stopPropagation(); onOpen(row) }}
        ><span className="font-mono text-compact break-all select-all tabular-nums">{row.cancellation_id}</span></Button> : "—"}
      </TableCell>
      <TableCell>
        <p className="font-mono text-compact font-medium break-all select-all tabular-nums">
          {row.posting_number || "—"}
        </p>
      </TableCell>
      <TableCell className="text-compact break-words"><span className="flex items-center gap-2"><StoreIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />{storeName}</span></TableCell>
      <TableCell>
        <Disclose value={displayReason(row.reason)} />
      </TableCell>
      <TableCell>
        <StateChip status={row.status || "unknown"} label={cancellationStatusLabel(row)} />
        {row.initiator ? (
          <p className="mt-1 text-meta text-muted-foreground">
            {initiatorLabel(row.initiator)}
          </p>
        ) : null}
      </TableCell>
      <TableCell className="font-mono text-compact tabular-nums text-muted-foreground whitespace-nowrap">
        {formatOccurredAt(row.occurred_at)}
      </TableCell>
      <TableCell>
        <Button
          aria-label={`查看 ${row.posting_number || row.cancellation_id}`}
          variant="outline"
          size="xs"
          onClick={(event) => {
            event.stopPropagation()
            onOpen(row)
          }}
        >查看</Button>
      </TableCell>
    </TableRow>
  )
}

function ClaimDialog({
  sheet,
  onOpenChange,
}: {
  sheet: ClaimDialogState | null
  onOpenChange: (open: boolean) => void
}) {
  const cancel = sheet?.kind === "cancellation" ? sheet.row : null
  const returning = sheet?.kind === "return" ? sheet.row : null
  return (
    <Dialog open={Boolean(sheet)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="font-mono text-sm break-all">
            {returning?.posting_number || cancel?.posting_number || "退货"}
          </DialogTitle>
          <DialogDescription>
            {sheet?.kind === "cancellation"
              ? "取消申请为只读信息；同意或拒绝请到 Ozon 后台处理。"
              : "退货单是只读投影。争议与退款在 Ozon 后台完成。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <KeyValueGrid className="sm:grid-cols-2 lg:grid-cols-2">
            <KeyValue
              label={returning ? "退货单号" : "申请单号"}
              value={returning?.id || cancel?.cancellation_id || "—"}
              mono
            />
            <KeyValue
              label="发货单号"
              value={returning?.posting_number || cancel?.posting_number || "—"}
              mono
            />
            <KeyValue
              label="状态"
              value={
                returning ? (
                  <StateChip
                    status={returning.status || "unknown"}
                    label={statusLabel(returning)}
                  />
                ) : cancel ? (
                  <StateChip
                    status={cancel.status || "unknown"}
                    label={cancellationStatusLabel(cancel)}
                  />
                ) : (
                  "—"
                )
              }
            />
            <KeyValue
              label="时间"
              value={formatOccurredAt(returning?.occurred_at || cancel?.occurred_at || "")}
              mono
            />
          </KeyValueGrid>
          <p className="break-words text-sm leading-relaxed">
            {displayReason(returning?.reason || cancel?.reason || "")}
          </p>
          {returning?.product_name ? (
            <p className="break-words text-compact text-muted-foreground">
              {returning.product_name}
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Disclose({ value }: { value: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="line-clamp-3 max-w-[46ch] cursor-pointer break-words text-left text-compact leading-relaxed text-foreground/90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11"
          />
        }
      >
        {value}
      </TooltipTrigger>
      <TooltipContent className="max-w-sm whitespace-pre-wrap">{value}</TooltipContent>
    </Tooltip>
  )
}

function StatusRow({
  colSpan,
  spinning,
  icon,
  error,
  onRetry,
  children,
}: {
  colSpan: number
  spinning?: boolean
  icon?: boolean
  error?: OpsListError
  onRetry?: () => void
  children?: string
}) {
  return (
    <TableRow>
      <TableCell colSpan={colSpan} className="px-4 py-16 text-center">
        <div
          role={spinning ? "status" : undefined}
          aria-live={spinning ? "polite" : undefined}
          className="sticky left-0 w-[calc(100cqw-2rem)] max-w-full"
        >
          {spinning ? (
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
              <RefreshCw className="size-5 animate-spin" />
            </div>
          ) : icon ? (
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-muted/40 text-muted-foreground">
              <Undo2 className="size-5" />
            </div>
          ) : error ? (
            <div className="mx-auto mb-3 flex size-10 items-center justify-center rounded-xl bg-muted/40">
              <AlertTriangle
                className={cn(
                  "size-5",
                  isAuthError(error) ? "text-st-attest-ink" : "text-st-bad-ink",
                )}
              />
            </div>
          ) : null}
          {error ? null : (
            <strong className="block text-sm font-medium text-foreground">
              {children}
            </strong>
          )}
          {error && onRetry ? (
            <Button size="sm" variant="outline" className="mt-3.5" onClick={onRetry}>
              重试
            </Button>
          ) : null}
        </div>
      </TableCell>
    </TableRow>
  )
}

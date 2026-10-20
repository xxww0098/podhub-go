import { useCallback, useEffect, useRef, useState } from "react"
import { AlertTriangle, RefreshCw, Search, SlidersHorizontal, Undo2 } from "lucide-react"

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
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
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
  DialogFooter,
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
import { Textarea } from "@/components/ui/textarea"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clearLive, notifyLive } from "@/lib/notify"
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
      const sequence = ++returnsSequence.current
      await loadOpsListPage({
        append,
        request: () =>
          opsHttp.opsReturnsList({
            store_id: targetStore,
            posting_number: returnPosting.trim(),
            visual_status_name: returnStatus.trim(),
            return_schema: returnSchema,
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
      const sequence = ++cancellationsSequence.current
      await loadOpsListPage({
        append,
        request: () =>
          opsHttp.opsCancellationsList({
            store_id: targetStore,
            posting_number: cancelPosting.trim(),
            state,
            initiator: cancelInitiator,
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
  cancellations: OpsListState<OpsCancellationsListView>
}

type ClaimDialogState =
  | { kind: "return"; row: OpsReturnRowView }
  | { kind: "cancellation"; row: OpsCancellationRowView; action: "approve" | "reject" | "detail" }

export function ReturnsScreenView(props: ReturnsScreenViewProps) {
  const [tab, setTab] = useState("cancellations")
  const [sheet, setSheet] = useState<ClaimDialogState | null>(null)
  const [rejectReason, setRejectReason] = useState("")

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden scroll-pt-14">
      <StoreGate
        loading={props.storesLoading}
        error={props.storesError}
        reason={props.storesReason}
        storeCount={props.stores.length}
        hasUnavailableStores={props.hasUnavailableStores}
        onRetry={props.onRetryStores}
        onOpenStores={props.onOpenStores}
      >
        <>
          <PageToolbar
            primary={
              <OpsStoreSelect
                value={props.storeId}
                stores={props.stores.map((store) => ({
                  storeUid: store.id,
                  name: store.label,
                  clientId: store.client_id,
                }))}
                onChange={props.onStoreChange}
              />
            }
          />

          <Tabs value={tab} onValueChange={setTab} className="gap-3">
            <TabsList aria-label="退货队列">
              <TabsIndicator />
              <TabsTrigger value="returns" className="h-7 px-2.5">
                退货单
              </TabsTrigger>
              <TabsTrigger value="cancellations" className="h-7 px-2.5">
                取消申请
                {props.cancellations.view.counter > 0 ? (
                  <span className="font-mono tabular-nums">
                    {props.cancellations.view.counter.toLocaleString()}
                  </span>
                ) : null}
              </TabsTrigger>
            </TabsList>

            <div
              hidden={tab !== "returns"}
              className="flex flex-col gap-3"
            >
              <div className="flex flex-wrap items-end gap-2">
                <Field className="w-52 gap-1">
                  <FieldLabel htmlFor="ops-return-posting">发货单号</FieldLabel>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="ops-return-posting"
                      value={props.returnPosting}
                      aria-label="按发货单号搜索退货单"
                      className="h-8 pl-8 font-mono"
                      onChange={(event) => props.onReturnPostingChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") props.onApplyReturnFilters()
                      }}
                    />
                  </div>
                </Field>
                <Field className="w-36 gap-1">
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
                <Field className="w-52 gap-1">
                  <FieldLabel htmlFor="ops-return-status">退货状态</FieldLabel>
                  <div className="relative">
                    <SlidersHorizontal className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="ops-return-status"
                      value={props.returnStatus}
                      aria-label="按退货状态搜索"
                      className="h-8 pl-8 font-mono"
                      onChange={(event) => props.onReturnStatusChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") props.onApplyReturnFilters()
                      }}
                    />
                  </div>
                </Field>
                <Button size="sm" variant="secondary" onClick={props.onApplyReturnFilters}>
                  筛选
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.storeId || props.returns.loading}
                  aria-label="刷新退货单"
                  onClick={props.onRefreshReturns}
                >
                  <RefreshCw className={cn(props.returns.loading && "animate-spin")} />
                  刷新
                </Button>
              </div>
              <ReturnsTable
                state={props.returns}
                onRetry={props.onRefreshReturns}
                onLoadMore={props.onLoadMoreReturns}
                onOpen={(row) => setSheet({ kind: "return", row })}
              />
            </div>

            <div
              hidden={tab !== "cancellations"}
              className="flex flex-col gap-3"
            >
              <div className="flex flex-wrap items-end gap-2">
                <Tabs
                  value={props.cancelState === "ON_APPROVAL" ? "pending" : "all"}
                  onValueChange={(next) =>
                    props.onCancelStateChange(next === "pending" ? "ON_APPROVAL" : "")
                  }
                >
                  <TabsList aria-label="取消申请队列">
                    <TabsIndicator />
                    <TabsTrigger value="pending" className="h-7 px-2.5">
                      待处理
                    </TabsTrigger>
                    <TabsTrigger value="all" className="h-7 px-2.5">
                      全部
                    </TabsTrigger>
                  </TabsList>
                </Tabs>
                <Field className="w-52 gap-1">
                  <FieldLabel htmlFor="ops-cancel-posting">发货单号</FieldLabel>
                  <div className="relative">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      id="ops-cancel-posting"
                      value={props.cancelPosting}
                      aria-label="按发货单号搜索取消申请"
                      className="h-8 pl-8 font-mono"
                      onChange={(event) => props.onCancelPostingChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") props.onApplyCancelFilters()
                      }}
                    />
                  </div>
                </Field>
                <Field className="w-36 gap-1">
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
                <Button size="sm" variant="secondary" onClick={props.onApplyCancelFilters}>
                  筛选
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!props.storeId || props.cancellations.loading}
                  aria-label="刷新取消申请"
                  onClick={props.onRefreshCancellations}
                >
                  <RefreshCw className={cn(props.cancellations.loading && "animate-spin")} />
                  刷新
                </Button>
              </div>
              <CancellationsTable
                state={props.cancellations}
                onRetry={props.onRefreshCancellations}
                onLoadMore={props.onLoadMoreCancellations}
                onOpen={(row, action) => {
                  setRejectReason("")
                  setSheet({ kind: "cancellation", row, action })
                }}
              />
            </div>
          </Tabs>
        </>
      </StoreGate>

      <ClaimDialog
        sheet={sheet}
        rejectReason={rejectReason}
        onRejectReason={setRejectReason}
        onOpenChange={(next) => {
          if (!next) setSheet(null)
        }}
      />
    </div>
  )
}

function ReturnsTable({
  state,
  onRetry,
  onLoadMore,
  onOpen,
}: {
  state: OpsListState<OpsReturnsListView>
  onRetry: () => void
  onLoadMore: () => void
  onOpen: (row: OpsReturnRowView) => void
}) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={state.loading || state.loadingMore}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-52">单号</TableHead>
            <TableHead>原因</TableHead>
            <TableHead className="w-40">状态</TableHead>
            <TableHead className="w-40">时间</TableHead>
            <TableHead className="w-24">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.loading && state.view.items.length === 0 ? (
            <StatusRow colSpan={5} spinning>
              正在读取退货单…
            </StatusRow>
          ) : state.error && state.view.items.length === 0 ? (
            <StatusRow colSpan={5} error={state.error} onRetry={onRetry} />
          ) : state.view.items.length === 0 ? (
            <StatusRow colSpan={5} icon>
              没有退货单
            </StatusRow>
          ) : (
            state.view.items.map((row) => (
              <ReturnRow key={row.id || row.posting_number} row={row} onOpen={onOpen} />
            ))
          )}
        </TableBody>
      </Table>
      <ListPageTail
        hasNext={state.view.has_next}
        hasRows={state.view.items.length > 0}
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
  onRetry,
  onLoadMore,
  onOpen,
}: {
  state: OpsListState<OpsCancellationsListView>
  onRetry: () => void
  onLoadMore: () => void
  onOpen: (row: OpsCancellationRowView, action: "approve" | "reject" | "detail") => void
}) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={state.loading || state.loadingMore}
    >
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-52">单号</TableHead>
            <TableHead>原因</TableHead>
            <TableHead className="w-40">状态</TableHead>
            <TableHead className="w-40">时间</TableHead>
            <TableHead className="w-40">操作</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {state.loading && state.view.items.length === 0 ? (
            <StatusRow colSpan={5} spinning>
              正在读取取消申请…
            </StatusRow>
          ) : state.error && state.view.items.length === 0 ? (
            <StatusRow colSpan={5} error={state.error} onRetry={onRetry} />
          ) : state.view.items.length === 0 ? (
            <StatusRow colSpan={5} icon>
              没有取消申请
            </StatusRow>
          ) : (
            state.view.items.map((row) => (
              <CancellationRow
                key={row.cancellation_id || row.posting_number}
                row={row}
                onOpen={onOpen}
              />
            ))
          )}
        </TableBody>
      </Table>
      <ListPageTail
        hasNext={state.view.has_next}
        hasRows={state.view.items.length > 0}
        loading={state.loading}
        loadingMore={state.loadingMore}
        error={state.error}
        onRetry={onRetry}
        onLoadMore={onLoadMore}
      />
    </div>
  )
}

function ListPageTail({
  hasNext,
  hasRows,
  loading,
  loadingMore,
  error,
  onRetry,
  onLoadMore,
}: {
  hasNext: boolean
  hasRows: boolean
  loading: boolean
  loadingMore: boolean
  error: OpsListError | null
  onRetry: () => void
  onLoadMore: () => void
}) {
  if (loading || (!hasNext && !error) || (error && !hasRows)) return null
  return (
    <div className="flex flex-wrap items-center gap-3 border-t border-border bg-muted/20 px-4 py-2.5">
      <Button
        size="sm"
        variant="ghost"
        disabled={loadingMore}
        onClick={error?.retry === "append" ? onLoadMore : onRetry}
      >
        {loadingMore
          ? "正在加载…"
          : error?.retry === "append"
            ? "重试下一页"
            : error
              ? "重试"
              : "加载下一页"}
      </Button>
    </div>
  )
}

function ReturnRow({
  row,
  onOpen,
}: {
  row: OpsReturnRowView
  onOpen: (row: OpsReturnRowView) => void
}) {
  return (
    <TableRow className="cursor-pointer align-top" onClick={() => onOpen(row)}>
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
          size="xs"
          variant="outline"
          aria-label={`详情 ${row.posting_number || row.id}`}
          onClick={(event) => {
            event.stopPropagation()
            onOpen(row)
          }}
        >
          详情
        </Button>
      </TableCell>
    </TableRow>
  )
}

function CancellationRow({
  row,
  onOpen,
}: {
  row: OpsCancellationRowView
  onOpen: (row: OpsCancellationRowView, action: "approve" | "reject" | "detail") => void
}) {
  const pending = row.status === "ON_APPROVAL"
  return (
    <TableRow
      className="cursor-pointer align-top"
      onClick={() => onOpen(row, pending ? "approve" : "detail")}
    >
      <TableCell>
        <p className="font-mono text-compact font-medium break-all select-all tabular-nums">
          {row.posting_number || "—"}
        </p>
        <p className="mt-1 font-mono text-meta text-muted-foreground tabular-nums">
          {row.cancellation_id || initiatorLabel(row.initiator)}
        </p>
      </TableCell>
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
        <div className="flex flex-wrap items-center gap-1">
          {pending ? (
            <>
              <Button
                size="xs"
                variant="outline"
                aria-label={`同意 ${row.posting_number || row.cancellation_id}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpen(row, "approve")
                }}
              >
                同意
              </Button>
              <Button
                size="xs"
                variant="destructive"
                aria-label={`拒绝 ${row.posting_number || row.cancellation_id}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onOpen(row, "reject")
                }}
              >
                拒绝
              </Button>
            </>
          ) : (
            <Button
              size="xs"
              variant="outline"
              aria-label={`详情 ${row.posting_number || row.cancellation_id}`}
              onClick={(event) => {
                event.stopPropagation()
                onOpen(row, "detail")
              }}
            >
              详情
            </Button>
          )}
        </div>
      </TableCell>
    </TableRow>
  )
}

function ClaimDialog({
  sheet,
  rejectReason,
  onRejectReason,
  onOpenChange,
}: {
  sheet: ClaimDialogState | null
  rejectReason: string
  onRejectReason: (value: string) => void
  onOpenChange: (open: boolean) => void
}) {
  const cancel = sheet?.kind === "cancellation" ? sheet.row : null
  const returning = sheet?.kind === "return" ? sheet.row : null
  const reject = sheet?.kind === "cancellation" && sheet.action === "reject"
  return (
    <Dialog open={Boolean(sheet)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="font-mono text-sm break-all">
            {returning?.posting_number || cancel?.posting_number || "退货"}
          </DialogTitle>
          <DialogDescription>
            {sheet?.kind === "cancellation"
              ? "同意 / 拒绝尚未接入 Seller 写接口。核对原因后到 Ozon 后台处理。"
              : "退货单是只读投影。争议与退款在 Ozon 后台完成。"}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          <KeyValueGrid className="sm:grid-cols-2">
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
          {reject ? (
            <Field>
              <FieldLabel htmlFor="ops-cancel-reject-reason">拒绝原因</FieldLabel>
              <Textarea
                id="ops-cancel-reject-reason"
                value={rejectReason}
                onChange={(event) => onRejectReason(event.target.value)}
              />
              <FieldDescription>写接口未接入，这段文字不会发给 Ozon。</FieldDescription>
            </Field>
          ) : null}
        </div>
        {sheet?.kind === "cancellation" && sheet.action !== "detail" ? (
          <DialogFooter className="m-0 shrink-0 rounded-none px-4 py-3">
            <Button type="button" variant="outline" disabled>
              {sheet.action === "reject" ? "拒绝" : "同意"}
            </Button>
          </DialogFooter>
        ) : null}
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
            className="line-clamp-3 max-w-[46ch] cursor-pointer break-words text-left text-compact leading-relaxed text-foreground/90 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
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

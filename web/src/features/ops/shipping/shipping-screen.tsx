import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  Package,
  Printer,
  RefreshCw,
  Truck,
} from "lucide-react"

import type { ShippingListRequest, ShippingListView, ShippingPostingView } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { delegateHttp } from "@/features/delegate/delegate-http"
import {
  delegateBadgeFor,
  type DelegateBadge,
} from "@/features/delegate/delegate-model"
import {
  loadStoreRoster,
  peekStoreRoster,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import {
  OpsStoreSelect,
  opsStoresFromRoster,
  preferredStoreUid,
  type OpsStore,
} from "@/features/ops/ops-store-roster"
import { PageToolbar } from "@/components/page-toolbar"
import { CursorPagerFooter } from "@/components/cursor-pager-footer"
import { useScreenActive } from "@/components/screen-pane"
import { KeyValue, KeyValueGrid, Section } from "@/components/section"
import { StateChip } from "@/components/state-chip"
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
import { clearLive, notifyError, notifyLive } from "@/lib/notify"
import { errorMessage } from "@/lib/error-message"
import { cn } from "@/lib/utils"
import { useVisiblePolling } from "@/lib/visible-polling"
import { StoreGate } from "@/features/stores/store-gate"

import {
  DEFAULT_QUEUE,
  PAGE_SIZE,
  QUEUE_FILTERS,
  SHIPPING_POLL_INTERVAL_MS,
  commandFailure,
  deadlineLabel,
  describeFailure,
  emptyView,
  formatInstant,
  hasUnavailableShippingStores,
  isEmptyShippingAdvance,
  labelPrintLabel,
  packingLabel,
  queueRequest,
  shippingActions,
  shippingStatusLabel,
  shouldStartShippingRead,
  type ShippingAction,
  type ShippingLoadState,
  type ShippingQueue,
} from "./shipping-model"

const SHIPPING_READ_LIVE = "shipping-read"
const DELEGATE_BADGE_LIVE = "delegate-badge-read"

type ShippingScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

export function ShippingScreen({ workspaceId, onOpenStores }: ShippingScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [stores, setStores] = useState<OpsStore[]>([])
  const [storesLoading, setStoresLoading] = useState(true)
  const [storesError, setStoresError] = useState("")
  const [storesReason, setStoresReason] = useState<unknown>()
  const [hasUnavailableStores, setHasUnavailableStores] = useState(false)
  const [rosterRetry, setRosterRetry] = useState(0)
  const [storeUid, setStoreUid] = useState("")
  const [queue, setQueue] = useState<ShippingQueue>(DEFAULT_QUEUE)
  const [cursors, setCursors] = useState([""])
  const [view, setView] = useState<ShippingListView>(emptyView(""))
  const [load, setLoad] = useState<ShippingLoadState>("idle")
  const [open, setOpen] = useState<{
    posting: ShippingPostingView
    action: ShippingAction
  } | null>(null)
  const [delegateBadges, setDelegateBadges] = useState<Record<string, DelegateBadge>>({})
  const requestSequence = useRef(0)
  const badgeSequence = useRef(0)
  const postingInFlight = useRef<number | null>(null)
  const storesRef = useRef(stores)
  storesRef.current = stores
  const storeUidRef = useRef(storeUid)
  storeUidRef.current = storeUid

  const requestFor = useCallback(
    (cursor = cursors.at(-1) ?? ""): ShippingListRequest => {
      const next = queueRequest(queue)
      return {
        store_id: storeUid,
        status: next.status,
        window_days: next.windowDays,
        cursor: cursor || undefined,
        limit: PAGE_SIZE,
      }
    },
    [cursors, queue, storeUid],
  )

  /**
   * 「已委托」只读徽标：列表落定后按本页单号批量读纯 DB 的
   * posting-states，N/M 由 `delegateBadgeFor` 用 covered offer 集合与本页
   * products 自算。纯增强：失败只清徽标并提示一次，不带重试按钮进行内。
   */
  const loadDelegateBadges = useCallback(async (badgeStoreUid: string, page: ShippingPostingView[]) => {
    if (!badgeStoreUid || page.length === 0) {
      setDelegateBadges({})
      return
    }
    const sequence = ++badgeSequence.current
    try {
      const states = await delegateHttp.postingStates(
        badgeStoreUid,
        page.map((posting) => posting.posting_number).slice(0, 200),
      )
      if (sequence !== badgeSequence.current) return
      const next: Record<string, DelegateBadge> = {}
      for (const posting of page) {
        const state = states.find((item) => item.posting_number === posting.posting_number)
        if (!state) continue
        const badge = delegateBadgeFor(
          posting.products.map((product) => product.offer_id),
          state.covered_offer_ids,
        )
        if (badge) next[posting.posting_number] = badge
      }
      setDelegateBadges(next)
    } catch (reason) {
      if (sequence !== badgeSequence.current) return
      setDelegateBadges({})
      notifyError("委托徽标读取失败", { id: DELEGATE_BADGE_LIVE, reason })
    }
  }, [])

  const loadPostings = useCallback(
    async (
      request: ShippingListRequest,
      options: { keepCommittedPage?: boolean; quiet?: boolean } = {},
    ) => {
      if (
        !shouldStartShippingRead(
          Boolean(options.quiet),
          postingInFlight.current !== null,
        )
      ) {
        return null
      }
      const sequence = ++requestSequence.current
      postingInFlight.current = sequence
      if (!options.quiet) {
        setLoad("loading")
      }
      try {
        const next = await opsHttp.opsShippingList(request)
        if (sequence !== requestSequence.current) return null
        clearLive(SHIPPING_READ_LIVE)
        const keepCommittedPage = isEmptyShippingAdvance(
          Boolean(options.keepCommittedPage),
          next,
        )
        if (keepCommittedPage) {
          setView((current) =>
            current.store_id === request.store_id
              ? { ...current, has_next: false, cursor: "" }
              : current,
          )
          setLoad("ready")
        } else {
          setView(next)
          setLoad(next.postings.length === 0 ? "empty" : "ready")
          void loadDelegateBadges(request.store_id, next.postings)
        }
        return !keepCommittedPage
      } catch (reason) {
        if (sequence !== requestSequence.current) return null
        if (options.quiet) return null
        const next = commandFailure(reason, "读取 FBS 待发货单失败")
        setLoad("error")
        notifyLive({
          id: SHIPPING_READ_LIVE,
          type: "error",
          reason,
          title: describeFailure(next),
          action: { label: "重试", onClick: () => void loadPostings(request) },
        })
        return null
      } finally {
        if (postingInFlight.current === sequence) {
          postingInFlight.current = null
        }
      }
    },
    [loadDelegateBadges],
  )

  useEffect(() => {
    if (!active) return
    let cancelled = false
    requestSequence.current += 1
    postingInFlight.current = null
    setStoresLoading(storesRef.current.length === 0)
    setStoresError("")
    setStoresReason(undefined)
    void loadStoreRoster({ workspaceId })
      .then(() => {
        if (!cancelled) setStoresError("")
      })
      .catch((reason) => {
        if (cancelled) return
        setStoresError(errorMessage(reason, "无法读取店铺配置。"))
        setStoresReason(() => reason)
        if (!peekStoreRoster(workspaceId) && storesRef.current.length === 0) {
          setStoreUid("")
          setCursors([""])
          setView(emptyView(""))
          setLoad("idle")
        }
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false)
      })
    return () => {
      cancelled = true
      requestSequence.current += 1
      postingInFlight.current = null
      clearLive(SHIPPING_READ_LIVE)
    }
  }, [active, rosterRetry, workspaceId])

  useEffect(() => {
    if (!roster) return
    const configured = opsStoresFromRoster(roster.overview.stores)
    setHasUnavailableStores(hasUnavailableShippingStores(roster.overview.stores))
    setStores(configured)
    const nextStoreUid = configured.some(
      (store) => store.storeUid === storeUidRef.current,
    )
      ? storeUidRef.current
      : preferredStoreUid(configured, roster.overview.active_id)
    if (nextStoreUid !== storeUidRef.current) {
      setCursors([""])
      setView(emptyView(nextStoreUid))
      setLoad(nextStoreUid ? "loading" : "idle")
      setStoreUid(nextStoreUid)
    }
  }, [roster])

  useVisiblePolling({
    enabled: active && Boolean(storeUid),
    intervalMs: SHIPPING_POLL_INTERVAL_MS,
    restartKey: `${storeUid}:${queue}`,
    onPoll: (trigger) => {
      void loadPostings(requestFor(), { quiet: trigger !== "mount" })
    },
  })

  const page = cursors.length
  const currentView = view.store_id === storeUid ? view : emptyView(storeUid)
  const storeName =
    stores.find((store) => store.storeUid === storeUid)?.name ?? ""

  function beginNavigation(nextStore = storeUid) {
    requestSequence.current += 1
    badgeSequence.current += 1
    postingInFlight.current = null
    setDelegateBadges({})
    setView(emptyView(nextStore))
    setLoad("loading")
  }

  async function goToCursors(nextCursors: string[]) {
    const nextPage = nextCursors.length
    const committed = await loadPostings(requestFor(nextCursors.at(-1) ?? ""), {
      keepCommittedPage: nextPage > page,
    })
    if (committed) setCursors(nextCursors)
  }

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col overflow-hidden scroll-pt-14">
      <Section
        className="min-h-0 flex-1 overflow-hidden"
        title="待发货单"
        action={
          stores.length > 0 ? (
            <PageToolbar
              primary={
                <>
              <OpsStoreSelect
                value={storeUid}
                stores={stores}
                triggerClassName="min-w-52"
                onChange={(next) => {
                  if (next === storeUid) return
                  beginNavigation(next)
                  setStoreUid(next)
                  setCursors([""])
                  setOpen(null)
                }}
              />
              <Tabs
                value={queue}
                onValueChange={(next) => {
                  const parsed = QUEUE_FILTERS.find((item) => item.value === next)
                  if (!parsed || parsed.value === queue) return
                  beginNavigation()
                  setQueue(parsed.value)
                  setCursors([""])
                  setOpen(null)
                }}
              >
                <TabsList aria-label="发货队列">
                  <TabsIndicator />
                  {QUEUE_FILTERS.map((item) => (
                    <TabsTrigger
                      key={item.value}
                      value={item.value}
                      className="h-8 px-2.5"
                    >
                      {item.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
                </>
              }
              secondary={
              <Button
                size="sm"
                variant="outline"
                disabled={!storeUid || load === "loading"}
                onClick={() => void loadPostings(requestFor())}
              >
                <RefreshCw className={cn(load === "loading" && "animate-spin")} />
                {load === "loading" ? "正在读取…" : "刷新"}
              </Button>
              }
            />
          ) : null
        }
      >
        <StoreGate
          loading={storesLoading}
          error={storesError}
          reason={storesReason}
          storeCount={stores.length}
          hasUnavailableStores={hasUnavailableStores}
          onRetry={() => setRosterRetry((value) => value + 1)}
          onOpenStores={onOpenStores}
          icon={<Package />}
        >
          <ShippingResults
            view={currentView}
            storeName={storeName}
            load={load}
            page={page}
            selectedNumber={open?.posting.posting_number}
            delegateBadges={delegateBadges}
            onOpen={(posting, action) => setOpen({ posting, action })}
            onPrevious={() => void goToCursors(cursors.slice(0, -1))}
            onNext={() => void goToCursors([...cursors, currentView.cursor])}
            onRetry={() => void loadPostings(requestFor())}
          />
        </StoreGate>
      </Section>
      <ShippingDetailDialog
        open={open}
        storeName={storeName}
        onOpenChange={(next) => {
          if (!next) setOpen(null)
        }}
      />
    </div>
  )
}

export type ShippingResultsProps = {
  view: ShippingListView
  storeName?: string
  load: ShippingLoadState
  page: number
  selectedNumber?: string
  delegateBadges?: Record<string, DelegateBadge>
  onOpen?: (posting: ShippingPostingView, action: ShippingAction) => void
  onPrevious: () => void
  onNext: () => void
  onRetry: () => void
}

export function ShippingResults({
  view,
  storeName = "",
  load,
  page,
  selectedNumber,
  delegateBadges,
  onOpen,
  onPrevious,
  onNext,
  onRetry,
}: ShippingResultsProps) {
  if (load === "error" && view.postings.length === 0 && page === 1) {
    return (
      <Empty className="min-h-48">
        <EmptyMedia variant="icon">
          <AlertTriangle />
        </EmptyMedia>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={onRetry}>
            重试
          </Button>
        </EmptyContent>
      </Empty>
    )
  }
  if ((load === "idle" || load === "loading") && view.postings.length === 0) {
    return <LoadingPanel>正在读取待发货单…</LoadingPanel>
  }
  if (load === "empty" && page === 1) {
    return (
      <NoticePanel
        icon="empty"
        title="当前队列没有待发货单"
        body="换一家店铺或队列后再刷新。"
      />
    )
  }

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      aria-busy={load === "loading"}
    >
      <ShippingPostingsTable
        postings={view.postings}
        storeName={storeName}
        selectedNumber={selectedNumber}
        delegateBadges={delegateBadges}
        onOpen={onOpen}
      />
      <CursorPagerFooter
        page={page}
        count={view.postings.length}
        hasNext={view.has_next}
        cursor={view.cursor ?? ""}
        busy={load === "loading"}
        onPrevious={onPrevious}
        onNext={onNext}
      />
    </div>
  )
}

function LoadingPanel({ children }: { children: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="grid min-h-48 place-items-center rounded-xl border border-border bg-card text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-2">
        <RefreshCw className="size-4 animate-spin" />
        {children}
      </span>
    </div>
  )
}

function NoticePanel({
  title,
  body,
  icon = "warn",
  children,
}: {
  title: string
  body: string
  icon?: "warn" | "empty"
  children?: ReactNode
}) {
  const Icon = icon === "empty" ? Package : AlertTriangle
  return (
    <Empty role={icon === "warn" ? "alert" : "status"} className="min-h-48">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {children ? <EmptyContent>{children}</EmptyContent> : null}
    </Empty>
  )
}

export function ShippingPostingsTable({
  postings,
  storeName = "",
  selectedNumber,
  delegateBadges = {},
  onOpen,
}: {
  postings: ShippingPostingView[]
  storeName?: string
  selectedNumber?: string
  /** posting_number → 已委托徽标（纯只读）。 */
  delegateBadges?: Record<string, DelegateBadge>
  onOpen?: (posting: ShippingPostingView, action: ShippingAction) => void
}) {
  return (
    <Table containerClassName="max-w-full">
      <TableHeader>
        <TableRow>
          <TableHead className="w-52">单号</TableHead>
          <TableHead className="w-28">状态</TableHead>
          <TableHead className="w-36">店铺</TableHead>
          <TableHead className="w-32">截止</TableHead>
          <TableHead className="w-20">件数</TableHead>
          <TableHead className="w-36">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {postings.map((posting) => (
          <ShippingPostingRow
            key={posting.posting_number}
            posting={posting}
            storeName={storeName}
            selected={selectedNumber === posting.posting_number}
            delegateBadge={delegateBadges[posting.posting_number]}
            onOpen={onOpen}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function ShippingPostingRow({
  posting,
  storeName,
  selected,
  delegateBadge,
  onOpen,
}: {
  posting: ShippingPostingView
  storeName: string
  selected: boolean
  delegateBadge?: DelegateBadge
  onOpen?: (posting: ShippingPostingView, action: ShippingAction) => void
}) {
  const actions = shippingActions(posting)
  const primary = actions[0]
  return (
    <TableRow
      data-state={selected ? "selected" : undefined}
      className={cn(onOpen && "cursor-pointer")}
      onClick={() => {
        if (primary) onOpen?.(posting, primary.id)
      }}
    >
      <TableCell>
        <p className="font-mono text-compact break-all select-all tabular-nums">
          {posting.posting_number}
        </p>
        {posting.substatus ? (
          <Disclose
            value={posting.substatus}
            label={`子状态 ${posting.substatus}`}
          />
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-1">
          <StateChip
            status={posting.status || "unknown"}
            label={shippingStatusLabel(posting.status || "unknown")}
          />
          {delegateBadge ? (
            <StateChip
              status="delegated"
              tone="good"
              label={delegateBadge.label}
            />
          ) : null}
        </div>
      </TableCell>
      <TableCell>
        <Disclose value={storeName || "—"} />
      </TableCell>
      <TableCell>
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-mono text-compact tabular-nums">
            {formatInstant(posting.shipment_date)}
          </span>
          <StateChip
            status={posting.deadline_state}
            label={deadlineLabel(posting.deadline_state)}
          />
        </div>
      </TableCell>
      <TableCell>
        <span className="font-mono text-compact tabular-nums">
          {posting.quantity}
        </span>
        <p className="sr-only">共 {posting.quantity} 件</p>
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap items-center gap-1">
          {actions.map((action) => (
            <Button
              key={action.id}
              size="xs"
              variant={action.id === "ship" ? "brand" : "outline"}
              aria-label={`${action.label} ${posting.posting_number}`}
              onClick={(event) => {
                event.stopPropagation()
                onOpen?.(posting, action.id)
              }}
            >
              {action.id === "label" ? <Printer /> : <Truck />}
              {action.label}
            </Button>
          ))}
        </div>
      </TableCell>
    </TableRow>
  )
}

function ShippingDetailDialog({
  open,
  storeName,
  onOpenChange,
}: {
  open: { posting: ShippingPostingView; action: ShippingAction } | null
  storeName: string
  onOpenChange: (open: boolean) => void
}) {
  const posting = open?.posting
  return (
    <Dialog open={Boolean(open)} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="font-mono text-sm break-all">
            {posting?.posting_number ?? "发货单"}
          </DialogTitle>
          <DialogDescription>
            {open?.action === "ship"
              ? "发货确认尚未接入 Seller 写接口。核对件数与截止后到 Ozon 后台发货。"
              : "打单尚未接入 Seller 写接口。组包完成后到 Ozon 后台打印面单。"}
          </DialogDescription>
        </DialogHeader>
        {posting ? (
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            <KeyValueGrid className="sm:grid-cols-2">
              <KeyValue
                label="状态"
                value={
                  <StateChip
                    status={posting.status || "unknown"}
                    label={shippingStatusLabel(posting.status || "unknown")}
                  />
                }
              />
              <KeyValue label="店铺" value={storeName || "—"} />
              <KeyValue
                label="截止"
                value={formatInstant(posting.shipment_date)}
                mono
              />
              <KeyValue
                label="处理开始"
                value={formatInstant(posting.in_process_at)}
                mono
              />
              <KeyValue
                label="组包"
                value={
                  <StateChip
                    status={posting.packing_state}
                    label={packingLabel(posting.packing_state)}
                  />
                }
              />
              <KeyValue
                label="打单"
                value={
                  <StateChip
                    status={posting.label_state}
                    label={labelPrintLabel(posting.label_state)}
                  />
                }
              />
            </KeyValueGrid>
            <ul className="flex flex-col gap-2 text-sm">
              {posting.products.length === 0 ? (
                <li className="font-mono text-compact tabular-nums">— × 0</li>
              ) : (
                posting.products.map((product) => (
                  <li
                    key={`${posting.posting_number}-${product.sku}-${product.offer_id}`}
                    className="min-w-0"
                  >
                    <p className="font-mono text-compact break-all select-all tabular-nums">
                      {product.sku} × {product.quantity}
                    </p>
                    {product.name ? (
                      <p className="break-words text-compact text-muted-foreground">
                        {product.name}
                      </p>
                    ) : null}
                  </li>
                ))
              )}
            </ul>
            <p className="font-mono text-compact tabular-nums text-muted-foreground">
              共 {posting.quantity} 件
            </p>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function Disclose({ value, label }: { value: string; label?: string }) {
  if (!value.trim()) return null
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="mt-0.5 max-w-[28ch] cursor-pointer truncate text-left font-mono text-meta text-muted-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
            aria-label={label ?? value}
          />
        }
      >
        {value}
      </TooltipTrigger>
      <TooltipContent>{value}</TooltipContent>
    </Tooltip>
  )
}

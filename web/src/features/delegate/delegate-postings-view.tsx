/**
 * 委托订单主视图：本店未履约 posting 列表。
 *
 * 行内四态由服务端合并（`DelegatePostingState`），这里只做「态 → 动作」：
 * `delegated` 点行进详情；`partial` 委托剩余行（补齐流里自动剔除已在单的
 * 行）；`ready` 确认即建单（可随单备注）；`needs_setup` 走补齐流。列表读是
 * 纯读——建单只发生在 POST /orders。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import {
  AlertTriangle,
  Package,
  RefreshCw,
} from "lucide-react"

import type {
  DelegatePosting,
  DelegatePostingsData,
  DelegateSource,
} from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import { CursorPagerFooter } from "@/components/cursor-pager-footer"
import {
  delegateRowAction,
  formatInstantValue,
  newIdempotencyKey,
  orderStateLabel,
  orderStateTone,
} from "./delegate-model"
import { DelegateSetupDialog } from "./delegate-setup-dialog"
import { DelegateOrderDetailDialog } from "./delegate-order-detail"
import { PageToolbar } from "@/components/page-toolbar"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Label } from "@/components/ui/label"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { clearLive, notifyCommandError, notifyLive, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { useVisiblePolling } from "@/lib/visible-polling"

const POSTINGS_LIVE = "delegate-postings-read"
const DEFAULT_WINDOW_DAYS = 30
const PAGE_SIZE = 50
const POLL_INTERVAL_MS = 60_000

export type PostingRowState = "idle" | "loading" | "ready" | "empty" | "error"

export type DelegatePostingsViewProps = {
  storeId: string
  /** 屏级缓存的厂家候选（建单/绑定编辑共用）。 */
  sources: DelegateSource[]
  /** 绑定或单变化后递增，驱动列表重读。 */
  refreshKey: number
  /** 任一建单成功（外带刷新信号）。 */
  onOrderCreated: () => void
}

export function DelegatePostingsView({
  storeId,
  sources,
  refreshKey,
  onOrderCreated,
}: DelegatePostingsViewProps) {
  const [cursors, setCursors] = useState([""])
  const [pageData, setPageData] = useState<DelegatePostingsData | null>(null)
  const [load, setLoad] = useState<PostingRowState>("idle")
  const [confirming, setConfirming] = useState<DelegatePosting | null>(null)
  const [settingUp, setSettingUp] = useState<DelegatePosting | null>(null)
  const [openOrderId, setOpenOrderId] = useState<string | null>(null)
  const requestSequence = useRef(0)
  const inFlight = useRef<number | null>(null)

  const loadPostings = useCallback(
    async (cursor: string, options: { quiet?: boolean; keepPage?: boolean } = {}) => {
      if (options.quiet && inFlight.current !== null) return
      const sequence = ++requestSequence.current
      inFlight.current = sequence
      if (!options.quiet) setLoad("loading")
      try {
        const data = await delegateHttp.listPostings({
          store_id: storeId,
          window_days: DEFAULT_WINDOW_DAYS,
          cursor: cursor || undefined,
          limit: PAGE_SIZE,
        })
        if (sequence !== requestSequence.current) return
        clearLive(POSTINGS_LIVE)
        if (options.keepPage && data.postings.length === 0) {
          // 空的下一页不算结果：保留当前页，只宣布到底。
          setPageData((current) =>
            current && current.store_id === storeId
              ? { ...current, has_next: false, cursor: "" }
              : current,
          )
        } else {
          setPageData(data)
          setLoad(data.postings.length === 0 ? "empty" : "ready")
        }
      } catch (reason) {
        if (sequence !== requestSequence.current) return
        if (options.quiet) return
        setLoad("error")
        notifyLive({
          id: POSTINGS_LIVE,
          type: "error",
          reason,
          title: "读取未履约订单失败",
          action: {
            label: "重试",
            onClick: () => void loadPostings(cursor),
          },
        })
        notifyCommandError(reason, "读取未履约订单失败")
      } finally {
        if (inFlight.current === sequence) inFlight.current = null
      }
    },
    [storeId],
  )

  useEffect(() => {
    requestSequence.current += 1
    inFlight.current = null
    setCursors([""])
    setPageData(null)
    if (storeId) setLoad("loading")
    void loadPostings("")
    return () => {
      requestSequence.current += 1
      inFlight.current = null
      clearLive(POSTINGS_LIVE)
    }
  }, [storeId, refreshKey, loadPostings])

  useVisiblePolling({
    enabled: Boolean(storeId),
    intervalMs: POLL_INTERVAL_MS,
    restartKey: `${storeId}:${cursors.at(-1) ?? ""}`,
    onPoll: (trigger) => {
      void loadPostings(cursors.at(-1) ?? "", {
        quiet: trigger !== "mount",
        keepPage: cursors.length > 1,
      })
    },
  })

  const page = cursors.length
  const postings = pageData && pageData.store_id === storeId ? pageData.postings : []
  const hasNext = pageData ? pageData.has_next : false
  const cursor = pageData ? pageData.cursor : ""

  async function goTo(nextCursors: string[]) {
    const nextPage = nextCursors.length
    if (!pageData) return
    const advancing = nextPage > page
    const sequence = ++requestSequence.current
    inFlight.current = sequence
    setLoad("loading")
    try {
      const data = await delegateHttp.listPostings({
        store_id: storeId,
        window_days: DEFAULT_WINDOW_DAYS,
        cursor: nextCursors.at(-1) || undefined,
        limit: PAGE_SIZE,
      })
      if (sequence !== requestSequence.current) return
      if (advancing && data.postings.length === 0) {
        setPageData({ ...pageData, has_next: false, cursor: "" })
      } else {
        setPageData(data)
        setCursors(nextCursors)
      }
      setLoad(data.postings.length === 0 && !advancing ? "empty" : "ready")
    } catch (reason) {
      if (sequence !== requestSequence.current) return
      notifyCommandError(reason, "读取未履约订单失败")
      setLoad(postings.length === 0 ? "error" : "ready")
    } finally {
      if (inFlight.current === sequence) inFlight.current = null
    }
  }

  if (!storeId) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageToolbar
        primary={
          <span className="text-compact text-muted-foreground">
            出单即入库：未挂委托的行可「委托」，已挂的显示委托态。
          </span>
        }
        secondary={
          <Button
            size="sm"
            variant="outline"
            disabled={load === "loading"}
            onClick={() => void loadPostings(cursors.at(-1) ?? "")}
          >
            <RefreshCw className={cn(load === "loading" && "animate-spin")} />
            刷新
          </Button>
        }
      />
      {load === "error" && postings.length === 0 && page === 1 ? (
        <Empty className="min-h-48">
          <EmptyMedia variant="icon">
            <AlertTriangle />
          </EmptyMedia>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => void loadPostings("")}>
              重试
            </Button>
          </EmptyContent>
        </Empty>
      ) : (load === "idle" || load === "loading") && postings.length === 0 ? (
        <div
          role="status"
          aria-live="polite"
          className="grid min-h-48 place-items-center rounded-xl border border-border bg-card text-sm text-muted-foreground"
        >
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-4" />
            正在读取未履约订单…
          </span>
        </div>
      ) : load === "empty" && page === 1 ? (
        <Empty className="min-h-48">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Package />
            </EmptyMedia>
            <EmptyTitle>窗口内没有未履约订单</EmptyTitle>
            <EmptyDescription>近 {DEFAULT_WINDOW_DAYS} 天没有待履约的物流单。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="overflow-hidden rounded-xl border border-border bg-card"
          aria-busy={load === "loading"}
        >
          <DelegatePostingsTable
            postings={postings}
            onOpenOrder={setOpenOrderId}
            onDelegateRest={setSettingUp}
            onDelegate={setConfirming}
            onSetup={setSettingUp}
          />
          <CursorPagerFooter
            page={page}
            count={postings.length}
            hasNext={hasNext}
            cursor={cursor}
            busy={load === "loading"}
            onPrevious={() => void goTo(cursors.slice(0, -1))}
            onNext={() => void goTo([...cursors, cursor])}
          />
        </div>
      )}
      <DelegateCreateConfirmDialog
        posting={confirming}
        storeId={storeId}
        onClose={() => setConfirming(null)}
        onCreated={() => {
          onOrderCreated()
          void loadPostings(cursors.at(-1) ?? "")
        }}
      />
      <DelegateSetupDialog
        posting={settingUp}
        storeId={storeId}
        sources={sources}
        onClose={() => setSettingUp(null)}
        onOrderCreated={onOrderCreated}
      />
      <DelegateOrderDetailDialog
        orderId={openOrderId}
        onOpenChange={(next) => {
          if (!next) setOpenOrderId(null)
        }}
        onMutated={() => void loadPostings(cursors.at(-1) ?? "")}
      />
    </div>
  )
}

export function DelegatePostingsTable({
  postings,
  onOpenOrder,
  onDelegate,
  onDelegateRest,
  onSetup,
}: {
  postings: DelegatePosting[]
  onOpenOrder: (orderId: string) => void
  onDelegate: (posting: DelegatePosting) => void
  onDelegateRest: (posting: DelegatePosting) => void
  onSetup: (posting: DelegatePosting) => void
}) {
  return (
    <Table containerClassName="max-w-full">
      <TableHeader>
        <TableRow>
          <TableHead className="w-52">单号</TableHead>
          <TableHead className="w-28">状态</TableHead>
          <TableHead className="w-36">备货截止</TableHead>
          <TableHead className="w-20">件数</TableHead>
          <TableHead className="w-44">委托态</TableHead>
          <TableHead className="w-36">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {postings.map((posting) => (
          <DelegatePostingRow
            key={posting.posting_number}
            posting={posting}
            onOpenOrder={onOpenOrder}
            onDelegate={onDelegate}
            onDelegateRest={onDelegateRest}
            onSetup={onSetup}
          />
        ))}
      </TableBody>
    </Table>
  )
}

function DelegatePostingRow({
  posting,
  onOpenOrder,
  onDelegate,
  onDelegateRest,
  onSetup,
}: {
  posting: DelegatePosting
  onOpenOrder: (orderId: string) => void
  onDelegate: (posting: DelegatePosting) => void
  onDelegateRest: (posting: DelegatePosting) => void
  onSetup: (posting: DelegatePosting) => void
}) {
  const action = delegateRowAction(posting.delegate_state)
  const openable = Boolean(posting.order_id)
  return (
    <TableRow
      className={cn(openable && "cursor-pointer")}
      onClick={() => {
        if (openable && posting.order_id) onOpenOrder(posting.order_id)
      }}
    >
      <TableCell>
        <p className="font-mono text-compact break-all select-all tabular-nums">
          {posting.posting_number}
        </p>
      </TableCell>
      <TableCell>
        <StateChip status={posting.status || "unknown"} label={statusLabel(posting)} />
      </TableCell>
      <TableCell>
        <span className="font-mono text-compact tabular-nums">
          {formatInstantValue(posting.shipment_date)}
        </span>
      </TableCell>
      <TableCell>
        <span className="font-mono text-compact tabular-nums">{posting.quantity}</span>
      </TableCell>
      <TableCell>
        <DelegateStateCell posting={posting} />
      </TableCell>
      <TableCell onClick={(event) => event.stopPropagation()}>
        {action.kind === "delegate" ? (
          <Button size="xs" variant="brand" aria-label={`委托 ${posting.posting_number}`} onClick={() => onDelegate(posting)}>
            委托
          </Button>
        ) : action.kind === "setup" ? (
          <Button size="xs" variant="brand" aria-label={`补齐并委托 ${posting.posting_number}`} onClick={() => onSetup(posting)}>
            补齐并委托
          </Button>
        ) : action.kind === "delegate-rest" ? (
          <Button size="xs" variant="outline" aria-label={`委托剩余行 ${posting.posting_number}`} onClick={() => onDelegateRest(posting)}>
            委托剩余行
          </Button>
        ) : null}
      </TableCell>
    </TableRow>
  )
}

function statusLabel(posting: DelegatePosting): string {
  // 未履约列表只出待办状态：映射进六色词汇的既有键，未知的原样印出。
  return posting.status || "unknown"
}

function DelegateStateCell({ posting }: { posting: DelegatePosting }) {
  switch (posting.delegate_state) {
    case "delegated":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <StateChip status="delegated" tone="good" label="已委托" />
          {posting.order_state ? (
            <StateChip
              status={posting.order_state}
              tone={orderStateTone(posting.order_state)}
              label={orderStateLabel(posting.order_state)}
            />
          ) : null}
        </div>
      )
    case "partial":
      return (
        <div className="flex min-w-0 flex-col gap-1">
          <StateChip
            status="partial"
            tone="flight"
            label={`已委托 ${posting.covered_lines}/${posting.total_lines} 行`}
          />
          {posting.order_state ? (
            <span className="text-meta text-muted-foreground">
              {orderStateLabel(posting.order_state)}
            </span>
          ) : null}
        </div>
      )
    case "ready":
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="w-fit cursor-help" aria-label="全部行已绑定且原图已核验" />
            }
          />
          <TooltipContent>全部行已绑定且原图已核验</TooltipContent>
        </Tooltip>
      )
    default:
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="w-fit cursor-help" aria-label="有行未绑定或原图未核验" />
            }
          />
          <TooltipContent>有行未绑定或原图未核验</TooltipContent>
        </Tooltip>
      )
  }
}

/** `ready` 行的确认建单对话框：确认即建单，随单备注选填。 */
export function DelegateCreateConfirmDialog({
  posting,
  storeId,
  onClose,
  onCreated,
}: {
  posting: DelegatePosting | null
  storeId: string
  onClose: () => void
  onCreated: () => void
}) {
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const keyRef = useRef(newIdempotencyKey())

  useEffect(() => {
    if (posting) {
      setNote("")
      keyRef.current = newIdempotencyKey()
    }
  }, [posting])

  async function confirm() {
    if (!posting) return
    setBusy(true)
    try {
      const order = await delegateHttp.createOrder(
        {
          store_id: storeId,
          posting_number: posting.posting_number,
          seller_note: note.trim() || undefined,
        },
        keyRef.current,
      )
      notifySuccess(`已建委托单（${order.lines.length} 行）`)
      onCreated()
      onClose()
    } catch (reason) {
      notifyCommandError(reason, "建单失败")
    } finally {
      setBusy(false)
    }
  }

  return (
    <ConfirmDialog
      open={Boolean(posting)}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={`委托 ${posting?.posting_number ?? ""}`}
      description="按整单建一张委托单：全部行进单、按行绑定的厂家分别派发。"
      confirmText="建单"
      variant="brand"
      busy={busy}
      size="md"
      onConfirm={() => void confirm()}
    >
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="delegate-order-note">随单备注（给厂家）</Label>
        <Textarea
          id="delegate-order-note"
          value={note}
          placeholder="选填；会随派发包发给厂家"
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
    </ConfirmDialog>
  )
}

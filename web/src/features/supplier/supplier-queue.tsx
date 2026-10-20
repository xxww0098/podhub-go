/**
 * 排单屏 (ADR-0100)：一个屏、无导航。
 *
 * 三列看板只留缩略图和一行摘要。点开弹窗才看单号、图片、物流和动作。
 * 动作是否可用只看服务端下发的 actions。失败文案只走 toast，不进 DOM。
 */
import { Image, Wallet } from "lucide-react"
import { useCallback, useMemo, useRef, useState } from "react"
import {
  getSupplierDispatch,
  listSupplierDispatches,
  type SupplierDispatchDetail,
  type SupplierDispatchRow,
} from "@/bindings/http-supplier-portal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { notifyCommandError } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"

import { queueFacts, SUPPLIER_PORTAL_POLL_MS } from "./supplier-board"
import { DispatchDetailDialog } from "./supplier-dispatch-dialog"
import { SupplierWalletCard } from "./supplier-wallet"
import {
  countdownLabel,
  isUrgent,
  sortUrgentFirst,
  useNow,
  useReducedMotion,
} from "./supplier-urgency"

type Queue = {
  pending: SupplierDispatchRow[]
  producing: SupplierDispatchRow[]
  shipped: SupplierDispatchRow[]
}

function groupQueue(rows: SupplierDispatchRow[], now: number): Queue {
  const queue: Queue = { pending: [], producing: [], shipped: [] }
  for (const row of rows) {
    if (row.state === "dispatched") queue.pending.push(row)
    else if (row.state === "accepted") queue.producing.push(row)
    else if (row.state === "shipped") queue.shipped.push(row)
  }
  queue.pending = sortUrgentFirst(queue.pending, now)
  queue.producing = sortUrgentFirst(queue.producing, now)
  return queue
}

function cardTitle(row: SupplierDispatchRow): string {
  const first = row.lines[0]
  if (!first) return row.posting_number
  const name = first.name || first.offer_id
  return row.lines.length > 1 ? name + " 等" : name
}

function cardMeta(row: SupplierDispatchRow, now: number): string {
  const qty = row.lines.reduce((sum, line) => sum + line.quantity, 0)
  const parts = ["× " + qty]
  const remaining = countdownLabel(row.deadline, now)
  if (remaining) parts.push(remaining === "超时" ? "超时" : remaining)
  if ((row.nudge_count ?? 0) > 0) parts.push("在催")
  return parts.join(" · ")
}

/** 页头标明这些是你的厂。没有厂名时留空，页面改写排序提示。 */
export function factorySubtitle(names: readonly string[]): string {
  const joined = names.map((name) => name.trim()).filter((name) => name.length > 0).join("、")
  return joined ? `你的厂：${joined}` : ""
}

/** 右上角账号名。没有名字时用邮箱。 */
export function accountLabel(name?: string | null, email?: string | null): string {
  const trimmed = name?.trim() ?? ""
  return trimmed || (email?.trim() ?? "")
}

export function SupplierQueue({
  supplierNames = [],
  accountName = "",
  onSignedOut,
}: {
  supplierNames?: readonly string[]
  accountName?: string
  /** The shell's signed-out hook; absent when nobody is listening. */
  onSignedOut?: () => void
}) {
  const [rows, setRows] = useState<SupplierDispatchRow[]>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [openId, setOpenId] = useState<string>()
  const [detail, setDetail] = useState<SupplierDispatchDetail>()
  const [detailBusy, setDetailBusy] = useState(false)
  const [updatedAt, setUpdatedAt] = useState<number>()
  const reducedMotion = useReducedMotion()
  const now = useNow(reducedMotion)
  const requestSeq = useRef(0)
  const openIdRef = useRef<string | undefined>(undefined)
  openIdRef.current = openId

  const refresh = useCallback(async (options?: { quiet?: boolean }) => {
    const seq = ++requestSeq.current
    const detailId = openIdRef.current
    try {
      const data = await listSupplierDispatches()
      if (seq !== requestSeq.current) return
      setRows(data.dispatches)
      setUpdatedAt(Date.now())
      setLoadFailed(false)
    } catch (reason) {
      if (seq !== requestSeq.current) return
      setLoadFailed(true)
      if (!options?.quiet) notifyCommandError(reason, "订单没读出来，请稍后再试。")
      return
    }
    if (!detailId) return
    try {
      const next = await getSupplierDispatch(detailId)
      if (seq !== requestSeq.current || openIdRef.current !== detailId) return
      setDetail(next)
    } catch (reason) {
      if (seq !== requestSeq.current || options?.quiet) return
      notifyCommandError(reason, "订单详情没读出来。")
    }
  }, [])

  useVisiblePolling({
    enabled: true,
    intervalMs: SUPPLIER_PORTAL_POLL_MS,
    onPoll: (trigger) => {
      void refresh({ quiet: trigger !== "mount" })
    },
  })

  const openDispatch = useCallback(async (dispatchId: string) => {
    setOpenId(dispatchId)
    setDetail(undefined)
    setDetailBusy(true)
    try {
      setDetail(await getSupplierDispatch(dispatchId))
    } catch (reason) {
      setOpenId(undefined)
      notifyCommandError(reason, "订单详情没读出来。")
    } finally {
      setDetailBusy(false)
    }
  }, [])

  const queue = useMemo(() => groupQueue(rows ?? [], now), [rows, now])
  const facts = useMemo(() => queueFacts(queue, now), [queue, now])

  if (rows === undefined && !loadFailed) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background">
        <Spinner className="size-5" aria-label="正在读取订单" />
      </div>
    )
  }

  const updated = updatedAt == null
    ? null
    : new Date(updatedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      })

  return (
    <div className="page-canvas mx-auto flex min-h-svh flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-md font-medium tracking-[-0.01em]">
            订单
            {facts.urgent > 0 ? (
              <Badge variant="destructive">{facts.urgent} 尽快</Badge>
            ) : null}
          </h1>
          <p
            className="truncate text-compact text-muted-foreground"
            title={factorySubtitle(supplierNames) || undefined}
          >
            {factorySubtitle(supplierNames) || "快到期的排前面"}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {updated ? (
            <span className="text-meta text-muted-foreground tabular-nums">更新于 {updated}</span>
          ) : null}
          {onSignedOut ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={onSignedOut}
            >
              退出登录
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh()}
          >
            刷新
          </Button>
          {accountName ? (
            <span className="max-w-48 truncate text-compact" title={accountName}>
              {accountName}
            </span>
          ) : null}
          <Popover>
            <PopoverTrigger
              render={
                <Button type="button" variant="outline" size="icon-sm" aria-label="钱包">
                  <Wallet />
                </Button>
              }
            />
            <PopoverContent align="end">
              <SupplierWalletCard bare />
            </PopoverContent>
          </Popover>
        </div>
      </header>
      <div className="grid min-w-0 items-start gap-3 md:grid-cols-3">
        <QueueGroup
          title="待接单"
          emptyHint="新订单会出现在这里"
          rows={queue.pending}
          badgeVariant="default"
          now={now}
          onOpen={openDispatch}
          activeId={openId}
        />
        <QueueGroup
          title="生产中"
          emptyHint="接单后会出现在这里"
          rows={queue.producing}
          badgeVariant="brand"
          now={now}
          onOpen={openDispatch}
          activeId={openId}
        />
        <QueueGroup
          title="已发货"
          emptyHint="填了快递单号后会出现在这里"
          rows={queue.shipped}
          badgeVariant="good"
          now={now}
          onOpen={openDispatch}
          activeId={openId}
        />
      </div>
      <DispatchDetailDialog
        open={openId !== undefined}
        detail={detail}
        busy={detailBusy}
        onOpenChange={(open) => {
          if (!open) setOpenId(undefined)
        }}
        onAction={async () => {
          await refresh()
          if (openId) await openDispatch(openId)
        }}
      />
    </div>
  )
}

function QueueGroup({
  title,
  emptyHint,
  rows,
  badgeVariant,
  now,
  onOpen,
  activeId,
}: {
  title: string
  emptyHint: string
  rows: SupplierDispatchRow[]
  badgeVariant: "default" | "brand" | "good"
  now: number
  onOpen: (dispatchId: string) => void
  activeId?: string
}) {
  return (
    <section className="flex min-h-72 min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border p-3">
      <h2 className="flex items-center justify-between gap-2 text-compact font-medium">
        {title}
        <Badge variant={badgeVariant}>{rows.length}</Badge>
      </h2>
      {rows.length === 0 ? (
        <p className="flex flex-1 items-center justify-center text-center text-meta text-muted-foreground">
          {emptyHint}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => {
            const urgent = isUrgent(row, now)
            const overdue = countdownLabel(row.deadline, now) === "超时"
            const tone = urgent
              ? overdue
                ? " border-st-bad/40"
                : " border-brand/40"
              : ""
            return (
            <li key={row.dispatch_id} className="min-w-0">
              <button
                type="button"
                aria-pressed={activeId === row.dispatch_id}
                className={"flex w-full min-w-0 cursor-pointer items-center gap-3 overflow-hidden rounded-lg border border-border bg-card px-3 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" + tone}
                onClick={() => onOpen(row.dispatch_id)}
              >
                <span className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-muted text-muted-foreground">
                  <Image aria-hidden />
                </span>
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-compact">{cardTitle(row)}</span>
                  <span className="truncate text-meta text-muted-foreground">{cardMeta(row, now)}</span>
                </span>
              </button>
            </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

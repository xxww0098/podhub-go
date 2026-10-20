/**
 * 委托单视图：单级状态过滤 + 分页列表；点行开详情（撤单/收口在详情里）。
 * 卖家 wire 只见单级状态与行级厂家/包状态，不见派发账本内部。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { RefreshCw } from "lucide-react"

import type { DelegateOrderListData } from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import { CursorPagerFooter } from "@/components/cursor-pager-footer"
import {
  formatInstantValue,
  orderStateLabel,
  orderStateTone,
} from "./delegate-model"
import { DelegateOrderDetailDialog } from "./delegate-order-detail"
import { PageToolbar } from "@/components/page-toolbar"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { notifyCommandError } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { useVisiblePolling } from "@/lib/visible-polling"

const ORDERS_PAGE_SIZE = 20
const POLL_INTERVAL_MS = 60_000

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部" },
  { value: "awaiting_setup", label: "待完善" },
  { value: "ready", label: "待派发" },
  { value: "dispatched", label: "已派发" },
  { value: "in_production", label: "生产中" },
  { value: "shipped", label: "已发货" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
]

export type DelegateOrdersViewProps = {
  storeId: string
  refreshKey: number
}

export function DelegateOrdersView({ storeId, refreshKey }: DelegateOrdersViewProps) {
  const [state, setState] = useState("")
  const [cursors, setCursors] = useState([""])
  const [pageData, setPageData] = useState<DelegateOrderListData | null>(null)
  const [loading, setLoading] = useState(false)
  const [openOrderId, setOpenOrderId] = useState<string | null>(null)
  const requestSequence = useRef(0)

  const loadOrders = useCallback(
    async (cursor: string, nextState = state) => {
      if (!storeId) return
      const sequence = ++requestSequence.current
      setLoading(true)
      try {
        const data = await delegateHttp.listOrders({
          storeId,
          state: nextState || undefined,
          cursor: cursor || undefined,
          limit: ORDERS_PAGE_SIZE,
        })
        if (sequence !== requestSequence.current) return
        setPageData(data)
      } catch (reason) {
        if (sequence === requestSequence.current) {
          notifyCommandError(reason, "读取委托单失败")
        }
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    },
    [storeId, state],
  )

  useEffect(() => {
    requestSequence.current += 1
    setCursors([""])
    setPageData(null)
    void loadOrders("")
  }, [storeId, state, refreshKey, loadOrders])

  useVisiblePolling({
    enabled: Boolean(storeId),
    intervalMs: POLL_INTERVAL_MS,
    restartKey: `${storeId}:${state}:${cursors.at(-1) ?? ""}`,
    onPoll: (trigger) => {
      if (trigger === "mount") return // 装载已由 effect 负责
      void loadOrders(cursors.at(-1) ?? "")
    },
  })

  const page = cursors.length
  const orders = pageData?.orders ?? []
  const hasNext = pageData?.has_next ?? false
  const cursor = pageData?.cursor ?? ""

  if (!storeId) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <PageToolbar
        primary={
          <Select
            value={state}
            onValueChange={(next) => {
              if (next === null || next === state) return
              setState(next)
            }}
          >
            <SelectTrigger size="sm" className="min-w-28" aria-label="委托单状态">
              <SelectValue>
                {STATE_FILTERS.find((item) => item.value === state)?.label ?? "全部"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {STATE_FILTERS.map((item) => (
                <SelectItem key={item.value || "all"} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
        secondary={
          <Button
            size="sm"
            variant="outline"
            disabled={loading}
            onClick={() => void loadOrders(cursors.at(-1) ?? "")}
          >
            <RefreshCw className={cn(loading && "animate-spin")} />
            刷新
          </Button>
        }
      />
      {orders.length === 0 && !loading ? (
        <Empty className="min-h-40">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <span className="font-mono text-lg">0</span>
            </EmptyMedia>
            <EmptyTitle>没有符合条件的委托单</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => void loadOrders("")}>
              刷新
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div
          className="overflow-hidden rounded-xl border border-border bg-card"
          aria-busy={loading}
        >
          <Table containerClassName="max-w-full">
            <TableHeader>
              <TableRow>
                <TableHead className="w-52">物流单号</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-16">行数</TableHead>
                <TableHead className="w-56">厂家</TableHead>
                <TableHead className="w-36">创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {orders.map((order) => (
                <TableRow
                  key={order.order_id}
                  className="cursor-pointer"
                  onClick={() => setOpenOrderId(order.order_id)}
                >
                  <TableCell>
                    <p className="font-mono text-compact break-all select-all tabular-nums">
                      {order.posting_number}
                    </p>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <StateChip
                        status={order.state}
                        tone={orderStateTone(order.state)}
                        label={orderStateLabel(order.state)}
                      />
                      {order.cancel_requested ? (
                        <StateChip status="attest" tone="attest" label="请求取消" />
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-compact tabular-nums">
                      {order.lines.length}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="break-words text-compact">
                      {[...new Set(order.lines.map((line) => line.source?.name).filter(Boolean))]
                        .join("、") || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-compact tabular-nums">
                      {formatInstantValue(order.created_at_ms)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <CursorPagerFooter
            page={page}
            count={orders.length}
            hasNext={hasNext}
            cursor={cursor}
            busy={loading}
            onPrevious={() => {
              const next = cursors.slice(0, -1)
              setCursors(next)
              void loadOrders(next.at(-1) ?? "")
            }}
            onNext={() => {
              const next = [...cursors, cursor]
              setCursors(next)
              void loadOrders(cursor)
            }}
          />
        </div>
      )}
      {loading && orders.length === 0 ? (
        <div role="status" aria-live="polite" className="grid min-h-32 place-items-center">
          <Spinner className="size-5" aria-label="正在读取委托单" />
        </div>
      ) : null}
      <DelegateOrderDetailDialog
        orderId={openOrderId}
        onOpenChange={(next) => {
          if (!next) setOpenOrderId(null)
        }}
        onMutated={() => void loadOrders(cursors.at(-1) ?? "")}
      />
    </div>
  )
}

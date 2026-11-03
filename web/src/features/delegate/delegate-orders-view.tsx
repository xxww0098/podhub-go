/**
 * 委托单视图：单级状态过滤 + 分页列表；点行开详情（撤单/收口在详情里）。
 * 卖家 wire 只见单级状态与行级厂家/包状态，不见派发账本内部。
 */
import type { ReactNode } from "react"
import { useCallback, useEffect, useRef, useState } from "react"
import { Copy, Filter, RefreshCw, Search } from "lucide-react"

import type { DelegateOrder, DelegateOrderListData } from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import { CursorPagerFooter } from "@/components/cursor-pager-footer"
import {
  formatInstantValue,
  orderStateLabel,
  orderStateTone,
} from "./delegate-model"
import { DelegateOrderDetailDialog } from "./delegate-order-detail"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import {
  Empty,
  EmptyContent,
  EmptyHeader,
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
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"

const POLL_INTERVAL_MS = 60_000

const STATE_FILTERS: { value: string; label: string }[] = [
  { value: "", label: "全部状态" },
  { value: "awaiting_setup", label: "待完善" },
  { value: "ready", label: "待派发" },
  { value: "dispatched", label: "已派发" },
  { value: "in_production", label: "生产中" },
  { value: "shipped", label: "已发货" },
  { value: "done", label: "已完成" },
  { value: "cancelled", label: "已取消" },
]

export type DelegateOrdersViewProps = {
  scopeControls?: ReactNode
  viewTabs?: ReactNode
  storeId: string
  refreshKey: number
}

export function DelegateOrdersView({ storeId, refreshKey, scopeControls, viewTabs }: DelegateOrdersViewProps) {
  const [state, setState] = useState("")
  const [searchDraft, setSearchDraft] = useState("")
  const [search, setSearch] = useState("")
  const [pageSize, setPageSize] = useState(10)
  const [cursors, setCursors] = useState([""])
  const [pageData, setPageData] = useState<DelegateOrderListData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [openOrderId, setOpenOrderId] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const requestSequence = useRef(0)

  const loadOrders = useCallback(
    async (nextCursors: string[], advancing = false) => {
      if (!storeId) return
      const sequence = ++requestSequence.current
      setLoading(true)
      try {
        const data = await delegateHttp.listOrders({
          storeId,
          state: state || undefined,
          search: search || undefined,
          cursor: nextCursors.at(-1) || undefined,
          limit: pageSize,
        })
        if (sequence !== requestSequence.current) return
        if (advancing && data.orders.length === 0) {
          setPageData((current) => current ? { ...current, has_next: false, cursor: "" } : data)
        } else {
          setPageData(data)
          setCursors(nextCursors)
          const visibleIds = new Set(data.orders.map((order) => order.order_id))
          setSelectedIds((current) => new Set([...current].filter((id) => visibleIds.has(id))))
        }
        setFailed(false)
      } catch (reason) {
        if (sequence === requestSequence.current) {
          setFailed(true)
          notifyCommandError(reason, "读取委托单失败")
        }
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    },
    [storeId, state, search, pageSize],
  )

  useEffect(() => {
    requestSequence.current += 1
    setCursors([""])
    setSelectedIds(new Set())
    setPageData(null)
    setFailed(false)
    void loadOrders([""])
    return () => { requestSequence.current += 1 }
  }, [storeId, state, refreshKey, loadOrders])

  useVisiblePolling({
    enabled: Boolean(storeId),
    intervalMs: POLL_INTERVAL_MS,
    restartKey: `${storeId}:${state}:${search}:${cursors.at(-1) ?? ""}`,
    onPoll: (trigger) => {
      if (trigger === "mount") return // 装载已由 effect 负责
      void loadOrders(cursors)
    },
  })

  const page = cursors.length
  const orders = pageData?.orders ?? []
  const hasNext = pageData?.has_next ?? false
  const cursor = pageData?.cursor ?? ""
  const selectedOrders = orders.filter((order) => selectedIds.has(order.order_id))

  const copySelected = async () => {
    try {
      await navigator.clipboard.writeText(selectedOrders.map((order) => order.posting_number).join("\n"))
      notifySuccess(`已复制 ${selectedOrders.length} 条物流单号`)
    } catch {
      notifyError("无法复制物流单号，请检查浏览器剪贴板权限。")
    }
  }

  if (!storeId) return null

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex min-h-9 shrink-0 flex-wrap items-center justify-end gap-2">
        {scopeControls}
        <Button
          size="sm"
          variant="outline"
          aria-label="刷新委托单"
          disabled={loading}
          onClick={() => void loadOrders(cursors)}
        >
          <RefreshCw data-icon="inline-start" className={loading ? "animate-spin" : undefined} />
          刷新
        </Button>
      </div>
      {viewTabs}
      <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-2 rounded-lg border border-border bg-card p-2">
        <span className="text-compact text-muted-foreground">状态</span>
        <Select
          value={state}
          onValueChange={(next) => {
            if (next === null || next === state) return
            setState(next)
          }}
        >
          <SelectTrigger size="sm" className="min-w-32 max-md:h-11" aria-label="委托单状态">
            <SelectValue>
              {STATE_FILTERS.find((item) => item.value === state)?.label ?? "全部状态"}
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
        {selectedOrders.length > 0 ? <Button size="sm" variant="outline" disabled={loading || failed} onClick={() => void copySelected()}>
          <Copy data-icon="inline-start" />复制所选单号（{selectedOrders.length}）
        </Button> : null}
        <form
          className="ml-auto flex min-w-0 max-w-full flex-1 basis-full items-center gap-2 sm:max-w-sm sm:basis-56"
          role="search"
          onSubmit={(event) => {
            event.preventDefault()
            const next = searchDraft.trim()
            if (next === search) void loadOrders([""])
            else setSearch(next)
          }}
        >
          <InputGroup className="h-9 flex-1 max-md:h-11">
            <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
            <InputGroupInput
              type="search"
              aria-label="搜索物流单号或厂家"
              placeholder="搜索物流单号或厂家"
              maxLength={120}
              value={searchDraft}
              className="max-md:h-11"
              onChange={(event) => setSearchDraft(event.target.value)}
            />
          </InputGroup>
          <Button type="submit" aria-label="搜索委托单" size="sm" variant="outline" className="max-md:h-11"><Filter data-icon="inline-start" />筛选</Button>
        </form>
      </div>
      {failed && pageData ? <div role="status" className="flex flex-wrap items-center gap-2 text-compact text-muted-foreground">
        读取失败，显示上次结果。
        <Button size="sm" variant="outline" disabled={loading} onClick={() => void loadOrders(cursors)}>重试</Button>
      </div> : null}
      {failed && !pageData ? (
        <Empty className="min-h-40">
          <EmptyHeader><EmptyTitle>无法读取委托单</EmptyTitle></EmptyHeader>
          <EmptyContent>
            <Button size="sm" variant="outline" onClick={() => void loadOrders([""])}>
              重试
            </Button>
          </EmptyContent>
        </Empty>
      ) : pageData ? (
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card"
          aria-busy={loading}
        >
          <DelegateOrdersTable orders={orders} onOpenOrder={setOpenOrderId} selectedIds={selectedIds} onSelectedIds={setSelectedIds} selectionDisabled={loading || failed} />
          <div className="flex flex-wrap items-center border-t border-border pr-3">
          <div className="min-w-0 flex-1 [&_footer]:border-t-0"><CursorPagerFooter
            page={page}
            count={orders.length}
            hasNext={hasNext}
            cursor={cursor}
            busy={loading}
            onPrevious={() => {
              setSelectedIds(new Set())
              void loadOrders(cursors.slice(0, -1))
            }}
            onNext={() => {
              setSelectedIds(new Set())
              void loadOrders([...cursors, cursor], true)
            }}
          /></div>
          <Select value={String(pageSize)} onValueChange={(next) => {
            if (next === "10" || next === "20" || next === "50") setPageSize(Number(next))
          }}>
            <SelectTrigger size="sm" aria-label="每页条数" className="w-28 max-md:h-11"><SelectValue>{`${pageSize} 条/页`}</SelectValue></SelectTrigger>
            <SelectContent>{[10, 20, 50].map((size) => <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>)}</SelectContent>
          </Select>
          </div>
        </div>
      ) : null}
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
        onMutated={() => void loadOrders(cursors)}
      />
    </div>
  )
}

export function DelegateOrdersTable({ orders, onOpenOrder, selectedIds, onSelectedIds, selectionDisabled }: {
  orders: DelegateOrder[]
  onOpenOrder: (orderId: string) => void
  selectedIds: ReadonlySet<string>
  onSelectedIds: (ids: Set<string>) => void
  selectionDisabled?: boolean
}) {
  const selectedCount = orders.filter((order) => selectedIds.has(order.order_id)).length
  const allSelected = orders.length > 0 && selectedCount === orders.length
  return (
    <Table aria-label="委托单" className="min-w-[720px]" containerClassName="min-h-0 max-w-full flex-1 overflow-auto">
      <TableHeader>
        <TableRow>
          <TableHead className="w-10"><Checkbox aria-label="选择本页全部委托单" checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={selectionDisabled || orders.length === 0} onCheckedChange={(checked) => onSelectedIds(checked ? new Set(orders.map((order) => order.order_id)) : new Set())} /></TableHead>
          <TableHead className="w-52">物流单号</TableHead>
          <TableHead className="w-28">状态</TableHead>
          <TableHead className="w-16">行数</TableHead>
          <TableHead className="w-56">厂家</TableHead>
          <TableHead className="w-36">创建时间</TableHead>
          <TableHead className="w-20">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {orders.length === 0 ? (
          <TableRow>
            <TableCell colSpan={7} className="text-compact text-muted-foreground">
              <span className="sticky left-0 block w-full max-w-[calc(100vw-5rem)] py-3 text-center">没有符合条件的委托单</span>
            </TableCell>
          </TableRow>
        ) : null}
        {orders.map((order) => (
          <TableRow key={order.order_id} data-state={selectedIds.has(order.order_id) ? "selected" : undefined} className="cursor-pointer" onClick={() => onOpenOrder(order.order_id)}>
            <TableCell><Checkbox aria-label={`选择委托单 ${order.posting_number}`} checked={selectedIds.has(order.order_id)} disabled={selectionDisabled} onClick={(event) => event.stopPropagation()} onCheckedChange={(checked) => {
              const next = new Set(selectedIds)
              if (checked) next.add(order.order_id)
              else next.delete(order.order_id)
              onSelectedIds(next)
            }} /></TableCell>
            <TableCell>
              <p className="font-mono text-compact break-all select-all tabular-nums">{order.posting_number}</p>
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1">
                <StateChip status={order.state} tone={orderStateTone(order.state)} label={orderStateLabel(order.state)} />
                {order.cancel_requested ? <StateChip status="attest" tone="attest" label="请求取消" /> : null}
              </div>
            </TableCell>
            <TableCell><span className="font-mono text-compact tabular-nums">{order.lines.length}</span></TableCell>
            <TableCell>
              <span className="break-words text-compact">
                {[...new Set(order.lines.map((line) => line.source?.name).filter(Boolean))].join("、") || "—"}
              </span>
            </TableCell>
            <TableCell><span className="font-mono text-compact tabular-nums">{formatInstantValue(order.created_at_ms)}</span></TableCell>
            <TableCell>
              <Button aria-label={`查看委托单 ${order.posting_number}`} size="sm" variant="outline" onClick={(event) => {
                event.stopPropagation()
                onOpenOrder(order.order_id)
              }}>查看</Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

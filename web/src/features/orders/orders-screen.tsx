import { useEffect, useMemo, useRef, useState } from "react"
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Ellipsis, Receipt, RefreshCw } from "lucide-react"

import type { AdminPaymentOrderView } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import {
  PlatformAdminEmpty,
  PlatformAdminSearch,
  PlatformAdminSurface,
} from "@/components/platform-admin-surface"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { useScreenActive } from "@/components/screen-pane"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDateTimeShort } from "@/lib/format"
import { formatCents } from "@/lib/money"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

import { filterOrders, orderEntitlement, sortOrdersByTime, type OrderStatusFilter } from "./orders-model"

const ORDER_STATUS = {
  pending: { label: "待处理", tone: "attest" },
  paid: { label: "已支付", tone: "good" },
  canceled: { label: "已取消", tone: "bad" },
} as const satisfies Record<string, { label: string; tone: "attest" | "good" | "bad" }>

function knownStatus(status: string) {
  return Object.hasOwn(ORDER_STATUS, status) ? ORDER_STATUS[status as keyof typeof ORDER_STATUS] : undefined
}

function orderAmount(order: AdminPaymentOrderView) {
  if (order.currency.toUpperCase() === "CNY") return formatCents(order.amount_cents)
  return `${(order.amount_cents / 100).toFixed(2)} ${order.currency || "未知币种"}`
}

function orderStatus(status: string) {
  return knownStatus(status)?.label ?? (status || "未知")
}

export function OrdersScreen({
  onSessionMayChange,
}: {
  /** Confirming a remittance upgrades member seats on the paid Workspace — refresh the shell overview. */
  onSessionMayChange?: () => void | Promise<void>
} = {}) {
  const active = useScreenActive()
  const [orders, setOrders] = useState<AdminPaymentOrderView[]>()
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [confirming, setConfirming] = useState<AdminPaymentOrderView>()
  const [canceling, setCanceling] = useState<AdminPaymentOrderView>()
  const [viewing, setViewing] = useState<AdminPaymentOrderView>()
  const [status, setStatus] = useState<OrderStatusFilter>("all")
  const [query, setQuery] = useState("")
  const [workspace, setWorkspace] = useState("all")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)
  const [timeOrder, setTimeOrder] = useState<"asc" | "desc">("desc")
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const requestVersion = useRef(0)

  async function reload() {
    const version = ++requestVersion.current
    setBusy(true)
    setLoadFailed(false)
    try {
      const next = await adminHttp.adminListOrders()
      if (version !== requestVersion.current) return
      setOrders(next)
      setSelected(new Set())
      setLoadFailed(false)
    } catch (reason) {
      if (version !== requestVersion.current) return
      setSelected(new Set())
      setLoadFailed(true)
      notifyCommandError(reason, "加载支付订单失败")
    } finally {
      if (version === requestVersion.current) setBusy(false)
    }
  }

  useEffect(() => {
    if (active) void reload()
    return () => { requestVersion.current += 1 }
  }, [active])

  async function confirm(order: AdminPaymentOrderView) {
    setBusy(true)
    try {
      await adminHttp.adminConfirmOrder(order.public_id)
    } catch (reason) {
      notifyCommandError(reason, "确认结果未能核实，正在重新读取")
      setConfirming(undefined)
      await reload()
      return
    }
    setConfirming(undefined)
    notifySuccess("已确认到账")
    await reload()
    try {
      await onSessionMayChange?.()
    } catch (reason) {
      notifyCommandError(reason, "刷新工作空间信息失败")
    }
  }

  async function cancel(order: AdminPaymentOrderView) {
    setBusy(true)
    try {
      await adminHttp.adminCancelOrder(order.public_id)
      setCanceling(undefined)
      notifySuccess("已取消订单")
      await reload()
    } catch (reason) {
      notifyCommandError(reason, "取消结果未能核实，正在重新读取")
      setCanceling(undefined)
      await reload()
    }
  }

  const loaded = orders ?? []
  const workspaces = useMemo(() => {
    const unique = new Map<number, string>()
    for (const order of loaded) unique.set(order.org_id, order.workspace_name || `工作空间 ${order.org_id}`)
    return [...unique].sort((a, b) => a[1].localeCompare(b[1], "zh-CN"))
  }, [orders])
  const filtered = sortOrdersByTime(filterOrders(loaded, { status, query, workspace, from, to }), timeOrder)
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const currentPage = Math.min(page, pageCount)
  const visible = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])
  useEffect(() => { setSelected(new Set()) }, [status, query, workspace, from, to, currentPage, pageSize, timeOrder])
  const selectedOrders = visible.filter((order) => selected.has(order.public_id))
  const allSelected = visible.length > 0 && selectedOrders.length === visible.length
  const filteredByUser = status !== "all" || query.trim() !== "" || workspace !== "all" || from !== "" || to !== ""
  const counts = {
    all: loaded.length,
    pending: loaded.filter((order) => order.status === "pending").length,
    paid: loaded.filter((order) => order.status === "paid").length,
    canceled: loaded.filter((order) => order.status === "canceled").length,
  }

  function resetFilters() {
    setStatus("all")
    setQuery("")
    setWorkspace("all")
    setFrom("")
    setTo("")
    setPage(1)
  }

  async function copySelected() {
    try {
      await navigator.clipboard.writeText(selectedOrders.map((order) => order.public_id).join("\n"))
      notifySuccess(`已复制 ${selectedOrders.length} 个订单号`)
    } catch (reason) {
      notifyCommandError(reason, "无法复制订单号")
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col gap-2">
      <h1 className="sr-only">订单</h1>
      <PlatformAdminSurface bodyClassName="flex min-h-0 flex-col border-0">
        {orders ? (
          <>
            <div className="flex min-w-0 flex-wrap items-center gap-3 pb-3">
              <div role="group" aria-label="订单状态" className="flex flex-wrap items-center gap-2">
                {([
                  ["all", "全部", counts.all],
                  ["pending", "待处理", counts.pending],
                  ["canceled", "已取消", counts.canceled],
                  ["paid", "已支付", counts.paid],
                ] as const).map(([value, label, count]) => (
                  <Button key={value} type="button" size="lg" variant={status === value ? "brand" : "outline"} aria-pressed={status === value} aria-label={`筛选${label}，${count} 个`} onClick={() => { setStatus(value); setPage(1) }}>
                    {label} <span className="rounded-full bg-current/10 px-1.5 text-xs tabular-nums">{count}</span>
                  </Button>
                ))}
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-2 sm:ml-auto">
                <Input type="date" aria-label="开始日期" value={from} max={to || undefined} onChange={(event) => { setFrom(event.target.value); setPage(1) }} className="h-10 w-32" />
                <span aria-hidden="true" className="text-muted-foreground">—</span>
                <Input type="date" aria-label="结束日期" value={to} min={from || undefined} onChange={(event) => { setTo(event.target.value); setPage(1) }} className="h-10 w-32" />
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-compact font-medium">工作空间</span>
                  <Select value={workspace} onValueChange={(value) => { setWorkspace(value ?? "all"); setPage(1) }}>
                    <SelectTrigger aria-label="按工作空间筛选" className="h-10 w-24">
                      <SelectValue>{() => workspaces.find(([id]) => String(id) === workspace)?.[1] ?? "全部"}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">全部</SelectItem>
                      {workspaces.map(([id, name]) => <SelectItem key={id} value={String(id)}>{name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2 pb-3">
              <PlatformAdminSearch value={query} onChange={(value) => { setQuery(value); setPage(1) }} placeholder="搜索单号、工作空间或权益…" className="h-10 min-w-32 flex-1 basis-40 sm:max-w-none" />
              {selectedOrders.length > 0 ? <Button type="button" variant="outline" size="sm" disabled={busy || loadFailed} onClick={() => void copySelected()}>复制已选订单号（{selectedOrders.length}）</Button> : null}
              <Button type="button" variant="outline" size="icon-lg" aria-label="刷新订单" disabled={busy} onClick={() => void reload()}><RefreshCw aria-hidden /></Button>
              <span className="text-meta text-muted-foreground">仅在最近最多 200 条订单内筛选</span>
            </div>
            {loadFailed ? <p role="status" className="pb-2 text-compact text-st-bad">刷新失败，当前显示上次读取的数据。</p> : null}
            <div className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-card">
              <Table containerClassName="@container overflow-visible" className="min-w-[760px]" aria-label="订阅订单列表">
                <TableHeader className="sticky top-0 z-10 [&_th]:bg-brand-soft/50">
                  <TableRow className="hover:bg-transparent">
                    <TableHead><Checkbox aria-label="选择本页全部订单" disabled={busy || loadFailed || visible.length === 0} checked={allSelected} indeterminate={selectedOrders.length > 0 && !allSelected} onCheckedChange={(checked) => setSelected(checked ? new Set(visible.map((order) => order.public_id)) : new Set())} /></TableHead>
                    <TableHead>单号</TableHead><TableHead>工作空间</TableHead><TableHead>权益</TableHead><TableHead>金额</TableHead><TableHead>状态</TableHead>
                    <TableHead aria-sort={timeOrder === "asc" ? "ascending" : "descending"}>
                      <Button variant="ghost" size="sm" onClick={() => { setTimeOrder((current) => current === "asc" ? "desc" : "asc"); setPage(1) }} aria-label={`按时间${timeOrder === "asc" ? "降序" : "升序"}排列`}>
                        时间 {timeOrder === "asc" ? <ArrowUp aria-hidden /> : <ArrowDown aria-hidden />}
                      </Button>
                    </TableHead><TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visible.map((order) => (
                    <TableRow key={order.public_id} className="h-15" data-state={selected.has(order.public_id) ? "selected" : undefined}>
                      <TableCell><Checkbox aria-label={`选择订单 ${order.public_id}`} disabled={busy || loadFailed} checked={selected.has(order.public_id)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(order.public_id); else next.delete(order.public_id); return next })} /></TableCell>
                      <TableCell className="tabular-nums"><button type="button" className="block max-w-44 truncate text-left text-compact font-medium text-brand hover:underline" title={order.public_id} onClick={() => setViewing(order)}>{order.public_id}</button></TableCell>
                      <TableCell>
                        <span className="block max-w-64 truncate text-compact font-medium text-foreground" title={order.workspace_name}>{order.workspace_name || `工作空间 ${order.org_id}`}</span>
                        {order.created_by_email ? <span className="block max-w-64 truncate text-meta text-muted-foreground" title={order.created_by_email}>{order.created_by_email}</span> : null}
                      </TableCell>
                      <TableCell className="whitespace-nowrap text-compact">{orderEntitlement(order)}</TableCell>
                      <TableCell className="font-mono text-compact font-medium tabular-nums">{orderAmount(order)}</TableCell>
                      <TableCell><StateChip status={order.status} label={orderStatus(order.status)} tone={knownStatus(order.status)?.tone ?? "idle"} /></TableCell>
                      <TableCell className="whitespace-nowrap text-compact tabular-nums text-muted-foreground">{formatDateTimeShort(order.created_at)}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button size="sm" variant="link" onClick={() => setViewing(order)}>详情</Button>
                          {order.status === "pending" ? <DropdownMenu>
                            <DropdownMenuTrigger render={<Button size="icon-sm" variant="ghost" aria-label={`订单 ${order.public_id} 的更多操作`} disabled={busy || loadFailed} />}><Ellipsis aria-hidden /></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem onClick={() => setConfirming(order)}>确认收款</DropdownMenuItem>
                              {order.provider === "manual" ? <DropdownMenuItem variant="destructive" onClick={() => setCanceling(order)}>取消订单</DropdownMenuItem> : null}
                            </DropdownMenuContent>
                          </DropdownMenu> : null}
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {filtered.length === 0 ? <TableRow><TableCell colSpan={8}>
                    <PlatformAdminEmpty
                      className="sticky left-0 min-h-56 w-[calc(100cqw-1.5rem)] max-w-full"
                      icon={Receipt}
                      title={filteredByUser ? "没有匹配的订单" : "暂无订单"}
                      description={filteredByUser ? "调整筛选条件后重试。" : "当前没有可显示的支付订单。"}
                      action={filteredByUser ? <Button variant="outline" size="sm" onClick={resetFilters}>清除筛选</Button> : undefined}
                    />
                  </TableCell></TableRow> : null}
                </TableBody>
              </Table>
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1 pt-3">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <span>本次筛选 {filtered.length.toLocaleString("zh-CN")} 条，每页</span>
                <Select value={String(pageSize)} onValueChange={(value) => { if (value) { setPageSize(Number(value)); setPage(1) } }}>
                  <SelectTrigger size="sm" aria-label="每页订单数量"><SelectValue>{() => `${pageSize} 条`}</SelectValue></SelectTrigger>
                  <SelectContent>{[10, 20, 50].map((size) => <SelectItem key={size} value={String(size)}>{size} 条</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon-sm" aria-label="上一页" disabled={busy || currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft aria-hidden /></Button>
                <span aria-current="page" aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`} className="inline-flex size-9 items-center justify-center rounded-md bg-brand text-sm font-medium text-brand-foreground tabular-nums">{currentPage}</span>
                <Button variant="outline" size="icon-sm" aria-label="下一页" disabled={busy || currentPage >= pageCount} onClick={() => setPage(currentPage + 1)}><ChevronRight aria-hidden /></Button>
              </div>
            </div>
          </>
        ) : (
          <PlatformAdminEmpty
            icon={Receipt}
            busy={!loadFailed}
            title={loadFailed ? "无法加载订单" : "正在加载订单…"}
            description={loadFailed ? "请重试读取平台支付订单。" : undefined}
            action={loadFailed ? <Button variant="outline" onClick={() => void reload()}><RefreshCw data-icon="inline-start" />重试</Button> : undefined}
          />
        )}
      </PlatformAdminSurface>
      <PlatformAdminDialog open={viewing != null} onOpenChange={(open) => { if (!open) setViewing(undefined) }} title="订单详情" width="sm:max-w-md">
        {viewing ? <OrderDetails order={viewing} /> : null}
      </PlatformAdminDialog>
      <PlatformAdminDialog
        open={confirming != null}
        onOpenChange={(open) => { if (!open && !busy) setConfirming(undefined) }}
        title="确认到账"
        description="请核对工作空间和实际收款后确认入账。"
        width="sm:max-w-md"
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => setConfirming(undefined)}>取消</Button>
          <Button disabled={busy || loadFailed || !confirming} onClick={() => confirming && void confirm(confirming)}>
            {busy ? <Spinner data-icon="inline-start" /> : <Receipt data-icon="inline-start" />}确认入账
          </Button>
        </>}
      >
        {confirming ? <OrderDetails order={confirming} /> : null}
      </PlatformAdminDialog>
      <PlatformAdminDialog
        open={canceling != null}
        onOpenChange={(open) => { if (!open && !busy) setCanceling(undefined) }}
        title="取消订单"
        description="取消后，该订单将不能继续付款。请核对订单信息。"
        width="sm:max-w-md"
        footer={<>
          <Button variant="outline" disabled={busy} onClick={() => setCanceling(undefined)}>返回</Button>
          <Button variant="destructive" disabled={busy || loadFailed || !canceling} onClick={() => canceling && void cancel(canceling)}>{busy ? <Spinner data-icon="inline-start" /> : null}确认取消</Button>
        </>}
      >
        {canceling ? <OrderDetails order={canceling} /> : null}
      </PlatformAdminDialog>
    </div>
  )
}

function OrderDetails({ order }: { order: AdminPaymentOrderView }) {
  const fields = [
    ["订单单号", order.public_id],
    ["工作空间", order.workspace_name || `工作空间 ${order.org_id}`],
    ["权益", orderEntitlement(order)],
    ["订单金额", orderAmount(order)],
    ["状态", orderStatus(order.status)],
    ["支付方式", order.provider || "未知"],
    ["创建时间", formatDateTimeShort(order.created_at)],
    ...(order.paid_at ? [["支付时间", formatDateTimeShort(order.paid_at)]] : []),
    ...(order.canceled_at ? [["取消时间", formatDateTimeShort(order.canceled_at)]] : []),
  ]
  return (
    <dl className="divide-y divide-border px-5 py-2 text-compact">
      {fields.map(([label, value]) => <div key={label} className="flex flex-col gap-1 py-2.5 sm:flex-row sm:items-start sm:justify-between sm:gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-all font-medium text-foreground sm:text-right">{value}</dd></div>)}
    </dl>
  )
}

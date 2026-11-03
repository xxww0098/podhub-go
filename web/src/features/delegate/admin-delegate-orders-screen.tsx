/**
 * 管理面「委托单」屏 (ADR-0100；「全部委托单/派发账本/代录回执」=
 * admin+)。`/admin?screen=admin-delegate-orders`，平台侧栏可进入。
 *
 * 队列（单级状态 / 厂家 / Workspace 过滤 + keyset 分页）→ 点行进详情
 * （行、派发包账本、物流快照、随单备注）+ 三个动作：手动派发（选厂家
 * 可选 / 行可选）、代录回执（运单号 + 备注）、撤单确认。详情打开态是
 * 地址（`?order=`），刷新/分享停在同一个单上。错误文案只走 toast，不进
 * DOM；状态色沿用委托订单屏的中文口径与 tone 词汇。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { ArrowLeft, ClipboardList, Inbox, RefreshCw, Search, Send, Truck } from "lucide-react"

import {
  cancelAdminDelegateOrder,
  dispatchAdminDelegateOrder,
  getAdminDelegateOrder,
  listAdminDelegateOrders,
  recordAdminDelegateReceipt,
  type AdminDelegateOrderDetailView,
  type AdminDelegateOrderListData,
  type AdminDelegateOrderRow,
  type DelegateOrderLineView,
  type SellerSupplierDbData,
} from "@/bindings/http-delegate-admin"
import { factoriesHttp } from "@/bindings/http-factories"
import { CursorPagerFooter } from "@/components/cursor-pager-footer"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyContent, EmptyMedia } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
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
import { KeyValue, KeyValueGrid } from "@/components/section"
import { StateChip } from "@/components/state-chip"
import { formatDateTimeShort } from "@/lib/format"
import { notifyCommandError, notifyError, notifySuccess } from "@/lib/notify"
import { replaceAddress } from "@/lib/address"
import {
  formatInstantValue,
  orderStateLabel,
  orderStateTone,
  packetStateLabel,
  packetStateTone,
} from "./delegate-model"

const QUEUE_STATES = [
  "awaiting_setup",
  "ready",
  "dispatched",
  "in_production",
  "shipped",
  "done",
  "cancelled",
] as const

const QUEUE_STATE_LABELS: Record<string, string> = {
  awaiting_setup: "待完善",
  ready: "待派发",
  dispatched: "已派发",
  in_production: "生产中",
  shipped: "已发货",
  done: "已完成",
  cancelled: "已取消",
}

/** 详情打开态就是地址：`?order=<order_id>`（壳层换屏收掉这个键，回程队列）。 */
function orderFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get("order")?.trim()
  return id || null
}

function writeOrderParam(orderId: string | null): void {
  if (typeof window === "undefined") return
  try {
    const url = new URL(window.location.href)
    if (orderId) {
      url.searchParams.set("screen", "admin-delegate-orders")
      url.searchParams.set("order", orderId)
    } else {
      url.searchParams.delete("order")
    }
    replaceAddress(url.href)
  } catch {
    // A URL the browser refuses is not worth failing navigation for.
  }
}

export function AdminDelegateOrdersScreen() {
  const [orderId, setOrderId] = useState<string | null>(() =>
    orderFromSearch(window.location.search),
  )

  return orderId ? (
    <AdminDelegateOrderDetail
      orderId={orderId}
      onBack={() => {
        setOrderId(null)
        writeOrderParam(null)
      }}
    />
  ) : (
    <AdminDelegateQueue
      onOpen={(id) => {
        setOrderId(id)
        writeOrderParam(id)
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// 队列
// ---------------------------------------------------------------------------

function AdminDelegateQueue({ onOpen }: { onOpen: (orderId: string) => void }) {
  const [pageData, setPageData] = useState<AdminDelegateOrderListData | null>(null)
  const [sources, setSources] = useState<SellerSupplierDbData[]>([])
  const [sourcesFailed, setSourcesFailed] = useState(false)
  const [state, setState] = useState<string>("")
  const [sourceId, setSourceId] = useState<string>("")
  const [orgId, setOrgId] = useState<string>("")
  const [search, setSearch] = useState("")
  const [pageSize, setPageSize] = useState(10)
  const [cursors, setCursors] = useState([""])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const requestSequence = useRef(0)
  const sourceSequence = useRef(0)

  const refresh = useCallback(
    async (nextCursors: string[], advancing = false) => {
      const sequence = ++requestSequence.current
      setLoading(true)
      try {
        const data = await listAdminDelegateOrders({
          state: state === "" ? undefined : state,
          sourceId: sourceId === "" ? undefined : sourceId,
          orgId: orgId.trim() || undefined,
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
          notifyCommandError(reason, "委托单队列读取失败，请稍后重试。")
        }
      } finally {
        if (sequence === requestSequence.current) setLoading(false)
      }
    },
    [state, sourceId, orgId, pageSize],
  )

  useEffect(() => {
    requestSequence.current += 1
    setCursors([""])
    setSelectedIds(new Set())
    setPageData(null)
    setFailed(false)
    void refresh([""])
    return () => { requestSequence.current += 1 }
  }, [refresh])

  const loadSources = useCallback(async () => {
    // 管理员可筛选所有工厂的商品库；目录只返回库的公开标识和名称。
    const sequence = ++sourceSequence.current
    try {
      const data = await factoriesHttp.list()
      if (sequence === sourceSequence.current) {
        setSources(data.factories.flatMap((factory) => (factory.libraries ?? []).map((db) => ({ source_id: db.sourceId, name: db.name, country: db.country, icon: db.icon }))))
        setSourcesFailed(false)
      }
    } catch {
      if (sequence === sourceSequence.current) setSourcesFailed(true)
    }
  }, [])

  useEffect(() => {
    void loadSources()
    return () => { sourceSequence.current += 1 }
  }, [loadSources])

  const rows = pageData?.orders ?? []
  const term = search.trim().toLocaleLowerCase()
  const visibleRows = term ? rows.filter((row) => row.posting_number.toLocaleLowerCase().includes(term)) : rows
  const selectedRows = visibleRows.filter((row) => selectedIds.has(row.order_id))
  const copySelected = async () => {
    try {
      await navigator.clipboard.writeText(selectedRows.map((row) => row.posting_number).join("\n"))
      notifySuccess(`已复制 ${selectedRows.length} 条物流单号`)
    } catch {
      notifyError("无法复制物流单号，请检查浏览器剪贴板权限。")
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <h1 className="sr-only">委托单</h1>
      <div className="grid grid-cols-2 items-end gap-4 rounded-xl border border-border bg-card p-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)_auto]">
        <Field className="min-w-0">
          <FieldLabel htmlFor="admin-delegate-state">状态</FieldLabel>
          <Select
            value={state}
            onValueChange={(next) => {
              if (typeof next === "string") setState(next)
            }}
          >
            <SelectTrigger id="admin-delegate-state" aria-label="按状态过滤">
              <SelectValue>
                {() => QUEUE_STATE_LABELS[state] ?? "全部状态"}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">全部状态</SelectItem>
              {QUEUE_STATES.map((candidate) => (
                <SelectItem key={candidate} value={candidate}>
                  {QUEUE_STATE_LABELS[candidate]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor="admin-delegate-source">商品库</FieldLabel>
          <Select
            value={sourceId}
            onValueChange={(next) => {
              if (typeof next === "string") setSourceId(next)
            }}
          >
            <SelectTrigger id="admin-delegate-source" aria-label="按商品库过滤" disabled={sourcesFailed && sources.length === 0}>
              <SelectValue>
                {() =>
                  sources.find((source) => source.source_id === sourceId)?.name ??
                  "全部商品库"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">全部商品库</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.source_id} value={source.source_id}>
                  {source.name || source.source_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {sourcesFailed ? <p role="status" className="text-compact text-st-bad">商品库列表读取失败，请刷新重试。</p> : null}
        </Field>
        <Field className="min-w-0">
          <FieldLabel htmlFor="admin-delegate-org">工作空间 ID</FieldLabel>
          <Input
            id="admin-delegate-org"
            inputMode="numeric"
            value={orgId}
            placeholder="全部工作空间"
            className="max-md:min-h-11"
            onChange={(event) =>
              setOrgId(event.target.value.replace(/[^\d]/g, ""))
            }
          />
        </Field>
        <Button type="button" variant="outline" size="lg" className="justify-self-end" aria-label={loading ? "正在刷新委托单" : "刷新委托单"} aria-busy={loading} disabled={loading} onClick={() => { void refresh(cursors); void loadSources() }}>
          {loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}刷新
        </Button>
      </div>
      {failed && !pageData ? (
        <Empty className="min-h-40">
          <EmptyContent>
            <p>无法读取委托单，请重试。</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void refresh([""])}>重试</Button>
          </EmptyContent>
        </Empty>
      ) : pageData ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card" aria-busy={loading}>
          {failed ? <p role="status" className="px-3 py-2 text-compact text-muted-foreground">读取失败，显示上次结果。</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex items-center gap-2">
              <ClipboardList aria-hidden className="size-6" />
              <h2 className="text-2xl font-semibold">委托单</h2>
              <Badge variant="brand">本页 {rows.length} 单</Badge>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-2">
            {selectedRows.length > 0 ? <Button type="button" variant="outline" size="sm" disabled={loading || failed} onClick={() => void copySelected()}>复制已选单号（{selectedRows.length}）</Button> : null}
            <InputGroup className="w-64 max-w-full max-md:h-11">
              <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
              <InputGroupInput
                type="search"
                aria-label="搜索本页物流单号"
                placeholder="搜索本页物流单号"
                className="max-md:min-h-11"
                value={search}
                onChange={(event) => { setSearch(event.target.value); setSelectedIds(new Set()) }}
              />
            </InputGroup>
            </div>
          </div>
          <AdminDelegateOrdersTable rows={visibleRows} onOpen={onOpen} selectedIds={selectedIds} onSelectedIds={setSelectedIds} selectionDisabled={loading || failed} emptyText={term ? "本页没有匹配的物流单号。" : "没有符合条件的委托单。"} />
          <div className="flex flex-wrap items-center gap-3 px-4">
          <Select value={String(pageSize)} onValueChange={(next) => {
            if (next === "10" || next === "20" || next === "50") setPageSize(Number(next))
          }}>
            <SelectTrigger size="sm" aria-label="每页条数" className="w-28 max-md:h-11"><SelectValue>{`${pageSize} 条/页`}</SelectValue></SelectTrigger>
            <SelectContent>{[10, 20, 50].map((size) => <SelectItem key={size} value={String(size)}>{size} 条/页</SelectItem>)}</SelectContent>
          </Select>
          <div className="min-w-0 flex-1">
          <CursorPagerFooter
            page={cursors.length}
            count={rows.length}
            hasNext={pageData.has_next}
            cursor={pageData.cursor}
            busy={loading}
            onPrevious={() => void refresh(cursors.slice(0, -1))}
            onNext={() => void refresh([...cursors, pageData.cursor], true)}
          />
          </div>
          </div>
        </div>
      ) : null}
      {loading && !pageData ? (
        <div className="flex min-h-40 items-center justify-center" role="status">
          <Spinner className="size-5" aria-label="正在读取委托单队列" />
        </div>
      ) : null}
    </div>
  )
}

export function AdminDelegateOrdersTable({ rows, onOpen, selectedIds = new Set(), onSelectedIds = () => {}, selectionDisabled, emptyText = "没有符合条件的委托单。" }: {
  rows: AdminDelegateOrderRow[]
  onOpen: (orderId: string) => void
  selectedIds?: ReadonlySet<string>
  onSelectedIds?: (ids: Set<string>) => void
  selectionDisabled?: boolean
  emptyText?: string
}) {
  const selectedCount = rows.filter((row) => selectedIds.has(row.order_id)).length
  const allSelected = rows.length > 0 && selectedCount === rows.length
  return (
    <Table aria-label="委托单队列" className="min-w-[720px]" containerClassName="@container min-h-0 max-w-full flex-1 overflow-auto">
      <TableHeader className="sticky top-0 z-10 bg-muted">
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-12"><Checkbox aria-label="选择本页显示的委托单" checked={allSelected} indeterminate={selectedCount > 0 && !allSelected} disabled={selectionDisabled || rows.length === 0} onCheckedChange={(checked) => onSelectedIds(checked ? new Set(rows.map((row) => row.order_id)) : new Set())} /></TableHead>
          <TableHead className="text-lg text-foreground">物流单号</TableHead>
          <TableHead className="text-lg text-foreground">工作空间 ID</TableHead>
          <TableHead className="text-lg text-foreground">厂家</TableHead>
          <TableHead className="text-lg text-foreground">状态</TableHead>
          <TableHead className="text-lg text-foreground">建单时间</TableHead>
          <TableHead className="text-lg text-foreground">操作</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length ? rows.map((row) => (
          <TableRow key={row.order_id} data-state={selectedIds.has(row.order_id) ? "selected" : undefined} className="h-16 cursor-pointer" onClick={() => onOpen(row.order_id)}>
            <TableCell><Checkbox aria-label={`选择委托单 ${row.posting_number}`} checked={selectedIds.has(row.order_id)} disabled={selectionDisabled} onClick={(event) => event.stopPropagation()} onCheckedChange={(checked) => {
              const next = new Set(selectedIds)
              if (checked) next.add(row.order_id)
              else next.delete(row.order_id)
              onSelectedIds(next)
            }} /></TableCell>
            <TableCell className="font-mono text-lg">
              <span className="flex items-center gap-2">
                {row.posting_number}
                {row.cancel_requested ? <Badge variant="outline">请求取消</Badge> : null}
              </span>
            </TableCell>
            <TableCell className="text-lg tabular-nums">{row.org_id}</TableCell>
            <TableCell className="text-lg">{row.source_names.length ? row.source_names.join("、") : "—"}</TableCell>
            <TableCell><StateChip status={row.state} tone={orderStateTone(row.state)} label={orderStateLabel(row.state)} className="h-8 px-3 text-lg" /></TableCell>
            <TableCell className="text-lg whitespace-nowrap text-muted-foreground">{formatDateTimeShort(row.created_at_ms)}</TableCell>
            <TableCell>
              <Button type="button" size="lg" variant="outline" aria-label={`查看委托单 ${row.posting_number}`} onClick={(event) => { event.stopPropagation(); onOpen(row.order_id) }}><span className="text-brand">查看</span></Button>
            </TableCell>
          </TableRow>
        )) : <TableRow><TableCell colSpan={7} className="p-0">
          <div className="sticky left-0 w-[100cqw] max-w-full">
            <Empty className="min-h-40">
              <EmptyMedia variant="icon"><Inbox aria-hidden /></EmptyMedia>
              <EmptyContent>{emptyText}</EmptyContent>
            </Empty>
          </div>
        </TableCell></TableRow>}
      </TableBody>
    </Table>
  )
}

// ---------------------------------------------------------------------------
// 详情 + 三个动作
// ---------------------------------------------------------------------------

function AdminDelegateOrderDetail({
  orderId,
  onBack,
}: {
  orderId: string
  onBack: () => void
}) {
  const [detail, setDetail] = useState<AdminDelegateOrderDetailView>()
  const [readFailed, setReadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const refresh = useCallback(async () => {
    setReadFailed(false)
    try {
      setDetail(await getAdminDelegateOrder(orderId))
    } catch (reason) {
      setReadFailed(true)
      notifyCommandError(reason, "委托单详情读取失败，请稍后重试。")
    }
  }, [orderId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const mutate = useCallback(
    async (action: () => Promise<AdminDelegateOrderDetailView>) => {
      setBusy(true)
      try {
        setDetail(await action())
      } catch (reason) {
        notifyCommandError(reason, "操作失败，请稍后重试。")
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  if (detail === undefined) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-3" role="status">
        {readFailed ? <>
          <p>无法读取委托单详情。</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onBack}>返回队列</Button>
            <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>重试</Button>
          </div>
        </> : <Spinner className="size-5" aria-label="正在读取委托单详情" />}
      </div>
    )
  }

  const { order, ledger } = detail
  const terminal = order.state === "done" || order.state === "cancelled"
  const dispatchable = !terminal && order.state !== "shipped"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <IconButton
            icon={ArrowLeft}
            label="返回队列"
            onClick={onBack}
          />
          <h1 className="font-mono text-md font-semibold tracking-[-0.01em] break-all">
            {order.posting_number}
          </h1>
          <StateChip
            status={order.state}
            tone={orderStateTone(order.state)}
            label={orderStateLabel(order.state)}
          />
          {order.cancel_requested ? (
            <StateChip status="attest" tone="attest" label="已请求取消" />
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || !dispatchable}
            onClick={() => setDispatchOpen(true)}
          >
            <Send data-icon="inline-start" />
            手动派发
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || terminal}
            onClick={() => setReceiptOpen(true)}
          >
            <Truck data-icon="inline-start" />
            代录回执
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={busy || terminal}
            onClick={() => setCancelOpen(true)}
          >
            撤单
          </Button>
        </div>
      </div>

      <KeyValueGrid>
        <KeyValue label="店铺" value={order.store_id} mono />
        <KeyValue label="随单备注" value={order.seller_note === "" ? "—" : order.seller_note} />
        <KeyValue
          label="物流快照"
          value={
            order.logistics == null
              ? "尚未取得（阻塞派发）"
              : `${logisticsField(order, "warehouse")} · ${logisticsField(order, "delivery_method")} · 截止 ${logisticsField(order, "shipment_date")}`
          }
        />
        <KeyValue
          label="Ozon 状态"
          value={`${snapshotField(order, "status")} / ${snapshotField(order, "substatus")}`}
        />
        <KeyValue
          label="备货截止"
          value={formatInstantValue(snapshotField(order, "shipment_date"))}
        />
      </KeyValueGrid>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-compact font-medium">商品行</span>
        </header>
        <Table aria-label="委托单商品行">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>商品</TableHead>
              <TableHead>offer_id</TableHead>
              <TableHead>数量</TableHead>
              <TableHead>厂家</TableHead>
              <TableHead>包状态</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {order.lines.map((line: DelegateOrderLineView) => (
              <TableRow key={line.line_id}>
                <TableCell className="text-compact">{line.name}</TableCell>
                <TableCell className="font-mono text-compact">
                  {line.offer_id}
                </TableCell>
                <TableCell className="text-compact tabular-nums">
                  {line.quantity}
                </TableCell>
                <TableCell className="text-compact">
                  {line.source ? line.source.name || line.source.source_id : "未绑定"}
                </TableCell>
                <TableCell>
                  {line.packet_state ? (
                    <StateChip
                      status={line.packet_state}
                      tone={packetStateTone(line.packet_state)}
                      label={packetStateLabel(line.packet_state)}
                    />
                  ) : (
                    <span className="text-compact text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <section className="rounded-xl border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-compact font-medium">派发包账本</span>
          <Badge variant="outline">{ledger.length} 包</Badge>
        </header>
        {ledger.length === 0 ? (
          <div className="flex items-center gap-2 px-4 py-6 text-compact text-muted-foreground">
            <ClipboardList className="size-4" aria-hidden />
            还没有派发包。
          </div>
        ) : (
          <Table aria-label="派发包账本">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>包号</TableHead>
                <TableHead>厂家</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>行数</TableHead>
                <TableHead>发起方</TableHead>
                <TableHead>回执</TableHead>
                <TableHead>创建时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ledger.map((packet) => (
                <TableRow key={packet.dispatch_id}>
                  <TableCell className="font-mono text-compact">
                    {packet.dispatch_no}
                  </TableCell>
                  <TableCell className="text-compact">
                    {packet.source.name || packet.source.source_id}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={packet.state}
                      tone={packetStateTone(packet.state)}
                      label={packetStateLabel(packet.state)}
                    />
                  </TableCell>
                  <TableCell className="text-compact tabular-nums">
                    {packet.line_count}
                  </TableCell>
                  <TableCell className="font-mono text-compact">
                    {packet.attempted_by}
                  </TableCell>
                  <TableCell className="text-compact">
                    {receiptSummary(packet.receipt)}
                  </TableCell>
                  <TableCell className="text-meta whitespace-nowrap text-muted-foreground">
                    {formatDateTimeShort(packet.created_at_ms)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <DispatchDialog
        open={dispatchOpen}
        order={order}
        busy={busy}
        onClose={() => setDispatchOpen(false)}
        onDispatched={(payload) => {
          setDispatchOpen(false)
          void mutate(async () => {
            const next = await dispatchAdminDelegateOrder(orderId, payload)
            notifySuccess("已写入手动派发包")
            return next
          })
        }}
      />
      <ReceiptDialog
        open={receiptOpen}
        busy={busy}
        onClose={() => setReceiptOpen(false)}
        onRecorded={(payload) => {
          setReceiptOpen(false)
          void mutate(async () => {
            const next = await recordAdminDelegateReceipt(orderId, payload)
            notifySuccess("已代录回执，包转为已发货")
            return next
          })
        }}
      />
      <ConfirmDialog
        open={cancelOpen}
        title="撤单"
        description="未接单的包立即划线、单转已取消；厂家已接单时改为记录「请求取消」旗标，等厂家/管理员收口。"
        confirmText="撤单"
        onConfirm={() => {
          setCancelOpen(false)
          void mutate(async () => {
            const next = await cancelAdminDelegateOrder(orderId)
            notifySuccess("撤单动作已落定")
            return next
          })
        }}
        onOpenChange={(open) => {
          if (!open) setCancelOpen(false)
        }}
      />
    </div>
  )
}

/** 快照/物流是服务端 jsonb（生成类型 `unknown`）：安全读键，缺省「—」。 */
function snapshotField(
  order: AdminDelegateOrderDetailView["order"],
  field: string,
): string {
  const snapshot = order.posting_snapshot
  if (typeof snapshot !== "object" || snapshot === null) return "—"
  const value = (snapshot as Record<string, unknown>)[field]
  return typeof value === "string" && value.trim() !== "" ? value : "—"
}

function logisticsField(
  order: AdminDelegateOrderDetailView["order"],
  field: string,
): string {
  if (order.logistics == null || typeof order.logistics !== "object") return "—"
  const value = (order.logistics as Record<string, unknown>)[field]
  return typeof value === "string" && value.trim() !== "" ? value : "—"
}

function receiptSummary(
  receipt?: AdminDelegateOrderDetailView["ledger"][number]["receipt"],
): string {
  if (!receipt) return "—"
  const parts: string[] = []
  if (receipt.tracking_no) parts.push(`运单 ${receipt.tracking_no}`)
  if (receipt.reason) parts.push(`拒因 ${receipt.reason}`)
  if (receipt.note) parts.push(receipt.note)
  if (receipt.recorded_by) parts.push(`代录 ${receipt.recorded_by}`)
  return parts.length > 0 ? parts.join(" · ") : "—"
}

/** 详情行的厂家选择候选：行上出现的厂家（绑定 ∪ 包）。 */
function factoriesOf(order: AdminDelegateOrderDetailView["order"]): SellerSupplierDbData[] {
  const seen = new Map<string, SellerSupplierDbData>()
  for (const line of order.lines) {
    if (line.source && !seen.has(line.source.source_id)) {
      seen.set(line.source.source_id, line.source)
    }
  }
  return [...seen.values()]
}

function DispatchDialog({
  open,
  order,
  busy,
  onClose,
  onDispatched,
}: {
  open: boolean
  order: AdminDelegateOrderDetailView["order"]
  busy: boolean
  onClose: () => void
  onDispatched: (payload: { sourceId?: string; lineIds?: string[] }) => void
}) {
  const factories = factoriesOf(order)
  const [sourceId, setSourceId] = useState<string>("")
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    if (open) {
      setSourceId("")
      setSelected(new Set())
    }
  }, [open])

  function submit() {
    const lineIds = selected.size > 0 ? [...selected] : undefined
    onDispatched({
      sourceId: sourceId === "" ? undefined : sourceId,
      lineIds,
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>手动派发</DialogTitle>
          <DialogDescription>
            人工派发无视拒单记录并解除它。不选厂家 = 各行按当前绑定厂家派；
            不选行 = 全部可派行。指定厂家时只派绑定该厂的行。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-dispatch-source">
              厂家（可选，缺省按行绑定）
            </FieldLabel>
            <Select
              value={sourceId}
              onValueChange={(next) => {
                if (typeof next === "string") setSourceId(next)
              }}
            >
              <SelectTrigger id="admin-dispatch-source" aria-label="派发厂家">
                <SelectValue>
                  {() =>
                    factories.find((factory) => factory.source_id === sourceId)
                      ?.name ?? "按行绑定厂家"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">按行绑定厂家</SelectItem>
                {factories.map((factory) => (
                  <SelectItem key={factory.source_id} value={factory.source_id}>
                    {factory.name || factory.source_id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel>行（可选，缺省全部可派行）</FieldLabel>
            <div className="flex flex-col gap-2">
              {order.lines.map((line) => (
                <label
                  key={line.line_id}
                  className="flex items-center gap-2 text-compact"
                >
                  <input
                    type="checkbox"
                    className="accent-primary"
                    checked={selected.has(line.line_id)}
                    onChange={(event) => {
                      setSelected((current) => {
                        const next = new Set(current)
                        if (event.target.checked) next.add(line.line_id)
                        else next.delete(line.line_id)
                        return next
                      })
                    }}
                  />
                  <span className="font-mono">{line.offer_id}</span>
                  <span>{line.name}</span>
                  {line.source ? (
                    <span className="text-muted-foreground">
                      {line.source.name || line.source.source_id}
                    </span>
                  ) : null}
                </label>
              ))}
            </div>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={submit}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            派发
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ReceiptDialog({
  open,
  busy,
  onClose,
  onRecorded,
}: {
  open: boolean
  busy: boolean
  onClose: () => void
  onRecorded: (payload: { trackingNo?: string; note?: string }) => void
}) {
  const [trackingNo, setTrackingNo] = useState("")
  const [note, setNote] = useState("")

  useEffect(() => {
    if (open) {
      setTrackingNo("")
      setNote("")
    }
  }, [open])

  function submit() {
    if (trackingNo.trim() === "" && note.trim() === "") {
      notifyError("请至少填写运单号或备注")
      return
    }
    onRecorded({
      trackingNo: trackingNo.trim() === "" ? undefined : trackingNo.trim(),
      note: note.trim() === "" ? undefined : note.trim(),
    })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>代厂家录回执</DialogTitle>
          <DialogDescription>
            对这张单最新的待接单/生产中包录发货回执（线下与厂家沟通后收口）；
            包转为已发货并通知卖家。终态单不可录。
          </DialogDescription>
        </DialogHeader>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="admin-receipt-tracking">运单号（可选）</FieldLabel>
            <Input
              id="admin-receipt-tracking"
              value={trackingNo}
              onChange={(event) => setTrackingNo(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="admin-receipt-note">备注（可选）</FieldLabel>
            <Input
              id="admin-receipt-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            取消
          </Button>
          <Button type="button" disabled={busy} onClick={submit}>
            {busy ? <Spinner data-icon="inline-start" /> : null}
            录回执
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

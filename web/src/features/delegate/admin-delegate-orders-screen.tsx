/**
 * 管理面「委托单」屏 (ADR-0100；「全部委托单/派发账本/代录回执」=
 * admin+)。`/admin?screen=admin-delegate-orders`，URL-only 注册
 * （无侧边栏项，同「厂家账号」口径）。
 *
 * 队列（单级状态 / 厂家 / Workspace 过滤 + keyset 分页）→ 点行进详情
 * （行、派发包账本、物流快照、随单备注）+ 三个动作：手动派发（选厂家
 * 可选 / 行可选）、代录回执（运单号 + 备注）、撤单确认。详情打开态是
 * 地址（`?order=`），刷新/分享停在同一个单上。错误文案只走 toast，不进
 * DOM；状态色沿用委托订单屏的中文口径与 tone 词汇。
 */
import { useCallback, useEffect, useState } from "react"
import { ArrowLeft, Send, Truck } from "lucide-react"

import {
  cancelAdminDelegateOrder,
  dispatchAdminDelegateOrder,
  getAdminDelegateOrder,
  listAdminDelegateOrders,
  recordAdminDelegateReceipt,
  type AdminDelegateOrderDetailView,
  type AdminDelegateOrderRow,
  type DelegateOrderLineView,
  type SellerSupplierDbData,
} from "@/bindings/http-delegate-admin"
import type { SupplierAccountsGroup } from "@/bindings/http-supplier-portal"
import { listSupplierAccounts } from "@/bindings/http-supplier-portal"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { ClipboardList, Inbox } from "lucide-react"
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
  const [rows, setRows] = useState<AdminDelegateOrderRow[]>()
  const [sources, setSources] = useState<SellerSupplierDbData[]>([])
  const [state, setState] = useState<string>("")
  const [sourceId, setSourceId] = useState<string>("")
  const [orgId, setOrgId] = useState<string>("")
  const [cursor, setCursor] = useState<string>("")
  const [hasNext, setHasNext] = useState(false)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(
    async (nextCursor?: string) => {
      setLoading(true)
      try {
        const data = await listAdminDelegateOrders({
          state: state === "" ? undefined : state,
          sourceId: sourceId === "" ? undefined : sourceId,
          orgId: orgId.trim() === "" ? undefined : Number(orgId.trim()),
          cursor: nextCursor,
        })
        setRows(data.orders)
        setHasNext(data.has_next)
        setCursor(data.cursor)
      } catch (reason) {
        notifyCommandError(reason, "委托单队列读取失败，请稍后重试。")
        setRows((current) => current ?? [])
      } finally {
        setLoading(false)
      }
    },
    [state, sourceId, orgId],
  )

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    // 厂家过滤器候选 = 全部厂家（厂家账号管理面的分组视图，admin 可读）。
    listSupplierAccounts()
      .then((data) =>
        setSources(
          data.groups.map((group: SupplierAccountsGroup) => group.source),
        ),
      )
      .catch(() => setSources([]))
  }, [])

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div>
        <h1 className="text-md font-semibold tracking-[-0.01em]">委托单</h1>
        <p className="text-compact text-muted-foreground">
          全部 Workspace 的委托单队列与派发包账本；可手动派发、代厂家录回执、
          撤单。
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="w-40">
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
        <Field className="w-48">
          <FieldLabel htmlFor="admin-delegate-source">厂家</FieldLabel>
          <Select
            value={sourceId}
            onValueChange={(next) => {
              if (typeof next === "string") setSourceId(next)
            }}
          >
            <SelectTrigger id="admin-delegate-source" aria-label="按厂家过滤">
              <SelectValue>
                {() =>
                  sources.find((source) => source.source_id === sourceId)?.name ??
                  "全部厂家"
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">全部厂家</SelectItem>
              {sources.map((source) => (
                <SelectItem key={source.source_id} value={source.source_id}>
                  {source.name || source.source_id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-36">
          <FieldLabel htmlFor="admin-delegate-org">Workspace ID</FieldLabel>
          <Input
            id="admin-delegate-org"
            inputMode="numeric"
            value={orgId}
            placeholder="全部"
            onChange={(event) =>
              setOrgId(event.target.value.replace(/[^\d]/g, ""))
            }
          />
        </Field>
      </div>
      {rows === undefined ? (
        <div className="flex min-h-40 items-center justify-center">
          <Spinner className="size-5" aria-label="正在读取委托单队列" />
        </div>
      ) : rows.length === 0 ? (
        <Empty>
          <EmptyMedia variant="icon">
            <Inbox />
          </EmptyMedia>
          <EmptyContent>还没有委托单。卖家委托出单后会出现在这里。</EmptyContent>
        </Empty>
      ) : (
        <>
          <Table aria-label="委托单队列">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>物流单号</TableHead>
                <TableHead>Workspace</TableHead>
                <TableHead>状态</TableHead>
                <TableHead>行数</TableHead>
                <TableHead>厂家</TableHead>
                <TableHead>建单时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row.order_id}
                  className="cursor-pointer"
                  onClick={() => onOpen(row.order_id)}
                >
                  <TableCell className="font-mono text-compact">
                    <span className="flex items-center gap-2">
                      {row.posting_number}
                      {row.cancel_requested ? (
                        <Badge variant="outline">请求取消</Badge>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-compact tabular-nums">
                    {row.org_id}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={row.state}
                      tone={orderStateTone(row.state)}
                      label={orderStateLabel(row.state)}
                    />
                  </TableCell>
                  <TableCell className="text-compact tabular-nums">
                    {row.line_count}
                  </TableCell>
                  <TableCell className="text-compact">
                    {row.source_names.length > 0
                      ? row.source_names.join("、")
                      : "—"}
                  </TableCell>
                  <TableCell className="text-meta whitespace-nowrap text-muted-foreground">
                    {formatDateTimeShort(row.created_at_ms)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-end gap-2">
            {loading ? <Spinner className="size-4" aria-label="加载中" /> : null}
            {hasNext ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refresh(cursor)}
              >
                下一页
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
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
  const [busy, setBusy] = useState(false)
  const [dispatchOpen, setDispatchOpen] = useState(false)
  const [receiptOpen, setReceiptOpen] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setDetail(await getAdminDelegateOrder(orderId))
    } catch (reason) {
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
      <div className="flex min-h-40 items-center justify-center">
        <Spinner className="size-5" aria-label="正在读取委托单详情" />
      </div>
    )
  }

  const { order, ledger } = detail
  const terminal = order.state === "done" || order.state === "cancelled"
  const dispatchable = !terminal && order.state !== "shipped"

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="返回队列"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden />
          </Button>
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

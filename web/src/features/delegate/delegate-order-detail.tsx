/**
 * 委托单详情（posting 行「点行进详情」与委托单列表共用）。
 *
 * 展示单级状态 + 行级厂家与包状态 + 物流快照（get_v3 白名单）+ 随单备注；
 * 动作只有撤单与收口两个，允许集由 `orderCanCancel` / `orderCanClose` 给出，
 * 服务端仍是最终门。失败一律 `notifyCommandError`，不进 DOM。
 */
import { useCallback, useEffect, useState } from "react"
import { Ban, Bell, CheckCheck } from "lucide-react"

import type { DelegateOrder } from "./delegate-http"
import { delegateHttp } from "./delegate-http"
import {
  formatInstantValue,
  orderCanCancel,
  orderCanClose,
  orderStateLabel,
  orderStateTone,
  packetStateLabel,
  packetStateTone,
} from "./delegate-model"
import { KeyValue, KeyValueGrid } from "@/components/section"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Spinner } from "@/components/ui/spinner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCents } from "@/lib/money"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

const NUDGE_COOLDOWN_MS = 30 * 60 * 1000

export type DelegateOrderDetailDialogProps = {
  /** 打开时要展示的委托单 id；空即关闭。 */
  orderId: string | null
  onOpenChange: (open: boolean) => void
  /** 撤单/收口落库后通知列表刷新。 */
  onMutated?: () => void
}

export function DelegateOrderDetailDialog({
  orderId,
  onOpenChange,
  onMutated,
}: DelegateOrderDetailDialogProps) {
  const open = Boolean(orderId)
  const [order, setOrder] = useState<DelegateOrder | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<"cancel" | "close" | "nudge" | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const reload = useCallback(async () => {
    if (!orderId) return
    setLoading(true)
    try {
      setOrder(await delegateHttp.getOrder(orderId))
    } catch (reason) {
      notifyCommandError(reason, "无法读取委托单详情")
      onOpenChange(false)
    } finally {
      setLoading(false)
    }
  }, [orderId, onOpenChange])

  useEffect(() => {
    if (!open) {
      setOrder(null)
      return
    }
    void reload()
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [open, reload])

  async function runAction(kind: "cancel" | "close" | "nudge") {
    if (!orderId) return
    setBusy(true)
    try {
      const next =
        kind === "cancel"
          ? await delegateHttp.cancelOrder(orderId)
          : kind === "close"
            ? await delegateHttp.closeOrder(orderId)
            : await delegateHttp.nudgeOrder(orderId)
      setOrder(next)
      onMutated?.()
      notifySuccess(kind === "cancel" ? "已撤单" : kind === "close" ? "已收口" : "已催单")
      setConfirming(null)
    } catch (reason) {
      notifyCommandError(
        reason,
        kind === "cancel" ? "撤单失败" : kind === "close" ? "收口失败" : "催单失败",
      )
    } finally {
      setBusy(false)
    }
  }

  const cancellable = order ? orderCanCancel(order.state, order.cancel_requested) : false
  const closable = order ? orderCanClose(order.state) : false
  const nudgeable = order?.state === "dispatched" || order?.state === "in_production"
  const cooling =
    order?.nudged_at_ms != null && now - order.nudged_at_ms < NUDGE_COOLDOWN_MS

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <div className="shrink-0 border-b border-border py-3 pr-12 pl-4">
          <DialogHeader>
            <DialogTitle>
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-sm break-all">
                  {order?.posting_number ?? "委托单"}
                </span>
                {order ? (
                  <StateChip
                    status={order.state}
                    tone={orderStateTone(order.state)}
                    label={orderStateLabel(order.state)}
                  />
                ) : null}
                {order?.cancel_requested ? (
                  <StateChip status="attest" tone="attest" label="已请求取消" />
                ) : null}
              </span>
            </DialogTitle>
            <DialogDescription>
              委托单按 posting 建：一张物流单一张委托单，行级厂家各自派发。
            </DialogDescription>
          </DialogHeader>
        </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
            {loading && !order ? (
              <div role="status" aria-live="polite" className="grid min-h-32 place-items-center">
                <Spinner className="size-5" aria-label="正在读取委托单" />
              </div>
            ) : null}
            {order ? (
              <>
                <KeyValueGrid className="sm:grid-cols-2">
                  <KeyValue
                    label="备货截止"
                    value={formatInstantValue(postingSnapshotField(order, "shipment_date"))}
                    mono
                  />
                  <KeyValue
                    label="处理开始"
                    value={formatInstantValue(postingSnapshotField(order, "in_process_at"))}
                    mono
                  />
                  <KeyValue label="随单备注" value={order.seller_note.trim() || "—"} />
                  {(order.held_cents ?? 0) > 0 ? (
                    <KeyValue label="已冻结" value={formatCents(order.held_cents ?? 0)} mono />
                  ) : null}
                  {(order.settled_cents ?? 0) > 0 ? (
                    <KeyValue label="已结算" value={formatCents(order.settled_cents ?? 0)} mono />
                  ) : null}
                  <KeyValue label="创建时间" value={formatInstantValue(order.created_at_ms)} mono />
                  {logisticsRow(order, "warehouse") ? (
                    <KeyValue label="仓名" value={logisticsRow(order, "warehouse")!} />
                  ) : null}
                  {logisticsRow(order, "delivery_method") ? (
                    <KeyValue label="配送方式" value={logisticsRow(order, "delivery_method")!} />
                  ) : null}
                  {logisticsRow(order, "tpl_provider") ? (
                    <KeyValue label="承运" value={logisticsRow(order, "tpl_provider")!} />
                  ) : null}
                  {logisticsRow(order, "city") ? (
                    <KeyValue
                      label="城市 / 区域"
                      value={
                        [logisticsRow(order, "city"), logisticsRow(order, "region")]
                          .filter(Boolean)
                          .join(" · ") || "—"
                      }
                    />
                  ) : null}
                  {logisticsMissing(order) ? (
                    <KeyValue
                      label="物流"
                      value="快照待补读，派发会在补齐后自动继续"
                    />
                  ) : null}
                </KeyValueGrid>
                <DelegateOrderLinesTable order={order} />
              </>
            ) : null}
          </div>
          {order && (cancellable || closable || nudgeable) ? (
            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">
              {nudgeable ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || cooling}
                  onClick={() => setConfirming("nudge")}
                >
                  <Bell />
                  {cooling ? "已催，稍后再试" : "催单"}
                </Button>
              ) : null}
              {cancellable ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setConfirming("cancel")}
                >
                  <Ban />
                  撤单
                </Button>
              ) : null}
              {closable ? (
                <Button size="sm" disabled={busy} onClick={() => setConfirming("close")}>
                  <CheckCheck />
                  收口
                </Button>
              ) : null}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={confirming === "cancel"}
        onOpenChange={(next) => {
          if (!next) setConfirming(null)
        }}
        title={`撤单 ${order?.posting_number ?? ""}`}
        description="接单前取消不扣费。已经接单的只是请求取消，冻结继续留着，直到未发货的包真正取消或收口退回。"
        confirmText="撤单"
        disabled={busy}
        onConfirm={() => void runAction("cancel")}
      />
      <ConfirmDialog
        open={confirming === "close"}
        onOpenChange={(next) => {
          if (!next) setConfirming(null)
        }}
        title={`收口 ${order?.posting_number ?? ""}`}
        description="未发货的冻结退回卖家钱包。已经发给厂家的成本不退。收口后不可再操作。"
        confirmText="收口"
        variant="brand"
        disabled={busy}
        onConfirm={() => void runAction("close")}
      />
      <ConfirmDialog
        open={confirming === "nudge"}
        onOpenChange={(next) => {
          if (!next) setConfirming(null)
        }}
        title={`催单 ${order?.posting_number ?? ""}`}
        description="催单会把在途派发包标成加急。半小时内只能催一次。"
        confirmText="催单"
        variant="brand"
        disabled={busy}
        onConfirm={() => void runAction("nudge")}
      />
    </>
  )
}

function postingSnapshotField(order: DelegateOrder, field: string): string {
  const snapshot = order.posting_snapshot
  if (typeof snapshot !== "object" || snapshot === null) return ""
  const value = (snapshot as Record<string, unknown>)[field]
  return typeof value === "string" ? value : ""
}

function logisticsValue(order: DelegateOrder, field: string): string {
  if (order.logistics === null || order.logistics === undefined) return ""
  if (typeof order.logistics !== "object") return ""
  const value = (order.logistics as Record<string, unknown>)[field]
  return typeof value === "string" ? value.trim() : ""
}

function logisticsRow(order: DelegateOrder, field: string): string | null {
  const value = logisticsValue(order, field)
  return value ? value : null
}

function logisticsMissing(order: DelegateOrder): boolean {
  return order.logistics === null || order.logistics === undefined
}

export function DelegateOrderLinesTable({ order }: { order: DelegateOrder }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border">
      <Table containerClassName="max-w-full">
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">商品</TableHead>
            <TableHead className="w-16">件数</TableHead>
            <TableHead className="w-36">厂家</TableHead>
            <TableHead className="w-24">包状态</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {order.lines.map((line) => (
            <TableRow key={line.line_id}>
              <TableCell>
                <p className="break-words text-sm">{line.name || line.offer_id}</p>
                <p className="font-mono text-meta break-all text-muted-foreground">
                  {line.offer_id}
                </p>
              </TableCell>
              <TableCell>
                <span className="font-mono text-compact tabular-nums">{line.quantity}</span>
              </TableCell>
              <TableCell>
                {line.source ? (
                  <span className="break-words text-sm">{line.source.name}</span>
                ) : (
                  <span className="text-sm text-muted-foreground">待补齐</span>
                )}
              </TableCell>
              <TableCell>
                {line.packet_state ? (
                  <StateChip
                    status={line.packet_state}
                    tone={packetStateTone(line.packet_state)}
                    label={packetStateLabel(line.packet_state)}
                  />
                ) : (
                  <span className="text-sm text-muted-foreground">未派发</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

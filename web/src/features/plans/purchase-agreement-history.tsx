import { useEffect, useRef, useState } from "react"
import type { PaymentOrderView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import {
  Dialog, DialogBody, DialogContent, DialogDescription, DialogHeader,
  DialogTitle, DialogTrigger,
} from "@/components/ui/dialog"
import { notifyCommandError } from "@/lib/notify"
import { paymentOrderPresentation } from "./payment-channels"
import { planDisplayName, yuanLabel } from "./plan-catalog"

export function PurchaseAgreementHistory({ workspaceUuid }: { workspaceUuid: string }) {
  return <History key={workspaceUuid} />
}

function History() {
  const [open, setOpen] = useState(false)
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        采购记录
      </DialogTrigger>
      <DialogContent className="flex max-h-screen flex-col overflow-hidden">
        {open ? <HistoryContent /> : null}
      </DialogContent>
    </Dialog>
  )
}

function HistoryContent() {
  const [orders, setOrders] = useState<PaymentOrderView[]>([])
  const [cursor, setCursor] = useState<string>()
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [selected, setSelected] = useState<PaymentOrderView>()
  const contentRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const receipt = selected?.purchase_agreement

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    accountHttp.accountListPaymentOrderPage({ cursor, limit: 20 }).then(
      (page) => {
        if (cancelled) return
        setOrders((current) => cursor ? [...current, ...page.orders] : page.orders)
        setNextCursor(page.next_cursor ?? undefined)
      },
      (reason) => {
        if (cancelled) return
        setFailed(true)
        notifyCommandError(reason, "采购记录读取失败，请重试。")
      },
    ).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [cursor, reload])

  useEffect(() => {
    if (receipt) contentRef.current?.focus()
  }, [receipt])

  return (
    <>
      <DialogHeader>
        <DialogTitle>{receipt ? receipt.title : "采购记录"}</DialogTitle>
        <DialogDescription className="break-words">
          {receipt
            ? `订单 ${selected.public_id} · 版本 ${receipt.version} · 生效日期 ${receipt.effective_at}`
            : "查看当前工作空间的采购订单及下单时保存的同意书。"}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0">
        {receipt ? (
          <div className="flex flex-col gap-4">
            <div ref={contentRef} tabIndex={-1} aria-label="本单采购同意书正文" className="break-words whitespace-pre-wrap text-compact leading-6">
              {receipt.content}
            </div>
            <p className="text-xs text-muted-foreground">
              同意时间：{receipt.accepted_at} · 操作者：{receipt.accepted_by}
            </p>
            <Button variant="outline" onClick={() => {
              setSelected(undefined)
              requestAnimationFrame(() => listRef.current?.focus())
            }}>
              返回采购记录
            </Button>
          </div>
        ) : (
          <div ref={listRef} tabIndex={-1} aria-label="采购订单列表" className="flex flex-col gap-4">
            {orders.map((order) => {
              const status = paymentOrderPresentation(order.status, order.entry_state)
              return (
                <div key={order.public_id} className="flex flex-col gap-2 border-b border-border pb-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{planDisplayName(order.plan)} · {order.member_seats} 席 · {order.duration_days} 天</span>
                    <StateChip status={order.status} tone={status.tone} label={status.label} />
                  </div>
                  <p className="font-mono text-compact tabular-nums">订单金额 {yuanLabel(order.amount_cents)}</p>
                  <p className="break-all text-xs text-muted-foreground">{order.public_id} · {new Date(order.created_at).toLocaleString()}</p>
                  {order.purchase_agreement ? (
                    <Button variant="outline" size="sm" onClick={() => setSelected(order)}>
                      查看本单采购同意书
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground">本单未留存采购同意书记录。</p>
                  )}
                </div>
              )
            })}
            {loading ? <p className="text-sm text-muted-foreground" role="status">正在读取采购记录…</p> : null}
            {!loading && !failed && orders.length === 0 ? <p className="text-sm text-muted-foreground">暂无采购记录。</p> : null}
            {failed ? <Button variant="outline" onClick={() => setReload((value) => value + 1)}>重试读取</Button> : null}
            {!loading && !failed && nextCursor ? (
              <Button variant="outline" onClick={() => { setLoading(true); setCursor(nextCursor) }}>加载更多</Button>
            ) : null}
          </div>
        )}
      </DialogBody>
    </>
  )
}

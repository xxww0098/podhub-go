import type { SubscriptionOrder } from "@/bindings/http-subscription"
import { ErrorNotice } from "@/components/error-notice"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { AlipayQr } from "./alipay-qr"
import { paymentOrderPresentation, paymentProviderLabel } from "./payment-channels"
import { yuanLabel } from "./plan-catalog"

export function SubscriptionPaymentOrder({ order, publicId, loading, error, onRefresh, onRecover }: {
  order?: SubscriptionOrder
  publicId?: string | null
  loading: boolean
  error?: string
  onRefresh: () => void
  onRecover: () => void
}) {
  const pending = order?.status === "pending"
  const state = order ? paymentOrderPresentation(order.status, order.entry_state) : undefined
  return <section aria-label="订阅付款订单" className="overflow-hidden rounded-xl border border-border bg-card text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-2.5" role="status" aria-live="polite">
      <p className="text-compact font-medium">{order?.status === "paid" ? "收款已记录" : "订阅付款订单"}</p>
      {order && <StateChip status={order.status} label={state?.label} tone={state?.tone} />}
    </div>
    <div className="flex flex-col gap-3 px-4 py-3.5">
      <p className="break-all font-mono text-meta tabular-nums text-muted-foreground">单号 {order?.public_id ?? publicId}{order ? ` · ${yuanLabel(order.amount_cents)}` : ""}{order?.provider ? ` · ${paymentProviderLabel(order.provider)}` : ""}</p>
      {error && <ErrorNotice layout="banner" title={`支付状态读取失败，当前信息未确认最新状态：${error}`} />}
      {!order && !error && <p className="flex items-center gap-2 text-compact text-muted-foreground"><Spinner />正在读取订单与付款入口…</p>}
      {order?.reconciliation_reason ? <p className="text-compact text-muted-foreground">收款记录已保留，正在核对服务期间，请联系运营处理。</p> : order?.status === "paid" ? <p className="text-compact text-muted-foreground">已按订单约定记录服务期间。</p> : null}
      {pending && <>
        {order.entry_state === "entry_confirming" ? <p className="text-compact text-muted-foreground">支付渠道结果尚未确认，请继续查询原订单，避免重复付款。</p> : order.qr_code ? <div className="flex flex-col items-center gap-2 rounded-lg border border-border bg-muted/30 p-4"><div className="rounded-lg bg-white p-2 shadow-sm"><AlipayQr value={order.qr_code} /></div><p className="text-compact text-muted-foreground">请扫码完成付款，到账后此页会自动更新。</p></div> : order.provider === "manual" ? <p className="text-compact text-muted-foreground">请将单号交给运营核对付款，确认收款后服务生效。</p> : !order.pay_url ? <p className="text-compact text-muted-foreground">付款入口尚未就绪，可查询原订单找回入口。</p> : null}
      </>}
    </div>
    <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted/30 px-4 py-3">
      {pending && order.pay_url && order.entry_state !== "entry_confirming" && <Button type="button" size="sm" onClick={() => window.open(order.pay_url!, "_blank", "noopener,noreferrer")}>在浏览器中继续支付</Button>}
      {pending && order.provider && order.provider !== "manual" && <Button type="button" size="sm" variant="outline" disabled={loading} onClick={onRecover}>{loading && <Spinner />}查询支付结果 / 找回入口</Button>}
      <Button type="button" size="sm" variant="outline" className="ml-auto" disabled={loading} onClick={onRefresh}>{loading && <Spinner />}刷新状态</Button>
    </div>
  </section>
}

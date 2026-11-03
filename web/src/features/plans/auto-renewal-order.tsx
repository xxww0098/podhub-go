import { useEffect, useState } from "react"
import { BellRing } from "lucide-react"

import type { PaymentMethodsData } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { subscriptionHttp, type SubscriptionView } from "@/bindings/http-subscription"
import { ErrorNotice } from "@/components/error-notice"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/error-message"
import { notifySuccess } from "@/lib/notify"
import { PaymentChannelList, paymentMethodKeys } from "./payment-channels"
import { yuanLabel } from "./plan-catalog"

/**
 * The renewal order the system issued before the paid end. It has no payment
 * channel and no purchase confirmation yet: nothing is charged until the buyer
 * accepts the agreement and picks a channel here.
 */
export function AutoRenewalOrder({ view, canManage, busy, onPaid }: {
  view: SubscriptionView
  canManage: boolean
  busy: boolean
  onPaid: () => void
}) {
  const [methods, setMethods] = useState<PaymentMethodsData>()
  const [loading, setLoading] = useState(false)
  const [methodsError, setMethodsError] = useState(false)
  const [reload, setReload] = useState(0)
  const [provider, setProvider] = useState("")
  const [accepted, setAccepted] = useState(false)
  const [paying, setPaying] = useState(false)
  const [failure, setFailure] = useState<string>()
  useEffect(() => {
    if (!canManage) return
    let canceled = false
    setLoading(true)
    setMethodsError(false)
    accountHttp.accountGetPaymentMethods().then((next) => {
      if (canceled) return
      setMethods(next)
      const keys = paymentMethodKeys(next)
      setProvider((current) => keys.includes(current) ? current : keys.find((key) => key.includes("alipay")) ?? keys[0] ?? "")
    }, () => { if (!canceled) { setMethods(undefined); setMethodsError(true) } }).finally(() => { if (!canceled) setLoading(false) })
    return () => { canceled = true }
  }, [canManage, reload])
  const publicId = view.pending_public_id ?? ""
  const blocked = busy || paying || !accepted || loading || methodsError || !paymentMethodKeys(methods).includes(provider)
  async function pay() {
    if (blocked || !publicId) return
    setPaying(true); setFailure(undefined)
    try {
      await subscriptionHttp.payAuto(publicId, view.purchase_agreement.version, provider)
      notifySuccess("已确认续费订单，请继续完成付款")
      onPaid()
    } catch (reason) { setFailure(errorMessage(reason, "确认失败，请刷新后重试")) }
    finally { setPaying(false) }
  }
  return <section aria-label="待确认的续费订单" className="overflow-hidden rounded-xl border border-brand/25 bg-card">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-brand-soft px-5 py-3">
      <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-card text-brand ring-1 ring-border"><BellRing className="size-3.5" /></span>
      <h3 className="text-compact font-semibold text-brand-ink">续费订单待确认</h3>
      <strong className="ml-auto font-mono text-lg tabular-nums text-brand-ink">{yuanLabel(view.pending_amount_cents ?? 0)}</strong>
    </div>
    <div className="flex flex-col gap-3 px-5 py-4">
      <p className="break-all font-mono text-meta tabular-nums text-muted-foreground">单号 {publicId}</p>
      <p className="text-compact leading-relaxed text-muted-foreground">系统已按当前配置生成续费订单，选择支付方式并付款后才会生效，不会自动扣款。不付款则服务到期后冻结，之后需重新购买。</p>
      {canManage ? <>
        <div className="flex flex-col gap-2"><p className="text-compact font-medium">支付方式</p>
          <PaymentChannelList layout="grid" methods={methods} loading={loading} error={methodsError} value={provider} onChange={setProvider} onRetry={() => setReload((value) => value + 1)} emptyHint="暂无可用支付方式，请联系运营。" />
        </div>
        <div className="rounded-lg border border-border bg-muted/30 p-3"><p className="whitespace-pre-wrap text-meta leading-6 text-muted-foreground">{view.purchase_agreement.content}</p></div>
        <label className="flex cursor-pointer items-center gap-3 text-compact"><Checkbox aria-label="我已阅读并同意购买确认" checked={accepted} onCheckedChange={(v) => setAccepted(Boolean(v))} />我已阅读并同意《{view.purchase_agreement.title}》</label>
        {failure && <ErrorNotice layout="banner" title={failure} />}
      </> : <p className="text-compact text-muted-foreground">只有工作区所有者或管理员可以确认续费订单。</p>}
    </div>
    {canManage && <div className="flex flex-wrap justify-end gap-2 border-t border-border bg-muted/30 px-5 py-3">
      <Button disabled={blocked} onClick={() => void pay()}>{paying && <Spinner />}确认并付款</Button>
    </div>}
  </section>
}

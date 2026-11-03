import { useEffect, useId, useRef, useState, type ReactNode } from "react"
import { Check, CalendarClock, Crown, Gem, Info, Minus, Plus, RefreshCcw, Rocket, Snowflake, Sparkles, Users, X, type LucideIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { StoreIcon } from "@/components/store-icon"
import type { AccountOverview, PaymentMethodsData } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  subscriptionHttp,
  type SubscriptionOrder,
  type SubscriptionPeriod,
  type SubscriptionQuote,
  type SubscriptionRequest,
  type SubscriptionView,
} from "@/bindings/http-subscription"
import { ErrorNotice } from "@/components/error-notice"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { cn } from "@/lib/utils"
import { planDisplayName as planName, yuanLabel } from "./plan-catalog"
import { PaymentChannelList, paymentMethodKeys } from "./payment-channels"
import { AutoRenewalOrder } from "./auto-renewal-order"
import { SubscriptionPaymentOrder } from "./subscription-payment-order"
import { SUBSCRIPTION_REDEEMED_EVENT } from "./redeem-code-dialog"

export { redeemSuccessNotice } from "./redeem-code-dialog"
export { paymentOrderPresentation } from "./payment-channels"

export function subscriptionDate(value: string | null | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value))
}

const PLAN_ICON: Record<string, LucideIcon> = { free: Crown, lite: Rocket, pro: Gem, max: Crown }

type Editor = { action: SubscriptionRequest["action"]; period?: SubscriptionPeriod }

export function PlansScreen({
  overview: overviewProp,
  onOverviewChange,
  subscription: preset,
}: {
  overview?: AccountOverview
  onOverviewChange?: (overview: AccountOverview) => void
  subscription?: SubscriptionView
}) {
  const overview = useAccountOverview() ?? overviewProp
  const workspace = overview?.active_workspace
  const canManage = ["owner", "manager", "admin"].includes(workspace?.role ?? "")
  const [view, setView] = useState<SubscriptionView | undefined>(preset)
  const [loadError, setLoadError] = useState<string>()
  const [reload, setReload] = useState(0)
  const [editor, setEditor] = useState<Editor | null>(null)
  const [showComparison, setShowComparison] = useState(false)
  const [order, setOrder] = useState<SubscriptionOrder>()
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderError, setOrderError] = useState<string>()
  const [orderReload, setOrderReload] = useState(0)
  const [recovering, setRecovering] = useState(false)
  const [editorBusy, setEditorBusy] = useState(false)
  const [autoToggling, setAutoToggling] = useState(false)
  const workspaceRef = useRef(workspace?.uuid)
  const editorTrigger = useRef<HTMLElement | null>(null)
  const openEditorButton = useRef<HTMLButtonElement | null>(null)
  workspaceRef.current = workspace?.uuid

  useEffect(() => {
    const refresh = (event: Event) => {
      if ((event as CustomEvent<string>).detail === workspaceRef.current) setReload((value) => value + 1)
    }
    window.addEventListener(SUBSCRIPTION_REDEEMED_EVENT, refresh)
    return () => window.removeEventListener(SUBSCRIPTION_REDEEMED_EVENT, refresh)
  }, [])

  useEffect(() => {
    setEditor(null)
    setOrder(undefined)
    setOrderError(undefined)
    setRecovering(false)
    setView(preset)
    setShowComparison(false)
    editorTrigger.current = null
  }, [workspace?.uuid, preset])

  useEffect(() => {
    if (preset || !workspace) return
    let canceled = false
    subscriptionHttp.view().then((next) => {
      if (canceled) return
      setView(next)
      setLoadError(undefined)
    }, (reason) => { if (!canceled) setLoadError(errorMessage(reason, "订阅读取失败")) })
    return () => { canceled = true }
  }, [workspace?.uuid, reload, preset])

  const pendingID = view?.pending_public_id
  const autoPending = view?.pending_provider === "unselected"
  useEffect(() => {
    if (!pendingID || !canManage || autoPending) return
    let canceled = false
    let inFlight = false
    setOrder((current) => current?.public_id === pendingID ? current : undefined)
    const load = async () => {
      if (inFlight) return
      inFlight = true
      setOrderLoading(true)
      try {
        const next = await subscriptionHttp.getOrder(pendingID)
        if (canceled) return
        setOrder(next)
        setOrderError(undefined)
        if (next.status !== "pending") {
          window.clearInterval(timer)
          setReload((value) => value + 1)
          if (next.status === "paid") {
            try {
              const nextOverview = await accountHttp.accountGetOverview()
              if (!canceled) onOverviewChange?.(nextOverview)
            } catch (reason) { if (!canceled) notifyCommandError(reason, "付款已记录，工作区概览刷新失败") }
          }
        }
      } catch (reason) { if (!canceled) setOrderError(errorMessage(reason, "支付状态读取失败")) }
      finally { inFlight = false; if (!canceled) setOrderLoading(false) }
    }
    void load()
    const timer = window.setInterval(() => { void load() }, 15_000)
    return () => { canceled = true; window.clearInterval(timer) }
  }, [workspace?.uuid, pendingID, canManage, autoPending, onOverviewChange, orderReload])

  async function recoverOrder() {
    if (!pendingID || recovering || editorBusy) return
    const currentWorkspace = workspace?.uuid
    setRecovering(true)
    try {
      await accountHttp.accountRecoverPaymentOrder(pendingID)
      if (workspaceRef.current === currentWorkspace) setOrderReload((value) => value + 1)
    } catch (reason) {
      if (workspaceRef.current === currentWorkspace) setOrderError(errorMessage(reason, "渠道查询失败，请继续使用原订单"))
    } finally { if (workspaceRef.current === currentWorkspace) setRecovering(false) }
  }

  function openEditor(next: Editor) {
    editorTrigger.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    setEditor(next)
  }

  async function toggleAutoRenew(enabled: boolean) {
    if (autoToggling) return
    const currentWorkspace = workspace?.uuid
    setAutoToggling(true)
    try {
      const next = await subscriptionHttp.setAutoRenew(enabled)
      if (workspaceRef.current === currentWorkspace) setView(next)
    } catch (reason) { notifyCommandError(reason, "自动续费订单设置失败") }
    finally { setAutoToggling(false) }
  }

  function closeEditor() {
    setEditor(null)
    requestAnimationFrame(() => {
      const trigger = editorTrigger.current
      if (trigger?.isConnected && !(trigger instanceof HTMLButtonElement && trigger.disabled)) trigger.focus()
      else openEditorButton.current?.focus()
    })
  }

  if (!workspace && !preset) {
    return (
      <div className="flex min-h-80 w-full flex-col items-center justify-center rounded-xl border border-border bg-card p-8 text-center sm:p-12">
        <Empty role="status" className="min-h-0 border-0 bg-transparent p-0">
          <EmptyHeader className="max-w-md">
            <EmptyMedia variant="icon">
              <Sparkles className="size-6 text-primary" />
            </EmptyMedia>
            <EmptyTitle>尚未选择工作空间</EmptyTitle>
            <EmptyDescription>
              套餐版本、店铺位与成员配额绑定至工作空间。请先在左侧栏选择或创建工作空间以查看并管理订阅。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  if (!view) {
    if (loadError) {
      return (
        <div className="flex min-h-60 w-full flex-col items-center justify-center rounded-xl border border-border bg-card p-6 text-center">
          <Empty role="status" className="min-h-0 border-0 bg-transparent p-0">
            <EmptyHeader className="max-w-md">
              <EmptyTitle>订阅读取失败</EmptyTitle>
              <EmptyDescription>{loadError}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent className="mt-3">
              <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
                <RefreshCcw className="size-3.5" data-icon="inline-start" />
                重试
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      )
    }
    return (
      <div className="flex min-h-60 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <Spinner /> 正在读取订阅…
      </div>
    )
  }

  const renewal = view.next_renewal
  const blockingOrder = view.pending_order && !autoPending
  const future = view.periods.filter((p) => new Date(p.starts_at).getTime() > Date.now())

  const statusBadge = view.frozen
    ? <Badge variant="destructive">已冻结</Badge>
    : view.status === "active"
      ? <Badge variant="good">已付期间生效中</Badge>
      : view.status === "expired"
        ? <Badge variant="destructive">付费服务已到期</Badge>
        : null

  const PlanIcon = PLAN_ICON[view.plan_key] ?? Crown
  const visibleEditor = canManage && (!blockingOrder || editor?.action === "keep") ? editor : null
  return <div className="@container flex w-full min-w-0 flex-col gap-4">
    <h1 className="sr-only">工作区订阅</h1>
    <section aria-label="当前套餐" className="@container overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-3 px-4 py-4 sm:px-5">
        <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand"><PlanIcon className="size-5" /></span>
        <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
          <h2 className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-base font-semibold">{planName(view.plan_key)}</span>
            {statusBadge}
          </h2>
          {view.status === "free" && <p className="text-compact text-muted-foreground">永久免费</p>}
          {view.status === "active" && <p className="text-compact leading-relaxed text-muted-foreground">全部已付服务至 {subscriptionDate(view.term_end)}。提前付款会延长已付时间，容量按各服务期间切换。</p>}
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {canManage ? <>
            <Button ref={openEditorButton} disabled={Boolean(blockingOrder) || editorBusy || recovering} onClick={() => openEditor({ action: view.status === "active" ? "renew" : "subscribe" })}>{view.status === "active" ? "续费订阅" : "购买套餐"}</Button>
            {view.status === "active" && <Button variant="outline" disabled={Boolean(blockingOrder) || editorBusy || recovering} onClick={() => openEditor({ action: "change" })}>本期扩容 / 升级</Button>}
          </> : <p className="text-compact text-muted-foreground">只有工作区所有者或管理员可以管理订阅。</p>}
          <Button variant="outline" aria-expanded={showComparison} onClick={() => setShowComparison((value) => !value)}>{showComparison ? "收起套餐对比" : "查看套餐对比"}</Button>
          <IconButton icon={RefreshCcw} label="刷新" variant="outline" size="icon-sm" onClick={() => setReload((n) => n + 1)} />
        </div>
      </div>
      <dl className={cn("grid border-t border-border @lg:divide-x @lg:divide-border", view.status === "free" ? "@lg:grid-cols-2" : "@lg:grid-cols-3")}>
        <div className="min-w-0 px-4 py-3 sm:px-5">
          <dt aria-label="当前可用店铺" className="flex items-center gap-2 text-compact text-muted-foreground"><StoreIcon aria-hidden className="size-4 shrink-0" />店铺</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums">已连接 {view.stores.used} / {view.stores.limit} 家</dd>
        </div>
        <div className="min-w-0 border-t border-border px-4 py-3 sm:px-5 @lg:border-t-0">
          <dt aria-label="当前成员" className="flex items-center gap-2 text-compact text-muted-foreground"><Users aria-hidden className="size-4 shrink-0" />成员</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums">{view.members.used} / {view.members.limit} 人</dd>
        </div>
        {view.status !== "free" && <div className="min-w-0 border-t border-border px-4 py-3 sm:px-5 @lg:border-t-0">
          <dt className="flex items-center gap-2 text-compact text-muted-foreground"><CalendarClock aria-hidden className="size-4 shrink-0" />当前额度可用至</dt>
          <dd className="mt-1 text-sm font-medium tabular-nums">{subscriptionDate(view.current_end)}（北京时间）</dd>
        </div>}
      </dl>
    </section>

    {view.frozen && <section role="alert" aria-label="工作区已冻结" className="flex gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-compact leading-relaxed"><Snowflake aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" /><p>付费服务已于 {subscriptionDate(view.term_end)} 到期，所有店铺已冻结，不能发布、同步或发放密钥。店铺配置和历史数据保留，续费后恢复。</p></section>}

    {autoPending && <AutoRenewalOrder view={view} canManage={canManage} busy={editorBusy || recovering} onPaid={() => { setOrder(undefined); setReload((n) => n + 1) }} />}

    {((view.pending_order && !autoPending) || order?.status === "paid") && <SubscriptionPaymentOrder order={order} publicId={view.pending_public_id} loading={orderLoading || recovering || editorBusy} error={orderError} onRefresh={() => setOrderReload((value) => value + 1)} onRecover={() => void recoverOrder()} />}

    {showComparison && <ul aria-label="套餐对比" className="grid list-none grid-cols-1 gap-3 p-0 @lg:grid-cols-2 @4xl:grid-cols-4">
      {view.plans.map((plan) => {
        const current = plan.key === view.plan_key
        const Icon = PLAN_ICON[plan.key] ?? Crown
        return <li key={plan.key} aria-current={current ? "true" : undefined} className={cn("flex min-w-0 flex-col gap-3 rounded-xl border p-4", current ? "border-brand bg-brand-soft/40" : "border-border bg-card")}>
          <div className="flex items-center gap-2.5">
            <span aria-hidden className={cn("flex size-9 shrink-0 items-center justify-center rounded-xl", current ? "bg-brand text-brand-foreground" : "bg-muted text-muted-foreground")}><Icon className="size-[18px]" /></span>
            <span className="text-md font-semibold">{planName(plan.key)}</span>
            {current ? <Badge variant="brand" className="ml-auto">当前</Badge> : null}
          </div>
          <p className="text-xl font-semibold leading-none tabular-nums">{plan.store_monthly_cents === 0 ? "免费" : <>{yuanLabel(plan.store_monthly_cents)}<span className="text-meta font-normal text-muted-foreground">/店/月</span></>}</p>
          {plan.key !== "free" && <div className="flex flex-col gap-2 border-t border-border pt-3 text-compact">
            <p className="flex items-center gap-2.5"><Check aria-hidden className={cn("size-4", current ? "text-brand" : "text-muted-foreground")} />店铺数量自选</p>
          </div>}
        </li>
      })}
    </ul>}

    <Dialog open={Boolean(visibleEditor)} onOpenChange={(open) => { if (!open && !editorBusy && !recovering) closeEditor() }}>
      {visibleEditor && <SubscriptionEditor key={`${workspace?.uuid}-${visibleEditor.action}-${visibleEditor.period?.id ?? ""}`} view={view} editor={visibleEditor} busy={editorBusy || recovering} setBusy={setEditorBusy} workspaceUuid={workspace?.uuid ?? ""} onClose={closeEditor} onSaved={(nextView) => { if (workspaceRef.current !== workspace?.uuid) return; setView(nextView); setReload((n) => n + 1); setEditor(null) }} onOrdered={(publicID) => { if (workspaceRef.current !== workspace?.uuid) return; setOrder(undefined); setView({ ...view, pending_order: true, pending_public_id: publicID }); setEditor(null); setReload((n) => n + 1) }} />}
    </Dialog>

    {(view.status === "active" || future.length > 0) && <div className={cn("grid min-w-0 gap-4", view.status === "active" && future.length > 0 && "@3xl:grid-cols-2")}>
    {view.status === "active" && <section aria-label="下次续费配置" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-5 py-3">
        <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-card text-muted-foreground ring-1 ring-border"><RefreshCcw className="size-3.5" /></span>
        <h3 className="text-compact font-semibold">下次续费配置</h3>
        <strong className="ml-auto font-mono text-lg tabular-nums">{yuanLabel(renewal.amount_cents)}/月</strong>
      </div>
      <div className="flex flex-col gap-2.5 px-5 py-4">
        <p className="text-meta text-muted-foreground">按当前配置续费</p>
        <p className="text-md font-semibold">{planName(renewal.plan_key)} · {renewal.stores} 家店铺</p>
        <p className="text-meta leading-5 text-muted-foreground">续费付款后才生效。要缩小容量，请在续费时选择更少的店铺数量。</p>
        {canManage && <label className="flex cursor-pointer items-center gap-3 text-compact"><Checkbox aria-label="到期前自动生成续费订单" checked={view.auto_renew} disabled={editorBusy || recovering || autoToggling} onCheckedChange={(v) => void toggleAutoRenew(Boolean(v))} />到期前 3 天自动生成续费订单（需付款后生效，不自动扣款）</label>}
      </div>
      {canManage && <div className="flex flex-wrap gap-2 border-t border-border bg-muted/30 px-5 py-3">
        <Button size="sm" disabled={Boolean(blockingOrder) || editorBusy || recovering} onClick={() => openEditor({ action: "renew" })}>续费</Button>
      </div>}
    </section>}

    {future.length > 0 && <section aria-label="已付款的未来服务" className="overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center gap-3 border-b border-border bg-muted/40 px-5 py-3">
        <span aria-hidden className="flex size-7 items-center justify-center rounded-lg bg-card text-muted-foreground ring-1 ring-border"><CalendarClock className="size-3.5" /></span>
        <h3 className="text-compact font-semibold">已付款的未来服务</h3>
      </div>
      <ul className="divide-y divide-border">
        {future.map((period) => <li key={period.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3.5">
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-brand" />
          <div className="min-w-0 flex-1 basis-56">
            <p className="text-compact font-medium">{period.stores} 家店铺</p>
            <p className="mt-0.5 font-mono text-meta tabular-nums text-muted-foreground">{subscriptionDate(period.starts_at)} 至 {subscriptionDate(period.ends_at)}</p>
          </div>
          {canManage && <Button size="sm" variant="outline" className="ml-auto" disabled={editorBusy || recovering} onClick={() => openEditor({ action: "keep", period })}>修改保留名单</Button>}
        </li>)}
      </ul>
    </section>}
    </div>}

    <section className="flex gap-3 rounded-2xl bg-muted/40 px-5 py-4 text-meta leading-5 text-muted-foreground">
      <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="flex min-w-0 flex-col gap-1.5">
        <p>按月计费：店铺数 × 店铺单价。单价取决于所选套餐，与订阅统一续费；成员不单独计费。</p>
        <p>已付名额继续用满；缩小容量请在续费时选择，已付部分不自动退款。每个工作区最多购买 {view.store_cap} 家店铺。手动停用、解绑、删除店铺不改变已订阅名额。服务到期未续费，该工作区所有店铺冻结，配置及历史数据保留，已受理业务继续收尾。</p>
      </div>
    </section>
  </div>
}

function SubscriptionEditor({ view, editor, busy, setBusy, workspaceUuid, onClose, onSaved, onOrdered }: {
  view: SubscriptionView; editor: Editor; busy: boolean; setBusy: (busy: boolean) => void; workspaceUuid: string; onClose: () => void; onSaved: (view: SubscriptionView) => void; onOrdered: (publicID: string) => void
}) {
  const radioGroupId = useId()
  const reduced = useReducedMotion()
  const renewing = editor.action === "renew"
  const firstPaidPlan = view.plans.find((item) => item.key !== "free")?.key ?? ""
  const initial = editor.period ?? (renewing ? view.next_renewal : { plan_key: view.plan_key === "free" ? firstPaidPlan : view.plan_key, stores: view.stores.limit })
  const [plan, setPlan] = useState(initial.plan_key)
  const [stores, setStores] = useState(initial.stores)
  const [months, setMonths] = useState(1)
  const [couponCode, setCouponCode] = useState("")
  const [couponOpen, setCouponOpen] = useState(false)
  const currentPeriod = view.periods.find((p) => new Date(p.starts_at).getTime() <= Date.now())
  const initialKeep = editor.period?.keep_store_ids ?? (renewing ? null : currentPeriod?.keep_store_ids ?? null)
  const [keep, setKeep] = useState<string[] | null>(initialKeep?.length ? initialKeep.filter((id) => view.store_choices.some((s) => s.id === id && !s.manual_disabled)) : null)
  const [quote, setQuote] = useState<SubscriptionQuote>()
  const [accepted, setAccepted] = useState(false)
  const [reading, setReading] = useState(false)
  const [read, setRead] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [methods, setMethods] = useState<PaymentMethodsData>()
  const [methodsLoading, setMethodsLoading] = useState(editor.action !== "keep")
  const [methodsError, setMethodsError] = useState(false)
  const [methodsReload, setMethodsReload] = useState(0)
  const [provider, setProvider] = useState("")
  const requestInFlight = useRef(false)
  const requiresPayment = Boolean(quote && !quote.free_only && quote.amount_cents > 0)
  useEffect(() => {
    if (editor.action === "keep") return
    let canceled = false
    setMethodsLoading(true)
    setMethodsError(false)
    accountHttp.accountGetPaymentMethods().then((next) => {
      if (canceled) return
      setMethods(next)
      const keys = paymentMethodKeys(next)
      setProvider((current) => keys.includes(current) ? current : keys.find((key) => key.includes("alipay")) ?? keys[0] ?? "")
    }, () => { if (!canceled) { setMethods(undefined); setMethodsError(true) } }).finally(() => { if (!canceled) setMethodsLoading(false) })
    return () => { canceled = true }
  }, [editor.action, methodsReload])
  const planRow = view.plans.find((p) => p.key === plan)
  const monthly = planRow ? stores * planRow.store_monthly_cents : undefined
  const increaseOnly = editor.action === "change"
  const minStores = increaseOnly ? view.stores.limit : 1
  const lockedCapacity = editor.action === "keep"
  const currentRank = view.plans.findIndex((p) => p.key === view.plan_key)
  const planChoices = view.plans.filter((p, rank) => p.key !== "free" && (!increaseOnly || rank >= currentRank))
  const limit = stores
  const choices = view.store_choices.filter((s) => !s.manual_disabled)
  const needsKeep = ["renew", "keep", "change"].includes(editor.action) && choices.length > limit
  const selected = keep ?? choices.slice(0, limit).map((s) => s.id)
  const paused = quote?.keep_store_ids ? choices.filter((s) => !quote.keep_store_ids!.includes(s.id)) : []
  const title = editor.action === "keep" ? "修改到期保留名单" : editor.action === "renew" ? "续费订阅" : editor.action === "subscribe" ? "购买套餐" : "本期扩容 / 升级"
  function edit(change?: () => void) { change?.(); setQuote(undefined); setAccepted(false); setRead(false); setFailure(undefined) }
  async function preview() {
    if (previewBlocked || requestInFlight.current) return
    requestInFlight.current = true
    setBusy(true); setFailure(undefined)
    try {
      const request: SubscriptionRequest = {
        action: editor.action, expected_workspace_uuid: workspaceUuid,
        target: { plan_key: plan, stores }, months: months as 1 | 3 | 6 | 12,
        keep_store_ids: needsKeep ? selected : renewing ? undefined : keep,
        period_id: editor.period?.id,
          ...(!increaseOnly && !lockedCapacity && couponCode.trim() ? { coupon_code: couponCode.trim() } : {}),
      }
      setQuote(await subscriptionHttp.quote(request))
    } catch (reason) { setFailure(errorMessage(reason, "预览失败，请刷新订阅后重试")) }
    finally { requestInFlight.current = false; setBusy(false) }
  }
  async function confirm() {
    if (!quote || confirmBlocked || requestInFlight.current) return
    requestInFlight.current = true
    setBusy(true); setFailure(undefined)
    try {
      if (quote.free_only) {
        onSaved(await subscriptionHttp.keep(quote.quote_id, cancelPending))
        notifySuccess("保留名单已保存，已付期间继续使用")
      } else {
        const created = await subscriptionHttp.order(quote.quote_id, view.purchase_agreement.version, requiresPayment ? provider : undefined)
        onOrdered(created.public_id)
        notifySuccess("订单已创建，请继续完成付款")
      }
    } catch (reason) { setFailure(errorMessage(reason, "确认失败，请刷新后重新预览")); setQuote(undefined) }
    finally { requestInFlight.current = false; setBusy(false) }
  }
  const previewBlocked = busy || (editor.action !== "keep" && !planRow) || (needsKeep && (selected.length > limit || selected.length === 0))
  const confirmBlocked = busy || (!quote?.free_only && !accepted) || (requiresPayment && (methodsLoading || methodsError || !paymentMethodKeys(methods).includes(provider))) || Boolean(quote?.free_only && view.pending_order && view.pending_provider !== "unselected" && !cancelPending)
  const confirmLabel = !quote ? "" : quote.free_only ? "确认保留名单" : "确认购买"
  const annual = !increaseOnly && !lockedCapacity && months === 12
  const subtotal = monthly === undefined ? undefined : monthly * months
  const estimated = lockedCapacity ? 0 : !increaseOnly && subtotal !== undefined ? Math.round(subtotal * (annual ? 80 : 100) / 100) : undefined
  return <DialogContent layout="panel" showCloseButton={!busy} className="w-[960px] sm:max-w-[calc(100%-2rem)]">
    <DialogHeader variant="panel" className="pl-5 sm:pl-8">
      <DialogTitle>{reading ? view.purchase_agreement.title : title}</DialogTitle>
      <DialogDescription className="sr-only">选择套餐、店铺数量与购买月数，预览费用后确认购买。</DialogDescription>
    </DialogHeader>
    <section aria-label={title} data-slot="subscription-editor" className="@container min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-5 sm:p-8">
      {reading ? <>
        <div className="max-h-[60dvh] overflow-y-auto rounded-2xl bg-muted/40 p-5"><p className="whitespace-pre-wrap text-sm leading-7">{view.purchase_agreement.content}</p></div>
        <div className="mt-5 flex justify-end"><Button onClick={() => { setReading(false); setRead(true) }}>返回购买</Button></div>
      </> : <div className="grid items-start gap-7 @3xl:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)] @3xl:gap-9">
        <fieldset disabled={busy} className="@container flex min-w-0 flex-col gap-6 border-0 p-0">
          {!lockedCapacity && (!quote || requiresPayment) && <>
            <PaymentChannelList layout="compact" methods={methods} loading={methodsLoading} error={methodsError} value={provider} onChange={setProvider} onRetry={() => setMethodsReload((value) => value + 1)} emptyHint="暂无可用支付方式，请联系运营。" />
            <div aria-hidden className="h-px bg-border" />
          </>}
          {!lockedCapacity && <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium">套餐</span>
              {!increaseOnly && <div role="radiogroup" aria-label="购买月数" className="flex flex-wrap rounded-full border border-border bg-muted/40 p-1">
                {[1, 3, 6, 12].map((m) => <label key={m} className={cn("relative flex min-h-9 cursor-pointer items-center justify-center rounded-full px-3 text-meta transition-colors max-md:min-h-11 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring", months === m ? "text-brand-ink" : "text-muted-foreground hover:text-foreground")}>
                  <input type="radio" name={`${radioGroupId}-months`} value={m} checked={months === m} onChange={() => edit(() => setMonths(m))} className="sr-only" />
                  {months === m && <motion.span layoutId={reduced ? undefined : `${radioGroupId}-term`} className="absolute inset-0 rounded-full border border-border bg-card shadow-sm" transition={{ type: "spring", bounce: 0.12, duration: 0.3 }} />}
                  <span className="relative">{m === 12 ? <>年付 <span className="text-st-good-ink">8 折</span></> : `${m} 个月`}</span>
                </label>)}
              </div>}
            </div>
            <div role="radiogroup" aria-label="套餐" className="grid grid-cols-1 gap-2.5 @sm:grid-cols-3">
              {planChoices.map((p) => {
                const on = plan === p.key
                return <label key={p.key} className={cn("relative flex min-w-0 cursor-pointer items-center justify-between gap-3 rounded-3xl border p-4 transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring @sm:flex-col @sm:items-start @sm:gap-5 @sm:py-5", on ? "border-brand bg-brand-soft/35" : "border-border bg-card hover:border-border-strong hover:bg-muted/25")}>
                  <input type="radio" name={`${radioGroupId}-plan`} value={p.key} checked={on} onChange={() => edit(() => setPlan(p.key))} className="sr-only" />
                  <span className="pr-4 text-sm font-medium">{planName(p.key)}</span>
                  {on && <Check aria-hidden className="absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-brand @sm:top-5 @sm:translate-y-0" />}
                  <span className="flex flex-col gap-1 pr-5 @sm:pr-0"><span className="break-all text-2xl font-medium leading-none tracking-tight tabular-nums">{yuanLabel(p.store_monthly_cents)}</span><span className="text-meta text-muted-foreground">/ 店 / 月</span></span>
                </label>
              })}
            </div>
            {planChoices.length === 0 && <p role="status" className="text-compact text-muted-foreground">暂无可用付费套餐，请刷新后重试。</p>}
          </div>}
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-3xl border border-border px-4 py-3">
              <span className="text-sm font-medium">店铺数量</span>
              <Stepper label="店铺数量" min={minStores} max={view.store_cap} value={stores} disabled={lockedCapacity} onChange={(n) => edit(() => setStores(Math.min(view.store_cap, Math.max(minStores, Math.floor(n || 0)))))} />
            </div>
            {increaseOnly ? <p className="px-1 text-meta leading-5 text-muted-foreground">当前 {view.stores.limit} 家，本期只能增加，减少请在续费时选择。已经付款的未来期间按缺少的名额分别补差。</p> : renewing && stores < view.stores.limit ? <p className="px-1 text-meta leading-5 text-muted-foreground">缩小容量从下一个服务期生效，当前已付容量用到期为止</p> : null}
          </div>
          {needsKeep && <ChoiceList legend={`选择到期保留的店铺，最多 ${limit} 家`} count={`${selected.length}/${limit}`} over={selected.length > limit} hint={`实际连接 ${choices.length} 家，只需暂停 ${choices.length - limit} 家。`}>{choices.map((s) => <label key={s.id} className="flex cursor-pointer items-center gap-3 px-3 py-3 text-compact hover:bg-muted/40"><Checkbox checked={selected.includes(s.id)} onCheckedChange={(checked) => edit(() => setKeep(checked ? [...selected, s.id] : selected.filter((id) => id !== s.id)))} /><span className="min-w-0 flex-1 truncate">{s.name || s.id}</span></label>)}</ChoiceList>}
          <p className="flex items-start gap-2 px-1 text-meta leading-5 text-muted-foreground"><Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />按店铺数量计费，成员不单独收费。已付期间继续使用，本次调整不自动退款。</p>
        </fieldset>
        <aside aria-label="订单摘要" className="min-w-0 rounded-4xl border border-border/60 bg-muted/40 p-5 sm:p-6">
          <h3 className="mb-6 text-xl font-medium tracking-tight">订单摘要</h3>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0"><p className="text-sm font-medium">{planName(plan)}{lockedCapacity ? " · 保留名单" : ""}</p><p className="mt-1 text-meta leading-5 text-muted-foreground">{stores} 家店铺{!lockedCapacity && planRow ? ` × ${yuanLabel(planRow.store_monthly_cents)} / 月` : ""}</p></div>
            <span className="shrink-0 text-sm tabular-nums">{lockedCapacity ? "不收取费用" : increaseOnly ? "按剩余期间补差" : `${months} 个月`}</span>
          </div>
          {quote && <dl className="mt-5 flex flex-col gap-4 border-t border-border pt-5 text-compact">
            {quote.breakdown.map((line, i) => <div key={i} className="flex items-start justify-between gap-4"><dt className={cn("min-w-0", line.cents < 0 ? "text-st-good-ink" : "text-muted-foreground")}>{line.label}</dt><dd className={cn("shrink-0 tabular-nums", line.cents < 0 && "text-st-good-ink")}>{line.cents < 0 ? `−${yuanLabel(-line.cents)}` : yuanLabel(line.cents)}</dd></div>)}
            <div className="flex items-start justify-between gap-4"><dt className="text-muted-foreground">当前可用</dt><dd className="text-right tabular-nums">{quote.current.stores} 家，至 {subscriptionDate(quote.current.term_end)}</dd></div>
            <div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-muted-foreground">{quote.free_only ? "适用日期" : "服务期间"}</dt><dd className="text-right tabular-nums">{subscriptionDate(quote.effective_at)}{!quote.free_only && <><br />至 {subscriptionDate(quote.term_end)}</>}</dd></div>
            <div className="flex items-start justify-between gap-4"><dt className="shrink-0 text-muted-foreground">到期暂停</dt><dd className="min-w-0 wrap-anywhere text-right">{paused.length ? paused.map((s) => s.name || s.id).join("、") : "无"}</dd></div>
          </dl>}
          {!quote && annual && subtotal !== undefined && estimated !== undefined && <dl className="mt-5 flex flex-col gap-3 border-t border-border pt-4 text-compact">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">商品小计</dt><dd className="tabular-nums">{yuanLabel(subtotal)}</dd></div>
            <div className="flex justify-between gap-3 text-st-good-ink"><dt>年付 8 折</dt><dd className="tabular-nums">−{yuanLabel(subtotal - estimated)}</dd></div>
          </dl>}
          {!increaseOnly && !lockedCapacity && <fieldset disabled={busy} className="mt-5 min-w-0 border-0 p-0">
            {quote?.coupon ? <Button variant="outline" size="sm" className="max-w-full" onClick={() => { edit(() => setCouponCode("")); setCouponOpen(false) }} aria-label={`移除优惠码 ${quote.coupon.code}`}>
              <span className="min-w-0 truncate">{quote.coupon.code}</span><span className="shrink-0 text-st-good-ink">减免 {quote.coupon.discount_percent}%</span><X aria-hidden />
            </Button> : couponOpen ? <div className="flex min-w-0 gap-2">
              <Input id={`${radioGroupId}-coupon`} aria-label="优惠码" autoFocus maxLength={32} placeholder="输入优惠码" value={couponCode} onChange={(event) => edit(() => setCouponCode(event.target.value))} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void preview() } }} />
              <Button variant="outline" disabled={!couponCode.trim() || previewBlocked} onClick={() => void preview()}>应用</Button>
            </div> : <Button variant="link" size="sm" onClick={() => setCouponOpen(true)}><Plus aria-hidden />添加优惠码</Button>}
          </fieldset>}
          <div className="mt-6 border-t border-border pt-5" aria-live="polite" aria-atomic="true">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-2">
              <span className="text-sm">{quote ? "本次应付" : "预估合计"}</span>
              {quote || estimated !== undefined ? <CheckoutAmount cents={quote?.amount_cents ?? estimated!} /> : <span className="text-lg font-medium">以费用预览为准</span>}
            </div>
            {!quote && <p className="mt-2 text-meta leading-5 text-muted-foreground">{increaseOnly ? "预览后确认补差金额与生效日期。" : "实际金额与服务日期以费用预览为准。"}</p>}
          </div>
          <fieldset disabled={busy} className="mt-5 flex min-w-0 flex-col gap-4 border-0 p-0">
            {quote?.free_only && view.pending_order && view.pending_provider !== "unselected" && <label className="flex cursor-pointer items-start gap-3 text-compact text-st-attest-ink"><Checkbox className="mt-0.5" checked={cancelPending} onCheckedChange={(v) => setCancelPending(Boolean(v))} />取消待付款订单并修改保留名单（支付结果不确定时等待渠道确认）</label>}
            {quote && !quote.free_only && <div className="flex flex-col items-start gap-2">
              <Button variant="link" size="sm" className="h-auto min-h-9 justify-start whitespace-normal text-left" onClick={() => setReading(true)}>阅读《{view.purchase_agreement.title}》</Button>
              <label className="flex min-h-9 cursor-pointer items-center gap-2.5 text-compact"><Checkbox aria-label="我已阅读并同意购买确认" disabled={!read} checked={accepted} onCheckedChange={(v) => setAccepted(Boolean(v))} />我已阅读并同意购买确认</label>
            </div>}
            {failure && <ErrorNotice layout="banner" title={failure} />}
            {!quote
              ? <Button className="min-h-11 w-full" disabled={previewBlocked} onClick={() => void preview()}>{busy && <Spinner />}预览费用与生效日期</Button>
              : <Button variant="brand" className="min-h-11 w-full" disabled={confirmBlocked} onClick={() => void confirm()}>{busy && <Spinner />}{confirmLabel}</Button>}
            <Button variant="ghost" className="w-full" disabled={busy} onClick={quote ? () => edit() : onClose}>{quote ? "返回修改" : "取消"}</Button>
          </fieldset>
        </aside>
      </div>}
    </section>
  </DialogContent>
}

function CheckoutAmount({ cents }: { cents: number }) {
  const reduced = useReducedMotion()
  const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(cents / 100)
  return <span aria-label={`¥${amount}`} className="inline-flex text-3xl font-medium leading-tight tracking-tight tabular-nums">
    <span aria-hidden>¥</span>
    <span aria-hidden className="inline-flex">{[...amount].map((digit, index) => <span key={amount.length - index} className="relative inline-grid overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={digit} className="col-start-1 row-start-1" initial={reduced ? false : { y: "70%", opacity: 0, filter: "blur(2px)" }} animate={{ y: 0, opacity: 1, filter: "blur(0px)" }} exit={reduced ? { opacity: 0 } : { y: "-70%", opacity: 0, filter: "blur(2px)" }} transition={{ duration: reduced ? 0 : 0.3, ease: [0.16, 1, 0.3, 1] }}>{digit}</motion.span>
      </AnimatePresence>
    </span>)}</span>
  </span>
}

function Stepper({ label, value, min, max, disabled, onChange }: { label: string; value: number; min: number; max: number; disabled?: boolean; onChange: (next: number) => void }) {
  const step = "flex w-11 shrink-0 cursor-pointer items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:bg-muted disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
  return <div className={cn("flex h-11 w-36 items-stretch overflow-hidden rounded-full border border-border bg-card transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50", disabled && "opacity-60")}>
    <button type="button" aria-label={`减少${label}`} disabled={disabled || value <= min} onClick={() => onChange(value - 1)} className={step}><Minus aria-hidden className="size-4" /></button>
    <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} step={1} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1 bg-transparent text-center text-sm font-medium tabular-nums outline-none [-moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
    <button type="button" aria-label={`增加${label}`} disabled={disabled || value >= max} onClick={() => onChange(value + 1)} className={step}><Plus aria-hidden className="size-4" /></button>
  </div>
}

/** A bordered checklist with a header strip carrying the legend and the used/allowed count. */
function ChoiceList({ legend, count, over, hint, children }: { legend: string; count: string; over: boolean; hint?: string; children: ReactNode }) {
  const id = useId()
  return <div role="group" aria-labelledby={id} className="overflow-hidden rounded-xl border border-border-strong bg-card">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-muted/40 px-3 py-2">
      <p id={id} className="min-w-0 flex-1 text-compact font-medium">{legend}</p>
      <Badge variant={over ? "destructive" : "outline"} className="font-mono tabular-nums">{count}</Badge>
      {hint ? <p className="basis-full text-meta text-muted-foreground">{hint}</p> : null}
    </div>
    <div className="max-h-56 divide-y divide-border overflow-y-auto">{children}</div>
  </div>
}

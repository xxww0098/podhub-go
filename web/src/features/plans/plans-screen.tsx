import { useEffect, useState } from "react"
import { CalendarClock, RefreshCcw, Store, Users } from "lucide-react"

import type { AccountOverview } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  subscriptionHttp,
  type SubscriptionOrder,
  type SubscriptionPeriod,
  type SubscriptionQuote,
  type SubscriptionRequest,
  type SubscriptionView,
} from "@/bindings/http-subscription"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { planDisplayName as planName, yuanLabel } from "./plan-catalog"

export { redeemSuccessNotice } from "./redeem-code-dialog"
export { paymentOrderPresentation } from "./payment-channels"

export function subscriptionDate(value: string | null | undefined): string {
  if (!value) return "—"
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(value))
}

type Editor = { action: SubscriptionRequest["action"]; period?: SubscriptionPeriod; restore?: boolean }

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
  const [editor, setEditor] = useState<Editor>()
  const [order, setOrder] = useState<SubscriptionOrder>()

  useEffect(() => {
    setEditor(undefined)
    setOrder(undefined)
    setView(preset)
  }, [workspace?.uuid, preset])

  useEffect(() => {
    if (preset) return
    let canceled = false
    subscriptionHttp.view().then((next) => {
      if (canceled) return
      setView(next)
      setLoadError(undefined)
    }, (reason) => { if (!canceled) setLoadError(errorMessage(reason, "订阅读取失败")) })
    return () => { canceled = true }
  }, [workspace?.uuid, reload, preset])

  const pendingID = view?.pending_public_id
  useEffect(() => {
    if (!pendingID || !canManage) return
    let canceled = false
    const load = () => subscriptionHttp.getOrder(pendingID).then(async (next) => {
      if (canceled) return
      setOrder(next)
      if (next.status !== "pending") {
        setReload((value) => value + 1)
        if (next.status === "paid") {
          try {
            const nextOverview = await accountHttp.accountGetOverview()
            if (!canceled) onOverviewChange?.(nextOverview)
          } catch (reason) { if (!canceled) notifyCommandError(reason, "付款已记录，工作区概览刷新失败") }
        }
      }
    }, (reason) => { if (!canceled) notifyCommandError(reason, "支付状态读取失败") })
    void load()
    const timer = window.setInterval(() => { void load() }, 15_000)
    return () => { canceled = true; window.clearInterval(timer) }
  }, [pendingID, canManage, onOverviewChange])

  if (!view) return <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
    {loadError ? <><span>{loadError}</span><Button variant="outline" onClick={() => setReload((n) => n + 1)}>重试</Button></> : <><Spinner /> 正在读取订阅</>}
  </div>

  const next = view.next
  const future = view.periods.filter((p) => new Date(p.starts_at).getTime() > Date.now())
  const reduction = next.stores < view.stores.limit || next.members < view.members.limit || next.plan_key !== view.plan_key
  const hasPaidReduction = future.some((p) => p.stores < view.stores.limit)

  return <div className="flex w-full flex-col gap-6">
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-lg font-semibold">工作区订阅</h2><p className="text-xs text-muted-foreground">按购买日每月续费 · 所有时间均为北京时间</p></div>
        <Button variant="ghost" size="sm" onClick={() => setReload((n) => n + 1)}><RefreshCcw className="size-4" /> 刷新</Button>
      </div>
      <div className="grid gap-4 rounded-xl border border-border p-5 sm:grid-cols-3">
        <div><p className="text-xs text-muted-foreground">当前套餐</p><p className="mt-2 font-semibold">{planName(view.plan_key)}</p><p className="mt-1 text-xs text-muted-foreground">{view.status === "active" ? "已付期间生效中" : view.status === "expired" ? "付费服务已到期" : "永久免费"}</p></div>
        <div><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Store className="size-3.5" /> 当前可用店铺</p><p className="mt-2 font-semibold">{view.stores.limit} 家 <span className="text-xs font-normal text-muted-foreground">已连接 {view.stores.used} 家</span></p><p className="mt-1 text-xs text-muted-foreground">套餐自带 {view.stores.limit - view.extra_stores} 家 · 加购 {view.extra_stores} 家</p></div>
        <div><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Users className="size-3.5" /> 当前成员</p><p className="mt-2 font-semibold">{view.members.used} / {view.members.limit} 人</p><p className="mt-1 text-xs text-muted-foreground">当前额度可用至 {subscriptionDate(view.current_end)}</p></div>
      </div>
      {view.status === "active" && <p className="text-sm text-muted-foreground">全部已付服务至 {subscriptionDate(view.term_end)}。提前付款会延长已付时间，容量按各服务期间切换。</p>}
      {canManage ? <div className="flex flex-wrap gap-2">
        <Button onClick={() => setEditor({ action: view.status === "active" ? "renew" : "subscribe" })}>{view.status === "active" ? "续费套餐与加购" : "购买套餐"}</Button>
        {view.status === "active" && <><Button variant="outline" onClick={() => setEditor({ action: "change" })}>本期加购 / 升级</Button><Button variant="outline" onClick={() => setEditor({ action: "schedule" })}>调整下期店铺数量</Button></>}
      </div> : <p className="text-sm text-muted-foreground">只有工作区所有者或管理员可以管理订阅。</p>}
    </section>

    <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="font-semibold">下次续费配置</h3>
      <p>{planName(next.plan_key)} · {next.stores} 家店铺 · {next.members} 名成员 <strong className="ml-2">{yuanLabel(view.next_renewal.amount_cents)}/月</strong></p>
      <p className="text-sm text-muted-foreground">{subscriptionDate(next.effective_at)} 起，下一段尚未购买的服务按此配置计费。保存配置不代表已经付款。</p>
      {view.stores.used > next.stores && !next.keep_store_ids?.length && <p className="text-sm">实际连接数量超过下期容量，请修改下期配置，选择到期后保留的店铺。</p>}
      {reduction && <p className="text-sm">已设置下期续费 {next.stores} 家。当前 {view.stores.limit} 家可使用至 {subscriptionDate(view.current_end)}。</p>}
      {canManage && view.status === "active" && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setEditor({ action: "schedule" })}>修改下期配置</Button>
        {(reduction || hasPaidReduction) && <Button size="sm" variant="outline" onClick={() => setEditor({ action: "change", restore: true })}>恢复为 {view.stores.limit} 家，预览补差</Button>}
      </div>}
    </section>

    {future.length > 0 && <section className="flex flex-col gap-3 border-t border-border pt-5">
      <h3 className="flex items-center gap-2 font-semibold"><CalendarClock className="size-4" /> 已付款的未来服务</h3>
      {future.map((period) => <div key={period.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3 text-sm">
        <div><p>{period.stores} 家店铺 · {period.members} 名成员</p><p className="text-xs text-muted-foreground">{subscriptionDate(period.starts_at)} 至 {subscriptionDate(period.ends_at)}</p></div>
        {canManage && <Button size="sm" variant="outline" onClick={() => setEditor({ action: "keep", period })}>修改保留名单</Button>}
      </div>)}
    </section>}

    {(view.pending_order || order?.status === "paid") && <section className="rounded-lg border border-border p-4 text-sm">
      <p className="font-medium">{order?.status === "paid" ? "收款已记录" : "待付款订阅订单"}</p>
      <p className="mt-1 break-all text-muted-foreground">单号 {order?.public_id ?? view.pending_public_id} {order ? `· ${yuanLabel(order.amount_cents)}` : ""}</p>
      <p className="mt-1 text-muted-foreground">{order?.reconciliation_reason ? "收款记录已保留，正在核对服务期间，请联系运营处理。" : order?.status === "paid" ? "已按订单约定记录服务期间。" : "请将单号交给运营核对付款，确认收款后服务生效。页面会自动刷新支付状态。"}</p>
    </section>}

    <section className="border-t border-border pt-5 text-xs leading-6 text-muted-foreground">
      <p>套餐从购买日起按月计算，店铺加购 {yuanLabel(view.store_monthly_cents)}/家/月，成员加购 {yuanLabel(view.member_monthly_cents)}/人/月，与套餐统一续费。</p>
      <p>已付名额继续用满；减少续费不自动退款。手动暂停、解绑、删除店铺不改变已订阅名额。到期暂停新操作，保留配置及历史数据，已受理业务继续收尾。</p>
      {view.store_choices.some((store) => !store.manual_disabled && next.keep_store_ids?.length && !next.keep_store_ids.includes(store.id)) && <p>未列入下期保留名单的店铺仅可使用至本期结束。删除保留店铺后，对应名额保持空闲。</p>}
    </section>
    {editor && <SubscriptionEditor key={`${workspace?.uuid}-${editor.action}-${editor.period?.id ?? ""}-${editor.restore ?? false}`} view={view} editor={editor} workspaceUuid={workspace?.uuid ?? ""} onClose={() => setEditor(undefined)} onSaved={(nextView) => { setView(nextView); setReload((n) => n + 1); setEditor(undefined) }} />}
  </div>
}

function SubscriptionEditor({ view, editor, workspaceUuid, onClose, onSaved }: {
  view: SubscriptionView; editor: Editor; workspaceUuid: string; onClose: () => void; onSaved: (view: SubscriptionView) => void
}) {
  const renewal = editor.action === "schedule" || editor.action === "renew"
  const initial = editor.period ?? (renewal ? view.next : { plan_key: view.plan_key === "free" ? "lite" : view.plan_key, extra_stores: view.extra_stores, extra_members: view.extra_members })
  const [plan, setPlan] = useState(initial.plan_key)
  const [stores, setStores] = useState(initial.extra_stores)
  const [members, setMembers] = useState(initial.extra_members)
  const [months, setMonths] = useState(1)
  const [renewAlso, setRenewAlso] = useState(editor.restore || (view.next.stores >= view.stores.limit && view.next.members >= view.members.limit && view.next.plan_key === view.plan_key))
  const currentPeriod = view.periods.find((p) => new Date(p.starts_at).getTime() <= Date.now())
  const initialKeep = editor.period?.keep_store_ids ?? (renewal ? view.next.keep_store_ids : currentPeriod?.keep_store_ids ?? null)
  const [keep, setKeep] = useState<string[] | null>(initialKeep?.length ? initialKeep.filter((id) => view.store_choices.some((s) => s.id === id && !s.manual_disabled)) : null)
  const [keepMembers, setKeepMembers] = useState<number[] | null>(editor.period?.keep_member_ids ?? (renewal ? view.next.keep_member_ids : null))
  const [quote, setQuote] = useState<SubscriptionQuote>()
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [reading, setReading] = useState(false)
  const [read, setRead] = useState(false)
  const [cancelPending, setCancelPending] = useState(false)
  const [failure, setFailure] = useState<string>()
  const planRow = view.plans.find((p) => p.key === plan)!
  const limit = planRow.stores + stores
  const choices = view.store_choices.filter((s) => !s.manual_disabled)
  const needsKeep = ["schedule", "keep", "change"].includes(editor.action) && choices.length > limit
  const memberLimit = planRow.members + members
  const needsMembers = ["schedule", "keep", "change"].includes(editor.action) && view.member_choices.length > memberLimit
  const selectedMembers = keepMembers ?? view.member_choices.slice(0, memberLimit).map((m) => m.id)
  const selected = keep ?? choices.slice(0, limit).map((s) => s.id)
  const paused = quote?.keep_store_ids ? choices.filter((s) => !quote.keep_store_ids!.includes(s.id)) : []
  const title = editor.action === "schedule" ? "调整下期店铺数量" : editor.action === "keep" ? "修改到期保留名单" : editor.restore ? "恢复店铺容量" : editor.action === "renew" ? "续费套餐与加购" : editor.action === "subscribe" ? "购买套餐" : "本期加购 / 升级"
  function edit(change: () => void) { change(); setQuote(undefined); setAccepted(false); setRead(false); setFailure(undefined) }
  async function preview() {
    setBusy(true); setFailure(undefined)
    try {
      const request: SubscriptionRequest = {
        action: editor.action, expected_workspace_uuid: workspaceUuid,
        target: { plan_key: plan, extra_stores: stores, extra_members: members }, months: months as 1 | 3 | 6 | 12,
        keep_store_ids: needsKeep ? selected : keep,
        keep_member_ids: needsMembers ? selectedMembers : keepMembers,
        period_id: editor.period?.id,
        renew_with_change: editor.action === "change" ? renewAlso : undefined,
      }
      setQuote(await subscriptionHttp.quote(request))
    } catch (reason) { setFailure(errorMessage(reason, "预览失败，请刷新订阅后重试")) }
    finally { setBusy(false) }
  }
  async function confirm() {
    if (!quote || (!quote.schedule_only && !accepted)) return
    setBusy(true); setFailure(undefined)
    try {
      if (quote.schedule_only) {
        onSaved(await subscriptionHttp.confirm(quote.quote_id, cancelPending))
        notifySuccess("下期配置已保存，已付期间继续使用")
      } else {
        await subscriptionHttp.order(quote.quote_id, view.purchase_agreement.version)
        onSaved(await subscriptionHttp.view())
        notifySuccess("订单已创建，请按单号核对付款")
      }
    } catch (reason) { setFailure(errorMessage(reason, "确认失败，请刷新后重新预览")); setQuote(undefined) }
    finally { setBusy(false) }
  }
  return <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl" showCloseButton={!busy}>
      <DialogHeader><DialogTitle>{reading ? view.purchase_agreement.title : title}</DialogTitle><DialogDescription>当前可用 {view.stores.limit} 家，可使用至 {subscriptionDate(view.current_end)}。</DialogDescription></DialogHeader>
      {reading ? <><p className="whitespace-pre-wrap text-sm leading-7">{view.purchase_agreement.content}</p><Button variant="outline" onClick={() => { setReading(false); setRead(true) }}>返回购买</Button></> : <>
        {!quote ? <div className="flex flex-col gap-4">
          {["subscribe", "change"].includes(editor.action) && !editor.restore && <label className="flex flex-col gap-2 text-sm">套餐<select className="h-9 rounded-md border border-input bg-background px-3" value={plan} onChange={(e) => edit(() => setPlan(e.target.value))}>{view.plans.filter((p) => p.key !== "free").map((p) => <option key={p.key} value={p.key}>{planName(p.key)} · {yuanLabel(p.monthly_cents)}/月 · 自带 {p.stores} 家店铺</option>)}</select></label>}
          {editor.action !== "renew" && <label className="flex flex-col gap-2 text-sm">{editor.action === "schedule" ? "下期加购店铺名额" : "加购店铺名额"}<Input type="number" min={0} step={1} value={stores} disabled={editor.action === "keep" || editor.restore} onChange={(e) => edit(() => setStores(Math.max(0, Math.floor(Number(e.target.value) || 0))))} /><span className="text-xs text-muted-foreground">套餐自带 {planRow.stores} 家，合计 {limit} 家。少于套餐自带数量请变更套餐。</span></label>}
          {editor.action === "schedule" && stores > 0 && <Button variant="outline" onClick={() => edit(() => setStores(0))}>取消全部店铺加购</Button>}
          {["subscribe", "change"].includes(editor.action) && !editor.restore && <label className="flex flex-col gap-2 text-sm">加购成员名额<Input type="number" min={view.extra_members} step={1} value={members} onChange={(e) => edit(() => setMembers(Math.max(view.extra_members, Math.floor(Number(e.target.value) || 0))))} /></label>}
          {["subscribe", "renew"].includes(editor.action) && <label className="flex flex-col gap-2 text-sm">购买月数<select className="h-9 rounded-md border border-input bg-background px-3" value={months} onChange={(e) => edit(() => setMonths(Number(e.target.value)))}>{[1, 3, 6, 12].map((m) => <option key={m} value={m}>{m} 个月</option>)}</select></label>}
          {needsKeep && <fieldset className="flex flex-col gap-2"><legend className="mb-2 text-sm font-medium">选择到期保留的店铺，最多 {limit} 家（{selected.length}/{limit}）</legend><p className="mb-2 text-xs text-muted-foreground">实际连接 {choices.length} 家，只需暂停 {choices.length - limit} 家。</p>{choices.map((s) => <label key={s.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selected.includes(s.id)} onCheckedChange={(checked) => edit(() => setKeep(checked ? [...selected, s.id] : selected.filter((id) => id !== s.id)))} />{s.name || s.id}</label>)}</fieldset>}
          {needsMembers && <fieldset className="flex flex-col gap-2"><legend className="mb-2 text-sm font-medium">到期保留的成员（{selectedMembers.length}/{memberLimit}）</legend>{view.member_choices.map((m) => <label key={m.id} className="flex items-center gap-2 text-sm"><Checkbox checked={selectedMembers.includes(m.id)} disabled={m.owner} onCheckedChange={(checked) => edit(() => setKeepMembers(checked ? [...selectedMembers, m.id] : selectedMembers.filter((id) => id !== m.id)))} />{m.name || `成员 ${m.id}`}{m.owner ? "（所有者）" : ""}</label>)}</fieldset>}
          {editor.action === "change" && !editor.restore && <label className="flex items-center gap-2 text-sm"><Checkbox checked={renewAlso} onCheckedChange={(value) => edit(() => setRenewAlso(Boolean(value)))} />下次也续费本次数量</label>}
          {editor.action === "change" && <p className="text-xs text-muted-foreground">已设置的下期目标默认保留。已经付款的未来期间按缺少的名额分别补差。</p>}
          <Button disabled={busy || (needsKeep && (selected.length > limit || selected.length === 0)) || (needsMembers && (selectedMembers.length > memberLimit || selectedMembers.length === 0))} onClick={() => void preview()}>{busy && <Spinner />}预览费用与生效日期</Button>
        </div> : <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-muted-foreground">当前可用</dt><dd>{quote.current.stores} 家，至 {subscriptionDate(quote.current.term_end)}</dd>
            <dt className="text-muted-foreground">{quote.schedule_only ? "下期配置" : "购买容量"}</dt><dd>{quote.target.stores} 家 · {quote.target.members} 人</dd>
            <dt className="text-muted-foreground">{quote.schedule_only ? "适用日期" : "服务期间"}</dt><dd>{subscriptionDate(quote.effective_at)}{!quote.schedule_only && ` 至 ${subscriptionDate(quote.term_end)}`}</dd>
            <dt className="text-muted-foreground">下次续费</dt><dd>{planName(quote.renewal.plan_key)} · 加购 {quote.renewal.extra_stores} 家 · {yuanLabel(quote.renewal_amount_cents)}/月</dd>
            <dt className="text-muted-foreground">到期暂停</dt><dd>{paused.length ? paused.map((s) => s.name || s.id).join("、") : "无"}</dd>
            <dt className="text-muted-foreground">本次应付</dt><dd className="text-lg font-semibold">{yuanLabel(quote.amount_cents)}</dd>
          </dl>
          {quote.breakdown.map((line, i) => <p key={i} className="text-xs text-muted-foreground">{line.label} · {yuanLabel(line.cents)}</p>)}
          <p className="text-xs leading-6 text-muted-foreground">已付期间继续使用，本次调整不自动退款。暂停后配置及历史数据保留；新业务暂停，已受理业务继续收尾。</p>
          {quote.schedule_only && view.pending_order && <label className="flex items-center gap-2 text-sm"><Checkbox checked={cancelPending} onCheckedChange={(v) => setCancelPending(Boolean(v))} />取消待付款订单并修改配置（支付结果不确定时等待渠道确认）</label>}
          {!quote.schedule_only && <><Button variant="link" className="justify-start" onClick={() => setReading(true)}>阅读《{view.purchase_agreement.title}》</Button><label className="flex items-center gap-2 text-sm"><Checkbox aria-label="我已阅读并同意购买确认" disabled={!read} checked={accepted} onCheckedChange={(v) => setAccepted(Boolean(v))} />我已阅读并同意购买确认</label></>}
          <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setQuote(undefined)}>返回修改</Button><Button disabled={busy || (!quote.schedule_only && !accepted) || (quote.schedule_only && view.pending_order && !cancelPending)} onClick={() => void confirm()}>{busy && <Spinner />}{quote.schedule_only ? editor.action === "keep" ? "确认保留名单" : quote.target.stores < quote.current.stores ? "确认下期减少" : "确认下期配置" : editor.restore ? `恢复为 ${quote.target.stores} 家，补差 ${yuanLabel(quote.amount_cents)}` : "确认购买"}</Button></div>
        </div>}
        {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      </>}
    </DialogContent>
  </Dialog>
}

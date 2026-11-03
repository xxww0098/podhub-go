import { useCallback, useEffect, useRef, useState, type FormEvent } from "react"
import { Infinity as InfinityIcon, Plus, RefreshCw } from "lucide-react"

import type { components } from "@/api/schema"
import { adminHttp } from "@/bindings/http-admin"
import { ErrorNotice } from "@/components/error-notice"
import { PlatformAdminDialog, PlatformAdminDialogFooter } from "@/components/platform-admin-dialog"
import { PlatformAdminSurface } from "@/components/platform-admin-surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

type Coupon = components["schemas"]["AdminSubscriptionCoupon"]
const couponTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" })
const beijingInputTime = (at: number) => new Date(at + 8 * 60 * 60 * 1000).toISOString().slice(0, 16)

export function SubscriptionCoupons() {
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string>()
  const [open, setOpen] = useState(false)
  const [changing, setChanging] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const generation = useRef(0)
  const load = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    setFailure(undefined)
    try {
      const next = await adminHttp.adminListSubscriptionCoupons()
      if (generation.current === current) { setCoupons(next.coupons); setNow(Date.now()) }
    } catch (reason) {
      if (generation.current === current) setFailure(errorMessage(reason, "读取失败，列表可能不是最新状态"))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [])
  useEffect(() => { void load(); return () => { generation.current++ } }, [load])
  useEffect(() => {
    const next = Math.min(...coupons.flatMap((coupon) => [Date.parse(coupon.starts_at), Date.parse(coupon.expires_at)]).filter((at) => at > now))
    if (!Number.isFinite(next)) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.min(Math.max(1, next - Date.now() + 1), 2_147_483_647))
    return () => window.clearTimeout(timer)
  }, [coupons, now])

  async function toggle(coupon: Coupon) {
    if (changing) return
    setChanging(coupon.code)
    try {
      const next = await adminHttp.adminSetSubscriptionCouponEnabled(coupon.code, !coupon.enabled)
      setCoupons((current) => current.map((item) => item.code === next.code ? next : item))
      setNow(Date.now())
      notifySuccess(next.enabled ? "优惠码已启用" : "优惠码已停用")
    } catch (reason) { notifyCommandError(reason, "优惠码状态更新失败") }
    finally { setChanging(undefined) }
  }

  return <>
    <PlatformAdminSurface bodyClassName="overflow-auto" toolbar={<div className="flex w-full flex-wrap items-center gap-2">
      <Button onClick={() => setOpen(true)}><Plus aria-hidden />生成优惠码</Button>
      <IconButton icon={RefreshCw} label="刷新优惠码" variant="outline" disabled={loading} onClick={() => void load()} />
      <span className="ml-auto text-meta text-muted-foreground">{coupons.length} 个优惠码</span>
    </div>}>
      {failure && <div className="p-3"><ErrorNotice layout="banner" title={failure} /><Button variant="outline" size="sm" onClick={() => void load()}>重试</Button></div>}
      {loading && coupons.length === 0 ? <p role="status" className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground"><Spinner />正在读取优惠码…</p> : <Table aria-label="订阅优惠码">
        <TableHeader><TableRow><TableHead>优惠码</TableHead><TableHead>减免比例</TableHead><TableHead>已用 / 上限</TableHead><TableHead>可用时段（北京时间）</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{coupons.length ? coupons.map((coupon) => {
          const status = !coupon.enabled ? "已停用" : Date.parse(coupon.expires_at) <= now ? "已结束" : Date.parse(coupon.starts_at) > now ? "未开始" : coupon.max_uses > 0 && coupon.used_count >= coupon.max_uses ? "已用完" : "可用"
          return <TableRow key={coupon.code}>
            <TableCell><span className="select-all font-medium">{coupon.code}</span></TableCell>
            <TableCell>{coupon.discount_percent}%</TableCell>
            <TableCell className="tabular-nums"><span className="inline-flex items-center gap-1">{coupon.used_count} / {coupon.max_uses === 0 ? <InfinityIcon role="img" aria-label="不限次数" className="size-4" /> : coupon.max_uses}</span></TableCell>
            <TableCell className="tabular-nums"><span className="block whitespace-nowrap">{couponTime.format(new Date(coupon.starts_at))}</span><span className="block whitespace-nowrap text-muted-foreground">至 {couponTime.format(new Date(coupon.expires_at))}</span></TableCell>
            <TableCell><Badge variant={status === "可用" ? "good" : "secondary"}>{status}</Badge></TableCell>
            <TableCell className="text-right"><Button variant="outline" size="sm" disabled={Boolean(changing)} onClick={() => void toggle(coupon)} aria-label={`${coupon.enabled ? "停用" : "启用"}优惠码 ${coupon.code}`}>{changing === coupon.code && <Spinner />}{coupon.enabled ? "停用" : "启用"}</Button></TableCell>
          </TableRow>
        }) : <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">暂无订阅优惠码</TableCell></TableRow>}</TableBody>
      </Table>}
    </PlatformAdminSurface>
    <p className="text-meta leading-5 text-muted-foreground">优惠码用于订阅购买和续费，可在年付 8 折后叠加。成功创建订单计 1 次，取消不返还次数。</p>
    <CouponCreate open={open} onOpenChange={setOpen} onCreated={(coupon) => { setCoupons((current) => [coupon, ...current]); setNow(Date.now()); setOpen(false) }} />
  </>
}

function CouponCreate({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: (coupon: Coupon) => void }) {
  const formRef = useRef<HTMLFormElement>(null)
  const [code, setCode] = useState("")
  const [maxUses, setMaxUses] = useState("100")
  const [unlimited, setUnlimited] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  function generateCode() {
    setCode(`SALE-${crypto.randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`)
  }
  useEffect(() => { if (open) { formRef.current?.reset(); generateCode(); setMaxUses("100"); setUnlimited(false); setFailure(undefined) } }, [open])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const fields = new FormData(event.currentTarget)
    setSaving(true)
    setFailure(undefined)
    try {
      const start = String(fields.get("starts_at") ?? "")
      const end = String(fields.get("expires_at") ?? "")
      if (!start || !end) throw new Error("请选择开始和结束时间")
      const startsAt = new Date(`${start}+08:00`)
      const expiresAt = new Date(`${end}+08:00`)
      if (expiresAt <= startsAt) throw new Error("结束时间须晚于开始时间")
      const coupon = await adminHttp.adminCreateSubscriptionCoupon({ code: String(fields.get("code") ?? "").trim(), discount_percent: Number(fields.get("discount_percent")), max_uses: unlimited ? 0 : Number(fields.get("max_uses")), starts_at: startsAt.toISOString(), expires_at: expiresAt.toISOString() })
      onCreated(coupon)
      notifySuccess("优惠码已创建")
    } catch (reason) { setFailure(errorMessage(reason, "优惠码创建失败")) }
    finally { setSaving(false) }
  }

  return <PlatformAdminDialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }} title="生成订阅优惠码" showCloseButton={!saving}>
    <form ref={formRef} onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
      <fieldset disabled={saving} className="min-h-0 overflow-y-auto border-0 p-4">
        <FieldGroup>
          <Field><FieldLabel htmlFor="coupon-code">优惠码</FieldLabel><div className="flex gap-2"><Input id="coupon-code" name="code" minLength={3} maxLength={32} pattern="[A-Za-z0-9_-]{3,32}" value={code} onChange={(event) => setCode(event.target.value)} required placeholder="例如 TEAM10" /><Button type="button" variant="outline" onClick={generateCode}><RefreshCw aria-hidden />重新生成</Button></div></Field>
          <div className="grid grid-cols-2 gap-4">
            <Field><FieldLabel htmlFor="coupon-percent">减免比例（%）</FieldLabel><Input id="coupon-percent" name="discount_percent" type="number" min={1} max={99} step={1} defaultValue="10" required /></Field>
            <Field><FieldLabel htmlFor="coupon-uses">可用次数</FieldLabel><div className="flex gap-2"><Input id="coupon-uses" name="max_uses" type={unlimited ? "text" : "number"} min={1} max={1000000} step={1} value={unlimited ? "不限次数" : maxUses} onChange={(event) => setMaxUses(event.target.value)} readOnly={unlimited} required={!unlimited} /><IconButton icon={InfinityIcon} label="不限次数" aria-pressed={unlimited} variant={unlimited ? "default" : "outline"} onClick={() => setUnlimited((value) => !value)} /></div></Field>
          </div>
          <Field><FieldLabel htmlFor="coupon-starts">开始时间（北京时间）</FieldLabel><Input id="coupon-starts" name="starts_at" type="datetime-local" defaultValue={beijingInputTime(Date.now())} required /></Field>
          <Field><FieldLabel htmlFor="coupon-expires">结束时间（北京时间）</FieldLabel><Input id="coupon-expires" name="expires_at" type="datetime-local" defaultValue={beijingInputTime(Date.now() + 7 * 24 * 60 * 60 * 1000)} required /></Field>
        </FieldGroup>
        {failure && <div className="mt-3"><ErrorNotice layout="banner" title={failure} /></div>}
      </fieldset>
      <PlatformAdminDialogFooter><Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button><Button type="submit" disabled={saving}>{saving && <Spinner />}保存优惠码</Button></PlatformAdminDialogFooter>
    </form>
  </PlatformAdminDialog>
}

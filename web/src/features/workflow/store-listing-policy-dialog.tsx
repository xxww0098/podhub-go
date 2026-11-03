import { useEffect, useId, useRef, useState } from "react"
import { LoaderCircle, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { errorMessage } from "@/lib/error-message"
import { notifySuccess } from "@/lib/notify"
import { loadStoreListingPolicy, parseStoreListingPolicy, saveStoreListingPolicy, type StoreListingPolicy } from "./store-listing-policy-api"

export function StoreListingPolicyDialog({ open, onOpenChange, storeId, storeName, workspaceId }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  storeId: string
  storeName: string
  workspaceId?: number
}) {
  const id = useId()
  const generation = useRef(0)
  const [policy, setPolicy] = useState<StoreListingPolicy | null>(null)
  const [cap, setCap] = useState("")
  const [gap, setGap] = useState("0")
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    const ticket = ++generation.current
    const controller = new AbortController()
    setPolicy(null)
    setError(null)
    setChecked(false)
    setSaving(false)
    if (!open) return () => controller.abort()
    setLoading(true)
    void loadStoreListingPolicy(storeId, controller.signal).then((value) => {
      if (ticket !== generation.current) return
      setPolicy(value)
      setCap(value.daily_cap === null ? "" : String(value.daily_cap))
      setGap(String(value.min_gap_seconds))
    }).catch((reason) => {
      if (!controller.signal.aborted && ticket === generation.current) setError(errorMessage(reason, "无法读取上架策略，请重试"))
    }).finally(() => {
      if (ticket === generation.current) setLoading(false)
    })
    return () => { generation.current++; controller.abort() }
  }, [open, storeId, workspaceId, reload])

  const parsed = parseStoreListingPolicy(cap, gap)
  const invalid = checked && parsed === null
  const busy = loading || saving

  async function save() {
    setChecked(true)
    if (!parsed || !policy?.can_manage || busy) return
    const ticket = generation.current
    setSaving(true)
    setError(null)
    try {
      const value = await saveStoreListingPolicy(storeId, parsed.dailyCap, parsed.minGapSeconds)
      if (ticket !== generation.current) return
      setPolicy(value)
      notifySuccess("上架策略已保存")
      onOpenChange(false)
    } catch (reason) {
      if (ticket === generation.current) setError(errorMessage(reason, "上架策略未保存，输入已保留，请重试"))
    } finally {
      if (ticket === generation.current) setSaving(false)
    }
  }

  return <Dialog open={open} onOpenChange={(value) => { if (!saving) onOpenChange(value) }}>
    <DialogContent aria-busy={busy}>
      <DialogHeader>
        <DialogTitle>上架策略</DialogTitle>
        <DialogDescription>{storeName} · 每日额度按北京时间重置</DialogDescription>
      </DialogHeader>
      {loading ? <p role="status" className="flex items-center gap-2"><LoaderCircle className="size-4 animate-spin" aria-hidden />读取中…</p> : null}
      {policy ? <>
        <p className="text-sm">今日已提交 <span className="tabular-nums font-medium">{policy.submitted_today}</span>{policy.daily_cap !== null ? ` / ${policy.daily_cap}` : " 件"}</p>
        {policy.wait_reason && policy.next_allowed_at ? <p role="status" className="text-sm text-st-unknown-ink">
          {policy.wait_reason === "STORE_DAILY_CAP_REACHED" ? "今日额度已用完" : "正在等待发送间隔"}，下次可提交时间 {new Date(policy.next_allowed_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}
        </p> : null}
        <form id={`${id}-form`} className="grid gap-4" onSubmit={(event) => { event.preventDefault(); void save() }}>
          <Field>
            <FieldLabel htmlFor={`${id}-cap`}>每日提交上限（件）</FieldLabel>
            <Input id={`${id}-cap`} type="text" inputMode="numeric" value={cap} onChange={(event) => setCap(event.target.value)} onBlur={() => setChecked(true)} disabled={busy || !policy.can_manage} aria-invalid={invalid} aria-describedby={`${id}-cap-help`} />
            <FieldDescription id={`${id}-cap-help`}>留空不限制；1–1000000 件。结果未知的发送仍计入额度。</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-gap`}>最小发送间隔（秒）</FieldLabel>
            <Input id={`${id}-gap`} type="text" inputMode="numeric" value={gap} onChange={(event) => setGap(event.target.value)} onBlur={() => setChecked(true)} disabled={busy || !policy.can_manage} aria-invalid={invalid} aria-describedby={`${id}-gap-help`} />
            <FieldDescription id={`${id}-gap-help`}>0–86400 秒；0 不限制。同一请求内的商品一起发送。</FieldDescription>
          </Field>
          {invalid ? <p role="alert" className="text-sm text-destructive">请输入有效的每日上限和发送间隔。</p> : null}
        </form>
      </> : null}
      {error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">{error}{!policy ? <Button type="button" size="sm" variant="outline" onClick={() => setReload((value) => value + 1)}><RefreshCw aria-hidden />重试</Button> : null}</div> : null}
      <DialogFooter>
        <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
        {policy?.can_manage ? <Button type="submit" form={`${id}-form`} disabled={busy || invalid}>{saving ? "保存中…" : "保存"}</Button> : null}
      </DialogFooter>
    </DialogContent>
  </Dialog>
}

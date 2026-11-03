import { useEffect, useState } from "react"
import { Truck } from "lucide-react"
import { sourceFulfillersHttp, type SourceFulfiller } from "@/bindings/http-source-fulfillers"
import { listSupplierAccounts, type SupplierAccountMemberView } from "@/bindings/http-supplier-portal"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

export function SupplierFulfillmentBinding({ db, superAdmin, onChanged }: {
  db: SupplierDb
  superAdmin: boolean
  onChanged: () => Promise<void>
}) {
  const [grants, setGrants] = useState<SourceFulfiller[]>([])
  const [members, setMembers] = useState<SupplierAccountMemberView[]>([])
  const [loading, setLoading] = useState(superAdmin)
  const [error, setError] = useState("")
  const [nonce, setNonce] = useState(0)
  const [accountUuid, setAccountUuid] = useState("")
  const [busy, setBusy] = useState(false)
  const [unbinding, setUnbinding] = useState(false)
  useEffect(() => {
    if (!superAdmin) return
    let active = true
    setLoading(true); setError("")
    void Promise.all([sourceFulfillersHttp.list(db.sourceId), listSupplierAccounts()]).then(([data, directory]) => {
      if (!active) return
      setGrants(data.fulfillers)
      setMembers(directory.groups.find((group) => group.factory.factory_id === db.factoryId)?.members.filter((member) => member.status === "active") ?? [])
    }).catch((reason) => { if (active) setError(errorMessage(reason, "无法读取履约绑定，请重新读取")) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [db.sourceId, db.factoryId, superAdmin, nonce])
  const bound = grants.find((grant) => grant.status === "active")
  const items = members.map((member) => ({ value: member.account_uuid, label: member.email }))
  const refresh = async () => { await onChanged(); setAccountUuid(""); setNonce((value) => value + 1) }
  return <section className="space-y-3 rounded-xl border border-border bg-card p-4" aria-label="工厂履约绑定" data-supplier-fulfillment="">
    <div className="flex items-start gap-3">
      <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-muted/50"><Truck aria-hidden className="size-4 text-muted-foreground" /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-compact font-semibold">履约账号</h2>
          <Badge variant={bound ? "good" : "outline"}>{bound ? "已绑定" : "待绑定"}</Badge>
        </div>
        <p className="mt-1 text-meta text-muted-foreground">订单推送给此处绑定的履约账号。未绑定时不能推单。</p>
      </div>
    </div>
    {!superAdmin ? <p className="text-compact">{db.fulfillerEmail ? `已绑定：${db.fulfillerEmail}` : "待绑定履约账号"}<span className="ml-2 text-meta text-muted-foreground">由超级管理员维护</span></p>
      : loading ? <p className="flex items-center gap-2 text-compact text-muted-foreground"><Spinner />正在读取履约绑定…</p>
      : error ? <div role="alert" className="flex flex-wrap items-center gap-3 text-compact text-destructive">{error}<Button size="sm" variant="outline" disabled={busy} onClick={async () => {
        setBusy(true)
        try { await refresh() }
        catch (reason) { setError(errorMessage(reason, "无法回读工厂状态，请重新读取")) }
        finally { setBusy(false) }
      }}>重新读取履约绑定</Button></div>
      : bound ? <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2.5"><p role="status" className="min-w-0 break-all text-compact">已绑定：<strong className="font-medium">{bound.email}</strong></p><Button size="sm" variant="outline" disabled={busy} onClick={() => setUnbinding(true)}>解除履约绑定</Button></div>
      : <form className="flex flex-wrap items-end gap-2" onSubmit={async (event) => {
        event.preventDefault()
        if (busy || !members.some((member) => member.account_uuid === accountUuid)) return
        setBusy(true)
        try {
          await sourceFulfillersHttp.grant(db.sourceId, accountUuid)
          await refresh(); notifySuccess("履约账号已绑定")
        } catch (reason) { setError("绑定结果待核实，请重新读取履约绑定"); notifyCommandError(reason, "未能确认履约绑定结果") }
        finally { setBusy(false) }
      }}>
        {members.length ? <><label className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5 text-meta">本工厂账号
          <Select items={items} value={accountUuid || null} onValueChange={(value) => setAccountUuid(value ?? "")} disabled={busy}>
            <SelectTrigger className="w-full" aria-label="选择履约账号"><SelectValue placeholder="选择本工厂已开通账号" /></SelectTrigger>
            <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
          </Select>
        </label><Button type="submit" variant="brand" disabled={busy || !accountUuid}>{busy ? <Spinner /> : null}绑定履约账号</Button></>
          : <p className="text-compact text-muted-foreground">待绑定：先在工厂设置中填写登录邮箱并保存，再绑定履约账号。</p>}
      </form>}
    <ConfirmDialog open={unbinding} onOpenChange={(open) => { if (!busy) setUnbinding(open) }} title="解除履约绑定" description={`解除 ${bound?.email ?? "此账号"} 后，本工厂不能接收新的推单；历史订单保留，操作权限按原授权规则执行。`} confirmText="解除绑定" busy={busy} onConfirm={async () => {
      if (!bound || busy) return
      setBusy(true)
      try {
        await sourceFulfillersHttp.revoke(db.sourceId, bound.fulfillerId)
        setUnbinding(false); await refresh(); notifySuccess("履约绑定已解除")
      } catch (reason) { setUnbinding(false); setError("解绑结果待核实，请重新读取履约绑定"); notifyCommandError(reason, "未能确认解绑结果") }
      finally { setBusy(false) }
    }} />
  </section>
}

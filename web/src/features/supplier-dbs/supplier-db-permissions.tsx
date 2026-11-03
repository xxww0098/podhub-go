import { useEffect, useMemo, useState } from "react"
import { ArrowLeft, CheckCircle2, Crown, KeyRound, LockKeyhole, Plus, UserRoundMinus, Users } from "lucide-react"
import type { AdminUsersOverview } from "@/bindings/commands"
import { adminHttp } from "@/bindings/http-admin"
import { catalogManagersHttp, type CatalogManager } from "@/bindings/http-catalog-managers"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { SupplierFulfillmentBinding } from "./supplier-fulfillment-binding"

/** A person whose display name is their email should not show the same string twice. */
export function accountOptionLabel(account: { name?: string | null; email: string }): string {
  const email = account.email.trim()
  const name = account.name?.trim() ?? ""
  return !name || name.toLocaleLowerCase() === email.toLocaleLowerCase() ? email : `${name} · ${email}`
}

export function SupplierDbPermissions({ db, superAdmin, onBack, onOpenAccounts, onFulfillmentChanged }: {
  db: SupplierDb
  superAdmin: boolean
  onBack: () => void
  onOpenAccounts: () => void
  onFulfillmentChanged: () => Promise<void>
}) {
  const [managers, setManagers] = useState<CatalogManager[]>([])
  const [loading, setLoading] = useState(superAdmin)
  const [error, setError] = useState("")
  const [nonce, setNonce] = useState(0)
  const [adding, setAdding] = useState(false)
  const [directory, setDirectory] = useState<AdminUsersOverview>()
  const [accountsLoading, setAccountsLoading] = useState(false)
  const [accountUuid, setAccountUuid] = useState("")
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<CatalogManager | null>(null)
  useEffect(() => {
    if (!superAdmin) return
    let active = true
    setLoading(true)
    setError("")
    void catalogManagersHttp.list(db.sourceId).then((data) => {
      if (active) setManagers(data.catalogManagers)
    }).catch((reason) => {
      if (active) setError(errorMessage(reason, "无法读取商品负责人"))
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [db.sourceId, superAdmin, nonce])
  useEffect(() => {
    if (!superAdmin || !adding || directory) return
    let active = true
    setAccountsLoading(true)
    void adminHttp.adminListUsers().then((data) => { if (active) setDirectory(data) })
      .catch((reason) => { if (active) notifyCommandError(reason, "无法读取可授权账号") })
      .finally(() => { if (active) setAccountsLoading(false) })
    return () => { active = false }
  }, [adding, directory, superAdmin])
  const activeManagers = managers.filter((manager) => manager.status === "active")
  const accounts = useMemo(() => {
    const people = [...(directory?.unaffiliated ?? []), ...(directory?.workspaces.flatMap((workspace) => workspace.members) ?? [])]
    return [...new Map(people.filter((person) => person.account_kind === "platform" && !person.disabled).map((person) => [person.uuid, person])).values()]
      .filter((person) => !managers.some((manager) => manager.status === "active" && manager.email === person.email))
  }, [directory, managers])
  const items = accounts.map((account) => ({ value: account.uuid, label: accountOptionLabel(account) }))
  return <div className="supplier-permissions flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-permissions="">
    <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
      <IconButton icon={ArrowLeft} label="返回商品库绑定" onClick={onBack} />
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="font-medium">商品库权限</span>
        <span className="truncate text-meta text-muted-foreground">{db.name}</span>
      </div>
      <span className="ml-auto shrink-0 whitespace-nowrap text-meta text-muted-foreground">{superAdmin ? "超级管理员" : "平台管理员"}</span>
    </div>
    <div className="grid min-h-0 flex-1 gap-5 overflow-y-auto p-4 sm:p-5 xl:grid-cols-[minmax(0,1fr)_300px]">
      <div className="min-w-0 space-y-5">
        <SupplierFulfillmentBinding key={db.sourceId} db={db} superAdmin={superAdmin} onChanged={onFulfillmentChanged} />
        <section aria-label="商品负责人" className="space-y-3 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 className="text-compact font-semibold">商品负责人</h2>
              <p className="mt-1 text-meta text-muted-foreground">按商品库授权，不改变账号的平台角色。</p>
            </div>
            {superAdmin ? <div className="flex items-center gap-2">
              {!loading && !error ? <span className="text-meta text-muted-foreground">{activeManagers.length} 人</span> : null}
              <Button variant="brand" size="sm" disabled={busy || loading || Boolean(error)} onClick={() => setAdding(true)}><Plus aria-hidden />添加</Button>
            </div> : null}
          </div>
          {!superAdmin ? <p className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2.5 text-compact text-muted-foreground"><LockKeyhole aria-hidden className="size-4" />负责人名单与授权由超级管理员管理。</p>
            : loading ? <div className="flex items-center gap-2 py-4 text-muted-foreground"><Spinner />正在读取负责人…</div>
            : error ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/30 px-3 py-2.5 text-compact text-destructive">{error}<Button variant="outline" size="sm" onClick={() => setNonce((value) => value + 1)}>重新读取</Button></div>
            : <Table aria-label="商品负责人授权"><TableHeader><TableRow><TableHead>账号</TableHead><TableHead>授权范围</TableHead><TableHead>状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>{managers.map((manager) => <TableRow key={manager.managerId}>
                <TableCell><span className="block font-medium">{manager.name || manager.email}</span><span className="text-meta text-muted-foreground">{manager.email}</span></TableCell>
                <TableCell>本库商品与规格</TableCell><TableCell>{manager.status === "active" ? "有效" : "已撤销"}</TableCell>
                <TableCell className="text-right">{manager.status === "active" ? <IconButton icon={UserRoundMinus} label="撤销" tip="撤销商品维护权限" variant="destructive" size="icon-sm" disabled={busy} onClick={() => setRevoking(manager)} /> : "—"}</TableCell>
              </TableRow>)}{!managers.length ? <TableRow><TableCell colSpan={4} className="py-10 text-center">
                <p className="text-compact font-medium">还没有商品负责人</p>
                <p className="mt-1 text-meta text-muted-foreground">添加后，该账号可以维护本库商品与供货成本。</p>
              </TableCell></TableRow> : null}</TableBody>
            </Table>}
          {adding && superAdmin ? <form aria-label="添加商品负责人" className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-muted/20 p-3" onSubmit={async (event) => {
            event.preventDefault()
            if (busy || !accounts.some((account) => account.uuid === accountUuid)) return
            setBusy(true)
            try {
              const data = await catalogManagersHttp.grant(db.sourceId, accountUuid)
              setManagers((current) => [...current.filter((manager) => manager.managerId !== data.catalogManager.managerId), data.catalogManager])
              setAdding(false); setAccountUuid(""); notifySuccess("已授予本库商品维护权限")
            } catch (reason) { notifyCommandError(reason, "授权失败，未更改账号角色") }
            finally { setBusy(false) }
          }}>
            <label className="flex min-w-0 flex-1 basis-64 flex-col gap-1.5 text-meta">平台账号
              <Select items={items} value={accountUuid || null} onValueChange={(next) => setAccountUuid(next ?? "")} disabled={busy || accountsLoading}>
                <SelectTrigger aria-label="选择商品负责人账号"><SelectValue placeholder={accountsLoading ? "正在读取账号…" : "选择已有平台账号"} /></SelectTrigger>
                <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
            <Button type="button" variant="outline" disabled={busy} onClick={() => setAdding(false)}>取消</Button>
            <Button type="submit" variant="brand" disabled={busy || !accountUuid}>{busy ? <Spinner /> : null}授予本库维护权限</Button>
          </form> : null}
        </section>
        {superAdmin ? <div className="border-t border-border pt-4">
          <Button variant="ghost" size="sm" onClick={onOpenAccounts}><KeyRound aria-hidden />管理工厂登录账号</Button>
        </div> : null}
      </div>
      <aside className="min-w-0 space-y-4">
        <section aria-label="平台管理范围" className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-compact font-semibold">平台管理范围</h2>
          <div className="mt-3 flex flex-col gap-3">
            <div className="flex items-start gap-2.5">
              <Crown aria-hidden className="mt-0.5 size-4 shrink-0 text-brand" />
              <div className="min-w-0">
                <p className="text-compact font-medium">超级管理员</p>
                <p className="mt-0.5 text-meta text-muted-foreground">全部商品库 · 管理商品、平台价及授权</p>
              </div>
            </div>
            <div className="flex items-start gap-2.5 border-t border-border pt-3">
              <Users aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <p className="text-compact font-medium">平台管理员</p>
                <p className="mt-0.5 text-meta text-muted-foreground">仅自己创建的库 · 维护商品及库公开状态</p>
              </div>
            </div>
          </div>
        </section>
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-compact font-semibold">商品负责人可以</h2>
          <div className="mt-3 flex flex-col gap-2">{["维护商品与规格", "维护供货成本"].map((text) => <p key={text} className="flex items-center gap-2 text-compact"><CheckCircle2 aria-hidden className="size-4 shrink-0 text-brand" />{text}</p>)}</div>
        </section>
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-compact font-semibold">由平台管理</h2>
          <div className="mt-3 flex flex-col gap-2">{["发布或停用库内商品：仅超级管理员", "归档已发布商品：仅超级管理员", "平台供货价：仅超级管理员", "人员授权：仅超级管理员", "整库公开：超级管理员或创建管理员"].map((text) => <p key={text} className="flex items-start gap-2 text-meta text-muted-foreground"><LockKeyhole aria-hidden className="mt-0.5 size-3.5 shrink-0" />{text}</p>)}</div>
        </section>
        <p className="px-1 text-meta text-muted-foreground">创建人：{db.creatorName || db.createdBy || "历史归属未知"}</p>
      </aside>
    </div>
    <ConfirmDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null) }} title="撤销商品维护权限" description={`撤销 ${revoking?.name || revoking?.email || "该账号"} 对本库的维护权限，已保存的商品和历史记录保留。`} confirmText="撤销授权" busy={busy} onConfirm={async () => {
      if (!superAdmin || !revoking || busy) return
      setBusy(true)
      try {
        await catalogManagersHttp.revoke(db.sourceId, revoking.managerId)
        setManagers((current) => current.map((manager) => manager.managerId === revoking.managerId ? { ...manager, status: "disabled" } : manager))
        setRevoking(null); notifySuccess("已撤销本库商品维护权限")
      } catch (reason) { notifyCommandError(reason, "撤销失败，请重新读取授权状态") }
      finally { setBusy(false) }
    }} />
  </div>
}

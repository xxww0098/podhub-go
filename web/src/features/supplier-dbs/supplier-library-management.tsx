import { useEffect, useState } from "react"
import { ArrowLeft, Link2, Plus, Settings2, SlidersHorizontal, Trash2 } from "lucide-react"
import { factoriesHttp, type Factory } from "@/bindings/http-factories"
import type { SupplierDb } from "@/bindings/http-supplier-dbs"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { replaceAddress } from "@/lib/address"
import { withSettings } from "@/lib/admin-surface"
import { commandFailure } from "./supplier-dbs-errors"
import { SupplierDbPermissions } from "./supplier-db-permissions"
import { SupplierPropManagerDialog } from "./supplier-props-manager"
import { EMPTY_DB_DRAFT, useSupplierDbsStore, type SupplierDbsStore } from "./supplier-dbs-store"

export function SupplierLibraryManagement({ store, superAdmin, onBack }: { store: SupplierDbsStore; superAdmin: boolean; onBack: () => void }) {
  const state = useSupplierDbsStore(store)
  const [factories, setFactories] = useState<Factory[]>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [dialog, setDialog] = useState<SupplierDb | "new" | null>(null)
  const [factoryId, setFactoryId] = useState("")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [permissionsId, setPermissionsId] = useState<string | null>(null)
  const [propertiesId, setPropertiesId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<SupplierDb | null>(null)
  const loadFactories = async () => {
    try { setFactories((await factoriesHttp.list()).factories); setLoadFailed(false) }
    catch (reason) { setLoadFailed(true); notifyCommandError(reason, "读取工厂失败") }
  }
  useEffect(() => { void loadFactories() }, [])
  const items = (factories ?? []).map((factory) => ({ value: factory.factory_id, label: factory.name }))
  const permissionsDb = (permissionsId && state.details[permissionsId]?.detail?.db) || state.dbs.find((db) => db.sourceId === permissionsId)
  const propDetail = propertiesId ? state.details[propertiesId]?.detail : undefined
  if (permissionsDb) return <SupplierDbPermissions db={permissionsDb} superAdmin={superAdmin} onBack={() => setPermissionsId(null)}
    onOpenAccounts={() => replaceAddress({ pathname: "/admin", search: withSettings(window.location.search, "supplier-accounts") })}
    onFulfillmentChanged={async () => {
      await store.loadDetail(permissionsDb.sourceId, { force: true }); await store.loadList()
      if (store.getState().status !== "ready" || store.getState().details[permissionsDb.sourceId]?.status !== "ready") throw new Error("无法回读商品库状态")
    }} />
  const openBinding = (target: SupplierDb | "new") => { setDialog(target); setFactoryId(""); setName("") }
  return <div className="flex min-h-0 flex-1 flex-col" data-supplier-libraries="">
    <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <IconButton icon={ArrowLeft} label="返回平台商品库" onClick={onBack} />
      <span className="font-medium">商品库工厂绑定</span>
      <Button className="ml-auto" variant="brand" size="sm" disabled={loadFailed || !factories} onClick={() => openBinding("new")}><Plus />绑定工厂</Button>
    </div>
    <div className="min-h-0 flex-1 space-y-2 overflow-auto p-4">
      {loadFailed ? <div role="alert">无法读取工厂目录 <Button variant="outline" size="sm" onClick={() => void loadFactories()}>重试</Button></div> : null}
      {!state.dbs.length ? <p className="text-sm text-muted-foreground">还没有商品库，先绑定已有工厂。</p> : null}
      {state.dbs.map((listDb) => { const db = state.details[listDb.sourceId]?.detail?.db ?? listDb; return <div key={db.sourceId} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
        <div className="min-w-0 flex-1"><p className="font-medium">{db.name}</p><p className="text-meta text-muted-foreground">{factories?.find((factory) => factory.factory_id === db.factoryId)?.name ?? (db.factoryId ? "工厂资料不可用" : "未绑定工厂")} · {db.rowCount} 个规格 · 履约：{db.fulfillerEmail || "待绑定"}</p></div>
        {!db.factoryId && db.sourceId !== "src_unassigned" ? <Button size="sm" variant="outline" onClick={() => openBinding(db)}><Link2 />绑定工厂</Button> : null}
        <label className="flex items-center gap-2 text-sm">接受委托<Switch checked={db.acceptsDelegate ?? false} disabled={busy} aria-label={`${db.name} 接受委托`} onCheckedChange={async (value) => {
          setBusy(true); const result = await store.updateDb(db.sourceId, { acceptsDelegate: value === true }); setBusy(false)
          if (!result.ok) notifyCommandError(commandFailure(result), "保存委托状态失败")
        }} /></label>
        <Button variant="ghost" size="sm" onClick={() => setPermissionsId(db.sourceId)}><Settings2 />权限</Button>
        <Button variant="ghost" size="sm" onClick={async () => {
          await store.loadDetail(db.sourceId, { force: true })
          const detail = store.getState().details[db.sourceId]
          if (detail?.status !== "ready") { notifyCommandError(detail?.reason, "读取商品库失败"); return }
          setPropertiesId(db.sourceId)
        }}><SlidersHorizontal />自定义属性</Button>
        {db.sourceId !== "src_unassigned" ? <Button variant="ghost" size="sm" aria-label={`删除商品库 ${db.name}`} onClick={() => setDeleting(db)}><Trash2 />删除商品库</Button> : null}
      </div> })}
    </div>
    <Dialog open={dialog !== null} onOpenChange={(open) => { if (!open && !busy) setDialog(null) }}><DialogContent>
      <DialogHeader><DialogTitle>绑定工厂</DialogTitle><DialogDescription>选择超级管理员已创建的工厂。每家工厂可以绑定多个商品库。</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={async (event) => {
        event.preventDefault()
        if (!dialog || !factoryId || busy || (dialog === "new" && !name.trim())) return
        setBusy(true)
        const result = dialog === "new"
          ? await store.createDb({ ...EMPTY_DB_DRAFT, factoryId, name: name.trim() })
          : await store.updateDb(dialog.sourceId, { factoryId })
        setBusy(false)
        if (!result.ok) { notifyCommandError(commandFailure(result), "绑定工厂失败"); return }
        setDialog(null); notifySuccess("工厂已绑定")
      }}>
        <Field><FieldLabel htmlFor="bind-factory">工厂</FieldLabel><Select items={items} value={factoryId || null} onValueChange={(value) => setFactoryId(value ?? "")} disabled={busy}><SelectTrigger id="bind-factory"><SelectValue placeholder="选择已有工厂" /></SelectTrigger><SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></Field>
        {dialog === "new" ? <Field><FieldLabel htmlFor="library-name">商品库名称</FieldLabel><Input id="library-name" value={name} required disabled={busy} onChange={(event) => setName(event.target.value)} /></Field> : null}
        {factories?.length === 0 ? <p className="text-sm text-muted-foreground">请先由超级管理员在平台管理中创建工厂。</p> : null}
        <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>取消</Button><Button type="submit" variant="brand" disabled={busy || !factoryId || (dialog === "new" && !name.trim())}>{busy ? <Spinner /> : null}确认绑定</Button></DialogFooter>
      </form>
    </DialogContent></Dialog>
    <ConfirmDialog open={deleting !== null} onOpenChange={(open) => { if (!open && !busy) setDeleting(null) }} title={`删除商品库「${deleting?.name ?? ""}」？`}
      description="将删除该商品库的商品、规格和属性，工厂及其账号会保留。有关联订单时不能删除。" confirmText="删除商品库" busy={busy} onConfirm={async () => {
        if (!deleting || busy) return
        setBusy(true); const result = await store.deleteDb(deleting.sourceId); setBusy(false)
        if (!result.ok) { notifyCommandError(commandFailure(result), "删除商品库失败"); return }
        setDeleting(null); notifySuccess("商品库已删除")
      }} />
    {propDetail ? <SupplierPropManagerDialog open store={store} sourceId={propDetail.db.sourceId} propDefs={propDetail.propDefs} rows={propDetail.rows} onOpenChange={(open) => { if (!open) setPropertiesId(null) }} /> : null}
  </div>
}

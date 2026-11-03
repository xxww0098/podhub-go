import { useEffect, useRef, useState } from "react"
import { Archive, Pencil, Plus, RotateCcw } from "lucide-react"
import { supplierCatalogHttp, type CatalogRow, type CatalogSource, type CatalogSourceDetail } from "@/bindings/http-supplier-catalog"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ReasonTooltip } from "@/components/reason-tooltip"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { loadAccountOverview, useAccountOverview } from "@/features/account/account-overview-cache"
import { isPlatformSuperAdminRole } from "@/lib/platform-role"
import { READINESS_LABELS, missingFromRefusal } from "@/features/supplier-dbs/supplier-readiness"
import { formatCnyCents } from "@/features/supplier-dbs/supplier-prop-editors"
import { CatalogRowEditor } from "./catalog-row-editor"

export function catalogMissing(row: CatalogRow): string[] {
  const missing = (Object.keys(READINESS_LABELS) as (keyof typeof row.readiness)[]).filter((key) => !row.readiness[key]).map((key) => READINESS_LABELS[key])
  if (!row.gallery.length) missing.push("图集")
  return missing
}

/** Published rows leave the catalogue via unpublish, which only a super admin may do. */
export function archiveBlockReason(published: boolean, canPublish: boolean): string | undefined {
  return published && !canPublish ? "已发布商品仅超级管理员可归档" : undefined
}

export function CatalogArchiveAction({ row, canPublish, busy, onArchive }: {
  row: Pick<CatalogRow, "title" | "published">
  canPublish: boolean
  busy: boolean
  onArchive: () => void
}) {
  const reason = archiveBlockReason(row.published, canPublish)
  return <ReasonTooltip reason={reason}>
    <IconButton icon={Archive} label={`归档 ${row.title}`} disabled={busy || Boolean(reason)} disabledReason={reason} onClick={onArchive} />
  </ReasonTooltip>
}

export function CatalogManagerScreen() {
  const canPublish = isPlatformSuperAdminRole(useAccountOverview()?.session.role)
  const [sources, setSources] = useState<CatalogSource[]>([])
  const [sourceId, setSourceId] = useState("")
  const [detail, setDetail] = useState<CatalogSourceDetail>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState("")
  const [editing, setEditing] = useState<CatalogRow | "new" | null>(null)
  const [archiving, setArchiving] = useState<CatalogRow | null>(null)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  useEffect(() => {
    let active = true
    setLoading(true); setError(""); setDetail(undefined); setEditing(null)
    void supplierCatalogHttp.sources().then(async ({ sources: next }) => {
      if (!active) return
      setSources(next)
      if (!next.length) void loadAccountOverview({ force: true }).catch(() => {})
      const id = next.some((source) => source.sourceId === sourceId) ? sourceId : next[0]?.sourceId ?? ""
      if (id !== sourceId) { setSourceId(id); return }
      if (id) {
        const value = await supplierCatalogHttp.detail(id)
        if (active) setDetail(value)
      }
    }).catch((reason) => {
      if (!active) return
      setError(errorMessage(reason, "无法读取获授权商品库"))
      void loadAccountOverview({ force: true }).catch(() => {})
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [sourceId, reload])
  const updateRow = (row: CatalogRow) => setDetail((current) => current ? { ...current, rows: current.rows.some((item) => item.productId === row.productId) ? current.rows.map((item) => item.productId === row.productId ? row : item) : [...current.rows, row] } : current)
  const mutate = async (run: () => Promise<void>) => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    try { await run() } catch (reason) {
      const missing = missingFromRefusal(reason)
      notifyCommandError(reason, missing.length ? `待补：${missing.join("、")}` : "操作失败，请重新读取后重试")
      if ((reason as { status?: number }).status === 403) { setDetail(undefined); setEditing(null); setReload((value) => value + 1) }
    } finally { pending.current = false; setBusy(false) }
  }
  if (editing && detail) return <CatalogRowEditor key={editing === "new" ? "new" : editing.productId} row={editing === "new" ? undefined : editing} source={detail.source} propDefs={detail.propDefs} onCancel={() => setEditing(null)} onChanged={updateRow} onSaved={(row) => { updateRow(row); setEditing(editing === "new" ? row : null); notifySuccess(editing === "new" ? "商品已创建，可继续上传素材" : "商品已保存") }} />
  const items = sources.map((source) => ({ value: source.sourceId, label: source.name }))
  const rows = detail?.rows.filter((row) => `${row.title} ${row.platformCode} ${row.size}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())) ?? []
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-catalog-manager="">
    <div className="flex flex-wrap items-center gap-2 p-3">
      <Select items={items} value={sourceId || null} onValueChange={(value) => { setSourceId(value ?? ""); setQuery("") }} disabled={loading || busy}>
        <SelectTrigger aria-label="选择获授权商品库" className="w-48"><SelectValue placeholder="选择商品库" /></SelectTrigger>
        <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
      </Select>
      <Input aria-label="搜索获授权商品" placeholder="商品、编号或规格" value={query} onChange={(event) => setQuery(event.target.value)} className="w-56" />
      <IconButton icon={RotateCcw} label="重新读取商品库" disabled={loading || busy} onClick={() => setReload((value) => value + 1)} />
      <Button variant="brand" size="sm" className="ml-auto" disabled={!detail || loading || busy} onClick={() => setEditing("new")}><Plus aria-hidden />新增商品</Button>
    </div>
    {loading ? <div className="grid min-h-48 place-items-center"><Spinner aria-label="正在读取获授权商品库" /></div>
      : error ? <div role="alert" className="p-4 text-destructive">{error}</div>
      : !sources.length ? <p role="status" className="p-4 text-muted-foreground">暂无有效的商品维护授权</p>
      : <div className="min-h-0 flex-1 overflow-auto"><Table aria-label="获授权商品"><TableHeader><TableRow><TableHead>商品</TableHead><TableHead>编号 / 规格</TableHead><TableHead>供货成本</TableHead><TableHead>平台价</TableHead><TableHead>发布检查</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
        <TableBody>{rows.map((row) => <TableRow key={row.productId} aria-busy={busy || undefined}>
          <TableCell>{row.title}</TableCell><TableCell>{row.platformCode}<span className="ml-2 text-muted-foreground">{row.size}</span></TableCell>
          <TableCell>{formatCnyCents(row.costCents)}</TableCell><TableCell>{formatCnyCents(row.platformPriceCents)}</TableCell>
          <TableCell>{row.published ? "已发布" : catalogMissing(row).join("、") || "就绪"}</TableCell>
          <TableCell><div className="flex flex-wrap justify-end gap-1"><IconButton icon={Pencil} label={`编辑 ${row.title}`} disabled={busy} onClick={() => setEditing(row)} />
            {canPublish ? <Button variant="outline" size="sm" disabled={busy || !row.published && catalogMissing(row).length > 0} onClick={() => void mutate(async () => { updateRow(await supplierCatalogHttp.publish(sourceId, row.productId, !row.published)); notifySuccess(row.published ? "已停用" : "已发布到商品库") })}>{row.published ? "停用" : "发布"}</Button> : null}
            <CatalogArchiveAction row={row} canPublish={canPublish} busy={busy} onArchive={() => setArchiving(row)} /></div></TableCell>
        </TableRow>)}{!rows.length ? <TableRow><TableCell colSpan={6} className="py-12 text-center text-muted-foreground">暂无匹配商品</TableCell></TableRow> : null}</TableBody></Table></div>}
    <ConfirmDialog open={archiving !== null} onOpenChange={(open) => { if (!open && !busy) setArchiving(null) }} title="归档商品" description={`归档“${archiving?.title ?? ""}”后，该规格不再展示。历史记录保留。`} confirmText="归档" busy={busy} onConfirm={() => void mutate(async () => { if (!archiving) return; await supplierCatalogHttp.archive(sourceId, archiving.productId); setArchiving(null); setReload((value) => value + 1) })} />
  </div>
}

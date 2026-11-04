import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ChevronRight, Cloud, Copy, Download, ExternalLink, FileImage, Folder, Home, RefreshCw, Search, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { copyToClipboard } from "@/lib/clipboard"
import { errorMessage } from "@/lib/error-message"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { WorkspaceStorageSetup } from "./workspace-storage-setup"
import { workspaceStorage, type SliceStorageInput, type WorkspaceStorage, type StorageObject, type StorageObjects, type StorageStats } from "./workspace-storage-api"

export function storageBytes(value: number): string {
  if (value === 0) return "0 B"
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)))
  return `${(value / 1024 ** unit).toLocaleString("zh-CN", { maximumFractionDigits: unit ? 1 : 0 })} ${["B", "KB", "MB", "GB", "TB"][unit]}`
}

export function storageFolderLabel(value: string): string {
  const batch = /^(\d{13,18})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(value)
  if (!batch) return value
  const date = new Date(Number(batch[1]))
  if (Number.isNaN(date.getTime())) return value
  const time = new Intl.DateTimeFormat("zh-CN", { timeZone: "UTC", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(date)
  return `${time} UTC · ${batch[2]!.slice(0, 8)}`
}

function modified(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { hour12: false })
}

function StorageThumbnail({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  return failed
    ? <span className="flex flex-col items-center gap-2 text-muted-foreground"><FileImage aria-hidden className="size-8" /><span className="text-xs">预览不可用</span></span>
    : <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="size-full object-contain" />
}

export function WorkspaceStoragePanel({ role = "owner" }: { role?: string }) {
  if (role !== "owner") {
    return <div role="status" className="flex flex-col gap-2 py-2">
      <p className="font-semibold">存储桶仅工作空间所有者可查看</p>
      <p className="text-sm text-muted-foreground">成员无需配置或管理 R2 存储桶。</p>
    </div>
  }
  return <WorkspaceStoragePanelOwner />
}

function WorkspaceStoragePanelOwner() {
  const [storage, setStorage] = useState<WorkspaceStorage | null>(null)
  const [error, setError] = useState("")
  const [loadError, setLoadError] = useState("")
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState(false)
  const [cleanupMode, setCleanupMode] = useState<"daily" | "manual">("daily")
  const [cleanupTime, setCleanupTime] = useState("04:00")
  const [prefix, setPrefix] = useState("")
  const [search, setSearch] = useState("")
  const [cursors, setCursors] = useState<string[]>([""])
  const [page, setPage] = useState<StorageObjects | null>(null)
  const [pageError, setPageError] = useState("")
  const [loading, setLoading] = useState(false)
  const [stats, setStats] = useState<StorageStats | null>(null)
  const [statsError, setStatsError] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<StorageObject | null>(null)
  const [previewFailed, setPreviewFailed] = useState(false)
  const [confirm, setConfirm] = useState<"selected" | "all" | { folder: string; prefix: string } | null>(null)
  const [deletedCount, setDeletedCount] = useState(0)
  const deleteController = useRef<AbortController | null>(null)
  useEffect(() => () => deleteController.current?.abort(), [])

  useEffect(() => {
    let ignore = false
    workspaceStorage.get().then((value) => { if (!ignore) { setStorage(value); setLoadError("") } }, (reason) => { if (!ignore) setLoadError(errorMessage(reason, "无法读取工作空间存储桶")) })
    return () => { ignore = true }
  }, [version])

  useEffect(() => {
    if (!storage?.configured) return
    setCleanupMode(storage.cleanup_mode ?? "daily")
    setCleanupTime(storage.cleanup_time ?? "04:00")
  }, [storage?.configured, storage?.cleanup_mode, storage?.cleanup_time])

  const cursor = cursors[cursors.length - 1] ?? ""
  useEffect(() => {
    if (!storage?.configured) return
    let ignore = false
    setLoading(true); setSelected(new Set()); setPage(null); setPageError("")
    workspaceStorage.list(prefix, cursor).then((value) => { if (!ignore) setPage(value) }, (reason) => { if (!ignore) setPageError(errorMessage(reason, "无法读取对象列表")) }).finally(() => { if (!ignore) setLoading(false) })
    return () => { ignore = true }
  }, [storage?.configured, prefix, cursor, version])

  useEffect(() => {
    if (!storage?.configured) return
    let ignore = false
    setStats(null); setStatsError("")
    workspaceStorage.stats().then((value) => { if (!ignore) setStats(value) }, (reason) => { if (!ignore) setStatsError(errorMessage(reason, "容量统计暂不可用")) })
    return () => { ignore = true }
  }, [storage?.configured, version])

  function navigate(value: string) { setPrefix(value); setSearch(value); setCursors([""]); setDetail(null) }
  async function create(input: SliceStorageInput) {
    setBusy(true); setError("")
    try { const value = await workspaceStorage.create(input); setStorage(value); notifySuccess("工作空间存储桶已验证并保存") } catch (reason) { setError(errorMessage(reason, "存储桶验证未通过")); setVersion((value) => value + 1) } finally { setBusy(false) }
  }
  async function saveCleanup() {
    setBusy(true); setError("")
    try {
      const value = await workspaceStorage.updateCleanup(cleanupMode, cleanupMode === "daily" ? cleanupTime : null)
      setStorage(value)
      notifySuccess("清理方式已保存")
    } catch (reason) { setError(errorMessage(reason, "无法保存清理方式")) } finally { setBusy(false) }
  }
  async function download(object: StorageObject) {
    try { const value = await workspaceStorage.download(object.key); window.location.assign(value.url) } catch (reason) { notifyCommandError(reason, "无法下载切片") }
  }
  async function remove() {
    const action = confirm
    if (!action) return
    const controller = new AbortController()
    deleteController.current = controller
    setBusy(true); setError(""); setDeletedCount(0)
    let deleted = 0
    try {
      if (action === "all") { await workspaceStorage.clear(); notifySuccess("已提交切片清理，完成前会等待上传链接过期") }
      else if (typeof action === "object") {
        while (!controller.signal.aborted) {
          const result = await workspaceStorage.removeFolder(action.prefix, controller.signal)
          if (controller.signal.aborted) break
          deleted += result.deleted
          setDeletedCount(deleted)
          if (result.failed_keys?.length) { setError(`已删除 ${deleted} 项，${result.failed_keys.length} 项未删除，文件夹尚未清空，可重试。`); break }
          if (!result.has_more) { notifySuccess(`已删除文件夹中的 ${deleted} 项切片`); break }
          if (!result.deleted) throw new Error("Folder deletion made no progress")
        }
      }
      else { const result = await workspaceStorage.remove([...selected]); if (result.failed_keys?.length) setError(`已删除 ${result.deleted} 项，${result.failed_keys.length} 项未删除，请刷新核对`); else notifySuccess(`已删除 ${result.deleted} 项`) }
    } catch (reason) {
      if (!controller.signal.aborted) setError(`${deleted ? `已确认删除 ${deleted} 项；` : ""}${errorMessage(reason, "删除未完成，请刷新核对")}`)
    } finally {
      deleteController.current = null
      if (!controller.signal.aborted) { setBusy(false); setConfirm(null); setSelected(new Set()); setDetail(null); setVersion((value) => value + 1) }
    }
  }

  if (!storage) return <div className="flex flex-wrap items-center gap-3 py-4" role={loadError ? "alert" : "status"}>{loadError || <><Spinner aria-hidden />正在读取工作空间存储桶</>}{loadError ? <Button variant="outline" onClick={() => setVersion((value) => value + 1)}>重试</Button> : null}</div>
  const clearing = storage.clear_status === "pending" || storage.clear_status === "retrying"
  const canDelete = storage.delete_enabled
  const cleanupChanged = cleanupMode !== storage.cleanup_mode || (cleanupMode === "daily" && cleanupTime !== storage.cleanup_time)
  const folderDelete = confirm && typeof confirm === "object" ? confirm : null
  const parts = prefix.split("/").filter(Boolean)
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 md:gap-4">
    {error || loadError ? <p role="alert" className="text-sm text-destructive">{error || loadError}</p> : null}
    {!storage.configured ? <WorkspaceStorageSetup busy={busy} create={(input) => void create(input)} /> : <>
      <div className="flex flex-wrap items-center gap-3 border-b border-border pb-4">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-border bg-muted/50"><Cloud aria-hidden className="size-6 text-muted-foreground" /></span><div className="min-w-0 flex-1 basis-48"><div className="flex flex-wrap items-center gap-2"><h3 className="break-all text-lg font-semibold">{storage.bucket}</h3><Badge variant="outline">工作空间共享</Badge></div><a href={storage.public_base_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex max-w-full items-center gap-1 break-all text-sm text-brand-ink hover:underline">{storage.public_base_url}<ExternalLink aria-hidden className="size-3.5 shrink-0" /><span className="sr-only">（在新窗口打开）</span></a></div>
        <IconButton icon={RefreshCw} label="刷新存储桶" variant="outline" onClick={() => setVersion((value) => value + 1)} disabled={busy} />
        <Button variant="outline" onClick={() => setConfirm("all")} disabled={busy || clearing || !canDelete}><Trash2 aria-hidden />{clearing ? "清理处理中" : "清理切片"}</Button>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm"><p className="tabular-nums"><span className="mr-2 text-muted-foreground">已用容量</span>{stats ? `${stats.complete ? "" : "至少 "}${storageBytes(stats.bytes)}` : statsError ? "统计不可用" : "统计中…"}</p><p className="tabular-nums"><span className="mr-2 text-muted-foreground">切片对象</span>{stats ? `${stats.complete ? "" : "至少 "}${stats.objects.toLocaleString()} 项` : "—"}</p></div>
      <form onSubmit={(event) => { event.preventDefault(); void saveCleanup() }} className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5"><Label htmlFor="slice-cleanup-mode">清理方式</Label><Select value={cleanupMode} onValueChange={(value) => { if (value === "daily" || value === "manual") setCleanupMode(value) }}><SelectTrigger id="slice-cleanup-mode" className="min-w-32" disabled={busy}><SelectValue>{(value) => value === "manual" ? "仅手动清理" : "每天自动清理"}</SelectValue></SelectTrigger><SelectContent><SelectItem value="daily">每天自动清理</SelectItem><SelectItem value="manual">仅手动清理</SelectItem></SelectContent></Select></div>
        {cleanupMode === "daily" ? <div className="grid gap-1.5"><Label htmlFor="slice-cleanup-time">清理时间（北京时间）</Label><Input id="slice-cleanup-time" type="time" value={cleanupTime} onChange={(event) => setCleanupTime(event.target.value)} disabled={busy} required className="w-40" /></div> : null}
        <Button type="submit" variant="outline" disabled={busy || !cleanupChanged || (cleanupMode === "daily" && !cleanupTime)}>保存清理方式</Button>
        <p className="basis-full text-sm text-muted-foreground">{cleanupMode === "daily" ? "仅清理平台抓图已确认超过 24 小时、且没有待处理任务引用的切片；新设置从下一个设定时间生效。" : "本应用不会自动清理；如已配置 Cloudflare 生命周期规则，仍会生效。"}</p>
      </form>
      {statsError ? <p role="status" className="text-sm text-muted-foreground">{statsError}</p> : null}
      {!canDelete ? <p role="status" className="text-sm text-muted-foreground">删除服务尚未启用，当前可浏览和下载。</p> : null}
      {clearing || (storage.cleanup_mode === "daily" && storage.daily_clear_status === "retrying") ? <p role="status" className="text-sm text-muted-foreground">{clearing ? "清理已排队或正在重试，完成前需等待上传链接过期。" : "本轮自动清理遇到问题，等待重试。"}</p> : storage.cleanup_mode === "daily" && storage.daily_clear_status === "unconfirmed" ? <p role="status" className="text-sm text-muted-foreground">本轮自动清理尚未确认</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="存储桶路径" className="flex min-w-0 flex-wrap items-center gap-1 text-sm">
          {parts.length ? <IconButton icon={ArrowLeft} label="返回上一级" onClick={() => navigate(parts.slice(0, -1).join("/") + (parts.length > 1 ? "/" : ""))} /> : null}
          <Button variant="ghost" size="sm" aria-current={!parts.length ? "page" : undefined} onClick={() => navigate("")}><Home aria-hidden />全部切片</Button>
          {parts.map((part, index) => <span key={index} className="flex min-w-0 items-center gap-1"><ChevronRight aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /><Button variant="ghost" size="sm" title={part} aria-current={index === parts.length - 1 ? "page" : undefined} className="h-auto min-h-9 min-w-0 max-w-52 whitespace-normal break-all text-left" onClick={() => navigate(parts.slice(0, index + 1).join("/") + "/")}>{storageFolderLabel(part)}</Button></span>)}
        </nav>
        <form onSubmit={(event) => { event.preventDefault(); navigate(search) }} className="flex min-w-0 flex-1 basis-64 items-center gap-2 sm:max-w-sm"><Input aria-label="按路径前缀搜索" placeholder="按路径前缀搜索" value={search} maxLength={512} onChange={(event) => setSearch(event.target.value)} className="min-w-0 flex-1" /><IconButton icon={Search} label="搜索路径" type="submit" variant="outline" /></form>
      </div>
      <div className="@container flex min-h-48 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-muted/15" aria-busy={loading}>
        {!!page?.objects.length ? <div className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
          <label className="flex min-h-9 items-center gap-3 text-sm text-muted-foreground"><Checkbox aria-label="选择本页全部对象" checked={page.objects.every((object) => selected.has(object.key))} indeterminate={selected.size > 0 && selected.size < page.objects.length} onCheckedChange={(checked) => setSelected(new Set(checked ? page.objects.map((object) => object.key) : []))} disabled={!canDelete || busy || loading} />{selected.size ? `已选 ${selected.size} 项` : "选择本页切片"}</label>
          {selected.size ? <Button type="button" variant="outline" disabled={busy || !canDelete} onClick={() => setConfirm("selected")}><Trash2 aria-hidden />删除已选 {selected.size} 项</Button> : null}
        </div> : null}
        <div role="region" aria-label="切片文件浏览区" tabIndex={0} className="min-h-0 flex-1 overflow-y-auto overscroll-contain focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        {loading || pageError ? <div role={pageError ? "alert" : "status"} className="flex min-h-full flex-wrap items-center justify-center gap-3 p-6 text-sm text-muted-foreground">{loading ? <Spinner aria-hidden /> : null}{pageError || "正在读取对象"}{pageError ? <Button variant="outline" onClick={() => setVersion((value) => value + 1)}>重试</Button> : null}</div> : <>
          <ul aria-label="文件夹和切片" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,7rem),1fr))] content-start items-start gap-3 p-3 empty:hidden @sm:grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]">
            {page?.folders.map((folder) => <li key={folder} className="group relative min-w-0 rounded-xl border border-transparent transition-colors hover:border-border hover:bg-card focus-within:border-ring">
              <Button variant="ghost" className="h-auto w-full min-w-0 flex-col gap-2 rounded-xl p-3 pt-10 text-foreground whitespace-normal hover:bg-transparent active:translate-y-0 @sm:pt-3" title={folder} onClick={() => navigate(folder)}>
                <span className="flex aspect-[4/3] w-full items-center justify-center"><Folder aria-hidden className="size-16 fill-muted text-muted-foreground @sm:size-20" strokeWidth={1.25} /></span>
                <span className="line-clamp-2 min-h-10 w-full break-all text-center leading-5">{storageFolderLabel(folder.slice(prefix.length).replace(/\/$/, ""))}</span>
              </Button>
              <IconButton icon={Trash2} label={`删除文件夹 ${folder}`} tip="删除文件夹" variant="ghost" className="absolute top-1 right-1 size-11 hover:text-destructive" disabled={busy || !canDelete || !storage.key_prefix} disabledReason={!canDelete ? "删除服务尚未启用" : undefined} onClick={() => setConfirm({ folder, prefix: `${storage.key_prefix}uploads/${folder}` })} />
            </li>)}
            {page?.objects.map((object) => <li key={object.key} className={`relative min-w-0 rounded-xl border transition-colors focus-within:border-ring ${selected.has(object.key) ? "border-brand bg-brand-soft" : "border-transparent hover:border-border hover:bg-card"}`}>
              <label className="absolute top-1 left-1 z-10 flex size-11 cursor-pointer items-center justify-center"><Checkbox aria-label={`选择 ${object.key}`} className="bg-card" disabled={!canDelete || busy} checked={selected.has(object.key)} onCheckedChange={(checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(object.key); else next.delete(object.key); return next })} /></label>
              <Button variant="ghost" aria-label={`查看 ${object.key.split("/").at(-1)}`} className="h-auto w-full min-w-0 flex-col gap-3 rounded-xl p-2 pb-0 text-foreground whitespace-normal hover:bg-transparent active:translate-y-0" title={object.key} onClick={() => { setPreviewFailed(false); setDetail(object) }}>
                <span className="flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-lg border border-border/70 bg-muted/50"><StorageThumbnail src={`${storage.public_base_url}/${object.key.split("/").map(encodeURIComponent).join("/")}`} /></span>
                <span className="line-clamp-2 min-h-10 w-full break-all px-1 text-left leading-5">{object.key.split("/").at(-1)}</span>
              </Button>
              <div className="flex items-center justify-between gap-1 px-3 pb-1"><span className="text-xs text-muted-foreground tabular-nums" title={modified(object.last_modified)}>{storageBytes(object.size)}</span><IconButton icon={Download} label={`下载 ${object.key.split("/").at(-1)}`} tip="下载切片" variant="ghost" className="size-11 shrink-0" onClick={() => void download(object)} /></div>
            </li>)}
          </ul>
          {page && !page.objects.length && !page.folders.length ? <div className="flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-muted-foreground"><Folder aria-hidden className="size-12 fill-muted" strokeWidth={1.25} /><p className="text-foreground">{prefix ? "此路径下没有对象" : "存储桶内还没有切片"}</p><p>{prefix ? "可返回全部切片，或更换路径前缀。" : "成员在工作台生成并上传的切片会显示在这里。"}</p>{prefix ? <Button variant="outline" size="sm" onClick={() => navigate("")}>返回全部切片</Button> : null}</div> : null}
        </>}
        </div>
        <div role="group" aria-label="切片分页" className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2 text-sm text-muted-foreground"><span>本页 {page ? page.objects.length + page.folders.length : "—"} 项{selected.size ? ` · 已选 ${selected.size} 项` : ""}</span><div className="flex gap-2"><Button variant="outline" size="sm" disabled={cursors.length <= 1 || loading} onClick={() => setCursors((value) => value.slice(0, -1))}>上一页</Button><Button variant="outline" size="sm" disabled={!page?.next_cursor || loading} onClick={() => setCursors((value) => [...value, page!.next_cursor])}>下一页</Button></div></div>
      </div>
    </>}
    <ConfirmDialog open={confirm !== null} onOpenChange={(open) => { if (!open) setConfirm(null) }} title={folderDelete ? "删除此文件夹？" : confirm === "all" ? "清理此空间的全部切片？" : `删除已选 ${selected.size} 项切片？`} description={folderDelete ? "将递归删除该文件夹及所有子文件夹中的切片。图片链接会失效，电商平台尚未取走的图片可能受影响，此操作无法恢复。" : "删除后图片链接失效，电商平台尚未取走的图片可能受影响。此操作无法恢复。"} confirmText={folderDelete ? "删除文件夹" : confirm === "all" ? "提交清理" : "删除切片"} busy={busy} onConfirm={() => void remove()}>
      {folderDelete ? <p className="break-all text-sm">{folderDelete.folder}</p> : null}
      {folderDelete && busy ? <p role="status" aria-live="polite" className="text-sm text-muted-foreground">已删除 {deletedCount.toLocaleString()} 项，正在分批处理…</p> : null}
    </ConfirmDialog>
    <Sheet open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}><SheetContent size="detail"><SheetHeader><SheetTitle>对象详情</SheetTitle></SheetHeader>{detail ? <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5"><div className="flex min-h-40 items-center justify-center rounded-lg border border-border bg-muted/30">{previewFailed ? <p role="status" className="p-4 text-sm text-muted-foreground">预览暂不可用，可下载查看</p> : <img src={`${storage.public_base_url}/${detail.key.split("/").map(encodeURIComponent).join("/")}`} alt="切片预览" onError={() => setPreviewFailed(true)} className="max-h-80 max-w-full object-contain" />}</div><dl className="grid gap-4 text-sm"><div><dt className="text-muted-foreground">对象路径</dt><dd className="mt-1 break-all">{detail.key}</dd></div><div><dt className="text-muted-foreground">大小</dt><dd className="mt-1 tabular-nums">{storageBytes(detail.size)}</dd></div><div><dt className="text-muted-foreground">修改时间</dt><dd className="mt-1">{modified(detail.last_modified)}</dd></div><div><dt className="text-muted-foreground">ETag</dt><dd className="mt-1 break-all font-mono">{detail.etag}</dd></div></dl><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void copyToClipboard(detail.key, { success: "已复制路径", failure: "无法复制，请手动选择路径" })}><Copy aria-hidden />复制路径</Button><Button variant="brand" onClick={() => void download(detail)}><Download aria-hidden />下载切片</Button></div></div> : null}</SheetContent></Sheet>
  </div>
}

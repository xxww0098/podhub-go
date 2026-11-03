import { Fragment, useCallback, useEffect, useState } from "react"
import { Ban, ChevronDown, ChevronLeft, ChevronRight, Copy, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"

import { api } from "@/api/client"
import { route } from "@/api/routes"
import { PlatformAdminEmpty, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableExpandedRow, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { notifyCommandError, notifySuccess } from "@/lib/notify"

type BannedTag = {
  id: number
  term: string
  matchMode: string
  note: string
  createdBy: string
  createdAt: string
  enabled: boolean
}

type MatchMode = "exact" | "stem"

const MATCH_MODES: readonly { value: MatchMode; label: string }[] = [
  { value: "stem", label: "词干匹配" },
  { value: "exact", label: "精确匹配" },
]

/**
 * Super-admin list of platform banned product tags. The table is global;
 * a save here is visible to other API processes within one second.
 */
export function PlatformBannedTagsScreen() {
  const [tags, setTags] = useState<BannedTag[]>()
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [term, setTerm] = useState("")
  const [note, setNote] = useState("")
  const [mode, setMode] = useState<MatchMode>("stem")
  const [enabled, setEnabled] = useState(true)
  const [invalid, setInvalid] = useState(false)
  const [editing, setEditing] = useState<BannedTag>()
  const [deleting, setDeleting] = useState<BannedTag>()
  const [page, setPage] = useState(0)
  const [pageSize, setPageSize] = useState(10)
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<"all" | "enabled" | "disabled">("all")
  const [selected, setSelected] = useState<Set<number>>(() => new Set())
  const [expandedNote, setExpandedNote] = useState<number>()

  const query = search.trim().toLocaleLowerCase()
  const filteredTags = tags?.filter((tag) =>
    (status === "all" || tag.enabled === (status === "enabled")) &&
    (!query || `${tag.term} ${tag.note}`.toLocaleLowerCase().includes(query)),
  )
  const pageCount = Math.max(1, Math.ceil((filteredTags?.length ?? 0) / pageSize))
  const currentPage = Math.min(page, pageCount - 1)
  const visibleTags = filteredTags?.slice(currentPage * pageSize, (currentPage + 1) * pageSize) ?? []
  const selectedTags = visibleTags.filter((tag) => selected.has(tag.id))
  const allSelected = visibleTags.length > 0 && selectedTags.length === visibleTags.length
  const formDisabled = busy || tags === undefined

  function changePage(next: number) {
    setPage(next)
    setSelected(new Set())
    setExpandedNote(undefined)
  }

  async function copySelected() {
    try {
      await navigator.clipboard.writeText(selectedTags.map((tag) => tag.term).join("\n"))
      notifySuccess("已复制所选受限词")
    } catch (reason) {
      notifyCommandError(reason, "无法复制所选受限词。")
    }
  }

  const load = useCallback(async () => {
    setFailed(false)
    try {
      const data = await api.get<{ tags: BannedTag[] }>(route("adminBannedTags"))
      setTags(data.tags)
      setSelected(new Set())
    } catch (reason) {
      setTags(undefined)
      setFailed(true)
      notifyCommandError(reason, "无法读取全局受限标签。")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  function resetEditor() {
    setEditing(undefined)
    setTerm("")
    setNote("")
    setMode("stem")
    setEnabled(true)
    setInvalid(false)
  }

  function editTag(tag: BannedTag) {
    if (tag.matchMode !== "stem" && tag.matchMode !== "exact") return
    setEditing(tag)
    setTerm(tag.term)
    setNote(tag.note)
    setMode(tag.matchMode)
    setEnabled(tag.enabled)
    setInvalid(false)
  }

  async function saveTag() {
    const next = term.trim()
    if (formDisabled) return
    if (!next) {
      setInvalid(true)
      return
    }
    setBusy(true)
    setInvalid(false)
    try {
      const fields = {
        term: next,
        matchMode: mode,
        note: note.trim(),
        enabled,
      }
      const data = editing
        ? await api.put<{ tags: BannedTag[] }>(route("adminBannedTagsById", { id: editing.id }), fields)
        : await api.post<{ tags: BannedTag[] }>(route("adminBannedTags"), fields)
      setTags(data.tags)
      setSelected(new Set())
      notifySuccess(editing ? "已更新受限词" : "已添加受限词")
      if (editing) resetEditor()
      else { setTerm(""); setNote("") }
    } catch (reason) {
      notifyCommandError(reason, "受限词没有保存。")
    } finally {
      setBusy(false)
    }
  }

  async function updateTag(tag: BannedTag, patch: Partial<Pick<BannedTag, "enabled">>) {
    if (busy) return
    setBusy(true)
    try {
      const data = await api.put<{ tags: BannedTag[] }>(route("adminBannedTagsById", { id: tag.id }), {
        term: tag.term,
        matchMode: tag.matchMode,
        note: tag.note,
        enabled: patch.enabled ?? tag.enabled,
      })
      setTags(data.tags)
      setSelected(new Set())
      notifySuccess(patch.enabled === false ? "已停用" : "已更新")
    } catch (reason) {
      notifyCommandError(reason, "受限词没有更新。")
    } finally {
      setBusy(false)
    }
  }

  async function removeTag(tag: BannedTag) {
    if (busy) return
    setBusy(true)
    try {
      const data = await api.del<{ tags: BannedTag[] }>(route("adminBannedTagsById", { id: tag.id }))
      setTags(data.tags)
      setSelected(new Set())
      setDeleting(undefined)
      notifySuccess("已删除受限词")
    } catch (reason) {
      notifyCommandError(reason, "受限词没有删除。")
    } finally {
      setBusy(false)
    }
  }

  return (
    <PlatformAdminSurface bodyClassName="flex flex-col gap-3 border-t-0">
      <form className="grid min-w-0 shrink-0 grid-cols-2 gap-2 px-1 pb-1 lg:grid-cols-[minmax(0,1.2fr)_minmax(8rem,.8fr)_minmax(0,1.4fr)_4.5rem_auto] lg:items-end" onSubmit={(event) => { event.preventDefault(); void saveTag() }}>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="banned-tag-term">受限词 <span aria-hidden className="text-destructive">*</span></Label>
          <Input
            id="banned-tag-term"
            className="h-9 max-md:min-h-11"
            aria-required="true"
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? "banned-tag-term-error" : undefined}
            placeholder="请输入受限词"
            value={term}
            disabled={formDisabled}
            onChange={(event) => {
              setTerm(event.target.value)
              setInvalid(false)
            }}
          />
        </div>
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="banned-tag-mode">匹配方式</Label>
          <Select items={{ stem: "词干匹配", exact: "精确匹配" }} value={mode} disabled={formDisabled} onValueChange={(value) => { if (value === "stem" || value === "exact") setMode(value) }}>
            <SelectTrigger id="banned-tag-mode" className="h-9 w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{MATCH_MODES.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="col-span-2 grid min-w-0 gap-1.5 lg:col-span-1">
          <Label htmlFor="banned-tag-note">备注</Label>
          <Input
            id="banned-tag-note"
            className="h-9 max-md:min-h-11"
            placeholder="请输入备注（可选）"
            value={note}
            disabled={formDisabled}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="banned-tag-enabled">启用</Label>
          <div className="flex h-9 items-center max-md:h-11">
            <Switch
              id="banned-tag-enabled"
              className="max-md:after:-inset-y-3.5"
              checked={enabled}
              disabled={formDisabled}
              onCheckedChange={(checked) => setEnabled(checked === true)}
              aria-label={editing ? "编辑时启用" : "新建时启用"}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 self-end">
          <Button type="submit" variant="brand" size="sm" disabled={formDisabled}>
            {busy ? <Spinner data-icon="inline-start" /> : <Plus data-icon="inline-start" />}
            {editing ? "保存修改" : "添加"}
          </Button>
          {editing ? <Button type="button" variant="outline" size="sm" disabled={busy} onClick={resetEditor}>取消编辑</Button> : null}
        </div>
        {invalid ? <span id="banned-tag-term-error" className="col-start-1 row-start-2 text-compact text-destructive">请输入受限词</span> : null}
      </form>

      <div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
        <Input aria-label="搜索受限词" placeholder="搜索词语或备注" className="w-full sm:max-w-xs" value={search} onChange={(event) => { setSearch(event.target.value); changePage(0) }} />
        <Select items={{ all: "全部状态", enabled: "已启用", disabled: "已禁用" }} value={status} onValueChange={(value) => { if (value === "all" || value === "enabled" || value === "disabled") { setStatus(value); changePage(0) } }}>
          <SelectTrigger aria-label="筛选状态" className="w-32"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="enabled">已启用</SelectItem><SelectItem value="disabled">已禁用</SelectItem></SelectContent>
        </Select>
        <Button type="button" variant="outline" size="sm" disabled={selectedTags.length === 0} onClick={() => void copySelected()}><Copy data-icon="inline-start" />复制所选{selectedTags.length > 0 ? `（${selectedTags.length}）` : ""}</Button>
      </div>

      <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto rounded-xl border border-border bg-card">
        {tags === undefined && !failed ? (
          <PlatformAdminEmpty className="flex-1" icon={Ban} busy title="正在读取全局受限标签" />
        ) : null}
        {failed ? (
          <PlatformAdminEmpty
            className="flex-1"
            icon={Ban}
            title="无法读取全局受限标签"
            action={<IconButton icon={RefreshCw} label="重试" variant="outline" onClick={() => void load()} />}
          />
        ) : null}
        {tags ? (
          <>
            <Table aria-label="全局受限标签" className="min-w-[46rem] table-fixed" containerClassName="shrink-0 overflow-visible">
              <colgroup><col className="w-11" /><col className="w-56" /><col className="w-28" /><col /><col className="w-24" /><col className="w-24" /></colgroup>
              <TableHeader className="sticky top-0 z-10 bg-muted"><TableRow><TableHead><Checkbox aria-label="选择本页全部受限词" checked={allSelected} indeterminate={selectedTags.length > 0 && !allSelected} disabled={busy || visibleTags.length === 0} onCheckedChange={(checked) => setSelected(checked ? new Set(visibleTags.map((tag) => tag.id)) : new Set())} /></TableHead><TableHead>受限词</TableHead><TableHead>匹配方式</TableHead><TableHead>备注</TableHead><TableHead className="text-center">状态</TableHead><TableHead className="text-right">操作</TableHead></TableRow></TableHeader>
              <TableBody>{visibleTags.map((tag) => (
                <Fragment key={tag.id}>
                <TableRow data-state={selected.has(tag.id) ? "selected" : undefined} className="[&>td]:py-1.5">
                  <TableCell><Checkbox aria-label={`选择 ${tag.term}`} checked={selected.has(tag.id)} disabled={busy} onCheckedChange={(checked) => setSelected((previous) => { const next = new Set(previous); if (checked) next.add(tag.id); else next.delete(tag.id); return next })} /></TableCell>
                  <TableCell className="break-words font-medium">{tag.term}</TableCell>
                  <TableCell className="text-compact text-muted-foreground">{MATCH_MODES.find((option) => option.value === tag.matchMode)?.label ?? tag.matchMode}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {tag.note ? <Button type="button" variant="ghost" size="sm" className="w-full min-w-0 justify-start gap-2 px-1 text-left font-normal" aria-label={`${expandedNote === tag.id ? "收起" : "展开"} ${tag.term} 的备注`} aria-expanded={expandedNote === tag.id} aria-controls={expandedNote === tag.id ? `banned-tag-note-${tag.id}` : undefined} onClick={() => setExpandedNote(expandedNote === tag.id ? undefined : tag.id)}>
                      <span className="min-w-0 flex-1 truncate">{tag.note}</span>
                      <ChevronDown aria-hidden className={`transition-transform motion-reduce:transition-none ${expandedNote === tag.id ? "rotate-180" : ""}`} />
                    </Button> : "—"}
                  </TableCell>
                  <TableCell className="text-center whitespace-nowrap"><Button type="button" variant="ghost" size="xs" role="switch" aria-checked={tag.enabled} aria-label={`${tag.term} 启用`} title={tag.enabled ? "点击停用" : "点击启用"} disabled={busy || Boolean(editing)} onClick={() => void updateTag(tag, { enabled: !tag.enabled })}><StateChip status={tag.enabled ? "启用" : "禁用"} tone={tag.enabled ? "good" : "idle"} /></Button></TableCell>
                  <TableCell><div className="flex justify-end gap-1">
                    <IconButton icon={Pencil} label={`编辑 ${tag.term}`} tip="编辑" size="icon-sm" disabled={busy || Boolean(editing) || !MATCH_MODES.some((option) => option.value === tag.matchMode)} onClick={() => editTag(tag)} />
                    <IconButton icon={Trash2} label={`删除 ${tag.term}`} tip="删除" size="icon-sm" className="hover:bg-destructive/10 hover:text-destructive" disabled={busy || Boolean(editing)} onClick={() => setDeleting(tag)} />
                  </div></TableCell>
                </TableRow>
                {expandedNote === tag.id && tag.note ? <TableExpandedRow id={`banned-tag-note-${tag.id}`} colSpan={6}>
                  <p className="max-w-prose whitespace-pre-wrap break-words px-3 py-3 text-compact leading-relaxed">{tag.note}</p>
                </TableExpandedRow> : null}
                </Fragment>
              ))}</TableBody>
            </Table>
            {tags.length === 0 ? <PlatformAdminEmpty className="flex-1" icon={Ban} title="暂无受限词" description="添加后，保存标签和推送 Ozon 前都会拦截。" /> : null}
            {tags.length > 0 && filteredTags?.length === 0 ? <PlatformAdminEmpty className="flex-1" icon={Ban} title="没有匹配的受限词" /> : null}
          </>
        ) : null}
      </section>
      {tags ? <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 px-1 text-compact text-muted-foreground">
        <div className="flex items-center gap-2">
          <span>共 {filteredTags?.length ?? 0} 条{(search || status !== "all") ? `（全部 ${tags.length} 条）` : ""}，每页</span>
          <Select items={{ "10": "10 条", "20": "20 条", "50": "50 条" }} value={String(pageSize)} onValueChange={(value) => { if (value) { setPageSize(Number(value)); changePage(0) } }}>
            <SelectTrigger aria-label="每页条数"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="10">10 条</SelectItem><SelectItem value="20">20 条</SelectItem><SelectItem value="50">50 条</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <IconButton icon={ChevronLeft} label="上一页" variant="outline" disabled={currentPage === 0} onClick={() => changePage(currentPage - 1)} />
          <span aria-live="polite" aria-label={`第 ${currentPage + 1} 页，共 ${pageCount} 页`} className="grid size-9 place-items-center rounded-lg bg-brand text-brand-foreground">{currentPage + 1}</span>
          <IconButton icon={ChevronRight} label="下一页" variant="outline" disabled={currentPage + 1 >= pageCount} onClick={() => changePage(currentPage + 1)} />
        </div>
      </div> : null}
      <ConfirmDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open) setDeleting(undefined) }} title="删除受限词？" description={`删除后「${deleting?.term ?? ""}」将不再被这条规则拦截。`} confirmText="删除" busy={busy} onConfirm={() => { if (deleting) void removeTag(deleting) }} />
    </PlatformAdminSurface>
  )
}

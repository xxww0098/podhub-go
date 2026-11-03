import { useEffect, useState, type Dispatch, type SetStateAction } from "react"
import { Activity, ChevronLeft, ChevronRight, FilterX, KeyRound, LoaderCircle, PackageOpen, Pencil, Plus, Power, PowerOff, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react"
import type { AiAccountView, AiPurpose, IntegrationCredentialsOverview } from "@/bindings/commands"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import type { AiAccountDraft } from "@/bindings/integration-ai-writes"
import { PlatformAdminEmpty, PlatformAdminSearch } from "@/components/platform-admin-surface"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { StateChip } from "@/components/state-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { IMAGE_MODEL, accountModelLine, connectionProbe } from "./ai-account-model"
import { AiConnectionChip, type AiConnectionState } from "./ai-account-status"
import { AiAccountEditor } from "./ai-account-editor"

/** Cloud stores at most this many AI accounts across all pools. */
const ACCOUNT_LIMIT = 64
const purposeLabels: Record<AiPurpose, string> = { ocr: "识图", image: "生图", chat: "对话" }
const formatLabels = { anthropic_messages: "Anthropic 消息", responses: "Responses" } as const

/**
 * One pool of AI accounts: the table, filter, paging and the editor dialog for
 * the accounts of a single purpose. The tab fixes the purpose; a new account
 * joins this pool and an edited one keeps the purpose it was stored with.
 */
export function AiAccountPool({ purpose, overview, loading, busy, readOnly = false, connections, defaultModel, onBusy, onOverview, onConnections, onReload }: {
  purpose: AiPurpose
  overview: IntegrationCredentialsOverview
  loading: boolean
  busy: boolean
  readOnly?: boolean
  connections: Record<string, AiConnectionState>
  /** The OCR default model; image accounts have none. */
  defaultModel?: string
  onBusy: (busy: boolean) => void
  onOverview: (overview: IntegrationCredentialsOverview) => void
  onConnections: Dispatch<SetStateAction<Record<string, AiConnectionState>>>
  onReload: () => void
}) {
  const noun = purposeLabels[purpose]
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState("10")
  const [editing, setEditing] = useState<AiAccountView | "new">()
  const [deleting, setDeleting] = useState<AiAccountView>()
  const [testingId, setTestingId] = useState<string>()
  const locked = busy || loading || readOnly

  async function save(draft: AiAccountDraft) {
    if (locked) return
    onBusy(true)
    try {
      onOverview(await aiAccountsHttp.upsert(draft))
      const savedId = draft.id
      if (savedId) onConnections((current) => {
        const next = { ...current }
        delete next[savedId]
        return next
      })
      setEditing(undefined)
      notifySuccess("AI 账号已保存")
    } catch (reason) { notifyCommandError(reason, "保存失败，请检查配置或刷新后重试。") }
    finally { onBusy(false) }
  }
  async function toggle(account: AiAccountView) {
    if (locked) return
    onBusy(true)
    try { onOverview(await aiAccountsHttp.setActive(account.id, !account.active)); notifySuccess(account.active ? "账号已停用" : "账号已启用") }
    catch (reason) { notifyCommandError(reason, "账号状态修改失败，请刷新后重试。") }
    finally { onBusy(false) }
  }
  async function test(account: AiAccountView) {
    if (locked || testingId) return
    const probe = connectionProbe({
      accountId: account.id,
      stored: account,
      baseUrl: account.base_url,
      apiKey: "",
      apiFormat: account.api_format,
      model: account.model,
    })
    if (probe.status === "blocked") {
      notifyError(probe.reason)
      return
    }
    setTestingId(account.id)
    onBusy(true)
    try {
      const result = await aiAccountsHttp.verifyModel(probe.request)
      const state: AiConnectionState = result.model_present ? "ok" : "missing"
      onConnections((current) => ({ ...current, [account.id]: state }))
      if (result.model_present) notifySuccess(`「${account.label}」连接正常`, { description: `${result.latency_ms} ms。未发起${noun}请求。` })
      else notifyInfo(`「${account.label}」密钥有效，但目录未列出该模型`)
    } catch (reason) {
      onConnections((current) => ({ ...current, [account.id]: "failed" }))
      notifyCommandError(reason, "连接测试失败，请检查密钥、服务地址和网络。")
    } finally {
      setTestingId(undefined)
      onBusy(false)
    }
  }
  async function remove() {
    if (!deleting || locked) return
    onBusy(true)
    try { onOverview(await aiAccountsHttp.delete(deleting.id)); setDeleting(undefined); notifySuccess("AI 账号已删除") }
    catch (reason) { notifyCommandError(reason, "删除失败，请刷新后重试。") }
    finally { onBusy(false) }
  }

  const total = overview.ai_accounts.length
  const accounts = overview.ai_accounts.filter((account) => account.purpose === purpose)
  const unknownCount = overview.ai_accounts.filter((account) => account.purpose === null).length
  const needle = query.trim().toLocaleLowerCase()
  const visible = accounts.filter((account) =>
    (filter === "all" || (filter === "active" ? account.active : !account.active)) &&
    [account.label, account.model, account.base_url].some((value) => value.toLocaleLowerCase().includes(needle)),
  ).sort((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority || a.id.localeCompare(b.id))
  // The image generator serves one model; two enabled accounts for it are refused at request time.
  const imageAmbiguous = purpose === "image" && accounts.filter((account) => account.active && account.model === IMAGE_MODEL).length > 1
  const pageCount = Math.max(1, Math.ceil(visible.length / Number(pageSize)))
  const currentPage = Math.min(page, pageCount)
  const pageAccounts = visible.slice((currentPage - 1) * Number(pageSize), currentPage * Number(pageSize))
  useEffect(() => { setPage((current) => Math.min(current, pageCount)) }, [pageCount])

  return (
    <>
      <section className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex flex-wrap items-center gap-2 p-3">
          <PlatformAdminSearch label="搜索账号" placeholder="搜索账号名称、服务地址或模型" value={query} onChange={(value) => { setQuery(value); setPage(1) }} className="h-11 min-w-0 basis-full sm:basis-56 sm:max-w-none" />
          <div className="flex items-center gap-2">
            <FieldLabel htmlFor={`ai-account-status-${purpose}`} className="sr-only">账号状态</FieldLabel>
            <Select items={{ all: "全部账号", active: "已启用", inactive: "已停用" }} value={filter} onValueChange={(value) => { if (value) { setFilter(value); setPage(1) } }}>
              <SelectTrigger id={`ai-account-status-${purpose}`} className="h-11"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">全部账号</SelectItem><SelectItem value="active">已启用</SelectItem><SelectItem value="inactive">已停用</SelectItem></SelectContent>
            </Select>
          </div>
          <span className="text-meta tabular-nums text-muted-foreground">{unknownCount ? `${accounts.length} 个已确认账号 · ${unknownCount} 个用途未确认` : `${accounts.length} 个账号 · ${accounts.filter((row) => row.active).length} 个已启用`}{total >= ACCOUNT_LIMIT ? ` · 总数已达 ${ACCOUNT_LIMIT} 上限` : ""}</span>
          <IconButton icon={RefreshCw} label="刷新" size="icon-lg" variant="outline" className="ml-auto" disabled={busy || loading} onClick={onReload} />
          <Button type="button" variant="brand" size="lg" aria-label="新增账号" disabled={locked || total >= ACCOUNT_LIMIT} onClick={() => setEditing("new")}><Plus data-icon="inline-start" />新增账号</Button>
        </div>
        {imageAmbiguous ? <p role="status" className="border-t border-border px-3 py-2 text-meta text-muted-foreground">已启用多个 {IMAGE_MODEL} 账号，生图请求会被拒绝。请只保留一个。</p> : null}
        <div className="max-h-[min(60vh,32rem)] overflow-auto border-t border-border">
          <Table aria-label={purpose === "ocr" ? "AI识图服务账号" : `${noun}服务账号`} className={visible.length > 0 ? "min-w-[48rem]" : undefined} containerClassName="shrink-0 overflow-visible">
            <TableHeader className="sticky top-0 z-10 bg-card"><TableRow><TableHead>账号名称</TableHead><TableHead>服务地址</TableHead><TableHead>模型</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
            <TableBody>
              {pageAccounts.map((account) => {
                const line = accountModelLine(account)
                return <TableRow key={account.id}>
                  <TableCell className="min-w-36">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="break-words text-compact font-medium">{account.label}</span>
                      {purpose === "ocr" && account.model === defaultModel ? <Badge variant="brand">默认识图</Badge> : null}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64 break-all text-meta text-muted-foreground">{account.base_url}</TableCell>
                  <TableCell className="min-w-36">
                    <div className="flex flex-col gap-1">
                      <span className="break-words text-compact">{line.model}</span>
                      {line.model !== account.model ? <span className="break-all text-meta text-muted-foreground">{account.model}</span> : null}
                      {purpose === "ocr" && account.api_format !== "chat_completions" ? <span className="text-meta text-muted-foreground">不能用于识图</span> : null}
                      {purpose === "chat" && account.api_format !== "chat_completions" ? <span className="text-meta text-muted-foreground">{formatLabels[account.api_format]}</span> : null}
                      {purpose === "image" && account.model !== IMAGE_MODEL ? <span className="text-meta text-muted-foreground">生图只使用 {IMAGE_MODEL}</span> : null}
                    </div>
                  </TableCell>
                  <TableCell><div className="flex flex-wrap items-center gap-1.5">
                    <StateChip status={account.active ? "present" : "idle"} label={account.active ? "已启用" : "已停用"} />
                    {!account.configured ? <StateChip status="idle" label="待填写密钥" /> : null}
                    <AiConnectionChip state={connections[account.id] ?? "idle"} />
                  </div></TableCell>
                  <TableCell><div className="flex flex-wrap items-center gap-2">
                    <IconButton icon={testingId === account.id ? LoaderCircle : Activity} size="icon-sm" variant="outline" disabled={locked} aria-busy={testingId === account.id} label={`${testingId === account.id ? "测试中" : "测试连接"} ${account.label}`} tip={testingId === account.id ? "测试中…" : "测试连接"} tooltipSide="top" onClick={() => void test(account)} />
                    <IconButton icon={account.active ? PowerOff : Power} size="icon-sm" variant="outline" disabled={locked} label={`${account.active ? "停用" : "启用"} ${account.label}`} tip={account.active ? "停用" : "启用"} tooltipSide="top" onClick={() => void toggle(account)} />
                    <IconButton icon={Pencil} size="icon-sm" variant="outline" disabled={locked} label={`编辑 ${account.label}`} tip="编辑" tooltipSide="top" onClick={() => setEditing(account)} />
                    <IconButton icon={Trash2} size="icon-sm" variant="ghost" disabled={locked} label={`删除 ${account.label}`} tip="删除" tooltipSide="top" onClick={() => setDeleting(account)} />
                  </div></TableCell>
                </TableRow>
              })}
            </TableBody>
          </Table>
          {accounts.length === 0 ? <PlatformAdminEmpty className="min-h-56" icon={PackageOpen} title={unknownCount ? "账号分类未确认" : "还没有 AI 账号"} description={unknownCount ? "请更新服务并刷新后查看账号分类。" : "点击右上角加号开始配置 AI 账号。"} /> :
            visible.length === 0 ? <PlatformAdminEmpty className="min-h-56" icon={Search} title="没有匹配的账号" description="尝试其他关键词，或查看全部账号。" action={<IconButton icon={FilterX} label="清除筛选" variant="outline" onClick={() => { setQuery(""); setFilter("all"); setPage(1) }} />} /> : null}
        </div>
      </section>
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>共 {visible.length} 条，每页</span>
          <Select value={pageSize} onValueChange={(value) => { if (value) { setPageSize(value); setPage(1) } }}>
            <SelectTrigger aria-label="每页账号数"><SelectValue>{(value) => `${value} 条`}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="10">10 条</SelectItem><SelectItem value="20">20 条</SelectItem><SelectItem value="50">50 条</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <IconButton icon={ChevronLeft} label="上一页" variant="outline" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)} />
          <span aria-label={`第 ${currentPage} 页，共 ${pageCount} 页`} className="grid size-9 place-items-center rounded-lg bg-brand text-sm font-medium text-white">{currentPage}</span>
          <IconButton icon={ChevronRight} label="下一页" variant="outline" disabled={currentPage >= pageCount} onClick={() => setPage(currentPage + 1)} />
        </div>
      </div>
      <PlatformAdminDialog open={editing !== undefined} onOpenChange={(open) => { if (!open && !busy) setEditing(undefined) }} title={editing === "new" ? "新增 AI 账号" : "编辑 AI 账号"}>
        {editing ? <AiAccountEditor key={editing === "new" ? "new" : editing.id} account={editing === "new" ? undefined : editing} purpose={purpose} busy={busy} onCancel={() => setEditing(undefined)} onSave={save} /> : null}
      </PlatformAdminDialog>
      <ConfirmDialog open={deleting !== undefined} onOpenChange={(open) => { if (!open) setDeleting(undefined) }} title="删除 AI 账号" description={`删除「${deleting?.label ?? ""}」及其密钥。进行中的请求与历史账单不受影响。删除后需要重新填写密钥才能恢复该账号。`} busy={busy} confirmText="删除" onConfirm={remove} />
    </>
  )
}

/** The pane's read state before an overview exists: waiting, or failed with a retry. */
export function AiReadState({ loading, onRetry }: { loading: boolean; onRetry: () => void }) {
  return loading
    ? <PlatformAdminEmpty icon={KeyRound} busy title="正在读取 AI 账号" />
    : <PlatformAdminEmpty icon={KeyRound} title="无法读取 AI 账号" action={<IconButton icon={RotateCcw} label="重试" variant="outline" onClick={onRetry} />} />
}

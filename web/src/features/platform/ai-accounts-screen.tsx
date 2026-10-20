import { useEffect, useState } from "react"
import { ArrowRight, KeyRound, Plus, Search } from "lucide-react"
import type { AiAccountView, IntegrationCredentialsOverview } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { aiAccountsHttp } from "@/bindings/http-ai-accounts"
import type { AiAccountDraft } from "@/bindings/integration-ai-writes"
import { PlatformAdminEmpty, PlatformAdminSurface } from "@/components/platform-admin-surface"
import { PlatformAdminDialog } from "@/components/platform-admin-dialog"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { notifyCommandError, notifyError, notifyInfo, notifySuccess } from "@/lib/notify"
import { accountModelLine, connectionProbe } from "./ai-account-model"
import { AiConnectionChip, type AiConnectionState } from "./ai-account-status"
import { AiAccountEditor } from "./ai-account-editor"

export function PlatformAiAccountsScreen({ initialOverview, onOpenModels }: { initialOverview?: IntegrationCredentialsOverview; onOpenModels?: () => void } = {}) {
  const [overview, setOverview] = useState(initialOverview)
  const [loading, setLoading] = useState(!initialOverview)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("all")
  const [editing, setEditing] = useState<AiAccountView | "new">()
  const [deleting, setDeleting] = useState<AiAccountView>()
  const [testingId, setTestingId] = useState<string>()
  const [connections, setConnections] = useState<Record<string, AiConnectionState>>({})
  useEffect(() => {
    if (initialOverview && reload === 0) return
    let cancelled = false
    setLoading(true)
    void integrationsHttp.integrationsGetCredentials().then((data) => {
      if (!cancelled) setOverview(data)
    }).catch((reason) => {
      if (!cancelled) notifyCommandError(reason, "无法读取 AI 账号池，请重试。")
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [initialOverview, reload])

  async function save(draft: AiAccountDraft) {
    if (busy) return
    setBusy(true)
    try {
      setOverview(await aiAccountsHttp.upsert(draft))
      setEditing(undefined)
      notifySuccess("AI 账号已保存")
    } catch (reason) { notifyCommandError(reason, "保存失败，请检查配置或刷新后重试。") }
    finally { setBusy(false) }
  }
  async function toggle(account: AiAccountView) {
    if (busy) return
    setBusy(true)
    try { setOverview(await aiAccountsHttp.setActive(account.id, !account.active)); notifySuccess(account.active ? "账号已停用" : "账号已启用") }
    catch (reason) { notifyCommandError(reason, "账号状态修改失败，请刷新后重试。") }
    finally { setBusy(false) }
  }
  async function test(account: AiAccountView) {
    if (busy || loading || testingId) return
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
    try {
      const result = await aiAccountsHttp.verifyModel(probe.request)
      const state: AiConnectionState = result.model_present ? "ok" : "missing"
      setConnections((current) => ({ ...current, [account.id]: state }))
      if (result.model_present) notifySuccess(`「${account.label}」连接正常`, { description: `${result.latency_ms} ms。未发起识图。` })
      else notifyInfo(`「${account.label}」密钥有效，但目录未列出该模型`)
    } catch (reason) {
      setConnections((current) => ({ ...current, [account.id]: "failed" }))
      notifyCommandError(reason, "连接测试失败，请检查密钥、服务地址和网络。")
    } finally {
      setTestingId(undefined)
    }
  }
  async function remove() {
    if (!deleting || busy) return
    setBusy(true)
    try { setOverview(await aiAccountsHttp.delete(deleting.id)); setDeleting(undefined); notifySuccess("AI 账号已删除") }
    catch (reason) { notifyCommandError(reason, "删除失败，请刷新后重试。") }
    finally { setBusy(false) }
  }
  const accounts = overview?.ai_accounts ?? []
  const visible = accounts.filter((account) =>
    (filter === "all" || (filter === "active" ? account.active : !account.active)) &&
    [account.label, account.model, account.base_url].some((value) => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())),
  ).sort((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority || a.id.localeCompare(b.id))
  const defaultModel = overview?.ai_default_model
  const mutationsDisabled = busy || loading

  return (
    <div className="flex w-full flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-compact">
          <span className="text-muted-foreground">默认识图模型</span>
          <strong className="break-all font-mono">{defaultModel || "尚未选择"}</strong>
          {onOpenModels ? <Button variant="ghost" size="sm" onClick={onOpenModels}>模型与定价<ArrowRight aria-hidden /></Button> : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || loading} onClick={() => setReload((value) => value + 1)}>刷新</Button>
          <Button disabled={!overview || busy || loading || accounts.length >= 64} onClick={() => setEditing("new")}><Plus aria-hidden />新增账号</Button>
        </div>
      </div>
      <PlatformAdminSurface summary={<span className="text-compact text-muted-foreground">{accounts.length} / 64 个账号 · {accounts.filter((row) => row.active).length} 个已启用</span>}
        toolbar={accounts.length > 0 ? <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <FieldLabel htmlFor="ai-account-search">搜索账号</FieldLabel>
            <Input id="ai-account-search" type="search" placeholder="账号名称、模型或服务地址" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5 sm:w-36">
            <FieldLabel htmlFor="ai-account-status">账号状态</FieldLabel>
            <Select items={{ all: "全部账号", active: "已启用", inactive: "已停用" }} value={filter} onValueChange={(value) => { if (value) setFilter(value) }}>
              <SelectTrigger id="ai-account-status"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="all">全部账号</SelectItem><SelectItem value="active">已启用</SelectItem><SelectItem value="inactive">已停用</SelectItem></SelectContent>
            </Select>
          </div>
        </div> : undefined}>
        {loading ? <PlatformAdminEmpty icon={KeyRound} busy title="正在读取 AI 账号池" /> : !overview ? (
          <PlatformAdminEmpty icon={KeyRound} action={<Button variant="outline" onClick={() => setReload((value) => value + 1)}>重试</Button>} />
        ) : accounts.length === 0 ? <PlatformAdminEmpty icon={KeyRound} title="还没有 AI 账号" description="添加账号，填写密钥并测试连接。价格在「模型与定价」中配置。" /> : (
          visible.length === 0 ? <PlatformAdminEmpty icon={Search} title="没有匹配的账号" description="尝试其他关键词，或查看全部账号。" action={<Button variant="outline" onClick={() => { setQuery(""); setFilter("all") }}>清除筛选</Button>} /> :
          <ul aria-label="AI 服务账号" className="divide-y divide-border">
            {visible.map((account) => {
              const line = accountModelLine(account)
              return <li key={account.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="break-words text-compact font-medium">{account.label}</span>
                  <StateChip status={account.active ? "present" : "idle"} label={account.active ? "已启用" : "已停用"} />
                  {!account.configured ? <StateChip status="idle" label="待填写密钥" /> : null}
                  <AiConnectionChip state={connections[account.id] ?? "idle"} />
                  {account.model === defaultModel ? <span className="text-meta text-muted-foreground">默认识图</span> : null}
                </div>
                <span className="break-words text-compact">{line.model}</span>
                <span className="break-all text-meta text-muted-foreground">{line.service}</span>
                {account.api_format !== "chat_completions" ? <span className="text-meta text-muted-foreground">不能用于识图</span> : null}
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={mutationsDisabled || testingId !== undefined} aria-label={`测试连接 ${account.label}`} onClick={() => void test(account)}>{testingId === account.id ? "测试中…" : "测试连接"}</Button>
                <Button size="sm" variant="outline" disabled={mutationsDisabled} aria-label={`${account.active ? "停用" : "启用"} ${account.label}`} onClick={() => void toggle(account)}>{account.active ? "停用" : "启用"}</Button>
                <Button size="sm" variant="outline" disabled={mutationsDisabled} aria-label={`编辑 ${account.label}`} onClick={() => setEditing(account)}>编辑</Button>
                <Button size="sm" variant="ghost" disabled={mutationsDisabled} aria-label={`删除 ${account.label}`} onClick={() => setDeleting(account)}>删除</Button>
              </div>
            </li>})}
          </ul>
        )}
      </PlatformAdminSurface>
      <p className="text-meta text-muted-foreground">同一模型有多个已启用账号时，按高级设置中的优先级选用。默认识图和价格在「模型与定价」中管理。</p>
      <PlatformAdminDialog open={editing !== undefined} onOpenChange={(open) => { if (!open && !busy) setEditing(undefined) }} title={editing === "new" ? "新增 AI 账号" : "编辑 AI 账号"}>
        {editing ? <AiAccountEditor key={editing === "new" ? "new" : editing.id} account={editing === "new" ? undefined : editing} busy={busy} onCancel={() => setEditing(undefined)} onSave={save} /> : null}
      </PlatformAdminDialog>
      <ConfirmDialog open={deleting !== undefined} onOpenChange={(open) => { if (!open) setDeleting(undefined) }} title="删除 AI 账号" description={`删除「${deleting?.label ?? ""}」及其密钥。进行中的请求与历史账单不受影响。删除后需要重新填写密钥才能恢复该账号。`} busy={busy} confirmText="删除" onConfirm={remove} />
    </div>
  )
}

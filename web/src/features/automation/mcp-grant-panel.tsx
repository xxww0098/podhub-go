import { useEffect, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { createAutomationGrant, listAutomationGrants, revokeAutomationGrant, type AutomationGrant, type GrantInput, type GrantScopeKind } from "@/bindings/http-automation-grants"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Copy, KeyRound } from "lucide-react"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { notifyCommandError, notifySuccess } from "@/lib/notify"
import { availableGrantScopes, roleGrantScope } from "./grant-options"
import { McpGrantForm } from "./mcp-grant-form"
import { McpGrantList } from "./mcp-grant-list"

/** The settings caller keys this component by account, workspace and role.
 * Secrets live only here and disappear on close or an authority change. */
export function McpGrantPanel({ overview }: { overview?: AccountOverview }) {
  const scope = roleGrantScope(overview)
  const visibleKey = availableGrantScopes(overview).join(",")
  const [grants, setGrants] = useState<AutomationGrant[]>([])
  const [token, setToken] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const endpoint = new URL("/mcp", window.location.origin).href
  const authenticated = !!overview?.session.authenticated

  useEffect(() => {
    if (!authenticated || visibleKey === "") { setLoading(false); return }
    const controller = new AbortController()
    const scopes = visibleKey.split(",").filter((item): item is GrantScopeKind => item === "catalog" || item === "workspace" || item === "supplier_catalog")
    setLoading(true)
    setFailed(false)
    setGrants([])
    void Promise.all(scopes.map((item) => listAutomationGrants(item, controller.signal))).then((groups) => {
      if (!controller.signal.aborted) {
        setGrants(groups.flat().sort((left, right) => (right.created_at_ms ?? 0) - (left.created_at_ms ?? 0)))
      }
    }).catch((reason) => {
      if (!controller.signal.aborted) { setFailed(true); notifyCommandError(reason, "无法读取 MCP 令牌") }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [authenticated, visibleKey, refresh])

  async function create(input: GrantInput) {
    if (!scope) return
    setBusy(true)
    try {
      const result = await createAutomationGrant(scope, input)
      setToken(result.token)
      setRefresh((value) => value + 1)
      notifySuccess("令牌已创建")
    } catch (reason) {
      notifyCommandError(reason, "无法申请 MCP 令牌")
    } finally { setBusy(false) }
  }
  async function revoke(grant: AutomationGrant) {
    setBusy(true)
    try {
      await revokeAutomationGrant(grant.scopeKind, grant.id)
      setToken(null)
      setRefresh((value) => value + 1)
      notifySuccess("令牌已删除")
    } catch (reason) {
      notifyCommandError(reason, "无法删除 MCP 令牌")
    } finally { setBusy(false) }
  }
  async function copy(value: string) {
    try { await navigator.clipboard.writeText(value); notifySuccess("已复制") }
    catch (reason) { notifyCommandError(reason, "无法复制，请手动选择复制") }
  }

  if (!authenticated) {
    return (
      <Empty role="status" className="min-h-60">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>未开放申请</EmptyTitle>
          <EmptyDescription>登录账号后方可申请智能体 MCP 授权令牌。</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
    <section aria-labelledby="mcp-connection" className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-6">
      <div>
        <h3 id="mcp-connection" className="text-2xl font-semibold">连接智能体</h3>
        <p className="mt-1 text-lg text-muted-foreground">通过以下同源地址接入 PodHub Cloud 的智能体服务。</p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-lg bg-muted px-3 py-2 font-mono text-compact text-foreground">{endpoint}</code>
        <IconButton icon={Copy} label="复制连接地址" variant="outline" size="icon-sm" onClick={() => { void copy(endpoint) }} />
      </div>
    </section>
    {token ? <section aria-label="保存新令牌" className="flex min-w-0 flex-col gap-3 rounded-xl border border-brand/30 bg-brand-soft/40 px-4 py-4">
      <p className="flex items-center gap-2 text-compact font-medium text-foreground"><KeyRound aria-hidden className="size-4 text-brand" />请妥善保存；关闭设置后无法再次查看。</p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 basis-64 break-all rounded-lg border border-border bg-card px-3 py-2 font-mono text-compact" aria-label="新建 MCP 令牌">{token}</code>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <IconButton icon={Copy} label="复制令牌" variant="default" size="icon-sm" onClick={() => { void copy(token) }} />
          <Button type="button" size="sm" variant="outline" onClick={() => setToken(null)}>已保存，隐藏令牌</Button>
        </div>
      </div>
      <p className="break-words text-meta text-muted-foreground">请求头：Authorization: Bearer &lt;令牌&gt;</p>
    </section> : <section aria-label="申请令牌" className="rounded-xl border border-border bg-card p-6">
      <h3 className="text-2xl font-semibold">申请令牌</h3>
      <p className="mb-4 mt-1 text-lg text-muted-foreground">创建令牌以便智能体访问指定能力。</p>
      {scope ? <McpGrantForm key={scope} scope={scope} overview={overview} busy={busy} onCreate={create} />
        : <p role="status" className="text-lg text-muted-foreground">请选择工作空间后申请读取令牌。</p>}
    </section>}
    <McpGrantList grants={grants} loading={loading} failed={failed} busy={busy} onRefresh={() => setRefresh((value) => value + 1)} onRevoke={revoke} />
  </div>
}

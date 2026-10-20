import { useEffect, useState } from "react"
import type { AccountOverview } from "@/bindings/commands"
import { createAutomationGrant, listAutomationGrants, revokeAutomationGrant, type AutomationGrant, type GrantInput, type GrantScopeKind } from "@/bindings/http-automation-grants"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
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

  if (!scope) return <p className="text-sm text-muted-foreground">登录后可以申请 MCP 令牌。</p>
  return <div className="flex min-w-0 flex-col gap-4">
    <Card size="sm">
      <CardHeader><CardTitle>连接智能体</CardTitle><CardDescription>在客户端填写连接地址与 Bearer 令牌。令牌只能执行你授权的操作。</CardDescription></CardHeader>
      <CardContent>
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <code className="min-w-0 flex-1 break-all font-mono text-compact">{endpoint}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => { void copy(endpoint) }}>复制连接地址</Button>
        </div>
      </CardContent>
    </Card>
    {token ? <Card size="sm">
      <CardHeader><CardTitle>保存新令牌</CardTitle><CardDescription>请立即复制并妥善保存；关闭设置后无法再次查看。</CardDescription></CardHeader>
      <CardContent><div className="flex flex-col gap-3">
        <code className="min-w-0 flex-1 break-all font-mono text-compact" aria-label="新建 MCP 令牌">{token}</code>
        <p className="break-words text-meta text-muted-foreground">客户端请求头：Authorization: Bearer &lt;令牌&gt;</p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => { void copy(token) }}>复制令牌</Button>
          <Button type="button" variant="outline" onClick={() => setToken(null)}>已保存，隐藏令牌</Button>
        </div>
      </div></CardContent>
    </Card> : <Card size="sm">
      <CardHeader><CardTitle>申请令牌</CardTitle><CardDescription>为每个客户端单独授权，按需选择操作和有效期。</CardDescription></CardHeader>
      <CardContent><McpGrantForm key={scope} scope={scope} overview={overview} busy={busy} onCreate={create} /></CardContent>
    </Card>}
    <McpGrantList grants={grants} loading={loading} failed={failed} busy={busy} onRefresh={() => setRefresh((value) => value + 1)} onRevoke={revoke} />
  </div>
}

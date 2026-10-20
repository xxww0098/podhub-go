import type { AutomationGrant } from "@/bindings/http-automation-grants"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { grantActionLabel } from "./grant-options"

function date(value?: number | null): string {
  return value ? new Date(value).toLocaleString() : "—"
}

export function McpGrantList({ grants, loading, failed, busy, onRefresh, onRevoke }: {
  grants: AutomationGrant[]
  loading: boolean
  failed: boolean
  busy: boolean
  onRefresh: () => void
  onRevoke: (grant: AutomationGrant) => Promise<void>
}) {
  const visible = grants.filter((grant) => !grant.revokedAtMs)
  return (
    <section className="flex flex-col gap-3" aria-label="已申请的 MCP 令牌">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">已申请的令牌</h3>
        <Button type="button" size="sm" variant="outline" disabled={loading || busy} onClick={onRefresh}>刷新</Button>
      </div>
      {loading ? <Spinner aria-label="正在读取令牌" /> : failed ? <Button type="button" variant="outline" disabled={busy} onClick={onRefresh}>重新读取令牌</Button> : visible.length === 0 ? <p className="text-sm text-muted-foreground">还没有令牌。</p> : visible.map((grant) => {
        const expired = !!grant.expiresAtMs && grant.expiresAtMs <= Date.now()
        const status = expired ? "已过期" : "有效"
        return <article key={grant.id} className="flex flex-col gap-2 border-t border-border py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0 break-words text-sm font-medium">{grant.name} · {status}</p>
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { void onRevoke(grant) }} aria-label={`删除令牌 ${grant.name}`}>删除</Button>
          </div>
          <code className="text-xs text-muted-foreground">{grant.token_prefix}</code>
          <p className="text-xs text-muted-foreground">{grant.actions.map(grantActionLabel).join("、")}</p>
          {grant.scopeKind === "supplier_catalog" ? <p className="text-xs text-muted-foreground">{grant.sourceIds === null ? "所有源库" : `指定 ${grant.sourceIds.length} 个源库`}</p> : null}
          <p className="text-xs text-muted-foreground">到期：{grant.expiresAtMs ? date(grant.expiresAtMs) : "无到期时间"} · 最近使用：{date(grant.lastUsedAtMs)}</p>
        </article>
      })}
    </section>
  )
}

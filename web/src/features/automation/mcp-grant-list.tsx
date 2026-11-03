import type { AutomationGrant } from "@/bindings/http-automation-grants"
import { useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { IconButton } from "@/components/ui/icon-button"
import { FileText, RefreshCw, Trash2 } from "lucide-react"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
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
  const [revoking, setRevoking] = useState<AutomationGrant | null>(null)
  const visible = grants.filter((grant) => !grant.revokedAtMs)
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-xl border border-border bg-card p-6" aria-label="已申请的 MCP 令牌">
      <div className="mb-3 flex shrink-0 flex-wrap items-start gap-2">
        <div>
          <h3 className="text-2xl font-semibold">令牌</h3>
          <p className="mt-1 text-lg text-muted-foreground">管理已申请的令牌，令牌仅在创建时显示，可在此删除。</p>
        </div>
        {!loading && !failed && visible.length > 0 ? <span className="font-mono text-meta tabular-nums text-muted-foreground">{visible.length}</span> : null}
        <IconButton className="ml-auto" icon={RefreshCw} label="刷新" variant="outline" size="icon-sm" disabled={loading || busy} onClick={onRefresh} />
      </div>
      <Table className={`[&_th]:h-12 ${visible.length ? "min-w-[42rem]" : ""}`} containerClassName="min-h-0 flex-1 overflow-auto" aria-label="MCP 令牌列表">
        <TableHeader className="sticky top-0 z-10 bg-card"><TableRow><TableHead>名称</TableHead><TableHead>权限范围</TableHead><TableHead>创建时间</TableHead><TableHead>状态</TableHead><TableHead>操作</TableHead></TableRow></TableHeader>
        <TableBody>
          {loading ? <TableRow><TableCell colSpan={5}><div className="flex min-h-20 items-center justify-center"><Spinner aria-label="正在读取令牌" /></div></TableCell></TableRow>
            : failed ? <TableRow><TableCell colSpan={5}><div className="flex min-h-20 items-center justify-center"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={onRefresh}>重新读取令牌</Button></div></TableCell></TableRow>
              : visible.length === 0 ? <TableRow><TableCell colSpan={5}><div className="flex min-h-36 flex-col items-center justify-center gap-1 text-center">
                <span className="mb-1 flex size-16 items-center justify-center rounded-full bg-muted text-muted-foreground"><FileText className="size-6" aria-hidden /></span>
                <p className="text-lg font-medium">暂无令牌</p>
                <p className="text-lg text-muted-foreground">当前还没有申请任何令牌。</p>
              </div></TableCell></TableRow>
                : visible.map((grant) => {
                  const expired = !!grant.expiresAtMs && grant.expiresAtMs <= Date.now()
                  return <TableRow key={grant.id}>
                    <TableCell><p className="break-words font-medium">{grant.name}</p><code className="text-meta text-muted-foreground">{grant.token_prefix}</code></TableCell>
                    <TableCell><div className="flex max-w-72 flex-wrap gap-1.5">
                      {grant.actions.map((action) => <Badge key={action} variant="outline">{grantActionLabel(action)}</Badge>)}
                      {grant.scopeKind === "supplier_catalog" ? <Badge variant="outline">{grant.sourceIds === null ? "所有源库" : `指定 ${grant.sourceIds.length} 个源库`}</Badge> : null}
                    </div></TableCell>
                    <TableCell className="whitespace-nowrap text-meta text-muted-foreground">{date(grant.created_at_ms)}<p>最近使用：{date(grant.lastUsedAtMs)}</p></TableCell>
                    <TableCell><Badge variant={expired ? "destructive" : "good"}>{expired ? "已过期" : "有效"}</Badge><p className="mt-1 whitespace-nowrap text-meta text-muted-foreground">{grant.expiresAtMs ? `到期：${date(grant.expiresAtMs)}` : "无到期时间"}</p></TableCell>
                    <TableCell><IconButton icon={Trash2} label={`删除令牌 ${grant.name}`} tip="删除令牌" size="icon-sm" variant="outline" disabled={busy} onClick={() => setRevoking(grant)} /></TableCell>
                  </TableRow>
                })}
        </TableBody>
      </Table>
      <ConfirmDialog open={revoking !== null} onOpenChange={(open) => { if (!open) setRevoking(null) }} title="删除令牌？" description={`删除后「${revoking?.name ?? ""}」将无法继续访问智能体服务。`} confirmText="删除令牌" busy={busy} onConfirm={() => { if (revoking) void onRevoke(revoking).then(() => setRevoking(null)) }} />
    </section>
  )
}

import { Eye, RefreshCw } from "lucide-react"
import { useId, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { useObservationScope } from "./observation-scope-provider"

export function ObservationScopeBar({ title, loading, onReload, children }: {
  title: string
  loading: boolean
  onReload: () => void
  children?: ReactNode
}) {
  const { scope, scopes, scopesLoading, scopesFailed, changeScope, reloadScopes } = useObservationScope()
  const id = useId()
  const workspaces = scopes?.workspaces ?? []
  const stores = (scopes?.stores ?? []).filter((store) => !scope.workspaceId || store.workspace_id === scope.workspaceId)
  const workspace = workspaces.find((item) => item.id === scope.workspaceId)
  const store = stores.find((item) => item.store_id === scope.storeId)
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-md font-semibold">{title}</h1>
        <Badge variant="outline"><Eye data-icon="inline-start" />只读观察</Badge>
        <p className="text-compact text-muted-foreground">云端快照 · 不切换当前工作空间</p>
        <div className="ml-auto flex items-center gap-2">
          {children}
          <Button variant="outline" size="sm" disabled={loading} onClick={onReload}>
            {loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            重读快照
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid w-full gap-1 sm:w-60">
          <label htmlFor={id + "-workspace"} className="text-meta text-muted-foreground">查看工作空间</label>
          <Select value={scope.workspaceId ?? "all"} disabled={scopesLoading} onValueChange={(value) => {
            if (value) changeScope({ workspaceId: value === "all" ? undefined : value })
          }}>
            <SelectTrigger id={id + "-workspace"} aria-label="查看工作空间"><SelectValue>{scope.workspaceId ? workspace?.name ?? "指定工作空间" : "全部工作空间"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部工作空间</SelectItem>
              {workspaces.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.owner_name} · {item.id.slice(0, 8)}</SelectItem>)}
              {scope.workspaceId && !workspace ? <SelectItem value={scope.workspaceId}>指定工作空间</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
        <div className="grid w-full gap-1 sm:w-72">
          <label htmlFor={id + "-store"} className="text-meta text-muted-foreground">查看店铺</label>
          <Select value={scope.storeId ?? "all"} disabled={scopesLoading} onValueChange={(value) => {
            if (value) changeScope({ ...scope, storeId: value === "all" ? undefined : value })
          }}>
            <SelectTrigger id={id + "-store"} aria-label="查看店铺"><SelectValue>{scope.storeId ? store?.store_name ?? "指定店铺" : "全部店铺"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部店铺</SelectItem>
              {stores.map((item) => <SelectItem key={item.store_id} value={item.store_id}>{item.store_name} · {item.workspace_name} · {item.store_id.slice(0, 8)}</SelectItem>)}
              {scope.storeId && !store ? <SelectItem value={scope.storeId}>指定店铺</SelectItem> : null}
            </SelectContent>
          </Select>
        </div>
        {scopesFailed ? <Button variant="outline" size="sm" onClick={reloadScopes}>重试范围</Button> : null}
      </div>
    </header>
  )
}

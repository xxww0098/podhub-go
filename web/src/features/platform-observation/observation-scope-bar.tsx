import { Eye, LoaderCircle, RefreshCw, RotateCcw } from "lucide-react"
import { useId, type ReactNode } from "react"
import { PageToolbar } from "@/components/page-toolbar"
import { IconButton } from "@/components/ui/icon-button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useObservationScope } from "./observation-scope-provider"

/** 平台只读页共用的单层工具条：工作空间、店铺、页面自带的筛选，右侧是只读标记与重读。 */
export function ObservationScopeBar({ title, loading, onReload, children, showLabels = false }: {
  title: string
  loading: boolean
  onReload: () => void
  children?: ReactNode
  showLabels?: boolean
}) {
  const { scope, scopes, scopesLoading, scopesFailed, changeScope, reloadScopes } = useObservationScope()
  const id = useId()
  const workspaces = scopes?.workspaces ?? []
  const stores = (scopes?.stores ?? []).filter((store) => !scope.workspaceId || store.workspace_id === scope.workspaceId)
  const workspace = workspaces.find((item) => item.id === scope.workspaceId)
  const store = stores.find((item) => item.store_id === scope.storeId)
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      <PageToolbar
        className={showLabels ? "gap-y-2 [&>div]:items-end" : "gap-y-2"}
        primary={<>
          <div className={showLabels ? "min-w-0 w-full sm:w-52" : "contents"}>
          {showLabels ? <label htmlFor={`${id}-workspace`} className="mb-1 block text-compact font-medium">工作空间</label> : null}
          <Select value={scope.workspaceId ?? "all"} disabled={scopesLoading} onValueChange={(value) => {
            if (value) changeScope({ workspaceId: value === "all" ? undefined : value })
          }}>
            <SelectTrigger id={`${id}-workspace`} size="sm" className="w-full min-w-0 sm:w-52" aria-label="查看工作空间"><SelectValue>{scope.workspaceId ? workspace?.name ?? "指定工作空间" : "全部工作空间"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部工作空间</SelectItem>
              {workspaces.map((item) => <SelectItem key={item.id} value={item.id}>{item.name} · {item.owner_name} · {item.id.slice(0, 8)}</SelectItem>)}
              {scope.workspaceId && !workspace ? <SelectItem value={scope.workspaceId}>指定工作空间</SelectItem> : null}
            </SelectContent>
          </Select>
          </div>
          <div className={showLabels ? "min-w-0 w-full sm:w-52" : "contents"}>
          {showLabels ? <label htmlFor={`${id}-store`} className="mb-1 block text-compact font-medium">店铺</label> : null}
          <Select value={scope.storeId ?? "all"} disabled={scopesLoading} onValueChange={(value) => {
            if (value) changeScope({ ...scope, storeId: value === "all" ? undefined : value })
          }}>
            <SelectTrigger id={`${id}-store`} size="sm" className="w-full min-w-0 sm:w-52" aria-label="查看店铺"><SelectValue>{scope.storeId ? store?.store_name ?? "指定店铺" : "全部店铺"}</SelectValue></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部店铺</SelectItem>
              {stores.map((item) => <SelectItem key={item.store_id} value={item.store_id}>{item.store_name} · {item.workspace_name} · {item.store_id.slice(0, 8)}</SelectItem>)}
              {scope.storeId && !store ? <SelectItem value={scope.storeId}>指定店铺</SelectItem> : null}
            </SelectContent>
          </Select>
          </div>
          {scopesFailed ? <IconButton icon={RotateCcw} label="重试范围" variant="outline" size="icon-sm" onClick={reloadScopes} /> : null}
          {children}
        </>}
        secondary={<>
          <span className="inline-flex items-center gap-1.5 text-meta text-muted-foreground"><Eye aria-hidden className="size-3.5" />只读</span>
          <IconButton
            icon={loading ? LoaderCircle : RefreshCw}
            aria-busy={loading}
            label="重读快照"
            variant="ghost"
            size="icon-sm"
            disabled={loading}
            onClick={onReload}
          />
        </>}
      />
    </>
  )
}

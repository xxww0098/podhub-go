import type { OzonStoresOverview } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { StoreTaxonomyDialog } from "./store-taxonomy-dialog"

/** 分组的重命名/删除管理框 — 壳与交互在 StoreTaxonomyDialog，这里只绑定 Group 命令与文案。 */
export function StoreGroupsDialog({
  open,
  onOpenChange,
  overview,
  workspaceId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  overview: OzonStoresOverview
  workspaceId?: number
}) {
  return (
    <StoreTaxonomyDialog
      open={open}
      onOpenChange={onOpenChange}
      items={overview.groups ?? []}
      workspaceId={workspaceId}
      noun="分组"
      description="重命名或删除分组；新建与指定在店铺资料里完成。删除后相关店铺变为未分组。"
      emptyHint="还没有分组。新建后即可在店铺编辑里使用。"
      renameItem={(input) => integrationsHttp.integrationsRenameStoreGroup(input)}
      deleteItem={(uuid) =>
        integrationsHttp.integrationsDeleteStoreGroup({ uuid })
      }
    />
  )
}

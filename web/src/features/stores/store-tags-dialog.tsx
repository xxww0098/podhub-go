import type { OzonStoresOverview } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { StoreTaxonomyDialog } from "./store-taxonomy-dialog"

/** 标签的重命名/删除管理框 — 壳与交互在 StoreTaxonomyDialog，这里只绑定 Tag 命令与文案。 */
export function StoreTagsDialog({
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
      items={overview.tags ?? []}
      workspaceId={workspaceId}
      noun="标签"
      description="重命名或删除标签；新建与勾选在店铺资料里完成。删除会从关联店铺中解除。"
      emptyHint="还没有标签。新建后即可在店铺编辑里使用。"
      renameItem={(input) => integrationsHttp.integrationsRenameStoreTag(input)}
      deleteItem={(uuid) =>
        integrationsHttp.integrationsDeleteStoreTag({ uuid })
      }
    />
  )
}

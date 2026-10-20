import { useRef, useState } from "react"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Tabs, TabsContent, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CategoryCellEditor, type CategoryCoord } from "./supplier-prop-editors"
import { SupplierRowDefaults } from "./supplier-row-defaults"
import type { PatchFn } from "./supplier-row-fields"

export function SupplierRowPlatformTab({
  row, categoryTree = [], categoryLoading, onEnsureCategoryTree, onPatch, onNavigateMedia, configEpoch, onConfigSaved,
}: {
  row: SupplierDbRow
  categoryTree?: CategoryTreeNodeView[]
  categoryLoading?: boolean
  onEnsureCategoryTree?: () => Promise<boolean>
  onPatch: PatchFn
  onNavigateMedia: () => void
  configEpoch?: number
  onConfigSaved?: () => void
}) {
  const [pendingCategory, setPendingCategory] = useState<CategoryCoord | null>(null)
  const [savingCategory, setSavingCategory] = useState(false)
  const categoryRef = useRef<HTMLDivElement>(null)

  function openCategory() {
    const trigger = categoryRef.current?.querySelector<HTMLButtonElement>(
      '[data-cell-editor="category"]',
    )
    trigger?.focus()
    trigger?.click()
  }

  return (
    <>
      <Tabs defaultValue="ozon" data-supplier-row-platform="">
        <TabsList aria-label="销售平台" variant="line">
          <TabsIndicator variant="line" />
          <TabsTrigger value="ozon" variant="line">Ozon</TabsTrigger>
          <TabsTrigger value="wb" variant="line">WB</TabsTrigger>
        </TabsList>
        {/* Preserve the draft and CAS session while the operator visits WB. */}
        <TabsContent value="ozon" keepMounted>
          <div className="flex flex-col gap-4">
            <div ref={categoryRef} className="flex flex-col gap-2" data-supplier-row-category="">
              <h3 className="text-compact font-semibold">Ozon 类目</h3>
              <CategoryCellEditor ariaLabel="Ozon 类目" tree={categoryTree} loading={categoryLoading}
                onEnsureTree={onEnsureCategoryTree} disabled={savingCategory}
                value={{ descriptionCategoryId: row.descriptionCategoryId, typeId: row.typeId }}
                onCommit={async (next) => {
                  if (next.descriptionCategoryId !== row.descriptionCategoryId || next.typeId !== row.typeId) setPendingCategory(next)
                  // Close the picker before opening confirmation; cancellation is not a validation error.
                  return true
                }}
              />
              <p className="text-meta text-muted-foreground">字段名称、类型、必填和字典选项均来自当前类目。</p>
            </div>
            <SupplierRowDefaults row={row} configEpoch={configEpoch} onConfigSaved={onConfigSaved} onNavigate={(target) => target === "media" ? onNavigateMedia() : openCategory()} />
          </div>
        </TabsContent>
        <TabsContent value="wb" keepMounted>
          <section className="flex flex-col gap-3" data-supplier-row-wb-empty="">
            <h3 className="text-compact font-semibold">WB 平台字段</h3>
            <p className="text-compact">暂未开放供应商商品的 WB 类目与字段配置。</p>
            <p className="text-meta text-muted-foreground">此处尚无可编辑的 WB 配置。Ozon 配置独立保留，切换平台不会复制或清空字段。</p>
          </section>
        </TabsContent>
      </Tabs>
      <ConfirmDialog open={pendingCategory !== null} busy={savingCategory}
        onOpenChange={(open) => { if (!open) setPendingCategory(null) }}
        title={pendingCategory?.descriptionCategoryId == null ? "清除 Ozon 类目" : "切换 Ozon 类目"}
        description={pendingCategory?.descriptionCategoryId == null
          ? "清除后 Ozon 配置将暂停使用。已保存的字段会保留，重新选择相同类目后可恢复；商品资料和提示词保持不变。"
          : "选择不同类目会清空已保存的 Ozon 字段配置，并按新类目重新读取。商品资料、提示词与固定标签保留。"}
        confirmText="确认更改" variant="default"
        onConfirm={async () => {
          if (!pendingCategory) return
          setSavingCategory(true)
          try {
            if (await onPatch({ descriptionCategoryId: pendingCategory.descriptionCategoryId, typeId: pendingCategory.typeId })) setPendingCategory(null)
          } finally {
            setSavingCategory(false)
          }
        }}
      />
    </>
  )
}

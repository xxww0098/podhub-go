import { useRef, useState } from "react"
import { ChevronDown } from "lucide-react"
import { FieldMeta } from "@/components/field-meta"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { CategoryCellEditor, type CategoryCoord } from "./supplier-prop-editors"
import { SupplierRowDefaults } from "./supplier-row-defaults"
import type { PatchFn } from "./supplier-row-fields"

export function SupplierRowPlatformTab({
  row, shared = true, categoryTree = [], categoryLoading, onEnsureCategoryTree, onPatch, onNavigateMedia, configEpoch, onConfigSaved, flushRef,
}: {
  row: SupplierDbRow
  shared?: boolean
  categoryTree?: CategoryTreeNodeView[]
  categoryLoading?: boolean
  onEnsureCategoryTree?: () => Promise<boolean>
  onPatch: PatchFn
  onNavigateMedia: () => void
  configEpoch: number
  onConfigSaved: () => void
  flushRef?: React.RefObject<(() => Promise<boolean>) | null>
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-row-platform="">
        <div className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
          <div className="flex shrink-0 items-center gap-1 text-compact font-medium"><span>类目</span><FieldMeta name="Ozon 类目" required description="上架前必须选择类目，平台字段随类目变化；切换类目需要确认。" /></div>
          <div ref={categoryRef} className="relative min-w-0 flex-1" data-supplier-row-category="">
            <CategoryCellEditor ariaLabel="Ozon 类目" tree={categoryTree} loading={categoryLoading}
              onEnsureTree={onEnsureCategoryTree} disabled={savingCategory}
              value={{ descriptionCategoryId: row.descriptionCategoryId, typeId: row.typeId }}
              onCommit={async (next) => {
                if (next.descriptionCategoryId !== row.descriptionCategoryId || next.typeId !== row.typeId) setPendingCategory(next)
                // Close the picker before opening confirmation; cancellation is not a validation error.
                return true
              }}
            />
            <ChevronDown aria-hidden className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-muted-foreground" />
          </div>
        </div>
        <SupplierRowDefaults row={row} configEpoch={configEpoch} onConfigSaved={onConfigSaved} flushRef={flushRef} onNavigate={(target) => target === "media" ? onNavigateMedia() : openCategory()} />
      </div>
      <ConfirmDialog open={pendingCategory !== null} busy={savingCategory}
        onOpenChange={(open) => { if (!open) setPendingCategory(null) }}
        title={pendingCategory?.descriptionCategoryId == null ? "清除 Ozon 类目" : "切换 Ozon 类目"}
        description={pendingCategory?.descriptionCategoryId == null
          ? `清除后${shared ? "本商品各规格" : "当前规格"}的 Ozon 配置将暂停使用。已保存的字段会保留，重新选择相同类目后可恢复；商品信息与识图事实保留。`
          : shared ? "更改会应用到本商品全部规格，清空已保存的 Ozon 字段并按新类目重新读取。各规格的商品信息、识图事实和固定标签保留。"
          : "更改仅应用到当前规格，清空已保存的 Ozon 字段并按新类目重新读取。商品信息、识图事实和固定标签保留。"}
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

/**
 * 「同款规格」详情抽屉：这件商品当前的同款分组、真实规格值与整组成员。
 *
 * 这里只读——写入入口在 products-variant-dialog.tsx；详情面板不可写是本功能的
 * 既有约定（product-expand.tsx 同）。数据来自预览端点对单件商品的定向读取：
 * 列表镜像只给分组观察列，组里还有谁必须问服务端。
 */
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"

import type { StoreProductRow } from "./products-api"
import { VariantPreviewPane } from "./products-variant-body"
import { buildVariantPreviewRequest } from "./products-variant-model"
import { useVariantPreview } from "./products-variant-preview"

export function ProductVariantDetailSheet({
  row,
  scopeKey,
  onClose,
}: {
  row: StoreProductRow | null
  /** 工作空间 + 店铺：变了就是在途读取作废，晚到回包不能重填。 */
  scopeKey: string
  onClose: () => void
}) {
  const request = row
    ? buildVariantPreviewRequest({ storeId: row.store_id, action: "merge", rows: [row] })
    : null
  const { state, reload } = useVariantPreview({
    enabled: row !== null,
    scopeKey,
    request,
    failureCopy: "无法读取这件商品的同款规格，请稍后重试。",
  })
  return (
    <Sheet open={row !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent size="detail" aria-label={row ? `${row.offer_id} 的同款规格` : "同款规格"}>
        <SheetHeader>
          <SheetTitle>同款规格</SheetTitle>
          <SheetDescription>
            {row ? `${row.name ?? "未命名商品"} · ${row.offer_id} · ${row.store_name}` : ""}
          </SheetDescription>
        </SheetHeader>
        {row ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-4 pb-4">
            <VariantPreviewPane state={state} onRetry={reload} />
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

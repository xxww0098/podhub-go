/**
 * 商品表的「同款」列：展示分组观察事实。
 *
 * 事实直接来自列表 DTO 的 `modelId` / `modelCount`（Ozon 的观察值）；缺席即未知，
 * 列读「—」或「已成组」，绝不补零。
 */
import type { StoreProductRow } from "./products-api"
import { groupCellView, rowGroupFacts } from "./products-variant-model"

export function ProductVariantCell({ row }: { row: StoreProductRow }) {
  const view = groupCellView(rowGroupFacts(row))
  return (
    <span className="truncate text-xs text-muted-foreground" title={view.hint}>
      {view.text}
    </span>
  )
}

/**
 * 商品表的「同款」列：分组观察事实 + 打开同款规格详情的入口。
 *
 * 事实直接来自列表 DTO 的 `modelId` / `modelCount`（Ozon 的观察值）；缺席即未知，
 * 列读「—」或「已成组」，绝不补零。详情走只读抽屉
 * （products-variant-detail.tsx）：这一列没有任何写入入口。
 */
import { Layers } from "lucide-react"

import type { StoreProductRow } from "./products-api"
import { groupCellView, rowGroupFacts } from "./products-variant-model"

export function ProductVariantCell({
  row,
  onOpen,
}: {
  row: StoreProductRow
  /** 不传时这一格是纯文本（行测试与只读观察面不必接详情）。 */
  onOpen?: (row: StoreProductRow) => void
}) {
  const view = groupCellView(rowGroupFacts(row))
  if (!onOpen) {
    return (
      <span className="truncate text-xs text-muted-foreground" title={view.hint}>
        {view.text}
      </span>
    )
  }
  return (
    <button
      type="button"
      title={view.hint}
      aria-label={`查看 ${row.offer_id} 的同款规格`}
      onClick={() => onOpen(row)}
      className="flex w-fit max-w-full cursor-pointer items-center gap-1 rounded-sm text-left text-xs underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Layers className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{view.text}</span>
    </button>
  )
}

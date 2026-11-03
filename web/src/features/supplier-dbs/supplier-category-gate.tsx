/** 类目是 Ozon 字段与 AI 识图的前置输入；未选时只留一个明确的下一步。 */
import { ListTree } from "lucide-react"

import { Button } from "@/components/ui/button"

export function SupplierCategoryGate({
  title = "先选择 Ozon 类目",
  description,
  actionLabel = "去选择类目",
  onAction,
}: {
  title?: string
  description: string
  actionLabel?: string
  onAction: () => void
}) {
  return (
    <div
      className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-muted/20 p-4"
      data-supplier-category-gate=""
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full border border-border bg-card">
          <ListTree aria-hidden className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <p className="text-compact font-medium">{title}</p>
          <p className="mt-1 text-meta leading-5 text-muted-foreground">{description}</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
        <span className="text-meta text-faint-foreground">
          类目决定字段、属性与校验规则
        </span>
        <Button type="button" variant="outline" size="sm" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}

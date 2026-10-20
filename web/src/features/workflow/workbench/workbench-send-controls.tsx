import { Send } from "lucide-react"
import type { OzonStoreView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { StoreColorId } from "../store-colors"
import { storeToneFor, storeToneStyle } from "../store-tone"
import { RIBBON_BUTTON } from "./workbench-ribbon-classes"
import { StoreAssignmentBadge } from "./store-assignment-badge"

export function sendConfirmAnnouncement(storeLabel: string, concurrentStores: number) {
  const queue =
    concurrentStores > 1 ? ` ${concurrentStores} 家店按分配量并发排队。` : ""
  return `提交到店铺 ${storeLabel}，Ozon 受理后不可撤回。商品先以库存 0 创建，不会立即开卖；发送后展示本次响应；商品信息可在 Ozon 后台查看。${queue} 未取得确定回执时，请先在 Ozon 后台核对，确认未收到后再恢复发送。`
}

export function SendConfirmFacts({
  storeLabel,
  storeIds,
  storeMap,
  assignments,
}: {
  storeLabel: string
  storeIds: readonly string[]
  storeMap: Record<string, OzonStoreView | undefined>
  assignments: Readonly<Record<string, StoreColorId>>
}) {
  const chips =
    storeIds.length > 0
      ? storeIds.map((id) => ({
          id,
          label: storeMap[id]?.label?.trim() || id,
          tone: storeToneFor(id, assignments),
        }))
      : [{ id: storeLabel, label: storeLabel, tone: undefined }]

  return (
    <div aria-hidden="true" className="grid gap-2 text-xs leading-5">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg bg-muted/70 px-2.5 py-2">
        <span className="text-foreground">提交到</span>
        {chips.map((chip) => (
          <StoreAssignmentBadge
            key={chip.id}
            tone={chip.tone}
            style={storeToneStyle(chip.tone)}
          >
            <span className="min-w-0 truncate">{chip.label}</span>
          </StoreAssignmentBadge>
        ))}
        {storeIds.length > 1 ? (
          <span className="basis-full text-meta text-muted-foreground">
            {storeIds.length} 家店按分配量并发排队
          </span>
        ) : null}
      </div>

      <p className="rounded-lg bg-st-attest-soft px-2.5 py-2 text-st-attest-ink">
        Ozon 受理后<span className="font-medium">不可撤回</span>
      </p>

      <div className="grid gap-1 rounded-lg bg-brand-soft px-2.5 py-2 text-brand-ink">
        <p>
          商品先以<span className="mx-1 rounded-md bg-card/90 px-1 py-0.5 font-medium tabular-nums">库存 0</span>创建，不会立即开卖
        </p>
        <p>
          发送后展示本次响应；商品信息可在 Ozon 后台查看
        </p>
      </div>

      <p className="text-meta leading-4 text-muted-foreground">
        未取得确定回执时，请先在 Ozon 后台核对，确认未收到后再恢复发送。
      </p>
    </div>
  )
}

export function SendAllButton({
  count,
  selected,
  storeLabel,
  disabled,
  onClick,
  readyBatch,
}: {
  count: number
  selected: boolean
  storeLabel: string
  concurrent: boolean
  disabled: boolean
  onClick: () => void
  readyBatch?: boolean
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="brand"
            size="sm"
            className={cn(
              RIBBON_BUTTON,
              readyBatch && !disabled && "wf-ready-pulse font-semibold shadow-sm",
            )}
            disabled={disabled || !count}
            focusableWhenDisabled
            onClick={onClick}
            aria-label={`${selected ? "发送选中" : "全部发送"}（${count}）到 ${storeLabel}`}
          >
            <Send aria-hidden />
            <span>发送 {count}</span>
          </Button>
        }
      />
      <TooltipContent>
        {count
          ? `发送 ${count} 件到 ${storeLabel}；Ozon 受理后不可撤回`
          : "没有可发送的行：打开默认字段补品牌和重量，或等准备完成"}
      </TooltipContent>
    </Tooltip>
  )
}

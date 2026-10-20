import * as React from "react"
import { ChevronDown } from "lucide-react"
import type { OzonStoreView } from "@/bindings/commands"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { cardStoreChipLabels } from "./card-store-chips"
import { cardStoreAvailability } from "./store-availability"
import { StoreCheckList } from "./store-multi-select"
import { formatStoreIds, parseStoreIds } from "./store-quota"

const VISIBLE_STORE_CHIPS = 2

/**
 * The library cell's store binding: a quiet trigger that opens the workspace
 * roster as a checklist. 勾选即关：每一次勾选/取消就是一次完整的
 * 编辑会话——弹层随即收起并立即落盘，不再要求点外部收起；card patch 是
 * 读改写 CAS，逐次提交换「勾完即生效」的直接反馈。未改任何勾选就关闭
 * （点外部 / Esc / 再点触发钮）则一次也不写。
 */
export function CardStorePicker({
  storeIdString,
  stores,
  disabled = false,
  onCommit,
  onOpenStores,
}: {
  storeIdString: string
  stores: readonly OzonStoreView[]
  disabled?: boolean
  /** Resolves true once the card's new binding is durably written. */
  onCommit: (storeIds: string[]) => Promise<boolean>
  onOpenStores?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [draftIds, setDraftIds] = React.useState<string[]>([])
  /** The in-flight write keeps showing its own selection until it lands. */
  const [committingIds, setCommittingIds] = React.useState<string[] | null>(null)

  const savedIds = parseStoreIds(storeIdString)
  const displayIds = open ? draftIds : (committingIds ?? savedIds)
  const chips = cardStoreChipLabels(displayIds.join(","), stores)
  const availability = cardStoreAvailability(displayIds.join(","), stores)
  const committing = committingIds !== null
  const bound = chips.length > 0

  /**
   * Close and, only when the selection actually changed, write it once. The
   * same path serves 勾选即关 (called with the fresh ids) and popover dismiss
   * (called with the draft) — the untouched cancel writes nothing.
   */
  function commitSelection(ids: string[]) {
    setOpen(false)
    if (formatStoreIds(ids) === formatStoreIds(savedIds)) return
    setCommittingIds(ids)
    void Promise.resolve(onCommit(ids))
      .catch(() => {})
      .finally(() => setCommittingIds(null))
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      setDraftIds(savedIds)
      setOpen(true)
      return
    }
    commitSelection(draftIds)
  }

  function handleDraftChange(next: string[]) {
    setDraftIds(next)
    commitSelection(next)
  }

  const visible = chips.slice(0, VISIBLE_STORE_CHIPS)
  const hidden = chips.slice(VISIBLE_STORE_CHIPS)
  const label = bound
    ? `店铺绑定：${chips.map((chip) => chip.label).join("、")}`
    : "绑定店铺"

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <button
            type="button"
            disabled={disabled || committing}
            aria-label={label}
            data-testid="card-store-chips"
            className={cn(
              "group/store-picker flex max-w-full cursor-pointer items-center gap-1 rounded-md text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed",
              bound || committing
                ? "-my-0.5 -ml-1 px-1 py-0.5 hover:bg-accent/70 data-popup-open:bg-accent/70"
                : "-ml-1 h-6 border border-dashed border-border-strong px-2 text-meta text-muted-foreground hover:border-brand/50 hover:text-foreground data-popup-open:border-brand/50 data-popup-open:text-foreground",
            )}
          >
            {bound || committing ? (
              <span className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap">
                {visible.map((chip) => (
                  <Badge
                    key={chip.id}
                    variant="outline"
                    className="max-w-[6.5rem] truncate"
                  >
                    {chip.label}
                  </Badge>
                ))}
                {hidden.length ? (
                  <Badge
                    variant="outline"
                    title={hidden.map((chip) => chip.label).join("、")}
                  >
                    +{hidden.length}
                  </Badge>
                ) : null}
                {availability.issue ? (
                  <span
                    className="truncate text-meta text-muted-foreground"
                    title={availability.issue.description}
                  >
                    {availability.issue.title}
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="whitespace-nowrap">绑定店铺</span>
            )}
            {committing ? (
              <Spinner
                className="size-3.5 shrink-0 text-muted-foreground"
                role="presentation"
                aria-hidden="true"
              />
            ) : (
              <ChevronDown
                aria-hidden
                className="size-3.5 shrink-0 text-muted-foreground/70 transition-[opacity,transform] duration-150 group-hover/store-picker:text-muted-foreground group-data-[popup-open]/store-picker:rotate-180"
              />
            )}
          </button>
        }
      />
      <PopoverContent
        align="start"
        sideOffset={4}
        aria-label="绑定店铺"
        className="w-64 p-1"
      >
        <StoreCheckList
          stores={stores}
          selectedStoreIds={draftIds}
          onChange={handleDraftChange}
          title="绑定店铺"
          emptyContent={
            <div className="flex flex-col items-center gap-2 py-3">
              <p className="text-xs text-muted-foreground">
                暂无店铺，先去「店铺」添加
              </p>
              {onOpenStores ? (
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setOpen(false)
                    onOpenStores()
                  }}
                >
                  打开店铺
                </Button>
              ) : null}
            </div>
          }
        />
        <p className="border-t border-border/60 px-2 pt-1.5 pb-1 text-meta text-muted-foreground">
          勾选后自动保存
        </p>
      </PopoverContent>
    </Popover>
  )
}

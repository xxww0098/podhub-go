import { Check, Store } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

import {
  defaultStoreColors,
  reassignStoreColor,
  STORE_COLOR_PALETTE,
  type StoreColorId,
  type StoreColorPreferences,
} from "./store-colors"
import type { StoreQuotaSlice } from "./store-quota"
import { storeToneFor, storeToneStyle } from "./store-tone"

export type StoreQuotaPickerProps = {
  /** One slice per bound store, from `calculateSequentialStoreSlices`. */
  storeSlices: StoreQuotaSlice[]
  rowCount: number
  storeMap: Readonly<Record<string, { label?: string } | undefined>>
  boundStoreIds: string[]
  storeColorAssignments: Readonly<Record<string, StoreColorId>>
  storeColorPreferences: StoreColorPreferences
  colorPickerStoreId: string | undefined
  onColorPickerChange: (storeId: string | undefined) => void
  onUpdateStoreColors: (next: StoreColorPreferences) => void
  onQuotaChange?: (storeId: string, quota: number) => void
  onEvenSplitQuotas?: () => void
  /** Ribbon button chrome, owned by the workbench toolbar. */
  className?: string
  disabled: boolean
}

/**
 * Per-store quota and colour picker for the workbench action ribbon.
 *
 * The rows are split across the stores bound to the card; each store gets a
 * quota, a palette colour and an even-split shortcut. Only the popover lives
 * here — the ribbon keeps the button that opens it.
 */
export function StoreQuotaPicker({
  storeSlices,
  rowCount,
  storeMap,
  boundStoreIds,
  storeColorAssignments,
  storeColorPreferences,
  colorPickerStoreId,
  onColorPickerChange,
  onUpdateStoreColors,
  onQuotaChange,
  onEvenSplitQuotas,
  className,
  disabled,
}: StoreQuotaPickerProps) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={className}
            disabled={disabled}
            aria-label="分配店铺上架量"
            title="按表格顺序分配各店铺上架量"
          >
            <Store aria-hidden />
            <span>{storeSlices.map((slice) => slice.quota).join("/")}</span>
          </Button>
        }
      />
      <PopoverContent aria-label="店铺上架量分配" className="w-80">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-compact font-semibold text-foreground">店铺上架量</p>
            <p className="mt-0.5 text-meta leading-4 text-muted-foreground">
              共 {rowCount} 件，按表序分配
            </p>
          </div>
          {onEvenSplitQuotas ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="h-7 text-meta"
              disabled={disabled}
              onClick={onEvenSplitQuotas}
            >
              均分
            </Button>
          ) : null}
        </div>
        {rowCount > 0 ? (
          <div className="mt-2.5">
            <div
              role="img"
              aria-label={`店铺分配比例：${storeSlices.map((s) => `${storeMap[s.storeId]?.label || s.storeId} ${s.quota} 件`).join("，")}`}
              className="flex h-2 w-full overflow-hidden rounded-full bg-muted/70 p-0.5 gap-0.5"
            >
              {storeSlices.map((slice) => {
                if (slice.quota <= 0) return null
                const tone = storeToneFor(slice.storeId, storeColorAssignments)
                const percent = Math.round((slice.quota / rowCount) * 100)
                return (
                  <div
                    key={slice.storeId}
                    style={{
                      flexGrow: slice.quota,
                      backgroundColor: tone?.color ?? "var(--muted-foreground)",
                    }}
                    title={`${storeMap[slice.storeId]?.label || slice.storeId}：${slice.quota} 件 (${percent}%)`}
                    className="wf-quota-transition h-full rounded-full"
                  />
                )
              })}
              {Math.max(0, rowCount - storeSlices.reduce((sum, s) => sum + s.quota, 0)) > 0 ? (
                <div
                  style={{
                    flexGrow: Math.max(0, rowCount - storeSlices.reduce((sum, s) => sum + s.quota, 0)),
                  }}
                  title={`未分配：${Math.max(0, rowCount - storeSlices.reduce((sum, s) => sum + s.quota, 0))} 件`}
                  className="wf-quota-transition h-full rounded-full bg-muted-foreground/25"
                />
              ) : null}
            </div>
          </div>
        ) : null}
        <div className="mt-3 grid gap-2">
          {storeSlices.map((slice) => {
            const sLabel = storeMap[slice.storeId]?.label || slice.storeId
            const colorId = storeColorAssignments[slice.storeId]
            const storeTone = storeToneFor(slice.storeId, storeColorAssignments)
            const pickerOpen = colorPickerStoreId === slice.storeId
            return (
              <div
                key={slice.storeId}
                style={storeToneStyle(storeTone)}
                className={cn(
                  "rounded-lg border px-2.5 py-2",
                  storeTone
                    ? "store-assignment-panel"
                    : "border-border/80 bg-muted/25",
                )}
              >
                <div className="grid grid-cols-[minmax(0,1fr)_28px_64px] items-center gap-2">
                  <span className="flex min-w-0 items-start gap-2">
                    {storeTone ? (
                      <span
                        aria-hidden
                        className="mt-1 size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: "var(--store-tone)" }}
                      />
                    ) : null}
                    <span className="min-w-0">
                      <span className="block truncate text-compact font-medium text-foreground">
                        {sLabel}
                      </span>
                      <span className="block text-meta tabular-nums text-muted-foreground">
                        {slice.quota > 0
                          ? `第 ${slice.startPosition}–${slice.endPosition} 件`
                          : "暂不分配"}
                      </span>
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label={`更换 ${sLabel} 背景色，当前${storeTone?.label ?? "默认色"}`}
                    aria-expanded={pickerOpen}
                    className="grid size-7 place-items-center rounded-md border border-border bg-card outline-none transition-colors hover:border-border-strong focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30"
                    onClick={() =>
                      onColorPickerChange(pickerOpen ? undefined : slice.storeId)
                    }
                  >
                    <span
                      aria-hidden
                      className="size-3.5 rounded-full border border-black/10"
                      style={{ backgroundColor: "var(--store-tone)" }}
                    />
                  </button>
                  <span className="relative">
                    <input
                      type="number"
                      aria-label={`${sLabel} 上架量`}
                      min={0}
                      max={rowCount}
                      value={slice.quota}
                      disabled={disabled}
                      onChange={(event) =>
                        onQuotaChange?.(slice.storeId, Number(event.target.value))
                      }
                      className="h-8 w-full rounded-md border border-input bg-card px-2 pr-6 text-right font-mono text-compact tabular-nums outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:opacity-50"
                    />
                    <span className="pointer-events-none absolute inset-y-0 right-2 grid place-items-center text-meta text-muted-foreground">
                      件
                    </span>
                  </span>
                </div>
                {pickerOpen ? (
                  <div className="mt-2 border-t border-border/60 pt-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-meta font-medium text-foreground">
                        表格背景色
                      </span>
                      <button
                        type="button"
                        className="text-meta text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                        onClick={() => {
                          onUpdateStoreColors(
                            defaultStoreColors(
                              storeColorPreferences,
                              boundStoreIds,
                            ),
                          )
                          onColorPickerChange(undefined)
                        }}
                      >
                        恢复默认配色
                      </button>
                    </div>
                    <div
                      role="radiogroup"
                      aria-label={`${sLabel} 表格背景色`}
                      className="mt-2 grid grid-cols-8 gap-1.5"
                    >
                      {STORE_COLOR_PALETTE.map((tone) => {
                        const selected = tone.id === colorId
                        const occupiedStoreId = boundStoreIds.find(
                          (id) =>
                            id !== slice.storeId &&
                            storeColorAssignments[id] === tone.id,
                        )
                        const occupied = Boolean(occupiedStoreId)
                        const occupiedStoreLabel = occupiedStoreId
                          ? storeMap[occupiedStoreId]?.label || occupiedStoreId
                          : undefined
                        return (
                          <button
                            key={tone.id}
                            type="button"
                            role="radio"
                            aria-checked={selected}
                            disabled={occupied}
                            aria-disabled={occupied ? "true" : undefined}
                            aria-label={
                              occupied
                                ? `${tone.label}（已由 ${occupiedStoreLabel} 占用，不可选）`
                                : `${tone.label}${selected ? "，当前颜色" : ""}`
                            }
                            title={
                              occupied
                                ? `${tone.label}（已由 ${occupiedStoreLabel} 占用）`
                                : tone.label
                            }
                            className={cn(
                              "grid size-7 place-items-center rounded-md border bg-card outline-none transition-[border-color,transform,opacity]",
                              occupied
                                ? "cursor-not-allowed border-dashed border-border opacity-30"
                                : selected
                                  ? "border-foreground"
                                  : "border-border hover:border-border-strong active:scale-95 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 motion-reduce:transform-none",
                            )}
                            onClick={() => {
                              if (occupied) return
                              onUpdateStoreColors(
                                reassignStoreColor(
                                  storeColorPreferences,
                                  boundStoreIds,
                                  slice.storeId,
                                  tone.id,
                                ),
                              )
                            }}
                          >
                            <span
                              aria-hidden
                              className={cn(
                                "grid size-4 place-items-center rounded-full border border-black/10",
                                occupied && "opacity-60",
                              )}
                              style={{ backgroundColor: tone.color }}
                            >
                              {selected ? (
                                <Check className="size-3 text-white drop-shadow-sm" />
                              ) : null}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="mt-1.5 text-meta leading-4 text-muted-foreground">
                      每种颜色只能分给一家店铺
                    </p>
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}

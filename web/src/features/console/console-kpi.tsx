import { cn } from "@/lib/utils"

/**
 * 迷你柱列 — 纯 DOM 柱条，按最大值归一。用于「7 日每日上架」这类小序列。
 */
export function MiniBars({
  values,
  className,
}: {
  values: number[]
  className?: string
}) {
  const max = Math.max(...values, 0)
  if (values.length === 0 || max <= 0) return null
  return (
    <div aria-hidden className={cn("flex h-7.5 items-end gap-1", className)}>
      {values.map((value, index) => (
        <span
          key={index}
          className="w-0.5 rounded-sm bg-current opacity-70"
          style={{ height: `${Math.max(0, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  )
}

/** 额度占用的细长进度条。 */
export function QuotaMeter({ ratio }: { ratio: number }) {
  const pct = Math.min(100, Math.max(0, ratio * 100))
  return (
    <div className="w-24">
      <div
        aria-hidden
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted/70"
      >
        <span
          className={cn(
            "block h-full rounded-full transition-[width] duration-300",
            pct >= 90 ? "bg-st-bad" : "bg-st-flight",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="mt-1 text-right font-mono text-meta tabular-nums text-muted-foreground">
        {pct.toFixed(1)}%
      </p>
    </div>
  )
}

import type { ReactNode } from "react"
import { RefreshCw, type LucideIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

import { formatSignedPercent } from "./console-format"

/** KPI 量值配色 — 数值颜色是账本事实，不是装饰。 */
const METRIC_TONES = {
  neutral: {
    icon: "border-border/70 bg-muted/60 text-foreground/80 group-hover:bg-muted group-hover:text-foreground",
  },
  brand: {
    icon: "border-brand/30 bg-brand/10 text-brand",
  },
  good: {
    icon: "border-st-good/30 bg-st-good/10 text-st-good",
  },
  attention: {
    icon: "border-st-attest/30 bg-st-attest-soft text-st-attest-ink",
  },
  flight: {
    icon: "border-st-flight/30 bg-st-flight-soft text-st-flight-ink",
  },
} as const

export type MetricTone = keyof typeof METRIC_TONES

/**
 * 一张 KPI 卡：左上图标 + 标签，右上徽标或刷新钮，大号量值，底部一行
 * 脚注；`visual` 是贴在右下角的迷你图（sparkline / mini bars / 进度条）。
 */
export function MetricCard({
  icon: Icon,
  label,
  value,
  unit,
  footnote,
  trendBadge,
  onRefresh,
  refreshDisabled = false,
  refreshing = false,
  tone = "neutral",
  visual,
}: {
  icon: LucideIcon
  label: string
  value: ReactNode
  unit: string
  footnote?: ReactNode
  trendBadge?: ReactNode
  onRefresh?: () => void
  refreshDisabled?: boolean
  refreshing?: boolean
  tone?: MetricTone
  visual?: ReactNode
}) {
  const tones = METRIC_TONES[tone]
  return (
    <div className="group relative flex flex-col justify-between overflow-hidden rounded-xl border border-border/80 bg-card p-4 transition-all duration-150 hover:border-border-strong hover:shadow-xs">
      <div className="flex flex-col gap-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <span
              className={cn(
                "grid size-6.5 place-items-center rounded-md border transition-colors",
                tones.icon,
              )}
            >
              <Icon className="size-3.5" />
            </span>
            <span className="truncate">{label}</span>
          </span>
          <span className="flex items-center gap-1">
            {trendBadge}
            {onRefresh ? (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="cursor-pointer"
                aria-label={`刷新${label}`}
                disabled={refreshDisabled || refreshing}
                onClick={onRefresh}
              >
                <RefreshCw aria-hidden className={refreshing ? "animate-spin" : undefined} />
              </Button>
            ) : null}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 pt-0.5">
          <span className="font-mono text-2xl font-bold tracking-tight tabular-nums text-foreground">
            {value}
          </span>
          {unit ? <span className="text-xs text-muted-foreground">{unit}</span> : null}
        </div>
      </div>
      <div className="mt-3 flex items-end justify-between gap-3 border-t border-border/50 pt-2.5">
        {footnote ? (
          <div className="min-w-0 text-xs leading-relaxed text-muted-foreground">{footnote}</div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}
        {visual ? <div className="shrink-0">{visual}</div> : null}
      </div>
    </div>
  )
}

/**
 * 迷你走势 — 纯 SVG 面积线，不开 echarts 实例。点的水平分布按索引均分，
 * 纵向按最大值归一；全零序列画一条底线。
 */
export function Sparkline({
  values,
  className,
}: {
  values: number[]
  className?: string
}) {
  const width = 96
  const height = 30
  const pad = 2
  const max = Math.max(...values, 0)
  const step = values.length > 1 ? (width - pad * 2) / (values.length - 1) : 0
  const points = values.map((value, index) => {
    const x = pad + index * step
    const y = max > 0 ? pad + (1 - value / max) * (height - pad * 2) : height - pad
    return [x, y] as const
  })
  const line = points.map(([x, y]) => `${x},${y}`).join(" ")
  const area =
    points.length > 0
      ? `${pad},${height - pad} ${line} ${width - pad},${height - pad}`
      : ""
  if (points.length === 0) return null
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${width} ${height}`}
      className={cn("h-7.5 w-24 overflow-visible", className)}
    >
      <polygon points={area} fill="currentColor" opacity={0.12} />
      <polyline
        points={line}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {points.map(([x, y], index) =>
        index === points.length - 1 ? (
          <circle key={index} cx={x} cy={y} r={2} fill="currentColor" />
        ) : null,
      )}
    </svg>
  )
}

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
  if (values.length === 0) return null
  return (
    <div aria-hidden className={cn("flex h-7.5 items-end gap-1", className)}>
      {values.map((value, index) => (
        <span
          key={index}
          className="w-1.5 rounded-sm bg-current opacity-70"
          style={{ height: `${max > 0 ? Math.max(8, (value / max) * 100) : 8}%` }}
        />
      ))}
    </div>
  )
}

/** 环比百分比徽标：上行绿、下行红、持平灰。 */
export function DeltaBadge({ pct }: { pct: number }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-mono text-meta font-medium tabular-nums",
        pct > 0
          ? "bg-st-good/15 text-st-good"
          : pct < 0
            ? "bg-destructive/15 text-destructive"
            : "bg-muted text-muted-foreground",
      )}
    >
      {formatSignedPercent(pct)}
      {pct > 0 ? " ↑" : pct < 0 ? " ↓" : ""}
    </span>
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

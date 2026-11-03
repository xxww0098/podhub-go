import { useEffect, useMemo } from "react"
import { BarChart, LineChart, PieChart } from "echarts/charts"
import {
  AriaComponent,
  GridComponent,
  TooltipComponent,
} from "echarts/components"
import * as echarts from "echarts/core"
import type { EChartsOption } from "echarts"
import { SVGRenderer } from "echarts/renderers"

import { cssColor, useEchart, useThemeRevision } from "@/lib/echarts-host"
import { formatShortDay } from "@/lib/format"
import { cn } from "@/lib/utils"

import type { LifecycleSlice } from "./console-products"

echarts.use([
  AriaComponent,
  BarChart,
  GridComponent,
  LineChart,
  PieChart,
  SVGRenderer,
  TooltipComponent,
])

type ChartPalette = {
  foreground: string
  muted: string
  faint: string
  border: string
  card: string
  flight: string
  good: string
  bad: string
  idle: string
  unknown: string
  attest: string
  font: string
  mono: string
}

export function readPalette(): ChartPalette {
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  return {
    foreground: cssColor(root, "--foreground", "#26272b"),
    muted: cssColor(root, "--muted-foreground", "#73757c"),
    faint: cssColor(root, "--faint-foreground", "#909198"),
    border: cssColor(root, "--border", "#e5e4e1"),
    card: cssColor(root, "--card", "#ffffff"),
    flight: cssColor(root, "--st-flight", "#2864e8"),
    good: cssColor(root, "--st-good", "#15976c"),
    bad: cssColor(root, "--st-bad", "#d04d38"),
    idle: cssColor(root, "--st-idle", "#8a8577"),
    unknown: cssColor(root, "--st-unknown", "#8750c7"),
    attest: cssColor(root, "--st-attest", "#b5792a"),
    font: body.fontFamily || "system-ui, sans-serif",
    mono: '"SFMono-Regular", Menlo, Consolas, "PT Mono", "Liberation Mono", Courier, monospace',
  }
}

export function chartAnimation(
  reducedMotion: boolean,
  duration: number,
  updateDuration: number,
) {
  return {
    animation: !reducedMotion,
    animationDuration: reducedMotion ? 0 : duration,
    animationDurationUpdate: reducedMotion ? 0 : updateDuration,
    animationEasing: "cubicOut" as const,
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  )
}

const chartNumber = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 })

/** One point on the sales/listing trend — both series share the UTC day key. */
export type SalesTrendPoint = {
  day: string
  orderedUnits: number
  listedUnits: number
}

export function salesTrendDescription(points: SalesTrendPoint[], includeListings = true): string {
  return `近 ${points.length} 日出单与上架提交走势：${points
    .map(
      (point) =>
        `${point.day} 出单 ${chartNumber.format(point.orderedUnits)} 件${includeListings ? `、上架提交 ${chartNumber.format(point.listedUnits)} 次` : ""}`,
    )
    .join("；")}${includeListings ? "" : "；上架提交记录可能不完整，未绘制"}`
}

export function lifecycleDonutDescription(
  slices: LifecycleSlice[],
  total: number,
): string {
  return `商品生命周期分布，共 ${chartNumber.format(total)} 件：${slices
    .map((slice) => `${slice.label} ${chartNumber.format(slice.value)}`)
    .join("；")}`
}

function EChart({
  label,
  option,
  active,
  className,
}: {
  label: string
  option: (palette: ChartPalette, reducedMotion: boolean) => EChartsOption
  active: boolean
  className?: string
}) {
  const { hostRef, chartRef } = useEchart()
  const themeRevision = useThemeRevision()

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(option(readPalette(), prefersReducedMotion()), {
      notMerge: true,
      lazyUpdate: true,
    })
    if (active) requestAnimationFrame(() => chart.resize())
  }, [active, option, themeRevision])

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={label}
      className={cn("min-h-0 min-w-0", className)}
    />
  )
}

/** Empty axes retain the chart's structure without showing fabricated counts. */
export function EmptySalesTrendChart({ active }: { active: boolean }) {
  const option = useMemo(() => (palette: ChartPalette): EChartsOption => ({
    animation: false,
    grid: { top: 16, right: 8, bottom: 16, left: 16 },
    xAxis: { type: "value", min: 0, max: 1, splitNumber: 10, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.border } }, splitLine: { lineStyle: { color: palette.border, type: "dashed" } } },
    yAxis: { type: "value", min: 0, max: 1, splitNumber: 4, axisLabel: { show: false }, axisTick: { show: false }, axisLine: { lineStyle: { color: palette.border } }, splitLine: { lineStyle: { color: palette.border, type: "dashed" } } },
    series: [],
  }), [])
  return <div className="relative min-h-62.5 flex-1">
    <EChart label="暂无可绘制的每日数据" option={option} active={active} className="absolute inset-0" />
    <p aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center text-sm text-muted-foreground">暂无可绘制的每日数据</p>
  </div>
}

/**
 * 出单量（蓝，面积）× 上架量（紫）双线趋势。出单是 Ozon 店铺事实，上架是
 * 本地账本事实——两条线口径不同，legend 在面板头部用文字标明单位。
 */
export function SalesTrendChart({
  points,
  active,
  salesStyle = "line",
  includeListings = true,
}: {
  points: SalesTrendPoint[]
  active: boolean
  salesStyle?: "line" | "bar"
  includeListings?: boolean
}) {
  const description = useMemo(() => salesTrendDescription(points, includeListings), [points, includeListings])
  const option = useMemo(
    () => (palette: ChartPalette, reducedMotion: boolean): EChartsOption => ({
      ...chartAnimation(reducedMotion, 360, 240),
      aria: { enabled: true, description },
      textStyle: { color: palette.muted, fontFamily: palette.font },
      tooltip: {
        trigger: "axis",
        confine: true,
        valueFormatter: (value) => chartNumber.format(Number(value)),
        backgroundColor: palette.card,
        borderColor: palette.border,
        borderWidth: 1,
        textStyle: { color: palette.foreground, fontFamily: palette.font, fontSize: 12 },
      },
      grid: { top: 16, right: 8, bottom: 4, left: 0, containLabel: true },
      xAxis: {
        type: "category",
        boundaryGap: salesStyle === "bar",
        data: points.map((point) => formatShortDay(point.day)),
        axisLine: { lineStyle: { color: palette.border } },
        axisTick: { show: false },
        axisLabel: {
          color: palette.faint,
          fontFamily: palette.mono,
          fontSize: 10,
          interval: salesStyle === "bar" && points.length > 8 ? 1 : 0,
        },
      },
      yAxis: {
        type: "value",
        min: 0,
        minInterval: 1,
        splitNumber: 3,
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: palette.faint, fontFamily: palette.mono, fontSize: 10 },
        splitLine: { lineStyle: { color: palette.border, type: "dashed", opacity: 0.9 } },
      },
      series: [
        {
          name: "出单量（件）",
          ...(salesStyle === "bar" ? {
            type: "bar" as const,
            barMaxWidth: 18,
            itemStyle: { color: palette.flight, borderRadius: [2, 2, 0, 0] },
          } : {
            type: "line" as const,
            smooth: 0.1,
            showSymbol: true,
            symbol: "circle",
            symbolSize: 7,
            lineStyle: { color: palette.flight, width: 2 },
            itemStyle: { color: palette.flight, borderColor: palette.card, borderWidth: 2 },
            areaStyle: { color: palette.flight, opacity: 0.1 },
          }),
          emphasis: { focus: "series" },
          data: points.map((point) => point.orderedUnits),
        },
        ...(includeListings ? [{
          name: "上架提交（次）",
          type: "line" as const,
          smooth: 0.1,
          showSymbol: salesStyle !== "bar",
          symbol: "circle",
          symbolSize: 7,
          lineStyle: { color: palette.unknown, width: 2 },
          itemStyle: { color: palette.unknown, borderColor: palette.card, borderWidth: 2 },
          ...(salesStyle === "line" ? { areaStyle: { color: palette.unknown, opacity: 0.06 } } : {}),
          emphasis: { focus: "series" as const },
          data: points.map((point) => point.listedUnits),
        }] : []),
      ],
    }),
    [description, includeListings, points, salesStyle],
  )

  return (
    <EChart
      label={description}
      option={option}
      active={active}
      className={cn(salesStyle === "bar" ? "min-h-48" : "min-h-62.5", "flex-1 w-full")}
    />
  )
}


/** Ledger UTC intake/settlement/exceptions reuse the same theme and chart host. */
export function LedgerTrendChart({ summary, active }: {
  summary: import("./console-metrics").LedgerSummary
  active: boolean
}) {
  const description = "最近 14 个 UTC 日账本趋势：" + summary.series.map((point) =>
    point.key + " 新增 " + point.intake + "、收敛 " + point.settled + "、异常 " + point.exceptions,
  ).join("；")
  const option = useMemo(() => (palette: ChartPalette, reducedMotion: boolean): EChartsOption => ({
    ...chartAnimation(reducedMotion, 360, 240),
    aria: { enabled: true, description },
    textStyle: { color: palette.muted, fontFamily: palette.font },
    tooltip: { trigger: "axis", confine: true, backgroundColor: palette.card,
      borderColor: palette.border, textStyle: { color: palette.foreground, fontFamily: palette.font } },
    grid: { top: 12, right: 12, bottom: 8, left: 8, containLabel: true },
    xAxis: { type: "category", data: summary.series.map((point) => point.label),
      axisLine: { lineStyle: { color: palette.border } }, axisTick: { show: false },
      axisLabel: { color: palette.faint, fontFamily: palette.mono, interval: 1 } },
    yAxis: { type: "value", min: 0, minInterval: 1, axisTick: { show: false },
      axisLabel: { color: palette.faint, fontFamily: palette.mono },
      splitLine: { lineStyle: { color: palette.border, type: "dashed" } } },
    series: ([
      { key: "intake", name: "新上架", color: palette.attest },
      { key: "settled", name: "已收敛", color: palette.good },
      { key: "exceptions", name: "待介入", color: palette.bad },
    ] as const).map(({ key, name, color }) => ({
      name, type: "line", symbol: "circle", symbolSize: 5,
      lineStyle: { color, width: 2 }, itemStyle: { color },
      data: summary.series.map((point) => point[key]),
    })),
  }), [description, summary.series])
  return <EChart label={description} option={option} active={active} className="min-h-62.5 w-full flex-1" />
}

const LIFECYCLE_TONES = {
  good: "flight",
  attest: "unknown",
  bad: "bad",
  idle: "idle",
} as const satisfies Record<LifecycleSlice["tone"], keyof ChartPalette>

const PLATFORM_LIFECYCLE_TONES = {
  good: "good",
  attest: "flight",
  bad: "bad",
  idle: "idle",
} as const satisfies Record<LifecycleSlice["tone"], keyof ChartPalette>

export function lifecycleColorTone(tone: LifecycleSlice["tone"], paletteMode: "default" | "platform" = "default") {
  return (paletteMode === "platform" ? PLATFORM_LIFECYCLE_TONES : LIFECYCLE_TONES)[tone]
}

/**
 * 商品生命周期环图 — 只画环；中心总数由面板用 DOM 覆盖，保证 tabular-nums
 * 排版与文案语义一致。
 */
export function LifecycleDonutChart({
  slices,
  total,
  active,
  paletteMode = "default",
  className,
}: {
  slices: LifecycleSlice[]
  total: number
  active: boolean
  paletteMode?: "default" | "platform"
  className?: string
}) {
  const description = useMemo(
    () => lifecycleDonutDescription(slices, total),
    [slices, total],
  )
  const option = useMemo(
    () => (palette: ChartPalette, reducedMotion: boolean): EChartsOption => ({
      ...chartAnimation(reducedMotion, 420, 260),
      aria: { enabled: true, description },
      tooltip: {
        trigger: "item",
        confine: true,
        formatter: "{b}<br/>{c} 件 · {d}%",
        backgroundColor: palette.card,
        borderColor: palette.border,
        borderWidth: 1,
        textStyle: { color: palette.foreground, fontFamily: palette.font, fontSize: 12 },
      },
      series: [
        {
          type: "pie",
          radius: ["68%", "88%"],
          center: ["50%", "50%"],
          minAngle: 4,
          avoidLabelOverlap: true,
          label: { show: false },
          labelLine: { show: false },
          emphasis: { scaleSize: 3 },
          itemStyle: { borderColor: palette.card, borderWidth: 2, borderRadius: 2 },
          data: slices
            .filter((slice) => slice.value > 0)
            .map((slice) => ({
              name: slice.label,
              value: slice.value,
              itemStyle: { color: palette[lifecycleColorTone(slice.tone, paletteMode)] },
            })),
        },
      ],
    }),
    [description, slices, total, paletteMode],
  )

  return (
    <EChart
      label={description}
      option={option}
      active={active}
      className={cn("size-28 shrink-0", className)}
    />
  )
}

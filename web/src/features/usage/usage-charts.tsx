import { memo, useEffect, useMemo } from "react"
import { BarChart, LineChart } from "echarts/charts"
import {
  AriaComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from "echarts/components"
import * as echarts from "echarts/core"
import type { EChartsOption } from "echarts"
import { SVGRenderer } from "echarts/renderers"

import type { UsageRequestRowView } from "@/bindings/commands"
import { cssColor, useEchart, useThemeRevision } from "@/lib/echarts-host"
import { formatShortDay } from "@/lib/format"
import { formatYuan } from "@/lib/money"
import { cn } from "@/lib/utils"

echarts.use([
  AriaComponent,
  BarChart,
  GridComponent,
  LegendComponent,
  LineChart,
  SVGRenderer,
  TooltipComponent,
])

export type ChartPalette = {
  foreground: string
  muted: string
  faint: string
  border: string
  card: string
  recess: string
  input: string
  output: string
  cacheRead: string
  cacheHit: string
  flight: string
  good: string
  bad: string
  unknown: string
  tokenCached: string
  tokenUncached: string
  tokenOutput: string
  requestLine: string
  axisPointer: string
  gridLine: string
  font: string
  mono: string
}

export function readPalette(): ChartPalette {
  if (typeof document === "undefined") {
    return {
      foreground: "#26272b",
      muted: "#73757c",
      faint: "#909198",
      border: "#e5e4e1",
      card: "#ffffff",
      recess: "#f0eee8",
      input: "#716dff",
      output: "#3dbb91",
      cacheRead: "#e59b24",
      cacheHit: "#d45b9d",
      flight: "#2864e8",
      good: "#15976c",
      bad: "#d04d38",
      unknown: "#8750c7",
      tokenCached: "#86d3ff",
      tokenUncached: "#4ba6ff",
      tokenOutput: "#1677ff",
      requestLine: "#1677ff",
      axisPointer: "#d6d6d3",
      gridLine: "#f0f0ee",
      font: '"Inter Variable", ui-sans-serif, system-ui, sans-serif',
      mono: '"SFMono-Regular", Menlo, Consolas, "PT Mono", "Liberation Mono", Courier, monospace',
    }
  }
  const root = getComputedStyle(document.documentElement)
  const body = getComputedStyle(document.body)
  const isDark = document.documentElement.classList.contains("dark")

  return {
    foreground: cssColor(root, "--foreground", isDark ? "#f6f4f1" : "#26272b"),
    muted: cssColor(root, "--muted-foreground", isDark ? "#c9c3bb" : "#73757c"),
    faint: cssColor(root, "--faint-foreground", isDark ? "#9c958d" : "#909198"),
    border: cssColor(root, "--border", isDark ? "rgba(255, 255, 255, 0.1)" : "#e5e4e1"),
    card: cssColor(root, "--card", isDark ? "#1c1c1f" : "#ffffff"),
    recess: cssColor(root, "--muted", isDark ? "#242428" : "#f0eee8"),
    input: isDark ? "#8d89ff" : "#716dff",
    output: isDark ? "#4fc9a1" : "#3dbb91",
    cacheRead: isDark ? "#f2b84b" : "#e59b24",
    cacheHit: isDark ? "#f07dbb" : "#d45b9d",
    flight: cssColor(root, "--st-flight", "#2864e8"),
    good: cssColor(root, "--st-good", "#15976c"),
    bad: cssColor(root, "--st-bad", "#d04d38"),
    unknown: cssColor(root, "--st-unknown", "#8750c7"),
    tokenCached: isDark ? "#6ecaff" : "#86d3ff",
    tokenUncached: isDark ? "#3b8eed" : "#4ba6ff",
    tokenOutput: isDark ? "#2979ff" : "#1677ff",
    requestLine: isDark ? "#3b82f6" : "#1677ff",
    axisPointer: isDark ? "#6f6e6a" : "#d6d6d3",
    gridLine: isDark ? "rgba(255, 255, 255, 0.08)" : "#f0f0ee",
    font: body.fontFamily || "system-ui, -apple-system, sans-serif",
    mono: '"SFMono-Regular", Menlo, Consolas, "PT Mono", "Liberation Mono", Courier, monospace',
  }
}

export function UsageEChart({
  label,
  option,
  className,
}: {
  label: string
  option: (palette: ChartPalette) => EChartsOption
  className?: string
}) {
  const { hostRef, chartRef } = useEchart()
  const themeRevision = useThemeRevision()

  useEffect(() => {
    const chart = chartRef.current
    if (!chart) return
    chart.setOption(option(readPalette()), { notMerge: true, lazyUpdate: true })
  }, [option, themeRevision])

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={label}
      className={cn("min-h-0 min-w-0", className)}
    />
  )
}

export type DailyUsagePoint = {
  date: string
  label: string
  rangeLabel: string
  isHourly: boolean
  requests: number
  input: number
  inputCached: number
  inputUncached: number
  output: number
  totalTokens: number
  costMicrofen: number
}

/**
 * Builds bucketed points across the date window:
 * - When `fromStr === toStr` (single day), generates 24 hourly buckets (00:00 ~ 23:00).
 * - When spanning multiple days, generates one bucket per calendar day.
 */
export function buildDailyPoints(
  fromStr: string,
  toStr: string,
  requests: UsageRequestRowView[],
): DailyUsagePoint[] {
  if (fromStr === toStr) {
    const buckets: DailyUsagePoint[] = []
    for (let h = 0; h < 24; h++) {
      const hourStr = String(h).padStart(2, "0")
      const nextHourStr = String(h + 1).padStart(2, "0")
      const label = `${hourStr}:00`
      const rangeLabel = `${hourStr}:00～${nextHourStr}:00`
      buckets.push({
        date: `${fromStr} ${label}`,
        label,
        rangeLabel,
        isHourly: true,
        requests: 0,
        input: 0,
        inputCached: 0,
        inputUncached: 0,
        output: 0,
        totalTokens: 0,
        costMicrofen: 0,
      })
    }

    for (const req of requests) {
      const reqDate = req.created_at.slice(0, 10)
      if (reqDate !== fromStr) continue

      let hour = 0
      if (req.created_at.length >= 13 && req.created_at[10] === "T") {
        hour = parseInt(req.created_at.slice(11, 13), 10)
      } else {
        hour = new Date(req.created_at).getUTCHours()
      }
      if (Number.isNaN(hour) || hour < 0 || hour > 23) hour = 0

      const bucket = buckets[hour]
      if (!bucket) continue

      const input = req.input_tokens
      const cached = Math.min(Math.max(0, req.cached_input_tokens ?? 0), input)
      const uncached = Math.max(0, input - cached)
      const output = req.output_tokens

      bucket.requests += 1
      bucket.input += input
      bucket.inputCached += cached
      bucket.inputUncached += uncached
      bucket.output += output
      bucket.totalTokens += input + output
      // Cost is charted in the charged split — what settlement took out of the
      // balance — never the nominal total.
      bucket.costMicrofen += req.charged_microfen
    }

    return buckets
  }

  const fromDate = new Date(fromStr + "T00:00:00Z")
  const toDate = new Date(toStr + "T00:00:00Z")

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return []
  }

  const buckets = new Map<string, DailyUsagePoint>()
  const current = new Date(fromDate)
  while (current <= toDate) {
    const date = current.toISOString().slice(0, 10)
    buckets.set(date, {
      date,
      label: formatShortDay(date),
      rangeLabel: date,
      isHourly: false,
      requests: 0,
      input: 0,
      inputCached: 0,
      inputUncached: 0,
      output: 0,
      totalTokens: 0,
      costMicrofen: 0,
    })
    current.setUTCDate(current.getUTCDate() + 1)
  }

  for (const req of requests) {
    const date = req.created_at.slice(0, 10)
    const bucket = buckets.get(date)
    if (!bucket) continue

    const input = req.input_tokens
    const cached = Math.min(Math.max(0, req.cached_input_tokens ?? 0), input)
    const uncached = Math.max(0, input - cached)
    const output = req.output_tokens

    bucket.requests += 1
    bucket.input += input
    bucket.inputCached += cached
    bucket.inputUncached += uncached
    bucket.output += output
    bucket.totalTokens += input + output
    bucket.costMicrofen += req.charged_microfen
  }

  return Array.from(buckets.values())
}

function cleanFixed(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "")
}

export function formatUsageNumber(num: number | null | undefined): string {
  const value = num ?? 0
  if (value === 0) return "0"
  if (value >= 100_000_000) return cleanFixed(value / 100_000_000) + "亿"
  if (value >= 10_000) return cleanFixed(value / 10_000) + "万"
  return value.toLocaleString("zh-CN")
}

/**
 * Formats Y-axis values in compact notation (e.g. 44K, 22K, 0, 8, 4).
 */
export function formatCompactAxisNumber(value: number): string {
  if (value === 0) return "0"
  if (Math.abs(value) >= 1_000_000_000) {
    return cleanFixed(value / 1_000_000_000) + "B"
  }
  if (Math.abs(value) >= 1_000_000) {
    return cleanFixed(value / 1_000_000) + "M"
  }
  if (Math.abs(value) >= 1_000) {
    return cleanFixed(value / 1_000) + "K"
  }
  return value.toLocaleString("zh-CN")
}

/** 1 元 = 10^8 microfen；图表按元作图，卡面标题仍打 ¥。 */
const MICROFEN_PER_YUAN = 100_000_000

/**
 * Money on an axis, not in a cell: no ¥ (the card title carries the unit) and
 * no fixed width.
 */
function formatYuanAxis(value: number): string {
  if (value === 0) return "0"
  if (Math.abs(value) >= 1_000) {
    return Math.round(value).toLocaleString("zh-CN")
  }
  return value.toFixed(4).replace(/\.?0+$/, "")
}

/**
 * Shared chart frame with clean axes, 3 horizontal splitlines, and responsive ticks.
 */
function chartFrame(palette: ChartPalette, points: DailyUsagePoint[]) {
  const isHourly = points[0]?.isHourly ?? false

  return {
    animationDuration: 360,
    animationEasing: "cubicOut" as const,
    grid: { top: 16, right: 8, bottom: 4, left: 4, containLabel: true },
    xAxis: {
      type: "category" as const,
      boundaryGap: true,
      data: points.map((p) => p.label),
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.faint,
        fontFamily: palette.mono,
        fontSize: 11,
        interval: isHourly
          ? (index: number) => index === 0 || index === 8 || index === 15 || index === 23
          : points.length > 15
          ? 5
          : points.length > 8
          ? 2
          : 0,
      },
    },
    yAxis: {
      type: "value" as const,
      minInterval: 1,
      splitNumber: 2,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: palette.faint,
        fontFamily: palette.mono,
        fontSize: 11,
        formatter: (val: number) => formatCompactAxisNumber(val),
      },
      splitLine: {
        lineStyle: {
          color: palette.gridLine,
          type: "solid" as const,
        },
      },
    },
  }
}

function tooltipFrame(palette: ChartPalette) {
  return {
    trigger: "axis" as const,
    confine: true,
    backgroundColor: palette.card,
    borderColor: palette.border,
    borderWidth: 1,
    borderRadius: 16,
    padding: [14, 18] as [number, number],
    extraCssText:
      "box-shadow: 0 12px 32px -4px rgba(0, 0, 0, 0.12), 0 4px 12px -2px rgba(0, 0, 0, 0.05); border: 1px solid " +
      palette.border +
      ";",
    textStyle: { color: palette.foreground, fontFamily: palette.font, fontSize: 12 },
    axisPointer: {
      type: "line" as const,
      lineStyle: {
        type: "dashed" as const,
        color: palette.axisPointer,
        width: 1,
      },
    },
  }
}

/**
 * `resolveCssColor` hands back `#rrggbb` or an `rgb()/rgba()` string, so alpha
 * has to be applied to both shapes.
 */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith("#") && color.length === 7) {
    return color + Math.round(alpha * 255).toString(16).padStart(2, "0")
  }
  const channels = color.match(/[\d.]+/g)
  if (channels && channels.length >= 3) {
    return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${alpha})`
  }
  return color
}

function renderTokensTooltip(palette: ChartPalette, point: DailyUsagePoint): string {
  const title = point.isHourly ? point.rangeLabel : `${point.date} (UTC)`
  const cachedColor = palette.tokenCached
  const uncachedColor = palette.tokenUncached
  const outputColor = palette.tokenOutput
  const total = point.totalTokens.toLocaleString("zh-CN")
  const cachedVal = point.inputCached.toLocaleString("zh-CN")
  const uncachedVal = point.inputUncached.toLocaleString("zh-CN")
  const outputVal = point.output.toLocaleString("zh-CN")

  return `<div style="padding: 2px 0; min-width: 200px; font-family: ${palette.font};">
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 12px;">
      <span style="font-size: 15px; font-weight: 600; color: ${palette.foreground}; line-height: 1.2;">${title}</span>
      <span style="font-size: 16px; font-weight: 600; color: ${palette.foreground}; font-family: ${palette.mono}; line-height: 1.2;">${total}</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <span style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: ${palette.muted};">
          <span style="display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: ${cachedColor}; flex-shrink: 0;"></span>
          输入（命中缓存）
        </span>
        <span style="font-size: 13px; font-weight: 500; color: ${palette.foreground}; font-family: ${palette.mono};">${cachedVal}</span>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <span style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: ${palette.muted};">
          <span style="display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: ${uncachedColor}; flex-shrink: 0;"></span>
          输入（未命中缓存）
        </span>
        <span style="font-size: 13px; font-weight: 500; color: ${palette.foreground}; font-family: ${palette.mono};">${uncachedVal}</span>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <span style="display: flex; align-items: center; gap: 6px; font-size: 13px; color: ${palette.muted};">
          <span style="display: inline-block; width: 9px; height: 9px; border-radius: 2px; background: ${outputColor}; flex-shrink: 0;"></span>
          输出
        </span>
        <span style="font-size: 13px; font-weight: 500; color: ${palette.foreground}; font-family: ${palette.mono};">${outputVal}</span>
      </div>
    </div>
  </div>`
}

function renderRequestsTooltip(palette: ChartPalette, point: DailyUsagePoint): string {
  const title = point.isHourly ? point.rangeLabel : `${point.date} (UTC)`
  const requests = point.requests.toLocaleString("zh-CN")

  return `<div style="padding: 2px 0; min-width: 170px; font-family: ${palette.font};">
    <div style="margin-bottom: 12px;">
      <span style="font-size: 15px; font-weight: 600; color: ${palette.foreground}; line-height: 1.2;">${title}</span>
    </div>
    <div style="display: flex; align-items: center; justify-content: space-between; gap: 20px;">
      <span style="font-size: 13px; color: ${palette.muted};">请求次数</span>
      <span style="font-size: 15px; font-weight: 600; color: ${palette.foreground}; font-family: ${palette.mono};">${requests}</span>
    </div>
  </div>`
}

function renderCostTooltip(palette: ChartPalette, point: DailyUsagePoint): string {
  const title = point.isHourly ? point.rangeLabel : `${point.date} (UTC)`
  const cost = formatYuan(point.costMicrofen)
  const requests = point.requests.toLocaleString("zh-CN")

  return `<div style="padding: 2px 0; min-width: 170px; font-family: ${palette.font};">
    <div style="margin-bottom: 12px;">
      <span style="font-size: 15px; font-weight: 600; color: ${palette.foreground}; line-height: 1.2;">${title}</span>
    </div>
    <div style="display: flex; flex-direction: column; gap: 8px;">
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <span style="font-size: 13px; color: ${palette.muted};">消费金额</span>
        <span style="font-size: 14px; font-weight: 600; color: ${palette.foreground}; font-family: ${palette.mono};">${cost}</span>
      </div>
      <div style="display: flex; align-items: center; justify-content: space-between; gap: 16px;">
        <span style="font-size: 13px; color: ${palette.muted};">请求次数</span>
        <span style="font-size: 13px; font-weight: 500; color: ${palette.foreground}; font-family: ${palette.mono};">${requests}</span>
      </div>
    </div>
  </div>`
}

/** API 请求次数 —— 单序列平滑面积图。 */
export const RequestsAreaChart = memo(function RequestsAreaChart({
  points,
}: {
  points: DailyUsagePoint[]
}) {
  const option = useMemo(
    () => (palette: ChartPalette): EChartsOption => {
      const frame = chartFrame(palette, points)
      return {
        ...frame,
        xAxis: {
          ...frame.xAxis,
          boundaryGap: false,
        },
        aria: { enabled: true, description: "展示 API 请求次数走势。" },
        tooltip: {
          ...tooltipFrame(palette),
          formatter: (params: any) => {
            const point = points[Array.isArray(params) ? params[0]?.dataIndex : 0]
            if (!point) return ""
            return renderRequestsTooltip(palette, point)
          },
        },
        series: [
          {
            name: "API 请求次数",
            type: "line",
            smooth: 0.4,
            showSymbol: false,
            symbol: "circle",
            symbolSize: 7,
            itemStyle: {
              color: "#ffffff",
              borderColor: palette.requestLine,
              borderWidth: 2.5,
            },
            emphasis: {
              focus: "series",
              itemStyle: {
                color: "#ffffff",
                borderColor: palette.requestLine,
                borderWidth: 2.5,
                shadowBlur: 0,
              },
            },
            lineStyle: { color: palette.requestLine, width: 2 },
            areaStyle: {
              color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: withAlpha(palette.requestLine, 0.42) },
                { offset: 1, color: withAlpha(palette.requestLine, 0.02) },
              ]),
            },
            data: points.map((p) => p.requests),
          },
        ],
      }
    },
    [points],
  )

  return <UsageEChart label="API 请求次数走势" option={option} className="h-[220px] w-full" />
})

/** 消费金额（CNY）—— 结算费用柱状图。 */
export const CostBarChart = memo(function CostBarChart({
  points,
}: {
  points: DailyUsagePoint[]
}) {
  const option = useMemo(
    () => (palette: ChartPalette): EChartsOption => {
      const frame = chartFrame(palette, points)
      return {
        ...frame,
        aria: { enabled: true, description: "展示 Cloud AI 结算费用。" },
        yAxis: {
          ...frame.yAxis,
          minInterval: undefined,
          axisLabel: { ...frame.yAxis.axisLabel, formatter: formatYuanAxis },
        },
        tooltip: {
          ...tooltipFrame(palette),
          formatter: (params: any) => {
            const point = points[Array.isArray(params) ? params[0]?.dataIndex : 0]
            if (!point) return ""
            return renderCostTooltip(palette, point)
          },
        },
        series: [
          {
            name: "消费金额",
            type: "bar",
            barMaxWidth: 16,
            itemStyle: { color: palette.flight, borderRadius: [2, 2, 0, 0] },
            data: points.map((p) => p.costMicrofen / MICROFEN_PER_YUAN),
          },
        ],
      }
    },
    [points],
  )

  return <UsageEChart label="消费金额走势" option={option} className="h-[220px] w-full" />
})

/** Tokens —— 输入（命中缓存）/ 输入（未命中缓存）/ 输出 3层堆叠柱状图。 */
export const TokensBarChart = memo(function TokensBarChart({
  points,
}: {
  points: DailyUsagePoint[]
}) {
  const option = useMemo(
    () => (palette: ChartPalette): EChartsOption => ({
      ...chartFrame(palette, points),
      aria: { enabled: true, description: "展示输入与输出 Token 构成。" },
      tooltip: {
        ...tooltipFrame(palette),
        formatter: (params: any) => {
          const point = points[Array.isArray(params) ? params[0]?.dataIndex : 0]
          if (!point) return ""
          return renderTokensTooltip(palette, point)
        },
      },
      series: [
        {
          name: "输出",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 16,
          itemStyle: { color: palette.tokenOutput },
          data: points.map((p) => p.output),
        },
        {
          name: "输入（未命中缓存）",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 16,
          itemStyle: { color: palette.tokenUncached },
          data: points.map((p) => p.inputUncached),
        },
        {
          name: "输入（命中缓存）",
          type: "bar",
          stack: "tokens",
          barMaxWidth: 16,
          itemStyle: { color: palette.tokenCached, borderRadius: [2, 2, 0, 0] },
          data: points.map((p) => p.inputCached),
        },
      ],
    }),
    [points],
  )

  return <UsageEChart label="Token 消耗走势" option={option} className="h-[220px] w-full" />
})

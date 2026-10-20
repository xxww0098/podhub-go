/** 店铺商品表的读数展示：状态页签（即合计）、覆盖率注脚、漏斗窗口注脚。 */
import { TriangleAlert } from "lucide-react"

import { Tabs, TabsIndicator, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { formatShortDay } from "@/lib/format"
import { cn } from "@/lib/utils"

import { freshnessLabel, type ProductFreshness } from "./freshness"
import type {
  StoreProductMetrics,
  StoreProductsOverviewData,
  StoreProductStatusFilter,
} from "./products-api"

export type ProductCounts = {
  total?: number | null
  onSale?: number | null
  processing?: number | null
  hidden?: number | null
  moderationFailed?: number | null
  zeroStock?: number | null
  archived?: number | null
  delisted?: number | null
}

const ALL = "all"

const STATUS_TABS: {
  value: StoreProductStatusFilter | typeof ALL
  label: string
  pick: (counts: ProductCounts) => number | null | undefined
  tone?: "bad" | "warn"
}[] = [
  { value: ALL, label: "所有", pick: (counts) => counts.total },
  { value: "on_sale", label: "销售中", pick: (counts) => counts.onSale },
  { value: "processing", label: "准备销售", pick: (counts) => counts.processing },
  {
    value: "moderation_failed",
    label: "错误",
    pick: (counts) => counts.moderationFailed,
    tone: "bad",
  },
  // 镜像没有 Ozon 问题清单，「待修改」落在「隐藏」桶上——非在售也非待审的行。
  { value: "hidden", label: "待修改", pick: (counts) => counts.hidden, tone: "warn" },
  { value: "delisted", label: "商品已下架", pick: (counts) => counts.delisted },
  { value: "archived", label: "档案", pick: (counts) => counts.archived },
]

/** `metrics_error` codes — the funnel axis's own refusal vocabulary. */
const METRICS_ERROR_LABEL: Record<string, string> = {
  restricted: "店铺套餐不含 Ozon 分析接口",
  rate_limited: "Ozon 限流中，稍后自动重试",
  refused: "Ozon 暂未提供漏斗数据",
  invalid: "Ozon 返回的漏斗数据有误",
  unavailable: "漏斗数据暂不可用",
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "—"
  return new Date(ms).toLocaleString("zh-CN", { hour12: false })
}

/** 月/日 时:分（`09/22 10:22`）——同步窗口与漏斗时间戳的短口径，跨日才带日。
 * 同步窗口锚在莫斯科低峰（02:00–06:00 MSK），落在操作员本地时钟的任何位置，
 * 只写钟面会读错，所以带上日。 */
export function fmtWindowStamp(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
}

/** `never` / `expired` are states. A real total is the only thing that becomes a number. */
export function countLabel(
  value: number | null | undefined,
  freshness: ProductFreshness | "totals",
): string {
  if (freshness === "expired") return "未知"
  if (freshness === "never" || value == null) return "—"
  return value.toLocaleString()
}

/** Status tabs double as the totals. Clicking one filters the table. */
export function StatusTabs({
  counts,
  freshness,
  status,
  onStatus,
}: {
  counts: ProductCounts
  freshness: ProductFreshness | "totals"
  status: StoreProductStatusFilter | undefined
  onStatus: (next: StoreProductStatusFilter | undefined) => void
}) {
  return (
    <Tabs
      value={status ?? ALL}
      onValueChange={(next) => {
        if (!next || next === ALL) onStatus(undefined)
        else onStatus(next as StoreProductStatusFilter)
      }}
    >
      <TabsList variant="line" className="min-w-max" aria-label="商品状态">
        <TabsIndicator variant="line" />
        {STATUS_TABS.map((tab) => {
          const label = countLabel(tab.pick(counts), freshness)
          const notable = label !== "—" && label !== "未知" && label !== "0"
          return (
            <TabsTrigger key={tab.value} value={tab.value} variant="line" className="whitespace-nowrap">
              <span>{tab.label}</span>
              <strong
                className={cn(
                  "font-mono text-xs font-semibold tabular-nums",
                  notable && tab.tone === "bad" && "text-st-bad-ink",
                  notable && tab.tone === "warn" && "text-st-attest-ink",
                )}
              >
                {label}
              </strong>
            </TabsTrigger>
          )
        })}
      </TabsList>
    </Tabs>
  )
}

/** Coverage is one sentence under the toolbar, naming stores the totals skip. */
export function CoverageNote({
  overview,
  className,
}: {
  overview: StoreProductsOverviewData
  className?: string
}) {
  const { coverage, newest_sync_at_ms, stores } = overview
  const uncovered = stores.filter(
    (store) => store.freshness === "never" || store.freshness === "expired",
  )
  return (
    <p className={cn("text-xs text-muted-foreground", className)}>
      已统计 {coverage.read}/{coverage.total} 家店铺
      {newest_sync_at_ms ? `，最新更新 ${fmtTime(newest_sync_at_ms)}` : ""}
      {uncovered.length > 0
        ? `。未计入：${uncovered
            .map((store) => `${store.name} ${freshnessLabel(store.freshness)}`)
            .join("、")}`
        : coverage.read < coverage.total
          ? "。未计入的店铺不在合计里"
          : ""}
    </p>
  )
}

/** The funnel window's one-line caption in the card header — 「近 14 天 ·
 * 至 09-25」when a page landed, or the refusal reason when it could not. */
export function FunnelNote({
  metrics,
  metricsError,
}: {
  metrics: StoreProductMetrics | null
  metricsError: string | null
}) {
  if (metricsError) {
    return (
      <span className="ml-auto inline-flex items-center gap-1 text-xs text-st-attest-ink">
        <TriangleAlert className="size-3" aria-hidden />
        销售漏斗：{METRICS_ERROR_LABEL[metricsError] ?? "漏斗数据暂不可用"}
      </span>
    )
  }
  if (!metrics) return null
  return (
    <span className="ml-auto text-xs text-muted-foreground">
      销售漏斗：近 {metrics.period_days} 天 · 至 {formatShortDay(metrics.through_day)}
    </span>
  )
}

import { useState, type ReactNode } from "react"
import { AlertTriangle, ArrowRight, Lightbulb, Medal, Stethoscope } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

import { LifecycleDonutChart, SalesTrendChart, type SalesTrendPoint } from "./console-charts"
import { formatInteger, formatSignedPercent } from "./console-format"
import type { ConsoleAdvice, StoreRankRow } from "./console-board"
import {
  lifecycleScope,
  type StoreProductsSummary,
} from "./console-products"

/** 面板外壳：标题 + 副标题 + 右侧动作区，白卡发丝线。 */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className,
  bodyClassName,
}: {
  title: string
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn(
        "flex min-w-0 flex-col rounded-xl border border-border/80 bg-card p-4",
        className,
      )}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {subtitle ? (
            <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      <div className={cn("flex min-h-0 flex-1 flex-col", bodyClassName)}>{children}</div>
    </section>
  )
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden className={cn("size-2 rounded-full", className)} />
      {label}
    </span>
  )
}

/** 近 N 日出单 × 上架双线图。窗口切换只在尾部切片，不重取数据。 */
export function SalesTrendPanel({
  points,
  coverageRead,
  coverageTotal,
  active,
}: {
  points: SalesTrendPoint[]
  coverageRead: number
  coverageTotal: number
  active: boolean
}) {
  const [days, setDays] = useState<7 | 14>(14)
  const windowed = points.slice(-days)
  const hasAny = windowed.some(
    (point) => point.orderedUnits > 0 || point.listedUnits > 0,
  )
  return (
    <Panel
      className="min-h-78 flex-1"
      title={`近 ${days} 日出单趋势`}
      subtitle={
        points.length > 0
          ? `${coverageRead}/${coverageTotal} 家共同口径 · 截至 ${points.at(-1)?.day}`
          : "仅汇总成功读取且日期口径一致的店铺订单"
      }
      action={
        <>
          <LegendDot className="bg-st-flight" label="出单量（件）" />
          <LegendDot className="bg-st-attest" label="上架量（件）" />
          <Select
            value={String(days)}
            onValueChange={(value) => setDays(value === "7" ? 7 : 14)}
          >
            <SelectTrigger size="sm" aria-label="趋势窗口">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="14">近 14 日</SelectItem>
              <SelectItem value="7">近 7 日</SelectItem>
            </SelectContent>
          </Select>
        </>
      }
      bodyClassName="border-t border-border/50"
    >
      {windowed.length === 0 ? (
        <ChartEmpty>暂无可绘制的每日数据</ChartEmpty>
      ) : hasAny ? (
        <SalesTrendChart points={windowed} active={active} />
      ) : (
        <ChartZero detail={`连续 ${windowed.length} 日无出单无上架`} />
      )}
    </Panel>
  )
}

const LIFECYCLE_DOT: Record<string, string> = {
  good: "bg-st-good",
  attest: "bg-st-attest",
  bad: "bg-st-bad",
  idle: "bg-st-idle",
}

/** 商品生命周期环图 + 图例；店铺下拉把范围切到单家。 */
export function LifecyclePanel({
  summary,
  active,
}: {
  summary: StoreProductsSummary
  active: boolean
}) {
  const [storeId, setStoreId] = useState<string | null>(null)
  const scope = lifecycleScope(summary, storeId)
  return (
    <Panel
      title="商品生命周期分布"
      subtitle="镜像统计在售 / 已隐藏 / 审核失败 / 已归档"
      action={
        <Select
          value={storeId ?? "all"}
          onValueChange={(value) => setStoreId(value === "all" ? null : value)}
        >
          <SelectTrigger size="sm" aria-label="店铺范围">
            <SelectValue>{storeId ? summary.perStore.find((store) => store.storeId === storeId)?.name : "全部店铺"}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部店铺</SelectItem>
            {summary.perStore.map((store) => (
              <SelectItem key={store.storeId} value={store.storeId}>
                {store.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      }
    >
      {scope.status === "ready" ? (
        <div className="flex flex-1 items-center justify-center gap-6 py-2">
          <div className="relative shrink-0">
            <LifecycleDonutChart slices={scope.slices} total={scope.total} active={active} />
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 grid place-items-center"
            >
              <div className="text-center">
                <p className="font-mono text-2xl font-bold tabular-nums text-foreground">
                  {formatInteger(scope.total)}
                </p>
                <p className="text-xs text-muted-foreground">商品总数</p>
              </div>
            </div>
          </div>
          <ul className="flex min-w-0 flex-col gap-2.5">
            {scope.slices.map((slice) => (
              <li
                key={slice.key}
                className="flex items-baseline gap-2 text-sm"
              >
                <span
                  aria-hidden
                  className={cn("size-2 shrink-0 self-center rounded-full", LIFECYCLE_DOT[slice.tone])}
                />
                <span className="w-14 shrink-0 text-xs text-muted-foreground">
                  {slice.label}
                </span>
                <span className="w-10 shrink-0 text-right font-mono text-sm tabular-nums text-foreground">
                  {formatInteger(slice.value)}
                </span>
                <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums text-muted-foreground">
                  {((slice.value / scope.total) * 100).toFixed(1)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ChartEmpty>
          {scope.status === "unsynced" ? "该范围尚未同步商品镜像" : "暂无商品"}
        </ChartEmpty>
      )}
    </Panel>
  )
}

/** 店铺出单排行：近 14 日窗口合计，较上期 = 后半 7 日对前半 7 日。 */
export function RankingPanel({
  rows,
  onNavigate,
}: {
  rows: StoreRankRow[]
  onNavigate: (screen: "stores") => void
}) {
  const top = rows.slice(0, 5)
  return (
    <Panel
      className="flex-1"
      title="店铺出单排行（近 14 日）"
      subtitle={
        rows.length > 0 ? `${rows.length} 家可读店铺 · 较上期为前 7 日` : "按出单量排序"
      }
      action={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onNavigate("stores")}
        >
          查看全部
          <ArrowRight data-icon="inline-end" />
        </Button>
      }
      bodyClassName="border-t border-border/50"
    >
      {top.length === 0 ? (
        <ChartEmpty>暂无可读店铺</ChartEmpty>
      ) : (
        <ul className="flex flex-1 flex-col">
          {top.map((row, index) => (
            <li
              key={row.storeId}
              className="flex items-center gap-3 border-b border-border/40 py-2.5 last:border-b-0"
            >
              {index < 3 ? (
                <Medal
                  aria-hidden
                  className={cn(
                    "size-4 shrink-0",
                    index === 0 && "text-st-attest",
                    index === 1 && "text-muted-foreground",
                    index === 2 && "text-st-attest/70",
                  )}
                />
              ) : (
                <span className="grid size-4 shrink-0 place-items-center font-mono text-xs tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-sm text-foreground" title={row.name}>
                {row.name}
              </span>
              <span className="w-16 shrink-0 text-right font-mono text-sm tabular-nums text-foreground">
                {formatInteger(row.units)}
              </span>
              <span
                className={cn(
                  "w-16 shrink-0 text-right font-mono text-xs tabular-nums",
                  row.deltaPct === null
                    ? "text-muted-foreground"
                    : row.deltaPct > 0
                      ? "text-st-good"
                      : row.deltaPct < 0
                        ? "text-st-bad"
                        : "text-muted-foreground",
                )}
              >
                {formatSignedPercent(row.deltaPct)}
                {row.deltaPct !== null && row.deltaPct !== 0
                  ? row.deltaPct > 0
                    ? " ↑"
                    : " ↓"
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

/** 运营建议条：第一条建议带跳转，第二条纯文字。 */
export function AdviceBanner({
  advice,
  onNavigate,
}: {
  advice: ConsoleAdvice[]
  onNavigate: (screen: "products" | "stores" | "listing") => void
}) {
  if (advice.length === 0) return null
  const [headline, ...rest] = advice
  return (
    <section
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border/80 bg-card px-4 py-3"
      aria-label="运营建议"
    >
      <span className="grid size-7 shrink-0 place-items-center rounded-md border border-brand/30 bg-brand/10 text-brand">
        <Lightbulb className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{headline.text}</p>
        {rest.map((item) => (
          <p key={item.text} className="mt-0.5 text-xs text-muted-foreground">
            {item.text}
          </p>
        ))}
      </div>
      {headline.target ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => headline.target && onNavigate(headline.target)}
        >
          查看运营建议
          <ArrowRight data-icon="inline-end" />
        </Button>
      ) : null}
    </section>
  )
}

/**
 * 待介入提醒条 — 有事项才渲染，无消息即好消息。所有动作按钮禁用态由调用方
 * 按刷新/对账在途决定。
 */
export function AttentionBanner({
  parts,
  needsReconciliation,
  showStoresLink,
  showProductsLink,
  reconciling,
  actionsDisabled,
  onReconcile,
  onNavigate,
}: {
  parts: string[]
  needsReconciliation: boolean
  showStoresLink: boolean
  showProductsLink: boolean
  reconciling: boolean
  actionsDisabled: boolean
  onReconcile: () => void
  onNavigate: (screen: "products" | "stores") => void
}) {
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-st-attest/40 bg-st-attest-soft px-4 py-3 shadow-xs"
    >
      <div className="flex items-center gap-2 text-st-attest-ink">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="text-xs font-semibold uppercase tracking-wider">待介入提醒</span>
      </div>
      <p className="text-sm font-medium text-foreground">{parts.join(" · ")}</p>
      {needsReconciliation ? (
        <span className="rounded bg-st-attest/20 px-1.5 py-0.5 text-meta font-mono font-medium text-st-attest-ink">
          含待对账记录
        </span>
      ) : null}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {needsReconciliation ? (
          <Button
            variant="brand"
            size="sm"
            disabled={actionsDisabled || reconciling}
            onClick={onReconcile}
          >
            {reconciling ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Stethoscope data-icon="inline-start" />
            )}
            <span>执行对账</span>
          </Button>
        ) : null}
        {showStoresLink ? (
          <Button variant="outline" size="sm" onClick={() => onNavigate("stores")}>
            查看异常店铺
          </Button>
        ) : null}
        {showProductsLink ? (
          <Button variant="outline" size="sm" onClick={() => onNavigate("products")}>
            查看上架明细
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function ChartEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-62.5 flex-1 place-items-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}

export function ChartZero({ detail }: { detail: string }) {
  return (
    <div className="grid min-h-62.5 flex-1 place-items-center text-center">
      <div>
        <strong className="font-mono text-3xl font-semibold tracking-tight tabular-nums text-foreground">
          0 <span className="text-sm font-normal text-muted-foreground">件</span>
        </strong>
        <p className="mt-2 text-sm text-muted-foreground">{detail}</p>
      </div>
    </div>
  )
}

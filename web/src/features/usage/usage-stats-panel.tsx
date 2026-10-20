import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { RefreshCw } from "lucide-react"

import { type WalletView } from "@/bindings/commands"
import { loadWallet, useWallet } from "@/features/usage/wallet-cache"
import { useScreenActive } from "@/components/screen-pane"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DateRangePicker,
  getPresetDateRange,
  type DateRangeValue,
} from "@/features/usage/date-range-picker"
import {
  buildDailyPoints,
  CostBarChart,
  RequestsAreaChart,
  TokensBarChart,
} from "@/features/usage/usage-charts"
import {
  isUsageStatsCacheFresh,
  loadUsageStats,
  peekUsageStats,
  useUsageStats,
  USAGE_CACHE_TTL_MS,
} from "@/features/usage/usage-cache"
import { errorMessage } from "@/lib/error-message"
import { formatYuan } from "@/lib/money"
import { clearLive, notifyLive } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { cn } from "@/lib/utils"

const USAGE_READ_LIVE = "usage-read"

/**
 * The relay only pages access rows, capped at 100 by the Cloud API, and there is
 * no per-day aggregate endpoint — so the two trend charts are built from the
 * most recent page. The page therefore says so out loud whenever the window
 * holds more calls than one page carries, instead of drawing a partial series as
 * if it were the whole window.
 *
 * ponytail: client-side daily buckets over one 100-row page; swap for a
 * `GET /api/billing/usage-daily` aggregate when a window outgrows it.
 */

/**
 * A soft-filled readout card. The usage screen is a wall of numbers, so the
 * cards carry no border — the fill alone groups them, and the borders would
 * otherwise out-weigh the figures they frame.
 */
function StatCard({
  label,
  value,
  unit,
  aside,
  footnote,
  className,
}: {
  label: ReactNode
  value: ReactNode
  unit?: string
  aside?: ReactNode
  footnote?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl bg-card border border-border p-5",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-compact text-muted-foreground">{label}</span>
        {aside}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-baseline gap-1.5">
          <span className="font-mono text-3xl font-semibold tracking-tight text-foreground tabular-nums">
            {value}
          </span>
          {unit ? (
            <span className="text-sm font-medium text-faint-foreground">{unit}</span>
          ) : null}
        </div>
        {footnote}
      </div>
    </div>
  )
}

/** Title + inline total, then the plot. Mirrors the chart cards on the DeepSeek 用量 page. */
function ChartCard({
  title,
  total,
  children,
}: {
  title: string
  total: string
  children: ReactNode
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card border border-border p-5">
      <div className="flex items-baseline gap-2">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="font-mono text-sm text-muted-foreground tabular-nums">{total}</span>
      </div>
      {children}
    </div>
  )
}

/**
 * The platform-absorbed relief under the charged headline — present only for
 * windows where some row actually billed past the ceiling. Split from the read
 * so it can be rendered from a fixture.
 */
export function AbsorbedReliefNote({ absorbedMicrofen }: { absorbedMicrofen: number }) {
  if (absorbedMicrofen <= 0) return null
  return (
    <span className="text-meta font-medium text-muted-foreground tabular-nums">
      {`含平台封顶减免 ${formatYuan(absorbedMicrofen)}`}
    </span>
  )
}

function WalletCards({
  wallet,
  onTopUp,
}: {
  wallet: WalletView | null | undefined
  onTopUp?: () => void
}) {
  const pending = wallet === undefined
  const depleted = wallet !== null && wallet !== undefined && wallet.available_microfen <= 0

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <StatCard
        label="充值余额"
        value={
          pending ? <Skeleton className="h-8 w-32" /> : wallet ? formatYuan(wallet.available_microfen) : "—"
        }
        unit={wallet ? "CNY" : undefined}
        aside={
          wallet && depleted ? (
            <span className="inline-flex items-center rounded-full border border-st-bad/30 bg-st-bad-soft px-2 py-0.5 text-meta font-medium leading-none text-st-bad-ink">
              余额不足
            </span>
          ) : wallet && wallet.held_microfen > 0 ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span className="font-mono text-meta text-faint-foreground tabular-nums" />
                }
              >
                预留 {formatYuan(wallet.held_microfen)}
              </TooltipTrigger>
              <TooltipContent side="top">
                进行中的请求会先预留这笔金额；结算后转为消费，未用则自动释放。
              </TooltipContent>
            </Tooltip>
          ) : null
        }
        footnote={
          onTopUp ? (
            <Button size="sm" className="rounded-full px-4" onClick={onTopUp}>
              去充值
            </Button>
          ) : null
        }
      />
      <StatCard
        label="累计消费金额"
        value={
          pending ? <Skeleton className="h-8 w-32" /> : wallet ? formatYuan(wallet.spent_microfen) : "—"
        }
        unit={wallet ? "CNY" : undefined}
      />
    </div>
  )
}

export function UsageStatsPanel({
  workspaceId,
  workspaceName,
  onTopUp,
}: {
  workspaceId?: number
  workspaceName?: string
  onTopUp?: () => void
}) {
  const active = useScreenActive()
  const [dateRange, setDateRange] = useState<DateRangeValue>(() => ({
    ...getPresetDateRange("last30"),
    preset: "last30",
  }))
  const wallet = useWallet()
  const [loading, setLoading] = useState(false)
  const requestGenerationRef = useRef(0)
  const retryRef = useRef<() => void>(() => {})

  const stats = useUsageStats(workspaceId, dateRange.from, dateRange.to)

  const refreshWallet = useCallback(() => {
    if (workspaceId === undefined) return
    void loadWallet().catch(() => {})
  }, [workspaceId])

  const loadStats = useCallback(
    async (
      currentWorkspaceId: number,
      from: string,
      to: string,
      force: boolean,
      generation: number,
    ) => {
      const cached = peekUsageStats(currentWorkspaceId, from, to)
      if (cached && !force && isUsageStatsCacheFresh(cached)) {
        if (generation === requestGenerationRef.current) {
          clearLive(USAGE_READ_LIVE)
          setLoading(false)
        }
        return
      }
      setLoading(true)
      try {
        await loadUsageStats({ workspaceId: currentWorkspaceId, from, to, force })
        if (generation === requestGenerationRef.current) clearLive(USAGE_READ_LIVE)
      } catch (reason) {
        if (generation !== requestGenerationRef.current) return
        notifyLive({
          id: USAGE_READ_LIVE,
          type: "error",
          reason,
          title: "用量数据读取失败",
          description: errorMessage(reason, "无法读取用量数据，请稍后重试。"),
          action: { label: "重试", onClick: () => retryRef.current() },
        })
      } finally {
        if (generation === requestGenerationRef.current) setLoading(false)
      }
    },
    [],
  )

  useVisiblePolling({
    enabled: active && workspaceId !== undefined,
    intervalMs: USAGE_CACHE_TTL_MS,
    restartKey: [workspaceId ?? "", dateRange.from, dateRange.to].join(":"),
    onPoll: () => {
      if (workspaceId === undefined) return
      refreshWallet()
      const generation = ++requestGenerationRef.current
      void loadStats(workspaceId, dateRange.from, dateRange.to, false, generation)
    },
  })

  useEffect(() => {
    if (!active || workspaceId === undefined) return
    const generation = ++requestGenerationRef.current
    void loadStats(workspaceId, dateRange.from, dateRange.to, false, generation)
  }, [active, loadStats, dateRange.from, dateRange.to, workspaceId])

  const reload = useCallback(() => {
    if (!active || workspaceId === undefined) return
    refreshWallet()
    const generation = ++requestGenerationRef.current
    void loadStats(workspaceId, dateRange.from, dateRange.to, true, generation)
  }, [active, loadStats, refreshWallet, dateRange.from, dateRange.to, workspaceId])

  // The live retry must run the newest reload, not the one captured when the
  // failure toast was raised.
  useEffect(() => {
    retryRef.current = reload
  }, [reload])

  useEffect(() => {
    if (workspaceId === undefined) clearLive(USAGE_READ_LIVE)
  }, [workspaceId])

  useEffect(() => () => clearLive(USAGE_READ_LIVE), [])

  const firstLoad = Boolean(active && workspaceId !== undefined && !stats && loading)

  // The API bounds the query to the selected range itself, so its totals are
  // authoritative for any range — not just the trailing presets. Cost reads
  // the charged split: what the settlements actually took out of the balance,
  // the same figure `wallet.spent_microfen` carries.
  const summary = useMemo(
    () =>
      stats
        ? {
            cost: stats.charged_microfen,
            absorbed: stats.absorbed_microfen,
            count: stats.message_count,
            tokens: stats.total_tokens,
          }
        : { cost: 0, absorbed: 0, count: 0, tokens: 0 },
    [stats],
  )

  const points = useMemo(
    () => (stats ? buildDailyPoints(dateRange.from, dateRange.to, stats.requests) : []),
    [stats, dateRange.from, dateRange.to],
  )
  const partialSeries = Boolean(stats && stats.message_count > stats.requests.length)

  return (
    <section className="flex flex-col gap-5" aria-label={"Workspace " + (workspaceName ?? "用量")}>
      <WalletCards wallet={wallet} onTopUp={onTopUp} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <div className="flex items-center gap-2">
          <DateRangePicker value={dateRange} onChange={setDateRange} />
          <Button variant="ghost" size="xs" disabled={loading} onClick={reload}>
            {loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
            刷新
          </Button>
        </div>
        <p className="text-compact text-muted-foreground">
          {`${dateRange.from} 至 ${dateRange.to}（UTC）`}
          {partialSeries && stats
            ? ` · 走势图基于最近 ${stats.requests.length} 次访问`
            : null}
        </p>
      </div>

      {!workspaceId ? (
        <Alert role="status">
          <AlertTitle>尚未选择 Workspace</AlertTitle>
          <AlertDescription>请先在 Workspace 下拉菜单中选择一个 Workspace。</AlertDescription>
        </Alert>
      ) : null}

      {firstLoad ? (
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Skeleton className="h-[6.5rem] rounded-xl" />
            <Skeleton className="h-[6.5rem] rounded-xl" />
            <Skeleton className="h-[6.5rem] rounded-xl" />
          </div>
          <Skeleton className="h-[18rem] rounded-xl" />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Skeleton className="h-[18rem] rounded-xl" />
            <Skeleton className="h-[18rem] rounded-xl" />
          </div>
        </div>
      ) : null}

      {stats ? (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <StatCard
              label="消费金额"
              value={formatYuan(summary.cost)}
              unit="CNY"
              footnote={<AbsorbedReliefNote absorbedMicrofen={summary.absorbed} />}
            />
            <StatCard label="API 请求次数" value={summary.count.toLocaleString("zh-CN")} />
            <StatCard label="Tokens" value={summary.tokens.toLocaleString("zh-CN")} />
          </div>

          <ChartCard
            title="消费金额（CNY）"
            total={formatYuan(summary.cost)}
          >
            <CostBarChart points={points} />
          </ChartCard>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ChartCard
              title="API 请求次数"
              total={summary.count.toLocaleString("zh-CN")}
            >
              <RequestsAreaChart points={points} />
            </ChartCard>
            <ChartCard title="Tokens" total={summary.tokens.toLocaleString("zh-CN")}>
              <TokensBarChart points={points} />
            </ChartCard>
          </div>
        </>
      ) : null}

      {!loading && !stats && workspaceId ? (
        <div className="rounded-xl bg-muted/40 px-4 py-10 text-center text-compact text-muted-foreground">
          尚未加载用量数据。点刷新重试，或检查本机是否已连上 Cloud。
        </div>
      ) : null}
    </section>
  )
}


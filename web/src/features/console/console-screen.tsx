import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import {
  Gauge,
  Package,
  PackageSearch,
  RefreshCw,
  Stethoscope,
  TrendingUp,
} from "lucide-react"

import type { ConsoleSnapshot } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { useScreenActive } from "@/components/screen-pane"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyMedia,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import { useSettledCount } from "@/hooks/use-settled-count"
import type { AppScreen } from "@/lib/app-screens"
import {
  commandErrorCode,
  CONSOLE_REFRESH_BUSY_CODE,
  errorMessage,
} from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyInfo, notifyLive, notifySuccess } from "@/lib/notify"

import { DeltaBadge, MiniBars, MetricCard, QuotaMeter, Sparkline } from "./console-kpi"
import { announceRefresh, commitLatest, shouldSoftReload } from "./console-model"
import { ConsoleSkeleton } from "./console-skeleton"
import {
  formatAge,
  formatInteger,
} from "./console-format"
import {
  buildAdvice,
  cohortPercentDelta,
  listingDailySeries,
  ordersFootnote,
  storeRankings,
} from "./console-board"
import {
  refreshableStoreIds,
  ROSTER_STATUS,
  rosterSnapshotsFromStores,
  summarizeLedger,
  summarizeStoreRoster,
  summarizeStoreSales,
} from "./console-metrics"
import { summarizeStoreProducts } from "./console-products"
import {
  AdviceBanner,
  AttentionBanner,
  LifecyclePanel,
  RankingPanel,
  SalesTrendPanel,
} from "./console-panels"

const CONSOLE_READ_LIVE = "console-read"

export const ConsoleScreen = memo(function ConsoleScreen({
  workspaceId,
  onNavigate,
}: {
  workspaceId?: number
  onNavigate: (screen: AppScreen) => void
}) {
  const active = useScreenActive()
  const [snapshot, setSnapshot] = useState<ConsoleSnapshot>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [reconciling, setReconciling] = useState(false)
  const requestVersion = useRef(0)
  const hasPainted = useRef(false)
  const wasActive = useRef(active)

  const load = useCallback(
    async (foreground: boolean) => {
      const version = ++requestVersion.current
      if (foreground) setLoading(true)
      await commitLatest({
        request: () => opsHttp.consoleGetSnapshot(),
        isCurrent: () => requestVersion.current === version,
        commit: (value) => {
          setSnapshot(value)
          clearLive(CONSOLE_READ_LIVE)
          setLoading(false)
          hasPainted.current = true
        },
        fail: (reason) => {
          const fallback = "无法读取当前 Workspace 的概览。"
          setLoading(false)
          notifyLive({
            id: CONSOLE_READ_LIVE,
            type: "error",
            reason,
            title: errorMessage(reason, fallback),
            action: { label: "重试", onClick: () => void load(true) },
          })
        },
      })
    },
    [workspaceId],
  )

  useEffect(() => {
    void load(true)
    return () => {
      requestVersion.current += 1
      clearLive(CONSOLE_READ_LIVE)
    }
  }, [load])

  useEffect(() => {
    const becameActive = active && !wasActive.current
    wasActive.current = active
    if (shouldSoftReload(becameActive, hasPainted.current, refreshing || reconciling)) {
      void load(false)
    }
  }, [active, load, reconciling, refreshing])

  const snapshots = useMemo(
    () => rosterSnapshotsFromStores(snapshot?.roster.stores ?? [], snapshot?.metrics ?? []),
    [snapshot],
  )
  const refreshableCount = refreshableStoreIds(snapshots).length
  const roster = useMemo(() => summarizeStoreRoster(snapshots, Date.now()), [snapshots])
  const salesTrend = useMemo(
    () => summarizeStoreSales(roster).dailyTrend,
    [roster],
  )
  const trendPoints = useMemo(() => {
    const listed = listingDailySeries(
      snapshot?.ledger ?? [],
      salesTrend.map((point) => point.day),
    )
    return salesTrend.map((point, index) => ({
      day: point.day,
      orderedUnits: point.orderedUnits,
      listedUnits: listed[index] ?? 0,
    }))
  }, [snapshot?.ledger, salesTrend])
  const ledger = useMemo(
    () => summarizeLedger(snapshot?.ledger ?? [], Date.now()),
    [snapshot?.ledger],
  )
  const products = useMemo(
    () =>
      summarizeStoreProducts(
        snapshot?.products ?? [],
        snapshot?.roster.stores ?? [],
        Date.now(),
      ),
    [snapshot],
  )
  const ranking = useMemo(() => storeRankings(roster.rows), [roster])
  const ordersPct = cohortPercentDelta(roster.cohortDelta)
  const settleRate =
    ledger.createdIn7Days > 0
      ? (ledger.settledIn7Days / ledger.createdIn7Days) * 100
      : null
  const failedReads = roster.rows.filter(
    (row) => row.status === "read_failed" || row.status === "rate_limited",
  ).length
  const alertStoreCount = roster.rows.filter(
    (row) => ROSTER_STATUS[row.status].group === "alerts",
  ).length
  const animatedNeedsAction = useSettledCount(ledger.needsAction)
  const needsReconciliation = (snapshot?.ledger ?? []).some(
    (entry) => entry.status === "result_unknown",
  )

  const advice = useMemo(
    () =>
      buildAdvice({
        failedReads,
        needsAction: ledger.needsAction,
        pending: products.totals.pending,
        zeroStock: products.totals.zeroStock,
        quotaUsed: products.quotaUsage?.used ?? null,
        quotaLimit: products.quotaUsage?.limit ?? null,
        settleRate,
        listed7d: ledger.createdIn7Days,
        readableStores: roster.coverage.read,
      }),
    [
      failedReads,
      ledger.needsAction,
      ledger.createdIn7Days,
      products.totals.pending,
      products.totals.zeroStock,
      products.quotaUsage,
      settleRate,
      roster.coverage.read,
    ],
  )

  const productsScope =
    (snapshot?.roster.stores.length ?? 0) === (snapshot?.roster.stores_used ?? -1)
      ? `全部 ${snapshot?.roster.stores.length ?? 0} 家店`
      : `我的 ${snapshot?.roster.stores.length ?? 0} 家店`
  const productsFootnote = `${productsScope} · 覆盖 ${products.coverage.read}/${products.coverage.total} · ${
    products.newestSyncMs
      ? `同步于 ${formatAge((Date.now() - products.newestSyncMs) / 3_600_000)}前`
      : "尚未同步"
  }`

  const refreshRoster = useCallback(async () => {
    if (refreshableCount === 0) return
    const version = ++requestVersion.current
    setRefreshing(true)
    try {
      const response = await opsHttp.consoleRefreshMetrics()
      if (requestVersion.current !== version) return
      setSnapshot((current) => (current ? { ...current, metrics: response.metrics } : current))
      announceRefresh(response)
    } catch (reason) {
      if (requestVersion.current !== version) return
      // Somebody else in this Workspace is already refreshing. Nothing is wrong and
      // nothing is lost — their pass writes the same metrics.
      if (commandErrorCode(reason) === CONSOLE_REFRESH_BUSY_CODE) {
        notifyInfo("工作空间里已有人正在刷新经营指标")
        return
      }
      const fallback = "无法刷新当前 Workspace 的经营指标。"
      notifyCommandError(reason, fallback)
    } finally {
      if (requestVersion.current === version) setRefreshing(false)
    }
  }, [refreshableCount])

  const reconcile = useCallback(async () => {
    const version = ++requestVersion.current
    setReconciling(true)
    try {
      const result = await opsHttp.consoleReconcileActiveWorkspace()
      if (requestVersion.current !== version) return
      const details = `已对账 ${result.reconciled}，冲突 ${result.conflicted}，仍未知 ${result.still_unknown}，跳过 ${result.skipped}`
      if (result.conflicted > 0 || result.still_unknown > 0) {
        notifyInfo("对账完成", { description: details })
      } else {
        notifySuccess("对账完成", { description: details })
      }

      try {
        const fresh = await opsHttp.consoleGetSnapshot()
        if (requestVersion.current !== version) return
        setSnapshot(fresh)
        clearLive(CONSOLE_READ_LIVE)
      } catch (reason) {
        if (requestVersion.current !== version) return
        const fallback = "对账完成，但概览重载失败。"
        notifyLive({
          id: CONSOLE_READ_LIVE,
          type: "error",
          reason,
          title: errorMessage(reason, fallback),
          action: { label: "重试", onClick: () => void load(true) },
        })
      }
    } catch (reason) {
      if (requestVersion.current !== version) return
      notifyCommandError(reason, "无法完成当前 Workspace 的 Reconciliation。")
    } finally {
      if (requestVersion.current === version) setReconciling(false)
    }
  }, [load])

  if (!snapshot && loading) return <ConsoleSkeleton />

  if (!snapshot) {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <Stethoscope />
        </EmptyMedia>
        <EmptyContent>
          <Button disabled={loading} onClick={() => void load(true)}>
            {loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
            重试
          </Button>
        </EmptyContent>
      </Empty>
    )
  }

  const attentionTotal = failedReads + ledger.needsAction
  const attentionParts = [
    failedReads > 0 ? `${failedReads} 家店铺读取异常` : undefined,
    ledger.needsAction > 0 ? `${animatedNeedsAction} 项待介入` : undefined,
    ledger.needsAction > 0 && ledger.oldestActionHours !== null
      ? `最久等待 ${formatAge(ledger.oldestActionHours)}`
      : undefined,
  ].filter((part): part is string => part !== undefined)

  const onSaleBars = products.perStore
    .filter((store) => store.status === "fresh" || store.status === "stale")
    .map((store) => store.onSale ?? 0)
    .sort((left, right) => right - left)
    .slice(0, 12)
  const quotaRatio =
    products.quotaUsage && products.quotaUsage.limit > 0
      ? products.quotaUsage.used / products.quotaUsage.limit
      : null

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col gap-4">
      <p className="sr-only" aria-live="polite">
        {refreshing ? "正在刷新经营指标" : reconciling ? "正在执行 Reconciliation" : ""}
      </p>

      {/* 待办条：有事项才渲染，无消息即好消息 */}
      {attentionTotal > 0 ? (
        <AttentionBanner
          parts={attentionParts}
          needsReconciliation={needsReconciliation}
          showStoresLink={alertStoreCount > 0}
          showProductsLink={ledger.needsAction > 0}
          reconciling={reconciling}
          actionsDisabled={refreshing}
          onReconcile={() => void reconcile()}
          onNavigate={onNavigate}
        />
      ) : null}

      {/* KPI 卡：出单 / 在售 / 上架收效 / 额度 */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={PackageSearch}
          label="30 日出单"
          tone="brand"
          onRefresh={() => void refreshRoster()}
          refreshDisabled={refreshableCount === 0 || reconciling}
          refreshing={refreshing}
          value={formatInteger(roster.totals.orderedUnits)}
          unit="件"
          trendBadge={
            ordersPct !== null ? (
              <DeltaBadge pct={ordersPct} />
            ) : roster.coverage.read === 0 ? (
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-meta text-muted-foreground">
                暂无读数
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-meta text-muted-foreground">
                首轮周期
              </span>
            )
          }
          footnote={ordersFootnote(roster)}
          visual={
            salesTrend.length > 0 ? (
              <Sparkline
                values={salesTrend.map((point) => point.orderedUnits)}
                className="text-st-flight"
              />
            ) : null
          }
        />

        <MetricCard
          icon={Package}
          label="在售商品"
          tone="good"
          value={
            products.coverage.read === 0
              ? "尚未同步"
              : formatInteger(products.totals.onSale)
          }
          unit={products.coverage.read === 0 ? "" : "件"}
          trendBadge={
            products.totals.pending > 0 ? (
              <span className="rounded-full bg-st-attest-soft px-2 py-0.5 font-mono text-meta font-medium text-st-attest-ink">
                {formatInteger(products.totals.pending)} 待处理
              </span>
            ) : null
          }
          footnote={productsFootnote}
          visual={
            onSaleBars.length > 0 ? (
              <MiniBars values={onSaleBars} className="text-st-good" />
            ) : null
          }
        />

        <MetricCard
          icon={TrendingUp}
          label="7 日上架与收效"
          tone="flight"
          value={
            <>
              <span>{formatInteger(ledger.createdIn7Days)}</span>
              <span className="text-muted-foreground/50"> / </span>
              <span>{formatInteger(ledger.settledIn7Days)}</span>
            </>
          }
          unit="新上架 / 已收敛"
          trendBadge={
            settleRate !== null ? (
              <span className="rounded-full bg-st-good/15 px-2 py-0.5 font-mono text-meta font-medium text-st-good">
                收敛率 {Math.round(settleRate)}%
              </span>
            ) : (
              <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-meta text-muted-foreground">
                7 日窗口
              </span>
            )
          }
          footnote={
            ledger.total > 0
              ? `全部账本 ${formatInteger(ledger.total)} 条 · 在途 ${formatInteger(ledger.inFlight)} 项`
              : "发起上架后自动建立账本"
          }
          visual={
            <MiniBars
              values={ledger.series.slice(-7).map((point) => point.intake)}
              className="text-st-attest"
            />
          }
        />

        <MetricCard
          icon={Gauge}
          label="额度占用"
          tone={quotaRatio !== null && quotaRatio >= 0.9 ? "attention" : "neutral"}
          value={
            products.quotaUsage
              ? `${formatInteger(products.quotaUsage.used)} / ${formatInteger(products.quotaUsage.limit)}`
              : "—"
          }
          unit={products.quotaUsage ? "已用/上限（件）" : ""}
          footnote={
            products.quotaUsage ? "Ozon 上架额度" : "暂无额度读数"
          }
          visual={quotaRatio !== null ? <QuotaMeter ratio={quotaRatio} /> : null}
        />
      </div>

      {/* 主区：左列 趋势+建议，右列 生命周期+排行 */}
      <div className="grid min-w-0 flex-1 gap-4 xl:grid-cols-[minmax(0,7fr)_minmax(20rem,5fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <SalesTrendPanel
            points={trendPoints}
            coverageRead={roster.coverage.read}
            coverageTotal={roster.coverage.total}
            active={active}
          />
          <AdviceBanner advice={advice} onNavigate={onNavigate} />
        </div>
        <div className="flex min-w-0 flex-col gap-4">
          <LifecyclePanel summary={products} active={active} />
          <RankingPanel rows={ranking} onNavigate={onNavigate} />
        </div>
      </div>
    </div>
  )
})

import type {
  ConsoleLedgerEntry,
  ConsoleStoreMetrics,
  OperationStatus,
  OzonStoreView,
} from "@/bindings/commands"
import { activeCloudStoreUid } from "@/features/stores/store-roster-cache"
import type { StateTone } from "@/lib/receipt-state"

const DAY_MS = 24 * 60 * 60 * 1000

const PROVEN_SETTLED = new Set<OperationStatus>(["succeeded", "reconciled"])
const TERMINAL = new Set<OperationStatus>([
  "succeeded",
  "reconciled",
  "operator_attested",
  "failed",
  "conflict",
])

export type LedgerSeriesPoint = {
  key: string
  label: string
  intake: number
  settled: number
  exceptions: number
}

export type OutcomeSlice = {
  key: "settled" | "active" | "unknown" | "failed" | "attested"
  label: string
  value: number
  tone: "good" | "flight" | "unknown" | "bad" | "attest"
}

export type LedgerSummary = {
  total: number
  createdIn7Days: number
  settledIn7Days: number
  inFlight: number
  provenSuccessRate: number | null
  medianSettlementMinutes: number | null
  needsAction: number
  oldestActionHours: number | null
  series: LedgerSeriesPoint[]
  outcomes: OutcomeSlice[]
}

function localDayStart(ms: number): number {
  const value = new Date(ms)
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime()
}

function dayKey(ms: number): string {
  const value = new Date(ms)
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(
    value.getDate(),
  ).padStart(2, "0")}`
}

function dayLabel(ms: number): string {
  const value = new Date(ms)
  return `${value.getMonth() + 1}/${value.getDate()}`
}

function isActionable(status: OperationStatus): boolean {
  return (
    status === "result_unknown" ||
    status === "failed" ||
    status === "conflict" ||
    status === "unknown"
  )
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[middle] ?? null
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** Project the Workspace-scoped Cloud ledger into the overview panels. */
export function summarizeLedger(
  entries: ConsoleLedgerEntry[],
  nowMs: number,
  seriesDays = 14,
): LedgerSummary {
  const today = localDayStart(nowMs)
  const start = today - (seriesDays - 1) * DAY_MS
  const sevenDayStart = today - 6 * DAY_MS
  const points = Array.from({ length: seriesDays }, (_, index) => {
    const at = start + index * DAY_MS
    return { key: dayKey(at), label: dayLabel(at), intake: 0, settled: 0, exceptions: 0 }
  })
  const byDay = new Map(points.map((point) => [point.key, point]))
  let createdIn7Days = 0
  let settledIn7Days = 0
  let provenSettled = 0
  let provenFailed = 0
  let needsAction = 0
  let oldestActionMs: number | null = null
  const durations: number[] = []
  const counts = { settled: 0, active: 0, unknown: 0, failed: 0, attested: 0 }

  for (const entry of entries) {
    // 「上架」口径只数 submission_intents（kind === "listing"）：改价、客服等
    // Seller 写入属于同一本账，但不是一次上架。
    const isListing = entry.kind === "listing"
    const createdDay = localDayStart(entry.created_at_ms)
    if (isListing && createdDay >= sevenDayStart && createdDay <= today) {
      createdIn7Days += 1
    }
    const createdPoint = byDay.get(dayKey(entry.created_at_ms))
    if (isListing && createdPoint) createdPoint.intake += 1

    if (PROVEN_SETTLED.has(entry.status)) {
      provenSettled += 1
      counts.settled += 1
    } else if (entry.status === "operator_attested") {
      counts.attested += 1
    } else if (entry.status === "queued" || entry.status === "dispatching") {
      counts.active += 1
    } else if (entry.status === "result_unknown" || entry.status === "unknown") {
      counts.unknown += 1
    } else {
      provenFailed += 1
      counts.failed += 1
    }

    if (TERMINAL.has(entry.status)) {
      durations.push(Math.max(0, entry.updated_at_ms - entry.created_at_ms))
    }
    const updatedDay = localDayStart(entry.updated_at_ms)
    const updatedPoint = byDay.get(dayKey(entry.updated_at_ms))
    if (PROVEN_SETTLED.has(entry.status) || entry.status === "operator_attested") {
      if (isListing && updatedDay >= sevenDayStart && updatedDay <= today) {
        settledIn7Days += 1
      }
      if (isListing && updatedPoint) updatedPoint.settled += 1
    }
    if (isActionable(entry.status)) {
      needsAction += 1
      oldestActionMs = Math.min(oldestActionMs ?? entry.updated_at_ms, entry.updated_at_ms)
      if (updatedPoint) updatedPoint.exceptions += 1
    }
  }

  const durationMs = median(durations)
  const provenTerminal = provenSettled + provenFailed
  return {
    total: entries.length,
    createdIn7Days,
    settledIn7Days,
    inFlight: counts.active,
    provenSuccessRate: provenTerminal > 0 ? (provenSettled / provenTerminal) * 100 : null,
    medianSettlementMinutes: durationMs === null ? null : durationMs / 60_000,
    needsAction,
    oldestActionHours:
      oldestActionMs === null ? null : Math.max(0, nowMs - oldestActionMs) / 3_600_000,
    series: points,
    outcomes: [
      { key: "settled", label: "已证实", value: counts.settled, tone: "good" },
      { key: "active", label: "进行中", value: counts.active, tone: "flight" },
      { key: "unknown", label: "Result Unknown", value: counts.unknown, tone: "unknown" },
      { key: "failed", label: "失败或冲突", value: counts.failed, tone: "bad" },
      { key: "attested", label: "人工确认", value: counts.attested, tone: "attest" },
    ],
  }
}

export type StoreEligibility =
  | "active"
  | "manual_disabled"
  | "quota_suspended"
  | "unconfigured"
  | "local_only"
  | "unavailable"

export type RosterRowStatus =
  | "ok"
  | "stalled"
  | "no_orders"
  | "unread"
  | "rate_limited"
  | "read_failed"
  | "manual_disabled"
  | "suspended"
  | "unconfigured"
  | "local_only"
  | "unavailable"

export type StoreRosterSnapshot = {
  storeId: string
  name: string
  /** Seller Client ID printed under the name — an identifier, not a metric. */
  clientId: string
  eligibility: StoreEligibility
  orderedUnits: number | null
  previousOrderedUnits?: number | null
  daySeries: number[]
  throughDay: string
  lastSyncAtMs: number
  lastError: string
  retryAtMs: number
}

export type StoreRosterRow = {
  storeId: string
  name: string
  clientId: string
  orderedUnits: number | null
  daySeries: number[]
  lastSyncAtMs: number
  throughDay: string
  status: RosterRowStatus
  stale: boolean
  error: string
  /** When Ozon lets this Store be read again; 0 when no retry is scheduled. */
  retryAtMs: number
}

export type CohortDelta =
  | { kind: "comparable"; current: number; previous: number; delta: number }
  | { kind: "incomparable"; reason: string }

export type StoreRosterSummary = {
  rows: StoreRosterRow[]
  coverage: { read: number; total: number }
  newestSyncMs: number | null
  totals: { orderedUnits: number }
  cohortDelta: CohortDelta
  stalled: string[]
}

/**
 * The one roster truth table. Row order, chip tone, coverage bucket,
 * readability and filter-tab membership all derive from this record — a
 * status enters or changes meaning in exactly one place.
 *
 *   readable  the row's numbers may be summed into Workspace totals
 *   bucket    the coverage bar: healthy / attention / dormant
 *   group     the roster filter tab the row answers to ("dormant" rows list
 *             under 全部 only, so no row counts toward two tabs)
 */
export type RosterGroup = "alerts" | "unread" | "active" | "dormant"

export const ROSTER_STATUS: Record<
  RosterRowStatus,
  {
    label: string
    tone: StateTone
    rank: number
    bucket: "healthy" | "attention" | "dormant"
    readable: boolean
    group: RosterGroup
  }
> = {
  read_failed: { label: "读取失败", tone: "bad", rank: 0, bucket: "attention", readable: false, group: "alerts" },
  rate_limited: { label: "限流", tone: "flight", rank: 1, bucket: "attention", readable: false, group: "alerts" },
  stalled: { label: "断单", tone: "bad", rank: 2, bucket: "attention", readable: true, group: "alerts" },
  unread: { label: "未同步", tone: "idle", rank: 3, bucket: "dormant", readable: false, group: "unread" },
  unconfigured: { label: "未配置凭据", tone: "bad", rank: 4, bucket: "attention", readable: false, group: "alerts" },
  unavailable: { label: "不可用", tone: "bad", rank: 5, bucket: "attention", readable: false, group: "alerts" },
  manual_disabled: { label: "已停用", tone: "idle", rank: 6, bucket: "dormant", readable: false, group: "dormant" },
  suspended: { label: "名额暂停", tone: "bad", rank: 7, bucket: "attention", readable: false, group: "alerts" },
  local_only: { label: "待导入 Workspace", tone: "idle", rank: 8, bucket: "dormant", readable: false, group: "unread" },
  no_orders: { label: "无单", tone: "idle", rank: 9, bucket: "dormant", readable: true, group: "active" },
  ok: { label: "正常", tone: "good", rank: 10, bucket: "healthy", readable: true, group: "active" },
}

export type StoreSalesSummary = {
  bars: { storeId: string; name: string; clientId: string; orderedUnits: number }[]
  dailyTrend: { day: string; orderedUnits: number }[]
}

function utcDayMs(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
  const value = Date.parse(`${day}T00:00:00Z`)
  return Number.isFinite(value) && new Date(value).toISOString().slice(0, 10) === day
    ? value
    : null
}

/** Project readable roster rows into store bars and a fixed-coverage UTC trend. */
export function summarizeStoreSales(summary: Pick<StoreRosterSummary, "rows">): StoreSalesSummary {
  const readable = summary.rows.filter((row) => ROSTER_STATUS[row.status].readable)
  const bars = readable
    .map(({ storeId, name, clientId, orderedUnits }) => ({
      storeId,
      name,
      clientId,
      orderedUnits: orderedUnits ?? 0,
    }))
    .sort((left, right) => {
      const units = right.orderedUnits - left.orderedUnits
      const name = left.name.localeCompare(right.name, "zh-CN")
      const storeId = left.storeId < right.storeId ? -1 : left.storeId > right.storeId ? 1 : 0
      return units || name || storeId
    })
  const covered = readable.map((row) => {
    const end = utcDayMs(row.throughDay)
    return end === null || row.daySeries.length === 0
      ? null
      : { row, end, start: end - (row.daySeries.length - 1) * DAY_MS }
  })
  if (covered.length === 0 || covered.some((coverage) => coverage === null)) {
    return { bars, dailyTrend: [] }
  }

  const complete = covered.filter((coverage) => coverage !== null)
  const start = Math.max(...complete.map((coverage) => coverage.start))
  const end = Math.min(...complete.map((coverage) => coverage.end))
  const dailyTrend = []
  for (let at = start; at <= end; at += DAY_MS) {
    dailyTrend.push({
      day: new Date(at).toISOString().slice(0, 10),
      orderedUnits: complete.reduce(
        (sum, coverage) => sum + coverage.row.daySeries[(at - coverage.start) / DAY_MS]!,
        0,
      ),
    })
  }
  return { bars, dailyTrend }
}

/**
 * Disabled markers win over a contradictory `active`: if Cloud says a Store is
 * suspended or the operator disabled it, the row never reports as live no
 * matter what the status string carries.
 */
function eligibility(store: OzonStoreView): StoreEligibility {
  if (store.cloud_status === "manual_disabled" || store.manual_disabled) {
    return "manual_disabled"
  }
  if (store.cloud_status === "quota_suspended" || store.quota_suspended) {
    return "quota_suspended"
  }
  if (activeCloudStoreUid(store)) return "active"
  if (!store.cloud_store_uuid?.trim()) return "local_only"
  if (!store.configured) return "unconfigured"
  return "unavailable"
}

/** A metric that cannot be a unit count fails closed to "unread". */
function cleanUnits(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null
}

/** Keep the 14 slots aligned: a corrupt day reads as 0, not a gap. */
function cleanSeries(series: number[] | null | undefined): number[] {
  return (series ?? []).map((value) =>
    Number.isFinite(value) && value > 0 ? value : 0,
  )
}

export function rosterSnapshotsFromStores(
  stores: OzonStoreView[],
  metrics: ConsoleStoreMetrics[],
): StoreRosterSnapshot[] {
  const byId = new Map(metrics.map((item) => [item.store_id, item]))
  return stores.map((store) => {
    const storeId = store.cloud_store_uuid?.trim()
    const metric = storeId ? byId.get(storeId) : undefined
    return {
      storeId: storeId || store.id,
      name: store.label,
      clientId: store.client_id?.trim() ?? "",
      eligibility: eligibility(store),
      orderedUnits: cleanUnits(metric?.ordered_units_30d),
      previousOrderedUnits: metric?.previous_ordered_units_30d === undefined
        ? undefined
        : cleanUnits(metric.previous_ordered_units_30d),
      daySeries: cleanSeries(metric?.day_series_14d),
      throughDay: metric?.through_day ?? "",
      lastSyncAtMs: metric?.last_sync_at_ms ?? 0,
      lastError: metric?.last_error?.trim() ?? "",
      retryAtMs: metric?.retry_at_ms ?? 0,
    }
  })
}

export function refreshableStoreIds(snapshots: StoreRosterSnapshot[]): string[] {
  return snapshots.filter((store) => store.eligibility === "active").map((store) => store.storeId)
}

function isStalled(series: number[], orderedUnits: number | null): boolean {
  return (
    orderedUnits !== null &&
    orderedUnits > 0 &&
    series.length >= 5 &&
    series.slice(-5).every((value) => value === 0)
  )
}

function rowStatus(store: StoreRosterSnapshot, nowMs: number): RosterRowStatus {
  if (store.eligibility !== "active") {
    return store.eligibility === "quota_suspended" ? "suspended" : store.eligibility
  }
  if (store.lastError) return store.retryAtMs > nowMs ? "rate_limited" : "read_failed"
  if (store.lastSyncAtMs <= 0 || store.orderedUnits === null) return "unread"
  if (isStalled(store.daySeries, store.orderedUnits)) return "stalled"
  if (store.orderedUnits === 0 && store.daySeries.every((value) => value === 0)) return "no_orders"
  return "ok"
}

/** One projection owns eligibility, stale values, coverage and row order. */
export function summarizeStoreRoster(
  snapshots: StoreRosterSnapshot[],
  nowMs: number,
): StoreRosterSummary {
  // Statuses are computed once per snapshot — rows sort in place afterwards,
  // so nothing downstream may key a row back to its snapshot by index.
  const statuses = snapshots.map((store) => rowStatus(store, nowMs))
  const rows = snapshots.map((store, index) => {
    return {
      storeId: store.storeId,
      name: store.name,
      clientId: store.clientId,
      orderedUnits: store.orderedUnits,
      daySeries: store.daySeries,
      lastSyncAtMs: store.lastSyncAtMs,
      throughDay: store.throughDay,
      status: statuses[index]!,
      stale: Boolean(store.lastError && store.lastSyncAtMs > 0),
      error: store.lastError,
      retryAtMs: store.retryAtMs,
    }
  })
  rows.sort((left, right) => {
    const rank = ROSTER_STATUS[left.status].rank - ROSTER_STATUS[right.status].rank
    return rank || left.name.localeCompare(right.name, "zh-CN")
  })

  // Readability is a fact of the row status, not a second predicate: only a
  // status that required synced, finite metrics can be summed into totals.
  const readable = snapshots.filter(
    (_, index) => ROSTER_STATUS[statuses[index]!].readable,
  )
  const newestSyncMs = readable.reduce<number | null>(
    (newest, store) =>
      newest === null ? store.lastSyncAtMs : Math.max(newest, store.lastSyncAtMs),
    null,
  )
  const totals = {
    orderedUnits: readable.reduce((sum, store) => sum + (store.orderedUnits ?? 0), 0),
  }
  const cohort = readable.filter((store) => store.previousOrderedUnits !== undefined)
  const cohortDelta: CohortDelta =
    readable.length === 0
      ? { kind: "incomparable", reason: "当前无成功指标" }
      : cohort.length === 0 || cohort.length * 2 < readable.length
        ? { kind: "incomparable", reason: "缺少上一口径日，暂不比较" }
        : (() => {
            const current = cohort.reduce((sum, store) => sum + (store.orderedUnits ?? 0), 0)
            const previous = cohort.reduce(
              (sum, store) => sum + (store.previousOrderedUnits ?? 0),
              0,
            )
            return { kind: "comparable", current, previous, delta: current - previous }
          })()

  return {
    rows,
    coverage: {
      read: readable.length,
      total: snapshots.filter((store) => store.eligibility === "active").length,
    },
    newestSyncMs,
    totals,
    cohortDelta,
    stalled: rows.filter((row) => row.status === "stalled").map((row) => row.storeId),
  }
}

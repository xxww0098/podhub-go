import { rosterSnapshotsFromStores } from "@/features/console/console-metrics"
import type { LedgerSummary, OutcomeSlice, StoreRosterSnapshot } from "@/features/console/console-metrics"
import type { ConsoleStoreMetrics, OzonStoreView } from "@/bindings/commands"
import { formatShortDay } from "@/lib/format"
import type { ObservationLedger } from "./observation-types"
import type { OzonStoresOverview } from "@/bindings/commands"
import type { StoreProductsOverviewData } from "@/features/products/products-api"
import type { StoreProductsSummary } from "@/features/console/console-products"

const OUTCOMES: Omit<OutcomeSlice, "value">[] = [
  { key: "settled", label: "已证实", tone: "good" },
  { key: "active", label: "进行中", tone: "flight" },
  { key: "unknown", label: "Result Unknown", tone: "unknown" },
  { key: "failed", label: "失败或冲突", tone: "bad" },
  { key: "attested", label: "人工确认", tone: "attest" },
]

/** Cloud snapshot readability is not Seller execution eligibility. The admin
 * roster intentionally carries no usable credential, so keep it untouched and
 * derive only this display model from live Store state. Cached-data quality is
 * still decided by summarizeStoreRoster; no write/refresh controller receives it.
 */
export function observationRosterSnapshots(stores: OzonStoreView[], metrics: ConsoleStoreMetrics[]): StoreRosterSnapshot[] {
  const state = new Map(stores.map((store) => {
    const id = store.cloud_store_uuid?.trim() || store.id
    const eligibility: StoreRosterSnapshot["eligibility"] =
      store.manual_disabled || store.cloud_status === "manual_disabled" ? "manual_disabled"
        : store.quota_suspended || store.cloud_status === "quota_suspended" ? "quota_suspended"
          : store.cloud_store_uuid?.trim() && store.cloud_status === "active" ? "active" : "unavailable"
    return [id, eligibility] as const
  }))
  return rosterSnapshotsFromStores(stores, metrics).map((snapshot) => ({
    ...snapshot, clientId: "", eligibility: state.get(snapshot.storeId) ?? "unavailable",
  }))
}

/** Exact server aggregate → existing presentation model, no client recomputation.
 * Day labels are sliced from UTC ISO dates, never converted to browser-local days.
 */
export function observationLedgerSummary(ledger: ObservationLedger): LedgerSummary {
  return {
    total: ledger.total,
    createdIn7Days: ledger.created_in7_days,
    settledIn7Days: ledger.settled_in7_days,
    inFlight: ledger.in_flight,
    needsAction: ledger.needs_action,
    provenSuccessRate: ledger.proven_success_rate ?? null,
    medianSettlementMinutes: ledger.median_settlement_minutes ?? null,
    oldestActionHours: ledger.oldest_action_hours ?? null,
    series: ledger.series.map((point) => ({
      key: point.day, label: formatShortDay(point.day),
      intake: point.intake, settled: point.settled, exceptions: point.exceptions,
    })),
    outcomes: OUTCOMES.map((outcome) => ({ ...outcome, value: ledger.outcomes[outcome.key] })),
  }
}

/** Use server freshness/counts instead of Console's legacy seven-day classifier.
 * A second bounded GET is intentional: the overview owns that business rule,
 * including consecutive failures, which ConsoleStoreProducts does not expose.
 */
export function observationProductsSummary(overview: StoreProductsOverviewData, roster: OzonStoresOverview): StoreProductsSummary {
  const ids = new Set(overview.stores.map((store) => store.store_id))
  const quotas = roster.stores.filter((store) => ids.has(store.cloud_store_uuid ?? store.id))
    .flatMap((store) => store.product_quota?.total ? [store.product_quota.total] : [])
  return {
    totals: {
      total: overview.totals.total ?? 0,
      onSale: overview.totals.on_sale ?? 0,
      pending: (overview.totals.hidden ?? 0) + (overview.totals.moderation_failed ?? 0),
      zeroStock: overview.totals.zero_stock ?? null,
      archived: overview.totals.archived ?? 0,
    },
    coverage: { ...overview.coverage },
    newestSyncMs: overview.newest_sync_at_ms ?? null,
    quotaUsage: quotas.length ? {
      used: quotas.reduce((sum, quota) => sum + (quota.usage ?? 0), 0),
      limit: quotas.reduce((sum, quota) => sum + (quota.limit ?? 0), 0),
    } : null,
    perStore: overview.stores.map((store) => ({
      storeId: store.store_id, name: store.name,
      onSale: store.count_on_sale ?? null, hidden: store.count_hidden ?? null,
      moderationFailed: store.count_moderation_failed ?? null, archived: store.count_archived ?? null,
      status: store.freshness,
    })),
  }
}

export function utcSnapshotStamp(ms: number | null | undefined): string {
  if (ms == null || ms <= 0 || !Number.isFinite(ms)) return "—"
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC"
}

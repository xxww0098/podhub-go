import assert from "node:assert/strict"
import test from "node:test"
import { alignObservationTrend, observationLedgerSummary, observationProductsSummary, observationRosterSnapshots, utcSnapshotStamp } from "./observation-console-model"
import { lifecycleScope } from "@/features/console/console-products"
import { rosterSnapshotsFromStores, summarizeStoreRoster } from "@/features/console/console-metrics"
import type { OzonStoreView, OzonStoresOverview } from "@/bindings/commands"
import { observedOverview, observedStore, STORE_A, STORE_B } from "./observation-fixtures"
import { observedLedger, STAMP } from "./observation-fixtures"

test("exact server rates/median are copied, never averaged across workspaces", () => {
  const dto = observedLedger()
  const summary = observationLedgerSummary(dto)
  assert.equal(summary.provenSuccessRate, 73.123456789)
  assert.equal(summary.medianSettlementMinutes, 19.875)
  assert.equal(summary.oldestActionHours, 12.25)
  assert.equal(summary.total, dto.total)
  assert.deepEqual(summary.outcomes.map(({ key, value }) => [key, value]), Object.entries(dto.outcomes))
  assert.notEqual(summary.series, dto.series)
  assert.deepEqual(dto.series, [{ day: "2026-10-12", intake: 4, settled: 3, exceptions: 1 }])
})

test("console coverage follows server expiry/never state, not the legacy seven-day client threshold", () => {
  const overview = {
    totals: { total: 0, on_sale: 0, processing: 0, hidden: 0, moderation_failed: 0, zero_stock: 0, archived: 0, delisted: 0 },
    coverage: { read: 0, total: 2 }, sync_disabled: true,
    stores: [
      { ...observedStore(), freshness: "expired" as const, count_total: 90, count_on_sale: 90 },
      { ...observedStore(STORE_B), freshness: "never" as const, count_total: null, count_on_sale: null },
    ],
  }
  const summary = observationProductsSummary(overview, { stores: [] } as unknown as OzonStoresOverview)
  assert.equal(summary.totals.onSale, 0)
  assert.deepEqual(summary.coverage, { read: 0, total: 2 })
  assert.deepEqual(summary.perStore.map((store) => store.status), ["expired", "never"])
  assert.equal(summary.perStore[1]?.onSale, null)
  assert.equal(lifecycleScope(summary, null).status, "unsynced")
})

test("UTC day keys and snapshot timestamps do not shift to the browser's next local day", () => {
  const summary = observationLedgerSummary(observedLedger())
  assert.deepEqual(summary.series, [{ key: "2026-10-12", label: "10/12", intake: 4, settled: 3, exceptions: 1 }])
  assert.equal(utcSnapshotStamp(STAMP), "2026-10-12 23:30 UTC")
  assert.equal(utcSnapshotStamp(undefined), "—")
})

test("only aligned ledger days can be plotted alongside sales", () => {
  const ledger = observationLedgerSummary(observedLedger())
  const matching = alignObservationTrend([{ day: "2026-10-12", orderedUnits: 3 }], ledger)
  assert.equal(matching.listingsComplete, true)
  assert.equal(matching.points[0]?.listedUnits, 4)
  const older = alignObservationTrend([{ day: "2026-09-01", orderedUnits: 3 }], ledger)
  assert.equal(older.listingsComplete, false)
})

test("redacted observer credentials do not hide an available Cloud business snapshot", () => {
  const raw = { id: STORE_A, label: "Cloud Store", cloud_store_uuid: STORE_A, cloud_status: "active",
    configured: false, secret_status: "unavailable", client_id: "", ref_id: "", can_manage: false,
    can_edit_credential: false, manual_disabled: false, quota_suspended: false } as OzonStoreView
  const before = JSON.stringify(raw)
  const metrics = [{ store_id: STORE_A, ordered_units_30d: 42, previous_ordered_units_30d: 21,
    day_series_14d: [1, 2, 3], through_day: "2026-10-12", last_sync_at_ms: STAMP, last_error: "", retry_at_ms: 0 }]
  const snapshots = observationRosterSnapshots([raw], metrics)
  const summary = summarizeStoreRoster(snapshots, STAMP)
  assert.equal(summary.coverage.read, 1)
  assert.equal(summary.totals.orderedUnits, 42)
  assert.equal(snapshots[0]?.clientId, "")
  assert.equal(JSON.stringify(raw), before, "no credential state or permission is manufactured")
  assert.equal(summarizeStoreRoster(rosterSnapshotsFromStores([raw], metrics), STAMP).coverage.read, 0, "workbench eligibility stays unchanged")
  assert.equal(observationRosterSnapshots([{ ...raw, manual_disabled: true }], metrics)[0]?.eligibility, "manual_disabled")
  assert.equal(observationRosterSnapshots([{ ...raw, quota_suspended: true }], metrics)[0]?.eligibility, "quota_suspended")
})

test("quota totals account for unlimited, missing and archived allowances", () => {
  const quotaStore = (id: string, total: { limit: number; usage: number; archived?: number } | null) => ({
    id, cloud_store_uuid: id, product_quota: total ? { total } : null,
  } as OzonStoreView)
  const bounded = observationProductsSummary(observedOverview(), { stores: [
    quotaStore(STORE_A, { limit: 100, usage: 20, archived: 5 }), quotaStore(STORE_B, { limit: 200, usage: 40 }),
  ] })
  assert.deepEqual(bounded.quotaUsage, { used: 60, limit: 305 })
  assert.deepEqual(bounded.quotaCoverage, { read: 2, total: 2, unlimited: 0 })

  const mixed = observationProductsSummary(observedOverview(), { stores: [
    quotaStore(STORE_A, { limit: -1, usage: 20 }), quotaStore(STORE_B, { limit: 200, usage: 40 }),
  ] })
  assert.deepEqual(mixed.quotaUsage, { used: 60, limit: -1 })
  assert.deepEqual(mixed.quotaCoverage, { read: 2, total: 2, unlimited: 1 })

  const missing = observationProductsSummary(observedOverview(), { stores: [
    quotaStore(STORE_A, { limit: 100, usage: 0 }), quotaStore(STORE_B, null),
  ] })
  assert.deepEqual(missing.quotaUsage, { used: 0, limit: 100 })
  assert.deepEqual(missing.quotaCoverage, { read: 1, total: 2, unlimited: 0 })
  const invalid = observationProductsSummary(observedOverview(), { stores: [quotaStore(STORE_A, { limit: 100, usage: NaN })] })
  assert.equal(invalid.quotaUsage, null)
  assert.equal(invalid.quotaCoverage.read, 0)
})

test("partial product counts stay unknown even if the aggregate contains a number", () => {
  const overview = observedOverview()
  const partial = observationProductsSummary({ ...overview, stores: [
    overview.stores[0]!, { ...overview.stores[1]!, count_on_sale: null, count_hidden: null },
  ] }, { stores: [] })
  assert.deepEqual(partial.countsKnown, { onSale: false, pending: false, zeroStock: true })
  const zero = observationProductsSummary({ ...overview, totals: { ...overview.totals, on_sale: 0, hidden: 0, moderation_failed: 0 }, stores: overview.stores.map((store) => ({ ...store, count_on_sale: 0, count_hidden: 0, count_moderation_failed: 0 })) }, { stores: [] })
  assert.deepEqual(zero.countsKnown, { onSale: true, pending: true, zeroStock: true })
  const invalidTotals = { ...overview.totals, on_sale: null, hidden: null } as unknown as typeof overview.totals
  const unknownAggregate = observationProductsSummary({ ...overview, totals: invalidTotals }, { stores: [] })
  assert.deepEqual(unknownAggregate.countsKnown, { onSale: false, pending: false, zeroStock: true })
  const missingStock = observationProductsSummary({ ...overview, stores: [overview.stores[0]!, { ...overview.stores[1]!, count_zero_stock: null }] }, { stores: [] })
  assert.equal(missingStock.countsKnown.zeroStock, false)
})

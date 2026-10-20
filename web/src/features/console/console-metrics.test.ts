import assert from "node:assert/strict"
import test from "node:test"

import {
  refreshableStoreIds,
  rosterSnapshotsFromStores,
  summarizeLedger,
  summarizeStoreSales,
  summarizeStoreRoster,
  type StoreRosterSnapshot,
} from "./console-metrics"

const now = new Date(2026, 7, 10, 12).getTime()
const hour = 60 * 60 * 1000
const day = 24 * hour

type CloudStore = Parameters<typeof rosterSnapshotsFromStores>[0][number]
type StoreMetric = Parameters<typeof rosterSnapshotsFromStores>[1][number]
type LedgerEntry = Parameters<typeof summarizeLedger>[0][number]

function cloudStore(id: string, partial: Partial<CloudStore> = {}): CloudStore {
  return {
    id: `local-${id}`,
    label: id,
    client_id: "",
    watermark_name: "",
    advertising_client_id: "",
    advertising_configured: false,
    configured: true,
    secret_status: "present",
    ref_id: `ref-${id}`,
    updated_at_ms: now,
    verified_at_ms: null,
    last_used_at_ms: null,
    active: true,
    cloud_store_uuid: id,
    create_order: 1,
    cloud_status: "active",
    manual_disabled: false,
    quota_suspended: false,
    cloud_revision: 1,
    credential_revision: 1,
    needs_reentry: false,
    can_manage: true,
    can_edit_credential: true,
    permissions: { manage_store: true, edit_name: true, manage_key_grants: true, manage_tags: true, test_key: true, manage_key: true, delete_store: true },
    assignee_key_manage: true,
    ...partial,
  }
}

function metric(storeId: string, partial: Partial<StoreMetric> = {}): StoreMetric {
  return { store_id: storeId, ...partial }
}

function snapshot(
  storeId: string,
  partial: Partial<StoreRosterSnapshot> = {},
): StoreRosterSnapshot {
  return {
    storeId,
    name: storeId,
    clientId: "",
    eligibility: "active",
    orderedUnits: 0,
    daySeries: Array.from({ length: 14 }, () => 0),
    throughDay: "2026-08-10",
    lastSyncAtMs: now,
    lastError: "",
    retryAtMs: 0,
    ...partial,
  }
}

function ledger(
  status: LedgerEntry["status"],
  createdAgo: number,
  updatedAgo: number,
  kind: LedgerEntry["kind"] = "listing",
): LedgerEntry {
  return {
    kind,
    status,
    created_at_ms: now - createdAgo,
    updated_at_ms: now - updatedAgo,
  }
}

test("minimal Workspace ledger separates proven, attested, active and actionable outcomes", () => {
  const summary = summarizeLedger(
    [
      ledger("succeeded", 2 * day, day),
      ledger("reconciled", 4 * day, 2 * day),
      ledger("operator_attested", 2 * day, hour),
      ledger("dispatching", hour, hour / 2),
      ledger("result_unknown", 3 * day, 2 * day),
      ledger("unknown", 5 * day, 4 * day),
      ledger("failed", 8 * day, 7 * day),
    ],
    now,
  )

  assert.equal(summary.total, 7)
  assert.equal(summary.createdIn7Days, 6)
  assert.equal(summary.settledIn7Days, 3)
  assert.equal(summary.needsAction, 3)
  assert.equal(summary.provenSuccessRate, (2 / 3) * 100)
  assert.equal(summary.medianSettlementMinutes, 2_130)
  assert.equal(summary.oldestActionHours, 7 * 24)
  assert.equal(summary.outcomes.find(({ key }) => key === "settled")?.value, 2)
  assert.equal(summary.outcomes.find(({ key }) => key === "attested")?.value, 1)
  assert.equal(summary.outcomes.find(({ key }) => key === "unknown")?.value, 2)
  assert.equal(summary.series.reduce((sum, point) => sum + point.intake, 0), 7)
})

test("non-listing writes stay on the ledger but never count as 上架", () => {
  const summary = summarizeLedger(
    [
      ledger("succeeded", 2 * day, day),
      ledger("succeeded", 10 * day, 9 * day),
      ledger("succeeded", day, hour, "write"),
      ledger("failed", hour, hour / 2, "write"),
    ],
    now,
  )

  assert.equal(summary.total, 4)
  // 上架口径只数 submission_intents。
  assert.equal(summary.createdIn7Days, 1)
  assert.equal(summary.settledIn7Days, 1)
  // 待介入仍是整本账——写入失败同样需要人来处理。
  assert.equal(summary.needsAction, 1)
  assert.equal(summary.series.reduce((sum, point) => sum + point.intake, 0), 2)
})

test("Cloud roster status is authoritative for every eligibility state", () => {
  const snapshots = rosterSnapshotsFromStores(
    [
      cloudStore("active", { needs_reentry: true }),
      cloudStore("manual", {
        cloud_status: null,
        manual_disabled: true,
        quota_suspended: true,
      }),
      cloudStore("suspended", {
        cloud_status: "quota_suspended",
        quota_suspended: true,
      }),
      cloudStore("unconfigured", { configured: false }),
      cloudStore("local", { cloud_store_uuid: null, cloud_status: null }),
      cloudStore("unavailable", { cloud_status: "deleted" }),
    ],
    [
      metric("active", { ordered_units_30d: 12, last_sync_at_ms: now }),
      metric("manual", { ordered_units_30d: 20, last_sync_at_ms: now - hour }),
      metric("suspended", { ordered_units_30d: 30, last_sync_at_ms: now - day }),
    ],
  )

  assert.deepEqual(
    snapshots.map(({ storeId, eligibility }) => [storeId, eligibility]),
    [
      ["active", "active"],
      ["manual", "manual_disabled"],
      ["suspended", "quota_suspended"],
      ["unconfigured", "unconfigured"],
      ["local-local", "local_only"],
      ["unavailable", "unavailable"],
    ],
  )
  assert.deepEqual(refreshableStoreIds(snapshots), ["active"])
  assert.equal(snapshots.find(({ storeId }) => storeId === "manual")?.orderedUnits, 20)
  assert.equal(snapshots.find(({ storeId }) => storeId === "suspended")?.orderedUnits, 30)

  const statuses = new Map(
    summarizeStoreRoster(snapshots, now).rows.map(({ storeId, status }) => [storeId, status]),
  )
  assert.equal(statuses.get("active"), "ok")
  assert.equal(statuses.get("manual"), "manual_disabled")
  assert.equal(statuses.get("suspended"), "suspended")
  assert.equal(statuses.get("unconfigured"), "unconfigured")
  assert.equal(statuses.get("local-local"), "local_only")
  assert.equal(statuses.get("unavailable"), "unavailable")
})

test("unknown and failed reads keep truth distinct while stale values stay visible", () => {
  const snapshots = rosterSnapshotsFromStores(
    [cloudStore("success"), cloudStore("unknown"), cloudStore("stale")],
    [
      metric("success", {
        ordered_units_30d: 10,
        day_series_14d: [1, 2],
        through_day: "2026-08-10",
        last_sync_at_ms: now - hour,
      }),
      metric("stale", {
        ordered_units_30d: 99,
        day_series_14d: [4, 5],
        through_day: "2026-08-09",
        last_sync_at_ms: now - day,
        last_error: "上游超时",
      }),
    ],
  )
  const summary = summarizeStoreRoster(snapshots, now)
  const rows = new Map(summary.rows.map((row) => [row.storeId, row]))

  assert.deepEqual(summary.coverage, { read: 1, total: 3 })
  assert.equal(summary.totals.orderedUnits, 10)
  assert.equal(summary.newestSyncMs, now - hour)
  assert.equal(rows.get("unknown")?.orderedUnits, null)
  assert.equal(rows.get("unknown")?.status, "unread")
  assert.equal(rows.get("stale")?.orderedUnits, 99)
  assert.equal(rows.get("stale")?.status, "read_failed")
  assert.equal(rows.get("stale")?.stale, true)
  assert.equal(rows.get("stale")?.error, "上游超时")
})

test("roster freshness reports the newest readable sync", () => {
  const summary = summarizeStoreRoster(
    [
      snapshot("fresh", { lastSyncAtMs: now - hour }),
      snapshot("stale", { lastSyncAtMs: now - 3 * day }),
    ],
    now,
  )
  assert.equal(summary.newestSyncMs, now - hour)
})

test("previous-day delta compares only the readable intersection", () => {
  const comparable = summarizeStoreRoster(
    [
      snapshot("a", { orderedUnits: 20, previousOrderedUnits: 10 }),
      snapshot("b", { orderedUnits: 5, previousOrderedUnits: 5 }),
      snapshot("new", { orderedUnits: 1 }),
    ],
    now,
  )
  assert.deepEqual(comparable.cohortDelta, {
    kind: "comparable",
    current: 25,
    previous: 15,
    delta: 10,
  })

  const shifted = summarizeStoreRoster(
    [
      snapshot("kept", { orderedUnits: 4, previousOrderedUnits: 4 }),
      snapshot("new-1", { orderedUnits: 8 }),
      snapshot("new-2", { orderedUnits: 8 }),
    ],
    now,
  )
  assert.deepEqual(shifted.cohortDelta, {
    kind: "incomparable",
    reason: "缺少上一口径日，暂不比较",
  })
})

test("stalled, never ordered and rate-limited stores remain distinct", () => {
  const summary = summarizeStoreRoster(
    [
      snapshot("cut", { orderedUnits: 14, daySeries: [4, 3, 2, 1, 1, 0, 0, 0, 0, 0] }),
      snapshot("older-only", {
        orderedUnits: 8,
        daySeries: Array.from({ length: 14 }, () => 0),
      }),
      snapshot("never"),
      snapshot("limited", { lastError: "429", retryAtMs: now + hour }),
    ],
    now,
  )
  const statuses = new Map(summary.rows.map(({ storeId, status }) => [storeId, status]))
  assert.equal(statuses.get("cut"), "stalled")
  assert.equal(statuses.get("older-only"), "stalled")
  assert.equal(statuses.get("never"), "no_orders")
  assert.equal(statuses.get("limited"), "rate_limited")
  assert.deepEqual(new Set(summary.stalled), new Set(["cut", "older-only"]))
})

test("store sales trend aligns each readable series by its UTC through day", () => {
  const roster = summarizeStoreRoster(
    [
      snapshot("later", {
        orderedUnits: 6,
        daySeries: [1, 2, 3],
        throughDay: "2026-08-10",
      }),
      snapshot("earlier", {
        orderedUnits: 60,
        daySeries: [10, 20, 30],
        throughDay: "2026-08-09",
      }),
    ],
    now,
  )

  assert.deepEqual(summarizeStoreSales(roster).dailyTrend, [
    { day: "2026-08-08", orderedUnits: 21 },
    { day: "2026-08-09", orderedUnits: 32 },
  ])
})

test("store sales excludes unread, failed and disabled rows and sorts bars stably", () => {
  const roster = summarizeStoreRoster(
    [
      snapshot("tie-b", { name: "中店", orderedUnits: 9, daySeries: [1] }),
      snapshot("tie-a", { name: "中店", orderedUnits: 9, daySeries: [2] }),
      snapshot("first-name", { name: "阿店", orderedUnits: 9, daySeries: [3] }),
      snapshot("high", { name: "末店", orderedUnits: 12, daySeries: [4] }),
      snapshot("stalled", { name: "停滞店", orderedUnits: 5, daySeries: [1, 0, 0, 0, 0, 0] }),
      snapshot("unread", { orderedUnits: null, lastSyncAtMs: 0, daySeries: [100] }),
      snapshot("failed", { orderedUnits: 99, daySeries: [100], lastError: "读取失败" }),
      snapshot("disabled", {
        eligibility: "manual_disabled",
        orderedUnits: 99,
        daySeries: [100],
      }),
    ],
    now,
  )
  const sales = summarizeStoreSales(roster)

  assert.deepEqual(
    sales.bars.map(({ storeId, orderedUnits }) => [storeId, orderedUnits]),
    [
      ["high", 12],
      ["first-name", 9],
      ["tie-a", 9],
      ["tie-b", 9],
      ["stalled", 5],
    ],
  )
  assert.equal(roster.rows.find((row) => row.storeId === "stalled")?.status, "stalled")
  assert.deepEqual(sales.dailyTrend, [{ day: "2026-08-10", orderedUnits: 10 }])
})

test("store sales preserves valid zero data while no readable rows stay empty", () => {
  const zero = summarizeStoreSales(
    summarizeStoreRoster(
      [snapshot("zero", { name: "零单店", daySeries: [0, 0] })],
      now,
    ),
  )

  assert.deepEqual(zero, {
    bars: [{ storeId: "zero", name: "零单店", clientId: "", orderedUnits: 0 }],
    dailyTrend: [
      { day: "2026-08-09", orderedUnits: 0 },
      { day: "2026-08-10", orderedUnits: 0 },
    ],
  })
  assert.deepEqual(summarizeStoreSales(summarizeStoreRoster([], now)), {
    bars: [],
    dailyTrend: [],
  })
})

// --- 商品镜像汇总 -------------------------------------------------------------

import {
  summarizeStoreProducts,
  type StoreProductMirrorRow,
} from "./console-products"

function mirrorRow(
  storeId: string,
  over: Partial<StoreProductMirrorRow> = {},
): StoreProductMirrorRow {
  return {
    store_id: storeId,
    price_stock_enabled: true,
    ...over,
  }
}

const QUOTA_STORES = [
  {
    id: "a",
    cloud_store_uuid: "a",
    label: "A 店",
    product_quota: { fetchedAtMs: now, total: { usage: 800, limit: 1000 } },
  },
  {
    id: "b",
    cloud_store_uuid: "b",
    label: "B 店",
    product_quota: { fetchedAtMs: now, total: { usage: 50, limit: 500 } },
  },
  { id: "c", cloud_store_uuid: "c", label: "C 店", product_quota: null },
] as never[]

test("summarizeStoreProducts: fresh+stale feed totals; expired/never stay visible but outside", () => {
  const summary = summarizeStoreProducts(
    [
      mirrorRow("a", {
        count_total: 40,
        count_on_sale: 30,
        count_hidden: 5,
        count_moderation_failed: 2,
        count_zero_stock: 3,
        count_archived: 1,
        probed_at_ms: now - hour,
      }),
      mirrorRow("b", {
        count_total: 20,
        count_on_sale: 15,
        count_hidden: 4,
        count_moderation_failed: 0,
        count_zero_stock: 1,
        count_archived: 0,
        probed_at_ms: now - 3 * day,
      }),
      mirrorRow("c", {
        count_total: 9,
        count_on_sale: 9,
        probed_at_ms: now - 10 * day,
      }),
      mirrorRow("d", {}),
    ],
    QUOTA_STORES,
    now,
  )

  assert.equal(summary.coverage.read, 2)
  assert.equal(summary.coverage.total, 4)
  assert.deepEqual(summary.totals, {
    total: 60,
    onSale: 45,
    pending: 11, // 5 + 4 hidden + 2 moderation
    zeroStock: 4,
    archived: 1,
  })
  assert.equal(summary.newestSyncMs, now - hour)
  assert.deepEqual(summary.quotaUsage, { used: 850, limit: 1500 })

  const d = summary.perStore.find((store) => store.storeId === "d")
  assert.equal(d?.status, "never")
  assert.equal(d?.onSale, null)
  const c = summary.perStore.find((store) => store.storeId === "c")
  assert.equal(c?.status, "expired")
})

test("summarizeStoreProducts: zeroStock stays null when no counted store syncs the C layer", () => {
  const summary = summarizeStoreProducts(
    [
      mirrorRow("a", {
        count_total: 5,
        count_on_sale: 5,
        count_zero_stock: 2,
        probed_at_ms: now - hour,
        price_stock_enabled: false,
      }),
    ],
    QUOTA_STORES,
    now,
  )
  assert.equal(summary.totals.zeroStock, null)
})

test("summarizeStoreProducts: quotaUsage is null when the roster carries no quota", () => {
  const summary = summarizeStoreProducts(
    [mirrorRow("a", { count_total: 1, count_on_sale: 1, probed_at_ms: now - hour })],
    [{ id: "a", cloud_store_uuid: "a", label: "A 店", product_quota: null }] as never[],
    now,
  )
  assert.equal(summary.quotaUsage, null)
})

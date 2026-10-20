import assert from "node:assert/strict"
import test from "node:test"

import type { StoreRosterRow } from "./console-metrics"
import {
  buildAdvice,
  cohortPercentDelta,
  listingDailySeries,
  storeRankings,
} from "./console-board"
import {
  lifecycleScope,
  summarizeStoreProducts,
  type StoreProductMirrorRow,
} from "./console-products"

const now = Date.parse("2026-09-20T12:00:00Z")
const day = 24 * 60 * 60 * 1000

// --- 上架日序列 ---------------------------------------------------------------

test("listing daily series counts only submission intents, bucketed by UTC day", () => {
  const series = listingDailySeries(
    [
      { kind: "listing", created_at_ms: Date.parse("2026-09-18T08:00:00Z") },
      { kind: "listing", created_at_ms: Date.parse("2026-09-18T20:00:00Z") },
      { kind: "write", created_at_ms: Date.parse("2026-09-18T09:00:00Z") },
      { kind: "listing", created_at_ms: Date.parse("2026-09-20T01:00:00Z") },
      { kind: "write", created_at_ms: Date.parse("2026-09-19T12:00:00Z") },
    ],
    ["2026-09-18", "2026-09-19", "2026-09-20"],
  )
  assert.deepEqual(series, [2, 0, 1])
})

test("listing daily series tolerates days outside the axis and empty input", () => {
  assert.deepEqual(
    listingDailySeries(
      [{ kind: "listing", created_at_ms: Date.parse("2026-01-01T00:00:00Z") }],
      ["2026-09-19", "2026-09-20"],
    ),
    [0, 0],
  )
  assert.deepEqual(listingDailySeries([], ["2026-09-20"]), [0])
  assert.deepEqual(listingDailySeries([], []), [])
})

// --- 店铺排行 -----------------------------------------------------------------

function rankRow(
  storeId: string,
  over: Partial<StoreRosterRow> = {},
): StoreRosterRow {
  return {
    storeId,
    name: storeId,
    clientId: "",
    orderedUnits: 0,
    daySeries: Array.from({ length: 14 }, () => 0),
    lastSyncAtMs: now,
    throughDay: "2026-09-20",
    status: "ok",
    stale: false,
    error: "",
    retryAtMs: 0,
    ...over,
  }
}

test("store rankings rank by the 14-day window, exclude unread rows", () => {
  const rows = storeRankings([
    rankRow("unread", { status: "unread", daySeries: Array.from({ length: 14 }, () => 99) }),
    rankRow("low", { daySeries: [0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0] }),
    rankRow("high", { daySeries: [1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2] }),
    rankRow("no-orders", { status: "no_orders" }),
  ])

  assert.deepEqual(
    rows.map((row) => [row.storeId, row.units]),
    [
      ["high", 21],
      ["low", 1],
      ["no-orders", 0],
    ],
  )
  const high = rows[0]
  // 前 7 日 7 件，后 7 日 14 件 → +100%。
  assert.equal(high?.deltaPct, 100)
  // 前半窗口全零时没有对照，不给百分比。
  assert.equal(rows.find((row) => row.storeId === "low")?.deltaPct, null)
})

test("store rankings break unit ties by name then id", () => {
  const rows = storeRankings([
    rankRow("b-id", { name: "同名店", daySeries: [0, 0, 0, 0, 0, 0, 0, 2] }),
    rankRow("a-id", { name: "同名店", daySeries: [0, 0, 0, 0, 0, 0, 0, 2] }),
    rankRow("c-id", { name: "阿店", daySeries: [0, 0, 0, 0, 0, 0, 0, 2] }),
  ])
  assert.deepEqual(
    rows.map((row) => row.storeId),
    ["c-id", "a-id", "b-id"],
  )
})

// --- 环比百分比 ---------------------------------------------------------------

test("cohort percent delta needs a comparable window and a nonzero baseline", () => {
  assert.equal(
    cohortPercentDelta({ kind: "comparable", current: 25, previous: 15, delta: 10 }),
    (10 / 15) * 100,
  )
  assert.equal(
    cohortPercentDelta({ kind: "comparable", current: 5, previous: 0, delta: 5 }),
    null,
  )
  assert.equal(
    cohortPercentDelta({ kind: "incomparable", reason: "缺少上一口径日，暂不比较" }),
    null,
  )
})

// --- 生命周期范围 --------------------------------------------------------------

function mirrorRow(
  storeId: string,
  over: Partial<StoreProductMirrorRow> = {},
): StoreProductMirrorRow {
  return { store_id: storeId, price_stock_enabled: true, ...over }
}

test("lifecycle scope sums fresh+stale mirrors; unsynced scopes never draw as zero", () => {
  const summary = summarizeStoreProducts(
    [
      mirrorRow("a", {
        count_on_sale: 30,
        count_hidden: 5,
        count_moderation_failed: 2,
        count_archived: 1,
        probed_at_ms: now - 1_000,
      }),
      mirrorRow("b", {
        count_on_sale: 15,
        count_hidden: 4,
        probed_at_ms: now - 3 * day,
      }),
      mirrorRow("c", { count_on_sale: 9, probed_at_ms: now - 10 * day }),
      mirrorRow("d", {}),
    ],
    [],
    now,
  )

  const all = lifecycleScope(summary, null)
  assert.equal(all.status, "ready")
  if (all.status === "ready") {
    assert.equal(all.total, 30 + 5 + 2 + 1 + 15 + 4)
    assert.deepEqual(
      all.slices.map((slice) => [slice.key, slice.value]),
      [
        ["on_sale", 45],
        ["hidden", 9],
        ["moderation_failed", 2],
        ["archived", 1],
      ],
    )
  }

  // 过期/从未同步的单店是「未同步」，不是四个零桶。
  assert.equal(lifecycleScope(summary, "c").status, "unsynced")
  assert.equal(lifecycleScope(summary, "d").status, "unsynced")

  const empty = summarizeStoreProducts(
    [mirrorRow("a", { count_on_sale: 0, probed_at_ms: now - 1_000 })],
    [],
    now,
  )
  assert.equal(lifecycleScope(empty, null).status, "empty")
  assert.equal(lifecycleScope(empty, "a").status, "empty")
})

// --- 运营建议 -----------------------------------------------------------------

const CALM_BOARD = {
  failedReads: 0,
  needsAction: 0,
  pending: 0,
  zeroStock: null,
  quotaUsed: null,
  quotaLimit: null,
  settleRate: null,
  listed7d: 0,
  readableStores: 2,
}

test("advice points to stores first when nothing is readable", () => {
  const advice = buildAdvice({ ...CALM_BOARD, readableStores: 0 })
  assert.equal(advice.length, 1)
  assert.equal(advice[0]?.target, "stores")
  assert.match(advice[0]!.text, /暂无可读/)
})

test("advice surfaces failures and pending actions before everything else", () => {
  const advice = buildAdvice({
    ...CALM_BOARD,
    failedReads: 2,
    needsAction: 3,
    pending: 5,
    zeroStock: 4,
    quotaUsed: 950,
    quotaLimit: 1000,
  })
  assert.equal(advice.length, 2)
  assert.match(advice[0]!.text, /2 家店铺指标读取失败/)
  assert.match(advice[1]!.text, /3 项操作待介入/)
})

test("advice on a calm board reports the settle rate or invites listing", () => {
  const [warm] = buildAdvice({ ...CALM_BOARD, settleRate: 62.4, listed7d: 20 })
  assert.match(warm!.text, /62%/)
  assert.equal(warm!.target, "listing")

  const [cold] = buildAdvice({ ...CALM_BOARD, settleRate: 12.5, listed7d: 8 })
  assert.match(cold!.text, /13%|12%|12\.5%/)
  assert.equal(cold!.target, "listing")

  const [quiet] = buildAdvice(CALM_BOARD)
  assert.match(quiet!.text, /暂无上架记录/)
  assert.equal(quiet!.target, "listing")
})

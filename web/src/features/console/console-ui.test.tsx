import assert from "node:assert/strict"
import test from "node:test"
import { PackageSearch } from "lucide-react"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  ConsoleStoreMetrics,
  OzonStoreView,
} from "@/bindings/commands"
import type { RosterRowStatus } from "./console-metrics"
import {
  ROSTER_STATUS,
  rosterSnapshotsFromStores,
  summarizeStoreRoster,
} from "./console-metrics"
import { ordersFootnote } from "./console-board"
import {
  chartAnimation,
  lifecycleDonutDescription,
  readPalette,
  SalesTrendChart,
  salesTrendDescription,
} from "./console-charts"
import { MetricCard } from "./console-kpi"
import { AdviceBanner, RankingPanel } from "./console-panels"

function replaceGlobal(name: PropertyKey, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  }
}

const ALL_STATUSES: RosterRowStatus[] = [
  "ok",
  "stalled",
  "no_orders",
  "unread",
  "rate_limited",
  "read_failed",
  "manual_disabled",
  "suspended",
  "unconfigured",
  "local_only",
  "unavailable",
]

function storeView(over: Partial<OzonStoreView>): OzonStoreView {
  return {
    active: false,
    advertising_client_id: "",
    advertising_configured: false,
    assignee_key_manage: false,
    can_edit_credential: false,
    can_manage: false,
    client_id: "42",
    configured: true,
    id: "local-1",
    label: "店",
    needs_reentry: false,
    permissions: {
      delete_store: false,
      edit_name: false,
      manage_key: false,
      manage_key_grants: false,
      manage_store: false,
      manage_tags: false,
      test_key: false,
    },
    ref_id: "r1",
    secret_status: "present",
    updated_at_ms: 0,
    watermark_name: "",
    ...over,
  }
}

test("every roster status has one spec entry and belongs to exactly one tab", () => {
  for (const status of ALL_STATUSES) {
    const spec = ROSTER_STATUS[status]
    assert.ok(spec.label.length > 0, status)
    assert.ok(
      ["alerts", "unread", "active", "dormant"].includes(spec.group),
      status,
    )
  }
  // Readable is exactly the set rowStatus can produce from synced metrics.
  assert.deepEqual(
    ALL_STATUSES.filter((status) => ROSTER_STATUS[status].readable).sort(),
    ["no_orders", "ok", "stalled"],
  )
  // 需关注 tab is exactly the attention bucket.
  assert.deepEqual(
    ALL_STATUSES.filter((status) => ROSTER_STATUS[status].group === "alerts").sort(),
    ALL_STATUSES.filter((status) => ROSTER_STATUS[status].bucket === "attention").sort(),
  )
})

test("a contradictory store never reports live: disable flags beat an active string", () => {
  const store = storeView({
    cloud_status: "active",
    cloud_store_uuid: "cloud-1",
    configured: true,
    manual_disabled: true,
  })
  const summary = summarizeStoreRoster(
    rosterSnapshotsFromStores([store], []),
    Date.now(),
  )
  assert.equal(summary.rows[0]?.status, "manual_disabled")
  assert.equal(summary.coverage.total, 0)
})

test("a corrupt metric fails closed to unread and stays out of totals", () => {
  const store = storeView({
    cloud_status: "active",
    cloud_store_uuid: "cloud-1",
    configured: true,
  })
  const metric: ConsoleStoreMetrics = {
    store_id: "cloud-1",
    ordered_units_30d: Number.NaN,
    day_series_14d: [3, -1, Number.NaN, 2],
    through_day: "2026-09-10",
    last_sync_at_ms: 1_000,
  }
  const [snapshot] = rosterSnapshotsFromStores([store], [metric])
  assert.equal(snapshot?.orderedUnits, null)
  assert.deepEqual(snapshot?.daySeries, [3, 0, 0, 2])

  const summary = summarizeStoreRoster([snapshot!], Date.now())
  assert.equal(summary.rows[0]?.status, "unread")
  assert.equal(summary.coverage.read, 0)
  assert.equal(summary.totals.orderedUnits, 0)
})

// --- 出单卡脚注：0 家可读是「没有数据」，不是「一切正常」 ----------------------

const COVERAGE_NOW = Date.now()

function activeStoreView(uuid: string): OzonStoreView {
  return storeView({ cloud_status: "active", cloud_store_uuid: uuid, configured: true })
}

function readableMetric(storeId: string): ConsoleStoreMetrics {
  return {
    store_id: storeId,
    ordered_units_30d: 5,
    day_series_14d: [1, 2, 0, 1, 0, 2, 0, 1, 0, 1, 1, 0, 1, 1],
    through_day: "2026-09-20",
    last_sync_at_ms: COVERAGE_NOW - 60_000,
  }
}

function footnoteOf(
  stores: OzonStoreView[],
  metrics: ConsoleStoreMetrics[],
): { summary: ReturnType<typeof summarizeStoreRoster>; footnote: string } {
  const summary = summarizeStoreRoster(rosterSnapshotsFromStores(stores, metrics), Date.now())
  return { summary, footnote: ordersFootnote(summary) }
}

test("orders footnote: 0 家可读时是中性「暂无」，绝不说「全部正常」", () => {
  const { summary, footnote } = footnoteOf([activeStoreView("cloud-1")], [])
  assert.equal(summary.coverage.read, 0)
  assert.equal(summary.coverage.total, 1)
  assert.equal(footnote, "暂无可读店铺")
  assert.doesNotMatch(footnote, /全部正常|全部状态正常/)
})

test("orders footnote: 没有可见店铺时不虚报覆盖率", () => {
  const { summary, footnote } = footnoteOf([], [])
  assert.equal(summary.coverage.total, 0)
  assert.equal(footnote, "暂无可见店铺")
})

test("orders footnote: 有可读店铺时给出覆盖率与环比对照", () => {
  const { summary, footnote } = footnoteOf(
    [activeStoreView("cloud-1"), activeStoreView("cloud-2")],
    [
      {
        store_id: "cloud-1",
        ordered_units_30d: 15,
        previous_ordered_units_30d: 10,
        day_series_14d: [1, 2, 0, 1, 0, 2, 0, 1, 0, 1, 1, 0, 1, 1],
        through_day: "2026-09-20",
        last_sync_at_ms: COVERAGE_NOW - 60_000,
      },
      readableMetric("cloud-2"),
    ],
  )
  assert.equal(summary.coverage.read, 2)
  assert.match(footnote, /覆盖 2\/2 店/)
  assert.match(footnote, /较上 30 日 \+5 件/)
})

// --- 面板渲染 ---------------------------------------------------------------

test("ranking panel lists stores with units and signed deltas", () => {
  const html = renderToStaticMarkup(
    <RankingPanel
      rows={[
        { storeId: "a", name: "榜首店", units: 42, deltaPct: 12.34 },
        { storeId: "b", name: "次席店", units: 7, deltaPct: null },
      ]}
      onNavigate={() => {}}
    />,
  )
  assert.match(html, /店铺出单排行（近 14 日）/)
  assert.match(html, /榜首店/)
  assert.match(html, />42</)
  assert.match(html, /\+12\.3%/)
  assert.match(html, /次席店/)
  // 无对照的店给「—」，不编一个百分比。
  assert.match(html, /—/)
})

test("advice banner renders the headline advice and its action", () => {
  const html = renderToStaticMarkup(
    <AdviceBanner
      advice={[
        { text: "2 项操作待介入，建议先完成对账再继续提交。", target: "products" },
        { text: "3 家店铺指标读取失败。", target: null },
      ]}
      onNavigate={() => {}}
    />,
  )
  assert.match(html, /运营建议/)
  assert.match(html, /2 项操作待介入/)
  assert.match(html, /3 家店铺指标读取失败/)
  assert.match(html, /查看运营建议/)
})

test("advice banner stays silent when there is nothing to say", () => {
  assert.equal(renderToStaticMarkup(<AdviceBanner advice={[]} onNavigate={() => {}} />), "")
})

test("metric card renders label, value, footnote and its refresh affordance", () => {
  const html = renderToStaticMarkup(
    <MetricCard
      icon={PackageSearch}
      label="30 日出单"
      value="128"
      unit="件"
      footnote="覆盖 2/2 店"
      onRefresh={() => {}}
    />,
  )
  assert.match(html, /30 日出单/)
  assert.match(html, />128</)
  assert.match(html, /覆盖 2\/2 店/)
  assert.match(html, /aria-label="刷新30 日出单"/)
})

// --- 图表 -------------------------------------------------------------------

test("console chart palette converts CSS Color 4 values to RGB pixels", () => {
  const context = {
    fillStyle: "",
    clearRect() {},
    fillRect() {},
    getImageData: () => ({ data: new Uint8ClampedArray([84, 137, 241, 255]) }),
  }
  const style = {
    fontFamily: "system-ui",
    getPropertyValue: (name: string) =>
      name === "--st-flight" ? "oklch(0.672 0.178 264)" : "",
  }
  const restoreDocument = replaceGlobal("document", {
    body: {},
    documentElement: {},
    createElement: () => ({ getContext: () => context }),
  })
  const restoreGetComputedStyle = replaceGlobal("getComputedStyle", () => style)

  try {
    assert.equal(readPalette().flight, "rgb(84, 137, 241)")
  } finally {
    restoreGetComputedStyle()
    restoreDocument()
  }
})

test("console charts disable every animation duration for reduced motion", () => {
  assert.deepEqual(chartAnimation(true, 360, 260), {
    animation: false,
    animationDuration: 0,
    animationDurationUpdate: 0,
    animationEasing: "cubicOut",
  })
  assert.deepEqual(chartAnimation(false, 360, 260), {
    animation: true,
    animationDuration: 360,
    animationDurationUpdate: 260,
    animationEasing: "cubicOut",
  })
})

test("trend chart description carries both series' daily values", () => {
  const points = [
    { day: "2026-09-22", orderedUnits: 3, listedUnits: 1 },
    { day: "2026-09-23", orderedUnits: 4, listedUnits: 0 },
  ]
  assert.equal(
    salesTrendDescription(points),
    "近 2 日出单与上架走势：2026-09-22 出单 3 件、上架 1 件；2026-09-23 出单 4 件、上架 0 件",
  )

  const html = renderToStaticMarkup(<SalesTrendChart points={points} active />)
  assert.match(html, /role="img"/)
  assert.match(html, /aria-label="近 2 日出单与上架走势：2026-09-22 出单 3 件/)
})

test("lifecycle donut description names every slice and the total", () => {
  assert.equal(
    lifecycleDonutDescription(
      [
        { key: "on_sale", label: "在售", value: 45, tone: "good" },
        { key: "hidden", label: "已隐藏", value: 9, tone: "attest" },
        { key: "moderation_failed", label: "审核失败", value: 2, tone: "bad" },
        { key: "archived", label: "已归档", value: 1, tone: "idle" },
      ],
      57,
    ),
    "商品生命周期分布，共 57 件：在售 45；已隐藏 9；审核失败 2；已归档 1",
  )
})

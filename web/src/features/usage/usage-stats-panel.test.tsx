import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { AbsorbedReliefNote, UsageStatsPanel } from "./usage-stats-panel"

import {
  buildDailyPoints,
  formatCompactAxisNumber,
  formatUsageNumber,
  readPalette,
} from "./usage-charts"

/**
 * Rows that hit the per-request ceiling carry an absorbed relief beside the
 * charged headline; an all-zero window renders nothing.
 */
test("absorbed>0 surfaces the platform relief note; an uncapped window stays clean", () => {
  const capped = renderToStaticMarkup(<AbsorbedReliefNote absorbedMicrofen={40_000_000} />)
  assert.match(capped, /含平台封顶减免 ¥0\.40/)
  assert.equal(renderToStaticMarkup(<AbsorbedReliefNote absorbedMicrofen={0} />), "")
})

function replaceGlobal(name: PropertyKey, value: unknown): () => void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, { configurable: true, value })
  return () => {
    if (previous) Object.defineProperty(globalThis, name, previous)
    else Reflect.deleteProperty(globalThis, name)
  }
}

test("usage panel without a Workspace asks the operator to pick one", () => {
  const html = renderToStaticMarkup(<UsageStatsPanel />)
  assert.match(html, /尚未选择 Workspace/)
  assert.doesNotMatch(html, /用量数据加载失败/)
})

test("usage figures collapse to 万 / 亿 above their thresholds", () => {
  assert.equal(formatUsageNumber(0), "0")
  assert.equal(formatUsageNumber(9_999), "9,999")
  assert.equal(formatUsageNumber(12_345), "1.2万")
  assert.equal(formatUsageNumber(100_000_000), "1亿")
})

test("compact axis numbers format with K / M / B notation", () => {
  assert.equal(formatCompactAxisNumber(0), "0")
  assert.equal(formatCompactAxisNumber(4), "4")
  assert.equal(formatCompactAxisNumber(8), "8")
  assert.equal(formatCompactAxisNumber(22_000), "22K")
  assert.equal(formatCompactAxisNumber(44_000), "44K")
  assert.equal(formatCompactAxisNumber(1_500_000), "1.5M")
  assert.equal(formatCompactAxisNumber(2_000_000_000), "2B")
})

test("chart palette converts CSS Color 4 values to RGB for ECharts hover", () => {
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
  const root = { classList: { contains: () => false } }
  const restoreDocument = replaceGlobal("document", {
    body: {},
    documentElement: root,
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

test("buildDailyPoints allocates requests and tokens across date range", () => {
  const points = buildDailyPoints("2026-08-20", "2026-08-21", [
    {
      request_id: "req-1",
      model: "claude-3-5-sonnet",
      operation: "ai_token",
      status: "settled",
      input_tokens: 100,
      output_tokens: 50,
      cached_input_tokens: 20,
      reasoning_output_tokens: 0,
      cache_hit_rate_bps: 2000,
      total_microfen: 15000,
      charged_microfen: 10000,
      absorbed_microfen: 5000,
      created_at: "2026-08-20T10:00:00Z",
    },
    {
      request_id: "req-2",
      model: "claude-3-5-sonnet",
      operation: "ai_token",
      status: "settled",
      input_tokens: 200,
      output_tokens: 100,
      cached_input_tokens: 50,
      reasoning_output_tokens: 0,
      cache_hit_rate_bps: 2500,
      total_microfen: 30000,
      charged_microfen: 30000,
      absorbed_microfen: 0,
      created_at: "2026-08-21T12:00:00Z",
    },
  ])

  assert.equal(points.length, 2)
  assert.equal(points[0]?.date, "2026-08-20")
  assert.equal(points[0]?.label, "08/20")
  assert.equal(points[0]?.requests, 1)
  assert.equal(points[0]?.input, 100)
  assert.equal(points[0]?.inputCached, 20)
  assert.equal(points[0]?.inputUncached, 80)
  assert.equal(points[0]?.output, 50)
  assert.equal(points[0]?.totalTokens, 150)
  // The cost series is the charged split — the absorbed relief is not cost.
  assert.equal(points[0]?.costMicrofen, 10000)

  assert.equal(points[1]?.date, "2026-08-21")
  assert.equal(points[1]?.requests, 1)
  assert.equal(points[1]?.input, 200)
  assert.equal(points[1]?.inputCached, 50)
  assert.equal(points[1]?.inputUncached, 150)
  assert.equal(points[1]?.output, 100)
  assert.equal(points[1]?.totalTokens, 300)
  assert.equal(points[1]?.costMicrofen, 30000)
})

test("buildDailyPoints handles single day with 24 hourly buckets", () => {
  const points = buildDailyPoints("2026-08-20", "2026-08-20", [
    {
      request_id: "req-1",
      model: "claude-3-5-sonnet",
      operation: "ai_token",
      status: "settled",
      input_tokens: 31078,
      output_tokens: 4470,
      cached_input_tokens: 4352,
      reasoning_output_tokens: 0,
      cache_hit_rate_bps: 1400,
      total_microfen: 50000,
      charged_microfen: 50000,
      absorbed_microfen: 0,
      created_at: "2026-08-20T19:24:12Z",
    },
  ])

  assert.equal(points.length, 24)
  assert.equal(points[0]?.label, "00:00")
  assert.equal(points[0]?.rangeLabel, "00:00～01:00")
  assert.equal(points[0]?.requests, 0)
  assert.equal(points[0]?.totalTokens, 0)

  const p19 = points[19]
  assert.equal(p19?.label, "19:00")
  assert.equal(p19?.rangeLabel, "19:00～20:00")
  assert.equal(p19?.requests, 1)
  assert.equal(p19?.inputCached, 4352)
  assert.equal(p19?.inputUncached, 26726)
  assert.equal(p19?.output, 4470)
  assert.equal(p19?.totalTokens, 35548)
})

test("buildDailyPoints keeps a zero bucket for days nobody called", () => {
  const points = buildDailyPoints("2026-08-19", "2026-08-21", [])
  assert.deepEqual(
    points.map((p) => [p.label, p.requests, p.totalTokens]),
    [
      ["08/19", 0, 0],
      ["08/20", 0, 0],
      ["08/21", 0, 0],
    ],
  )
})

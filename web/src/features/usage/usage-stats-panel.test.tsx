import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { renderToStaticMarkup } from "react-dom/server"

import { formatYuan } from "@/lib/money"
import { WalletBalanceBadge } from "@/components/workspace-quota-facts"

import { AiLogTableView, formatLogCost, logFailureText, logPageCount, type AiLogState } from "./ai-log-table"
import { WalletLedgerTable, formatSignedYuan, ledgerNoteLabel } from "./wallet-ledger-table"
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

function readNearby(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8")
}

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

test("the header wallet chip keeps its place and reads — until a wallet lands", () => {
  const empty = renderToStaticMarkup(<WalletBalanceBadge wallet={null} onOpenUsage={() => {}} />)
  assert.match(empty, /<button/)
  assert.match(empty, /aria-label="钱包余额 —"/)
  assert.match(empty, />—</)

  const filled = renderToStaticMarkup(
    <WalletBalanceBadge
      wallet={{ balance_microfen: 250_000_000, held_microfen: 0, available_microfen: 250_000_000, spent_microfen: 0, updated_at: "2026-10-30T00:00:00Z" }}
      onOpenUsage={() => {}}
    />,
  )
  assert.match(filled, /钱包余额 ¥2\.50 CNY/)
})

test("wallet ledger: 中文类型、带符号金额、变动后余额、备注；空与失败各一行", () => {
  const html = renderToStaticMarkup(
    <WalletLedgerTable
      failed={false}
      ledger={[
        { entry_type: "topup", amount_microfen: 100_000_000, balance_after_microfen: 100_000_000, note: "手动充值", created_at: "2026-10-30T01:00:00Z" },
        { entry_type: "settle", amount_microfen: -300_000, balance_after_microfen: 99_700_000, note: "", created_at: "2026-10-30T02:00:00Z" },
      ]}
    />,
  )
  assert.match(html, /最近 50 条/)
  assert.match(html, />充值</)
  assert.match(html, />结算</)
  assert.match(html, /\+¥1\.00/)
  assert.match(html, /-¥0\.003/)
  assert.match(html, /¥0\.997/)
  assert.match(html, /手动充值/)
  assert.equal(formatSignedYuan(0), "—")

  assert.match(renderToStaticMarkup(<WalletLedgerTable ledger={[]} failed={false} />), /暂无钱包流水/)
  assert.match(renderToStaticMarkup(<WalletLedgerTable ledger={null} failed />), /钱包流水读取失败/)
})

const logItem = (over: Record<string, unknown> = {}) => ({
  id: 1, user_id: 1, created_at: 1_761_800_000, type: 2, content: "quota 300000", username: "u", token_name: "",
  model_name: "gpt-5", quota: 300_000, prompt_tokens: 1200, completion_tokens: 80, use_time: 4, is_stream: false,
  channel: 0, token_id: 0, group: "default", ip: "", request_id: "req-123", upstream_request_id: "", other: {},
  ...over,
})

test("AI log table: tokens, quota as microfen yuan, failure text", () => {
  const state: AiLogState = {
    status: "ready",
    page: { page: 1, page_size: 20, total: 41, items: [logItem(), logItem({ id: 2, type: 5, content: "上游超时", request_id: "req-9" })] },
  }
  const html = renderToStaticMarkup(<AiLogTableView state={state} page={1} onExport={() => {}} />)
  assert.match(html, /gpt-5/)
  assert.match(html, /1,200/)
  assert.match(html, /¥0\.003/)
  assert.match(html, /req-123/)
  assert.match(html, /上游超时/)
  assert.match(html, /第 1 \/ 3 页 · 共 41 条/)
  assert.match(html, /导出 CSV/)
  assert.doesNotMatch(html, />渠道<|>IP</)
  assert.doesNotMatch(html, /QuantumNous|New API contributors/)
  assert.equal(formatLogCost(300_000), "¥0.003")
  assert.equal(logFailureText(logItem()), null)
  assert.equal(logPageCount(0), 1)
})

test("AI log table: empty and failed states keep their own copy", () => {
  const empty = renderToStaticMarkup(
    <AiLogTableView state={{ status: "ready", page: { page: 1, page_size: 20, total: 0, items: [] } }} page={1} />,
  )
  assert.match(empty, /暂无调用日志/)
  const failed = renderToStaticMarkup(<AiLogTableView state={{ status: "failed" }} page={1} onRetry={() => {}} />)
  assert.match(failed, /AI 调用日志读取失败/)
  assert.match(failed, /重试/)
})

test("recharge and redeem copy name the Workspace wallet, not the creator", () => {
  for (const file of ["./recharge-dialog.tsx", "../plans/redeem-code-dialog.tsx"]) {
    const source = readNearby(file)
    assert.doesNotMatch(source, /创建者.{0,2}钱包|同一.创建者/)
  }
  assert.match(readNearby("./recharge-dialog.tsx"), /当前工作空间的钱包/)
})

test("the server's English absorbed note reads in Chinese; other notes pass through", () => {
  assert.equal(
    ledgerNoteLabel("platform absorbed 153240 microfen above the per-request ceiling"),
    `平台承担超出单次上限的 ${formatYuan(153240)}`,
  )
  assert.equal(ledgerNoteLabel("兑换码充值"), "兑换码充值")
  assert.equal(ledgerNoteLabel(""), "")
})

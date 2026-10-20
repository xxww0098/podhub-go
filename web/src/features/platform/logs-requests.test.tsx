import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import { UsageStatsPanel } from "@/features/usage/usage-stats-panel"

import {
  AdminUsageScreen,
  endpointLabel,
  formatGenerationSpeed,
  RequestRow,
  sinceForPeriod,
} from "./logs"
import {
  formatCacheHitRate,
  operationLabel,
  UsageSummaryStrip,
} from "./usage-summary"

const ledgerRow = (chargedMicrofen: number, absorbedMicrofen: number) => ({
  request_id: "req-1",
  workspace_name: "演示 Workspace",
  email: "op@example.com",
  model: "gpt-x",
  channel_name: null,
  thinking_depth: null,
  api_format: "chat_completions",
  operation: "ocr",
  status: "settled",
  input_tokens: 100,
  output_tokens: 50,
  cached_input_tokens: 0,
  reasoning_output_tokens: 0,
  total_microfen: chargedMicrofen + absorbedMicrofen,
  charged_microfen: chargedMicrofen,
  absorbed_microfen: absorbedMicrofen,
  error_class: null,
  upstream_error: null,
  created_at: "2026-09-22T10:00:00Z",
  latency_ms: 1200,
  generation_speed_milli_tps: 42_000,
})

/**
 * A capped row shows what settlement took out of the balance plus the absorbed
 * relief beside it; a row that stayed under the ceiling shows charged alone.
 */
test("absorbed>0 rows show the relief badge beside the charged amount", () => {
  const capped = renderToStaticMarkup(<RequestRow row={ledgerRow(30_000_000, 10_000_000)} />)
  assert.match(capped, /¥0\.30/, "the amount is the charged split")
  assert.match(capped, /减免 ¥0\.10/)
  const uncapped = renderToStaticMarkup(<RequestRow row={ledgerRow(40_000_000, 0)} />)
  assert.match(uncapped, /¥0\.40/)
  assert.doesNotMatch(uncapped, /减免/)
})

test("time presets produce stable inclusive lower bounds", () => {
  const now = Date.parse("2026-08-22T12:00:00.000Z")
  assert.equal(sinceForPeriod("24h", now), "2026-08-21T12:00:00.000Z")
  assert.equal(sinceForPeriod("7d", now), "2026-08-15T12:00:00.000Z")
  assert.equal(sinceForPeriod("30d", now), "2026-07-23T12:00:00.000Z")
})

test("generation speed uses one decimal and stays blank without timing", () => {
  assert.equal(formatGenerationSpeed(50_600), "50.6 t/s")
  assert.equal(formatGenerationSpeed(undefined), "—")
})

test("endpoint labels use the upstream protocol", () => {
  assert.equal(endpointLabel("chat_completions"), "chat/completions")
  assert.equal(endpointLabel("responses"), "responses")
  assert.equal(endpointLabel("anthropic_messages"), "messages")
  assert.equal(endpointLabel(undefined), "")
})

test("operation labels separate paid recognition from chat", () => {
  assert.equal(operationLabel("ocr"), "识图")
  assert.equal(operationLabel("ai_token"), "Chat")
  assert.equal(operationLabel(undefined), "")
})

/** No settled input means the ratio is undefined, not a healthy zero percent. */
test("cache hit rate renders percent only when input exists", () => {
  assert.equal(formatCacheHitRate(4545, 1100), "45.5%")
  assert.equal(formatCacheHitRate(5000, 1000), "50.0%")
  assert.equal(formatCacheHitRate(0, 0), "—")
})

/**
 * The summary strip is the §6.3 admission read: status mix, upstream latency
 * percentiles, cache health, and the failure families — over the filtered
 * window the staff ledger below it shows row by row.
 */
test("the summary strip shows the tuning decision numbers", () => {
  const html = renderToStaticMarkup(
    <UsageSummaryStrip
      data={{
        total_rows: 3,
        settled_rows: 2,
        failed_rows: 0,
        unbilled_unknown_rows: 1,
        in_flight_rows: 0,
        input_tokens: 1100,
        cached_input_tokens: 500,
        cache_hit_rate_bps: 4545,
        output_tokens: 250,
        charged_microfen: 950,
        absorbed_microfen: 0,
        latency_p50_ms: 2500,
        latency_p90_ms: 2900,
        latency_p99_ms: 3100,
        upstream_latency_p50_ms: 2000,
        upstream_latency_p90_ms: 2400,
        upstream_latency_p99_ms: 2600,
        generation_speed_milli_tps_median: 56_666,
        failure_classes: [{ error_class: "upstream_rate_limited", count: 1 }],
      }}
    />,
  )
  assert.match(html, /请求/)
  assert.match(html, /未计费待确认 1/)
  assert.match(html, /上游延迟/)
  assert.match(html, /2\.00 s/)
  assert.match(html, /p99 2\.60 s/)
  assert.match(html, /56\.7 t\/s/)
  assert.match(html, /45\.5%/)
  assert.match(html, /upstream_rate_limited × 1/)
})

/**
 * Per-request billing detail is staff-only. The operator screen answers "what
 * did my Workspace spend"; only this screen answers "who spent it, on which call".
 * Both halves are asserted together so a future refactor cannot quietly move
 * the ledger back onto the member-facing page.
 */
test("the API request log stays on the staff-only platform screen", () => {
  const operator = renderToStaticMarkup(<UsageStatsPanel workspaceId={1} workspaceName="演示 Workspace" />)
  for (const column of ["用户邮箱", "总延迟", "错误信息"]) {
    assert.doesNotMatch(operator, new RegExp(column), `${column} must stay off the 用量 screen`)
  }

  const staff = renderToStaticMarkup(<AdminUsageScreen />)
  assert.match(staff, /API 请求日志/)
  assert.match(staff, /搜索 API 请求日志/)
  assert.doesNotMatch(staff, /全平台各 Workspace/)
})

test("the staff ledger shows an empty state before any row arrives", () => {
  const html = renderToStaticMarkup(<AdminUsageScreen />)
  assert.match(html, /暂无 API 请求日志/)
  assert.doesNotMatch(html, /加载失败/)
})

test("the table separates Workspace and email and exposes no credential column", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  for (const column of [
    "Workspace",
    "用户邮箱",
    "模型 / 请求",
    "渠道",
    "思考深度",
    "总延迟",
    "生成速度",
    "输入",
    "输出",
    "错误信息",
  ]) {
    assert.match(source, new RegExp(`TableHead[^>]*>${column}`))
  }
  assert.doesNotMatch(source, /凭据/)
  assert.match(source, /row\.thinking_depth \?\? ""/)
  assert.match(source, /row\.channel_name \?\? ""/)
  assert.match(source, /完整上游错误/)
  assert.match(source, /row\.upstream_error/)
})

test("the staff ledger has server-backed request filters", () => {
  const source = readFileSync(new URL("./logs.tsx", import.meta.url), "utf8")
  for (const label of [
    "搜索 API 请求日志",
    "按请求状态筛选",
    "按请求端点筛选",
    "按请求操作筛选",
    "按访问时间筛选",
  ]) {
    assert.match(source, new RegExp(label))
  }
  assert.match(source, /adminListAiRequests\(targetPage, PAGE_SIZE, filters\)/)
  assert.match(source, /没有符合当前筛选条件的请求/)
})

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

import type { UsageStatsView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import {
  invalidateUsageStats,
  isUsageStatsCacheFresh,
  loadUsageStats,
  peekUsageStats,
  sameUsageStats,
  usageStatsCacheKey,
  USAGE_CACHE_TTL_MS,
  USAGE_STATS_PAGE_SIZE,
  type UsageStatsCacheEntry,
} from "./usage-cache"

const emptyStats = (days: 7 | 30, spentYuan: number): UsageStatsView => ({
  days,
  from: "2026-08-01",
  to: "2026-08-30",
  total_tokens: 10,
  input_tokens: 6,
  output_tokens: 4,
  cached_input_tokens: 0,
  message_count: 2,
  cache_hit_rate_bps: 0,
  total_microfen: spentYuan * 100_000_000,
  charged_microfen: spentYuan * 100_000_000,
  absorbed_microfen: 0,
  page: 1,
  page_size: USAGE_STATS_PAGE_SIZE,
  total_pages: 1,
  requests: [],
  generated_at_ms: 1,
})

const entry: UsageStatsCacheEntry = {
  cachedAt: 10_000,
  stats: emptyStats(30, 1),
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test("usage cache is isolated by Workspace and range", () => {
  assert.equal(usageStatsCacheKey(42, "2026-08-01", "2026-08-30"), "42:2026-08-01:2026-08-30")
  assert.equal(usageStatsCacheKey(42, "2026-08-15", "2026-08-21"), "42:2026-08-15:2026-08-21")
  assert.equal(usageStatsCacheKey(43, "2026-08-01", "2026-08-30"), "43:2026-08-01:2026-08-30")
})

test("usage cache stays fresh for the short switching window", () => {
  assert.equal(isUsageStatsCacheFresh(entry, entry.cachedAt + USAGE_CACHE_TTL_MS - 1), true)
  assert.equal(isUsageStatsCacheFresh(entry, entry.cachedAt + USAGE_CACHE_TTL_MS), false)
})

test("identical totals do not count as a change", () => {
  assert.equal(sameUsageStats(emptyStats(30, 1), emptyStats(30, 1)), true)
  assert.equal(sameUsageStats(emptyStats(30, 1), emptyStats(30, 2)), false)
})

test("a changed charged or absorbed split counts as a change even when the nominal total holds", () => {
  const settled = emptyStats(30, 1)
  const recharged = { ...emptyStats(30, 1), charged_microfen: settled.total_microfen - 100, absorbed_microfen: 100 }
  assert.equal(sameUsageStats(settled, recharged), false)
  // The same move on a row keeps the pages distinct too.
  const row = (charged: number): UsageStatsView => ({
    ...settled,
    requests: [{
      request_id: "req-1",
      model: "m",
      operation: "ai_token",
      status: "settled",
      input_tokens: 6,
      output_tokens: 4,
      cached_input_tokens: 0,
      reasoning_output_tokens: 0,
      cache_hit_rate_bps: 0,
      total_microfen: 300,
      charged_microfen: charged,
      absorbed_microfen: 300 - charged,
      created_at: "2026-08-20T10:00:00Z",
    }],
  })
  assert.equal(sameUsageStats(row(300), row(300)), true)
  assert.equal(sameUsageStats(row(300), row(200)), false)
})

test("a later usage load is visible to every subscriber", async (t) => {
  invalidateUsageStats()
  const original = accountHttp.accountGetUsageStats
  const first = deferred<UsageStatsView>()
  const second = deferred<UsageStatsView>()
  const responses = [first.promise, second.promise]
  accountHttp.accountGetUsageStats = () => responses.shift()!
  t.after(() => {
    accountHttp.accountGetUsageStats = original
    invalidateUsageStats()
  })

  const pending = loadUsageStats({
    workspaceId: 7,
    from: "2026-08-01",
    to: "2026-08-30",
    force: true,
  })
  first.resolve(emptyStats(30, 1))
  await pending
  assert.equal(
    peekUsageStats(7, "2026-08-01", "2026-08-30")?.stats.total_microfen,
    100_000_000,
  )

  const next = loadUsageStats({
    workspaceId: 7,
    from: "2026-08-01",
    to: "2026-08-30",
    force: true,
  })
  second.resolve(emptyStats(30, 4))
  await next
  assert.equal(
    peekUsageStats(7, "2026-08-01", "2026-08-30")?.stats.total_microfen,
    400_000_000,
  )
})

test("header reads the summary snapshot, 用量 reads the full page", () => {
  const cache = readFileSync(fileURLToPath(new URL("./usage-cache.ts", import.meta.url)), "utf8")
  const summaryCache = readFileSync(
    fileURLToPath(new URL("./usage-summary-cache.ts", import.meta.url)),
    "utf8",
  )
  const sessionCache = readFileSync(
    fileURLToPath(new URL("../../lib/session-cache.ts", import.meta.url)),
    "utf8",
  )
  const header = readFileSync(
    fileURLToPath(new URL("../../components/workspace-quota-facts.tsx", import.meta.url)),
    "utf8",
  )
  const panel = readFileSync(
    fileURLToPath(new URL("./usage-stats-panel.tsx", import.meta.url)),
    "utf8",
  )
  assert.match(sessionCache, /from "zustand"/)
  assert.match(cache, /createSessionCache/)
  assert.match(summaryCache, /createSessionCache/)
  assert.match(summaryCache, /summary: true/)
  // The header heartbeat never fetches the 100-row request page.
  assert.match(header, /useUsageSummary/)
  assert.match(header, /loadUsageSummary/)
  assert.doesNotMatch(header, /useUsageStats/)
  assert.doesNotMatch(header, /accountGetUsageStats/)
  // The panel queries the exact selected range, not a days= preset window.
  assert.match(panel, /useUsageStats/)
  assert.match(panel, /loadUsageStats/)
  assert.doesNotMatch(panel, /preset === "last7"/)
  assert.doesNotMatch(panel, /accountGetUsageStats/)
  // "已花费" everywhere is the charged 口径 — no surface derives spend from
  // the nominal total (README 单一 owner 不变量; workspace-quota-facts 用它对齐 wallet.spent).
  assert.match(panel, /charged_microfen/)
  assert.doesNotMatch(panel, /total_microfen/)
  assert.match(header, /charged_microfen/)
  assert.doesNotMatch(header, /total_microfen/)
})

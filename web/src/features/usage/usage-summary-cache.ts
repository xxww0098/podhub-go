import type { UsageStatsView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { createSessionCache } from "@/lib/session-cache"

import { USAGE_CACHE_TTL_MS } from "./usage-cache"

/**
 * The header heartbeat only reads the range totals, never the 100-row request
 * page — `summary=1` lets its 60s beat skip the list query. A separate cache
 * on purpose: its `requests: []` payload must never land in the full-stats
 * entries the 用量 screen reads.
 */
const cache = createSessionCache<UsageStatsView>(
  () =>
    accountHttp.accountGetUsageStats({
      days: 30,
      page: 1,
      pageSize: 1,
      summary: true,
    }),
  { ttlMs: USAGE_CACHE_TTL_MS },
)

function usageSummaryCacheKey(workspaceId: number): string {
  return `${workspaceId}:summary:last30`
}

export function useUsageSummary(workspaceId?: number): UsageStatsView | null {
  const key = workspaceId === undefined ? undefined : usageSummaryCacheKey(workspaceId)
  return cache.use(key, (entry) => entry?.value ?? null)
}

export function loadUsageSummary(workspaceId: number): Promise<UsageStatsView> {
  return cache.load(usageSummaryCacheKey(workspaceId))
}

export function invalidateUsageSummary(): void {
  cache.invalidate()
}

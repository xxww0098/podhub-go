import type { UsageStatsView } from "@/bindings/commands"
import { accountHttp } from "@/bindings/http-account"
import { createSessionCache } from "@/lib/session-cache"

/** Keep a recent Workspace/range result local while operators move between Workspaces. */
export const USAGE_CACHE_TTL_MS = 60_000

/** One page is enough for both the header totals and the 用量 charts. */
export const USAGE_STATS_PAGE_SIZE = 100

export type UsageStatsCacheEntry = {
  stats: UsageStatsView
  cachedAt: number
}

const cache = createSessionCache<UsageStatsView>(
  (key) => {
    const [, from, to] = key.split(":")
    return accountHttp.accountGetUsageStats({
      from,
      to,
      page: 1,
      pageSize: USAGE_STATS_PAGE_SIZE,
    })
  },
  {
    ttlMs: USAGE_CACHE_TTL_MS,
    /** A refreshed-but-identical page keeps the old `stats` reference so readers do not re-render. */
    commit: ({ current, next, write }) => {
      write(current && sameUsageStats(current, next) ? current : next)
    },
  },
)

export function usageStatsCacheKey(workspaceId: number, from: string, to: string): string {
  return `${workspaceId}:${from}:${to}`
}

export function isUsageStatsCacheFresh(
  entry: UsageStatsCacheEntry,
  now = Date.now(),
  ttlMs = USAGE_CACHE_TTL_MS,
): boolean {
  return now - entry.cachedAt < ttlMs
}

export function sameUsageStats(
  current?: UsageStatsView | null,
  next?: UsageStatsView | null,
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  if (
    current.days !== next.days ||
    current.from !== next.from ||
    current.to !== next.to ||
    current.total_tokens !== next.total_tokens ||
    current.input_tokens !== next.input_tokens ||
    current.output_tokens !== next.output_tokens ||
    current.message_count !== next.message_count ||
    current.total_microfen !== next.total_microfen ||
    current.charged_microfen !== next.charged_microfen ||
    current.absorbed_microfen !== next.absorbed_microfen ||
    current.input_tokens !== next.input_tokens ||
    current.output_tokens !== next.output_tokens ||
    current.cached_input_tokens !== next.cached_input_tokens ||
    current.cache_hit_rate_bps !== next.cache_hit_rate_bps ||
    current.requests.length !== next.requests.length
  ) {
    return false
  }
  return current.requests.every((row, index) => {
    const other = next.requests[index]
    // Compare every data-bearing row field: the charts bucket by created_at
    // and split cached/uncached via cached_input_tokens, so a change the old
    // three-field check ignored kept the stale snapshot painted forever.
    return (
      other !== undefined &&
      row.request_id === other.request_id &&
      row.created_at === other.created_at &&
      row.status === other.status &&
      row.model === other.model &&
      row.operation === other.operation &&
      row.input_tokens === other.input_tokens &&
      row.cached_input_tokens === other.cached_input_tokens &&
      row.output_tokens === other.output_tokens &&
      row.reasoning_output_tokens === other.reasoning_output_tokens &&
      row.total_microfen === other.total_microfen &&
      row.charged_microfen === other.charged_microfen &&
      row.absorbed_microfen === other.absorbed_microfen
    )
  })
}

export function peekUsageStats(
  workspaceId?: number,
  from?: string,
  to?: string,
): UsageStatsCacheEntry | undefined {
  if (workspaceId === undefined || from === undefined || to === undefined) return undefined
  const entry = cache.peek(usageStatsCacheKey(workspaceId, from, to))
  return entry && { stats: entry.value, cachedAt: entry.cachedAt }
}

export function invalidateUsageStats(): void {
  cache.invalidate()
}

export function useUsageStats(
  workspaceId?: number,
  from?: string,
  to?: string,
): UsageStatsView | null {
  const key =
    workspaceId === undefined || from === undefined || to === undefined
      ? undefined
      : usageStatsCacheKey(workspaceId, from, to)
  return cache.use(key, (entry) => entry?.value ?? null)
}

export function loadUsageStats(options: {
  workspaceId: number
  from: string
  to: string
  force?: boolean
}): Promise<UsageStatsView> {
  return cache.load(usageStatsCacheKey(options.workspaceId, options.from, options.to), {
    force: options.force,
  })
}

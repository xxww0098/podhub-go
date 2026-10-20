import type { AdminUsageSummaryData } from "@/bindings/commands"
import { Badge } from "@/components/ui/badge"
import { formatUsageNumber } from "@/features/usage/usage-charts"
import { formatYuan } from "@/lib/money"

/** The relay operation names the ledger groups by: paid recognition vs chat. */
export function operationLabel(operation?: string | null): string {
  if (operation === "ocr") return "识图"
  if (operation === "ai_token") return "Chat"
  return operation ?? ""
}

export function formatLatency(value?: number | null): string {
  if (value == null) return "—"
  if (value < 1_000) return `${value} ms`
  const seconds = value / 1_000
  return `${seconds.toFixed(seconds >= 10 ? 1 : 2)} s`
}

export function formatGenerationSpeed(value?: number | null): string {
  return value == null ? "—" : `${(value / 1_000).toFixed(1)} t/s`
}

/** Basis points → percent; no settled input means no ratio, not zero percent. */
export function formatCacheHitRate(bps: number, inputTokens: number): string {
  return inputTokens > 0 ? `${(bps / 100).toFixed(1)}%` : "—"
}

function SummaryItem({
  label,
  value,
  detail,
  title,
}: {
  label: string
  value: string
  detail?: string
  title?: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5" title={title}>
      <span className="text-meta text-muted-foreground">{label}</span>
      <span className="font-mono text-compact tabular-nums text-foreground">{value}</span>
      {detail ? (
        <span className="text-meta text-faint-foreground">{detail}</span>
      ) : null}
    </div>
  )
}

/**
 * The aggregate twin of the staff request ledger: over the same filtered window,
 * the status mix, latency percentiles, and prompt-cache health that decide
 * whether a relay tuning (streaming, pacing, concurrency) has a problem worth
 * solving — the admission measurements docs/ocr.md §6.3 asks for.
 */
export function UsageSummaryStrip({ data }: { data: AdminUsageSummaryData }) {
  return (
    <div className="grid grid-cols-2 items-start gap-4 border-b border-border p-4 lg:grid-cols-3">
      <SummaryItem
        label="请求"
        value={formatUsageNumber(data.total_rows)}
        detail={`正常 ${data.settled_rows} · 失败 ${data.failed_rows} · 未计费待确认 ${data.unbilled_unknown_rows} · 处理中 ${data.in_flight_rows}`}
      />
      <SummaryItem
        label="上游延迟"
        value={formatLatency(data.upstream_latency_p50_ms)}
        detail={`p90 ${formatLatency(data.upstream_latency_p90_ms)} · p99 ${formatLatency(data.upstream_latency_p99_ms)}`}
        title="上游派发到结算的生成耗时，不含钱包与准入等待"
      />
      <SummaryItem
        label="总延迟"
        value={formatLatency(data.latency_p50_ms)}
        detail={`p90 ${formatLatency(data.latency_p90_ms)} · p99 ${formatLatency(data.latency_p99_ms)}`}
        title="Cloud 收到请求到终态的完整耗时"
      />
      <SummaryItem
        label="生成速度中位"
        value={formatGenerationSpeed(data.generation_speed_milli_tps_median)}
      />
      <SummaryItem
        label="缓存命中率"
        value={formatCacheHitRate(data.cache_hit_rate_bps, data.input_tokens)}
        detail={`输入 ${formatUsageNumber(data.input_tokens)} · 缓存读取 ${formatUsageNumber(data.cached_input_tokens)}`}
        title="命中缓存的输入 token 占比，缓存输入按半价计费"
      />
      <SummaryItem
        label="实收"
        value={formatYuan(data.charged_microfen)}
        detail={
          data.absorbed_microfen > 0 ? `平台封顶减免 ${formatYuan(data.absorbed_microfen)}` : undefined
        }
      />
      {data.failure_classes.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-meta text-muted-foreground">失败分类</span>
          <div className="flex flex-wrap gap-1.5">
            {data.failure_classes.map((failure) => (
              <Badge key={failure.error_class} variant="outline">
                {failure.error_class} × {failure.count}
              </Badge>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}

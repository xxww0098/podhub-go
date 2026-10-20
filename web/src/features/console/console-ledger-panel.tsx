/** Pure ledger presentation accepts exact aggregates; it never reads/reconciles. */
import { StateChip } from "@/components/state-chip"
import { formatPercentPoint } from "@/lib/format"
import { LedgerTrendChart } from "./console-charts"
import { formatAge, formatInteger } from "./console-format"
import type { LedgerSummary } from "./console-metrics"
import { Panel } from "./console-panels"

export function LedgerSummaryPanel({ summary, active }: { summary: LedgerSummary; active: boolean }) {
  const stats = [
    { label: "证明成功率", value: summary.provenSuccessRate == null ? "—" : formatPercentPoint(summary.provenSuccessRate) },
    { label: "中位收敛耗时", value: summary.medianSettlementMinutes == null ? "—" : formatAge(summary.medianSettlementMinutes / 60) },
    { label: "在途", value: formatInteger(summary.inFlight) + " 项" },
    { label: "待介入", value: formatInteger(summary.needsAction) + " 项" },
  ]
  return <Panel title="上架账本" subtitle="最近 14 个 UTC 日 · 全范围原始行精确聚合 · 只读">
    <dl className="grid grid-cols-2 gap-3 border-b border-border/50 pb-3 sm:grid-cols-4">
      {stats.map((stat) => <div key={stat.label} className="grid gap-1">
        <dt className="text-meta text-muted-foreground">{stat.label}</dt>
        <dd className="font-mono text-md font-semibold tabular-nums">{stat.value}</dd>
      </div>)}
    </dl>
    <div className="mt-3 flex flex-wrap gap-3 text-meta text-muted-foreground" aria-label="账本趋势图例">
      <span>新上架</span><span>已收敛</span><span>待介入</span>
    </div>
    <LedgerTrendChart summary={summary} active={active} />
    <ul className="flex flex-wrap gap-3 border-t border-border/50 pt-3" aria-label="账本结果结构">
      {summary.outcomes.map((outcome) => <li key={outcome.key} className="flex items-center gap-2">
        <StateChip status={outcome.key} label={outcome.label} tone={outcome.tone} />
        <span className="font-mono text-compact tabular-nums">{formatInteger(outcome.value)}</span>
      </li>)}
    </ul>
    {summary.oldestActionHours != null ? <p className="mt-3 text-meta text-muted-foreground">待介入最久等待 {formatAge(summary.oldestActionHours)}；此处不执行对账。</p> : null}
  </Panel>
}

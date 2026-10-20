import type { WorkflowProductLifecycle } from "@/bindings/commands"

export type ReconcileFilter = "all" | "checking" | "needs_manual"
export type ReconcilePhase = "checking" | "needs_manual" | "none"

type ProbeLifecycle = Pick<WorkflowProductLifecycle, "stage" | "importProbe" | "last_error_code">

/** `outcome_unknown` is one stage. The probe phase splits 核对中 from 需人工核对. */
export function reconcilePhase(lifecycle: ProbeLifecycle | undefined): ReconcilePhase {
  if (!lifecycle || lifecycle.stage !== "outcome_unknown") return "none"
  if (
    lifecycle.importProbe?.phase === "needs_manual"
    || lifecycle.last_error_code === "OZON_RECONCILE_STILL_UNKNOWN"
  ) return "needs_manual"
  return "checking"
}

export function reconcilePhaseOf(
  row: { stage?: string; draftId: string },
  drafts: Record<string, { lifecycle?: ProbeLifecycle } | undefined>,
): ReconcilePhase {
  const lifecycle = drafts[row.draftId]?.lifecycle
  if (lifecycle) return reconcilePhase(lifecycle)
  return row.stage === "outcome_unknown" ? "checking" : "none"
}

export function filterReconcileRows<T extends { stage?: string; draftId: string }>(
  rows: readonly T[],
  drafts: Record<string, { lifecycle?: ProbeLifecycle } | undefined>,
  filter: ReconcileFilter,
): T[] {
  if (filter === "all") return [...rows]
  return rows.filter((row) => reconcilePhaseOf(row, drafts) === filter)
}

export function reconcileCounts(
  rows: readonly { stage?: string; draftId: string }[],
  drafts: Record<string, { lifecycle?: ProbeLifecycle } | undefined>,
): { checking: number; needsManual: number } {
  let checking = 0
  let needsManual = 0
  for (const row of rows) {
    const phase = reconcilePhaseOf(row, drafts)
    if (phase === "checking") checking += 1
    else if (phase === "needs_manual") needsManual += 1
  }
  return { checking, needsManual }
}

function clock(ms: number): string {
  const date = new Date(ms)
  const hour = String(date.getHours()).padStart(2, "0")
  const minute = String(date.getMinutes()).padStart(2, "0")
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hour}:${minute}`
}

/** Count, and the next automatic read while the scanner is still scheduled. */
export function reconcileScheduleText(
  probe: WorkflowProductLifecycle["importProbe"],
  now = Date.now(),
): string | undefined {
  if (!probe) return undefined
  const count = `已核对 ${Math.max(0, probe.passes)} 次`
  if (probe.phase !== "checking" || probe.nextCheckAtMs == null) return count
  if (probe.nextCheckAtMs <= now) return `${count}，即将自动核对`
  return `${count}，下次核对 ${clock(probe.nextCheckAtMs)}`
}

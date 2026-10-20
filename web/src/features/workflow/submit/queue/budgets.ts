import type { PublishBudget, PublishQueueState } from "../../rows/types"

export function spendSubmit(budget: PublishBudget): boolean {
  if (budget.submits >= 6) return false
  budget.submits += 1
  return true
}
export function spendRepair(budget: PublishBudget, kind: "schema" | "media"): boolean {
  if (budget[kind] >= 1 || budget.submits >= 6) return false
  budget[kind] += 1
  return true
}
/** Three busy retries over the whole action/destination, within 30 seconds. */
export function spendBusy(state: PublishQueueState, key: string, now: number): boolean {
  const budget = state.busy[key] ??= { attempts: 0, startedAt: now }
  const delay = (budget.attempts + 1) * 5_000
  if (budget.attempts >= 3 || now - budget.startedAt + delay > 30_000 || now < budget.startedAt) return false
  budget.attempts += 1
  return true
}

/** Stop interrupts waits, never an already-dispatched request. */
export function waitForAdmission(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, ms)
    if (signal.aborted) done()
    else signal.addEventListener("abort", done, { once: true })
  })
}

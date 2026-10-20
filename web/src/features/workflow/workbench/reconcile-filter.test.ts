import assert from "node:assert/strict"
import test from "node:test"
import {
  filterReconcileRows,
  reconcileCounts,
  reconcilePhase,
  reconcileScheduleText,
} from "./reconcile-filter"

const row = (id: string, stage: string) => ({ draftId: id, stage })

test("unknown imports split into checking and needs-manual without a new stage", () => {
  assert.equal(reconcilePhase({ stage: "accepted" }), "none")
  assert.equal(reconcilePhase({ stage: "outcome_unknown" }), "checking")
  assert.equal(reconcilePhase({
    stage: "outcome_unknown",
    importProbe: { phase: "checking", passes: 2, nextCheckAtMs: 1 },
  }), "checking")
  assert.equal(reconcilePhase({
    stage: "outcome_unknown",
    importProbe: { phase: "needs_manual", passes: 8 },
  }), "needs_manual")
  assert.equal(reconcilePhase({
    stage: "outcome_unknown",
    last_error_code: "OZON_RECONCILE_STILL_UNKNOWN",
  }), "needs_manual")
})

test("the list filter keeps only the selected probe phase", () => {
  const rows = [
    row("a", "outcome_unknown"),
    row("b", "outcome_unknown"),
    row("c", "accepted"),
  ]
  const drafts = {
    a: { lifecycle: { stage: "outcome_unknown" as const, importProbe: { phase: "checking" as const, passes: 1 } } },
    b: { lifecycle: { stage: "outcome_unknown" as const, importProbe: { phase: "needs_manual" as const, passes: 8 } } },
    c: { lifecycle: { stage: "accepted" as const } },
  }
  assert.deepEqual(filterReconcileRows(rows, drafts, "checking").map((item) => item.draftId), ["a"])
  assert.deepEqual(filterReconcileRows(rows, drafts, "needs_manual").map((item) => item.draftId), ["b"])
  assert.equal(filterReconcileRows(rows, drafts, "all").length, 3)
  assert.deepEqual(reconcileCounts(rows, drafts), { checking: 1, needsManual: 1 })
})

test("the schedule names the next read only while checking", () => {
  const future = Date.UTC(2099, 0, 2, 3, 4)
  const checking = reconcileScheduleText(
    { phase: "checking", passes: 2, nextCheckAtMs: future },
    future - 60_000,
  )
  assert.match(checking ?? "", /已核对 2 次，下次核对 /)
  assert.equal(
    reconcileScheduleText({ phase: "checking", passes: 2, nextCheckAtMs: future }, future),
    "已核对 2 次，即将自动核对",
  )
  const stopped = reconcileScheduleText({ phase: "needs_manual", passes: 8, nextCheckAtMs: future })
  assert.equal(stopped, "已核对 8 次")
  assert.doesNotMatch(stopped ?? "", /下次/)
})

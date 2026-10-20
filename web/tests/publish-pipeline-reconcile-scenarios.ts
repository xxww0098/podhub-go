/** Actual final queue/capability, real DOM gestures and clocks; transport alone is mocked. */
import assert from "node:assert/strict"
import type { Page } from "playwright-core"
import type { PipelineEvidence } from "./publish-pipeline-metrics"
import type { QueueEvidence, Scenario } from "./publish-pipeline-browser-contract"
import type { RunnerOperation } from "./publish-pipeline-browser-trace"
import { action, readEvidence } from "./publish-pipeline-browser-scenarios"
import { waitForPage } from "./publish-pipeline-browser-wait"

const button = (page: Page, name: string) => page.getByRole("button", { name, exact: true })
const state = (evidence: PipelineEvidence) => evidence.state as QueueEvidence
const submits = (evidence: PipelineEvidence) => evidence.business.filter((event) => event.operation === "submit" && event.event === "dispatch")
const reads = (evidence: PipelineEvidence) => evidence.business.filter((event) => event.operation === "intents" && event.event === "dispatch")
const labels = { "admission-store-unavailable": "多块店铺不可用", "admission-capacity-full": "多块容量已满", "admission-offer-busy": "多块货号占用",
  "admission-busy-exhausted": "持续店铺忙", "reconcile-pending-200": "多批权威待决", "reconcile-lost-history": "提交已落库但响应丢失" } as const

export async function driveReconcileScenario(page: Page, scenario: Scenario, screenshot: (label: string) => Promise<void>, operation: RunnerOperation) {
  const label = labels[scenario as keyof typeof labels]
  assert.ok(label, "each S16 scenario needs its own exercised mode")
  await operation("pre-import", () => operation("scenario-selection", () => button(page, label).click()))
  await operation("initial-import", () => action(page, "导入 1000 行", "import"))
  await action(page, "编辑首行价格", "single-edit")
  await action(page, "校验与拼接", "validate-compose")
  const initial = await readEvidence(page)
  assert.equal(state(initial).rowCount, 1000)
  assert.deepEqual(initial.native.find((entry) => entry.kind === "validate-compose")!.value, { requested: 1000, prepared: 1000, blocked: 0 })
  assert.equal(initial.business.length, 0)
  for (const destination of ["fixture-a", "fixture-b"]) assert.equal(state(initial).rows.filter((row) => row.destination === destination).length, 500)
  await page.getByRole("checkbox", { name: "保持首块响应以取证" }).check()
  await button(page, "发送").dblclick()
  await waitForPage(page, () => window.publishPipelineMetrics.business.filter((entry) => entry.operation === "submit" && entry.event === "held").length === 2, undefined)
  await screenshot("loading")
  await button(page, "释放模拟响应或修复").click()
  await waitForPage(page, () => window.publishPipelineMetrics.actions.some((entry) => entry.name === "normal-send" && entry.end !== undefined), undefined, { timeout: 90_000 })
  let evidence = await readEvidence(page)
  assert.equal(evidence.actions.find((entry) => entry.name === "normal-send")!.status, "passed")
  assert.ok(submits(evidence).every((entry) => entry.rowIds!.length <= 100 && entry.requestBytes! <= 7.5 * 1024 * 1024))
  assert.equal(evidence.business.filter((entry) => entry.operation === "submit" && entry.event === "abort").length, 0)
  let peak = 0
  const active = new Map<number, string>()
  for (const event of evidence.business.filter((entry) => entry.operation === "submit")) {
    if (event.event === "dispatch") { assert.ok(![...active.values()].includes(event.destination!)); active.set(event.request, event.destination!); peak = Math.max(peak, active.size) }
    else if (event.event === "response" || event.event === "rejection") active.delete(event.request)
  }
  assert.equal(peak, 2); assert.equal(active.size, 0)

  if (scenario.startsWith("admission-")) {
    const codes = { "admission-store-unavailable": "store_unavailable", "admission-capacity-full": "submit_capacity_full",
      "admission-offer-busy": "offer_busy", "admission-busy-exhausted": "store_busy" } as const
    const code = codes[scenario as keyof typeof codes]
    const a = submits(evidence).filter((event) => event.destination === "fixture-a")
    const parents = state(evidence).parents!, before = state(evidence)
    assert.equal(submits(evidence).filter((event) => event.destination === "fixture-b").length, 5)
    assert.equal(before.snapshot.counts.accepted, 500); assert.equal(before.snapshot.counts.rejected, 100); assert.equal(before.snapshot.counts.unknown, 0)
    assert.equal(before.rows.filter((row) => row.destination === "fixture-a" && row.state === "ready").length, 400)
    const blocked = parents.filter((parent) => parent.destination === "fixture-a")
    assert.deepEqual(blocked.slice(1).map((parent) => [parent.state, parent.budget.submits, parent.remaining]), Array.from({ length: 4 }, () => ["pending", 0, 100]))
    assert.equal(blocked[0]!.state, "halted"); assert.equal(blocked[0]!.remaining, 100); assert.equal(blocked[0]!.haltReason?.code, code)
    if (code !== "store_busy") assert.equal(a.length, 1)
    else {
      const busy = Object.values(before.busy!)[0]!
      const deadline = busy.startedAt + 30_000, halt = blocked[0]!.haltReason!
      const dispatches = evidence.native.filter((entry) => entry.kind === "busy-admission-dispatch")
        .map((entry) => entry.value as { request: number; destination: string; at: number }).filter((entry) => entry.destination === "fixture-a")
      const waits = evidence.native.filter((entry) => entry.kind === "busy-admission-wait").map((entry) => entry.value as {
        actionId: string; requestedMs: number; startedAt: number; endedAt: number; aborted: boolean
        reservations: { blockId: string; platform: string; destination: string; dueAt: number; submits: number; busy: typeof busy }[]
      })
      assert.deepEqual(dispatches.map((entry) => entry.request), a.map((entry) => entry.request))
      assert.ok(a.length >= 1 && a.length <= 4)
      assert.ok(busy.attempts >= 1 && busy.attempts <= 3)
      assert.ok(busy.attempts === a.length - 1 || busy.attempts === a.length, "at most one reserved retry can expire without dispatch")
      assert.ok(waits.length === busy.attempts || waits.length === busy.attempts - 1 && halt.at > deadline, "only an expired reservation may halt before entering its wait")
      for (let i = 0; i < waits.length; i++) {
        const wait = waits[i]!, reservation = wait.reservations[0]!
        assert.equal(wait.reservations.length, 1); assert.equal(wait.actionId, before.actionId); assert.equal(wait.aborted, false)
        assert.equal(reservation.blockId, blocked[0]!.id); assert.equal(reservation.platform, "ozon"); assert.equal(reservation.destination, "fixture-a")
        assert.deepEqual(reservation.busy, { attempts: i + 1, startedAt: busy.startedAt })
        assert.equal(reservation.submits, i + 1)
        const nominalMs = (i + 1) * 5000 // Exactly 5/10/15s; persistence may consume part of the absolute wait.
        assert.ok(wait.requestedMs >= 0 && wait.requestedMs <= nominalMs)
        assert.ok(wait.startedAt >= reservation.dueAt - wait.requestedMs)
        assert.ok(reservation.dueAt - nominalMs >= dispatches[i]!.at)
        assert.ok(wait.endedAt >= reservation.dueAt && wait.endedAt <= halt.at)
        if (dispatches[i + 1]) assert.ok(dispatches[i + 1]!.at >= wait.endedAt && dispatches[i + 1]!.at <= deadline)
      }
      assert.ok(dispatches.slice(1).every((entry) => entry.at >= busy.startedAt && entry.at <= deadline))
      for (const entry of a) assert.deepEqual(entry.rowIds, a[0]!.rowIds)
      if (halt.cause === "retries_exhausted") {
        assert.equal(busy.attempts, 3); assert.equal(waits.length, 3); assert.equal(a.length, 4)
      } else {
        assert.equal(halt.cause, "deadline_exhausted")
        if (busy.attempts === a.length - 1) {
          assert.ok(busy.attempts < 3 && halt.at + (busy.attempts + 1) * 5000 > deadline, "the next nominal wait would exceed the original deadline")
        } else assert.ok(halt.at > deadline, "the already-reserved retry expired before dispatch")
      }
      if (blocked[0]!.budget.submits !== a.length) {
        assert.equal(blocked[0]!.budget.submits, a.length + 1)
        assert.equal(busy.attempts, a.length); assert.equal(waits.length, busy.attempts)
        assert.ok(waits.at(-1)!.endedAt <= deadline && halt.at > deadline, "only expiry during native preparation/persistence can spend admission credit without fetch")
      }
    }
    await screenshot("admission-halted")
    assert.equal(await button(page, "核对结果").isDisabled(), true, "confirmed refusal is not an unknown history query")
    await action(page, "继续", "continue")
    await action(page, "重新载入本地队列", "reload")
    await action(page, "继续", "continue")
    evidence = await readEvidence(page)
    assert.equal(submits(evidence).length, a.length + 5); assert.equal(reads(evidence).length, 0)
    assert.deepEqual(state(evidence).parents, parents)
    assert.deepEqual(state(evidence).busy, before.busy)
    assert.equal(state(evidence).actionId, before.actionId)
    assert.equal(state(evidence).snapshot.halts[0]!.reason.code, code)
    await action(page, "fixture-a 显式重试原块", "continue")
    evidence = await readEvidence(page)
    const afterA = submits(evidence).filter((entry) => entry.destination === "fixture-a")
    assert.equal(afterA.length, a.length + 1)
    assert.deepEqual(afterA.at(-1)!.rowIds, a[0]!.rowIds)
    assert.equal(state(evidence).parents![0]!.id, parents[0]!.id)
    assert.equal(state(evidence).actionId, before.actionId)
    assert.deepEqual(state(evidence).busy, before.busy)
    assert.equal(state(evidence).parents![0]!.budget.submits, blocked[0]!.budget.submits + 1)
    assert.equal(submits(evidence).filter((entry) => entry.destination === "fixture-b").length, 5)
    assert.ok(state(evidence).parents!.filter((parent) => parent.destination === "fixture-a").slice(1).every((parent) => parent.budget.submits === 0))
  } else if (scenario === "reconcile-lost-history") {
    assert.deepEqual(state(evidence).snapshot.counts, { accepted: 500, pending: 0, rejected: 0, unknown: 100 })
    const before = state(evidence), sent = submits(evidence).length
    await action(page, "核对结果", "query")
    evidence = await readEvidence(page)
    const result = state(evidence).reconciliation!
    assert.equal(result.mode, "history"); assert.equal(result.rowIds.length, 100)
    assert.equal(result.rows.reduce((sum, row) => sum + row.candidates.length, 0), 100)
    assert.deepEqual(result.appliedRowIds, []); assert.ok(result.rows.every((row) => !row.fact))
    assert.deepEqual(state(evidence).rows, before.rows)
    assert.equal(reads(evidence).length, 1); assert.equal(reads(evidence)[0]!.destination, "fixture-a")
    await page.getByRole("region", { name: "所选批次核对结果" }).getByText("查看所选批次的候选身份与状态", { exact: true }).click()
    await screenshot("manual-history")
    await action(page, "继续", "continue")
    evidence = await readEvidence(page)
    assert.equal(submits(evidence).length, sent)
    assert.equal(state(evidence).snapshot.counts.unknown, 100)
  } else {
    assert.deepEqual(state(evidence).snapshot.counts, { accepted: 500, pending: 500, rejected: 0, unknown: 0 })
    const before = state(evidence), first = before.rows.filter((row) => row.destination === "fixture-a").slice(0, 100).map((row) => row.id)
    const second = before.rows.filter((row) => row.destination === "fixture-a").slice(100, 200).map((row) => row.id)
    await page.getByRole("combobox", { name: "核对批次" }).selectOption({ label: "ozon / fixture-a / 已有权威身份 / 第 1 批（100 行）" })
    await action(page, "核对结果", "query")
    evidence = await readEvidence(page)
    assert.deepEqual(state(evidence).reconciliation!.appliedRowIds, first)
    assert.equal(reads(evidence).length, 1)
    assert.deepEqual(state(evidence).snapshot.counts, { accepted: 600, pending: 400, rejected: 0, unknown: 0 })
    assert.deepEqual(state(evidence).rows.filter((row) => !first.includes(row.id)), before.rows.filter((row) => !first.includes(row.id)))
    await page.getByRole("combobox", { name: "核对批次" }).selectOption({ label: "ozon / fixture-a / 已有权威身份 / 第 1 批（100 行）" })
    await action(page, "核对结果", "query")
    evidence = await readEvidence(page)
    assert.deepEqual(state(evidence).reconciliation!.appliedRowIds, second)
    assert.equal(reads(evidence).length, 2); assert.equal(submits(evidence).length, 10)
    assert.deepEqual(state(evidence).snapshot.counts, { accepted: 700, pending: 300, rejected: 0, unknown: 0 })
    const queries = evidence.native.filter((entry) => entry.kind === "mock-intent-query").map((entry) => entry.value as { storeId: string; intentIds: string[]; limit: number; latestPerRow: boolean })
    assert.deepEqual(queries, [first, second].map((rowIds) => ({ storeId: "fixture-a", intentIds: rowIds.map((id) => `fixture-intent-${id}`), limit: 100, latestPerRow: true })))
    assert.deepEqual(state(evidence).parents, before.parents)
    await screenshot("two-explicit-batches")
  }
  assert.ok(state(evidence).parents!.every((parent) => parent.budget.submits <= 6 && parent.budget.schema <= 1 && parent.budget.media <= 1))
  await action(page, "测量空闲 2 秒", "idle")
}

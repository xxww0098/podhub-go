import assert from "node:assert/strict"
import test from "node:test"

import type {
  WorkflowDraftView,
  WorkflowOperationRowResult,
  WorkflowProductLifecycle,
  WorkflowReadinessReport,
} from "@/bindings/commands"

import { workbenchScopes } from "./batch-actions"
import { runWorkflowOperationBatch } from "./batch-operation"
import type { ListingRow } from "./model/listing-row"
import type { PreparationActivity } from "./prepare/preparation-tracks"

const lifecycle = (
  over: Partial<WorkflowProductLifecycle> = {},
): WorkflowProductLifecycle => ({
  revision: 1,
  view_revision: 1,
  image_total: 0,
  image_completed: 0,
  stage: "awaiting_content",
  ai: "pending",
  media: "pending",
  fields: "dirty",
  images: [],
  failure_log: [],
  ai_candidates: [],
  product_videos: [],
  ...over,
})

const needsPreparation: WorkflowReadinessReport = {
  ready_to_publish: false,
  can_start_publish_attempt: false,
  blockers: ["ai_pending"],
  allowed_actions: ["prepare"],
}

/** A row the Host would accept a publish command for. */
const readyToPublish: WorkflowReadinessReport = {
  ready_to_publish: true,
  can_start_publish_attempt: true,
  blockers: [],
  allowed_actions: ["publish", "edit_fields"],
}

const outcomeUnknown: WorkflowReadinessReport = {
  ready_to_publish: false,
  can_start_publish_attempt: false,
  blockers: [],
  allowed_actions: ["reconcile"],
}

function row(index: number, over: Partial<ListingRow> = {}): ListingRow {
  const imageName = `SZ-000${index}.png`
  return {
    id: `row-${index}`,
    draftId: `workflow_instance_${index}`,
    imageName,
    source: { handle: `handle-${index}`, file_name: imageName },
    status: "pending",
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "已导入",
    readiness: needsPreparation,
    ...over,
  }
}

function draftsFor(
  rows: ListingRow[],
  phases: Record<string, Partial<WorkflowProductLifecycle>> = {},
) {
  return Object.fromEntries(
    rows.map((item) => [item.draftId, { lifecycle: lifecycle(phases[item.id]) }]),
  )
}

const idleActivity: PreparationActivity = {
  ai: new Set(),
  render: new Set(),
  deliver: new Set(),
}

test("without a selection every unsent row is in scope", () => {
  const unsent = row(1, { readiness: readyToPublish })
  const sent = row(2, { status: "sent" })
  const rows = [unsent, sent]
  // Only the unsent row has an instance: a lifecycle phase outranks the
  // painted row status when the two disagree.
  const scopes = workbenchScopes(
    rows,
    draftsFor([unsent], { "row-1": { stage: "ready_to_publish" } }),
    new Set(),
    idleActivity,
    false,
    false,
  )
  assert.deepEqual(scopes.picked, [])
  assert.deepEqual(scopes.unsent.map((item) => item.id), ["row-1"])
  assert.equal(scopes.sentCount, 1)
  assert.deepEqual(scopes.sendTargets.map((item) => item.id), ["row-1"])
})

test("a selection narrows the scope to the picked rows only", () => {
  const picked = row(1)
  const other = row(2)
  const rows = [picked, other]
  const scopes = workbenchScopes(
    rows,
    draftsFor(rows),
    new Set(["row-1"]),
    idleActivity,
    false,
    false,
  )
  assert.deepEqual(scopes.picked.map((item) => item.id), ["row-1"])
  // prepare / clear / repair read the scope, so the unselected row is absent
  // even though it is unsent.
  assert.deepEqual(scopes.prepareTargets.map((item) => item.id), ["row-1"])
})

test("a lifecycle phase that means sent moves the row out of unsent", () => {
  const dispatched = row(1)
  const rows = [dispatched]
  const scopes = workbenchScopes(
    rows,
    draftsFor(rows, { "row-1": { stage: "accepted" } }),
    new Set(),
    idleActivity,
    false,
    false,
  )
  assert.equal(scopes.sentCount, 1)
  assert.deepEqual(scopes.unsent, [])
  assert.deepEqual(scopes.sendTargets, [])
})

test("the unknown-outcome tally follows the queue state, not the row count", () => {
  const rows = [
    row(1, { stage: "outcome_unknown", readiness: outcomeUnknown }),
    row(2, { stage: "outcome_unknown", readiness: outcomeUnknown }),
  ]
  const drafts = draftsFor(rows)
  const running = workbenchScopes(rows, drafts, new Set(), idleActivity, true, false)
  assert.equal(running.awaitingReceiptCount, 2)
  assert.equal(running.unknownOutcomeCount, 0)
  const paused = workbenchScopes(rows, drafts, new Set(), idleActivity, false, true)
  assert.equal(paused.awaitingReceiptCount, 0)
  assert.equal(paused.unknownOutcomeCount, 2)
})

test("unknown-outcome rows are release targets only while the queue is idle", () => {
  const rows = [
    row(1, { stage: "outcome_unknown", readiness: outcomeUnknown }),
    row(2, { stage: "outcome_unknown", readiness: outcomeUnknown }),
    row(3, { readiness: readyToPublish }),
  ]
  const drafts = draftsFor(rows)
  const idle = workbenchScopes(rows, drafts, new Set(), idleActivity, false, false)
  assert.deepEqual(idle.releaseTargets.map((item) => item.id), ["row-1", "row-2"])
  // Released rows reopen through send, never through the release verb itself.
  assert.ok(!idle.sendTargets.some((item) => item.stage === "outcome_unknown"))
  const picked = workbenchScopes(rows, drafts, new Set(["row-2", "row-3"]), idleActivity, false, false)
  assert.deepEqual(picked.releaseTargets.map((item) => item.id), ["row-2"])
  assert.deepEqual(workbenchScopes(rows, drafts, new Set(), idleActivity, true, false).releaseTargets, [])
  assert.deepEqual(workbenchScopes(rows, drafts, new Set(), idleActivity, false, true).releaseTargets, [])
})

test("ready lanes are counted from the lifecycle", () => {
  const rows = [row(1), row(2)]
  const scopes = workbenchScopes(
    rows,
    draftsFor(rows, { "row-1": { ai: "ready", media: "ready" } }),
    new Set(),
    idleActivity,
    false,
    false,
  )
  assert.equal(scopes.aiReadyCount, 1)
  assert.equal(scopes.mediaReadyCount, 1)
  // Both lanes ready on the only prepared row: nothing left to prepare.
  assert.deepEqual(scopes.prepareTargets.map((item) => item.id), ["row-2"])
})

test("a row with a live lane claim is not a clear target", () => {
  const busy = row(1)
  const free = row(2)
  const rows = [busy, free]
  const scopes = workbenchScopes(
    rows,
    draftsFor(rows),
    new Set(),
    { ...idleActivity, deliver: new Set(["row-1"]) },
    false,
    false,
  )
  assert.deepEqual(scopes.clearTargets.map((item) => item.id), ["row-2"])
})

test("a running row and a source-less row are held back", () => {
  const running = row(1, { status: "running" })
  const sourceless = row(2, { source: undefined })
  const rows = [running, sourceless]
  const scopes = workbenchScopes(
    rows,
    draftsFor(rows),
    new Set(),
    idleActivity,
    false,
    false,
  )
  assert.deepEqual(scopes.clearTargets.map((item) => item.id), ["row-2"])
  assert.deepEqual(scopes.prepareTargets.map((item) => item.id), ["row-1"])
})
test("only a brand-rejected conflict is a repair target", () => {
  const rejected = row(1, { readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["publish_conflict"], allowed_actions: ["edit_fields"] } })
  const plain = row(2)
  const rows = [rejected, plain]
  const scopes = workbenchScopes(
    rows,
    draftsFor(rows, {
      "row-1": {
        stage: "publish_rejected",
        ai: "ready",
        media: "ready",
        last_error_code: "BR_hashtag_brand",
      },
    }),
    new Set(),
    idleActivity,
    false,
    false,
  )
  assert.deepEqual(scopes.repairTargets.map((item) => item.id), ["row-1"])
})

// Stop leaves most of a batch unadmitted: those rows come back cancelled with no
// projection, and re-reading each from Cloud held Stop on ~90 serial GETs.
test("a stopped batch settles its cancelled rows without a Cloud re-read each", async () => {
  const targets = Array.from({ length: 100 }, (_, index) => row(index + 1))
  const drafts = draftsFor(targets) as Record<string, WorkflowDraftView>
  let rows = targets
  const settled = new Map<string, boolean>()
  const reread: string[] = []
  const failures = await runWorkflowOperationBatch(
    targets,
    {
      drafts: () => drafts,
      patchRow: (rowId, patch) => {
        rows = rows.map((item) => (item.id === rowId ? { ...item, ...patch } : item))
      },
      startRows: (rowIds, patch) => {
        rows = rows.map((item) => (rowIds.includes(item.id) ? { ...item, ...patch } : item))
      },
      commitProduct: () => undefined,
      settleProgress: (rowId, failed) => settled.set(rowId, failed),
      settleRow: async (target, _log, failed) => {
        reread.push(target.id)
        settled.set(target.id, failed)
      },
    },
    async (request, onRow) => {
      // Row 1 was in flight and failed. The executor streams the unadmitted
      // rows it reached; the renderer's skipped rows only come back returned.
      const results: WorkflowOperationRowResult[] = request.row_ids.map((row_id, index) => index === 0
        ? { row_id, outcome: "start", blockers: [], error: { code: "workflow_ai_failed", message: "模型超时", remediation: null } }
        : { row_id, outcome: "noop", blockers: [], noop_reason: "cancelled" })
      for (const result of results.slice(0, 50)) onRow(result)
      return results
    },
    { status: "running", ai: "running", log: "AI 识别已开始" },
    "AI 识别已完成",
  )

  assert.deepEqual(reread, ["row-1"], "only the failed row is read back from Cloud")
  assert.equal(failures.length, 1)
  assert.equal(settled.size, 100)
  for (const item of rows.slice(1)) {
    assert.equal(settled.get(item.id), false)
    assert.deepEqual([item.status, item.ai, item.log], ["pending", "idle", "准备已停止"])
  }
})

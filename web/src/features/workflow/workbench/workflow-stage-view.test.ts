import assert from "node:assert/strict"
import test from "node:test"
import type { RowStage, WorkflowDraftView } from "@/bindings/commands"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { workbenchScopes } from "../batch-actions"
import { product } from "../cloud-fanout-tests/fixtures"
import type { ListingRow } from "../model/listing-row"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { rowStatusView } from "../model/row-state"
import { NO_PREPARATION_ACTIVITY } from "../prepare/preparation-tracks"
import { batchSelectionScopes } from "./workbench-contract"
import { listingWorkbenchScope, patchListingWorkbench, peekListingWorkbench, receiveListingProducts, resetListingWorkbench } from "./listing-workbench-store"
import { WORKFLOW_STAGE_VIEWS, workflowStageViewOf, workflowStageViewScope, type WorkflowStageView } from "./workflow-stage-view"

const expected = {
  materials: ["awaiting_content"],
  processing: ["recognizing", "recognition_failed", "rendering", "uploading", "media_failed", "candidates_pending", "fields_invalid"],
  ready: ["build_stale", "ready_to_publish"],
  receipts: ["queued", "submitting", "outcome_unknown", "accepted", "publish_rejected", "operator_attested"],
} satisfies Record<WorkflowStageView, RowStage[]>

function item(id: string, stage: RowStage, viewRevision = 1) {
  const before = product(id)
  const canSend = stage === "ready_to_publish" || stage === "build_stale"
  const status = rowStatusView({
    id, card_id: "card", store_id: "store", revision: 1, view_revision: viewRevision,
    content_state: "ready", media_state: "ready", validation_state: "passed", submission_state: "none",
    projection: listingProjection({ stage, readiness: { ready_to_publish: canSend, can_start_publish_attempt: canSend,
      blockers: [], allowed_actions: canSend ? ["publish", "edit_fields"] : [] } }),
    draft: before.draft, validation_issues: [], media: { images: [] }, ai: {}, source: {}, payload: {},
    updated_at_ms: viewRevision, build: { state: "built", sources: [] },
  })
  const draft: WorkflowDraftView = { ...before, ...status }
  const row = projectListingRowLifecycle({ id, draftId: id, imageName: `${id}.png`, status: "pending",
    ai: "idle", render: "idle", upload: "idle", log: "" }, draft.lifecycle, status.readiness)
  return { row, draft, readiness: status.readiness }
}

test("the four browsing groups partition all 16 existing Cloud stages exactly once", () => {
  const stages = Object.values(expected).flat()
  assert.equal(stages.length, 16)
  assert.equal(new Set(stages).size, 16)
  const rows: ListingRow[] = []
  const drafts: Record<string, WorkflowDraftView> = {}
  for (const group of WORKFLOW_STAGE_VIEWS) for (const stage of expected[group]) {
    const value = item(stage, stage)
    rows.push(value.row)
    drafts[stage] = value.draft
    assert.equal(workflowStageViewOf(value.row, drafts), group, stage)
  }
  const memberships = WORKFLOW_STAGE_VIEWS.flatMap((group) => workflowStageViewScope(rows, drafts, group, "all", new Set()).rows)
  assert.equal(new Set(memberships.map((row) => row.id)).size, rows.length)
  assert.equal(memberships.length, rows.length)
})

test("the current lifecycle wins over stale row badges; uncertainty never becomes a ready group", () => {
  const value = item("a", "ready_to_publish")
  const rejected = item("a", "publish_rejected")
  assert.equal(workflowStageViewOf(value.row, { a: rejected.draft }), "receipts")
  assert.equal(workflowStageViewOf({ ...value.row, publishUnconfirmed: true }, { a: value.draft }), "receipts")
  assert.equal(workflowStageViewOf(value.row, {}), "ready")
  assert.equal(workflowStageViewOf({ ...value.row, stage: undefined }, {}), "materials")
})

test("batch choices and eligible commands use only visible rows, including explicit empty scopes", () => {
  const ready = item("ready", "ready_to_publish"), hidden = item("hidden", "recognition_failed")
  const drafts = { ready: ready.draft, hidden: hidden.draft }
  const view = workflowStageViewScope([ready.row, hidden.row], drafts, "ready", "all", new Set(["hidden", "ready"]))
  assert.deepEqual(view.selectedIds, ["ready"])
  const scopes = workbenchScopes(view.rows, drafts, view.selectedRowIds, NO_PREPARATION_ACTIVITY, false, false)
  assert.deepEqual(scopes.picked.map((row) => row.id), ["ready"])
  assert.deepEqual(scopes.sendTargets.map((row) => row.id), ["ready"])
  assert.ok(batchSelectionScopes(view.rows, drafts).every((choice) => choice.rows.every((row) => row.id === "ready")))
  const empty = workflowStageViewScope([ready.row, hidden.row], drafts, "materials", "all", new Set(["hidden"]))
  assert.deepEqual(empty.rows, [])
  assert.deepEqual(empty.selectedIds, [])
  assert.deepEqual(workbenchScopes(empty.rows, drafts, empty.selectedRowIds, NO_PREPARATION_ACTIVITY, false, false).sendTargets, [])
})

test("reconciliation is an intersection inside receipts and never changes global stage totals", () => {
  const checking = item("checking", "outcome_unknown"), manual = item("manual", "outcome_unknown"), ready = item("ready", "ready_to_publish")
  manual.draft.lifecycle.importProbe = { phase: "needs_manual", passes: 3 }
  const rows = [checking.row, manual.row, ready.row], drafts = { checking: checking.draft, manual: manual.draft, ready: ready.draft }
  const view = workflowStageViewScope(rows, drafts, "receipts", "needs_manual", new Set(rows.map((row) => row.id)))
  assert.deepEqual(view.rows.map((row) => row.id), ["manual"])
  assert.deepEqual(view.selectedIds, ["manual"])
  assert.deepEqual(view.counts, { materials: 0, processing: 0, ready: 1, receipts: 2 })
  assert.deepEqual(workflowStageViewScope(rows, drafts, "ready", "checking", new Set()).rows, [])
})

test("real workbench event ingestion moves the view and ignores older projections without leaking hidden selection", () => {
  resetListingWorkbench()
  const before = item("a", "ready_to_publish", 1)
  patchListingWorkbench({ rows: [before.row], productDrafts: { a: before.draft }, selectedIds: ["a"] })
  const scope = listingWorkbenchScope()
  const accepted = item("a", "accepted", 3)
  try {
    receiveListingProducts([{ product: accepted.draft, readiness: accepted.readiness }], new Set(), scope)
    receiveListingProducts([{ product: before.draft, readiness: before.readiness }], new Set(), scope)
    const current = peekListingWorkbench()
    assert.equal(current.productDrafts.a!.lifecycle.view_revision, 3)
    const view = workflowStageViewScope(current.rows, current.productDrafts, "ready", "all", new Set(current.selectedIds))
    assert.deepEqual(view.rows, [])
    assert.deepEqual(view.selectedIds, [])
    assert.equal(view.counts.receipts, 1)
    const receipt = workflowStageViewScope(current.rows, current.productDrafts, "receipts", "all", new Set(current.selectedIds))
    assert.deepEqual(receipt.rows.map((row) => row.id), ["a"])
    assert.equal(receipt.rows[0]!.stage, "accepted")
  } finally { resetListingWorkbench() }
})

import assert from "node:assert/strict"
import test from "node:test"
import { product, SIGNED_IN } from "../cloud-fanout-tests/fixtures"
import type { ListingRow } from "../model/listing-row"
import { emptyListingWorkbench } from "../workbench/listing-workbench-store"
import { projectPublishResults, beforeDispatchFailure } from "./publish-queue-results"
import { publishPreflight, publishSkipMessage } from "./publish-policy"

const row: ListingRow = { id: "row", draftId: "row", imageName: "row.png", status: "ready",
  ai: "done", render: "done", upload: "done", log: "" }

test("a transport unknown restores no send permission even if a later row projection looks ready", () => {
  const before = { ...emptyListingWorkbench(), rows: [row], productDrafts: { row: product("row") }, productBases: { row: product("row") } }
  const projected = projectPublishResults(before, before, [{ row_id: "row", outcome: "unknown", blockers: [], noop_reason: "result_unconfirmed" }], new Map(), ["row"])
  const after = { ...before, ...projected }
  assert.equal(after.rows[0]!.publishUnconfirmed, true)
  assert.equal(publishPreflight(after, new Set(["row"]), SIGNED_IN).ok, false)
  after.productDrafts = before.productDrafts
  after.rows = after.rows.map((row) => ({ ...row, stage: "ready_to_publish" }))
  assert.equal(publishPreflight(after, new Set(["row"]), SIGNED_IN).ok, false, "missing Intent evidence cannot unlock uncertainty")
})

test("a newer accepted projection survives an older request refusal", () => {
  const before = { ...emptyListingWorkbench(), rows: [row], productDrafts: { row: product("row") }, productBases: { row: product("row") } }
  const accepted = { ...product("row"), lifecycle: { ...product("row").lifecycle, view_revision: 2, stage: "accepted" as const } }
  const current = { ...before, productBases: { row: accepted }, productDrafts: { row: accepted }, rows: [{ ...row, stage: "accepted" as const, log: "已受理" }] }
  const result = projectPublishResults(current, before, [{ row_id: "row", outcome: "blocked", blockers: [],
    error: { code: "cloud_offer_busy", message: "older refusal", remediation: null } }], new Map(), ["row"])
  assert.equal(result.rows![0]!.stage, "accepted")
  assert.equal(result.rows![0]!.log, "已受理")
})

test("pre-dispatch logs retain safe native group details and reject raw technical exceptions", () => {
  const message = "系统媒体组 100001 不能新增；请在方案默认值中删除后重新保存"
  assert.equal(beforeDispatchFailure({ code: "cloud_validation", message }), `发送未执行：${message}`)
  assert.doesNotMatch(beforeDispatchFailure(new Error("https://private.invalid/?token=secret")), /private|secret|token/)
  assert.match(beforeDispatchFailure(new Error("failed")), /方案或商品.*校验.*保存/)
  assert.doesNotMatch(publishSkipMessage("future-secret-code"), /future-secret-code|发送未执行（/)
  assert.match(publishSkipMessage("future-secret-code"), /接口合同.*核对原 Intent/)
})


test("a receipt without authoritative Intent acceptance cannot resolve an unknown outcome", () => {
  const before = { ...emptyListingWorkbench(), rows: [row], productDrafts: { row: product("row") }, productBases: { row: product("row") } }
  const projected = projectPublishResults(before, before, [{ row_id: "row", outcome: "unknown", blockers: [],
    submissionReceipt: { batch_id: "receipt", item_count: 1, http_status: 200 } }], new Map(), ["row"])
  assert.equal(projected.rows![0]!.publishUnconfirmed, true)
  assert.equal(projected.productDrafts!.row!.lifecycle.stage, "outcome_unknown")
  assert.equal(projected.productDrafts!.row!.lifecycle.submissionReceipt!.http_status, 200)
  assert.equal(publishPreflight({ ...before, ...projected }, new Set(["row"]), SIGNED_IN).ok, false)
})

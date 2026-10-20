import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowDraftView } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { unknownReleaseFactLine, unknownReleaseFacts } from "./unknown-release-facts"

const row = { id: "row", draftId: "row", imageName: "ART-9.png" } as ListingRow

function draft(partial: Partial<WorkflowDraftView>): WorkflowDraftView {
  return partial as WorkflowDraftView
}

test("incomplete evidence names the offer, the task and each missing item", () => {
  const [fact] = unknownReleaseFacts([row], {
    row: draft({
      draft: { values: {}, complex_values: [] },
      lifecycle: { taskId: "5666996254" } as WorkflowDraftView["lifecycle"],
      target_store_id: "",
    }),
  }, {}, false)
  assert.equal(fact?.offerId, "ART-9")
  assert.deepEqual(fact?.missing, ["intent", "store", "permission"])
  assert.equal(
    unknownReleaseFactLine(fact!),
    "货号「ART-9」，任务号 5666996254。缺少Intent、店铺、释放权限",
  )
})

test("complete evidence keeps the offer, store, intent and task, and lists nothing missing", () => {
  const [fact] = unknownReleaseFacts([row], {
    row: draft({
      draft: { values: { offer_id: { kind: "text", value: "ART-9" } }, complex_values: [] },
      lifecycle: { taskId: "99", run_id: "intent-9" } as WorkflowDraftView["lifecycle"],
      target_store_id: "store-1",
    }),
  }, { "store-1": { label: "主店" } }, true)
  assert.deepEqual(fact?.missing, [])
  assert.equal(fact?.storeLabel, "主店")
  assert.equal(
    unknownReleaseFactLine(fact!),
    "货号「ART-9」，任务号 99，店铺「主店」，Intent intent-9",
  )
  assert.doesNotMatch(unknownReleaseFactLine(fact!), /缺少/)
})

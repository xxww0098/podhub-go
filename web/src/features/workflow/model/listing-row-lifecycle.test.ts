import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import type { ListingRow } from "./listing-row"
import { projectListingRowLifecycle } from "./listing-row-lifecycle"

const evidence = { traceId: "kept" } as unknown as NonNullable<ListingRow["publishRequestEvidence"]>
const row = {
  id: "row",
  draftId: "draft",
  imageName: "image",
  status: "pending",
  ai: "idle",
  render: "idle",
  upload: "idle",
  log: "",
  publishUnconfirmed: true,
  publishRequestEvidence: evidence,
} satisfies ListingRow

function stage(stage: WorkflowProductLifecycle["stage"]): WorkflowProductLifecycle {
  return { stage } as WorkflowProductLifecycle
}

test("a refresh keeps the local fence while the server stage is still unknown", () => {
  const next = projectListingRowLifecycle(row, stage("outcome_unknown"))
  assert.equal(next.publishUnconfirmed, true)
  assert.equal(next.publishRequestEvidence, row.publishRequestEvidence)
})

test("an accepted or ready server stage clears the local fence", () => {
  for (const name of ["accepted", "ready_to_publish"] as const) {
    const next = projectListingRowLifecycle(row, stage(name))
    assert.equal(next.publishUnconfirmed, false, name)
    assert.equal(next.publishRequestEvidence, undefined)
  }
})

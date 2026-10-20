import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowProductLifecycle } from "@/bindings/commands"
import { NO_PREPARATION_ACTIVITY } from "./prepare/preparation-tracks"
import { brandRepairEligible, clearBrandSearchTags } from "./brand-repair"
import type { ListingRow } from "./model/listing-row"

const row = (status: ListingRow["status"] = "failed"): ListingRow => ({
  id: "row-1", draftId: "row-1", imageName: "one.png", status,
  ai: "done", render: "done", upload: "done", log: "",
})

const lifecycle = (stage: WorkflowProductLifecycle["stage"]): WorkflowProductLifecycle => ({
  revision: 4, view_revision: 4, stage, ai: "ready", media: "ready",
  image_total: 1, image_completed: 1, fields: "valid", images: [],
  failure_log: [], ai_candidates: [], product_videos: [], last_error_code: "BR_hashtag_brand",
})

const CONFLICT = { blockers: ["publish_conflict"] }
const REJECTED = { blockers: ["publish_rejected"] }

test("brand repair admits a conflict blocker but not a plain rejection", () => {
  assert.equal(brandRepairEligible(row(), lifecycle("publish_rejected"), REJECTED, NO_PREPARATION_ACTIVITY), false)
})

test("brand repair is limited to a ready media/AI row with the exact conflict", () => {
  assert.equal(brandRepairEligible(row(), lifecycle("publish_rejected"), CONFLICT, NO_PREPARATION_ACTIVITY), true)
  assert.equal(brandRepairEligible(row(), { ...lifecycle("publish_rejected"), last_error_code: "SPU_ALREADY_EXISTS_IN_ANOTHER_ACCOUNT" }, CONFLICT, NO_PREPARATION_ACTIVITY), false)
  assert.equal(brandRepairEligible(row(), { ...lifecycle("publish_rejected"), media: "failed" }, CONFLICT, NO_PREPARATION_ACTIVITY), false)
})

test("brand repair never admits a queued or actively prepared row", () => {
  assert.equal(brandRepairEligible(row("running"), lifecycle("publish_rejected"), CONFLICT, NO_PREPARATION_ACTIVITY), false)
  for (const stage of ["queued", "submitting", "outcome_unknown", "accepted"] as const) {
    assert.equal(brandRepairEligible(row(), lifecycle(stage), CONFLICT, NO_PREPARATION_ACTIVITY), false, stage)
  }
  assert.equal(brandRepairEligible(row(), lifecycle("publish_rejected"), CONFLICT, { ...NO_PREPARATION_ACTIVITY, ai: new Set(["row-1"]) }), false)
})


test("brand repair uses native draft edit, Manual provenance and revalidation without clearing media or AI", async () => {
  const { wasmCore, golden, goldenSchema } = await import("./submit/send-test-support")
  const core = await wasmCore()
  const schema = { ...goldenSchema, fields: [...goldenSchema.fields, {
    ...goldenSchema.fields.find((field) => field.key === "name")!,
    key: "native_search_tags", attribute_id: "23171", complex_id: null, required: false,
  }] }
  const handle = core.loadSchema({ snapshot: schema })
  const row = structuredClone(golden.row)
  row.draft.values.native_search_tags = { kind: "text", value: "brand" }
  try {
    const result = await clearBrandSearchTags(core, handle, schema, { row, card: golden.card, nowMs: 10 })
    assert.equal(result.row.draft.values.native_search_tags, undefined)
    assert.ok(result.row.handEditedKeys.includes("native_search_tags"))
    assert.match(JSON.stringify(result.row.fieldOrigins), /manual/i)
    assert.deepEqual(result.row.media, row.media)
    assert.deepEqual(result.row.ai, row.ai)
    assert.equal(row.draft.values.native_search_tags.value, "brand", "input stays immutable")
    assert.equal(result.fact, "Passed")
  } finally { core.dropSchema(handle) }
})

test("brand repair with no unique schema address calls neither native edit nor revalidation", async () => {
  const { golden, goldenSchema } = await import("./submit/send-test-support")
  let calls = 0
  const fail = () => { calls += 1; throw new Error("must not execute") }
  await assert.rejects(clearBrandSearchTags({ editRow: fail, revalidate: fail }, 1, goldenSchema,
    { row: golden.row, nowMs: 10 }), /没有唯一搜索标签地址/)
  assert.equal(calls, 0)
})

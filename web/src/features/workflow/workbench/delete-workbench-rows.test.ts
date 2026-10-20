import { route } from "@/api/routes"
import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowDraftView } from "@/bindings/commands"
import { listingRow, listingProjection } from "../../../../tests/listing-row-fixture"
import { removeWorkbenchRows } from "./delete-workbench-rows"
import { editListingProduct, patchListingWorkbench, peekListingWorkbench, receiveListingProducts, resetListingWorkbench } from "./listing-workbench-store"
import { projectListingRowLifecycle } from "../model/listing-row-lifecycle"
import { rowStatusView } from "../model/row-state"

function seed(ids: string[]) {
  const products = ids.map((id, index): WorkflowDraftView => ({
    draft_id: id, kind: "instance", display_name: id,
    schema: { description_category_id: 1, type_id: 1, fields: [], complex_groups: [] },
    draft: { values: {}, complex_values: [] }, validation_state: "draft", issues: [],
    ai_prompt_id: "", ai_prompt: "", ai_prompt_file_name: "", psd_template_asset_id: "", psd_template_file_name: "",
    target_store_id: "store", ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] },
    lifecycle: { ...rowStatusView(listingRow({ id, projection: listingProjection() })).lifecycle, queue_position: index },
    updated_at_ms: 1,
  }))
  patchListingWorkbench({
    productDrafts: Object.fromEntries(products.map((product) => [product.draft_id, product])),
    rows: products.map((product) => projectListingRowLifecycle({ id: product.draft_id, draftId: product.draft_id,
      imageName: `${product.draft_id}.png`, status: "ready", ai: "done", render: "done", upload: "done", log: "" }, product.lifecycle, listingProjection().readiness)),
    selectedIds: ids,
  })
  return products
}

test("rows disappear before save/delete waits, streamed updates stay hidden, failure restores edits", async () => {
  resetListingWorkbench()
  const products = seed(["deleted", "failed", "sibling"])
  const edited = { ...products[1]!, draft: { ...products[1]!.draft, values: { name: { kind: "text" as const, value: "unsaved input" } } } }
  editListingProduct("failed", edited)
  let release!: () => void
  const saving = new Promise<void>((resolve) => { release = resolve })
  const original = globalThis.fetch
  const requests: string[] = []
  const forgotten: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === "GET") {
      assert.equal(peekListingWorkbench().rows.find((row) => row.id === "failed")?.readiness, undefined, "old ready verdict is cleared before refreshing")
      return Response.json({ data: listingRow({ id: "failed", view_revision: 3, projection: listingProjection({ stage: "rendering", readiness: {
        ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [],
      } }) }) })
    }
    assert.equal(init?.method, "DELETE")
    requests.push(url)
    return url.endsWith("/failed")
      ? Response.json({ code: "FORBIDDEN", message: "permission changed" }, { status: 403 })
      : Response.json({ data: { id: "deleted", deletedRows: 1 } })
  }
  try {
    const deleting = removeWorkbenchRows(["deleted", "failed"], {
      flushRowsFor: async () => { await saving; return false },
      forgetRows: (ids) => forgotten.push(...ids),
    })
    assert.deepEqual(peekListingWorkbench().rows.map((row) => row.id), ["sibling"])
    assert.equal(requests.length, 0, "UI removal precedes even the autosave round trip")
    const streamed = { ...products[1]!, lifecycle: { ...products[1]!.lifecycle, stage: "rendering" as const, view_revision: 2 } }
    receiveListingProducts([{ product: streamed, readiness: { ...listingProjection().readiness, ready_to_publish: false } }], new Set(), peekListingWorkbench().scope)
    patchListingWorkbench({ rows: [...peekListingWorkbench().rows, { id: "failed", draftId: "failed", imageName: "failed.png", status: "ready", ai: "done", render: "done", upload: "done", log: "late callback" }] })
    assert.deepEqual(peekListingWorkbench().rows.map((row) => row.id), ["sibling"], "SSE and action callbacks cannot resurrect a pending delete")
    patchListingWorkbench({ selectedIds: ["sibling"] })
    release()
    await deleting
    const current = peekListingWorkbench()
    assert.deepEqual(current.rows.map((row) => row.id), ["failed", "sibling"])
    assert.match(current.rows[0]!.log, /删除失败/)
    assert.deepEqual(current.productDrafts.failed!.draft.values.name, { kind: "text", value: "unsaved input" })
    assert.equal(current.productBases.failed!.lifecycle.view_revision, 3)
    assert.equal(current.rows[0]!.readiness?.ready_to_publish, false)
    assert.deepEqual(new Set(current.selectedIds), new Set(["failed", "sibling"]))
    assert.deepEqual(forgotten, ["deleted"])
    assert.equal(current.pendingRemovalIds.size, 0)
    assert.equal(current.removedProducts.has("deleted"), true)
  } finally {
    release()
    globalThis.fetch = original
    patchListingWorkbench({ pendingRemovalIds: new Set() })
    resetListingWorkbench()
  }
})

for (const reopen of [false, true]) for (const failed of [false, true]) test(`deletion settles after leaving the table (reopen=${reopen}, failed=${failed})`, async () => {
  resetListingWorkbench()
  const products = seed(["old"])
  let release!: () => void
  const saving = new Promise<void>((resolve) => { release = resolve })
  const original = globalThis.fetch
  let deleted = false
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), route("listingRowsById", { id: "old" }))
    if (init?.method === "GET") return Response.json({ data: listingRow({ id: "old" }) })
    deleted = true
    return failed ? Response.json({ code: "FORBIDDEN", message: "permission changed" }, { status: 403 })
      : Response.json({ data: { id: "old", deletedRows: 1 } })
  }
  try {
    const deleting = removeWorkbenchRows(["old"], {
      flushRowsFor: async () => { await saving; return true }, forgetRows: () => {},
    })
    resetListingWorkbench()
    if (reopen) receiveListingProducts([{ product: products[0]!, readiness: listingProjection().readiness }], new Set(), peekListingWorkbench().scope)
    else seed(["new-card-row"])
    assert.equal(peekListingWorkbench().rows.some((row) => row.id === "old"), false)
    release()
    await deleting
    assert.equal(deleted, true)
    assert.deepEqual(peekListingWorkbench().rows.map((row) => row.id), reopen ? failed ? ["old"] : [] : ["new-card-row"])
    assert.equal(peekListingWorkbench().pendingRemovalIds.size, 0)
  } finally {
    release()
    globalThis.fetch = original
    patchListingWorkbench({ pendingRemovalIds: new Set() })
    resetListingWorkbench()
  }
})

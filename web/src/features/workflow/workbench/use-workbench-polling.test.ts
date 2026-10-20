import { route } from "@/api/routes"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowDraftView, WorkflowQueueState } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import type { ListingRow } from "../model/listing-row"
import { editListingProduct, patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "./listing-workbench-store"
import { rowStatusView } from "../model/row-state"
import { pollWorkbench, workbenchNeedsPolling } from "./use-workbench-polling"

const cloudRow: ListingRowView = {
  id: "row-1", card_id: "card-1", store_id: "store-1", revision: 2, view_revision: 2, projection: listingProjection({ stage: "accepted" }),
  content_state: "ready", media_state: "ready", validation_state: "passed", submission_state: "accepted",
  draft: { values: { name: { kind: "text", value: "Cloud name" } }, complex_values: [] },
  validation_issues: [], media: { images: [], videos: [] }, ai: { candidates: [] },
  source: { sha256: "sha", fileName: "source.png" }, payload: {}, updated_at_ms: 2,
  build: { state: "stale", sources: [] },
}

function seed() {
  resetListingWorkbench()
  const lifecycle = { ...rowStatusView(cloudRow).lifecycle, stage: "rendering" as const, revision: 1, view_revision: 1 }
  const product: WorkflowDraftView = {
    draft_id: cloudRow.id, parent_card_id: cloudRow.card_id, kind: "instance", display_name: "",
    schema: { description_category_id: 1, type_id: 1, fields: [], complex_groups: [] },
    draft: { values: { name: { kind: "text", value: "Before" } }, complex_values: [] },
    validation_state: "valid", issues: [], ai_prompt_id: "", ai_prompt: "", ai_prompt_file_name: "",
    psd_template_asset_id: "", psd_template_file_name: "", target_store_id: "store-1",
    ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] }, lifecycle, updated_at_ms: 1,
  }
  const row: ListingRow = {
    id: "local-row", draftId: product.draft_id, imageName: "source.png",
    status: "running", ai: "done", render: "done", upload: "done", log: "Keep the local log",
  }
  patchListingWorkbench({ rows: [row], productDrafts: { [product.draft_id]: product }, selectedIds: [row.id], activeProductId: row.id, queueRunning: true, queueFrozenIds: [product.draft_id] })
  return {
    active: true, cardId: "card-1", generation: 1, busy: false, pendingCardChanges: false, queueStopRequested: false,
    projectQueueState(queue: WorkflowQueueState) {
      patchListingWorkbench({ queueRunning: queue.running, queuePaused: queue.paused, queueFrozenIds: queue.frozen_row_ids, queueHaltReason: queue.halt_reason ?? null })
    },
  }
}

function server(
  barrier: Promise<void> = Promise.resolve(),
  projection = listingProjection({ stage: "accepted", sku: 123 }),
  paginated = false,
  row: Partial<ListingRowView> = {},
) {
  const previous = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    let data: unknown
    if (url === route("listingCardsById", { id: "card-1" })) {
      data = { id: "card-1", title: "Card", revision: 1, payload: { queue: { frozenRowIds: [cloudRow.id] } }, updatedAtMs: 2 }
    } else if (url.startsWith(`${route("listingRows")}?`)) {
      data = { items: [{ ...cloudRow, projection, ...row }], nextCursor: paginated && !url.includes("cursor=") ? "next-rows" : undefined }
    } else throw new Error(`unexpected HTTP request ${url}`)
    await barrier
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
  }
  return { calls, restore: () => { globalThis.fetch = previous; resetListingWorkbench() } }
}

test("a preparing card refreshes its saved projection, preserves UI identity, and stops", async () => {
  const context = seed()
  const initial = peekListingWorkbench()
  const stub = server()
  try {
    const flight = { inFlight: false }
    await pollWorkbench(flight, () => context)
    const current = peekListingWorkbench()
    assert.equal(current.productDrafts[cloudRow.id]!.lifecycle.ozon_sku, 123)
    assert.deepEqual(current.productDrafts[cloudRow.id]!.draft.values.name, { kind: "text", value: "Cloud name" })
    assert.equal(current.rows[0]!.status, "sent")
    assert.equal(current.rows[0]!.log, initial.rows[0]!.log)
    assert.equal(current.rows[0]!.id, initial.rows[0]!.id)
    assert.equal(current.selectedIds, initial.selectedIds)
    assert.equal(current.activeProductId, initial.activeProductId)
    assert.equal(current.queueRunning, false)
    assert.equal(workbenchNeedsPolling(current), false)
    await pollWorkbench(flight, () => context)
    assert.equal(stub.calls.length, 2)
  } finally { stub.restore() }
})

test("hidden work spends no reads; a resume coalesces overlapping triggers and fences card switches", async () => {
  const context = seed()
  context.active = false
  let release!: () => void
  const stub = server(new Promise<void>((resolve) => { release = resolve }))
  try {
    const flight = { inFlight: false }
    await pollWorkbench(flight, () => context)
    assert.deepEqual(stub.calls, [])
    context.active = true
    const pending = pollWorkbench(flight, () => context)
    await pollWorkbench(flight, () => context)
    assert.equal(stub.calls.length, 2)
    context.generation += 1
    const switched = peekListingWorkbench()
    release()
    await pending
    assert.equal(peekListingWorkbench(), switched, "the previous runner generation cannot paint")
    await pollWorkbench(flight, () => context)
    assert.equal(peekListingWorkbench().rows[0]!.status, "sent", "the current generation can refresh")
    assert.equal(stub.calls.length, 4)
  } finally { release(); stub.restore() }
})

test("edits and active preparation survive an older response, then settle on the next writable beat", async () => {
  for (const kind of ["edit", "saved_edit", "prepare"] as const) {
    const context = seed()
    let release!: () => void
    const stub = server(new Promise<void>((resolve) => { release = resolve }))
    try {
      const flight = { inFlight: false }
      if (kind === "prepare") {
        patchListingWorkbench((state) => ({
          activity: { ...state.activity, ai: new Set([state.rows[0]!.id]) },
          productDrafts: { ...state.productDrafts, [cloudRow.id]: { ...state.productDrafts[cloudRow.id]!, lifecycle: { ...state.productDrafts[cloudRow.id]!.lifecycle, stage: "rendering" } } },
        }))
      }
      const pending = pollWorkbench(flight, () => context)
      if (kind === "edit" || kind === "saved_edit") {
        patchListingWorkbench((state) => ({
          productDrafts: { ...state.productDrafts, [cloudRow.id]: { ...state.productDrafts[cloudRow.id]!, draft: { values: { name: { kind: "text", value: "Local edit" } }, complex_values: [] } } },
          rowSaveStates: { [cloudRow.id]: kind === "edit" ? "dirty" : "saved" },
        }))
      } else {
        patchListingWorkbench((state) => ({ activity: { ...state.activity, ai: new Set() } }))
      }
      const local = peekListingWorkbench().productDrafts[cloudRow.id]
      release()
      await pending
      assert.equal(peekListingWorkbench().productDrafts[cloudRow.id], local, kind)
      if (kind === "edit") {
        await pollWorkbench(flight, () => context)
        assert.equal(peekListingWorkbench().productDrafts[cloudRow.id], local, "pending edits survive future beats too")
      }
      patchListingWorkbench({ rowSaveStates: { [cloudRow.id]: "saved" } })
      await pollWorkbench(flight, () => context)
      assert.equal(peekListingWorkbench().productDrafts[cloudRow.id]!.lifecycle.ozon_sku, 123, "released rows eventually converge")
    } finally { release(); stub.restore() }
  }
})

test("unchanged live responses keep row, product and workbench references stable", async () => {
  const context = seed()
  const stub = server(Promise.resolve(), listingProjection({ stage: "rendering" }))
  try {
    const flight = { inFlight: false }
    await pollWorkbench(flight, () => context)
    const observed = peekListingWorkbench()
    assert.equal(workbenchNeedsPolling(observed), true)
    await pollWorkbench(flight, () => context)
    assert.equal(peekListingWorkbench(), observed)
    assert.equal(stub.calls.length, 4)
    patchListingWorkbench((state) => ({ rows: state.rows.map((row) => ({ ...row, ai: "running" })) }))
    await pollWorkbench(flight, () => context)
    assert.equal(peekListingWorkbench().rows[0]!.ai, "done", "a released lane still converges when its product snapshot is unchanged")
  } finally { stub.restore() }
})

test("polling a completed row keeps another row's unsaved input out of its server baseline", async () => {
  const context = seed()
  const original = peekListingWorkbench().productDrafts[cloudRow.id]!
  const editing = { ...original, draft_id: "editing-row" }
  patchListingWorkbench((state) => ({
    productDrafts: { ...state.productBases, [editing.draft_id]: editing },
    rows: [...state.rows, { ...state.rows[0]!, id: "local-editing", draftId: editing.draft_id }],
    rowSaveStates: { [editing.draft_id]: "dirty" },
  }))
  const input = { ...editing, draft: { ...editing.draft, values: { name: { kind: "text" as const, value: "Unsaved input" } } } }
  editListingProduct(editing.draft_id, input)
  const stub = server()
  try {
    await pollWorkbench({ inFlight: false }, () => context)
    const current = peekListingWorkbench()
    assert.equal(current.rows[0]!.status, "sent")
    assert.deepEqual(current.productBases[editing.draft_id]!.draft, editing.draft)
    assert.deepEqual(current.productDrafts[editing.draft_id]!.draft, input.draft)
    assert.equal(current.rowSaveStates[editing.draft_id], "dirty")
  } finally { stub.restore() }
})

test("a hidden or failed in-flight read preserves the last projection and the next visible read recovers", async () => {
  const context = seed()
  let release!: () => void
  const stub = server(new Promise<void>((resolve) => { release = resolve }), undefined, true)
  try {
    const flight = { inFlight: false }
    const original = peekListingWorkbench()
    const pending = pollWorkbench(flight, () => context)
    context.active = false
    release()
    await pending
    assert.equal(peekListingWorkbench(), original)
    assert.equal(stub.calls.length, 2, "hiding stops row pagination before the next page")
    context.active = true
    const healthyFetch = globalThis.fetch
    globalThis.fetch = async () => { throw new Error("offline") }
    await pollWorkbench(flight, () => context)
    assert.equal(peekListingWorkbench(), original)
    globalThis.fetch = healthyFetch
    await pollWorkbench(flight, () => context)
    assert.equal(peekListingWorkbench().rows[0]!.status, "sent")
  } finally { release(); stub.restore() }
})

test("HTTP merge applies a newer view_revision even when updatedAtMs is older", async () => {
  const context = seed()
  const local = peekListingWorkbench().productDrafts[cloudRow.id]!
  patchListingWorkbench({
    productDrafts: { [cloudRow.id]: { ...local, updated_at_ms: 100 } },
  })
  assert.equal(peekListingWorkbench().productDrafts[cloudRow.id]!.lifecycle.view_revision, 1)
  assert.equal(peekListingWorkbench().productDrafts[cloudRow.id]!.updated_at_ms, 100)
  const stub = server(Promise.resolve(), listingProjection({ stage: "accepted", sku: 123 }), false, {
    view_revision: 2,
    updated_at_ms: 1,
  })
  try {
    await pollWorkbench({ inFlight: false }, () => context)
    const current = peekListingWorkbench().productDrafts[cloudRow.id]!
    assert.equal(current.lifecycle.view_revision, 2)
    assert.equal(current.lifecycle.ozon_sku, 123)
    assert.equal(current.updated_at_ms, 1)
    assert.equal(peekListingWorkbench().rows[0]!.status, "sent")
  } finally { stub.restore() }
})


test("sending and received or missing receipts never start status polling", async () => {
  for (const stage of ["queued", "submitting", "accepted", "outcome_unknown", "publish_rejected", "operator_attested"] as const) {
    const context = seed()
    patchListingWorkbench((state) => ({
      queueRunning: true,
      productDrafts: { [cloudRow.id]: { ...state.productDrafts[cloudRow.id]!, lifecycle: { ...state.productDrafts[cloudRow.id]!.lifecycle, stage } } },
    }))
    const stub = server()
    try {
      assert.equal(workbenchNeedsPolling(peekListingWorkbench()), false, stage)
      await pollWorkbench({ inFlight: false }, () => context)
      assert.deepEqual(stub.calls, [], stage)
    } finally { stub.restore() }
  }
})

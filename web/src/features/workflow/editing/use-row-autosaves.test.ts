import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { WorkflowDraftView } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { prepareRowSaveRetry, useRowAutosaves } from "./use-row-autosaves"
import { instance, row, schema, slice } from "../workbench/workbench-test-fixtures"
import { cloudRow } from "../workbench/workbench-test-harness"
import { workflowActions } from "../workflow-actions"

const DRAFT = "draft-A"
const ROW: ListingRow = {
  id: "A", draftId: DRAFT, imageName: "A.png", status: "pending",
  ai: "idle", render: "idle", upload: "idle", log: "",
}
const VIEW = {
  draft_id: DRAFT,
  lifecycle: { view_revision: 1 },
  draft: { values: {}, complex_values: [] },
} as unknown as WorkflowDraftView

/** One retry with every Cloud request and conflict prompt counted. */
async function retry() {
  const requests: string[] = []
  let prompts = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    throw new Error("a retry with nothing to save never reaches Cloud")
  }) as typeof fetch
  try {
    const edit = await prepareRowSaveRetry(DRAFT, () => {
      prompts += 1
      return true
    })
    return { edit, requests, prompts }
  } finally {
    globalThis.fetch = previousFetch
    resetListingWorkbench()
  }
}

test("a retry on a row without a local edit makes no request", async () => {
  resetListingWorkbench()
  patchListingWorkbench({ rows: [ROW], productDrafts: { [DRAFT]: VIEW } })
  assert.deepEqual(await retry(), { edit: undefined, requests: [], prompts: 0 })
})

test("a retry on an edit whose Product Instance is gone makes no request", async () => {
  resetListingWorkbench()
  patchListingWorkbench({
    rows: [ROW],
    dirtyProducts: { [DRAFT]: { id: 1, base: VIEW, view: VIEW, fields: new Set<`values.${string}`>(["values.name"]) } },
  })
  assert.deepEqual(await retry(), { edit: undefined, requests: [], prompts: 0 })
})

test("a retry on an unknown draft makes no request", async () => {
  resetListingWorkbench()
  patchListingWorkbench({ rows: [{ ...ROW, id: "B", draftId: "draft-B" }] })
  assert.deepEqual(await retry(), { edit: undefined, requests: [], prompts: 0 })
})

test("a picker captured before an unknown or queued projection cannot queue a late media edit", () => {
  const target = row(1)
  const product = instance(target)
  product.lifecycle = { ...product.lifecycle, stage: "ready_to_publish", ai: "ready", media: "ready", images: [
    slice(0, { phase: "public_ready", public_url: "https://media.example.invalid/one.jpg" }),
  ] }
  let captured!: ReturnType<typeof useRowAutosaves>
  function Capture() { captured = useRowAutosaves({ schema }); return null }
  resetListingWorkbench()
  patchListingWorkbench({ rows: [target], productDrafts: { [target.draftId]: product } })
  renderToStaticMarkup(createElement(Capture))
  try {
    for (const changed of [{ ...target, publishUnconfirmed: true }, { ...target, stage: "queued" as const }]) {
      patchListingWorkbench({ rows: [changed] })
      captured.editRowField(target.draftId, "primary_image", { kind: "text", value: "https://media.example.invalid/one.jpg" }, {})
      assert.equal(peekListingWorkbench().dirtyProducts[target.draftId], undefined)
      assert.equal(peekListingWorkbench().rowSaveStates[target.draftId], undefined)
      assert.equal(peekListingWorkbench().productDrafts[target.draftId]?.draft.values.primary_image, undefined)
    }
  } finally { resetListingWorkbench() }
})

test("a failed media autosave retains the choice and an explicit retry persists it once", async () => {
  const target = row(1)
  const product = instance(target)
  const url = "https://media.example.invalid/one.jpg"
  product.lifecycle = { ...product.lifecycle, revision: 1, view_revision: 1, stage: "ready_to_publish", ai: "ready", media: "ready", images: [slice(0, { phase: "public_ready", public_url: url })] }
  let saved = cloudRow(target.draftId, { revision: 1, draft: product.draft, media: { images: product.lifecycle.images } })
  let fail = true, writes = 0
  const previousFetch = globalThis.fetch
  const previousWindow = globalThis.window
  globalThis.window = { setTimeout, clearTimeout, confirm: () => true } as unknown as Window & typeof globalThis
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), route("listingRowsById", { id: target.draftId }))
    if (init?.method === "PATCH") {
      writes += 1
      if (fail) return Response.json({ error: "fixture save failed", code: "fixture_save_failed" }, { status: 503 })
      const body = JSON.parse(String(init.body))
      assert.equal(body.baseRevision, saved.revision)
      saved = { ...saved, revision: saved.revision + 1, view_revision: saved.view_revision + 1, draft: body.draft }
    }
    return Response.json({ data: saved })
  }
  let captured!: ReturnType<typeof useRowAutosaves>
  function Capture() { captured = useRowAutosaves({ schema }); return null }
  resetListingWorkbench()
  patchListingWorkbench({ rows: [target], productDrafts: { [target.draftId]: product } })
  renderToStaticMarkup(createElement(Capture))
  try {
    captured.editRowField(target.draftId, "primary_image", { kind: "text", value: url }, {})
    assert.equal(await captured.flushRowsFor([target.draftId]), false)
    assert.equal(writes, 1)
    assert.deepEqual(peekListingWorkbench().productDrafts[target.draftId]?.draft.values.primary_image, { kind: "text", value: url })
    assert.equal(peekListingWorkbench().rowSaveStates[target.draftId], "error")
    fail = false
    await captured.retryRowSave(target.draftId)
    assert.equal(await captured.flushRowsFor([target.draftId]), true)
    assert.equal(writes, 2)
    assert.deepEqual(saved.draft.values.primary_image, { kind: "text", value: url })
    assert.equal(peekListingWorkbench().rowSaveStates[target.draftId], "saved")
    assert.equal(peekListingWorkbench().dirtyProducts[target.draftId], undefined)
  } finally {
    captured.resetRowAutosaves()
    resetListingWorkbench()
    globalThis.fetch = previousFetch
    globalThis.window = previousWindow
  }
})

test("a card invalidation during save keeps the drain waiting for a fresh receipt", async () => {
  const target = row(1)
  const product = instance(target)
  const previousSave = workflowActions.listingRowSaveDraft
  const previousWindow = globalThis.window
  globalThis.window = { setTimeout, clearTimeout } as unknown as Window & typeof globalThis
  let releaseFirst!: () => void
  let firstStarted!: () => void
  const held = new Promise<void>((resolve) => { releaseFirst = resolve })
  const started = new Promise<void>((resolve) => { firstStarted = resolve })
  const writes: string[] = []
  workflowActions.listingRowSaveDraft = async (view) => {
    writes.push(String(view.draft.values.name?.value))
    if (writes.length === 1) { firstStarted(); await held }
    const saved = { ...view, lifecycle: { ...view.lifecycle, revision: writes.length + 1, view_revision: writes.length + 1 } }
    return { saved, status: { lifecycle: saved.lifecycle } } as Awaited<ReturnType<typeof previousSave>>
  }
  let captured!: ReturnType<typeof useRowAutosaves>
  function Capture() { captured = useRowAutosaves({ schema }); return null }
  resetListingWorkbench()
  patchListingWorkbench({ rows: [target], productDrafts: { [target.draftId]: product } })
  renderToStaticMarkup(createElement(Capture))
  try {
    captured.editRowCell(target.draftId, "name", "typed")
    const flushing = captured.flushRowsFor([target.draftId])
    await started
    patchListingWorkbench((current) => ({ mediaEpoch: current.mediaEpoch + 1 }))
    releaseFirst()
    assert.equal(await flushing, true)
    assert.deepEqual(writes, ["typed", "typed"])
    assert.equal(peekListingWorkbench().dirtyProducts[target.draftId], undefined)
    assert.equal(peekListingWorkbench().rowSaveStates[target.draftId], "saved")
    assert.equal(captured.pendingRowEdits(), false)
  } finally {
    releaseFirst()
    captured.resetRowAutosaves()
    resetListingWorkbench()
    workflowActions.listingRowSaveDraft = previousSave
    globalThis.window = previousWindow
  }
})

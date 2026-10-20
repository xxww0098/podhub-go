import { listingRow } from "../../../tests/listing-row-fixture"
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowDraftView } from "@/bindings/commands"
import { useStoreQuotas } from "./use-store-quotas"
import { refreshProductStatus } from "./workbench/product-status"
import { createPreparationTracks } from "./prepare/preparation-tracks"
import { peekListingWorkbench, projectListingProducts, projectListingRows, resetListingWorkbench } from "./workbench/listing-workbench-store"

test("a quota conflict displays the actual assignment and a fresh operator choice can succeed", async () => {
  const product = {
    draft_id: "a", target_store_id: "store-0",
    draft: { values: {}, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [] },
  } as unknown as WorkflowDraftView
  resetListingWorkbench()
  projectListingProducts(() => ({ a: product }))
  projectListingRows(() => [{ id: "a", draftId: "a", imageName: "a.png", status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" }])
  let quota!: ReturnType<typeof useStoreQuotas>
  function Harness() {
    quota = useStoreQuotas({
      targetStoreId: "store-1,store-2",
      preparationTracks: { current: createPreparationTracks() },
      guidedPreparationLock: { current: false },
    })
    return null
  }
  renderToStaticMarkup(<Harness />)
  let current = listingRow({ id: "a", store_id: "store-2", revision: 13, view_revision: 13, content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none", draft: product.draft })
  let writes = 0
  const previous = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "PATCH") {
      writes += 1
      const body = JSON.parse(String(init.body))
      assert.equal(body.baseRevision, current.revision)
      current = { ...current, revision: current.revision + 1, view_revision: current.view_revision + 1, store_id: body.storeId, draft: body.draft }
    }
    return new Response(JSON.stringify({ data: current }), { status: 200 })
  }) as typeof fetch
  try {
    await quota.handleEvenSplitQuotas()
    assert.equal(writes, 0)
    assert.equal(peekListingWorkbench().productBases.a?.target_store_id, "store-2")
    await quota.handleEvenSplitQuotas()
    assert.equal(writes, 1)
    assert.equal(current.store_id, "store-1")
    assert.equal(peekListingWorkbench().productBases.a?.target_store_id, "store-1")
  } finally {
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})

test("a newer status refresh retains the committed Store while its quota save response is pending", async () => {
  const product = {
    draft_id: "a", target_store_id: "store-0",
    draft: { values: {}, complex_values: [] },
    lifecycle: { revision: 1, view_revision: 1, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [] },
  } as unknown as WorkflowDraftView
  resetListingWorkbench()
  projectListingProducts(() => ({ a: product }))
  projectListingRows(() => [{ id: "a", draftId: "a", imageName: "a.png", status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" }])
  let quota!: ReturnType<typeof useStoreQuotas>
  function Harness() {
    quota = useStoreQuotas({ targetStoreId: "store-1", preparationTracks: { current: createPreparationTracks() }, guidedPreparationLock: { current: false } })
    return null
  }
  renderToStaticMarkup(<Harness />)
  let current = listingRow({ id: "a", store_id: "store-0", revision: 1, view_revision: 1, content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none", draft: product.draft })
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let didWrite!: () => void
  const written = new Promise<void>((resolve) => { didWrite = resolve })
  const previous = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body))
      current = { ...current, revision: 2, view_revision: 2, store_id: body.storeId, draft: body.draft }
      const saved = { ...current }
      didWrite()
      await held
      return new Response(JSON.stringify({ data: saved }))
    }
    return new Response(JSON.stringify({ data: String(input).includes("/intents") ? { items: [] } : current }))
  }
  let saving: Promise<void> | undefined
  try {
    saving = quota.handleEvenSplitQuotas()
    await written
    current = { ...current, revision: 3, view_revision: 3 }
    await refreshProductStatus(peekListingWorkbench().rows[0]!)
    release()
    await saving
    assert.equal(peekListingWorkbench().productBases.a!.lifecycle.revision, 3)
    assert.equal(peekListingWorkbench().productBases.a!.target_store_id, "store-1")
    assert.equal(peekListingWorkbench().productDrafts.a!.target_store_id, "store-1")
  } finally {
    release()
    await saving
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})

test("quota persistence bounds row writes and keeps partial failures observable", async () => {
  resetListingWorkbench()
  const products = Object.fromEntries(Array.from({ length: 100 }, (_, index) => {
    const id = `row-${index}`
    return [id, {
      draft_id: id,
      target_store_id: "store-2",
      draft: { values: {}, complex_values: [] },
      lifecycle: { revision: 1, view_revision: 1, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [] },
    } as unknown as WorkflowDraftView]
  }))
  projectListingProducts(() => products)
  projectListingRows(() => Object.keys(products).map((id) => ({ id, draftId: id, imageName: `${id}.png`, status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" })))
  let quota!: ReturnType<typeof useStoreQuotas>
  function Harness() {
    quota = useStoreQuotas({ targetStoreId: "store-1,store-2", preparationTracks: { current: createPreparationTracks() }, guidedPreparationLock: { current: false } })
    return null
  }
  renderToStaticMarkup(<Harness />)
  const previous = globalThis.fetch
  let active = 0
  let peak = 0
  let failed = 0
  globalThis.fetch = (async (input, init) => {
    const url = String(input)
    if (init?.method === "PATCH") {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 1))
      active -= 1
      const body = JSON.parse(String(init.body)) as { storeId?: string }
      if (url.endsWith("/row-0")) {
        failed += 1
        return new Response(JSON.stringify({ error: "one row failed", code: "ROW_FAILED" }), { status: 500 })
      }
      return new Response(JSON.stringify({ data: listingRow({
        id: url.split("/").at(-1)!, store_id: body.storeId ?? "store-1", revision: 2, view_revision: 2,
        content_state: "draft", media_state: "pending", validation_state: "valid", submission_state: "none",
        draft: { values: {}, complex_values: [] },
      }) }), { status: 200 })
    }
    const id = url.split("/").at(-1)!
    return new Response(JSON.stringify({ data: listingRow({
      id, store_id: "store-2", revision: 1, view_revision: 1, content_state: "draft", media_state: "pending",
      validation_state: "valid", submission_state: "none", draft: { values: {}, complex_values: [] },
    }) }), { status: 200 })
  }) as typeof fetch
  try {
    await quota.handleEvenSplitQuotas()
    assert.ok(peak <= 4, `row writes must be bounded, observed ${peak}`)
    assert.equal(failed, 1)
    assert.equal(peekListingWorkbench().productBases["row-1"]?.target_store_id, "store-1")
  } finally {
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})

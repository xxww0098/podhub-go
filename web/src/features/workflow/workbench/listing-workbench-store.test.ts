import { listingRow, listingProjection } from "../../../../tests/listing-row-fixture"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  peekListingWorkbench,
  patchListingWorkbench,
  projectListingRows,
  projectListingProducts,
  editListingProduct,
  listingWorkbenchScope,
  settleListingProductEdit,
  resetListingWorkbench,
  receiveListingProducts,
  subscribeListingWorkbench,
} from "./listing-workbench-store"
import type { ListingRow } from "../model/listing-row"
import type { WorkflowDraftView } from "@/bindings/commands"
import { workflowActions } from "../workflow-actions"
import { rowStatusView } from "../model/row-state"
import { refreshProductStatus } from "./product-status"

function row(draftId: string, status: ListingRow["status"] = "pending"): ListingRow {
  return {
    id: draftId,
    draftId,
    imageName: `${draftId}.png`,
    status,
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "",
  }
}

test("a row patch does not invent a new queue progress snapshot", () => {
  resetListingWorkbench()
  const seen: Array<number | null> = []
  const stop = subscribeListingWorkbench((state) => {
    seen.push(state.rows.length)
  })
  projectListingRows(() => [row("a"), row("b")])
  projectListingRows((current) =>
    current.map((item) =>
      item.draftId === "a" ? { ...item, log: "settled" } : item,
    ),
  )
  stop()
  resetListingWorkbench()
  assert.deepEqual(seen, [2, 2])
})

test("subscribeListingWorkbench still accepts a one-argument listener and passes the previous snapshot", () => {
  resetListingWorkbench()
  const seen: Array<[number, number]> = []
  const stop = subscribeListingWorkbench((state, previous) => {
    seen.push([previous?.rows.length ?? -1, state.rows.length])
  })
  projectListingRows(() => [row("a")])
  stop()
  resetListingWorkbench()
  assert.deepEqual(seen, [[0, 1]])
})

test("product status refresh projects its row and lifecycle in one store update", async () => {
  resetListingWorkbench()
  const incoming = rowStatusView(listingRow({
    projection: listingProjection(), view_revision: 2,
    id: "a", card_id: "card", revision: 2, content_state: "ready", media_state: "ready",
    validation_state: "passed", submission_state: "none", draft: { values: {}, complex_values: [] },
    validation_issues: [], media: { images: [], videos: [] }, ai: { candidates: [] },
    source: {}, payload: {}, updated_at_ms: 2,
  }))
  const product: WorkflowDraftView = {
    draft_id: "a", kind: "instance", display_name: "", schema: { description_category_id: 1, type_id: 1, fields: [], complex_groups: [] },
    draft: { values: {}, complex_values: [] }, validation_state: "draft", issues: [],
    ai_prompt_id: "", ai_prompt: "", ai_prompt_file_name: "", psd_template_asset_id: "", psd_template_file_name: "",
    target_store_id: "", ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] },
    lifecycle: { ...incoming.lifecycle, revision: 1, stage: "awaiting_content" }, updated_at_ms: 1,
  }
  const selected = row("a")
  const sibling = row("b")
  patchListingWorkbench({ rows: [selected, sibling], productDrafts: { a: product } })
  const snapshots: Array<[number, ListingRow["status"]]> = []
  const stop = subscribeListingWorkbench((state) => {
    snapshots.push([state.productDrafts.a!.lifecycle.revision, state.rows[0]!.status])
  })
  const original = workflowActions.workflowGetProductStatus
  workflowActions.workflowGetProductStatus = async (id) => { assert.equal(id, "a"); return incoming }
  try {
    assert.equal(await refreshProductStatus(selected, "refreshed"), incoming)
    assert.deepEqual(snapshots, [[2, "ready"]], "subscribers never see a half-updated verdict")
    assert.equal(peekListingWorkbench().rows[0]!.log, "refreshed")
    assert.equal(peekListingWorkbench().rows[1], sibling)
    workflowActions.workflowGetProductStatus = async () => { throw new Error("offline") }
    assert.equal(await refreshProductStatus(selected), undefined)
    assert.equal(snapshots.length, 1, "a failed read does not publish a fabricated verdict")
  } finally {
    workflowActions.workflowGetProductStatus = original
    stop()
    resetListingWorkbench()
  }
})

test("runner reads the workbench store instead of parent props", () => {
  const runner = readFileSync(new URL("../card-runner.tsx", import.meta.url), "utf8")
  const screen = readFileSync(new URL("../workflow-screen.tsx", import.meta.url), "utf8")
  const progress = readFileSync(
    new URL("../workflow-task-progress.tsx", import.meta.url),
    "utf8",
  )
  assert.match(runner, /useListingWorkbenchStore/)
  assert.match(runner, /from "zustand\/react\/shallow"/)
  assert.doesNotMatch(screen, /useSetWorkflowProgress/)
  assert.match(screen, /resetListingWorkbench/)
  assert.doesNotMatch(progress, /useState<WorkflowTaskProgressView/)
})

test("peek after reset is empty", () => {
  projectListingRows(() => [row("keep")])
  patchListingWorkbench({ cardId: "card-1" })
  resetListingWorkbench()
  assert.equal(peekListingWorkbench().rows.length, 0)
  assert.equal(peekListingWorkbench().queueRunning, false)
  assert.equal(peekListingWorkbench().cardId, undefined)
})


test("a late HTTP status cannot replace a newer row or Draft", async () => {
  const { refreshProductStatus } = await import("./product-status")
  const target = row("a", "ready")
  const product = {
    draft_id: "a",
    draft: { values: { name: { kind: "text", value: "new title" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "ready_to_publish", ai: "ready", media: "ready", fields: "valid", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingRows(() => [target])
  projectListingProducts(() => ({ a: product }))
  const previous = globalThis.fetch
  globalThis.fetch = (async (input) => new Response(JSON.stringify({ data: String(input).includes("/intents")
    ? { items: [] }
    : listingRow({ id: "a", revision: 11, view_revision: 11, content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none", draft: { values: { name: { kind: "text", value: "old title" } }, complex_values: [] } })
  }), { status: 200 })) as typeof fetch
  try {
    await refreshProductStatus(target)
    assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "new title")
    assert.equal(peekListingWorkbench().productDrafts.a?.lifecycle.revision, 12)
    assert.equal(peekListingWorkbench().rows[0]?.status, "ready")
  } finally {
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})


test("a server refresh preserves a pending local Draft edit", async () => {
  const { refreshProductStatus } = await import("./product-status")
  const target = row("a")
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "original" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingRows(() => [target])
  projectListingProducts(() => ({ a: product }))
  const edited = { ...product, draft: { ...product.draft, values: { name: { kind: "text" as const, value: "my unsaved title" } } } }
  editListingProduct("a", edited)
  const previous = globalThis.fetch
  globalThis.fetch = (async (input) => new Response(JSON.stringify({ data: String(input).includes("/intents")
    ? { items: [] }
    : listingRow({ id: "a", revision: 13, view_revision: 13, content_state: "draft", media_state: "ready", projection: listingProjection({ media: "ready" }), validation_state: "stale", submission_state: "none", draft: product.draft })
  }), { status: 200 })) as typeof fetch
  try {
    await refreshProductStatus(target)
    assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "my unsaved title")
    assert.equal(peekListingWorkbench().productDrafts.a?.lifecycle.media, "ready")
  } finally {
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})


test("a save response predating an applied card invalidation is dropped (db-write-amp 08)", () => {
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "original" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, phase: "draft", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingRows(() => [row("a")])
  projectListingProducts(() => ({ a: product }))
  const scope = listingWorkbenchScope()
  const typed = editListingProduct("a", { ...product, draft: { ...product.draft, values: { ...product.draft.values, name: { kind: "text" as const, value: "typed" } } } })!
  // The card-level invalidation is applied while the save is in flight: a
  // template change does not bump view_revision, so only the epoch can
  // detect that the response predates it.
  patchListingWorkbench((current) => ({ mediaEpoch: current.mediaEpoch + 1 }))
  const saved = { ...typed.view, lifecycle: { ...product.lifecycle, revision: 13, view_revision: 13 } }
  settleListingProductEdit(typed, saved, scope, undefined, 0)
  assert.equal(peekListingWorkbench().productBases.a?.lifecycle.view_revision, 12, "the stale response never moves the baseline")
  assert.ok(peekListingWorkbench().dirtyProducts.a, "the edit stays dirty and flushes again")
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "typed")
  // A response issued after the invalidation settles normally.
  settleListingProductEdit(typed, saved, scope, undefined, 1)
  assert.equal(peekListingWorkbench().productBases.a?.lifecycle.view_revision, 13)
  assert.equal(peekListingWorkbench().dirtyProducts.a, undefined)
  resetListingWorkbench()
})

test("only the matching save response acknowledges local edits; removed rows stay removed", () => {
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "original" }, price: { kind: "text", value: "100" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingRows(() => [row("a")])
  projectListingProducts(() => ({ a: product }))
  const scope = listingWorkbenchScope()
  const title = (value: string) => ({ ...product, draft: { ...product.draft, values: { ...product.draft.values, name: { kind: "text" as const, value } } } })
  const first = editListingProduct("a", title("first"))!
  const second = editListingProduct("a", title("second"))!
  const saved = { ...first.view, draft: { ...first.view.draft, values: { ...first.view.draft.values, price: { kind: "text" as const, value: "200" } } }, lifecycle: { ...product.lifecycle, revision: 13, view_revision: 13 } }
  settleListingProductEdit(first, saved, scope)
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "second")
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.price?.value, "200")
  assert.equal(peekListingWorkbench().dirtyProducts.a?.id, second.id)
  assert.equal(peekListingWorkbench().dirtyProducts.a?.base.draft.values.name?.value, "first")
  projectListingProducts(() => ({}))
  settleListingProductEdit(second, { ...second.view, lifecycle: { ...product.lifecycle, revision: 14, view_revision: 14 } }, scope)
  projectListingProducts((current) => ({ ...current, a: saved }))
  assert.equal(peekListingWorkbench().productDrafts.a, undefined)
  assert.equal(peekListingWorkbench().dirtyProducts.a, undefined)
  resetListingWorkbench()
})

test("an old HTTP request is ignored after leaving and reopening the same card", async () => {
  const { refreshProductStatus } = await import("./product-status")
  const product = {
    draft_id: "a", draft: { values: { name: { kind: "text", value: "reopened title" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  const target = row("a")
  resetListingWorkbench()
  projectListingRows(() => [target])
  projectListingProducts(() => ({ a: product }))
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const previous = globalThis.fetch
  globalThis.fetch = (async (input) => {
    await held
    return new Response(JSON.stringify({ data: String(input).includes("/intents")
      ? { items: [] }
      : listingRow({ id: "a", revision: 99, view_revision: 99, content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none", draft: { values: { name: { kind: "text", value: "previous card response" } }, complex_values: [] } })
    }), { status: 200 })
  }) as typeof fetch
  try {
    const request = refreshProductStatus(target)
    resetListingWorkbench()
    projectListingRows(() => [target])
    projectListingProducts(() => ({ a: product }))
    release()
    await request
    assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "reopened title")
    assert.equal(peekListingWorkbench().productDrafts.a?.lifecycle.revision, 12)
  } finally {
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})


test("a conflict retry preserves input on cancel and saves only after an explicit keep-mine choice", async () => {
  const { prepareRowSaveRetry } = await import("../editing/use-row-autosaves")
  const { persistRowEdit } = await import("../batch-actions")
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "original" }, price: { kind: "text", value: "100" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingRows(() => [row("a")])
  projectListingProducts(() => ({ a: product }))
  const edited = editListingProduct("a", { ...product, draft: { ...product.draft, values: {
    ...product.draft.values, name: { kind: "text", value: "my title" },
  } } })!
  let current = listingRow({ id: "a", store_id: "store-1", revision: 13, view_revision: 13, content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none", draft: {
    values: { name: { kind: "text", value: "their title" }, price: { kind: "text", value: "200" } }, complex_values: [],
  } })
  let writes = 0
  const previous = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    if (init?.method === "PATCH") {
      writes += 1
      const body = JSON.parse(String(init.body))
      assert.equal(body.baseRevision, current.revision)
      current = { ...current, revision: current.revision + 1, view_revision: current.view_revision + 1, draft: body.draft }
    }
    return new Response(JSON.stringify({ data: String(input).includes("/intents") ? { items: [] } : current }), { status: 200 })
  }) as typeof fetch
  try {
    let choices = 0
    const cancelled = await prepareRowSaveRetry("a", (message) => {
      choices += 1
      assert.match(message, /their title/)
      return false
    })
    assert.equal(cancelled, undefined)
    assert.equal(writes, 0)
    assert.equal(peekListingWorkbench().dirtyProducts.a?.id, edited.id)
    assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "my title")
    const confirmed = await prepareRowSaveRetry("a", () => { choices += 1; return true })
    assert.ok(confirmed)
    assert.notEqual(confirmed.id, edited.id)
    assert.equal(choices, 2)
    const result = await persistRowEdit(confirmed.view, confirmed.base)
    settleListingProductEdit(confirmed, result.saved, listingWorkbenchScope())
    assert.equal(writes, 1)
    assert.equal(current.draft.values.name.value, "my title")
    assert.equal(current.draft.values.price.value, "200")
    assert.equal(peekListingWorkbench().dirtyProducts.a, undefined)
  } finally {
    globalThis.fetch = previous
    resetListingWorkbench()
  }
})

test("typing after a background refresh does not make its unrelated field a local edit", () => {
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "original" }, price: { kind: "text", value: "100" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12 },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingProducts(() => ({ a: product }))
  editListingProduct("a", { ...product, draft: { ...product.draft, values: { ...product.draft.values, name: { kind: "text", value: "first" } } } })
  const server = (price: string, revision: number) => ({ ...product, draft: { ...product.draft, values: { ...product.draft.values, price: { kind: "text" as const, value: price } } }, lifecycle: { ...product.lifecycle, revision, view_revision: revision } })
  projectListingProducts(() => ({ a: server("200", 13) }))
  const visible = peekListingWorkbench().productDrafts.a!
  editListingProduct("a", { ...visible, draft: { ...visible.draft, values: { ...visible.draft.values, name: { kind: "text", value: "second" } } } })
  projectListingProducts(() => ({ a: server("300", 14) }))
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "second")
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.price?.value, "300")
  resetListingWorkbench()
})

test("a field first edited after a refresh keeps its displayed baseline across an older save ack", () => {
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "original" }, description: { kind: "text", value: "A" } }, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12 },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingProducts(() => ({ a: product }))
  const first = editListingProduct("a", { ...product, draft: { ...product.draft, values: { ...product.draft.values, name: { kind: "text", value: "title" } } } })!
  projectListingProducts(() => ({ a: { ...product, draft: { ...product.draft, values: { ...product.draft.values, description: { kind: "text", value: "B" } } }, lifecycle: { ...product.lifecycle, revision: 14, view_revision: 14 } } }))
  const visible = peekListingWorkbench().productDrafts.a!
  editListingProduct("a", { ...visible, draft: { ...visible.draft, values: { ...visible.draft.values, description: { kind: "text", value: "A" } } } })
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.description?.value, "A")
  settleListingProductEdit(first, { ...first.view, lifecycle: { ...product.lifecycle, revision: 13, view_revision: 13 } }, listingWorkbenchScope())
  assert.equal(peekListingWorkbench().dirtyProducts.a?.base.draft.values.name?.value, "title")
  assert.equal(peekListingWorkbench().dirtyProducts.a?.base.draft.values.description?.value, "B")
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.description?.value, "A")
  resetListingWorkbench()
})

test("a successful field correction replaces stale row readiness with its save verdict", () => {
  const readiness = { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: [] }
  const product = {
    draft_id: "a", draft: { values: {}, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 12, stage: "build_stale", ai: "ready", media: "ready", fields: "invalid", ai_candidates: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  projectListingProducts(() => ({ a: product }))
  projectListingRows(() => [{ ...row("a"), readiness: { ...readiness, ready_to_publish: false } }])
  const edit = editListingProduct("a", { ...product, draft: { ...product.draft, values: { name: { kind: "text", value: "fixed" } } } })!
  settleListingProductEdit(edit, { ...edit.view, lifecycle: { ...product.lifecycle, revision: 13, view_revision: 13, stage: "ready_to_publish", fields: "valid" } }, listingWorkbenchScope(), readiness)
  assert.equal(peekListingWorkbench().rows[0]?.readiness?.ready_to_publish, true)
  assert.equal(peekListingWorkbench().rows[0]?.readiness?.ready_to_publish, true)
  resetListingWorkbench()
})

test("same-Draft-revision receipts use the response version at every cache entry", async () => {
  const { commitProductStatus } = await import("./product-status")
  const target = row("a", "sent")
  const product = {
    draft_id: "a", draft: { values: {}, complex_values: [] },
    lifecycle: { revision: 12, view_revision: 101, stage: "accepted", ai: "ready", media: "ready", fields: "valid", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  const status = (version: number, stage: "accepted" | "outcome_unknown") => ({
    target_store_id: "",
    lifecycle: { ...product.lifecycle, view_revision: version, stage },
    readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: [], allowed_actions: [] },
  })
  resetListingWorkbench()
  projectListingRows(() => [target])
  projectListingProducts(() => ({ a: product }))
  const scope = listingWorkbenchScope()
  assert.equal(commitProductStatus("a", status(100, "outcome_unknown"), scope), false)
  projectListingProducts(() => ({ a: { ...product, lifecycle: status(99, "outcome_unknown").lifecycle } }))
  assert.equal(peekListingWorkbench().productDrafts.a!.lifecycle.stage, "accepted")
  assert.equal(peekListingWorkbench().rows[0]!.status, "sent")
  assert.equal(commitProductStatus("a", status(102, "outcome_unknown"), scope), true)
  assert.equal(peekListingWorkbench().productDrafts.a!.lifecycle.revision, 12)
  assert.equal(peekListingWorkbench().rows[0]!.status, "exception")
  resetListingWorkbench()
})


test("stream receive keeps newer HTTP facts, dirty edits and deletion tombstones", () => {
  const readiness = listingProjection().readiness
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "saved" }, price: { kind: "text", value: "100" } }, complex_values: [] },
    lifecycle: { revision: 1, view_revision: 10, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  const scope = listingWorkbenchScope()
  receiveListingProducts([{ product, readiness }], new Set(), scope)
  editListingProduct("a", { ...product, draft: { ...product.draft, values: { ...product.draft.values, name: { kind: "text", value: "typing" } } } })
  const newer = { ...product, draft: { ...product.draft, values: { ...product.draft.values, price: { kind: "text" as const, value: "200" } } }, lifecycle: { ...product.lifecycle, view_revision: 12, media: "ready" as const } }
  projectListingProducts(() => ({ a: newer }))
  receiveListingProducts([{ product, readiness }], new Set(), scope)
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.price?.value, "200")
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "typing")
  receiveListingProducts([], new Set(["a"]), scope)
  receiveListingProducts([{ product: newer, readiness }], new Set(), scope)
  projectListingProducts(() => ({ a: newer }))
  assert.equal(peekListingWorkbench().rows.length, 0)
  assert.equal(peekListingWorkbench().productBases.a, undefined)
  assert.equal(peekListingWorkbench().dirtyProducts.a, undefined)
  resetListingWorkbench()
  receiveListingProducts([{ product, readiness }], new Set(), scope)
  assert.equal(peekListingWorkbench().rows.length, 0)
})

test("a later card event replaces an unknown import with the probe conclusion", () => {
  const readiness = listingProjection().readiness
  const product = (
    stage: "outcome_unknown" | "accepted" | "publish_rejected",
    view: number,
    extra: Record<string, unknown> = {},
  ) => ({
    draft_id: "a", target_store_id: "store-1",
    draft: { values: {}, complex_values: [] },
    lifecycle: {
      revision: 1, view_revision: view, stage, ai: "ready", media: "ready", fields: "valid",
      ai_candidates: [], images: [], failure_log: [], product_videos: [], ...extra,
    },
  } as unknown as WorkflowDraftView)
  resetListingWorkbench()
  const scope = listingWorkbenchScope()
  receiveListingProducts([{
    product: product("outcome_unknown", 10, { importProbe: { phase: "checking", passes: 1, nextCheckAtMs: 1 } }),
    readiness,
  }], new Set(), scope)
  assert.equal(peekListingWorkbench().rows[0]!.status, "exception")
  receiveListingProducts([{ product: product("accepted", 11), readiness }], new Set(), scope)
  assert.equal(peekListingWorkbench().productBases.a!.lifecycle.stage, "accepted")
  assert.equal(peekListingWorkbench().rows[0]!.status, "sent")
  receiveListingProducts([{
    product: product("publish_rejected", 12, { last_error_detail: "类目属性无效" }),
    readiness,
  }], new Set(), scope)
  assert.equal(peekListingWorkbench().productBases.a!.lifecycle.last_error_detail, "类目属性无效")
  assert.equal(peekListingWorkbench().rows[0]!.status, "failed")
  receiveListingProducts([{
    product: product("outcome_unknown", 13, {
      importProbe: { phase: "needs_manual", passes: 8 },
      last_error_code: "OZON_RECONCILE_STILL_UNKNOWN",
    }),
    readiness,
  }], new Set(), scope)
  assert.equal(peekListingWorkbench().productBases.a!.lifecycle.importProbe?.phase, "needs_manual")
  receiveListingProducts([{ product: product("accepted", 12), readiness }], new Set(), scope)
  assert.equal(peekListingWorkbench().productBases.a!.lifecycle.importProbe?.phase, "needs_manual")
  resetListingWorkbench()
})

test("a stream update keeps unchanged dirty siblings, order and selection stable", () => {
  const readiness = listingProjection().readiness
  const product = (draftId: string, name: string, queue_position: number) => ({
    draft_id: draftId, target_store_id: "store-1",
    draft: { values: { name: { kind: "text" as const, value: name }, price: { kind: "text" as const, value: "100" } }, complex_values: [] },
    lifecycle: { revision: 1, view_revision: 10, queue_position, stage: "awaiting_content" as const, ai: "pending" as const, media: "pending" as const, fields: "dirty" as const, ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as WorkflowDraftView)
  resetListingWorkbench()
  const scope = listingWorkbenchScope()
  const a = product("a", "saved a", 1)
  const b = product("b", "saved b", 2)
  patchListingWorkbench({ rows: [row("a"), row("b")], productDrafts: { a, b }, selectedIds: ["a", "b"] })
  editListingProduct("a", { ...a, draft: { ...a.draft, values: { ...a.draft.values, name: { kind: "text", value: "mine a" } } } })
  const bEdit = editListingProduct("b", { ...b, draft: { ...b.draft, values: { ...b.draft.values, name: { kind: "text", value: "mine b" } } } })!
  const before = peekListingWorkbench()
  const sibling = before.productDrafts.b
  const selectedIds = before.selectedIds
  const newerA = { ...a, draft: { ...a.draft, values: { ...a.draft.values, price: { kind: "text" as const, value: "200" } } }, lifecycle: { ...a.lifecycle, revision: 2, view_revision: 11 } }

  receiveListingProducts([{ product: newerA, readiness }], new Set(), scope)

  const after = peekListingWorkbench()
  assert.equal(after.productDrafts.b, sibling)
  assert.equal(after.productDrafts.b?.draft.values.name?.value, "mine b")
  assert.equal(after.productDrafts.a?.draft.values.name?.value, "mine a")
  assert.equal(after.productDrafts.a?.draft.values.price?.value, "200")
  assert.deepEqual(after.rows.map((item) => item.draftId), ["a", "b"])
  assert.equal(after.selectedIds, selectedIds)
  settleListingProductEdit(bEdit, b, scope)
  assert.equal(peekListingWorkbench().productDrafts.b?.draft.values.name?.value, "saved b")
  resetListingWorkbench()
})

test("a late AI result does not overwrite a manual title", () => {
  const readiness = listingProjection().readiness
  const product = {
    draft_id: "a", target_store_id: "store-1",
    draft: { values: { name: { kind: "text", value: "saved" } }, complex_values: [] },
    lifecycle: { revision: 1, view_revision: 10, stage: "awaiting_content", ai: "pending", media: "pending", fields: "dirty", ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as import("@/bindings/commands").WorkflowDraftView
  resetListingWorkbench()
  const scope = listingWorkbenchScope()
  receiveListingProducts([{ product, readiness }], new Set(), scope)
  editListingProduct("a", { ...product, draft: { ...product.draft, values: { name: { kind: "text", value: "mine" } } } })
  const lateAi = {
    ...product,
    draft: { values: { name: { kind: "text" as const, value: "Nastennaya kartina" } }, complex_values: [] },
    lifecycle: { ...product.lifecycle, view_revision: 20, ai: "ready" as const },
  }
  receiveListingProducts([{ product: lateAi, readiness }], new Set(), scope)
  assert.equal(peekListingWorkbench().productDrafts.a?.draft.values.name?.value, "mine")
  assert.equal(peekListingWorkbench().productBases.a?.lifecycle.view_revision, 20)
  resetListingWorkbench()
})

test("a content-only stream update keeps row order and unchanged row references without sorting", () => {
  const readiness = listingProjection().readiness
  const product = (draftId: string, queue_position: number, viewRevision: number) => ({
    draft_id: draftId, target_store_id: "store-1",
    draft: { values: {}, complex_values: [] },
    lifecycle: { revision: 1, view_revision: viewRevision, queue_position, stage: "awaiting_content" as const, ai: "pending" as const, media: "pending" as const, fields: "dirty" as const, ai_candidates: [], images: [], failure_log: [], product_videos: [] },
  } as unknown as WorkflowDraftView)
  resetListingWorkbench()
  const scope = listingWorkbenchScope()
  receiveListingProducts([
    { product: product("b", 2, 10), readiness },
    { product: product("a", 1, 10), readiness },
    { product: product("c", 3, 10), readiness },
  ], new Set(), scope)
  const before = peekListingWorkbench()
  assert.deepEqual(before.rows.map((item) => item.draftId), ["a", "b", "c"])

  // A title-only change on the middle row must not rebuild the order: the row
  // array stays [a, b, c], untouched rows keep their object identity, and a
  // fenced older revision is a complete no-op.
  const newerB = { ...product("b", 2, 11), lifecycle: { ...product("b", 2, 11).lifecycle, media: "ready" as const } }
  receiveListingProducts([{ product: newerB, readiness }], new Set(), scope)
  const after = peekListingWorkbench()
  assert.deepEqual(after.rows.map((item) => item.draftId), ["a", "b", "c"])
  assert.equal(after.rows[0], before.rows[0])
  assert.equal(after.rows[2], before.rows[2])
  assert.notEqual(after.rows[1], before.rows[1])

  const staleB = { ...product("b", 2, 10) }
  receiveListingProducts([{ product: staleB, readiness }], new Set(), scope)
  assert.equal(peekListingWorkbench().rows, after.rows)

  // A queue_position change is a membership/order change: it re-sorts.
  const movedC = { ...product("c", 0, 11) }
  receiveListingProducts([{ product: movedC, readiness }], new Set(), scope)
  assert.deepEqual(peekListingWorkbench().rows.map((item) => item.draftId), ["c", "a", "b"])
  resetListingWorkbench()
})

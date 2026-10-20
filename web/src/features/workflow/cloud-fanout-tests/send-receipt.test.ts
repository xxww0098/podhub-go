/** Real Hook callbacks, command adapters and HTTP boundaries. SSR supplies React's
 * refs; these checks cover explicit actions, not mounted effects or rerenders. */
import { listingProjection } from "../../../../tests/listing-row-fixture"
import assert from "node:assert/strict"
import test, { before } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { route } from "@/api/routes"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { invalidateAccountOverview } from "@/features/account/account-overview-cache"
import { rowStatusView } from "../model/row-state"
import { nativeCardPayload, warmProductionSend } from "../submit/send-test-support"
import {
  listingWorkbenchScope,
  patchListingWorkbench,
  peekListingWorkbench,
  receiveListingProducts,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { cloudRow, product } from "./fixtures"
import { capturePublishQueue } from "./publish-queue-harness"

// The send rail freezes through the real native core against resident material.
before(warmProductionSend)

test("a late submit receipt cannot move a newer streamed completion back to running", async () => {
  resetListingWorkbench()
  const row = cloudRow("late")
  patchListingWorkbench({
    rows: [{ id: row.id, draftId: row.id, imageName: "late.png", status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
    queueFrozenIds: [row.id], productDrafts: { [row.id]: product(row.id) },
  })
  const hook = capturePublishQueue()
  const original = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let submitting = false
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === route("listingSubmit")) {
      submitting = true
      entered()
      await gate
      return Response.json({ data: { items: [{ row_id: row.id, created: true, intent: { id: "intent" },
        row: { ...row, view_revision: 2, projection: listingProjection({ stage: "submitting" }) },
      }] } })
    }
    if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload(), updated_at_ms: 1 } })
    if (url === route("listingRowsById", { id: row.id })) return Response.json({ data: row })
    if (url.startsWith(`${route("listingIntents")}?`)) return Response.json({ data: { items: [] } })
    throw new Error(`unexpected request ${url}`)
  }
  const sending = hook.startPublish()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    try {
      await Promise.race([started, sending.then(() => assert.fail("send settled before the actual submit")),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("submit boundary not reached within 3 seconds")), 3000) })])
    } finally { clearTimeout(timer) }
    assert.equal(submitting, true)
    const completed = rowStatusView({ ...row, view_revision: 3, projection: listingProjection({ stage: "accepted" }) })
    receiveListingProducts([{ product: { ...product(row.id), lifecycle: completed.lifecycle }, readiness: completed.readiness }], new Set(), listingWorkbenchScope())
    assert.equal(peekListingWorkbench().rows[0]?.status, "sent")
    release()
    await sending
    assert.equal(peekListingWorkbench().productBases[row.id]?.lifecycle.stage, "accepted")
    assert.equal(peekListingWorkbench().rows[0]?.status, "sent")
    assert.equal(peekListingWorkbench().queueRunning, false)
  } finally {
    release()
    await sending
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

for (const leave of [false, true]) test(`accepted send survives queue refresh failure (leave=${leave})`, async () => {
  resetListingWorkbench()
  const row = cloudRow("accepted")
  // The card stream's snapshot already made the row resident, as in production.
  rememberListingRows([row], rowCacheScope())
  patchListingWorkbench({
    rows: [{ id: row.id, draftId: row.id, imageName: "accepted.png", status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
    queueFrozenIds: [row.id], productDrafts: { [row.id]: product(row.id) },
  })
  const hook = capturePublishQueue()
  const original = globalThis.fetch
  let submissions = 0
  let rowGets = 0
  let postReceiptCardGets = 0
  const requests: string[] = []
  let releaseRefresh!: () => void
  const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve })
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (url === route("listingSubmit")) {
      submissions++
      return Response.json({ data: { items: [{ row_id: row.id, created: true, intent: { id: "intent" },
        row: { ...row, view_revision: 2, submission_state: "queued", projection: listingProjection({ stage: "queued" }) },
      }] } })
    }
    if (url === route("listingCardsById", { id: "card" })) {
      if (submissions) {
        if ((init?.method ?? "GET") === "GET") postReceiptCardGets++
        // A complete authoritative receipt settles directly; this 503 guards
        // against an accidental refresh dependency rather than serving a read.
        await refreshGate
        return Response.json({ message: "暂时无法读取队列" }, { status: 503 })
      }
      return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload(), updated_at_ms: 1 } })
    }
    if (url === route("listingRowsById", { id: row.id })) { rowGets += 1; return Response.json({ data: row }) }
    if (url.startsWith(`${route("listingIntents")}?`)) return Response.json({ data: { items: [] } })
    throw new Error(`unexpected request ${url}`)
  }
  const sending = hook.startPublish()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    try {
      await Promise.race([sending,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("send did not settle within 3 seconds")), 3000) })])
    } finally { clearTimeout(timer) }
    assert.equal(submissions, 1)
    assert.equal(peekListingWorkbench().productBases[row.id]?.lifecycle.stage, "queued")
    assert.equal(peekListingWorkbench().rows[0]?.status, "running")
    assert.equal(peekListingWorkbench().queueRunning, true, "read failure must not undo the accepted send")
    assert.equal(hook.submissionPending(), false, "background queue does not block navigation")
    assert.equal(rowGets, 0, "click-time pins and the complete submit receipt need no row GET")
    assert.equal(postReceiptCardGets, 0, "the authoritative receipt needs no post-submit card GET")
    if (leave) resetListingWorkbench()
    releaseRefresh()
    await sending
    assert.equal(requests.some((url) => url.includes("/cancel")), false, "leaving never cancels server work")
    if (leave) {
      assert.deepEqual(peekListingWorkbench().rows, [], "late reads cannot restore the previous card")
      assert.equal(peekListingWorkbench().queueRunning, false)
    } else assert.equal(peekListingWorkbench().queueRunning, true)
  } finally {
    releaseRefresh()
    await sending
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

test("a deferred send stays running when a stale queue projection reports running false", async () => {
  resetListingWorkbench()
  const row = cloudRow("deferred-queue")
  patchListingWorkbench({
    rows: [{ id: row.id, draftId: row.id, imageName: "deferred-queue.png", status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
    queueFrozenIds: [row.id], productDrafts: { [row.id]: product(row.id) },
  })
  let releaseFlush!: () => void
  const flushGate = new Promise<void>((resolve) => { releaseFlush = resolve })
  const hook = capturePublishQueue({ flushAutosave: async () => { await flushGate; return true } })
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === route("listingCardsById", { id: "card" }) && init?.method === "PATCH") return Response.json({ data: { id: "card", revision: 2, payload: nativeCardPayload({ queue: { frozenRowIds: [row.id], paused: false, stopAfterCurrent: false, nextPosition: 0 } }), updated_at_ms: 2 } })
    if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload({ queue: { frozenRowIds: [row.id], paused: false, stopAfterCurrent: false, nextPosition: 0 } }), updated_at_ms: 1 } })
    if (url === route("listingRowsById", { id: row.id })) return Response.json({ data: row })
    if (url === route("listingIntents")) return Response.json({ data: { items: [], nextCursor: null } })
    if (url === route("listingRows") || url.startsWith(`${route("listingRows")}?`)) return Response.json({ data: { items: [row], nextCursor: null } })
    if (url === route("listingSubmit")) return Response.json({ data: { items: [{ row_id: row.id, created: true, intent: { id: "intent-deferred" }, row: { ...row, view_revision: 2, submission_state: "queued", projection: listingProjection({ stage: "queued" }) } }] } })
    throw new Error(`unexpected request ${url}`)
  }
  let sending!: Promise<unknown>
  try {
    sending = hook.startPublish()
    await tick()
    assert.equal(peekListingWorkbench().queueRunning, true, "send gives immediate feedback before autosave finishes")
    hook.projectQueueState({ paused: false, running: false, frozen_row_ids: [row.id], next_position: 0, stop_after_current: false, halt_reason: undefined })
    assert.equal(peekListingWorkbench().queueRunning, true)
    releaseFlush()
    await sending
  } finally {
    releaseFlush?.()
    await Promise.allSettled([sending])
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

test("a failed send queue save does not restore an old workbench snapshot over streamed rows", async () => {
  resetListingWorkbench()
  const original = cloudRow("queue-original")
  const initialProduct = product(original.id)
  patchListingWorkbench({
    rows: [{ id: original.id, draftId: original.id, imageName: "queue-original.png", status: "ready", ai: "done", render: "done", upload: "done", log: "before" }],
    queueFrozenIds: [original.id], productDrafts: { [original.id]: initialProduct },
  })
  const hook = capturePublishQueue()
  const originalFetch = globalThis.fetch
  let releaseSave!: () => void
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve })
  let saveStarted!: () => void
  const saveSeen = new Promise<void>((resolve) => { saveStarted = resolve })
  let cardPatch = 0
  const updated = product(original.id)
  const updatedView = rowStatusView({ ...original, revision: 2, view_revision: 2, projection: listingProjection({ stage: "queued" }) })
  updated.lifecycle = updatedView.lifecycle
  const added = product("queue-added")
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === route("listingCardsById", { id: "card" }) && init?.method === "PATCH") {
      cardPatch += 1
      if (cardPatch === 1) {
        saveStarted()
        await saveGate
        return new Response(JSON.stringify({ message: "queue save failed" }), { status: 503 })
      }
      return Response.json({ data: { id: "card", revision: 2, payload: nativeCardPayload({ queue: { frozenRowIds: [original.id], paused: true, stopAfterCurrent: true, nextPosition: 0 } }), updated_at_ms: 2 } })
    }
    if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload({ queue: { frozenRowIds: [original.id], paused: false, stopAfterCurrent: false, nextPosition: 0 } }), updated_at_ms: 1 } })
    if (url === route("listingRows")) return Response.json({ data: { items: [original], nextCursor: null } })
    if (url.startsWith(`${route("listingRows")}/`)) return Response.json({ data: original })
    if (url.startsWith(`${route("listingIntents")}?`)) return Response.json({ data: { items: [] } })
    throw new Error(`unexpected request ${url}`)
  }
  const sending = hook.startPublish()
  try {
    await saveSeen
    receiveListingProducts([
      { product: updated, readiness: updatedView.readiness },
      { product: added, readiness: rowStatusView(cloudRow(added.draft_id)).readiness },
    ], new Set(), listingWorkbenchScope())
    assert.equal(peekListingWorkbench().rows.some((row) => row.draftId === added.draft_id), true)
    releaseSave()
    await sending
    const state = peekListingWorkbench()
    assert.equal(state.rows.some((row) => row.draftId === added.draft_id), true)
    assert.equal(state.productBases[original.id]?.lifecycle.view_revision, 2)
    assert.equal(state.productBases[added.draft_id]?.draft.values.offer_id?.value, added.draft.values.offer_id?.value)
  } finally {
    releaseSave?.()
    await sending
    globalThis.fetch = originalFetch
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

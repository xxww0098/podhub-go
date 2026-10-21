/** Real Hook callbacks, command adapters and HTTP boundaries. SSR supplies React's
 * refs; these checks cover explicit actions, not mounted effects or rerenders. */
import assert from "node:assert/strict"
import test, { before } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { route } from "@/api/routes"
import { invalidateAccountOverview } from "@/features/account/account-overview-cache"
import type { ListingRow } from "../model/listing-row"
import { nativeCardPayload, warmProductionSend } from "../submit/send-test-support"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { cloudRow, product } from "./fixtures"
import { capturePublishQueue } from "./publish-queue-harness"

// The send rail freezes through the real native core against resident material.
before(warmProductionSend)

/** Observe the actual HTTP boundary, never assume one event-loop tick freezes 100 rows. */
function observeSubmit(expectedIds: readonly string[]) {
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const signals: AbortSignal[] = []
  let aborts = 0
  return {
    receive(init?: RequestInit) {
      // This pre-S17 Cloud-row bridge uses batch/submit, not the Draft items wire.
      const body = JSON.parse(String(init?.body)) as { store_id: string; row_ids: string[] }
      assert.deepEqual(body, { store_id: "store", row_ids: [...expectedIds],
        expected_revisions: expectedIds.map((rowId) => ({ row_id: rowId, revision: 1 })) })
      assert.ok(init?.signal, "the original submit request has its own signal")
      signals.push(init.signal)
      init.signal.addEventListener("abort", () => { aborts++ }, { once: true })
      entered()
      return body
    },
    async wait(sending: Promise<unknown>) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([started, sending.then(() => assert.fail("send settled before reaching submit")),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("submit boundary not reached within 3 seconds")), 3000) })])
      } finally { clearTimeout(timer) }
    },
    assertUnaborted() {
      assert.equal(signals.length, 1, "Stop retains exactly the original request")
      assert.equal(signals[0]!.aborted, false, "Stop must not abort the in-flight submit")
      assert.equal(aborts, 0)
    },
  }
}

test("a failed stop queue save still cancels an in-flight submit after the final intent rescan", async () => {
  resetListingWorkbench()
  const row = cloudRow("stop-save-fails")
  patchListingWorkbench({
    rows: [{ id: row.id, draftId: row.id, imageName: "stop-save-fails.png", status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
    queueFrozenIds: [row.id], productDrafts: { [row.id]: product(row.id) },
  })
  const hook = capturePublishQueue()
  const originalFetch = globalThis.fetch
  let submitRelease!: () => void
  const submitGate = new Promise<void>((resolve) => { submitRelease = resolve })
  const submit = observeSubmit([row.id])
  let patchCount = 0
  let intentReads = 0
  const cancelled: string[] = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost")
    if (url.pathname === route("listingRowsById", { id: "stop-save-fails" })) return Response.json({ data: row })
    if (url.pathname === route("listingSubmit")) {
      submit.receive(init)
      await submitGate
      return Response.json({ data: { items: [{ row_id: row.id, created: true, intent: { id: "intent-late" } }] } })
    }
    if (url.pathname === route("listingCardsById", { id: "card" }) && init?.method === "PATCH") {
      patchCount += 1
      if (patchCount === 1) return Response.json({ data: { id: "card", revision: 2, payload: nativeCardPayload({ queue: { frozenRowIds: [row.id], paused: false, stopAfterCurrent: false, nextPosition: 0 } }), updated_at_ms: 2 } })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      return new Response(JSON.stringify({ message: "stop queue save failed" }), { status: 503 })
    }
    if (url.pathname === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload({ queue: { frozenRowIds: [row.id], paused: false, stopAfterCurrent: false, nextPosition: 0 } }), updated_at_ms: 1 } })
    if (url.pathname === route("listingIntents") && url.searchParams.has("cardId")) {
      intentReads += 1
      return intentReads === 1
        ? Response.json({ data: { items: [], next_cursor: null } })
        : Response.json({ data: { items: [{ id: "intent-late", listing_row_id: row.id, state: "queued" }], next_cursor: null } })
    }
    if (url.pathname === route("listingIntentsByIdCancel", { id: "intent-late" }) && init?.method === "POST") {
      cancelled.push("intent-late")
      return Response.json({ data: { id: "intent-late", state: "queued" } })
    }
    if (url.pathname === route("listingRows")) return Response.json({ data: { items: [row], nextCursor: null } })
    throw new Error(`unexpected request ${url}`)
  }
  let sending!: Promise<unknown>
  let stopping!: Promise<unknown>
  try {
    sending = hook.startPublish()
    await submit.wait(sending)
    stopping = hook.stopPublish()
    submit.assertUnaborted()
    submitRelease()
    await Promise.all([sending, stopping])
    submit.assertUnaborted()
    assert.deepEqual(cancelled, ["intent-late"])
    assert.equal(intentReads, 2, "stop rescans after the in-flight submit settles")
  } finally {
    submitRelease?.()
    await Promise.allSettled([sending, stopping])
    globalThis.fetch = originalFetch
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

for (const firstCancelFails of [false, true]) {
 test(`stop fences later chunks and cancels in-flight intents${firstCancelFails ? " after an initial cancellation failure" : ""}`, async () => {
  resetListingWorkbench()
  const ids = Array.from({ length: 101 }, (_, i) => `stop-${i}`)
  patchListingWorkbench({
    rows: ids.map((id): ListingRow => ({ id, draftId: id, imageName: `${id}.png`, status: "ready", ai: "done", render: "done", upload: "done", log: "" })),
    queueFrozenIds: ids, productDrafts: Object.fromEntries(ids.map((id) => [id, product(id)])),
  })
  const hook = capturePublishQueue()
  const original = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let submissions = 0
  const submit = observeSubmit(ids.slice(0, 100))
  const intents = new Map<string, string>()
  const cancelled = new Set<string>()
  let cancellationFailed = false
  let card = { id: "card", revision: 1, payload: nativeCardPayload({ queue: { frozenRowIds: ids, paused: false, stopAfterCurrent: false } }), updated_at_ms: 1 }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), "http://localhost")
    const path = url.pathname
    if (path === route("listingSubmit")) {
      submissions++
      const body = submit.receive(init)
      if (submissions === 1) await gate
      for (const id of body.row_ids) intents.set(`intent-${id}`, id)
      return Response.json({ data: { items: body.row_ids.map((rowId: string) => ({ row_id: rowId, created: true, intent: { id: `intent-${rowId}` } })) } })
    }
    if (path === route("listingCardsById", { id: "card" })) {
      if (init?.method === "PATCH") card = { ...card, payload: { ...card.payload, ...JSON.parse(String(init.body)).payload }, revision: card.revision + 1 }
      return Response.json({ data: card })
    }
    if (path === route("listingRows")) return Response.json({ data: { items: ids.map(cloudRow), nextCursor: null } })
    if (path.startsWith(`${route("listingRows")}/`)) return Response.json({ data: cloudRow(path.split("/").at(-1)!) })
    if (path === route("listingIntents") && url.searchParams.has("cardId") && firstCancelFails && !cancellationFailed) {
      cancellationFailed = true
      return Response.json({ message: "暂时无法读取 Intent" }, { status: 503 })
    }
    if (path === route("listingIntents")) return Response.json({ data: { items: [...intents].filter(([id]) => !cancelled.has(id)).map(([id, listing_row_id]) => ({ id, listing_row_id, state: "queued" })), next_cursor: null } })
    if (path.endsWith("/cancel")) {
      const id = path.split("/").at(-2)!
      assert.ok(intents.has(id))
      cancelled.add(id)
      return Response.json({ data: { id, state: "queued" } })
    }
    throw new Error(`unexpected request ${url}`)
  }
  const sending = hook.startPublish()
  let stopping = Promise.resolve()
  try {
    await submit.wait(sending)
    assert.equal(submissions, 1)
    let stopped = false
    stopping = hook.stopPublish().then(() => { stopped = true })
    await tick()
    assert.equal(peekListingWorkbench().queuePaused, true, "stop gives immediate feedback")
    assert.equal(stopped, false, "the in-flight submit can still create intents")
    submit.assertUnaborted()
    await Promise.all([hook.startPublish(), hook.resumePublish(), hook.stopPublish()])
    assert.equal(submissions, 1, "repeat controls cannot admit another request while draining")
    release()
    await Promise.all([sending, stopping])
    submit.assertUnaborted()
    assert.equal(cancellationFailed, firstCancelFails, "the initial cancel-read failure control was exercised")
    assert.equal(submissions, 1, "no second chunk is sent after stop")
    assert.deepEqual([...cancelled].sort(), ids.slice(0, 100).map((id) => `intent-${id}`).sort())
    assert.equal(peekListingWorkbench().queuePaused, true)
    assert.equal(peekListingWorkbench().rows.find((row) => row.id === ids[100])?.status, "ready")
  } finally {
    release()
    await Promise.all([sending, stopping])
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})
}

test("stop during direct submission prevents a second send", async () => {
  resetListingWorkbench()
  const row = cloudRow("resume-stop")
  patchListingWorkbench({
    rows: [{ id: row.id, draftId: row.id, imageName: "resume-stop.png", status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
    queueFrozenIds: [row.id], queuePaused: true, queueHaltReason: "reconcile_required",
    productDrafts: { [row.id]: product(row.id) },
  })
  const hook = capturePublishQueue()
  const original = globalThis.fetch
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let submissions = 0
  const submit = observeSubmit([row.id])
  const pauses: boolean[] = []
  let card = { id: "card", revision: 1, payload: nativeCardPayload({ queue: { frozenRowIds: [row.id], paused: true, stopAfterCurrent: false } }), updated_at_ms: 1 }
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname
    if (path === route("listingSubmit")) {
      submissions++
      submit.receive(init)
      await gate
      return Response.json({ data: { items: [{ row_id: row.id, intent: { id: `intent-${row.id}`, submission_receipt: { http_status: 200, raw_response: { accepted: true } } } }] } })
    }
    if (path === route("listingCardsById", { id: "card" })) {
      if (init?.method === "PATCH") {
        card = { ...card, payload: { ...card.payload, ...JSON.parse(String(init.body)).payload }, revision: card.revision + 1 }
        pauses.push(card.payload.queue.paused)
      }
      return Response.json({ data: card })
    }
    if (path === route("listingRows")) return Response.json({ data: { items: [row], nextCursor: null } })
    if (path === route("listingRowsById", { id: row.id })) return Response.json({ data: row })
    if (path === route("listingIntents")) return Response.json({ data: { items: [], nextCursor: null } })
    throw new Error(`unexpected request ${path}`)
  }
  const resuming = hook.resumePublish()
  try {
    await submit.wait(resuming)
    assert.equal(submissions, 1)
    const stopping = hook.stopPublish()
    submit.assertUnaborted()
    release()
    await Promise.all([resuming, stopping])
    assert.equal(submissions, 1)
    submit.assertUnaborted()
    assert.deepEqual(pauses, [false, true], "stop keeps the durable cohort paused")
    assert.equal(peekListingWorkbench().queuePaused, true)
  } finally {
    release()
    await resuming
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

test("stop before autosave settles sends no submit and keeps the row ready", async () => {
  resetListingWorkbench()
  const row = cloudRow("early-stop")
  patchListingWorkbench({
    rows: [{ id: row.id, draftId: row.id, imageName: "early-stop.png", status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
    queueFrozenIds: [row.id], productDrafts: { [row.id]: product(row.id) },
  })
  let release!: () => void
  const flush = new Promise<boolean>((resolve) => { release = () => resolve(true) })
  let flushEntered = false, submissions = 0
  const hook = capturePublishQueue({ flushAutosave: () => { flushEntered = true; return flush } })
  const original = globalThis.fetch
  let card = { id: "card", revision: 1, payload: nativeCardPayload({ queue: { frozenRowIds: [row.id], paused: false, stopAfterCurrent: false } }), updated_at_ms: 1 }
  globalThis.fetch = async (input, init) => {
    const path = new URL(String(input), "http://localhost").pathname
    if (path === route("listingSubmit")) { submissions++; throw new Error("early Stop must not submit") }
    if (path === route("listingCardsById", { id: "card" })) {
      if (init?.method === "PATCH") card = { ...card, payload: { ...card.payload, ...JSON.parse(String(init.body)).payload }, revision: card.revision + 1 }
      return Response.json({ data: card })
    }
    if (path === route("listingIntents")) return Response.json({ data: { items: [], nextCursor: null } })
    throw new Error(`unexpected request ${path}`)
  }
  const sending = hook.startPublish()
  let stopping = Promise.resolve()
  try {
    assert.equal(flushEntered, true, "the send is observably waiting at autosave")
    stopping = hook.stopPublish()
    assert.equal(peekListingWorkbench().queuePaused, true)
    release()
    await Promise.all([sending, stopping])
    assert.equal(submissions, 0)
    assert.equal(peekListingWorkbench().rows[0]?.status, "ready")
    assert.equal(peekListingWorkbench().queuePaused, true)
  } finally {
    release()
    await Promise.allSettled([sending, stopping])
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

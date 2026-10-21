/** Real Hook callbacks, command adapters and HTTP boundaries. SSR supplies React's
 * refs; these checks cover explicit actions, not mounted effects or rerenders. */
import assert from "node:assert/strict"
import test, { before } from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import { forgetListingRows } from "@/bindings/listing-row-cache"
import {
  invalidateAccountOverview,
  rememberAccountOverview,
} from "@/features/account/account-overview-cache"
import type { ListingRow } from "../model/listing-row"
import { createPreparationTracks } from "../prepare/preparation-tracks"
import { nativeCardPayload, warmProductionSend } from "../submit/send-test-support"
import { usePublishQueue } from "../submit/use-publish-queue"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { cloudRow, product, SIGNED_IN } from "./fixtures"
import { capturePublishQueue } from "./publish-queue-harness"

function isolateRowCache(ids: readonly string[]): void {
  forgetListingRows(ids)
}

// The send rail freezes through the real native core against resident material.
before(warmProductionSend)


test("a real send callback refreshes rows within the read budget", async () => {
  resetListingWorkbench()
  isolateRowCache(['a', 'b', 'row-fail', 'supplier-ready', 'row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6'])
  rememberAccountOverview(SIGNED_IN)
  const rows = Array.from({ length: 7 }, (_, i): ListingRow => ({
    id: `row-${i}`, draftId: `row-${i}`, imageName: `offer-${i}.png`,
    status: "ready", ai: "done", render: "done", upload: "done", log: "before",
  }))
  patchListingWorkbench({ rows, queueFrozenIds: rows.map((row) => row.draftId),
    productDrafts: Object.fromEntries(rows.map((row) => [row.draftId, product(row.draftId)])),
  })
  let hook!: ReturnType<typeof usePublishQueue>
  function Capture() {
    hook = usePublishQueue({
      cardTemplateId: "card", busy: false, storeConfigured: true,
      preparationTracks: { current: createPreparationTracks() },
      guidedPreparationLock: { current: false },
      flushAutosave: async () => true, flushAutosavesFor: async () => true,
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  let submitted = false
  let active = 0
  let peak = 0
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    let data: unknown
    if (url === route("listingSubmit")) {
      const body = JSON.parse(String(init?.body))
      assert.deepEqual(body.row_ids, rows.map((row) => row.draftId))
      submitted = true
      entered()
      await held
      data = { items: body.row_ids.map((rowId: string) => ({
        row_id: rowId,
        created: true,
        intent: {
          id: rowId,
          submission_receipt: { http_status: 200, raw_response: { accepted: true } },
        },
      })) }
    } else if (url === route("listingCardsById", { id: "card" })) {
      data = { id: "card", revision: 1, payload: nativeCardPayload(), updated_at_ms: 1 }
    } else if (url.startsWith(`${route("listingRows")}/`) || url.startsWith(`${route("listingIntents")}?`)) {
      if (submitted) {
        active += 1
        peak = Math.max(peak, active)
        await held
        active -= 1
      }
      if (url.startsWith(`${route("listingIntents")}?`)) data = { items: [] }
      else {
        const id = url.split("/").at(-1)!
        data = cloudRow(id)
      }
    } else throw new Error(`unexpected request ${url}`)
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
  }
  const sending = hook.startPublish()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    try {
      await Promise.race([started, sending.then(() => assert.fail("send settled before the actual submit")),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("submit boundary not reached within 3 seconds")), 3000) })])
    } finally { clearTimeout(timer) }
    assert.equal(submitted, true, "the actual send request was accepted")
    assert.equal(active, 0, "receipt-only submission performs no projected row reads")
    release()
    await sending
    assert.equal(peak, 0, "receipt-only submission never refreshes rows")
    assert.ok(peekListingWorkbench().rows.every((row) => row.log === "已取得发送响应"))
  } finally {
    release()
    await sending
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

test("send click immediately sets optimistic running status and reflects writeback upon response", async () => {
  resetListingWorkbench()
  isolateRowCache(['a', 'b', 'row-fail', 'supplier-ready', 'row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6'])
  rememberAccountOverview(SIGNED_IN)
  const rows = Array.from({ length: 3 }, (_, i): ListingRow => ({
    id: `row-${i}`, draftId: `row-${i}`, imageName: `offer-${i}.png`,
    status: "ready", ai: "done", render: "done", upload: "done", log: "",
  }))
  patchListingWorkbench({
    rows,
    queueFrozenIds: rows.map((row) => row.draftId),
    productDrafts: Object.fromEntries(rows.map((row) => [row.draftId, product(row.draftId)])),
  })
  let hook!: ReturnType<typeof usePublishQueue>
  function Capture() {
    hook = usePublishQueue({
      cardTemplateId: "card", busy: false, storeConfigured: true,
      preparationTracks: { current: createPreparationTracks() },
      guidedPreparationLock: { current: false },
      flushAutosave: async () => true, flushAutosavesFor: async () => true,
    })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  let submitResolve!: () => void
  const submitGate = new Promise<void>((resolve) => { submitResolve = resolve })
  const original = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url === route("listingSubmit")) {
      await submitGate
      return Response.json({
        data: {
          items: [
            { row_id: "row-0", created: true, intent: { id: "intent-0" } },
            { row_id: "row-1", created: true, intent: { id: "intent-1" } },
            { row_id: "row-2", created: false, skipped: "blocked", blockers: ["rule_violation"] },
          ],
        },
      })
    }
    if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload(), updated_at_ms: 1 } })
    if (url.startsWith(`${route("listingRows")}/`)) {
      const id = url.split("/").at(-1)!
      return Response.json({ data: cloudRow(id) })
    }
    if (url.startsWith(`${route("listingIntents")}?`)) return Response.json({ data: { items: [] } })
    throw new Error(`unexpected request ${url}`)
  }
  const sending = hook.startPublish()
  try {
    await tick()
    // 1. Optimistic feedback must be visible IMMEDIATELY while request is in-flight:
    const inFlightState = peekListingWorkbench()
    assert.equal(inFlightState.queueRunning, true, "queueRunning must be true immediately on send")
    assert.equal(hook.submissionPending(), true, "must wait for the submission receipt before leaving")
    assert.ok(inFlightState.rows.every((row) => row.status === "running" && row.log === "正在提交发送..."), "rows must reflect in-flight status")
    assert.ok(Object.values(inFlightState.productDrafts).every((d) => d.lifecycle.stage === "submitting"), "drafts must optimistically be publishing")

    // Concurrent send attempt while in flight must be ignored (no duplicate submission)
    await hook.startPublish()

    submitResolve()
    await sending
    assert.equal(hook.submissionPending(), false, "receipt releases the navigation guard")

    // 2. Status write-back is promptly reflected:
    const settled = peekListingWorkbench()
    const row0 = settled.rows.find((r) => r.id === "row-0")!
    const row1 = settled.rows.find((r) => r.id === "row-1")!
    const row2 = settled.rows.find((r) => r.id === "row-2")!
    assert.equal(row0.log, "发送状态已刷新")
    assert.equal(row1.log, "发送状态已刷新")
    assert.match(row2.log, /当前状态不允许执行|不能发送/)
  } finally {
    submitResolve()
    await sending
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

test("send network failure resets queueRunning and reverts in-flight row state", async () => {
  resetListingWorkbench()
  isolateRowCache(['a', 'b', 'row-fail', 'supplier-ready', 'row-0', 'row-1', 'row-2', 'row-3', 'row-4', 'row-5', 'row-6'])
  rememberAccountOverview(SIGNED_IN)
  const rows = [
    { id: "row-fail", draftId: "row-fail", imageName: "fail.png", status: "ready" as const, ai: "done" as const, render: "done" as const, upload: "done" as const, log: "" },
  ]
  patchListingWorkbench({
    rows,
    queueFrozenIds: ["row-fail"],
    productDrafts: { "row-fail": product("row-fail") },
  })
  const hook = capturePublishQueue()
  let submitted = false
  let submissions = 0
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const responseGate = new Promise<void>((resolve) => { release = resolve })
  const calls: string[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${url}`)
    if (url === route("listingSubmit")) {
      assert.deepEqual(JSON.parse(String(init?.body)), { store_id: "store", row_ids: ["row-fail"],
        expected_revisions: [{ row_id: "row-fail", revision: 1 }] })
      submitted = true; submissions++; entered()
      await responseGate
      return new Response(JSON.stringify({ message: "Cloud error" }), { status: 500, headers: { "Content-Type": "application/json" } })
    }
    if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload(), updated_at_ms: 1 } })
    if (url === route("listingRowsById", { id: "row-fail" }) && !submitted) return Response.json({ data: cloudRow("row-fail") })
    throw new Error(`unexpected request ${url}`)
  }
  const sending = hook.startPublish()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    try {
      await Promise.race([started, sending.then(() => assert.fail("send settled before the actual submit")),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("submit boundary not reached within 3 seconds")), 3000) })])
    } finally { clearTimeout(timer) }
    assert.equal(submitted, true, "failure must occur after native preflight and actual dispatch")
    assert.equal(hook.submissionPending(), true)
    await hook.startPublish()
    assert.equal(submissions, 1, "an in-flight duplicate click never submits again")
    release()
    await sending
    const state = peekListingWorkbench()
    assert.equal(state.queueRunning, false, "queueRunning must reset to false on failure")
    assert.equal(state.rows[0]?.stage, "outcome_unknown")
    assert.equal(state.rows[0]?.publishUnconfirmed, true)
    assert.equal(state.productDrafts["row-fail"]?.lifecycle.stage, "outcome_unknown")
    assert.equal(state.productDrafts["row-fail"]?.target_store_id, "store")
    assert.deepEqual(state.queueFrozenIds, ["row-fail"])
    const callsAtUnknown = calls.length
    await hook.startPublish()
    await hook.resumePublish()
    assert.equal(calls.length, callsAtUnknown, "unknown forbids implicit retry or readback")
    assert.equal(submissions, 1)
    assert.equal(peekListingWorkbench().rows[0]?.publishUnconfirmed, true)
    assert.equal(state.rows[0]?.log, "本次发送结果未确认；核对原平台、原店铺的确切 Intent 和平台记录；不要重复发送。")
    assert.notEqual(state.rows[0]?.status, "failed", "an unobserved send is unconfirmed, not failed")
    assert.equal(state.rows[0]?.status, "exception", "the unknown lifecycle remains distinct from confirmed failure")
  } finally {
    release()
    await sending
    globalThis.fetch = original
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

for (const verified of [true, false]) {
  test(`supplier send ${verified ? "verifies media before enqueueing" : "stops when media verification fails"}`, async () => {
    resetListingWorkbench()
    const row = cloudRow("supplier-ready")
    patchListingWorkbench({
      rows: [{ id: row.id, draftId: row.id, imageName: `${row.id}.png`,
        status: "ready", ai: "done", render: "done", upload: "done", log: "" }],
      queueFrozenIds: [row.id], productDrafts: { [row.id]: product(row.id) },
    })
    const hook = capturePublishQueue({ supplierProductId: "supplier-1" })
    const original = globalThis.fetch
    const writes: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === route("mediaSupplierProductsByProductIdVerify", { product_id: "supplier-1" })) {
        writes.push("verify")
        assert.equal(init?.method, "POST")
        if (!verified) throw new Error("供应商视频不可访问")
        return Response.json({ data: {} })
      }
      if (url === route("listingCardsById", { id: "card" })) {
        if (init?.method === "PATCH") writes.push("queue")
        // The session's own verify gate reads `payload.supplierProductId`
        // off this Card, not off the hook's prop — a real supplier-bound
        // Card carries it here.
        return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload({ supplierProductId: "supplier-1" }), updated_at_ms: 1 } })
      }
      if (url === route("listingSubmit")) {
        writes.push("submit")
        return Response.json({ data: { items: [{ row_id: row.id, created: true, intent: { id: "intent" } }] } })
      }
      if (url === route("listingRowsById", { id: row.id })) return Response.json({ data: row })
      if (url.startsWith(`${route("listingIntents")}?`)) return Response.json({ data: { items: [] } })
      throw new Error(`unexpected request ${url}`)
    }
    try {
      await hook.startPublish([row.id])
      assert.deepEqual(writes, verified ? ["verify", "queue", "submit"] : ["verify"])
      if (!verified) {
        assert.equal(peekListingWorkbench().queueRunning, false)
        assert.equal(peekListingWorkbench().rows[0]?.status, "ready")
        assert.equal(peekListingWorkbench().rows[0]?.upload, "done")
      }
    } finally {
      globalThis.fetch = original
      invalidateAccountOverview()
      resetListingWorkbench()
    }
  })
}

for (const sameStore of [false, true]) {
  test(`send ${sameStore ? "rejects same-Store" : "allows cross-Store"} matching offers`, async () => {
    resetListingWorkbench()
    isolateRowCache(["a", "b"])
    const cloudRows = ["a", "b"].map((id, i) => ({
      ...cloudRow(id), store_id: sameStore ? "store-a" : `store-${id}`,
      draft: { values: { offer_id: { kind: "text" as const, value: sameStore && i ? " shared " : "shared" } }, complex_values: [] },
    }))
    patchListingWorkbench({
      rows: cloudRows.map((row): ListingRow => ({ id: row.id, draftId: row.id, imageName: `${row.id}.png`,
        status: "ready", ai: "done", render: "done", upload: "done", log: "" })),
      queueFrozenIds: ["a", "b"],
      productDrafts: Object.fromEntries(cloudRows.map((row) => [row.id, {
        ...product(row.id), target_store_id: row.store_id, draft: row.draft,
      }])),
    })
    const hook = capturePublishQueue()
    const original = globalThis.fetch
    const submissions: { store_id: string, row_ids: string[] }[] = []
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === route("listingSubmit")) {
        const body = JSON.parse(String(init?.body))
        submissions.push({ store_id: body.store_id, row_ids: body.row_ids })
        return Response.json({ data: { items: body.row_ids.map((rowId: string) => ({ row_id: rowId, created: true, intent: { id: rowId } })) } })
      }
      if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: { id: "card", revision: 1, payload: nativeCardPayload({ targetStoreId: [...new Set(cloudRows.map((row) => row.store_id))].join(",") }), updated_at_ms: 1 } })
      if (url.startsWith(`${route("listingRows")}/`)) return Response.json({ data: cloudRows.find((row) => row.id === url.split("/").at(-1)) })
      if (url.startsWith(`${route("listingIntents")}?`)) return Response.json({ data: { items: [] } })
      throw new Error(`unexpected request ${url}`)
    }
    try {
      await hook.startPublish()
      assert.deepEqual(submissions.sort((a, b) => a.store_id.localeCompare(b.store_id)), sameStore ? [] : [
        { store_id: "store-a", row_ids: ["a"] }, { store_id: "store-b", row_ids: ["b"] },
      ])
    } finally {
      globalThis.fetch = original
      invalidateAccountOverview()
      resetListingWorkbench()
    }
  })
}

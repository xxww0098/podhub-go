/** Actual hook, native core and HTTP rail with deterministic retirement boundaries. */
import assert from "node:assert/strict"
import test, { afterEach, beforeEach } from "node:test"
import { route } from "@/api/routes"
import { cachedListingRow } from "@/bindings/listing-row-cache"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { cloudRow, product, SIGNED_IN } from "../cloud-fanout-tests/fixtures"
import { capturePublishQueue } from "../cloud-fanout-tests/publish-queue-harness"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { defaultSendCore } from "./send-native"
import { nativeCardPayload, residentRows, resetSendState, serve, warmProductionSend, type SendCall } from "./send-test-support"

beforeEach(async () => { resetSendState(); await warmProductionSend() })
afterEach(resetSendState)

function gate() {
  let enter!: () => void, release!: () => void
  return { started: new Promise<void>((resolve) => { enter = resolve }),
    held: new Promise<void>((resolve) => { release = resolve }), enter: () => enter(), release: () => release() }
}

async function waitFor(started: Promise<void>, running: Promise<void>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([started, running.then(() => assert.fail("publish returned before the controlled boundary")),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("publish boundary timeout")), 3000) })])
  } finally { clearTimeout(timer) }
}

function fixture(options: Parameters<typeof capturePublishQueue>[0] = {}) {
  const hook = capturePublishQueue(options), raw = cloudRow("retired-row")
  residentRows([raw])
  patchListingWorkbench({ cardId: "card", rows: [{ id: raw.id, draftId: raw.id, imageName: raw.source.fileName,
    status: "ready", stage: "ready_to_publish", ai: "done", render: "done", upload: "done", log: "before" }],
    productDrafts: { [raw.id]: product(raw.id) }, queueFrozenIds: [raw.id] })
  const answer = (call: SendCall) => {
    if (call.url === route("listingCardsById", { id: "card" })) return {
      id: "card", revision: call.method === "PATCH" ? 2 : 1, storeId: "store", title: "Test",
      payload: call.method === "PATCH" ? call.body.payload : nativeCardPayload(), updatedAtMs: 1,
    }
    if (call.url.startsWith(`${route("listingRows")}?`)) return { items: [raw], nextCursor: null }
    throw new Error(`unexpected request ${call.method} ${call.url}`)
  }
  return { hook, raw, answer }
}

test("a replaced workbench cannot dispatch its old rows after native loading resumes", async () => {
  const fx = fixture(), boundary = gate(), core = defaultSendCore(), loadSchema = core.loadSchema
  core.loadSchema = async (...args) => {
    const handle = await loadSchema.apply(core, args)
    boundary.enter()
    await boundary.held
    return handle
  }
  const cloud = serve((call) => call.url === route("listingSubmit")
    ? Response.json({ code: "permission_denied" }, { status: 403 }) : fx.answer(call))
  const running = fx.hook.startPublish([fx.raw.id])
  try {
    await waitFor(boundary.started, running)
    resetListingWorkbench()
    patchListingWorkbench({ cardId: "replacement", rows: [{ id: "new-row", draftId: "new-row", imageName: "new.png",
      status: "ready", ai: "done", render: "done", upload: "done", log: "new-workbench" }], productDrafts: { "new-row": product("new-row") } })
    const replacement = peekListingWorkbench()
    boundary.release()
    await running
    assert.deepEqual(peekListingWorkbench(), replacement)
    assert.equal(cloud.calls.filter((call) => call.url === route("listingSubmit")).length, 0)
  } finally { boundary.release(); await running; core.loadSchema = loadSchema; cloud.restore() }
})

test("a session retired during autosave never reaches a queue save or submit in the replacement session", async () => {
  const boundary = gate()
  const fx = fixture({ flushAutosavesFor: async () => { boundary.enter(); await boundary.held; return true } })
  const cloud = serve(fx.answer)
  const running = fx.hook.startPublish([fx.raw.id])
  try {
    await waitFor(boundary.started, running)
    invalidateAllSessionCaches()
    rememberAccountOverview(SIGNED_IN)
    const retired = peekListingWorkbench()
    boundary.release()
    await running
    assert.equal(cloud.calls.length, 0, "a new authenticated session cannot revive the old click")
    assert.deepEqual(peekListingWorkbench(), retired)
  } finally { boundary.release(); await running; cloud.restore() }
})

test("an already dispatched receipt settles without repainting a retired session", async () => {
  const fx = fixture(), boundary = gate()
  let signal: AbortSignal | undefined, bodyRead = false
  const cloud = serve((call) => {
    if (call.url !== route("listingSubmit")) return fx.answer(call)
    const response = Response.json({ data: { items: [{ row_id: fx.raw.id, created: true,
      row: { ...fx.raw, view_revision: 2, projection: listingProjection({ stage: "accepted" }) },
      intent: { id: "accepted-intent", external_task_id: "42", submission_receipt: { batch_id: "accepted-batch",
        item_count: 1, http_status: 200, response_body: "accepted", received_at_ms: 1 } },
    }] } })
    const text = response.text.bind(response)
    response.text = async () => { boundary.enter(); await boundary.held; bodyRead = true; return text() }
    return response
  })
  const fetchCloud = globalThis.fetch
  globalThis.fetch = (input, init) => {
    if (String(input) === route("listingSubmit")) signal = init?.signal ?? undefined
    return fetchCloud(input, init)
  }
  const running = fx.hook.startPublish([fx.raw.id])
  try {
    await waitFor(boundary.started, running)
    invalidateAllSessionCaches()
    const retired = peekListingWorkbench()
    boundary.release()
    await running
    assert.equal(bodyRead, true)
    assert.ok(signal)
    assert.equal(signal.aborted, false, "session retirement does not abort a request that may have landed")
    assert.equal(cloud.calls.filter((call) => call.url === route("listingSubmit")).length, 1)
    assert.equal(cachedListingRow(fx.raw.id), undefined)
    assert.deepEqual(peekListingWorkbench(), retired, "normal response settlement honors the session fence too")
  } finally { boundary.release(); await running; cloud.restore() }
})

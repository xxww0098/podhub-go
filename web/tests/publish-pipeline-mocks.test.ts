/** The browser fixture's actual responses must survive the production HTTP decoders. */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import type { RequestEvidence } from "@/api/client-options"
import { route } from "@/api/routes"
import { readListingIntents } from "@/bindings/http-listing-intents"
import { submitListingDrafts, type DraftSubmitRequest } from "@/bindings/http-listing-submit"
import type { CategorySchemaSnapshot } from "@/listing-core/types"
import type { FixtureMode } from "./publish-pipeline-mocks"
import schemaJson from "./fixtures/listing-core/decorative-wall-art-schema.json"

// The browser metrics install a readonly getter at import time. Keep that and
// passive listeners off the process's real globals after loading the fixture.
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
const [mocksModule, metrics] = await Promise.all([import("./publish-pipeline-mocks"), import("./publish-pipeline-metrics")]).finally(() => {
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow)
  else Reflect.deleteProperty(globalThis, "window")
})
const schema = schemaJson as unknown as CategorySchemaSnapshot
const body: DraftSubmitRequest = { card_id: "fixture-card", store_id: "fixture-a",
  items: [{ rowId: "fixture-row", schemaRevision: schema.schema_revision }] }

function fixture(mode: FixtureMode) {
  const fetch = globalThis.fetch, location = Object.getOwnPropertyDescriptor(globalThis, "location")
  Object.defineProperty(globalThis, "location", { configurable: true, value: new URL("http://127.0.0.1:14921/tests/publish-pipeline.html") })
  const start = metrics.evidenceSnapshot().business.length
  const mocks = mocksModule.installPipelineMocks(schema)
  mocks.select(mode)
  const received: { method: string; url: string; body?: string; signal?: AbortSignal | null }[] = []
  const mockedFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    received.push({ method: init?.method ?? "GET", url: String(input), body: typeof init?.body === "string" ? init.body : undefined, signal: init?.signal })
    return mockedFetch(input, init)
  }
  return { mocks, received, events: () => metrics.evidenceSnapshot().business.slice(start), restore() {
    mocks.release()
    globalThis.fetch = fetch
    if (location) Object.defineProperty(globalThis, "location", location)
    else Reflect.deleteProperty(globalThis, "location")
  } }
}

test("accepted browser mock output passes the real Draft decoder with exact request evidence", async () => {
  const fx = fixture("accepted"), observed: RequestEvidence[] = []
  try {
    const result = await submitListingDrafts(body, Date.now() + 150_000, (evidence) => observed.push(evidence))
    assert.deepEqual(Object.keys(result).sort(), ["items", "server_schema_revision"])
    assert.equal(result.server_schema_revision, schema.schema_revision)
    assert.deepEqual(Object.keys(result.items[0]!).sort(), ["intent", "outcome", "row_id"])
    assert.deepEqual([result.items[0]!.row_id, result.items[0]!.outcome], ["fixture-row", "created"])
    assert.deepEqual([result.items[0]!.intent!.state, result.items[0]!.intent!.external_task_id], ["accepted", "42"])
    assert.deepEqual(observed, [{ jsonText: JSON.stringify(body), traceId: null }])
    assert.equal(fx.received.length, 1)
    assert.equal(fx.received[0]!.body, observed[0]!.jsonText)
    assert.deepEqual(fx.events().map(({ event, status }) => [event, status]), [["dispatch", undefined], ["response", 200]])
  } finally { fx.restore() }
})

for (const mode of ["schema", "media"] as const) {
  test(`${mode} repair mock exposes its typed skip and only retries on the next explicit submit`, async () => {
    const fx = fixture(mode)
    try {
      const refused = await submitListingDrafts(body)
      assert.deepEqual(refused.items, [{ row_id: "fixture-row", outcome: "skipped", skip_reason: mode === "schema" ? "schema_stale" : "media_expired" }])
      assert.equal(fx.received.length, 1, "the binding must not turn a skip into an automatic replay")
      const accepted = await submitListingDrafts(body)
      assert.equal(accepted.items[0]!.intent!.state, "accepted")
      assert.equal(fx.received.length, 2)
      assert.ok(fx.received.every((request) => request.method === "POST" && request.body === JSON.stringify(body)))
    } finally { fx.restore() }
  })
}

test("the empty browser Intent page preserves its explicit terminal cursor through the real decoder", async () => {
  const fx = fixture("accepted")
  try {
    assert.deepEqual(await readListingIntents("fixture-a", { rowIds: ["not-submitted"] }), { items: [], next_cursor: null })
    assert.equal(fx.received.length, 1)
    assert.equal(fx.received[0]!.method, "GET")
  } finally { fx.restore() }
})

test("pending browser submission reads back as accepted with its real task id without another submit", async () => {
  const fx = fixture("reconcile-pending-200")
  try {
    // Continue through readback even if submit validation fails, so this test
    // independently exposes a read response that puts the task in an old key.
    const submitted = await submitListingDrafts(body).then((value) => ({ value }), (error: unknown) => ({ error }))
    const page = await readListingIntents("fixture-a", { intentIds: ["fixture-intent-fixture-row"] })
    assert.deepEqual(page.items.map((intent) => [intent.id, intent.state, intent.external_task_id]),
      [["fixture-intent-fixture-row", "accepted", "42"]])
    assert.equal(page.next_cursor, null)
    assert.equal(Object.hasOwn(page.items[0]!, "externalTaskId"), false)
    if ("error" in submitted) throw submitted.error
    assert.deepEqual([submitted.value.items[0]!.intent!.state, submitted.value.items[0]!.intent!.external_task_id], ["queued", ""])
    assert.deepEqual(fx.received.map((request) => request.method), ["POST", "GET"])
  } finally { fx.restore() }
})

test("lost browser submit response keeps exact evidence and recovers only through a history GET", async () => {
  const fx = fixture("reconcile-lost-history"), observed: RequestEvidence[] = []
  try {
    await assert.rejects(submitListingDrafts(body, Date.now() + 150_000, (evidence) => observed.push(evidence)), { code: "cloud_unavailable" })
    assert.deepEqual(observed, [{ jsonText: JSON.stringify(body), traceId: null }])
    assert.equal(fx.received.length, 1, "a possibly committed submit is never repeated by the binding")
    const recovered = await readListingIntents("fixture-a", { rowIds: ["fixture-row"] })
    assert.equal(recovered.next_cursor, null)
    assert.deepEqual(recovered.items.map((intent) => [intent.id, intent.state, intent.external_task_id]),
      [["fixture-intent-fixture-row", "accepted", "42"]])
    assert.deepEqual(fx.received.map((request) => request.method), ["POST", "GET"])
    assert.equal(fx.received[0]!.url, route("listingSubmit"))
  } finally { fx.restore() }
})

async function waitForHeld(fx: ReturnType<typeof fixture>) {
  const deadline = Date.now() + 3000
  while (!fx.events().some((event) => event.event === "held")) {
    assert.ok(Date.now() < deadline, "mock did not reach its controlled response hold")
    await tick()
  }
}

for (const expire of [false, true]) {
  test(`a held browser response ${expire ? "honors the original deadline without retry" : "settles accepted when explicitly released"}`, async () => {
    const fx = fixture("stop"), observed: RequestEvidence[] = [], set = globalThis.setTimeout
    let deadline: (() => void) | undefined, deadlines = 0
    globalThis.setTimeout = new Proxy(set, { apply(target, receiver, args) {
      if (args[1] > 149_000 && args[1] <= 150_000) { deadlines++; deadline = () => Reflect.apply(args[0], undefined, args.slice(2)) }
      return Reflect.apply(target, receiver, args)
    } })
    const pending = submitListingDrafts(body, Date.now() + 150_000, (evidence) => observed.push(evidence))
      .then((value) => ({ value }), (error: unknown) => ({ error }))
    try {
      await waitForHeld(fx)
      assert.equal(deadlines, 1)
      assert.ok(deadline)
      assert.equal(observed.length, 0)
      assert.equal(fx.received[0]!.signal!.aborted, false)
      if (expire) deadline()
      else fx.mocks.release()
      const settled = await pending
      if (expire) {
        assert.ok("error" in settled)
        assert.equal((settled.error as { code: string }).code, "cloud_unavailable")
      } else {
        if ("error" in settled) throw settled.error
        assert.equal(settled.value.items[0]!.intent!.state, "accepted")
      }
      assert.equal(fx.received[0]!.signal!.aborted, expire)
      assert.equal(fx.received.length, 1)
      assert.equal(deadlines, 1)
      assert.deepEqual(observed, [{ jsonText: JSON.stringify(body), traceId: null }])
    } finally { fx.mocks.release(); await pending; globalThis.setTimeout = set; fx.restore() }
  })
}

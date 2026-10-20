import assert from "node:assert/strict"
import test from "node:test"
import { request } from "./client"
import type { RequestEvidence } from "./client-options"
import { route } from "./routes"

test("the actual fetch dispatch port runs synchronously after serialization and before fetch; observer throws change neither bytes nor result", async () => {
  const before = globalThis.fetch
  const order: string[] = [], evidence: RequestEvidence[] = []
  let serializations = 0, actual: unknown
  const body = { toJSON() { serializations++; order.push("serialize"); return { name: "private exact body", serializations } } }
  globalThis.fetch = async (_url, init) => {
    order.push("fetch")
    actual = init?.body
    assert.equal(serializations, 1)
    return Response.json({ data: { accepted: true } }, { headers: { "x-request-id": "actual-trace" } })
  }
  try {
    const value = await request("POST", route("listingSubmit"), body, {}, 150_000, undefined, {
      reportOwner: "caller", onDispatch() { order.push("dispatch"); throw new Error("private observer exception") },
      onEvidence(value) { evidence.push(value); order.push("evidence") },
    })
    assert.deepEqual(value, { accepted: true })
    assert.deepEqual(order, ["serialize", "dispatch", "fetch", "evidence"])
    assert.deepEqual(evidence, [{ jsonText: actual, traceId: "actual-trace" }])
    assert.equal(serializations, 1)
  } finally { globalThis.fetch = before }
})

test("serialization failure never invokes dispatch or invents exact submitted bytes", async () => {
  const before = globalThis.fetch
  let calls = 0, dispatches = 0
  const evidence: RequestEvidence[] = []
  globalThis.fetch = async () => { calls++; throw new Error("must not fetch") }
  try {
    await assert.rejects(request("POST", route("listingSubmit"), { toJSON() { throw new Error("cannot serialize") } }, {}, 150_000, undefined,
      { reportOwner: "caller", onDispatch() { dispatches++ }, onEvidence(value) { evidence.push(value) } }))
    assert.equal(calls, 0)
    assert.equal(dispatches, 0)
    assert.deepEqual(evidence, [{ jsonText: null, traceId: null }])
  } finally { globalThis.fetch = before }
})

test("an already cancelled request cannot invoke the dispatch port; its existing abort failure is preserved", async () => {
  const original = globalThis.fetch, controller = new AbortController()
  let dispatches = 0, calls = 0
  controller.abort()
  globalThis.fetch = async (_url, init) => {
    calls++
    assert.equal(init?.signal?.aborted, true)
    throw new DOMException("request already aborted", "AbortError")
  }
  try {
    await assert.rejects(request("POST", route("listingSubmit"), { name: "private original" }, {}, 150_000, undefined,
      { reportOwner: "caller", callerSignal: controller.signal, onDispatch() { dispatches++ } }),
      (failure: unknown) => failure instanceof Error && "code" in failure && failure.code === "cloud_unavailable")
    assert.equal(dispatches, 0)
    assert.equal(calls, 1, "the observer adds no new transport or cancellation behavior")
  } finally { globalThis.fetch = original }
})

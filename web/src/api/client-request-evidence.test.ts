import assert from "node:assert/strict"
import test from "node:test"
import { request } from "./client"
import type { RequestEvidence } from "./client-options"
import { route } from "./routes"

const endpoint = route("listingSubmit")

async function withFetch(next: typeof fetch, run: (calls: string[]) => Promise<void>) {
  const original = globalThis.fetch
  const calls: string[] = []
  globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    assert.equal(String(input), endpoint, "no eventsInbox, retries or other requests")
    return next(input, init)
  }
  try { await run(calls) } finally { globalThis.fetch = original }
}

test("request evidence reuses the exact Unicode JSON body without clipping or a second toJSON call", async () => {
  const payload = { note: "  前 后 \n\t雪😀  ", detail: " 原文雪😀 ".repeat(50_000) }
  const expected = JSON.stringify(payload)
  let serializations = 0
  const body = { toJSON() { serializations++; return payload } }
  const observed: RequestEvidence[] = []
  let submitted: string | undefined
  await withFetch(async (_input, init) => {
    assert.ok(init)
    assert.equal(init.method, "POST")
    assert.equal(init.credentials, "include")
    assert.deepEqual(init.headers, { "Content-Type": "application/json", "Idempotency-Key": "fixture-operation" })
    assert.equal(typeof init.body, "string")
    submitted = String(init.body)
    return Response.json({ data: { accepted: true } }, { headers: { "x-request-id": "http-trace" } })
  }, async (calls) => {
    const value = await request("POST", endpoint, body, { "Idempotency-Key": "fixture-operation" }, undefined, undefined,
      { reportOwner: "caller", onEvidence: (evidence) => observed.push(evidence) })
    assert.deepEqual(value, { accepted: true })
    assert.equal(serializations, 1)
    assert.equal(submitted, expected)
    assert.deepEqual(observed, [{ jsonText: submitted, traceId: "http-trace" }])
    assert.ok(new TextEncoder().encode(observed[0]!.jsonText!).byteLength > 256 * 1024, "full evidence must survive former clipping sizes")
    assert.deepEqual(new TextEncoder().encode(observed[0]!.jsonText!), new TextEncoder().encode(expected))
    assert.deepEqual(Object.keys(observed[0]!).sort(), ["jsonText", "traceId"], "no URL, headers, response body, error or stack")
    assert.equal(Object.isFrozen(observed[0]), true)
    assert.equal(Reflect.set(observed[0]!, "traceId", "changed"), false)
    assert.equal(calls.length, 1)
  })
})

test("request evidence is emitted after body consumption and before promise settlement", async () => {
  let release!: () => void, reading!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { reading = resolve })
  const order: string[] = []
  const observed: RequestEvidence[] = []
  const response = Response.json({ data: "accepted" }, { headers: { "x-request-id": "header-trace" } })
  const text = response.text.bind(response)
  response.text = async () => { reading(); await held; order.push("body"); return text() }
  await withFetch(async () => response, async (calls) => {
    try {
      const pending = request("POST", endpoint, { value: "fixture" }, {}, undefined, undefined, {
        reportOwner: "caller", onEvidence: (evidence) => { order.push("evidence"); observed.push(evidence) },
      }).then((value) => { order.push("settled"); return value })
      await started
      assert.deepEqual(observed, [], "headers alone do not settle the request")
      release()
      assert.equal(await pending, "accepted")
      assert.deepEqual(order, ["body", "evidence", "settled"])
      assert.equal(observed.length, 1)
      assert.deepEqual(observed[0], { jsonText: '{"value":"fixture"}', traceId: "header-trace" })
      assert.equal(calls.length, 1)
    } finally { release() }
  })
})

test("HTTP evidence uses x-request-id while OCR recovery keeps its separate business requestId", async () => {
  const observed: RequestEvidence[] = []
  await withFetch(async () => Response.json({ code: "OCR_BUSY", message: "fixture refusal", ocrRecovery: { requestId: "ocr-business-id" } },
    { status: 409, headers: { "x-request-id": "http-id", "Retry-After": "5" } }), async (calls) => {
    await assert.rejects(request("POST", endpoint, { source: "fixture" }, {}, undefined, undefined,
      { reportOwner: "caller", onEvidence: (evidence) => observed.push(evidence) }), (reason: unknown) => {
      assert.ok(reason instanceof Error)
      assert.equal(Reflect.get(reason, "code"), "cloud_ocr_busy")
      assert.equal(Reflect.get(reason, "requestId"), "ocr-business-id")
      assert.equal(Reflect.get(reason, "traceId"), "http-id")
      assert.equal(Reflect.get(reason, "serverCode"), "OCR_BUSY")
      assert.equal(Reflect.get(reason, "status"), 409)
      assert.equal(Reflect.get(reason, "retryAfterMs"), 5000)
      assert.deepEqual(observed, [{ jsonText: '{"source":"fixture"}', traceId: "http-id" }])
      return true
    })
    assert.equal(calls.length, 1)
  })
})

for (const [name, response] of [
  ["malformed JSON", () => new Response("{invalid private response", { headers: { "x-request-id": "bad-json" } })],
  ["missing data envelope", () => Response.json({ privateResponse: "not evidence" }, { headers: { "x-request-id": "bad-envelope" } })],
] as const) {
  test(`${name} still emits submitted request evidence once before rejection`, async () => {
    const observed: RequestEvidence[] = []
    await withFetch(async () => response(), async (calls) => {
      await assert.rejects(request("POST", endpoint, { offer: "fixture" }, {}, undefined, undefined,
        { reportOwner: "caller", onEvidence: (evidence) => observed.push(evidence) }), { code: "cloud_bad_response" })
      assert.deepEqual(observed, [{ jsonText: '{"offer":"fixture"}', traceId: name === "malformed JSON" ? "bad-json" : "bad-envelope" }])
      assert.equal(calls.length, 1)
    })
  })
}

test("network failure preserves the attempted body with no invented header trace or retry", async () => {
  const network = new TypeError("fixture disconnected")
  const observed: RequestEvidence[] = []
  await withFetch(async () => { throw network }, async (calls) => {
    await assert.rejects(request("POST", endpoint, { offer: "fixture" }, {}, undefined, undefined,
      { reportOwner: "caller", onEvidence: (evidence) => observed.push(evidence) }), (reason: unknown) => {
      assert.ok(reason instanceof Error)
      assert.equal(Reflect.get(reason, "code"), "cloud_unavailable")
      assert.equal(reason.cause, network)
      assert.deepEqual(observed, [{ jsonText: '{"offer":"fixture"}', traceId: null }])
      return true
    })
    assert.equal(calls.length, 1)
  })
})

test("pre-fetch serialization failure emits null evidence and makes no request", async () => {
  const serialization = new Error("fixture serialization refused")
  const observed: RequestEvidence[] = []
  await withFetch(async () => { throw new Error("fetch must not run") }, async (calls) => {
    await assert.rejects(request("POST", endpoint, { toJSON() { throw serialization } }, {}, undefined, undefined,
      { reportOwner: "caller", onEvidence: (evidence) => observed.push(evidence) }), (reason: unknown) => {
      assert.ok(reason instanceof Error)
      assert.equal(reason.cause, serialization)
      assert.deepEqual(observed, [{ jsonText: null, traceId: null }])
      return true
    })
    assert.equal(calls.length, 0)
  })
})

test("absent and JSON-undefined bodies emit null; raw DTO and void responses keep their values", async () => {
  const observed: RequestEvidence[] = []
  await withFetch(async (_input, init) => {
    assert.equal(init?.body, undefined)
    return init?.method === "GET" ? Response.json({ dto: true }) : new Response(null, { status: 204 })
  }, async (calls) => {
    const onEvidence = (evidence: RequestEvidence) => observed.push(evidence)
    assert.deepEqual(await request("GET", endpoint, undefined, {}, undefined, undefined,
      { reportOwner: "caller", responseBody: "json", onEvidence }), { dto: true })
    assert.equal(await request("POST", endpoint, { toJSON: () => undefined }, {}, undefined, undefined,
      { reportOwner: "caller", onEvidence }), undefined)
    assert.deepEqual(observed, [{ jsonText: null, traceId: null }, { jsonText: null, traceId: null }])
    assert.notEqual(observed[0], observed[1], "each request owns a fresh immutable evidence value")
    assert.equal(calls.length, 2)
  })
})

for (const mode of ["accepted", "HTTP refusal", "network rejection"] as const) {
  test(`throwing evidence observer preserves ${mode} without logs or diagnostic requests`, async () => {
    const originalLog = console.log, originalWarn = console.warn, originalError = console.error
    const logs: unknown[][] = [], observed: RequestEvidence[] = []
    const network = new Error("original network failure"), observer = new Error("observer failed")
    console.log = console.warn = console.error = (...args: unknown[]) => { logs.push(args) }
    try {
      await withFetch(async () => {
        if (mode === "network rejection") throw network
        return mode === "accepted" ? Response.json({ data: { accepted: true } })
          : Response.json({ code: "offer_busy", message: "original refusal" }, { status: 409, headers: { "x-request-id": "refusal-id" } })
      }, async (calls) => {
        const pending = request("POST", endpoint, { value: "fixture" }, {}, undefined, undefined,
          { reportOwner: "caller", onEvidence: (evidence) => { observed.push(evidence); throw observer } })
        if (mode === "accepted") assert.deepEqual(await pending, { accepted: true })
        else await assert.rejects(pending, (reason: unknown) => {
          assert.ok(reason instanceof Error)
          assert.notEqual(reason, observer)
          assert.equal(Reflect.get(reason, "code"), mode === "HTTP refusal" ? "cloud_offer_busy" : "cloud_unavailable")
          if (mode === "network rejection") assert.equal(reason.cause, network)
          else { assert.equal(reason.message, "original refusal"); assert.equal(Reflect.get(reason, "traceId"), "refusal-id") }
          return true
        })
        assert.equal(observed.length, 1)
        assert.deepEqual(logs, [])
        assert.equal(calls.length, 1)
      })
    } finally { console.log = originalLog; console.warn = originalWarn; console.error = originalError }
  })
}

for (const mode of ["body success", "body deadline", "caller body cancellation", "caller fetch cancellation"] as const) {
  test(`${mode} settles evidence once using the original request signal and deadline`, async () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
    const handle = originalSet(() => {}, 150_000)
    originalClear(handle)
    const durations: number[] = [], observed: RequestEvidence[] = []
    let fire!: () => void, ready!: () => void, clears = 0
    const waiting = new Promise<void>((resolve) => { ready = resolve })
    const caller = new AbortController()
    let requestSignal: AbortSignal | undefined
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined
    globalThis.setTimeout = new Proxy(originalSet, { apply(target, receiver, args) {
      if (args[1] !== 150_000) return Reflect.apply(target, receiver, args)
      durations.push(args[1])
      fire = () => Reflect.apply(args[0], undefined, args.slice(2))
      return handle
    } })
    globalThis.clearTimeout = new Proxy(originalClear, { apply(target, receiver, args) {
      if (args[0] === handle) clears++
      return Reflect.apply(target, receiver, args)
    } })
    let watchdog: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<never>((_resolve, reject) => {
      watchdog = originalSet(() => reject(new Error("controlled request failed to reach or settle its wait")), 3000)
    })
    try {
      await withFetch(async (_input, init) => {
        assert.ok(init?.signal)
        requestSignal = init.signal
        assert.equal(requestSignal.aborted, false)
        if (mode === "caller fetch cancellation") return new Promise<Response>((_resolve, reject) => {
          requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), { once: true })
          ready()
        })
        const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
          stream = controller
          requestSignal!.addEventListener("abort", () => controller.error(requestSignal!.reason), { once: true })
        } }), { headers: { "x-request-id": "body-trace" } })
        const text = response.text.bind(response)
        response.text = () => { ready(); return text() }
        return response
      }, async (calls) => {
        const pending = request("POST", endpoint, { value: "fixture" }, {}, 150_000, undefined,
          { reportOwner: "caller", callerSignal: caller.signal, onEvidence: (evidence) => observed.push(evidence) })
        await Promise.race([waiting, bounded, pending.then(() => { throw new Error("request settled without its controlled wait") })])
        assert.deepEqual(observed, [])
        assert.deepEqual(durations, [150_000])
        assert.equal(clears, 0)
        assert.ok(requestSignal)
        assert.notEqual(requestSignal, caller.signal, "caller cancellation merges into the original deadline signal")
        if (mode === "body success") {
          assert.ok(stream)
          stream.enqueue(new TextEncoder().encode('{"data":{"accepted":true}}'))
          stream.close()
        } else if (mode === "body deadline") fire()
        else caller.abort(new DOMException("fixture caller cancelled", "AbortError"))
        if (mode === "body success") assert.deepEqual(await Promise.race([pending, bounded]), { accepted: true })
        else await assert.rejects(Promise.race([pending, bounded]), (reason: unknown) => {
          assert.ok(reason instanceof Error)
          assert.equal(Reflect.get(reason, "code"), "cloud_unavailable")
          assert.equal(reason.cause, requestSignal!.reason)
          assert.equal(observed.length, 1, "observer runs before rejection reaches its caller")
          return true
        })
        assert.equal(requestSignal.aborted, mode !== "body success")
        assert.equal(caller.signal.aborted, mode.startsWith("caller"))
        assert.deepEqual(observed, [{ jsonText: '{"value":"fixture"}', traceId: mode === "caller fetch cancellation" ? null : "body-trace" }])
        assert.deepEqual(durations, [150_000], "no reset or replacement timeout")
        assert.equal(clears, 1)
        // Old deadline or cancellation notifications must not emit late evidence again.
        caller.abort()
        if (mode === "body success") assert.equal(requestSignal.aborted, false, "successful settlement detaches caller cancellation")
        fire()
        await Promise.resolve()
        assert.equal(observed.length, 1)
        assert.equal(calls.length, 1)
      })
    } finally {
      originalClear(watchdog)
      if (clears === 0) caller.abort()
      globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear
    }
  })
}

import assert from "node:assert/strict"
import test from "node:test"
import { normalizedProblem, setupDiagnosticTelemetry, settle } from "./diagnostic-test-support"

test("import/edit/build/validate/Stop/idle and generic flush produce zero inbox HTTP calls", async () => {
  const s = setupDiagnosticTelemetry()
  const leave = s.telemetry.enterWorkflowRoute()
  for (const stage of ["import", "edit", "build", "validate", "prepare", "result"] as const) {
    await s.telemetry.capture(normalizedProblem({ stage }))
    s.telemetry.resume(); await s.telemetry.flush(); s.telemetry.closePublishWindow()
  }
  await s.advance(150_000)
  leave(); s.telemetry.resume(); await s.telemetry.flush()
  assert.equal(s.calls.length, 0)
  assert.equal(s.timers.size, 0)
  s.telemetry.enterWorkflowRoute()
  await s.open("explicit-report").window.flush()
  assert.equal(s.calls[0]!.events.length, 6, "held reportable events remain available to the next explicit report action")
})

test("a route guard holds every event; leaving or browser online never releases held items", async () => {
  const s = setupDiagnosticTelemetry()
  await s.telemetry.capture(normalizedProblem({ stage: "build" }))
  const outside = s.telemetry.createPublishAction("outside-route")
  assert.ok(outside)
  assert.equal(s.telemetry.openPublishWindow(outside, new AbortController().signal), null)
  const leave = s.telemetry.enterWorkflowRoute()
  await s.telemetry.flush(); await s.advance(1000)
  leave()
  s.telemetry.resume(); await s.telemetry.flush(); await s.advance(150_000)
  assert.equal(s.calls.length, 0)
  s.telemetry.enterWorkflowRoute()
  await s.open("explicit-next").window.flush()
  assert.equal(s.calls[0]!.events.length, 1)
})

test("local preparation remains held while another dispatch window is active, even with its action ID", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  const { window: current, action } = s.open("sending-other-rows")
  for (const stage of ["import", "edit", "build", "validate", "prepare", "preview"] as const) {
    await s.telemetry.capture(normalizedProblem({ stage, publishAction: action }))
  }
  await current.flush(); await s.advance(1000)
  assert.equal(s.calls.length, 0)
  current.close()
  await s.open("explicit-report-preparation").window.flush()
  assert.equal(s.calls[0]!.events.length, 6)
})

test("a closed action's late event cannot join a newer open action or its retries", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  const old = s.open("same-label")
  old.window.close()
  const { window: current, action } = s.open("same-label")
  assert.equal(old.action.actionId, action.actionId)
  assert.notEqual(old.action, action)
  const late = (await s.telemetry.capture(normalizedProblem({ publishAction: old.action })))!
  await current.flush(); await s.advance(1000)
  assert.equal(s.calls.length, 0)
  const fresh = (await s.telemetry.capture(normalizedProblem({ publishAction: action })))!
  await current.flush()
  assert.deepEqual(s.calls[0]!.events.map((event) => event.id), [fresh.diagnosticId])
  await s.advance(7000)
  assert.equal(s.calls.length, 1)
  current.close()
  await s.open("next-explicit-report").window.flush()
  assert.deepEqual(s.calls[1]!.events.map((event) => event.id), [late.diagnosticId])
})

test("hash completion after its action closes remains held in a newer open window", async () => {
  let finish!: (hash: string) => void
  const s = setupDiagnosticTelemetry(() => new Promise((resolve) => { finish = resolve }))
  s.telemetry.enterWorkflowRoute()
  const { window: old, action } = s.open("old-action")
  const pending = s.telemetry.capture(normalizedProblem({
    publishAction: action, exactOperation: { provenance: "native_freeze", jsonText: '{"name":"raw"}' },
  }))
  old.close()
  const current = s.open("new-action").window
  finish("a".repeat(64))
  const detail = (await pending)!
  await current.flush(); await s.advance(1000)
  assert.equal(s.calls.length, 0)
  current.close()
  await s.open("next-explicit-report").window.flush()
  assert.deepEqual(s.calls[0]!.events.map((event) => event.id), [detail.diagnosticId])
})

test("window requires authenticated identity and active route, and same action cannot reopen or reset", async () => {
  const s = setupDiagnosticTelemetry()
  const leave = s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  const first = s.open()
  first.controller.abort()
  assert.equal(s.telemetry.openPublishWindow(first.action, new AbortController().signal), null)
  s.telemetry.resume(); await s.telemetry.flush(); await s.advance(150_000)
  assert.equal(s.calls.length, 0)
  leave()
  const outside = s.telemetry.createPublishAction("new-action")
  assert.ok(outside)
  assert.equal(s.telemetry.openPublishWindow(outside, new AbortController().signal), null)
  s.telemetry.enterWorkflowRoute()
  await s.open("new-action").window.flush()
  assert.equal(s.calls.length, 1)
})

test("Stop aborts diagnostic fetch/body but never the independent in-flight submission", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  const submitController = new AbortController()
  await s.telemetry.capture(normalizedProblem())
  s.setTransport(async () => new Promise<Response>(() => undefined))
  const { window, controller, action } = s.open()
  const pending = window.flush()
  await settle()
  assert.equal(s.calls.length, 1)
  controller.abort()
  await pending
  assert.equal(s.calls[0]!.init.signal?.aborted, true)
  assert.equal(submitController.signal.aborted, false)
  await s.telemetry.capture(normalizedProblem({ stage: "result" }))
  await s.advance(150_000)
  s.telemetry.resume(); await s.telemetry.flush()
  assert.equal(s.calls.length, 1, "late submit failure remains held after Stop")
  assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
})

test("duplicate flushes share one flight and cannot bypass the retry deadline", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  let answer!: (response: Response) => void
  s.setTransport(async () => new Promise<Response>((resolve) => { answer = resolve }))
  const { window } = s.open()
  const first = window.flush()
  await window.flush(); await window.flush()
  assert.equal(s.calls.length, 1)
  answer(new Response(null, { status: 500 }))
  await first
  await window.flush()
  assert.equal(s.calls.length, 1)
  window.close()
})

test("a synchronous Stop during fetch setup still observes a rejected transport promise", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  const { window, controller } = s.open()
  s.setTransport(async () => { controller.abort(); throw new Error("private transport failure") })
  await window.flush()
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0]!.init.signal?.aborted, true)
  await s.advance(150_000)
  assert.equal(s.calls.length, 1)
})

test("offline closes flight/window; online and resume cannot reopen the action", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  s.setTransport(async () => new Promise<Response>(() => undefined))
  const { window, action } = s.open()
  const pending = window.flush(); await settle()
  s.setOnline(false)
  await pending
  assert.equal(s.calls[0]!.init.signal?.aborted, true)
  s.setOnline(true); s.telemetry.resume(); await s.telemetry.flush(); await s.advance(150_000)
  assert.equal(s.calls.length, 1)
  assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
  s.setTransport(async (events) => Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } }))
  await s.open("explicit-new-action").window.flush()
  assert.deepEqual(s.calls[1]!.events, s.calls[0]!.events)
})

test("route exit aborts flight; active-but-mounted route scope is explicit and nested releases are idempotent", async () => {
  const s = setupDiagnosticTelemetry()
  const first = s.telemetry.enterWorkflowRoute()
  const second = s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  s.setTransport(async () => new Promise<Response>(() => undefined))
  const { window } = s.open()
  const pending = window.flush(); await settle()
  first(); first()
  assert.equal(s.calls[0]!.init.signal?.aborted, false)
  second(); second()
  await pending
  assert.equal(s.calls[0]!.init.signal?.aborted, true)
  s.telemetry.resume(); await s.telemetry.flush(); await s.advance(150_000)
  assert.equal(s.calls.length, 1)
})

test("request timeout is five seconds through the response body, including transports ignoring abort", async () => {
  for (const stalledBody of [false, true]) {
    const s = setupDiagnosticTelemetry()
    s.telemetry.enterWorkflowRoute()
    await s.telemetry.capture(normalizedProblem())
    s.setTransport(async () => {
      if (!stalledBody) return new Promise<Response>(() => undefined)
      return Object.assign(Response.json({}), { json: () => new Promise<unknown>(() => undefined) })
    })
    const { window } = s.open()
    const pending = window.flush(); await settle()
    await s.advance(4999)
    assert.equal(s.calls[0]!.init.signal?.aborted, false)
    await s.advance(1)
    await pending
    assert.equal(s.calls[0]!.init.signal?.aborted, true)
    window.close()
    await s.advance(150_000)
    assert.equal(s.calls.length, 1)
  }
})

test("Retry-After is bounded at 30 seconds and manual flush cannot skip the wait", async () => {
  for (const choice of ["999999999999999999", "30", "1", "invalid", "http-date"]) {
    const s = setupDiagnosticTelemetry()
    s.telemetry.enterWorkflowRoute()
    await s.telemetry.capture(normalizedProblem())
    const header = choice === "http-date" ? new Date(s.clock.now() + 120_000).toUTCString() : choice
    s.setTransport(async () => new Response(null, { status: 429, headers: { "Retry-After": header } }))
    const { window } = s.open()
    await window.flush()
    const wait = choice === "1" || choice === "invalid" ? 1000 : 30_000
    await window.flush(); await s.advance(wait - 1)
    assert.equal(s.calls.length, 1)
    await s.advance(1)
    assert.equal(s.calls.length, 2)
    window.close()
  }
})

test("five batches each receive at most three total attempts without resetting on continued action", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  for (let i = 0; i < 100; i++) await s.telemetry.capture(normalizedProblem())
  s.setTransport(async () => { throw new Error("network") })
  const { window, action } = s.open()
  await window.flush(); await s.advance(119_999)
  assert.equal(s.calls.length, 15)
  const attempts = new Map<string, number>()
  for (const call of s.calls) {
    assert.equal(call.events.length, 20)
    const batchId = call.events.map((event) => event.id).join(",")
    attempts.set(batchId, (attempts.get(batchId) ?? 0) + 1)
  }
  assert.equal(attempts.size, 5)
  assert.deepEqual([...attempts.values()], [3, 3, 3, 3, 3])
  s.telemetry.resume(); await s.telemetry.flush(); await window.flush()
  assert.equal(s.calls.length, 15)
  await s.advance(1)
  assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
})

test("120-second deadline forbids late events or retries, even after a 150-second submit response", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  const { window } = s.open()
  await s.advance(120_000)
  await s.telemetry.capture(normalizedProblem())
  await window.flush(); await s.advance(30_000)
  s.telemetry.resume(); await s.telemetry.flush()
  assert.equal(s.calls.length, 0)
  await s.open("next-explicit").window.flush()
  assert.equal(s.calls.length, 1)
})

test("stale fetch completion cannot settle or clear a newer identity/window", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  const old = (await s.telemetry.capture(normalizedProblem()))!
  let respond!: (response: Response) => void
  s.setTransport(async () => new Promise<Response>((resolve) => { respond = resolve }))
  const oldWindow = s.open("old-action").window
  const pending = oldWindow.flush(); await settle()
  s.telemetry.setContext({ sessionKey: "account-2:workspace-2" })
  await pending
  assert.equal(s.telemetry.detail(old.diagnosticId).event, null)
  await s.telemetry.capture(normalizedProblem())
  s.setTransport(async (events) => Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } }))
  const next = s.open("next-action").window
  respond(new Response(null, { status: 401 }))
  await next.flush()
  assert.equal(s.calls.length, 2)
  assert.ok(await s.telemetry.capture(normalizedProblem()), "late old 401 must not clear the fresh identity")
  next.close()
})

test("terminal refusals retire only selected events; malformed acknowledgements retry within the same budget", async () => {
  for (const status of [400, 403, 500, 200]) {
    const s = setupDiagnosticTelemetry()
    s.telemetry.enterWorkflowRoute()
    await s.telemetry.capture(normalizedProblem())
    s.setTransport(async () => status === 200 ? Response.json({ invalid: true }) : new Response(null, { status }))
    await s.open().window.flush(); await s.advance(7000)
    assert.equal(s.calls.length, status === 400 || status === 403 ? 1 : 3)
    s.telemetry.closePublishWindow()
  }
})

test("malformed response JSON retains immutable events for only three total attempts", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  s.setTransport(async () => new Response("{broken", { status: 200 }))
  await s.open().window.flush(); await s.advance(7000)
  assert.equal(s.calls.length, 3)
  assert.deepEqual(s.calls[1]!.events, s.calls[0]!.events)
  assert.deepEqual(s.calls[2]!.events, s.calls[0]!.events)
  s.telemetry.closePublishWindow()
})

for (const status of [429, 500]) test(`streaming ${status} bodies are cancelled before every bounded retry`, async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.enterWorkflowRoute()
  await s.telemetry.capture(normalizedProblem())
  let openBodies = 0
  let cancelled = 0
  s.setTransport(async () => {
    assert.equal(openBodies, 0, "the previous response must be retired before admitting another request")
    openBodies++
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("unread streaming response")) },
      cancel() {
        openBodies--; cancelled++
        // A non-cooperating cancellation sink cannot keep diagnostic ownership or extend its deadline.
        if (status === 500) return new Promise<void>(() => undefined)
      },
    }), { status, headers: { "Retry-After": "999999" } })
  })
  const { window, action } = s.open()
  await window.flush(); await settle()
  assert.equal(cancelled, 1)
  assert.equal(openBodies, 0)
  assert.equal(s.calls[0]!.init.signal?.aborted, true)
  for (let attempt = 2; attempt <= 3; attempt++) {
    await window.flush(); await s.advance(29_999)
    assert.equal(s.calls.length, attempt - 1, "manual flush must preserve the 30-second delay cap")
    await s.advance(1)
    assert.equal(s.calls.length, attempt)
    assert.equal(cancelled, attempt)
    assert.equal(openBodies, 0)
    assert.ok(s.calls.every((call) => call.init.signal?.aborted))
    assert.deepEqual(s.calls.at(-1)!.events, s.calls[0]!.events)
  }
  await s.advance(60_000)
  assert.equal(s.calls.length, 3)
  assert.equal(cancelled, 3)
  assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
})

test("Stop and offline cancel streaming refusal bodies and pending retries without aborting submission", async () => {
  for (const close of ["Stop", "offline"] as const) {
    const s = setupDiagnosticTelemetry()
    s.telemetry.enterWorkflowRoute()
    await s.telemetry.capture(normalizedProblem())
    const submission = new AbortController()
    let cancelled = 0
    s.setTransport(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])) },
      cancel() { cancelled++ },
    }), { status: 429, headers: { "Retry-After": "30" } }))
    const { window, controller, action } = s.open()
    await window.flush(); await settle()
    assert.equal(cancelled, 1)
    if (close === "Stop") controller.abort()
    else s.setOnline(false)
    assert.equal(s.calls[0]!.init.signal?.aborted, true)
    assert.equal(submission.signal.aborted, false)
    s.setOnline(true); s.telemetry.resume(); await s.telemetry.flush()
    await s.advance(150_000)
    assert.equal(s.calls.length, 1)
    assert.equal(cancelled, 1)
    assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
  }
})

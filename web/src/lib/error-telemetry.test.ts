import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { route } from "@/api/routes"
import {
  beginErrorTelemetryContextChange, captureDiagnostic, createDiagnosticPublishAction, createErrorTelemetry, getDiagnosticCopyData,
  enterDiagnosticWorkflowRoute, openDiagnosticPublishWindow, queueErrorTelemetry, safeErrorFrames, setErrorTelemetryContext,
} from "./error-telemetry"
import { normalizedProblem, setupDiagnosticTelemetry, v4Payload } from "./diagnostic-test-support"
import type { DiagnosticPublishAction } from "./diagnostic-window"

function guardNativeTimers(run: (scheduled: () => number) => void) {
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  let scheduled = 0
  globalThis.setTimeout = function (this: unknown) {
    assert.equal(this, globalThis, "Window timers require the native receiver")
    return ++scheduled as unknown as ReturnType<typeof setTimeout>
  } as unknown as typeof setTimeout
  globalThis.clearTimeout = function (this: unknown) {
    assert.equal(this, globalThis, "Window timer cleanup requires the native receiver")
  } as typeof clearTimeout
  try { run(() => scheduled) } finally { globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear }
}

test("default browser dependencies preserve native timer receivers", () => {
  guardNativeTimers((scheduled) => {
    const telemetry = createErrorTelemetry()
    telemetry.setContext({ sessionKey: "account:native-receiver" })
    const leave = telemetry.enterWorkflowRoute()
    const action = telemetry.createPublishAction("native-timer")
    assert.ok(action)
    assert.ok(telemetry.openPublishWindow(action, new AbortController().signal))
    assert.equal(scheduled(), 1)
    telemetry.setContext({ sessionKey: null })
    leave()
  })
})

test("concurrent cookie changes ignore polls and require a fresh overview after every finish", async () => {
  setErrorTelemetryContext({ sessionKey: "account:before-change" })
  const action = createDiagnosticPublishAction("before-change")
  assert.ok(action)
  const detail = (await captureDiagnostic(normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: '{"name":"local-secret"}' } })))!
  const first = beginErrorTelemetryContextChange()
  const second = beginErrorTelemetryContextChange()
  const leave = enterDiagnosticWorkflowRoute()
  try {
    assert.equal(getDiagnosticCopyData(detail.diagnosticId).originalJson, null)
    setErrorTelemetryContext({ sessionKey: "stale:poll" })
    assert.equal(await captureDiagnostic(normalizedProblem()), null)
    first(); first()
    setErrorTelemetryContext({ sessionKey: "other:stale-poll" })
    assert.equal(await captureDiagnostic(normalizedProblem()), null)
    second()
    assert.equal(openDiagnosticPublishWindow(action, new AbortController().signal), null)
    assert.equal(createDiagnosticPublishAction("anonymous"), null)
    assert.equal(await captureDiagnostic(normalizedProblem()), null, "finish cannot restore old identity")
    setErrorTelemetryContext({ sessionKey: "account:fresh-overview" })
    assert.ok(await captureDiagnostic(normalizedProblem()))
  } finally { first(); second(); leave(); setErrorTelemetryContext({ sessionKey: null }) }
})

test("inbox payload is v4 hash-only, ID-deduplicated and immutable across retry", async () => {
  const s = setupDiagnosticTelemetry()
  const input = normalizedProblem()
  await s.telemetry.capture(input); await s.telemetry.capture(input); await s.telemetry.capture(input)
  s.telemetry.enterWorkflowRoute()
  s.setTransport(async () => { throw new Error("Bearer secret network body") })
  await s.open().window.flush()
  const first = s.calls[0]!.events[0]!
  const payload = v4Payload(first)
  assert.equal(payload.platform, "ozon")
  assert.equal(payload.payload_sha256, null)
  assert.deepEqual(payload.summary, [])
  assert.equal(s.calls[0]!.events.length, 1)
  assert.equal(s.calls[0]!.url, route("eventsInbox"))
  assert.equal(s.calls[0]!.init.credentials, "include")
  assert.equal((s.calls[0]!.init.headers as Record<string, string>)["X-Podhub-Device-Id"], "spa-device-1")
  s.setTransport(async (events) => Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } }))
  await s.advance(1000)
  assert.deepEqual(s.calls[1]!.events, [first])
  assert.ok(!JSON.stringify(s.calls).includes("secret"))
})

test("distinct platform, stage or field stay separate events", async () => {
  const s = setupDiagnosticTelemetry()
  for (const input of [
    { platform: "ozon", field: "name" }, { platform: "ozon", field: "offer_id" },
    { platform: "wb", field: "name" }, { platform: "ozon", stage: "reconcile" as const, field: "name" },
  ]) await s.telemetry.capture(normalizedProblem(input))
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  assert.equal(s.calls[0]!.events.length, 4)
  for (const event of s.calls[0]!.events) v4Payload(event)
})

test("HTTP 200 retires accepted and rejected ids separately and retries an unacknowledged id", async () => {
  const s = setupDiagnosticTelemetry()
  for (let i = 0; i < 3; i++) await s.telemetry.capture(normalizedProblem())
  s.setTransport(async (events) => Response.json({ data: { accepted: [events[0]!.id, "foreign-id"], rejected: [{ id: events[1]!.id, reason: "not logged" }] } }))
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  const missing = s.calls[0]!.events[2]!
  s.setTransport(async (events) => Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } }))
  await s.advance(1000)
  assert.deepEqual(s.calls[1]!.events, [missing])
})

test("three network failures park the bounded queue and online/resume never reset attempts", async () => {
  const s = setupDiagnosticTelemetry()
  await s.telemetry.capture(normalizedProblem())
  s.telemetry.enterWorkflowRoute()
  s.setTransport(async () => { throw new Error("private network reason") })
  const { window, action } = s.open()
  await window.flush()
  await s.advance(7000)
  assert.equal(s.calls.length, 3)
  for (let i = 0; i < 10; i++) { s.telemetry.resume(); await s.telemetry.flush(); await window.flush() }
  assert.equal(s.calls.length, 3)
  assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
  assert.ok(!JSON.stringify(s.calls).includes("private network reason"))
})

test("repeated identical context polls never retry a parked event", async () => {
  const s = setupDiagnosticTelemetry()
  await s.telemetry.capture(normalizedProblem())
  s.telemetry.enterWorkflowRoute()
  s.setTransport(async () => { throw new Error("offline") })
  await s.open().window.flush(); await s.advance(7000)
  for (let poll = 0; poll < 100; poll++) {
    s.telemetry.setContext({ sessionKey: "account-1:workspace-1" })
    s.telemetry.resume(); await s.telemetry.flush()
  }
  assert.equal(s.calls.length, 3)
  s.telemetry.setContext({ sessionKey: "account-2:workspace-1" })
  s.setTransport(async (events) => Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } }))
  const next = s.open("new-identity")
  await next.window.flush()
  assert.equal(s.calls.length, 3, "held events cannot cross an identity change")
  await s.telemetry.capture(normalizedProblem({ publishAction: next.action }))
  await s.advance(0)
  assert.equal(s.calls.length, 4)
})

test("anonymous events are quiet and queued errors never cross account or workspace changes", async () => {
  const s = setupDiagnosticTelemetry()
  s.telemetry.setContext({ sessionKey: null })
  assert.equal(await s.telemetry.capture(normalizedProblem()), null)
  s.telemetry.setContext({ sessionKey: "account-1:workspace-1" })
  const detail = (await s.telemetry.capture(normalizedProblem()))!
  s.telemetry.setContext({ sessionKey: "account-2:workspace-1" })
  assert.equal(s.telemetry.detail(detail.diagnosticId).event, null)
  s.telemetry.enterWorkflowRoute()
  const current = s.open()
  await current.window.flush()
  assert.equal(s.calls.length, 0)
  await s.telemetry.capture(normalizedProblem({ publishAction: current.action }))
  s.setTransport(async () => new Response(null, { status: 401 }))
  await s.advance(0)
  assert.equal(s.calls.length, 1)
  assert.equal(await s.telemetry.capture(normalizedProblem()), null)
  assert.equal(s.timers.size, 0)
})

test("queue is capped at 100 events and batches at 20", async () => {
  const s = setupDiagnosticTelemetry()
  for (let i = 0; i < 110; i++) await s.telemetry.capture(normalizedProblem())
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  await s.advance(5000)
  assert.equal(s.calls.length, 5)
  assert.ok(s.calls.every((call) => call.events.length === 20))
  assert.equal(new Set(s.calls.flatMap((call) => call.events.map((event) => event.id))).size, 100)
})

test("safe frames preserve only portable symbols from bounded causal stacks", () => {
  const cause = new Error("raw password=secret")
  cause.stack = "Error: secret\n    at relayMedia (/Users/operator/private.ts:1:2)\nrun@https://cdn.invalid?token=secret"
  const error = new Error("raw response secret", { cause })
  error.stack = "Error: secret\n    at uploadAsset (https://cdn.invalid/app.js:2:1)\n    at https://secret.invalid/body"
  cause.cause = error
  assert.deepEqual(safeErrorFrames(error, "at App\nat Panel (/private/file.ts:2:1)"), ["uploadAsset", "relayMedia", "run", "App", "Panel"])
})

test("legacy queue entrypoints remain console-only and cannot invent reportable v4 events", () => {
  const original = console.log
  console.log = () => undefined
  try {
    guardNativeTimers((scheduled) => {
      setErrorTelemetryContext({ sessionKey: "account:local-only" })
      queueErrorTelemetry({ code: "test:local", source: "workbench", severity: "blocking", frames: [] })
      assert.equal(scheduled(), 0)
      setErrorTelemetryContext({ sessionKey: null })
    })
  } finally { console.log = original }
})

test("thousands of completed gestures retain bounded resources and never revive closed, stopped, offline or expired tokens", async () => {
  const s = setupDiagnosticTelemetry(async (text) => createHash("sha256").update(text, "utf8").digest("hex"))
  const leave = s.telemetry.enterWorkflowRoute()
  const originalLog = console.log
  console.log = () => undefined
  try {
    const original = { provenance: "native_freeze" as const, jsonText: '{"name":"local-original"}' }
    const problem = normalizedProblem({ exactOperation: original, traceEvidence: { listingIssueTraceId: "same-trace" } })
    const detail = await s.telemetry.capture(problem)
    assert.ok(detail)
    assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, original.jsonText)
    const closed = s.open("same-label")
    await closed.window.flush(); closed.window.close()
    assert.equal(s.calls.length, 1)
    s.calls.length = 0
    const stopped = s.open("same-label")
    stopped.controller.abort()
    const offline = s.open("same-label")
    s.setOnline(false); s.setOnline(true)
    const expired = s.open("same-label")
    await s.advance(120_000)
    for (let cycle = 0; cycle < 2000; cycle++) {
      assert.ok(await s.telemetry.capture({ ...problem }))
      const next = s.open("same-label")
      await next.window.flush(); next.window.close()
      assert.equal(s.calls.length, 1)
      assert.equal(s.calls[0]!.events.length, 1)
      assert.equal(s.calls[0]!.init.signal?.aborted, true)
      // Bound the observer too: keep no growing test history to prove production boundedness.
      s.calls.length = 0
      assert.equal(s.timers.size, 1, "only the bounded memory's single TTL timer remains")
    }
    for (const old of [closed, stopped, offline, expired]) {
      assert.equal(s.telemetry.openPublishWindow(old.action, new AbortController().signal), null)
      await old.window.flush()
    }
    assert.equal(s.telemetry.detail(detail.diagnosticId).event, null, "the 100-entry memory evicts old metadata")
    assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, null)
    assert.equal(await s.telemetry.capture(problem), detail, "the normalized object's weak lifecycle still deduplicates after acknowledgement and eviction")
    const empty = s.open("same-label")
    await empty.window.flush(); empty.window.close()
    assert.equal(s.calls.length, 0)
  } finally {
    console.log = originalLog
    s.telemetry.setContext({ sessionKey: null }); leave()
    assert.equal(s.timers.size, 0)
  }
})

test("action tokens are one-use even on failed admission, superseded before opening, forged or from another identity", () => {
  const s = setupDiagnosticTelemetry()
  const outside = s.telemetry.createPublishAction("outside")!
  assert.equal(s.telemetry.openPublishWindow(outside, new AbortController().signal), null)
  const leave = s.telemetry.enterWorkflowRoute()
  assert.equal(s.telemetry.openPublishWindow(outside, new AbortController().signal), null)
  for (const duration of [0, -1, NaN, Infinity]) {
    const action = s.telemetry.createPublishAction("invalid-duration")!
    assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal, duration), null)
    assert.equal(s.telemetry.openPublishWindow(action, new AbortController().signal), null)
  }
  const stopped = s.telemetry.createPublishAction("already-stopped")!
  const stop = new AbortController(); stop.abort()
  assert.equal(s.telemetry.openPublishWindow(stopped, stop.signal), null)
  assert.equal(s.telemetry.openPublishWindow(stopped, new AbortController().signal), null)
  const offline = s.telemetry.createPublishAction("offline")!
  s.setOnline(false)
  assert.equal(s.telemetry.openPublishWindow(offline, new AbortController().signal), null)
  s.setOnline(true)
  assert.equal(s.telemetry.openPublishWindow(offline, new AbortController().signal), null)
  const older = s.telemetry.createPublishAction("older-unopened")!
  const latest = s.open("latest")
  assert.equal(s.telemetry.openPublishWindow(older, new AbortController().signal), null)
  assert.equal(s.telemetry.openPublishWindow({ actionId: "latest" } as DiagnosticPublishAction, new AbortController().signal), null)
  const foreign = setupDiagnosticTelemetry().telemetry.createPublishAction("foreign")!
  assert.equal(s.telemetry.openPublishWindow(foreign, new AbortController().signal), null)
  s.telemetry.setContext({ sessionKey: "account-2:workspace-2" })
  assert.equal(s.telemetry.openPublishWindow(latest.action, new AbortController().signal), null)
  assert.ok(s.open("latest").window)
  s.telemetry.setContext({ sessionKey: null }); leave()
  assert.equal(s.timers.size, 0)
})

test("identity change fences a pending full hash and its original action token", async () => {
  let finish!: (hash: string) => void
  const s = setupDiagnosticTelemetry(() => new Promise((resolve) => { finish = resolve }))
  s.telemetry.enterWorkflowRoute()
  const old = s.open("pending-capture")
  const pending = s.telemetry.capture(normalizedProblem({
    publishAction: old.action, exactOperation: { provenance: "native_freeze", jsonText: '{"name":"local-original"}' },
  }))
  s.telemetry.setContext({ sessionKey: "account-2:workspace-2" })
  finish("a".repeat(64))
  assert.equal(await pending, null)
  assert.equal(s.telemetry.openPublishWindow(old.action, new AbortController().signal), null)
  await s.open("fresh-capture").window.flush()
  assert.equal(s.calls.length, 0)
  assert.ok(await s.telemetry.capture(normalizedProblem()))
  s.telemetry.setContext({ sessionKey: null })
  assert.equal(s.timers.size, 0)
})

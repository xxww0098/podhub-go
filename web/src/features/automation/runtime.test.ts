import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { startAutomationRuntime } from "./runtime"

test("runtime skips expired grants and renews with the registered lease duration", async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  const originalInterval = globalThis.setInterval
  const originalClearInterval = globalThis.clearInterval
  const calls: { path: string; body: Record<string, unknown> }[] = []
  const intervals: number[] = []
  let releaseSettle!: () => void
  const settling = new Promise<void>((resolve) => { releaseSettle = resolve })
  const errors: unknown[] = []
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval: () => 1, clearInterval: () => {},
    setTimeout: () => 2, clearTimeout: () => {},
  } })
  globalThis.setInterval = ((_run: unknown, ms: number) => { intervals.push(ms); return intervals.length }) as typeof setInterval
  globalThis.clearInterval = (() => {}) as typeof clearInterval
  globalThis.fetch = async (input, init) => {
    const path = String(input)
    const body = JSON.parse(String(init?.body ?? "{}"))
    calls.push({ path, body })
    if (path.endsWith("/grants")) return Response.json({ data: { grants: [
      { id: "expired", actions: ["read"], expires_at_ms: Date.now() - 1 },
      { id: "revoked", actions: ["read"], revoked_at_ms: Date.now() },
      { id: "live", actions: ["read"], expires_at_ms: Date.now() + 60_000 },
    ] } })
    if (path.endsWith("/runtimes")) return Response.json({ data: { runtime: { id: "runtime" }, claim_lease_seconds: 12 } })
    if (path.endsWith("/commands/claim")) return Response.json({ data: { lease_seconds: 12, commands: [
      { operationId: "command", action: "legacy", clientRequestId: "request", claimEpoch: 1, payload: {}, cancelRequested: false },
    ] } })
    if (path.endsWith("/settle")) { await settling; return Response.json({ data: { accepted: true } }) }
    if (path.endsWith("/deregister")) return Response.json({ data: { runtime: { id: "runtime" } } })
    throw new Error(`unexpected runtime request ${path}`)
  }
  const runtime = startAutomationRuntime({ workspaceId: 1, onError: (reason) => errors.push(reason) })
  try {
    for (let i = 0; i < 20 && !calls.some((call) => call.path.endsWith("/settle")); i++) await tick()
    assert.deepEqual(calls.filter((call) => call.path.endsWith("/runtimes")).map((call) => call.body.grantId), ["live"])
    assert.ok(intervals.includes(4_000), "the 12 second lease must renew every 4 seconds")
    assert.ok(intervals.every(Number.isFinite), "undefined wire fields must not schedule NaN intervals")
    assert.equal(calls.find((call) => call.path.endsWith("/settle"))?.body.status, "failed")
    assert.deepEqual(errors, [])
  } finally {
    runtime.stop()
    releaseSettle()
    await tick()
    await tick()
    globalThis.fetch = originalFetch
    globalThis.setInterval = originalInterval
    globalThis.clearInterval = originalClearInterval
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
  }
})

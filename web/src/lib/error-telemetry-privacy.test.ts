import assert from "node:assert/strict"
import test from "node:test"
import { request } from "@/api/client"
import { route } from "@/api/routes"
import { installBrowserDiagnostics, reactErrorHandlers } from "./browser-diagnostics"
import { diagLog, reportError } from "./diag-log"
import { queueErrorTelemetry, setErrorTelemetryContext } from "./error-telemetry"
import { normalizedProblem, setupDiagnosticTelemetry, v4Payload } from "./diagnostic-test-support"
import type { DiagnosticCaptureInput } from "./diagnostic-capture"

test("only four closed reportable categories enqueue; field/config/balance/WB disabled issues stay local", async () => {
  const s = setupDiagnosticTelemetry()
  for (const code of ["contract_violation", "unclassified_server", "wasm_exception", "result_unknown"] as const) {
    const input = normalizedProblem({ code })
    await s.telemetry.capture(input); await s.telemetry.capture(input)
  }
  for (const code of ["schema_stale", "required", "balance_insufficient", "workspace_full", "not_enabled"]) assert.equal(await s.telemetry.capture(normalizedProblem({ code } as unknown as Partial<DiagnosticCaptureInput>)), null)
  assert.equal(s.calls.length, 0)
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  assert.deepEqual(s.calls[0]!.events.map((event) => v4Payload(event).code), ["contract_violation", "unclassified_server", "wasm_exception", "result_unknown"])
})

test("raw text, URLs, credentials, frames, unknown keys and invalid enums never enter remote v4", async () => {
  const s = setupDiagnosticTelemetry()
  const text = JSON.stringify({
    name: "Bearer secret", price: "password=secret", offer_id: "private-offer", currency_code: "XYZ",
    dimension_unit: "kg", weight_unit: "mm", token: "secret", url: "https://cdn.invalid/private", frames: ["/Users/private"],
    attributes: [{ id: 85, values: [{ value: "token=secret https://cdn.invalid/private" }], privateKey: "secret" }],
  })
  const detail = (await s.telemetry.capture(normalizedProblem({ exactOperation: { provenance: "native_freeze", jsonText: text } })))!
  assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, text)
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  const remote = s.calls[0]!.events[0]!
  const payload = v4Payload(remote)
  for (const leak of ["secret", "private-offer", "XYZ", "cdn.invalid", "privateKey", "frames", "/Users"]) assert.ok(!remote.payload_json.includes(leak), leak)
  for (const summary of payload.summary) assert.equal(summary.enum_value, null)
  assert.equal(payload.summary.find((entry) => entry.field === "attributes[0].id")?.field_id, 85)
})

test("API, diag-log, global rejection and browser errors have zero inbox calls before canonical capture", async () => {
  const originalFetch = globalThis.fetch
  const originalLog = console.log
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  let inbox = 0
  const timers: (() => void)[] = []
  console.log = () => undefined
  globalThis.setTimeout = ((callback: () => void) => { timers.push(callback); return timers.length as unknown as ReturnType<typeof setTimeout> }) as unknown as typeof setTimeout
  globalThis.clearTimeout = () => undefined
  globalThis.fetch = (async (url: unknown) => {
    if (String(url) === route("eventsInbox")) { inbox++; throw new Error("unexpected inbox") }
    return Response.json({ code: "validation", message: "refusal" }, { status: 422 })
  }) as typeof fetch
  const target = new EventTarget()
  const remove = installBrowserDiagnostics(target as unknown as Window)
  try {
    setErrorTelemetryContext({ sessionKey: "test:privacy-live" })
    const failure = await request("POST", route("listingSubmit"), { name: "secret" }).catch((reason: unknown) => reason)
    reportError("[normalized-low-level]", failure)
    diagLog("[prepare]", "build.fail", { status: 500, message: "secret" })
    queueErrorTelemetry({ code: "result_unknown", source: "workbench", severity: "blocking", frames: [] })
    target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: new Error("secret") }))
    target.dispatchEvent(Object.assign(new Event("error"), { message: "secret", error: new Error("secret") }))
    reactErrorHandlers.onUncaughtError(new Error("secret"), { componentStack: "at App" })
    assert.equal(inbox, 0)
    // Toast timers may exist; executing a snapshot cannot authorize a diagnostic remote send.
    const pending = [...timers]
    for (const timer of pending) timer()
    await Promise.resolve()
    assert.equal(inbox, 0)
  } finally {
    remove(); setErrorTelemetryContext({ sessionKey: null })
    globalThis.fetch = originalFetch; console.log = originalLog
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear
  }
})

test("readonly detail and explicit copy-data access never invoke clipboard or persistent storage", async () => {
  const s = setupDiagnosticTelemetry()
  const descriptors = new Map<string, PropertyDescriptor | undefined>()
  for (const name of ["localStorage", "sessionStorage", "indexedDB", "navigator"]) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name))
    Object.defineProperty(globalThis, name, name === "navigator"
      ? { configurable: true, value: { get clipboard() { return assert.fail("clipboard access belongs to the explicit UI gesture") } } }
      : { configurable: true, get() { return assert.fail(`${name} is forbidden`) } })
  }
  try {
    const detail = (await s.telemetry.capture(normalizedProblem({ exactOperation: { provenance: "submitted_http_body", jsonText: '{"name":"local-only"}' } })))!
    assert.ok(!JSON.stringify(s.telemetry.detail(detail.diagnosticId)).includes("local-only"))
    const copied = s.telemetry.copyData(detail.diagnosticId)
    assert.equal(copied.originalJson, '{"name":"local-only"}')
    assert.equal(copied.detail.diagnosticId, detail.diagnosticId)
    assert.equal(copied.detail.event?.trace_id, detail.event?.trace_id)
    s.telemetry.setContext({ sessionKey: null })
    assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, null)
  } finally {
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else Reflect.deleteProperty(globalThis, name)
    }
  }
})

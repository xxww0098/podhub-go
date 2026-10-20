import assert from "node:assert/strict"
import { createErrorTelemetry } from "./error-telemetry"
import type { DiagnosticCaptureInput } from "./diagnostic-capture"
import type { DiagnosticClock, DiagnosticTimer } from "./diagnostic-window"
import type { DiagnosticEvent } from "./diagnostic-summary"

export type EventWire = { id: string; kind: string; schema_version: number; payload_json: string }
export const normalizedProblem = (extra: Partial<DiagnosticCaptureInput> = {}): DiagnosticCaptureInput => ({
  code: "result_unknown", platform: "ozon", stage: "submit", field: null, ...extra,
})
export const testId = (sequence: number) => `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`
export async function settle() { for (let i = 0; i < 12; i++) await Promise.resolve() }

export function diagnosticTestClock() {
  let now = 1_790_000_000_000
  let sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: DiagnosticClock = {
    now: () => now,
    setTimer: (callback, ms) => {
      const id = ++sequence
      timers.set(id, { at: now + ms, callback })
      return id as unknown as DiagnosticTimer
    },
    clearTimer: (timer) => { timers.delete(timer as unknown as number) },
  }
  const advance = async (ms: number) => {
    const target = now + ms
    for (let step = 0; step < 1000; step++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) { now = target; await settle(); return }
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
      await settle()
    }
    assert.fail("diagnostic timer runaway")
  }
  return { clock, timers, advance }
}

export function setupDiagnosticTelemetry(digest?: (text: string) => Promise<string>) {
  const time = diagnosticTestClock()
  const calls: { url: unknown; events: EventWire[]; init: RequestInit }[] = []
  let online = true
  let sequence = 0
  let transport = async (events: EventWire[], _init: RequestInit): Promise<Response> =>
    Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
  const telemetry = createErrorTelemetry({
    ...time.clock, isOnline: () => online, deviceId: () => "spa-device-1", uuid: () => testId(++sequence), digest,
    fetch: (async (url: unknown, init: RequestInit) => {
      const { events } = JSON.parse(String(init.body)) as { events: EventWire[] }
      calls.push({ url, events, init })
      return transport(events, init)
    }) as typeof fetch,
  })
  telemetry.setContext({ sessionKey: "account-1:workspace-1" })
  const open = (id = "action-1", controller = new AbortController(), timeoutMs = 120_000) => {
    const action = telemetry.createPublishAction(id)
    assert.ok(action)
    const window = telemetry.openPublishWindow(action, controller.signal, timeoutMs)
    assert.ok(window)
    return { window, controller, action }
  }
  return {
    ...time, telemetry, calls, open,
    setOnline: (value: boolean) => { online = value; if (!value) telemetry.offline() },
    setTransport: (next: typeof transport) => { transport = next },
  }
}

/** Independently assert exact v4 envelope/nullable key ABI, not sender-derived key expectations. */
export function v4Payload(event: EventWire): DiagnosticEvent {
  assert.equal(event.kind, "desktop_error_log.v4")
  assert.equal(event.schema_version, 4)
  const payload: DiagnosticEvent = JSON.parse(event.payload_json)
  assert.deepEqual(Object.keys(payload).sort(), [
    "code", "diagnostic_id", "field", "occurred_at", "payload_sha256", "platform", "schema_version", "stage", "summary", "trace_id",
  ])
  assert.equal(event.id, payload.diagnostic_id)
  assert.match(event.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(payload.schema_version, 4)
  assert.ok(Number.isFinite(Date.parse(payload.occurred_at)))
  if (payload.payload_sha256 === null) assert.deepEqual(payload.summary, [])
  else assert.match(payload.payload_sha256, /^[0-9a-f]{64}$/)
  for (const field of payload.summary) assert.deepEqual(Object.keys(field).sort(), ["enum_value", "field", "field_id", "length", "value_type"])
  return payload
}

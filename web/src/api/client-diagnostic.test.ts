/**
 * API diagnostics are local metadata. Only explicit reportable normalization
 * creates v4, and only an explicit publish/report window delivers it. Exact
 * submitted text remains local; the inbox receives its full hash and summary.
 */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { afterEach, test } from "node:test"

import { api, request, type CloudRefusal } from "@/api/client"
import { route } from "@/api/routes"
import { reportError } from "@/lib/diag-log"
import {
  captureDiagnostic, createDiagnosticPublishAction, enterDiagnosticWorkflowRoute, getDiagnosticCopyData, getDiagnosticDetail,
  openDiagnosticPublishWindow, resumeErrorTelemetry, setErrorTelemetryContext,
} from "@/lib/error-telemetry"
import { normalizedProblem, v4Payload, type EventWire } from "@/lib/diagnostic-test-support"
import type { DiagnosticCaptureInput } from "@/lib/diagnostic-capture"

const previousFetch = globalThis.fetch
const previousLog = console.log
let leaveRoute: (() => void) | undefined

afterEach(() => {
  leaveRoute?.()
  leaveRoute = undefined
  setErrorTelemetryContext({ sessionKey: null })
  globalThis.fetch = previousFetch
  console.log = previousLog
})

/** `answer` plays the API; every inbox delivery is captured. */
function serve(answer: () => Response | Promise<Response>) {
  const events: EventWire[] = []
  const inboxBodies: string[] = []
  const requests: RequestInit[] = []
  console.log = () => {}
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== route("eventsInbox")) {
      assert.ok([route("listingSubmit"), route("listingSubmit")].includes(String(input)), `unexpected request: ${String(input)}`)
      assert.ok(init)
      requests.push(init)
      return answer()
    }
    assert.equal(init?.method, "POST")
    assert.equal(init?.credentials, "include")
    assert.equal(new Headers(init?.headers).get("Content-Type"), "application/json")
    inboxBodies.push(String(init?.body))
    const parsed = JSON.parse(String(init?.body)) as { events: EventWire[] }
    parsed.events.forEach(v4Payload)
    events.push(...parsed.events)
    return new Response(JSON.stringify({ data: { accepted: parsed.events.map((event) => event.id), rejected: [] } }))
  }) as typeof fetch
  setErrorTelemetryContext({ sessionKey: `test-${Math.random()}` })
  leaveRoute = enterDiagnosticWorkflowRoute()
  return { events, inboxBodies, requests }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } })
const flushed = () => new Promise((resolve) => setTimeout(resolve, 700))
async function publish(actionId = "explicit-report") {
  const action = createDiagnosticPublishAction(actionId)
  assert.ok(action)
  const window = openDiagnosticPublishWindow(action, new AbortController().signal)
  assert.ok(window)
  try { await window.flush() } finally { window.close() }
}
const ozonContext = (stage: string, offerId: string) => ({
  platform: "ozon", stage, rawPayload: { kind: "ozon_fields" as const, data: { offer_id: offerId } },
})

test("an explicit Ozon context stays local; normalized v4 uses the refusal trace and exact submitted body once", async () => {
  const { events, inboxBodies, requests } = serve(() => json(502, {
    code: "OZON_DOWN", error: "upstream said token=abc", ocrRecovery: { requestId: "ocr-business-123" },
  }, { "x-request-id": "Cloud-Trace_123", "Retry-After": "2" }))
  const item = { offer_id: "ART-001", name: "Картина", images: ["https://cdn.invalid/1.jpg"], api_key: "k" }
  const failure = await api.post(route("listingSubmit"), { storeId: "store-secret", rowIds: ["row-secret"] }, undefined, {
    platform: "ozon", stage: "submit", rawPayload: { kind: "ozon_fields", data: item },
  }).catch((reason: unknown) => reason) as CloudRefusal & { requestId?: string }
  assert.ok(failure instanceof Error)
  assert.equal(failure.code, "cloud_ozon_down")
  assert.equal(failure.serverCode, "OZON_DOWN")
  assert.equal(failure.status, 502)
  assert.equal(failure.retryAfterMs, 2_000)
  assert.equal(failure.traceId, "Cloud-Trace_123")
  assert.equal(failure.requestId, "ocr-business-123", "HTTP trace must not overwrite the OCR business ID")
  assert.equal(requests.length, 1)
  assert.equal(requests[0]!.method, "POST")
  assert.equal(requests[0]!.credentials, "include")
  assert.equal(new Headers(requests[0]!.headers).get("Content-Type"), "application/json")
  const submitted = String(requests[0]!.body)
  assert.equal(submitted, JSON.stringify({ storeId: "store-secret", rowIds: ["row-secret"] }))
  reportError("[listing-send]", failure, {}, { platform: "ozon", stage: "submit", rawPayload: null })
  await flushed()
  await publish("local-api-report")
  assert.equal(events.length, 0, "API/reportError metadata cannot create an event, even inside an explicit window")
  const input = normalizedProblem({
    code: "unclassified_server", traceEvidence: { requestHeaderTraceId: failure.traceId ?? null },
    exactOperation: { provenance: "submitted_http_body", jsonText: submitted },
  })
  const detail = await captureDiagnostic(input)
  assert.ok(detail)
  assert.equal((await captureDiagnostic(input))?.diagnosticId, detail.diagnosticId)
  assert.equal(getDiagnosticCopyData(detail.diagnosticId).originalJson, submitted)
  assert.equal(getDiagnosticCopyData(detail.diagnosticId).provenance, "submitted_http_body")
  assert.ok(!JSON.stringify(getDiagnosticDetail(detail.diagnosticId)).includes("store-secret"))
  assert.equal(events.length, 0)
  await publish()
  assert.equal(events.length, 1, "the same normalized problem is enqueued only once")
  const event = v4Payload(events[0]!)
  assert.deepEqual([event.platform, event.stage, event.field, event.code], ["ozon", "submit", null, "unclassified_server"])
  assert.equal(event.trace_id, failure.traceId)
  assert.equal(event.diagnostic_id, detail.diagnosticId)
  assert.equal(event.payload_sha256, createHash("sha256").update(submitted, "utf8").digest("hex"))
  assert.deepEqual(event.summary, [], "caller metadata is not substituted for the submitted body")
  assert.doesNotMatch(inboxBodies.join("\n"), /store-secret|row-secret|ART-001|Картина|token=abc|cdn\.invalid|api_key|ocr-business-123/)
})

test("a request without a diagnostic stays local; capture without exact text has null hash and empty summary", async () => {
  const { events, inboxBodies } = serve(() => json(500, { code: "BROKEN", error: "server said password=x" }))
  await assert.rejects(api.post(route("listingSubmit"), { offer_id: "ART-SECRET", name: "Картина" }))
  await flushed()
  assert.equal(events.length, 0)
  const detail = await captureDiagnostic(normalizedProblem({ code: "unclassified_server" }))
  assert.ok(detail)
  assert.equal(getDiagnosticCopyData(detail.diagnosticId).originalJson, null)
  assert.equal(detail.hasOriginal, false)
  assert.equal(detail.originalUnavailableReason, "no_exact_payload")
  resumeErrorTelemetry()
  await flushed()
  assert.equal(events.length, 0, "general resume cannot authorize a held diagnostic")
  await publish()
  assert.equal(events.length, 1)
  const payload = v4Payload(events[0]!)
  assert.equal(payload.payload_sha256, null)
  assert.deepEqual(payload.summary, [])
  assert.equal(payload.trace_id, payload.diagnostic_id)
  assert.doesNotMatch(inboxBodies.join("\n"), /ART-SECRET|Картина|password=x/)
})

test("transport and malformed 2xx failures remain local; normalized v4 preserves each failure and available trace", async () => {
  let malformed = false
  const { events, inboxBodies } = serve(() => {
    if (malformed) return new Response("{broken password=private-response", { status: 200, headers: { "x-request-id": "response-trace" } })
    throw new TypeError("network down")
  })
  const network = await api.post(route("listingSubmit"), {}, undefined, ozonContext("submit", "ART-NET")).catch((error: unknown) => error) as CloudRefusal
  assert.ok(network instanceof Error)
  assert.equal(network.code, "cloud_unavailable")
  assert.equal(network.traceId, undefined)
  malformed = true
  const response = await api.post(route("listingSubmit"), {}, undefined, ozonContext("readback", "ART-JSON")).catch((error: unknown) => error) as CloudRefusal
  assert.ok(response instanceof Error)
  assert.equal(response.code, "cloud_bad_response")
  assert.equal(response.status, 200)
  assert.equal(response.traceId, "response-trace")
  assert.doesNotMatch(response.message, /private-response|broken/)
  await flushed()
  assert.equal(events.length, 0)
  const ids: string[] = []
  for (const [code, stage, failure] of [["result_unknown", "submit", network], ["contract_violation", "reconcile", response]] as const) {
    const detail = await captureDiagnostic(normalizedProblem({ code, stage, traceEvidence: { requestHeaderTraceId: failure.traceId ?? null } }))
    assert.ok(detail)
    ids.push(detail.diagnosticId)
    assert.equal(getDiagnosticCopyData(detail.diagnosticId).originalJson, null)
  }
  assert.notEqual(ids[0], ids[1])
  await publish()
  assert.equal(events.length, 2)
  assert.deepEqual(
    events.map((event) => { const payload = v4Payload(event); return [payload.stage, payload.code, payload.trace_id, payload.payload_sha256, payload.summary] }),
    [["submit", "result_unknown", ids[0], null, []], ["reconcile", "contract_violation", "response-trace", null, []]],
  )
  assert.deepEqual(events.map((event) => event.id), ids)
  assert.doesNotMatch(inboxBodies.join("\n"), /ART-NET|ART-JSON|readback|private-response|network down|rawPayload/)
})

for (const [kind, answer] of [
  ["http", () => json(409, { code: "offer_busy", message: "refused" })],
  ["envelope", () => json(200, { malformed: true })],
  ["json", () => new Response("{broken")],
  ["network", () => { throw new TypeError("network down") }],
] as const) test(`caller-owned ${kind} failure stays local until explicit reportable normalization`, async () => {
  const { events, requests } = serve(answer)
  const failure = await request("POST", route("listingSubmit"), {}, { "Idempotency-Key": "caller-action-1" }, 50, undefined, { reportOwner: "caller" }).catch((error: unknown) => error) as CloudRefusal
  assert.ok(failure instanceof Error)
  assert.equal(failure.code, kind === "http" ? "cloud_offer_busy" : kind === "network" ? "cloud_unavailable" : "cloud_bad_response")
  assert.equal(requests.length, 1)
  assert.equal(new Headers(requests[0]!.headers).get("Idempotency-Key"), "caller-action-1")
  await flushed()
  assert.equal(events.length, 0)
  reportError("[normalized]", failure)
  reportError("[normalized]", failure)
  await flushed()
  assert.equal(events.length, 0, "reportError remains local regardless of report ownership")
  if (kind === "http") {
    assert.equal(await captureDiagnostic({ ...normalizedProblem(), code: "offer_busy" } as unknown as DiagnosticCaptureInput), null)
    await publish()
    assert.equal(events.length, 0, "known user-correctable refusals cannot become a reportable v4 code")
    return
  }
  const input = normalizedProblem({ code: kind === "network" ? "result_unknown" : "contract_violation" })
  const detail = await captureDiagnostic(input)
  assert.ok(detail)
  assert.equal((await captureDiagnostic(input))?.diagnosticId, detail.diagnosticId)
  assert.equal(events.length, 0)
  await publish()
  assert.equal(events.length, 1, "local logging cannot suppress the explicit normalized diagnostic")
  assert.equal(v4Payload(events[0]!).diagnostic_id, detail.diagnosticId)
})

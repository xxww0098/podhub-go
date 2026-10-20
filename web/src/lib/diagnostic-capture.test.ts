import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { createDiagnosticCapture, type DiagnosticCaptureInput } from "./diagnostic-capture"
import { createDiagnosticMemory } from "./diagnostic-memory"
import { diagnosticSha256, type DiagnosticEvent } from "./diagnostic-summary"
import { normalizedProblem, setupDiagnosticTelemetry, testId, v4Payload } from "./diagnostic-test-support"

const exact = (jsonText: string) => ({ provenance: "submitted_http_body" as const, jsonText })

test("trace priority is ListingIssue, then actual header, then the same local diagnostic UUID", async () => {
  const s = setupDiagnosticTelemetry()
  const first = await s.telemetry.capture(normalizedProblem({ traceEvidence: { listingIssueTraceId: "JOB.Trace-7", requestHeaderTraceId: "HTTP-8" } }))
  const second = await s.telemetry.capture(normalizedProblem({ traceEvidence: { listingIssueTraceId: "unsafe trace!", requestHeaderTraceId: "HTTP-8" } }))
  const third = await s.telemetry.capture(normalizedProblem())
  assert.equal(first?.event?.trace_id, "JOB.Trace-7")
  assert.equal(second?.event?.trace_id, "HTTP-8")
  assert.equal(third?.event?.trace_id, third?.diagnosticId)
})

test("same normalization object captures once; same trace and same hash do not swallow other problems", async () => {
  const s = setupDiagnosticTelemetry()
  const problem = normalizedProblem({ traceEvidence: { listingIssueTraceId: "same-trace" }, exactOperation: exact('{"name":"raw"}') })
  const first = await s.telemetry.capture(problem)
  assert.equal(await s.telemetry.capture(problem), first)
  const second = await s.telemetry.capture({ ...problem })
  const third = await s.telemetry.capture({ ...problem, exactOperation: exact('{"name":"other"}') })
  assert.notEqual(first?.diagnosticId, second?.diagnosticId)
  assert.equal(first?.event?.payload_sha256, second?.event?.payload_sha256)
  assert.notEqual(first?.event?.payload_sha256, third?.event?.payload_sha256)
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  assert.equal(s.calls[0]?.events.length, 3)
  for (const detail of [first, second, third]) assert.equal(s.telemetry.detail(detail!.diagnosticId).event?.trace_id, "same-trace")
})

test("exact owner text snapshots before hashing, and detail/copy/event share diagnostic and trace IDs", async () => {
  const s = setupDiagnosticTelemetry()
  const operation = { provenance: "native_freeze" as const, jsonText: ' {"name":"俄🐱文","token":"secret"} ' }
  const expected = operation.jsonText
  const pending = s.telemetry.capture(normalizedProblem({ exactOperation: operation, traceEvidence: { requestHeaderTraceId: "req-1" } }))
  operation.jsonText = '{"name":"mutated"}'
  const detail = (await pending)!
  assert.equal(detail.event?.payload_sha256, await diagnosticSha256(expected))
  assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, expected)
  assert.ok(!JSON.stringify(detail).includes("secret"))
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  const remote = JSON.parse(s.calls[0]!.events[0]!.payload_json)
  assert.equal(remote.diagnostic_id, detail.diagnosticId)
  assert.equal(remote.trace_id, s.telemetry.copyData(detail.diagnosticId).detail.event?.trace_id)
  assert.ok(!s.calls[0]!.events[0]!.payload_json.includes("secret"))
})

test("normalization logs the same diagnostic ID and trace as detail/copy without original text", async () => {
  const s = setupDiagnosticTelemetry()
  const originalLog = console.log
  const lines: string[] = []
  console.log = (line) => { lines.push(String(line)) }
  try {
    const detail = (await s.telemetry.capture(normalizedProblem({
      traceEvidence: { listingIssueTraceId: "safe-issue-trace" }, exactOperation: exact('{"name":"local-secret"}'),
    })))!
    assert.equal(lines.length, 1)
    assert.match(lines[0]!, new RegExp(`diagnosticId=${detail.diagnosticId} traceId=safe-issue-trace`))
    assert.equal(s.telemetry.copyData(detail.diagnosticId).detail.event?.trace_id, "safe-issue-trace")
    assert.ok(!lines[0]!.includes("local-secret"))
  } finally { console.log = originalLog }
})

test("a failing console sink cannot turn a retained diagnostic into a null normalization result", async () => {
  const s = setupDiagnosticTelemetry()
  const originalLog = console.log
  console.log = () => { throw new Error("unavailable console") }
  try {
    const detail = (await s.telemetry.capture(normalizedProblem()))!
    assert.ok(detail)
    assert.equal(s.telemetry.detail(detail.diagnosticId).event?.diagnostic_id, detail.diagnosticId)
  } finally { console.log = originalLog }
})

test("metadata/rawPayload/HTTP response objects are not exact text and cannot invent a hash", async () => {
  const s = setupDiagnosticTelemetry()
  for (const original of [
    { kind: "ozon_fields", data: { name: "secret" } }, { provenance: "http_response", jsonText: '{"name":"secret"}' },
    { provenance: "native_freeze", jsonText: { name: "secret" } },
  ]) {
    const detail = await s.telemetry.capture({ ...normalizedProblem(), exactOperation: original } as unknown as DiagnosticCaptureInput)
    assert.equal(detail?.event?.payload_sha256, null)
    assert.deepEqual(detail?.event?.summary, [])
    assert.equal(detail?.originalUnavailableReason, "no_exact_payload")
  }
})

test("hostile getters, revoked Proxies and cyclic objects never throw, stringify or leak", async () => {
  const s = setupDiagnosticTelemetry()
  let getters = 0
  const accessor = { get jsonText() { getters++; throw new Error("secret") }, provenance: "native_freeze" }
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
  const trap = new Proxy({}, { get() { throw new Error("secret") }, getOwnPropertyDescriptor() { throw new Error("secret") } })
  const revoked = Proxy.revocable({}, {}); revoked.revoke()
  for (const original of [accessor, cyclic, trap, revoked.proxy]) {
    const detail = await s.telemetry.capture({ ...normalizedProblem(), exactOperation: original } as unknown as DiagnosticCaptureInput)
    assert.equal(detail?.event?.payload_sha256, null)
  }
  assert.equal(getters, 0)
  for (const input of [trap, revoked.proxy, null, 4]) assert.equal(await s.telemetry.capture(input as DiagnosticCaptureInput), null)
})

test("unknown categories, stages and unsafe coordinates are rejected instead of disguised as reportable", async () => {
  const s = setupDiagnosticTelemetry()
  for (const invalid of [{ code: "schema_stale" }, { code: "not_enabled" }, { stage: "runtime" }, { field: "token" }, { platform: "https://evil.invalid" }]) {
    assert.equal(await s.telemetry.capture({ ...normalizedProblem(), ...invalid } as DiagnosticCaptureInput), null)
  }
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  assert.equal(s.calls.length, 0)
})

test("logout fences asynchronous hash completion and clears originals without persistent storage", async () => {
  let generation = 0
  let finish!: (hash: string) => void
  const memory = createDiagnosticMemory()
  const events: DiagnosticEvent[] = []
  const capture = createDiagnosticCapture({ memory, generation: () => generation, enqueue: (event) => events.push(event), uuid: () => testId(1), digest: () => new Promise((resolve) => { finish = resolve }) })
  const pending = capture(normalizedProblem({ exactOperation: exact('{"name":"secret"}') }))
  generation++; memory.clear(); finish("a".repeat(64))
  assert.equal(await pending, null)
  assert.deepEqual(events, [])
  assert.equal(memory.copyData(testId(1)).originalJson, null)
  const s = setupDiagnosticTelemetry()
  const detail = (await s.telemetry.capture(normalizedProblem({ exactOperation: exact('{"name":"secret"}') })))!
  s.telemetry.setContext({ sessionKey: null })
  assert.equal(s.telemetry.detail(detail.diagnosticId).event, null)
  assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, null)
  assert.equal(await s.telemetry.capture(normalizedProblem()), null)
})

test("oversize payload still hashes the entire original and exposes an explicit unavailable reason", async () => {
  const s = setupDiagnosticTelemetry()
  const text = '{"name":"' + "x".repeat(8 * 1024 * 1024) + '"}'
  const detail = (await s.telemetry.capture(normalizedProblem({ exactOperation: exact(text) })))!
  assert.equal(detail.event?.payload_sha256, await diagnosticSha256(text))
  assert.equal(detail.originalUnavailableReason, "oversize")
  assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, null)
})

test("digest failure returns no partial transport event or original memory entry", async () => {
  const memory = createDiagnosticMemory()
  const events: DiagnosticEvent[] = []
  const capture = createDiagnosticCapture({ memory, generation: () => 0, enqueue: (event) => events.push(event), uuid: () => testId(1), digest: async () => { throw new Error("secret") } })
  assert.equal(await capture(normalizedProblem({ exactOperation: exact("{}") })), null)
  assert.deepEqual(events, [])
  assert.equal(memory.detail(testId(1)).event, null)
})

test("literal address injection stays only in the exact local original; v4 keeps its full UTF8 hash and unique native summary", async () => {
  const s = setupDiagnosticTelemetry()
  const text = ' \n{"name":"俄🐱","name.value":"private value","attributes[0].id":7654321,"attributes":[{"id":85,"id.value":8765432}]}\n'
  const detail = await s.telemetry.capture(normalizedProblem({ exactOperation: exact(text) }))
  assert.ok(detail)
  assert.equal(s.telemetry.copyData(detail.diagnosticId).originalJson, text)
  s.telemetry.enterWorkflowRoute()
  await s.open().window.flush()
  const wire = s.calls[0]!.events[0]!
  const remote = v4Payload(wire)
  assert.equal(remote.payload_sha256, createHash("sha256").update(text, "utf8").digest("hex"))
  assert.equal(remote.payload_sha256, detail.event?.payload_sha256)
  assert.deepEqual(remote.summary.map((field) => field.field), ["name", "attributes", "attributes[0]", "attributes[0].id"])
  assert.equal(new Set(remote.summary.map((field) => field.field)).size, remote.summary.length)
  assert.deepEqual(remote.summary.filter((field) => field.field_id !== null).map((field) => field.field_id), [85])
  assert.equal(remote.summary[0]!.length, 2)
  assert.doesNotMatch(wire.payload_json, /7654321|8765432|private value|name\.value|id\.value|俄/)
})

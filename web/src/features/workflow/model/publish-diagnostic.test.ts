import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import { getDiagnosticCopyData, getDiagnosticDetail, setErrorTelemetryContext } from "@/lib/error-telemetry"
import { capturePublishDiagnostic, diagnosticReferenceFrom, normalizePublishDiagnostic } from "./publish-diagnostic"
import { nativeSolutions, publishSolutions, resolvePublishSolution, type Solution } from "./publish-solutions"
import { resolvePublishRemediation } from "./publish-remediation"

test("local diagnostic references reject inherited or malformed IDs without executing accessors", () => {
  const id = "12345678-1234-1234-1234-123456789abc"
  let reads = 0
  const accessor = { get publishDiagnostic() { reads++; return { diagnosticId: id } } }
  assert.equal(diagnosticReferenceFrom(accessor), undefined)
  assert.equal(diagnosticReferenceFrom({ publishDiagnostic: { get diagnosticId() { reads++; return id } } }), undefined)
  assert.equal(diagnosticReferenceFrom(Object.create({ publishDiagnostic: { diagnosticId: id } })), undefined)
  assert.equal(diagnosticReferenceFrom({ publishDiagnostic: Object.create({ diagnosticId: id }) }), undefined)
  assert.equal(diagnosticReferenceFrom({ publishDiagnostic: { diagnosticId: "not-a-uuid" } }), undefined)
  assert.deepEqual(diagnosticReferenceFrom({ publishDiagnostic: { diagnosticId: id, traceId: "unsafe:trace" } }),
    { eventKey: id, diagnosticId: id })
  assert.deepEqual(diagnosticReferenceFrom({ publishDiagnostic: { diagnosticId: id, traceId: "safe-trace" } }),
    { eventKey: id, diagnosticId: id, traceId: "safe-trace" })
  assert.equal(reads, 0)
})

test("the entire canonical native and wire tables alone determine diagnostic categories; user problems capture zero", async () => {
  const before = globalThis.fetch
  let requests = 0, technical = 0, user = 0
  globalThis.fetch = async () => { requests++; throw new Error("normalization cannot deliver") }
  setErrorTelemetryContext({ sessionKey: "canonical-producer-test" })
  try {
    for (const [platform, stages] of Object.entries(nativeSolutions)) {
      for (const [stage, codes] of Object.entries(stages)) for (const [code, solution] of Object.entries<Solution>(codes)) {
        const problem = { platform, stage, code }
        const input = normalizePublishDiagnostic(problem)
        assert.equal(input?.code ?? null, solution.diagnosticCode)
        assert.equal(solution.reportable, solution.diagnosticCode !== null)
        const detail = await capturePublishDiagnostic(problem)
        if (solution.diagnosticCode) {
          technical++
          assert.equal(detail?.event?.code, solution.diagnosticCode)
          assert.equal(detail?.event?.payload_sha256, null)
          assert.deepEqual(detail?.event?.summary, [])
        } else { user++; assert.equal(detail, null) }
      }
    }
    for (const table of Object.values(publishSolutions)) for (const solution of Object.values(table)) {
      assert.equal(solution.reportable, solution.diagnosticCode !== null)
    }
    assert.ok(technical > 0 && user > 40)
    assert.equal(await capturePublishDiagnostic({ platform: "wb", stage: "submit", family: "control", code: "not_enabled" }), null)
    assert.equal(requests, 0)
  } finally { setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = before }
})

test("native throws, unknown external tuples, internal responses and uncertain sends use the canonical actionless categories", () => {
  const inputs = [
    { platform: "ozon", stage: "freeze", code: "core_unavailable" },
    { platform: "wb", stage: "preview", family: "control" as const, code: "wasm_failed" },
    { platform: "ozon", stage: "validate", code: "unknown-external" },
    { platform: "ozon", stage: "pre_dispatch", family: "request" as const, code: "internal" },
    { platform: "ozon", stage: "submit", family: "control" as const, code: "result_unconfirmed" },
  ]
  assert.deepEqual(inputs.map((problem) => normalizePublishDiagnostic(problem)?.code),
    ["wasm_exception", "wasm_exception", "contract_violation", "unclassified_server", "result_unknown"])
  for (const problem of inputs) {
    assert.equal(resolvePublishRemediation(problem)?.action, undefined)
    assert.deepEqual(resolvePublishSolution(problem).actions, [])
  }
})

test("whole exact Native and HTTP source bytes hash past the old cutoff; trace is identical in console, detail, copy and event", async () => {
  const logBefore = console.log
  const lines: string[] = []
  console.log = (line) => { lines.push(String(line)) }
  setErrorTelemetryContext({ sessionKey: "exact-source-test" })
  try {
    const prefix = "私有商品原文".repeat(12_000)
    const raw = ' { "name": "' + prefix + 'A", "currency_code": "RUB" }\n'
    const different = raw.replace('A"', 'B"')
    const problem = { platform: "ozon", stage: "freeze", code: "core_unavailable", traceId: "issue-trace" }
    const a = await capturePublishDiagnostic(problem, { exactOperation: { provenance: "native_freeze", jsonText: raw },
      traceEvidence: { requestHeaderTraceId: "http-trace" } })
    const b = await capturePublishDiagnostic(problem, { exactOperation: { provenance: "submitted_http_body", jsonText: different } })
    assert.ok(a?.event && b?.event)
    assert.notEqual(a.diagnosticId, b.diagnosticId, "distinct normalized problems sharing a trace own different IDs")
    assert.equal(a.event.trace_id, "issue-trace")
    assert.equal(b.event.trace_id, "issue-trace")
    assert.equal(a.event.payload_sha256, createHash("sha256").update(raw).digest("hex"))
    assert.notEqual(a.event.payload_sha256, b.event.payload_sha256)
    assert.equal(getDiagnosticDetail(a.diagnosticId).event?.trace_id, a.event.trace_id)
    const copied = getDiagnosticCopyData(a.diagnosticId)
    assert.equal(copied.detail.event?.diagnostic_id, a.diagnosticId)
    assert.equal(copied.detail.event?.payload_sha256, a.event.payload_sha256)
    assert.equal(copied.originalJson, raw)
    assert.equal(copied.provenance, "native_freeze")
    assert.ok(lines.some((line) => line.includes(a.diagnosticId) && line.includes("traceId=issue-trace")))
    assert.doesNotMatch(JSON.stringify(a) + lines.join(""), /私有商品原文/)
    const header = await capturePublishDiagnostic({ platform: "ozon", stage: "submit", family: "control", code: "result_unconfirmed" },
      { traceEvidence: { requestHeaderTraceId: "http-trace" } })
    assert.equal(header?.event?.trace_id, "http-trace")
    const local = await capturePublishDiagnostic({ platform: "wb", stage: "preview", family: "control", code: "wasm_failed" })
    assert.equal(local?.event?.trace_id, local?.diagnosticId)
    assert.deepEqual(local?.event?.summary, [])
  } finally { setErrorTelemetryContext({ sessionKey: null }); console.log = logBefore }
})

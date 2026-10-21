import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import type { components } from "@/api/schema"
import { request } from "@/api/client"
import { route } from "@/api/routes"
import { toast } from "@/components/ui/toast"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { getDiagnosticCopyData, getDiagnosticDetail, queueErrorTelemetry, resumeErrorTelemetry, setErrorTelemetryContext } from "@/lib/error-telemetry"
import { reportError } from "@/lib/diag-log"
import { notifyCommandError } from "@/lib/notify"
import { ERROR_FEEDBACK_KEYS } from "@/lib/error-feedback-reporting"
import { safeUserAgent } from "@/lib/error-report-environment"
import { diagnosticReferenceFrom } from "../model/publish-diagnostic"
import { createOzonAdapter } from "../platforms/ozon"
import { createPublishDiagnosticOperation } from "./queue/diagnostics"
import { createPublishDiagnosticRoute } from "./use-publish-diagnostics"
import { submitOzonChunk, type OzonSendContext } from "./send-ozon-transport"
import { golden, goldenSchema, nativeCardPayload, nativePayload, warmProductionSend, wasmCore } from "./send-test-support"
import { cloudRow, product } from "../cloud-fanout-tests/fixtures"
import { capturePublishQueue } from "../cloud-fanout-tests/publish-queue-harness"
import { currentWorkbenchDiagnostic } from "../workbench/publish-diagnostic-producer"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"

type InboxEvent = { id: string; kind: string; schema_version: number; payload_json: string }
function assertFeedbackEvent(event: InboxEvent) {
  assert.equal(event.kind, "error_feedback.v1")
  assert.equal(event.schema_version, 1)
  assert.match(event.id, /^[0-9]{20}$/)
  const payload = JSON.parse(event.payload_json)
  assert.equal(payload.errorId, event.id)
  assert.ok(Object.keys(payload).every(key => (ERROR_FEEDBACK_KEYS as readonly string[]).includes(key)))
  const agent = safeUserAgent(globalThis.navigator?.userAgent)
  if (agent) assert.equal(payload.userAgent, agent)
  for (const key of ["appVersion", "userId", "workspaceId", "userAgent"]) delete payload[key]
  return payload
}

const issue: components["schemas"]["ListingIssue"] = {
  allowed_actions: [], code: "OZON_ACCESS_UNCLASSIFIED", created_at_ms: 1, credential_revision: 1,
  dispatch_evidence: "rejected", endpoint: "import", input_revision: 9, intent_id: "intent-a",
  phase: "submit", remediation: "Cloud 核对步骤", request_hash: "digest", retry_after_fallback: false,
  row_id: "a", safe_message: "", scope: "store", store_id: "store", summary: "Cloud 未分类原因", trace_id: "issue-trace",
}

test("actual workbench hook reaches dispatch through workflowSend, native freeze and legacy HTTP with the same producer and reference", async () => {
  await warmProductionSend()
  resetListingWorkbench()
  const row = cloudRow("hook-diagnostic")
  const hook = capturePublishQueue()
  rememberListingRows([row], rowCacheScope())
  patchListingWorkbench({ cardId: "card", productDrafts: { [row.id]: product(row.id) }, rows: [{ id: row.id, draftId: row.id,
    imageName: row.source.fileName, stage: "ready_to_publish", status: "ready", ai: "done", render: "done", upload: "done", log: "" }] })
  const owner = createPublishDiagnosticRoute(() => true)
  const original = globalThis.fetch, previousToast = toast.add
  const rawCard = { id: "card", revision: 1, title: "Test", store_id: "store", payload: nativeCardPayload(), updated_at_ms: 1 }
  const calls: string[] = [], inboxEvents: InboxEvent[] = []
  let submittedBody = ""
  setErrorTelemetryContext({ sessionKey: "actual-hook-dispatch" })
  toast.add = () => "hook-diagnostic-notice"
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === route("eventsInbox")) {
      const events = JSON.parse(String(init?.body)).events as InboxEvent[]
      inboxEvents.push(...events)
      return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
    }
    if (url === route("listingCardsById", { id: "card" })) return Response.json({ data: init?.method === "PATCH"
      ? { ...rawCard, revision: 2, payload: JSON.parse(String(init.body)).payload } : rawCard })
    if (url.startsWith(`${route("listingRows")}?`)) return Response.json({ data: { items: [row], nextCursor: null } })
    assert.equal(url, route("listingSubmit"))
    submittedBody = String(init?.body)
    throw new TypeError("mock submitted response lost")
  }
  try {
    owner.enter()
    await hook.startPublish([row.id])
    await new Promise((resolve) => setTimeout(resolve, 0))
    const state = peekListingWorkbench(), current = state.rows[0]!
    assert.equal(current.status, "exception")
    assert.equal(current.publishUnconfirmed, true)
    assert.equal(state.productBases[row.id]!.lifecycle.stage, "outcome_unknown")
    const ref = currentWorkbenchDiagnostic(current)
    assert.ok(ref?.diagnosticId)
    const copied = getDiagnosticCopyData(ref.diagnosticId)
    assert.deepEqual(JSON.parse(submittedBody), { store_id: "store", row_ids: [row.id],
      expected_revisions: [{ row_id: row.id, revision: 1 }] })
    assert.equal(copied.originalJson, submittedBody)
    assert.equal(copied.provenance, "submitted_http_body")
    assert.equal(copied.detail.event?.code, "result_unknown")
    const diagnostics = inboxEvents.filter(event => event.kind === "desktop_error_log.v4")
    const receipts = inboxEvents.filter(event => event.kind === "error_feedback.v1")
    assert.equal(inboxEvents.length, diagnostics.length + receipts.length, "only the two declared telemetry protocols are admitted")
    assert.equal(receipts.length, 2, "one row receipt and one batch notice receipt, separate from v4")
    const rowReceipt = receipts.find(event => event.id === ref.errorFeedback?.errorId)
    assert.ok(rowReceipt)
    assert.deepEqual(assertFeedbackEvent(rowReceipt), { errorId: ref.errorFeedback!.errorId,
      code: "outcome_unknown", stage: "submit", rowId: row.id, cardId: "card" })
    const noticeReceipt = receipts.find(event => event !== rowReceipt)!
    assert.equal(assertFeedbackEvent(noticeReceipt).code, "cloud_unavailable")
    assert.equal(diagnostics.length, 1, "normal projection must reuse the transport's normalized event, not recapture it")
    assert.equal(diagnostics[0]!.id, ref.diagnosticId)
    assert.equal(JSON.parse(diagnostics[0]!.payload_json).trace_id, copied.detail.event!.trace_id)
    assert.equal(calls.filter((url) => url === route("listingSubmit")).length, 1)
    assert.equal(calls.some((url) => /cancel|release|listing\/intents/.test(url)), false)
    const callCount = calls.length
    await hook.startPublish([row.id])
    assert.equal(calls.length, callCount, "explicit repeat remains locally fenced")
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = previousToast; resetListingWorkbench(); invalidateAllSessionCaches() }
})
async function frozen() {
  const core = await wasmCore(), handle = core.loadSchema({ snapshot: goldenSchema })
  try {
    const built = await createOzonAdapter(core).build({ schemaHandle: handle, card: golden.card, nowMs: Date.now(),
      rows: ["a", "b"].map((rowId) => ({ rowId, storeId: "store", row: nativePayload(rowId) })) })
    assert.deepEqual(built.blocked, [], "the real compiled native freeze must admit the fixture")
    return built.frozen
  } finally { core.dropSchema(handle) }
}
function context(): OzonSendContext {
  return { storeId: "store", pins: new Map(["a", "b"].map((id) => [id, { revision: 9 }])),
    shouldStop: () => false, results: new Map(), syncRequired: false, replayed: false }
}

test("compiled legacy freeze and real HTTP normalization share exact bytes, Cloud-first trace and safe references; only explicit report delivers held events", async () => {
  const items = await frozen(), original = globalThis.fetch, previousToast = toast.add
  const calls: string[] = [], delivered: string[] = []
  let body = ""
  const owner = createPublishDiagnosticRoute(() => true)
  setErrorTelemetryContext({ sessionKey: "legacy-normalized-integration" })
  toast.add = () => "diagnostic-test"
  globalThis.fetch = async (input, init) => {
    calls.push(String(input))
    if (String(input) === route("eventsInbox")) {
      const batch = JSON.parse(String(init?.body)).events as Array<{ id: string; payload_json: string }>
      delivered.push(...batch.map((entry) => entry.payload_json))
      return Response.json({ data: { accepted: batch.map((entry) => entry.id), rejected: [] } })
    }
    assert.equal(String(input), route("listingSubmit"))
    body = String(init?.body)
    return Response.json({ data: { items: items.map((item) => ({ row_id: item.key, created: false, skipped: "blocked",
      intent: { id: "intent-" + item.key, listing_row_id: item.key, store_id: "store", row_revision: 9, client_operation_id: "server-" + item.key,
        state: "rejected", can_resume: false, current_issue_status: "present", current_issue: { ...issue, row_id: item.key },
        submission_issues: [{ ...issue, row_id: item.key }], external_task_id: null, submission_receipt_status: "absent", updated_at_ms: 1 } })) } },
      { headers: { "x-request-id": "http-trace" } })
  }
  try {
    const sending = context()
    await submitOzonChunk(sending, items)
    assert.deepEqual(JSON.parse(body), { store_id: "store", row_ids: ["a", "b"],
      expected_revisions: [{ row_id: "a", revision: 9 }, { row_id: "b", revision: 9 }] })
    const references = ["a", "b"].map((id) => diagnosticReferenceFrom(sending.results.get(id)))
    assert.ok(references[0]?.diagnosticId && references[1]?.diagnosticId)
    assert.notEqual(references[0].diagnosticId, references[1].diagnosticId)
    for (const ref of references) {
      const copied = getDiagnosticCopyData(ref!.diagnosticId!)
      assert.equal(copied.originalJson, body, "the SAME string handed to fetch, not native preview or response")
      assert.equal(copied.provenance, "submitted_http_body")
      assert.equal(copied.detail.event?.trace_id, "issue-trace")
      assert.equal(copied.detail.event?.payload_sha256, createHash("sha256").update(body).digest("hex"))
      assert.equal(getDiagnosticDetail(ref!.diagnosticId!).event?.diagnostic_id, ref!.diagnosticId)
      assert.equal(JSON.stringify([...sending.results.values()]).includes(body), false)
    }
    resumeErrorTelemetry()
    assert.deepEqual(calls, [route("listingSubmit")], "normalization and general recovery retain held events")
    owner.enter()
    assert.equal(await owner.report(references[0].diagnosticId), true)
    assert.equal(delivered.length, 2)
    for (const payload of delivered) {
      const remote = JSON.parse(payload)
      assert.equal(remote.code, "unclassified_server")
      assert.equal(remote.trace_id, "issue-trace")
      assert.ok(references.some((ref) => ref!.diagnosticId === remote.diagnostic_id))
      assert.doesNotMatch(payload, /Cloud 未分类原因|Cloud 核对步骤|原文|originalJson|clientOperationId|intent-a/)
    }
    assert.equal(calls.filter((url) => url === route("listingSubmit")).length, 1, "report cannot resend or release")
  } finally { owner.leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = previousToast }
})

for (const code of ["offer_busy", "validation", "media_confirmation_required"] as const) {
  test(`real legacy ${code} refusal remains a user solution with zero diagnostic delivery or capture`, async () => {
    const items = await frozen(), original = globalThis.fetch
    let calls = 0
    setErrorTelemetryContext({ sessionKey: "known-" + code })
    globalThis.fetch = async (input) => {
      calls++
      assert.equal(String(input), route("listingSubmit"))
      return Response.json({ code, message: "media.steps[0] removable-media cause" }, { status: code === "offer_busy" ? 409 : 400 })
    }
    try {
      const sending = context()
      await submitOzonChunk(sending, items)
      for (const row of sending.results.values()) assert.equal(row.publishDiagnostic, undefined)
      assert.equal(calls, 1)
    } finally { setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original }
  })
}

test("actual HTTP body hashes its complete suffix; notify sends only safe receipts while low-level paths retain diagnostics", async () => {
  const original = globalThis.fetch, previousToast = toast.add, beforeLog = console.log
  const bodies: string[] = []
  const receipts: InboxEvent[] = []
  const lines: string[] = []
  setErrorTelemetryContext({ sessionKey: "raw-api-normalization" })
  toast.add = () => "local-test"
  console.log = (value) => { lines.push(String(value)) }
  globalThis.fetch = async (input, init) => {
    if (String(input) === route("eventsInbox")) {
      const events: InboxEvent[] = JSON.parse(String(init?.body)).events
      for (const event of events) assertFeedbackEvent(event)
      receipts.push(...events)
      return Response.json({ data: { accepted: events.map(event => event.id), rejected: [] } })
    }
    assert.equal(String(input), route("listingSubmit"))
    bodies.push(String(init?.body))
    return Response.json({ code: "internal", message: "RAW_RESPONSE_MUST_NOT_LEAK" }, { status: 500 })
  }
  try {
    const details = []
    for (const suffix of ["A", "B"]) {
      const operation = createPublishDiagnosticOperation()
      const body = { name: "PRIVATE_ORIGINAL".repeat(12_000) + suffix, currency_code: "RUB" }
      await assert.rejects(request("POST", route("listingSubmit"), body, {}, undefined, undefined,
        { onEvidence: operation.onEvidence, onDispatch: operation.onDispatch }))
      notifyCommandError({ code: "internal" }, "请核对原店铺记录")
      reportError("[test-global]", new Error("RAW_EXCEPTION_MUST_NOT_LEAK"))
      queueErrorTelemetry({ code: "internal", frames: [], severity: "blocking", source: "renderer_uncaught" })
      resumeErrorTelemetry()
      const detail = await operation.capture({ platform: "ozon", stage: "pre_dispatch", family: "request", code: "internal" })
      operation.clear()
      assert.ok(detail?.event)
      details.push(detail)
    }
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(receipts.length, 1, "duplicate notices reuse the same safe receipt")
    assert.equal(assertFeedbackEvent(receipts[0]!).code, "internal")
    assert.doesNotMatch(JSON.stringify(receipts), /PRIVATE_ORIGINAL|RAW_RESPONSE_MUST_NOT_LEAK|RAW_EXCEPTION_MUST_NOT_LEAK/)
    assert.equal(bodies.length, 2, "only the two explicitly mocked business HTTP requests")
    assert.notEqual(details[0]!.event!.payload_sha256, details[1]!.event!.payload_sha256)
    for (let i = 0; i < 2; i++) {
      assert.equal(details[i]!.event!.payload_sha256, createHash("sha256").update(bodies[i]!).digest("hex"))
      assert.equal(getDiagnosticCopyData(details[i]!.diagnosticId).originalJson, bodies[i])
      assert.equal(details[i]!.event!.trace_id, details[i]!.diagnosticId, "no HTTP trace means the local diagnostic UUID")
    }
    assert.doesNotMatch(JSON.stringify(details) + lines.join("\n"), /PRIVATE_ORIGINAL|RAW_RESPONSE_MUST_NOT_LEAK|RAW_EXCEPTION_MUST_NOT_LEAK/)
  } finally { setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; toast.add = previousToast; console.log = beforeLog }
})

test("exact HTTP hash completion cannot return a reference after the actual workbench row revision advances", async () => {
  const original = globalThis.fetch
  resetListingWorkbench()
  patchListingWorkbench({ cardId: "card", productDrafts: { row: product("row") } })
  const initial = peekListingWorkbench(), revision = initial.productBases.row!.lifecycle.revision
  const operation = createPublishDiagnosticOperation({ action: null, onDispatch() {}, current() {
    const state = peekListingWorkbench()
    return state.scope === initial.scope && state.cardId === "card" && state.productBases.row?.lifecycle.revision === revision
  } })
  let actualBody = "", calls = 0
  setErrorTelemetryContext({ sessionKey: "pending-exact-http-hash" })
  globalThis.fetch = async (_input, init) => {
    calls++; actualBody = String(init?.body)
    return Response.json({ code: "internal", message: "private server exception" }, { status: 500 })
  }
  try {
    await assert.rejects(request("POST", route("listingSubmit"), { name: "EXACT_PRIVATE_BODY".repeat(12_000) }, {}, undefined, undefined,
      { reportOwner: "caller", onDispatch: operation.onDispatch, onEvidence: operation.onEvidence }))
    assert.ok(actualBody.length > 128_000)
    const pending = operation.capture({ platform: "ozon", stage: "pre_dispatch", family: "request", code: "internal" })
    const base = peekListingWorkbench().productBases.row!
    patchListingWorkbench({ productDrafts: { row: { ...base, lifecycle: { ...base.lifecycle, revision: revision + 1 } } } })
    assert.equal(await pending, null)
    assert.equal(calls, 1, "hash completion cannot open a window or request another operation")
    assert.equal(peekListingWorkbench().rows.some((row) => row.publishDiagnostic?.diagnosticId), false)
  } finally { operation.clear(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; resetListingWorkbench() }
})

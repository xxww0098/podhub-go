import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import { capturePublishDiagnostic } from "../model/publish-diagnostic"
import { createOzonSendCapability } from "../platforms/ozon"
import type { SendCapability } from "./queue/types"
import { currentLocalPublishDiagnostic } from "./queue/diagnostics"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, golden, goldenSchema, nativePayload, wasmCore } from "./send-test-support"
import { enterDiagnosticWorkflowRoute, getDiagnosticCopyData, openDiagnosticPublishWindow, resumeErrorTelemetry, setErrorTelemetryContext } from "@/lib/error-telemetry"

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
async function fixture(count = 1) {
  const fx = await finalQueueHarness(count)
  for (const row of fx.rows.all()) fx.rows.update(row.id, (current) => ({ ...current, row: nativePayload(row.id) }))
  const core = await wasmCore(), handle = core.loadSchema({ snapshot: goldenSchema })
  const capability = createOzonSendCapability({ core, schemaHandle: () => handle, card: () => golden.card, cardId: fx.scope.cardId })
  return { ...fx, capability, dispose: async () => { core.dropSchema(handle); await fx.rows.close() } }
}
function acknowledge(init?: RequestInit) {
  const events = JSON.parse(String(init?.body)).events as Array<{ id: string }>
  return Response.json({ data: { accepted: events.map((event) => event.id), rejected: [] } })
}

test("real compiled S16 dispatch keeps the 150-second HTTP alive on Stop; its late exact-body Unknown stays held and restored action cannot remint", async () => {
  const fx = await fixture(2), started = deferred(), response = deferred(), original = globalThis.fetch
  const signals: AbortSignal[] = [], bodies: string[] = []
  let inbox = 0
  setErrorTelemetryContext({ sessionKey: "s16-stop-diagnostics" })
  const leave = enterDiagnosticWorkflowRoute()
  globalThis.fetch = async (input, init) => {
    if (String(input) === route("eventsInbox")) { inbox++; return acknowledge(init) }
    assert.equal(String(input), route("listingSubmit"))
    signals.push(init!.signal!)
    bodies.push(String(init!.body))
    started.resolve()
    if (bodies.length === 1) await response.promise
    throw new TypeError("mock HTTP response lost after commit")
  }
  const options = { rows: fx.rows, ...fx.scope, current: () => true, capabilities: { ozon: fx.capability } }
  const queue = createSendQueue(options)
  try {
    const before = Date.now()
    const pending = queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    await started.promise
    const deadlines = queue.snapshot().deadlines
    assert.ok(deadlines[0]! >= before + 150_000)
    assert.ok(deadlines[0]! <= Date.now() + 150_000)
    const actionId = fx.rows.cardState()!.publish!.actionId
    queue.stop(); queue.stop()
    assert.equal(signals[0]!.aborted, false)
    assert.deepEqual(queue.snapshot().deadlines, deadlines)
    assert.equal(queue.continue(), pending)
    assert.equal(bodies.length, 1)
    response.resolve(); await pending
    assert.equal(fx.rows.get("r0")!.submission!.state, "unconfirmed")
    const reference = currentLocalPublishDiagnostic(fx.rows.get("r0")!)
    assert.ok(reference?.diagnosticId)
    const copied = getDiagnosticCopyData(reference.diagnosticId)
    assert.equal(copied.originalJson, bodies[0])
    assert.equal(copied.detail.event?.code, "result_unknown")
    assert.equal(copied.provenance, "submitted_http_body")
    assert.equal(inbox, 0, "Stop closes only diagnostics; the late result cannot reopen its action")
    assert.equal(fx.rows.get("r1")!.submission, undefined)
    assert.ok(fx.rows.cardState()!.publish!.locks.some((lock) => lock.rowId === "r0" && lock.state === "unknown"))
    await queue.continue()
    assert.equal(bodies.length, 1, "Unknown is never automatically queried/retried/released")
    fx.rows.update("r1", (row) => ({ ...row, storeId: "s2" }))
    await fx.rows.flush()
    const restored = createSendQueue(options)
    await restored.start([{ platform: "ozon", destination: "s2", rowIds: ["r1"] }])
    assert.equal(fx.rows.cardState()!.publish!.actionId, actionId)
    assert.equal(fx.rows.get("r1")!.submission!.sendActionId, actionId)
    assert.equal(bodies.length, 2, "only the separate explicit action on another row may submit")
    resumeErrorTelemetry()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(inbox, 0, "restoring the existing action or general resume grants no new window")
    assert.doesNotMatch(JSON.stringify(await fx.repo.rowsOfCard(fx.scope.workspaceUuid, fx.scope.cardId)), /originalJson|jsonText|publishAction/)
  } finally { response.resolve(); queue.stop(); leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; await fx.dispose() }
})

test("actual S16 store-busy retries preserve one token and parent credits; window is opened only by the shared HTTP dispatch port", async () => {
  const fx = await fixture(), original = globalThis.fetch
  let submit = 0, inbox = 0, clock = Date.now()
  const contexts: Array<NonNullable<Parameters<SendCapability["send"]>[2]["diagnostics"]>> = []
  const capability: SendCapability = { ...fx.capability, async send(destination, items, request) {
    if (submit === 0) assert.equal(inbox, 0, "entering send is still before actual HTTP dispatch")
    assert.ok(request.diagnostics)
    contexts.push(request.diagnostics)
    return fx.capability.send(destination, items, request)
  } }
  setErrorTelemetryContext({ sessionKey: "s16-busy-action" })
  const leave = enterDiagnosticWorkflowRoute()
  globalThis.fetch = async (input, init) => {
    if (String(input) === route("eventsInbox")) { inbox++; return acknowledge(init) }
    assert.equal(String(input), route("listingSubmit"))
    submit++
    if (submit < 3) return Response.json({ code: "store_busy", message: "store occupied" }, { status: 409 })
    return Response.json({ data: { server_schema_revision: goldenSchema.schema_revision, items: [{ row_id: "r0", outcome: "created",
      intent: { id: "intent-r0", listing_row_id: "r0", store_id: "s1", row_revision: 1, client_operation_id: "server-r0", state: "queued",
        can_resume: false, current_issue_status: "absent", submission_issues: [], external_task_id: null, submission_receipt_status: "absent", updated_at_ms: 1 } }] } })
  }
  const queue = createSendQueue({ rows: fx.rows, ...fx.scope, current: () => true, capabilities: { ozon: capability },
    now: () => clock, wait: async (ms) => { clock += ms; await new Promise((resolve) => setTimeout(resolve, 0)) } })
  try {
    await capturePublishDiagnostic({ platform: "ozon", stage: "freeze", code: "core_unavailable" })
    assert.equal(inbox, 0, "the preparation event is held before real dispatch")
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    assert.equal(submit, 3)
    assert.equal(inbox, 1, "one existing held queue is claimed by the first HTTP dispatch")
    assert.ok(contexts[0]!.action)
    assert.ok(contexts.every((context) => context === contexts[0]))
    assert.equal(contexts[0]!.action!.actionId, fx.rows.cardState()!.publish!.actionId)
    assert.equal(openDiagnosticPublishWindow(contexts[0]!.action!, new AbortController().signal), null)
    assert.equal(fx.rows.cardState()!.publish!.blocks[0]!.budget.submits, 3)
    assert.equal(fx.rows.get("r0")!.submission!.state, "queued")
    assert.equal(fx.rows.get("r0")!.diagnostic, undefined, "known busy/queued facts do not create diagnostics")
    await queue.continue()
    assert.equal(submit, 3)
    assert.equal(inbox, 1)
  } finally { queue.stop(); leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; await fx.dispose() }
})

test("S16 local HTTP admission refuses before onDispatch and creates a held contract diagnostic without inbox calls", async () => {
  const fx = await fixture(), original = globalThis.fetch
  let calls = 0
  setErrorTelemetryContext({ sessionKey: "s16-local-admission" })
  const leave = enterDiagnosticWorkflowRoute()
  globalThis.fetch = async () => { calls++; throw new Error("no fetch is permitted") }
  const bad: SendCapability = { ...fx.capability, async prepare(rows, signal) {
    const built = await fx.capability.prepare(rows, signal)
    built.items[0]!.body = { rowId: "r0", schemaRevision: "" }
    return built
  } }
  const queue = createSendQueue({ rows: fx.rows, ...fx.scope, current: () => true, capabilities: { ozon: bad } })
  try {
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    assert.equal(calls, 0)
    const ref = currentLocalPublishDiagnostic(fx.rows.get("r0")!)
    assert.ok(ref?.diagnosticId)
    const copied = getDiagnosticCopyData(ref.diagnosticId)
    assert.equal(copied.detail.event?.code, "contract_violation")
    assert.equal(copied.originalJson, null)
    assert.equal(copied.detail.event?.payload_sha256, null)
    assert.deepEqual(copied.detail.event?.summary, [])
  } finally { queue.stop(); leave(); setErrorTelemetryContext({ sessionKey: null }); globalThis.fetch = original; await fx.dispose() }
})

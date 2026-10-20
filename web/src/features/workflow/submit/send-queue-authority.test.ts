import assert from "node:assert/strict"
import test from "node:test"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, prepareQueueRows, queueAccepted } from "./send-test-support"
import type { SendCapability, SendFact } from "./queue/types"
import { factFromIntent } from "./queue/authority"
import type { ListingIntent } from "@/bindings/http-listing-intents"

const intent: ListingIntent = { id: "i", listing_row_id: "r", store_id: "s", row_revision: 0, client_operation_id: "server-op", state: "queued", can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 }

test("only authoritative accepted state with positive task ID is accepted; pending is not success", () => {
  for (const state of ["queued", "submitting"]) assert.equal(factFromIntent({ ...intent, state, external_task_id: "42" }).state, "pending")
  for (const externalTaskId of [null, "", "0", "-1", "NaN", "1.1", "9007199254740993"]) {
    const fact = factFromIntent({ ...intent, state: "accepted", external_task_id: externalTaskId })
    assert.equal(fact.state, "accepted")
    assert.equal(fact.taskId, undefined)
  }
  assert.equal(factFromIntent({ ...intent, state: "accepted", external_task_id: "42" }).state, "accepted")
  assert.equal(factFromIntent({ ...intent, state: "superseded", can_resume: true }).state, "rejected")
  assert.equal(factFromIntent({ ...intent, state: "superseded", can_resume: true }).canResume, true)
  for (const state of ["unknown", "superseded", "future", "conflict", "cancelled"]) assert.equal(factFromIntent({ ...intent, state }).state, "unknown")
  assert.equal(factFromIntent({ ...intent, state: "rejected", can_resume: false }).state, "unknown")
})


for (const answer of ["empty", "superseded", "wrong-operation", "accepted"] as const) test(`explicit reconciliation ${answer} never resends and requires the captured server identity`, async () => {
  const { rows, scope } = await finalQueueHarness()
  let sends = 0
  const unknown: SendFact = { state: "unknown", intentId: "i", serverOperationId: "server", serverRevision: 0 }
  const capability: SendCapability = { prepare: prepareQueueRows, bytes: () => 1,
    async send() { sends++; return new Map([["r0", unknown]]) },
    async reconcile() {
      return { complete: true, rows: answer === "empty" ? [] : [{ rowId: "r0", candidates: [], fact: {
        ...unknown, state: answer === "superseded" ? "unknown" : "accepted", taskId: 42,
        serverOperationId: answer === "wrong-operation" ? "other" : "server",
      } }] }
    },
  }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    await queue.reconcile({ platform: "third", destination: "s1", rowIds: ["r0"] })
    assert.equal(sends, 1)
    assert.equal(rows.get("r0")?.submission?.state, answer === "accepted" ? "accepted" : "unconfirmed")
    assert.equal(queue.snapshot().counts.accepted, answer === "accepted" ? 1 : 0)
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 1)
  } finally { await rows.close() }
})

test("exact unknown release plus current read only unlocks locally; explicit retry keeps the parent", async () => {
  const { rows, scope } = await finalQueueHarness()
  let sends = 0
  let complete = false
  const capability: SendCapability = { prepare: prepareQueueRows, bytes: () => 1,
    async send(_destination, items) {
      sends++
      return sends === 1 ? new Map<string, SendFact>([["r0", { state: "unknown", intentId: "i", serverOperationId: "server", serverRevision: 0 }]]) : queueAccepted(items)
    },
    async releaseUnknown() { return { releasedIntentIds: ["i"], complete, unresolvedIntentIds: [] } },
  }
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    await queue.releaseUnknown("third", "s1", ["i"])
    assert.equal(rows.get("r0")?.submission?.state, "unconfirmed")
    complete = true
    await queue.releaseUnknown("third", "s1", ["i"])
    assert.equal(sends, 1)
    assert.equal(rows.get("r0")?.submission?.state, "rejected")
    const block = rows.cardState()!.publish!.blocks[0]!
    await queue.retry(block.id)
    assert.equal(sends, 2)
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 2)
  } finally { await rows.close() }
})

test("exact release/readback keeps the offer locked until real native validation succeeds, with zero release submits", async () => {
  const { createOzonSendCapability } = await import("../platforms/ozon")
  const { wasmCore, golden, goldenSchema, nativePayload } = await import("./send-test-support")
  const { route } = await import("@/api/routes")
  const core = await wasmCore()
  const handle = core.loadSchema({ snapshot: goldenSchema })
  const { rows, scope } = await finalQueueHarness()
  rows.update("r0", (row) => ({ ...row, row: nativePayload("r0") }))
  const original = globalThis.fetch
  let submits = 0
  let releases = 0
  let reads = 0
  let validations = 0
  const serverIntent = (state: string): ListingIntent => ({ ...intent, id: "i-r0", listing_row_id: "r0", store_id: "s1", state, external_task_id: state === "accepted" ? "42" : null })
  globalThis.fetch = async (url) => {
    if (String(url) === route("listingSubmit")) {
      submits++
      return Response.json({ data: { server_schema_revision: golden.row.schemaRevision, items: [{ row_id: "r0", outcome: "created", intent: serverIntent(submits === 1 ? "unknown" : "accepted") }] } })
    }
    if (String(url) === route("listingIntentsReleaseUnknown")) {
      releases++
      return Response.json({ data: { released_intent_ids: ["i-r0"], intents: [serverIntent("superseded")] } })
    }
    assert.ok(String(url).startsWith(`${route("listingIntents")}?`))
    reads++
    return Response.json({ data: { items: [serverIntent("superseded")] } })
  }
  const capability = createOzonSendCapability({ core: { ...core, freezeListing(h, input) {
    validations++; return core.freezeListing(h, input)
  } }, schemaHandle: () => handle, card: () => golden.card, cardId: scope.cardId })
  const queue = createSendQueue({ rows, ...scope, current: () => true, capabilities: { ozon: capability } })
  try {
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    const parent = rows.cardState()!.publish!.blocks[0]!
    const action = rows.cardState()!.publish!.actionId
    const invalid = nativePayload("r0"); delete invalid.draft.values.name
    rows.update("r0", (row) => ({ ...row, row: invalid }))
    await queue.releaseUnknown("ozon", "s1", ["i-r0"])
    assert.equal(rows.get("r0")?.submission?.state, "unconfirmed")
    assert.equal(rows.cardState()!.publish!.locks.length, 1)
    assert.equal(validations, 2, "failed validation was a real compiled native freeze")
    await queue.retry(parent.id)
    assert.equal(submits, 1)
    rows.update("r0", (row) => ({ ...row, row: nativePayload("r0") }))
    await queue.releaseUnknown("ozon", "s1", ["i-r0"])
    assert.deepEqual([submits, releases, reads, validations], [1, 2, 2, 3])
    assert.equal(rows.cardState()!.publish!.locks.length, 0)
    assert.equal(rows.get("r0")?.submission?.state, "rejected", "not accepted or automatically sent")
    await queue.retry(parent.id)
    assert.equal(submits, 2)
    assert.equal(rows.get("r0")?.submission?.state, "accepted")
    assert.equal(rows.cardState()!.publish!.actionId, action)
    assert.equal(rows.cardState()!.publish!.blocks[0]!.budget.submits, 2)
  } finally { globalThis.fetch = original; await rows.close() }
})

for (const change of ["readback-failed", "native-failed", "revision", "scope", "stop", "accepted", "queued", "missing-identity", "foreign-store"] as const) test(`release remains fenced after ${change}; no implicit or explicit resend`, async () => {
  const { rows, scope } = await finalQueueHarness()
  let current = true
  let sends = 0
  let releases = 0
  let checks = 0
  let queue: ReturnType<typeof createSendQueue>
  const capability: SendCapability = {
    async prepare(selected, signal) {
      checks++
      if (checks > 1) {
        if (change === "native-failed") throw new WebAssembly.RuntimeError("fixture trap")
        if (change === "revision") rows.update("r0", (row) => ({ ...row, row: { edited: true } }))
        if (change === "scope") current = false
        if (change === "stop") queue.stop()
      }
      return prepareQueueRows(selected, signal)
    }, bytes: () => 1,
    async send() {
      sends++
      return new Map([["r0", { state: "unknown", intentId: "i", serverOperationId: "server", serverRevision: 0 }]])
    },
    async releaseUnknown() {
      releases++
      if (change === "readback-failed") throw new Error("readback failed")
      return { releasedIntentIds: ["i"], complete: true, unresolvedIntentIds: [] }
    },
  }
  queue = createSendQueue({ rows, ...scope, current: () => current, capabilities: { third: capability } })
  try {
    await queue.start([{ platform: "third", destination: "s1", rowIds: ["r0"] }])
    if (change === "accepted" || change === "queued") rows.update("r0", (row) => ({ ...row, submission: { ...row.submission!, state: change } }))
    if (change === "missing-identity") rows.update("r0", (row) => ({ ...row, submission: { ...row.submission!, clientOperationId: undefined } }))
    if (change === "foreign-store") rows.update("r0", (row) => ({ ...row, storeId: "other" }))
    const release = queue.releaseUnknown("third", "s1", ["i"])
    if (change === "native-failed" || change === "readback-failed") await assert.rejects(release)
    else await release
    assert.equal(rows.cardState()!.publish!.locks.length, 1)
    await queue.retry(rows.cardState()!.publish!.blocks[0]!.id)
    assert.equal(sends, 1)
    if (["accepted", "queued", "missing-identity", "foreign-store"].includes(change)) assert.equal(releases, 0)
  } finally { await rows.close() }
})

import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import type { KnownIssueKey, LeanRow, SubmitDraft } from "@/listing-core/types"
import { createOzonSendCapability } from "../platforms/ozon"
import { createOzonRepair } from "../platforms/ozon-repair"
import { openCardRows } from "../rows/card-rows"
import { createSchemaCache } from "../schema-cache"
import { createSendQueue } from "./send-queue"
import { finalQueueHarness, golden, goldenSchema, nativePayload, serve, wasmCore } from "./send-test-support"

const repairedSchema = { ...goldenSchema, schema_revision: "cold-repaired" }
type ManifestLoader = (read: () => KnownIssueKey[]) => KnownIssueKey[] | Promise<KnownIssueKey[]>

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Cold reconciliation fixture did not settle within 5 seconds")), 5000)
    })])
  } finally { clearTimeout(timer) }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** A real send spends both repair credits before persisting a queued server identity. */
async function persistPending() {
  const h = await finalQueueHarness()
  let schemas: ReturnType<typeof createSchemaCache> | undefined
  const intent: ListingIntent = { id: "i-r0", listing_row_id: "r0", store_id: "s1", row_revision: 9,
    client_operation_id: "server-r0", state: "queued", can_resume: false, current_issue_status: "absent",
    submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 }
  let draft: SubmitDraft | undefined, submits = 0
  try {
    const core = await wasmCore()
    schemas = createSchemaCache(core)
    h.rows.update("r0", (row) => ({ ...row, row: nativePayload(row.id) }))
    const initialHandle = (await schemas.load({ platform: "ozon", coordinate: [golden.card.descriptionCategoryId, golden.card.typeId], language: "default",
      materialDigest: "initial", defaultsRevision: "1", sessionFence: "cold-test" }, { snapshot: goldenSchema })).handle
    const repair = createOzonRepair({ rows: h.rows, core, schemas, initialHandle, accountId: "fixture-account",
      card: () => golden.card, current: () => true,
      refreshSchema: async () => ({ identity: { platform: "ozon", coordinate: [golden.card.descriptionCategoryId, golden.card.typeId], language: "default",
        materialDigest: "repaired", defaultsRevision: "1", sessionFence: "cold-test" }, material: { snapshot: repairedSchema } }),
      reuploadRows: async (rows) => rows.map((row) => ({ rowId: row.id, revision: row.rev, state: "confirmed" as const,
        images: (row.row as LeanRow).media.images.map((image) => ({ ...image, phase: "public_ready" as const,
          public_url: "https://media.example.invalid/cold.jpg", object_key: "fixture/cold.jpg", account_id: "fixture-account" })) })),
    })
    const capability = createOzonSendCapability({ ...repair, core, card: () => golden.card, cardId: h.scope.cardId })
    const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: capability } })
    const mock = serve(({ url, method, body }) => {
      assert.equal(url, route("listingSubmit")); assert.equal(method, "POST")
      draft = structuredClone(body.items[0])
      submits++
      return { server_schema_revision: repairedSchema.schema_revision, items: [{ row_id: "r0",
        ...(submits < 3 ? { outcome: "skipped", skip_reason: submits === 1 ? "schema_stale" : "media_expired" }
          : { outcome: "created", intent }) }] }
    })
    try {
      await bounded(queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }]))
      assert.equal(mock.calls.length, 3)
      assert.deepEqual(h.rows.cardState()!.publish!.blocks[0]!.budget, { submits: 3, schema: 1, media: 1 })
      assert.equal(h.rows.get("r0")!.submission!.intentId, intent.id)
      await bounded(h.rows.flush())
    } finally {
      queue.stop()
      try { await bounded(queue.settled().catch(() => {})) } finally { mock.restore() }
    }
  } finally { try { await bounded(h.rows.close()) } finally { await schemas?.close() } }
  assert.ok(draft)
  // Neither capability A, its queue nor its native instance escape this scope.
  return { repo: h.repo, scope: h.scope, intent, draft }
}

async function coldHarness(load: ManifestLoader = (read) => read()) {
  const saved = await persistPending()
  const rows = await openCardRows(saved.repo, saved.scope, async () => ({ writable: true, onChange: () => () => {}, release() {} }))
  try {
    const native = await wasmCore() // New compiled instance, with no resident schema or prior manifest.
    const calls = { manifest: 0, freeze: 0, project: 0, schema: 0, card: 0 }
    let handle: number | undefined, manifest: KnownIssueKey[] | undefined
    const capability = createOzonSendCapability({ core: { ...native,
      issueManifest() {
        calls.manifest++
        return load(() => { manifest = native.issueManifest(); return manifest })
      },
      freezeListing(h, input) { calls.freeze++; return native.freezeListing(h, input) },
      projectSubmitDraft(input) { calls.project++; return native.projectSubmitDraft(input) },
    }, schemaHandle() {
      calls.schema++; assert.ok(handle !== undefined, "cold reconcile must not request schema or prepare")
      return handle
    }, card() { calls.card++; return golden.card }, cardId: saved.scope.cardId })
    const queue = createSendQueue({ rows, ...saved.scope, current: () => true, capabilities: { ozon: capability } })
    const selection = { platform: "ozon", destination: "s1", rowIds: ["r0"] }
    const persisted = async () => structuredClone({ rows: await saved.repo.rowsOfCard(saved.scope.workspaceUuid, saved.scope.cardId),
      card: await saved.repo.cardState(saved.scope.workspaceUuid, saved.scope.cardId) })
    const before = await persisted()
    const parent = before.card!.publish!.blocks[0]!
    return { ...saved, rows, capability, queue, calls, selection, persisted, before, parent,
      manifest: () => manifest,
      enableRetry() { assert.equal(handle, undefined); handle = native.loadSchema({ snapshot: repairedSchema }) },
      async close() { queue.stop(); try { await bounded(rows.close()) } finally { if (handle !== undefined) native.dropSchema(handle) } },
    }
  } catch (error) { await bounded(rows.close()); throw error }
}
type ColdHarness = Awaited<ReturnType<typeof coldHarness>>

function rejected(h: ColdHarness): ListingIntent {
  return { ...h.intent, state: "rejected", can_resume: true, current_issue_status: "present", current_issue: {
    intent_id: h.intent.id, row_id: "r0", store_id: "s1", input_revision: h.intent.row_revision, credential_revision: 1,
    request_hash: "fixture-hash", phase: "submit", code: "OZON_ROW_REJECTED", endpoint: "/v3/product/import",
    safe_message: "fixture rejection", summary: "商品被拒绝", remediation: "修改商品后明确重试", scope: "row",
    allowed_actions: ["edit_row", "resume"], trace_id: "fixture-trace", dispatch_evidence: "rejected",
    retry_after_fallback: false, created_at_ms: 1,
  } }
}
function assertNativeOnly(h: ColdHarness, loads = 1) {
  assert.deepEqual(h.calls, { manifest: loads, freeze: 0, project: 0, schema: 0, card: 0 })
  assert.ok(h.manifest()?.some((key) => key.platform === "ozon" && key.stage === "submit" && key.code === "OZON_ROW_REJECTED"),
    "known issue must come from actual compiled op13, not a fixture whitelist")
}
function identityRead(url: string) {
  const parsed = new URL(url, "http://fixture.invalid")
  assert.equal(parsed.pathname, route("listingIntents"))
  assert.deepEqual([...parsed.searchParams.entries()].sort(), [
    ["intentIds", "i-r0"], ["latestPerRow", "true"], ["limit", "100"], ["storeId", "s1"],
  ])
}
async function assertRetained(h: ColdHarness) {
  assert.deepEqual(await h.persisted(), h.before, "failed/cancelled/uncertain reads cannot change durable rows or queue")
  assert.equal(h.rows.get("r0")!.submission!.state, "queued")
  assert.equal(h.rows.cardState()!.publish!.locks.length, 1)
}

for (const loading of ["sync", "async"] as const) test(`cold ${loading} native manifest reconciles exact rejected Intent durably; explicit retry preserves spent parent credits`, async () => {
  const h = await coldHarness((read) => loading === "sync" ? read() : Promise.resolve().then(read))
  const mock = serve(({ url, method, body }) => {
    if (method === "GET") { identityRead(url); return { items: [rejected(h)] } }
    assert.equal(url, route("listingSubmit")); assert.equal(method, "POST")
    assert.deepEqual(body.items, [h.draft])
    return { server_schema_revision: repairedSchema.schema_revision, items: [{ row_id: "r0", outcome: "resumed",
      intent: { ...h.intent, state: "accepted", external_task_id: "42" } }] }
  })
  try {
    const result = await bounded(h.queue.reconcile(h.selection)) // First explicit operation on capability B.
    assert.equal(result.status, "read"); assert.equal(result.mode, "identities"); assert.equal(result.complete, true)
    assert.deepEqual(result.appliedRowIds, ["r0"])
    assert.deepEqual(result.rows[0]!.fact, { state: "rejected", intentId: h.intent.id, serverOperationId: h.intent.client_operation_id,
      serverRevision: h.intent.row_revision, taskId: undefined, code: undefined, canResume: true })
    assertNativeOnly(h)
    assert.equal(mock.calls.length, 1); assert.equal(mock.calls[0]!.method, "GET")
    const reconciled = await h.persisted(), submission = reconciled.rows[0]!.submission!
    assert.equal(submission.state, "rejected"); assert.equal(submission.logicalBlockId, h.parent.id)
    assert.equal(submission.sendActionId, h.before.card!.publish!.actionId)
    assert.equal(submission.intentId, h.intent.id); assert.equal(submission.clientOperationId, h.intent.client_operation_id)
    assert.equal(submission.serverRevision, h.intent.row_revision)
    assert.deepEqual(reconciled.card!.publish!.locks, [])
    assert.deepEqual(await h.repo.offerLocks(h.scope.workspaceUuid), [])
    assert.deepEqual(reconciled.card!.publish!.blocks, h.before.card!.publish!.blocks)
    assert.equal(h.queue.snapshot().counts.rejected, 1)
    assert.equal((await bounded(h.queue.reconcile(h.selection))).status, "invalid_selection")
    assertNativeOnly(h); assert.equal(mock.calls.length, 1)
    h.enableRetry()
    await bounded(h.queue.retry(h.parent.id))
    const retried = await h.persisted()
    assert.equal(retried.card!.publish!.actionId, h.before.card!.publish!.actionId)
    assert.equal(retried.card!.publish!.blocks[0]!.id, h.parent.id)
    assert.deepEqual(retried.card!.publish!.blocks[0]!.budget, { submits: 4, schema: 1, media: 1 })
    assert.equal(retried.rows[0]!.submission!.state, "accepted")
    assert.equal(retried.rows[0]!.submission!.logicalBlockId, h.parent.id)
    assert.equal(retried.rows[0]!.submission!.sendActionId, h.before.card!.publish!.actionId)
    assert.deepEqual(h.calls, { manifest: 1, freeze: 1, project: 1, schema: 1, card: 1 })
    await bounded(h.queue.retry(h.parent.id))
    assert.deepEqual(mock.calls.map((call) => call.method), ["GET", "POST"])
  } finally { mock.restore(); await h.close() }
})

for (const answer of ["unknown-code", "unknown-phase", "no-resume", "disallowed", "absent", "operation-mismatch", "revision-mismatch"] as const)
  test(`cold rejected ${answer} keeps the persisted lock and credits; no resumed submit or release`, async () => {
    const h = await coldHarness()
    const mock = serve(({ url, method }) => {
      assert.equal(method, "GET"); identityRead(url)
      const intent = rejected(h)
      if (answer === "unknown-code") intent.current_issue!.code = "future-native-code"
      if (answer === "unknown-phase") intent.current_issue!.phase = "future-native-phase"
      if (answer === "no-resume") intent.can_resume = false
      if (answer === "disallowed") intent.current_issue!.allowed_actions = ["reconcile"]
      if (answer === "absent") intent.current_issue_status = "absent"
      if (answer === "operation-mismatch") intent.client_operation_id = "different-operation"
      if (answer === "revision-mismatch") intent.row_revision++
      return { items: [intent] }
    })
    try {
      const result = await bounded(h.queue.reconcile(h.selection))
      assert.deepEqual(result.appliedRowIds, [])
      assert.equal(result.rows[0]!.fact?.state, answer.endsWith("mismatch") ? undefined : "unknown")
      assertNativeOnly(h); await assertRetained(h)
      await bounded(h.queue.retry(h.parent.id)); await bounded(h.queue.releaseUnknown("ozon", "s1", [h.intent.id]))
      assert.equal(mock.calls.length, 1); await assertRetained(h)
    } finally { mock.restore(); await h.close() }
  })

for (const state of ["accepted", "queued", "submitting"] as const) test(`cold native initialization preserves authoritative ${state} and its lock disposition`, async () => {
  const h = await coldHarness()
  const mock = serve(({ url, method }) => {
    assert.equal(method, "GET"); identityRead(url)
    return { items: [{ ...h.intent, state, externalTaskId: state === "accepted" ? "42" : null }] }
  })
  try {
    assert.deepEqual((await bounded(h.queue.reconcile(h.selection))).appliedRowIds, ["r0"])
    assertNativeOnly(h)
    const after = await h.persisted()
    assert.equal(after.rows[0]!.submission!.state, state === "accepted" ? "accepted" : "queued")
    assert.equal(after.card!.publish!.locks[0]!.state, state === "accepted" ? "accepted" : "pending")
    assert.deepEqual(after.card!.publish!.blocks, h.before.card!.publish!.blocks)
    assert.equal(after.card!.publish!.actionId, h.before.card!.publish!.actionId)
    assert.equal(mock.calls.length, 1)
  } finally { mock.restore(); await h.close() }
})

test("cold invalid and pre-aborted selections do not load native knowledge or issue HTTP", async () => {
  const h = await coldHarness(), controller = new AbortController()
  controller.abort()
  const mock = serve(() => { throw new Error("invalid/cancelled selection reached HTTP") })
  try {
    for (const rowIds of [[], ["r0", "r0"], [" r0"], ["missing"], Array.from({ length: 101 }, (_, i) => `r${i}`)]) {
      assert.equal((await bounded(h.queue.reconcile({ ...h.selection, rowIds }))).status, "invalid_selection")
    }
    assert.equal((await bounded(h.queue.reconcile(h.selection, controller.signal))).status, "stale")
    const pin = { rowId: "r0", revision: h.rows.get("r0")!.rev }
    await assert.rejects(bounded(h.capability.reconcile!("s1", [pin], controller.signal)), { name: "AbortError" })
    await assert.rejects(bounded(h.capability.reconcile!("s1", [pin, pin], new AbortController().signal)), { code: "listing_contract_invalid" })
    assert.equal(h.calls.manifest, 0); assert.equal(mock.calls.length, 0); await assertRetained(h)
  } finally { mock.restore(); await h.close() }
})

for (const cancellation of ["abort", "stop"] as const) test(`cold ${cancellation} interrupts a pending local manifest; its late native result cannot initialize knowledge or dispatch`, async () => {
  const entered = deferred(), gate = deferred(), finished = deferred()
  const h = await coldHarness(async (read) => {
    entered.resolve(); await gate.promise
    try { return read() } finally { finished.resolve() }
  }), controller = new AbortController()
  const mock = serve(({ url, method }) => { assert.equal(method, "GET"); identityRead(url); return { items: [rejected(h)] } })
  let reading: Promise<unknown> | undefined
  try {
    reading = h.queue.reconcile(h.selection, controller.signal)
    void reading.catch(() => {}) // Observe early failure even when the entry latch itself fails.
    await bounded(entered.promise)
    if (cancellation === "abort") controller.abort(); else h.queue.stop()
    await assert.rejects(bounded(reading), { name: "AbortError" }) // Must settle while the native promise is still blocked.
    assert.equal(mock.calls.length, 0); await assertRetained(h)
    gate.resolve(); await bounded(finished.promise)
    await Promise.resolve()
    assert.equal(mock.calls.length, 0); await assertRetained(h)
    assert.deepEqual((await bounded(h.queue.reconcile(h.selection))).appliedRowIds, ["r0"])
    assertNativeOnly(h, 2); assert.equal(mock.calls.length, 1)
    assert.deepEqual((await h.persisted()).card!.publish!.blocks, h.before.card!.publish!.blocks)
  } finally {
    controller.abort(); h.queue.stop(); gate.resolve()
    try { if (reading) await bounded(reading.catch(() => {})) } finally { mock.restore(); await h.close() }
  }
})

test("abort during synchronous native manifest initialization prevents HTTP and preserves persisted state", async () => {
  const controller = new AbortController()
  const h = await coldHarness((read) => { const manifest = read(); controller.abort(); return manifest })
  const mock = serve(() => { throw new Error("cancelled native result reached HTTP") })
  try {
    await assert.rejects(bounded(h.queue.reconcile(h.selection, controller.signal)), { name: "AbortError" })
    assertNativeOnly(h); assert.equal(mock.calls.length, 0); await assertRetained(h)
  } finally { mock.restore(); await h.close() }
})

for (const failure of ["sync", "async"] as const) test(`cold ${failure} manifest load failure propagates without HTTP or an empty whitelist; next explicit load uses real native knowledge`, async () => {
  const error = new WebAssembly.RuntimeError("fixture manifest load failure")
  let fail = true
  const h = await coldHarness((read) => {
    if (!fail) return read()
    if (failure === "sync") throw error
    return Promise.reject(error)
  })
  const mock = serve(({ url, method }) => { assert.equal(method, "GET"); identityRead(url); return { items: [rejected(h)] } })
  try {
    await assert.rejects(bounded(h.queue.reconcile(h.selection)), (actual) => actual === error)
    assert.equal(h.manifest(), undefined); assert.equal(h.calls.manifest, 1)
    assert.equal(mock.calls.length, 0); await assertRetained(h)
    fail = false
    assert.deepEqual((await bounded(h.queue.reconcile(h.selection))).appliedRowIds, ["r0"])
    assertNativeOnly(h, 2); assert.equal(mock.calls.length, 1)
    assert.deepEqual((await h.persisted()).card!.publish!.blocks, h.before.card!.publish!.blocks)
  } finally { mock.restore(); await h.close() }
})

for (const outcome of ["cancel", "error"] as const) test(`cold Intent read ${outcome} retains the original persistent state with exactly one GET and no submit/release`, async () => {
  const h = await coldHarness(), entered = deferred(), gate = deferred(), controller = new AbortController()
  const mock = serve(async ({ url, method }) => {
    assert.equal(method, "GET"); identityRead(url); entered.resolve(); await gate.promise
    if (outcome === "error") throw new TypeError("fixture read failed")
    return { items: [rejected(h)] } // Deliberately late usable authority must still lose the cancellation fence.
  })
  let reading: ReturnType<typeof h.queue.reconcile> | undefined
  try {
    reading = h.queue.reconcile(h.selection, controller.signal)
    void reading.catch(() => {})
    await bounded(entered.promise)
    await bounded(h.queue.retry(h.parent.id)); await bounded(h.queue.releaseUnknown("ozon", "s1", [h.intent.id]))
    if (outcome === "cancel") controller.abort()
    gate.resolve()
    if (outcome === "error") await assert.rejects(bounded(reading))
    else { const read = await bounded(reading); assert.equal(read.status, "stale"); assert.deepEqual(read.appliedRowIds, []) }
    assertNativeOnly(h); assert.equal(mock.calls.length, 1); await assertRetained(h)
  } finally {
    controller.abort(); h.queue.stop(); gate.resolve()
    try { if (reading) await bounded(reading.catch(() => {})) } finally { mock.restore(); await h.close() }
  }
})

test("cold local manifest await captures mutable caller pins before loading and never expands the selection", async () => {
  const entered = deferred(), gate = deferred()
  const h = await coldHarness(async (read) => { entered.resolve(); await gate.promise; return read() })
  const pin = { rowId: "r0", revision: h.rows.get("r0")!.rev, identity: {
    intentId: h.intent.id, serverOperationId: h.intent.client_operation_id, serverRevision: h.intent.row_revision,
  } }
  const mock = serve(({ url, method }) => { assert.equal(method, "GET"); identityRead(url); return { items: [rejected(h)] } })
  const controller = new AbortController()
  let reading: ReturnType<NonNullable<typeof h.capability.reconcile>> | undefined
  try {
    reading = h.capability.reconcile!("s1", [pin], controller.signal)
    void reading.catch(() => {})
    await bounded(entered.promise)
    pin.rowId = "other"; pin.identity.intentId = "other-intent"; pin.identity.serverOperationId = "other-operation"; pin.identity.serverRevision++
    gate.resolve()
    const read = await bounded(reading)
    assert.equal(read.rows[0]!.rowId, "r0"); assert.equal(read.rows[0]!.fact!.state, "rejected")
    assert.equal(read.rows[0]!.fact!.intentId, h.intent.id)
    assertNativeOnly(h); assert.equal(mock.calls.length, 1); await assertRetained(h)
  } finally {
    controller.abort(); gate.resolve()
    try { if (reading) await bounded(reading.catch(() => {})) } finally { mock.restore(); await h.close() }
  }
})

test("cold rejected reconciliation and repeated explicit retries never replenish the six-submit parent or either repair credit", async () => {
  const h = await coldHarness()
  const mock = serve(({ url, method }) => {
    if (method === "GET") { identityRead(url); return { items: [rejected(h)] } }
    assert.equal(method, "POST"); assert.equal(url, route("listingSubmit"))
    return { server_schema_revision: repairedSchema.schema_revision, items: [{ row_id: "r0", outcome: "resumed", intent: rejected(h) }] }
  })
  try {
    await bounded(h.queue.reconcile(h.selection))
    h.enableRetry()
    for (let submits = 4; submits <= 6; submits++) {
      await bounded(h.queue.retry(h.parent.id))
      const state = (await h.persisted()).card!.publish!
      assert.equal(state.actionId, h.before.card!.publish!.actionId); assert.equal(state.blocks[0]!.id, h.parent.id)
      assert.deepEqual(state.blocks[0]!.budget, { submits, schema: 1, media: 1 })
      assert.equal((await bounded(h.queue.reconcile(h.selection))).status, "invalid_selection")
    }
    const exhausted = await h.persisted()
    await bounded(h.queue.retry(h.parent.id)); await bounded(h.queue.retry(h.parent.id))
    assert.deepEqual(await h.persisted(), exhausted)
    assert.equal(h.calls.manifest, 1)
    assert.deepEqual(mock.calls.map((call) => call.method), ["GET", "POST", "POST", "POST"])
  } finally { mock.restore(); await h.close() }
})

/**
 * The send rail over the real native core: local refusals cost zero requests,
 * resident rows/material cost zero reads, each chunk freezes through
 * the Ozon adapter (WASM op 11) and sends one persistent-intent batch POST
 * carrying only row ids and the click's pins.
 */
import assert from "node:assert/strict"
import { afterEach, before, beforeEach, test } from "node:test"

import { route } from "@/api/routes"
import { readCategorySchema, rememberDictionaryHits, residentCategorySchema } from "@/bindings/listing-material-cache"
import { cachedListingRow } from "@/bindings/listing-row-cache"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import type { ListingCore } from "@/listing-core/wasm"
import { sendPins } from "../prepare/executor-test-support"
import { patchListingWorkbench } from "../workbench/listing-workbench-store"
import { sendRows } from "./send-rows"
import type { OzonSubmissionError } from "./ozon-admission-refusal"
import {
  accepted, CARD, CATEGORY, countingCore, golden, nativeRowView, openCard, refusal, residentRows,
  resetSendState, schemaData, serve, TYPE, wasmCore, type SendCall,
} from "./send-test-support"

let native: ListingCore
before(async () => { native = await wasmCore() })
beforeEach(resetSendState)
afterEach(resetSendState)

const SUBMIT = route("listingSubmit")
const isSchema = (call: SendCall) => call.url.startsWith(route("catalogSchema"))
const isRowRead = (call: SendCall) => call.method === "GET" && call.url.startsWith(`${route("listingRows")}/`)
const submits = (calls: SendCall[]) => calls.filter((call) => call.url === SUBMIT)
const gets = (calls: SendCall[]) => calls.filter((call) => call.method === "GET")

/** Rows, card and the coordinate's material all resident; the stub then records only what `sendRows` itself sends. */
async function residentSend(rowIds: readonly string[], store: (rowId: string) => string = () => "store-1") {
  residentRows(rowIds.map((id) => nativeRowView(id, { storeId: store(id) })))
  openCard(CARD, TYPE, [...new Set(rowIds.map(store))].join(","))
  const warm = serve(() => schemaData())
  await readCategorySchema({ descriptionCategoryId: CATEGORY, typeId: TYPE, language: "default" })
  warm.restore()
}

const cloud = (reply: (body: { storeId: string, row_ids: string[] }, call: SendCall) => unknown) => (call: SendCall) => {
  if (call.url === SUBMIT) return reply(call.body, call)
  if (isSchema(call)) return schemaData()
  if (isRowRead(call)) return nativeRowView(call.url.split("/").at(-1)!)
  throw new Error(`unexpected request ${call.method} ${call.url}`)
}

test("everything known locally is refused with a remedy and zero requests", async () => {
  residentRows([nativeRowView("no-store", { cardId: "unbound-card" }), nativeRowView("invalid", { stage: "fields_invalid" }), nativeRowView("malformed", { payload: { schemaRevision: "" } })])
  openCard("unbound-card", TYPE, "")
  patchListingWorkbench({
    pendingRemovalIds: new Set(["removing"]),
    rowSaveStates: { unsaved: "saving" },
    productDrafts: { unknown: { lifecycle: { stage: "outcome_unknown" } } as never },
  })
  const stub = serve(() => { throw new Error("no request may be sent") })
  try {
    await assert.rejects(sendRows({ row_ids: [], expected_revisions: [] }), { code: "workflow_send_empty" })
    const ids = ["no-pin", "no-store", "stopped", "removing", "unsaved", "unknown", "invalid", "malformed"]
    const results = await sendRows({
      row_ids: ids,
      expected_revisions: [...sendPins(ids.slice(2)), { row_id: "no-store", revision: 9 }],
    }, (id) => id === "stopped", { core: native })
    assert.deepEqual(results.map((result) => [result.row_id, result.outcome, result.error?.code ?? result.noop_reason]), [
      ["no-pin", "blocked", "workflow_revision_missing"],
      ["no-store", "blocked", "target_store_missing"],
      ["stopped", "noop", "cancelled"],
      ["removing", "blocked", "workflow_row_removing"],
      ["unsaved", "blocked", "workflow_row_unsaved"],
      ["unknown", "blocked", "workflow_outcome_unknown"],
      ["invalid", "blocked", "workflow_fields_invalid"],
      ["malformed", "blocked", "workflow_row_payload_invalid"],
    ])
    assert.deepEqual(results[1]!.blockers, ["target_store_missing"])
    assert.ok(results.every((result) => result.outcome === "noop" || result.error?.remediation))
    assert.equal(stub.calls.length, 0)
  } finally { stub.restore() }
})

test("resident rows and material send one POST with the click's pins and nothing else", async () => {
  await residentSend(["row-1", "row-2"])
  const core = countingCore(native)
  const stub = serve(cloud((body) => accepted(body)))
  try {
    const results = await sendRows({ row_ids: ["row-1", "row-2"], expected_revisions: sendPins(["row-1", "row-2"]) }, undefined, { core })
    assert.deepEqual(results.map((result) => [result.outcome, result.job_id]), [["start", "intent-row-1"], ["start", "intent-row-2"]])
    assert.equal(gets(stub.calls).length, 0, "a resident send reads nothing")
    assert.deepEqual(submits(stub.calls).map((call) => call.body), [{
      storeId: "store-1", row_ids: ["row-1", "row-2"],
      expectedRevisions: [{ rowId: "row-1", revision: 9 }, { rowId: "row-2", revision: 9 }],
    }])
    await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core })
    assert.equal(core.loads, 1, "the schema handle stays resident for its material signature")
  } finally { stub.restore() }
})

test("rows are read only when missing or behind the pin; a newer row is refused before any material read", async () => {
  openCard()
  residentRows([nativeRowView("behind", { revision: 8 })])
  const stub = serve((call) => {
    if (isRowRead(call)) return nativeRowView(call.url.split("/").at(-1)!, { revision: call.url.endsWith("edited") ? 10 : 9, viewRevision: 2 })
    return cloud((body) => accepted(body))(call)
  })
  try {
    const edited = await sendRows({ row_ids: ["edited"], expected_revisions: sendPins(["edited"]) }, undefined, { core: native })
    assert.equal(edited[0]!.noop_reason, "revision_mismatch")
    assert.equal(stub.calls.filter(isSchema).length + submits(stub.calls).length, 0)
    const sent = await sendRows({ row_ids: ["cold", "behind"], expected_revisions: sendPins(["cold", "behind"]) }, undefined, { core: native })
    assert.deepEqual(sent.map((result) => result.outcome), ["start", "start"])
    assert.deepEqual(stub.calls.filter(isRowRead).map((call) => call.url.split("/").at(-1)), ["edited", "cold", "behind"])
    assert.equal(stub.calls.filter(isSchema).length, 1, "a cold coordinate is read once")
    await sendRows({ row_ids: ["cold"], expected_revisions: sendPins(["cold"]) }, undefined, { core: native })
    assert.equal(stub.calls.filter(isRowRead).length, 3, "a row read once stays resident")
  } finally { stub.restore() }
})

test("a confirmed dictionary hit changes the material signature: the next send loads a fresh handle, no GET", async () => {
  await residentSend(["row-1"])
  const core = countingCore(native)
  const stub = serve(cloud((body) => accepted(body)))
  try {
    await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core })
    const coordinate = { descriptionCategoryId: CATEGORY, typeId: TYPE, language: "default" as const }
    const base = await residentCategorySchema(coordinate)
    await rememberDictionaryHits(coordinate, base, 85, 28_732_849, [{ id: "5550001", value: "Searched" }])
    assert.notEqual((await residentCategorySchema(coordinate)).material!.signature, base.material!.signature)
    await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core })
    assert.equal(core.loads, 2)
    assert.equal(gets(stub.calls).length, 0)
  } finally { stub.restore() }
})

test("a native validation refusal blocks locally: no POST, nothing reported", async () => {
  const values = { ...golden.row.draft.values }
  delete values.name
  residentRows([nativeRowView("no-name", { payload: { draft: { ...golden.row.draft, values: { ...values, offer_id: { kind: "text", value: "no-name" } } } } })])
  openCard()
  const stub = serve(cloud(() => { throw new Error("must not submit") }))
  const lines: string[] = []
  console.log = (line: string) => lines.push(line)
  try {
    const [result] = await sendRows({ row_ids: ["no-name"], expected_revisions: sendPins(["no-name"]) }, undefined, { core: native })
    assert.equal(result!.outcome, "blocked")
    assert.match(result!.error!.code, /^ozon_/)
    assert.ok(result!.error!.remediation)
    assert.equal(submits(stub.calls).length, 0)
    assert.equal(lines.filter((line) => line.includes(" error ")).length, 0, "a business refusal is never reported")
  } finally { stub.restore() }
})

test("a core failure is blocked, never Unknown, and reported once as a technical freeze failure", async () => {
  await residentSend(["row-1"])
  const broken = { loadSchema: native.loadSchema.bind(native), freezeListing: () => { throw new Error("wasm trap with secret") } }
  const stub = serve(cloud(() => { throw new Error("must not submit") }))
  const lines: string[] = []
  console.log = (line: string) => lines.push(line)
  try {
    const [result] = await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core: broken })
    assert.deepEqual([result!.outcome, result!.error?.code], ["blocked", "ozon_core_unavailable"])
    assert.doesNotMatch(JSON.stringify(result), /secret/)
    assert.deepEqual(lines.filter((line) => line.startsWith("[listing-send] error")).length, 1)
    assert.doesNotMatch(lines.join("\n"), /secret/)
  } finally { stub.restore() }
})

test("missing native material refuses the send instead of freezing against an empty bag", async () => {
  residentRows([nativeRowView("row-1")])
  openCard()
  const stub = serve((call) => isSchema(call) ? schemaData(TYPE, false) : cloud(() => { throw new Error("must not submit") })(call))
  try {
    const [result] = await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core: native })
    assert.deepEqual([result!.outcome, result!.error?.code], ["blocked", "workflow_schema_material_missing"])
    assert.equal(submits(stub.calls).length, 0)
  } finally { stub.restore() }
})

test("an identity switch while the material loads fences it out: blocked, no POST", async () => {
  residentRows([nativeRowView("row-1")])
  openCard()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const stub = serve(async (call) => {
    if (isSchema(call)) { await held; return schemaData() }
    throw new Error("must not submit")
  })
  try {
    const running = sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core: native })
    for (let tick = 0; tick < 20 && !stub.calls.some(isSchema); tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    invalidateAllSessionCaches()
    release()
    const [result] = await running
    assert.deepEqual([result!.outcome, result!.error?.code], ["blocked", "workflow_schema_material_stale"])
    assert.equal(submits(stub.calls).length, 0)
  } finally { stub.restore() }
})

test("an identity switch after material loading cancels the send before native freeze can dispatch", async () => {
  await residentSend(["old-workspace-row"])
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const core = {
    async loadSchema(...args: Parameters<typeof native.loadSchema>) {
      const handle = native.loadSchema(...args)
      entered()
      await held
      return handle
    },
    freezeListing: native.freezeListing.bind(native),
  }
  const stub = serve(cloud((body) => ({ items: accepted(body).items.map((item) => ({ ...item, row: nativeRowView(item.row_id) })) })))
  const running = sendRows({ row_ids: ["old-workspace-row"], expected_revisions: sendPins(["old-workspace-row"]) }, undefined, { core })
  try {
    await started
    invalidateAllSessionCaches()
    release()
    const [result] = await running
    assert.equal(submits(stub.calls).length, 0, "retiring the session closes admission after the native await")
    assert.equal(result!.noop_reason, "cancelled")
    assert.equal(cachedListingRow("old-workspace-row"), undefined, "the retired send cannot repopulate the new session")
  } finally { release(); await running; stub.restore() }
})

test("different categories in one Store freeze on their own handles and share one POST", async () => {
  residentRows([nativeRowView("a"), nativeRowView("b", { cardId: "card-2", typeId: TYPE + 1 })])
  openCard()
  openCard("card-2", TYPE + 1)
  const stub = serve((call) => {
    if (isSchema(call)) return schemaData(Number(new URL(call.url, "http://x").searchParams.get("typeId")))
    return cloud((body) => accepted(body))(call)
  })
  const core = countingCore(native)
  try {
    const results = await sendRows({ row_ids: ["a", "b"], expected_revisions: sendPins(["a", "b"]) }, undefined, { core })
    assert.deepEqual(results.map((result) => result.outcome), ["start", "start"], JSON.stringify(results))
    assert.equal(core.loads, 2)
    assert.deepEqual(submits(stub.calls).map((call) => call.body.row_ids), [["a", "b"]])
  } finally { stub.restore() }
})

test("schema_sync_required refreshes the material, freezes again and replays the original pins once", async () => {
  await residentSend(["row-1", "row-2"])
  let posts = 0
  const stub = serve(cloud((body) => ++posts === 1 ? refusal(409, "schema_sync_required", "目录已过期") : accepted(body)))
  try {
    const results = await sendRows({ row_ids: ["row-1", "row-2"], expected_revisions: sendPins(["row-1", "row-2"]) }, undefined, { core: native })
    assert.deepEqual(results.map((result) => result.outcome), ["start", "start"])
    const writes = submits(stub.calls)
    assert.equal(writes.length, 2)
    assert.deepEqual(writes[0]!.body, writes[1]!.body, "schema refresh cannot authorize newer edits")
    assert.equal(stub.calls.filter(isSchema).length, 1, "the replay forced exactly one material read")
    assert.equal(stub.calls.filter(isRowRead).length, 0, "retries keep the original pins without rereading rows")
  } finally { stub.restore() }
})

test("a second schema_sync_required is final: blocked, no third POST", async () => {
  await residentSend(["row-1"])
  const stub = serve(cloud(() => refusal(409, "schema_sync_required", "目录已过期")))
  try {
    const [result] = await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core: native })
    assert.equal(result!.outcome, "blocked")
    assert.equal(submits(stub.calls).length, 2)
  } finally { stub.restore() }
})

test("row cancellation during schema refresh prevents only that row's retry submit", async () => {
  await residentSend(["row-schema", "row-keep"])
  const cancelled = new Set<string>()
  let posts = 0
  let releaseSchema!: () => void
  const schemaReady = new Promise<void>((resolve) => { releaseSchema = resolve })
  const stub = serve(async (call) => {
    if (isSchema(call)) { cancelled.add("row-schema"); await schemaReady; return schemaData() }
    return cloud((body) => ++posts === 1 ? refusal(409, "schema_sync_required") : accepted(body))(call)
  })
  try {
    const running = sendRows({ row_ids: ["row-schema", "row-keep"], expected_revisions: sendPins(["row-schema", "row-keep"]) }, (id) => cancelled.has(id), { core: native })
    for (let tick = 0; tick < 50 && !stub.calls.some(isSchema); tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    releaseSchema()
    const results = await running
    assert.deepEqual(submits(stub.calls).map((call) => call.body.row_ids), [["row-schema", "row-keep"], ["row-keep"]])
    assert.equal(results.find((result) => result.row_id === "row-schema")?.noop_reason, "cancelled")
    assert.equal(results.find((result) => result.row_id === "row-keep")?.outcome, "start")
  } finally { releaseSchema?.(); stub.restore() }
})

test("send names rows per Store and reports each row's own Cloud outcome", async () => {
  await residentSend(["row-1", "row-2"])
  const queuedRow = nativeRowView("row-1", { viewRevision: 11 })
  const stub = serve(cloud(() => ({
    items: [
      { row_id: "row-1", created: true, blockers: [], intent: { id: "intent-1", store_id: "store-1", listing_row_id: "row-1", row_revision: 9, client_operation_id: "op-1", state: "queued", updated_at_ms: 0 }, row: { ...queuedRow, submission_state: "queued", projection: { ...queuedRow.projection, stage: "queued" } } },
      { row_id: "row-2", created: false, skipped: "blocked", blockers: ["missing_template"] },
    ],
  })))
  try {
    const results = await sendRows({ row_ids: ["row-1", "row-2"], expected_revisions: sendPins(["row-1", "row-2"]) }, undefined, { core: native })
    assert.deepEqual([results[0]!.outcome, results[0]!.job_id, results[0]!.product?.lifecycle.stage], ["start", "intent-1", "queued"])
    assert.deepEqual([results[1]!.outcome, results[1]!.noop_reason, results[1]!.blockers], ["blocked", "blocked", ["missing_template"]])
  } finally { stub.restore() }
})

test("submit refusals are blocked, while waiting and accepted rows remain noops", async () => {
  const reasons = ["compose_failed", "not_found", "store_mismatch", "store_unbound", "waiting", "already_accepted"]
  await residentSend(reasons)
  const stub = serve(cloud(() => ({ items: reasons.map((skipped) => ({ row_id: skipped, created: false, skipped, detail: skipped === "compose_failed" ? "品牌为必填项" : undefined })) })))
  try {
    const { settledRowMessage } = await import("../batch-operation")
    const results = await sendRows({ row_ids: reasons, expected_revisions: sendPins(reasons) }, undefined, { core: native })
    assert.deepEqual(results.map((result) => result.outcome), ["blocked", "blocked", "blocked", "blocked", "noop", "noop"])
    assert.deepEqual(results.slice(4).map((result) => result.noop_reason), ["waiting", "already_accepted"])
    assert.deepEqual(settledRowMessage(results[0], "发送失败"), { message: "该商品在云端拼接时被拒绝，请重新校验商品字段。查看字段校验结果并修正；仍失败请联系管理员核对该商品。", failed: true })
    assert.doesNotMatch(JSON.stringify(results[0]), /品牌为必填项/, "unstructured detail is not row presentation evidence")
    assert.equal(results[0]!.error?.code, "workflow_compose_failed")
    assert.equal(results[0]!.error?.remediation, "查看字段校验结果并修正；仍失败请联系管理员核对该商品。")
  } finally { stub.restore() }
})

test("one Store's failed submit is unconfirmed; another Store still sends", async () => {
  await residentSend(["row-a", "row-b"], (id) => id === "row-a" ? "store-a" : "store-b")
  const stub = serve(cloud((body) => body.storeId === "store-a" ? refusal(502, "OZON_PRODUCTS_FAILED", "store-a down") : accepted(body)))
  try {
    const results = await sendRows({ row_ids: ["row-a", "row-b"], expected_revisions: sendPins(["row-a", "row-b"], (id) => id === "row-a" ? "store-a" : "store-b") }, undefined, { core: native })
    assert.deepEqual([results[0]!.outcome, results[0]!.noop_reason, results[0]!.error?.message], ["unknown", "result_unconfirmed", "本次提交结果未确认，请核对原店铺的发送记录"])
    const cause = (results[0]!.error as OzonSubmissionError).requestCause!
    assert.deepEqual([cause.kind, cause.scope, cause.storeId, cause.rowIds, cause.status, cause.serverCode],
      ["result_unconfirmed", "request", "store-a", ["row-a"], 502, "OZON_PRODUCTS_FAILED"])
    assert.doesNotMatch(JSON.stringify(results[0]!.error), /store-a down/)
    assert.equal(results[1]!.outcome, "start")
  } finally { stub.restore() }
})

test("a transport failure and a generic 409 are Unknown and never resent", async () => {
  await residentSend(["lost", "refused"], (id) => `store-${id}`)
  const stub = serve(cloud((body) => {
    if (body.storeId === "store-lost") throw new TypeError("network down")
    return refusal(409, "conflict", "该店铺正在发送，本次未发送")
  }))
  try {
    const results = await sendRows({ row_ids: ["lost", "refused"], expected_revisions: sendPins(["lost", "refused"], (id) => `store-${id}`) }, undefined, { core: native })
    assert.deepEqual(results.map((result) => [result.outcome, result.noop_reason]), [["unknown", "result_unconfirmed"], ["unknown", "result_unconfirmed"]])
    assert.equal(submits(stub.calls).length, 2, "Unknown is never retried automatically")
  } finally { stub.restore() }
})

test("send submits at most two Stores at once, the Cloud batch budget", async () => {
  const rowIds = ["row-1", "row-2", "row-3", "row-4"]
  const store = (id: string) => `store-${id.slice(-1)}`
  await residentSend(rowIds, store)
  const releases: Array<() => void> = []
  let inFlight = 0
  let peak = 0
  const stub = serve(cloud(async (body) => {
    inFlight += 1
    peak = Math.max(peak, inFlight)
    await new Promise<void>((resolve) => releases.push(resolve))
    inFlight -= 1
    return accepted(body)
  }))
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
  try {
    const running = sendRows({ row_ids: rowIds, expected_revisions: sendPins(rowIds, store) }, undefined, { core: native })
    for (let attempt = 0; attempt < 100 && releases.length < 2; attempt += 1) await tick()
    assert.equal(releases.length, 2, "two Stores are in flight; the other two wait their turn")
    while (releases.length || inFlight) {
      releases.splice(0).forEach((release) => release())
      await tick()
    }
    assert.deepEqual((await running).map((result) => result.outcome), rowIds.map(() => "start"))
    assert.equal(peak, 2)
  } finally { stub.restore() }
})

test("row cancellation skips only that row in the next same-Store chunk", async () => {
  const rowIds = Array.from({ length: 102 }, (_, index) => `bulk-${index}`)
  await residentSend(rowIds)
  let release!: () => void
  const submitted: string[][] = []
  const cancelled = new Set<string>()
  const stub = serve(cloud(async (body) => {
    submitted.push(body.row_ids)
    if (submitted.length === 1) await new Promise<void>((resolve) => { release = resolve })
    return accepted(body)
  }))
  try {
    const running = sendRows({ row_ids: rowIds, expected_revisions: sendPins(rowIds) }, (id) => cancelled.has(id), { core: native })
    for (let attempt = 0; attempt < 200 && submitted.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    cancelled.add("bulk-100")
    release()
    const results = await running
    assert.deepEqual(submitted[1], ["bulk-101"])
    assert.ok(results.slice(0, 100).every((result) => result.outcome === "start"))
    assert.equal(results.find((result) => result.row_id === "bulk-100")?.noop_reason, "cancelled")
    assert.equal(results.find((result) => result.row_id === "bulk-101")?.outcome, "start")
  } finally { release?.(); stub.restore() }
})

test("stop after two Stores start keeps both in-flight chunks and skips both follow-up chunks", async () => {
  const rowIds = [...Array.from({ length: 101 }, (_, i) => `a-${i}`), ...Array.from({ length: 101 }, (_, i) => `b-${i}`)]
  const store = (id: string) => id.startsWith("a-") ? "store-a" : "store-b"
  await residentSend(rowIds, store)
  const releases: Array<() => void> = []
  let stop = false
  const bodies: Array<{ storeId: string, row_ids: string[] }> = []
  const stub = serve(cloud(async (body) => {
    bodies.push(body)
    await new Promise<void>((resolve) => releases.push(resolve))
    return accepted(body)
  }))
  try {
    const running = sendRows({ row_ids: rowIds, expected_revisions: sendPins(rowIds, store) }, () => stop, { core: native })
    for (let attempt = 0; attempt < 400 && releases.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(releases.length, 2)
    stop = true
    releases.splice(0).forEach((release) => release())
    const results = await running
    assert.deepEqual(bodies.map(({ storeId, row_ids: ids }) => [storeId, ids.length]).sort(), [["store-a", 100], ["store-b", 100]])
    assert.equal(results.filter((result) => result.noop_reason === "cancelled").length, 2)
  } finally { releases.splice(0).forEach((release) => release()); stub.restore() }
})

for (const count of [100, 101, 201]) {
  test(`send splits ${count} same-store rows into bounded chunks with no reads`, async () => {
    const rowIds = Array.from({ length: count }, (_, i) => `bulk-${i}`)
    await residentSend(rowIds)
    const stub = serve(cloud((body) => accepted(body)))
    try {
      const results = await sendRows({ row_ids: rowIds, expected_revisions: sendPins(rowIds) }, undefined, { core: native })
      const batches = submits(stub.calls)
      assert.deepEqual(batches.map((call) => call.body.row_ids.length), count === 100 ? [100] : count === 101 ? [100, 1] : [100, 100, 1])
      assert.deepEqual(batches.flatMap((call) => call.body.row_ids), rowIds)
      for (const batch of batches) assert.deepEqual(batch.body.expectedRevisions,
        batch.body.row_ids.map((rowId: string) => ({ rowId, revision: 9 })))
      assert.ok(results.every((result) => result.outcome === "start" && !result.error))
      assert.equal(gets(stub.calls).length, 0)
    } finally { stub.restore() }
  })
}

for (const providerStatus of [200, 403, 429]) test(`250 rows keep batch receipts; Seller ${providerStatus} stops only its Store when required`, async () => {
  const ids = [...Array.from({ length: 250 }, (_, i) => `receipt-${i}`), "other-store"]
  const store = (id: string) => id === "other-store" ? "store-b" : "store-a"
  await residentSend(ids, store)
  const batches: { store: string, ids: string[] }[] = []
  const stub = serve(cloud((body) => {
    batches.push({ store: body.storeId, ids: body.row_ids })
    const status = body.storeId === "store-a" ? providerStatus : 200
    const receipt = { batch_id: `${body.storeId}-${batches.length}`, item_count: body.row_ids.length, http_status: status, response_body: `provider response ${status}`, received_at_ms: 1 }
    return { items: body.row_ids.map((id) => {
      const row = nativeRowView(id, { storeId: body.storeId, viewRevision: 2 })
      return {
        row_id: id, created: true,
        intent: { id: `intent-${id}`, external_task_id: status === 200 ? "42" : undefined, submission_receipt: receipt },
        row: { ...row, projection: { ...row.projection, submission_receipt: receipt } },
      }
    }) }
  }))
  try {
    const results = await sendRows({ row_ids: ids, expected_revisions: sendPins(ids, store) }, undefined, { core: native })
    assert.deepEqual(batches.filter((batch) => batch.store === "store-a").map((batch) => batch.ids.length), providerStatus === 200 ? [100, 100, 50] : [100])
    assert.equal(batches.filter((batch) => batch.store === "store-b").length, 1)
    for (const batch of batches) for (const id of batch.ids) {
      const result = results.find((result) => result.row_id === id)!
      assert.equal(result.submissionReceipt?.item_count, batch.ids.length)
      assert.equal(result.product?.lifecycle.submissionReceipt?.response_body, result.submissionReceipt?.response_body)
    }
    if (providerStatus !== 200) assert.ok(results.slice(100, 250).every((result) => result.blockers.includes("store_rate_limited")))
  } finally { stub.restore() }
})

test("a 429 chunk halts the Store's later chunks; a 5xx chunk is unconfirmed and later chunks still go", async () => {
  const rowIds = Array.from({ length: 250 }, (_, i) => `r-${i}`)
  await residentSend(rowIds)
  let posts = 0
  const stub = serve(cloud((body) => ++posts === 2 ? refusal(429, "busy", "rate limited") : accepted(body)))
  try {
    const results = await sendRows({ row_ids: rowIds, expected_revisions: sendPins(rowIds) }, undefined, { core: native })
    assert.deepEqual(submits(stub.calls).map((call) => call.body.row_ids.length), [100, 100])
    assert.ok(results.slice(100).every((result) => result.error?.code === "cloud_rate_limited" || result.blockers.includes("store_rate_limited")))
  } finally { stub.restore() }
  resetSendState()
  const more = Array.from({ length: 201 }, (_, i) => `m-${i}`)
  await residentSend(more)
  posts = 0
  const unstable = serve(cloud((body) => ++posts === 2 ? refusal(503, "unavailable", "test refusal") : accepted(body)))
  try {
    const results = await sendRows({ row_ids: more, expected_revisions: sendPins(more) }, undefined, { core: native })
    assert.equal(posts, 3)
    assert.ok(results.slice(100, 200).every((result) => result.outcome === "unknown" && result.noop_reason === "result_unconfirmed" && result.error))
    assert.equal(results[200]!.outcome, "start")
  } finally { unstable.restore() }
})

test("the card coordinate comes from the open session, never from row defaults", async () => {
  residentRows([nativeRowView("row-1")])
  const stub = serve((call) => {
    if (call.url === `${route("listingCards")}/${CARD}`) return { id: CARD, title: "golden", revision: 1, store_id: "store-1", payload: { ...golden.card, typeId: 0 }, updated_at_ms: 0 }
    return cloud(() => { throw new Error("must not submit") })(call)
  })
  try {
    const [result] = await sendRows({ row_ids: ["row-1"], expected_revisions: sendPins(["row-1"]) }, undefined, { core: native })
    assert.deepEqual([result!.outcome, result!.error?.code], ["blocked", "workflow_card_payload_invalid"])
    assert.equal(stub.calls.filter(isSchema).length + submits(stub.calls).length, 0)
  } finally { stub.restore() }
})

/**
 * The Ozon adapter over the real compiled `listing-core-wasm` (op 11): the
 * wire-golden row freezes to the same body, digest and `clientOperationId`
 * native Rust pins (`rust/crates/listing-core-wasm/tests/freeze_abi.rs` exports
 * the input), stale/AI-unresolved/invalid rows are refused with actionable
 * issues, and build makes no network call. Rebuild the artifact with
 * `scripts/build-wasm.sh core --copy` after changing the crate.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import type { CardPayload, CategorySchemaSnapshot, LeanRow } from "@/listing-core/types"
import { createListingCore, type ListingCore } from "@/listing-core/wasm"
import { createListingPlatforms, createListingSendCapabilities } from "."
import { createOzonAdapter } from "./ozon"
import type { OzonFieldRules } from "./ozon-fields"
import { createSendQueue } from "../submit/send-queue"
import { finalQueueHarness } from "../submit/send-test-support"
import { route } from "@/api/routes"
import { wbConfigFixture, wbMaterialFixture } from "../../../../tests/publish-pipeline-fixtures"

const root = new URL("../../../../../", import.meta.url)
const readJson = <T>(path: string): T => JSON.parse(readFileSync(new URL(path, root), "utf8")) as T

type Golden = { rowId: string; row: LeanRow; card: CardPayload; expected: { digest: string; offerId: string; clientOperationId: string } }
const golden = readJson<Golden>("rust/crates/listing-core-wasm/tests/fixtures/ambient/ozon-freeze-golden.json")
const schema = readJson<CategorySchemaSnapshot>("rust/crates/listing-core-wasm/tests/fixtures/ambient/decorative-wall-art-schema.json")
const wireGolden = readJson<unknown>("fixtures/listing/ozon/product-import-request.json")

let core: ListingCore
let handle: number

test.before(async () => {
  let memory: WebAssembly.Memory | undefined
  const { instance } = await WebAssembly.instantiate(readFileSync(new URL("wasm/dist/browser/listing-state.wasm", root)), {
    env: { fill_random: (ptr: number, len: number) => crypto.getRandomValues(new Uint8Array(memory!.buffer, ptr, len)) },
  })
  memory = instance.exports.memory as WebAssembly.Memory
  core = createListingCore(instance.exports)
  handle = core.loadSchema({ snapshot: schema })
})

const NOW = 1_790_000_000_000
const platforms = () => createListingPlatforms(core, (issue) => ({ ...issue.key, field: issue.field, message: "fixture issue", remediation: "fixture action" }))
const ozonInput = (row: LeanRow) => ({ schemaHandle: handle, card: golden.card, nowMs: NOW, rows: [{ rowId: golden.rowId, storeId: "store-1", row }] })
const build = (row: LeanRow, fields?: OzonFieldRules) =>
  (fields ? createOzonAdapter(core, { fields }) : platforms().ozon).build(ozonInput(row))

test("the golden row freezes through WASM to the native wire golden and identities, with no fetch", async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = (async () => { calls += 1; throw new Error("network forbidden") }) as unknown as typeof fetch
  let built
  try {
    built = await build(golden.row)
  } finally {
    globalThis.fetch = original
  }
  assert.equal(calls, 0)
  assert.deepEqual(built.blocked, [])
  const [item] = built.frozen
  assert.deepEqual(item!.body.import, wireGolden)
  assert.equal(item!.digest, golden.expected.digest)
  assert.equal(item!.body.offerId, golden.expected.offerId)
  assert.equal(item!.clientOperationId, golden.expected.clientOperationId)
  assert.ok(item!.provenance.some((entry) => entry.field === "offer_id" || entry.stage === "DatabaseDefault"))
})

test("a stale schema revision is refused before build", async () => {
  const built = await build({ ...golden.row, schemaRevision: "older" })
  const [issue] = built.blocked[0]!.issues
  assert.deepEqual([issue!.stage, issue!.code], ["freeze", "schema_stale"])
  assert.equal(built.frozen.length, 0)
})

test("an unconfirmed AI candidate is never publishable", async () => {
  const candidate = { address: { kind: "plain" as const, field_key: "name" }, value: { kind: "text" as const, value: "AI" }, current_value: null, source: "ocr", state: "proposed" as const, issue: null }
  const built = await build({ ...golden.row, ai: { ...golden.row.ai, candidates: [candidate] } })
  const [issue] = built.blocked[0]!.issues
  assert.deepEqual([issue!.stage, issue!.field, issue!.code], ["freeze", "name", "ai_candidate_unresolved"])
})

test("a validation refusal keeps the core's actionable field issues", async () => {
  const values = { ...golden.row.draft.values }
  delete values.name
  const built = await build({ ...golden.row, draft: { ...golden.row.draft, values } })
  const issues = built.blocked[0]!.issues
  const name = issues.find((issue) => issue.field === "name")
  assert.equal(name?.stage, "validate")
  assert.ok(name?.message && name.remediation)
})

test("production registry: Ozon uses final queue while WB preview has no send capability", async () => {
  const { rows, scope } = await finalQueueHarness()
  const original = globalThis.fetch
  const sent: string[] = []
  const previews: string[] = []
  const seed = rows.get("r0")!
  rows.remove(["r0"])
  rows.create([{ ...seed, id: golden.rowId, row: structuredClone(golden.row) }])
  const registry = createListingSendCapabilities({ core: { ...core, freezeListing(h, input) {
    const result = core.freezeListing(h, input)
    if (result.status === "frozen") previews.push(result.clientOperationId)
    return result
  } }, schemaHandle: () => handle, card: () => golden.card, cardId: scope.cardId })
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), route("listingSubmit"))
    const body = JSON.parse(String(init?.body)) as { card_id: string; store_id: string; items: Array<{ rowId: string }> }
    sent.push(...body.items.map((item) => item.rowId))
    return Response.json({ data: { server_schema_revision: golden.row.schemaRevision, items: body.items.map((item) => ({
      row_id: item.rowId, outcome: "created", intent: { id: `i-${item.rowId}`, listing_row_id: item.rowId, store_id: body.store_id,
        row_revision: 0, client_operation_id: `server-${item.rowId}`, state: "accepted", external_task_id: "42", can_resume: false,
        current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1 },
    })) } })
  }
  const queue = createSendQueue({ rows, ...scope, capabilities: registry, current: () => true })
  try {
    const wbHandle = core.loadWbMaterial(wbMaterialFixture())
    const wb = await platforms().wb.build({ material: () => wbHandle, groups: [{ key: "g1", config: wbConfigFixture() }] })
    assert.equal(wb.frozen.length, 1)
    assert.equal(Object.hasOwn(registry, "wb"), false, "preview-only platform cannot enter a send capability")
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: [golden.rowId] }])
    assert.deepEqual(previews, [golden.expected.clientOperationId])
    assert.deepEqual(sent, [golden.rowId], "no WB submit and no Ozon fallback for its preview")
    assert.equal(queue.snapshot().counts.accepted, 1)
  } finally { globalThis.fetch = original; await rows.close() }
})

type ImportItem = Record<string, unknown>
const itemOf = (body: unknown) => ((body as { items: ImportItem[] }).items)[0]!

test("one field rule changes only its own field in the canonical body, as the operator layer", async () => {
  const built = await build(golden.row, { price: () => ({ value: { kind: "text", value: "120" } }) })
  assert.deepEqual(built.blocked, [])
  const [item] = built.frozen
  const expected = structuredClone(itemOf(wireGolden))
  expected.price = "120"
  assert.deepEqual(itemOf(item!.body.import), expected, "every sibling field keeps its golden value")
  assert.notEqual(item!.digest, golden.expected.digest, "the native digest follows the new body")
  assert.equal(item!.clientOperationId, `workflow:${golden.rowId}:ART-001:${item!.digest}`)
  assert.deepEqual(item!.provenance.find((entry) => entry.field === "price"), { field: "price", stage: "UserCustom" })
  assert.equal(golden.row.handEditedKeys.length, 0, "the fixture row is not mutated")
})

test("a rule's clear is a real clear: the native validator refuses the missing required field", async () => {
  const built = await build(golden.row, { name: () => ({ clear: true }) })
  const name = built.blocked[0]!.issues.find((issue) => issue.field === "name")
  assert.deepEqual([name?.stage, name?.code], ["validate", "required"])
})

test("a field rule never settles an unresolved AI candidate", async () => {
  const candidate = { address: { kind: "plain" as const, field_key: "name" }, value: { kind: "text" as const, value: "AI" }, current_value: null, source: "ocr", state: "unresolved" as const, issue: null }
  const built = await build({ ...golden.row, ai: { ...golden.row.ai, candidates: [candidate] } }, { name: () => ({ value: { kind: "text", value: "Picture" } }) })
  assert.equal(built.blocked[0]!.issues[0]!.code, "ai_candidate_unresolved")
})

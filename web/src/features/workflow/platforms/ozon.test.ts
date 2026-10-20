/**
 * Ozon adapter routing with a stubbed core: how core refusals become
 * platform issues, row identity/store/duplicate-offer blocking, core
 * failures, stage replacement, and what one per-field rule hands the core.
 * Real freeze bytes are `wasm-freeze.test.ts`'s job.
 */
import assert from "node:assert/strict"
import test from "node:test"

import { goldenSchema, wasmCore } from "../submit/send-test-support"
import type { BuildEvidence, CardPayload, FieldIssue, FreezeListingInput, FreezeListingOutput, LeanRow } from "@/listing-core/types"
import { createOzonAdapter, type OzonAdapterOptions, type OzonBuildInput, type OzonFreezeCore } from "./ozon"

const evidence: BuildEvidence = {
  digest: "sha256:build",
  card_defaults_digest: "sha256:card",
  sources: [[{ kind: "plain", field_key: "offer_id" }, "SourceFile"]],
}

function frozen(rowId: string, offerId = rowId): FreezeListingOutput {
  return { status: "frozen", import: { items: [] }, digest: `sha256:${rowId}`, offerId, clientOperationId: `workflow:${rowId}:${offerId}:sha256:${rowId}`, evidence }
}

function core(answer: (input: FreezeListingInput) => FreezeListingOutput): OzonFreezeCore & { calls: FreezeListingInput[] } {
  const calls: FreezeListingInput[] = []
  return { calls, freezeListing: (_handle, input) => (calls.push(input), answer(input)) }
}

const card: CardPayload = {
  categoryKey: "workflow:1:1",
  descriptionCategoryId: 1,
  typeId: 1,
  defaults: { values: { price: { kind: "text", value: "90" }, weight: { kind: "text", value: "310" } }, complex_values: [] },
  aiFieldPolicy: { allowed_field_keys: [], protected_field_keys: [] },
}

const leanRow: LeanRow = {
  categoryKey: "workflow:1:1",
  descriptionCategoryId: 1,
  typeId: 1,
  language: "default",
  schemaRevision: "rev-1",
  draft: { values: { name: { kind: "text", value: "Картина" } }, complex_values: [], cleared: [] },
  handEditedKeys: [],
  fieldOrigins: [{ address: { kind: "plain", field_key: "name" }, kind: "ai_confirmed", source_ref: null, updated_at_ms: 1 }],
  normalizedSnapshot: null,
  validationIssues: [],
  source: { assetId: "", sha256: "", fileName: "ART-1.psd" },
  renderEvidence: null,
  media: { images: [], videos: [] },
  ai: { requestId: "", candidates: [], promptSha256: "", modelVersion: "" },
  failureLog: [],
}

const input = (rows: { rowId: string; storeId?: string }[]): OzonBuildInput => ({
  schemaHandle: 1,
  card,
  nowMs: 1_790_000_000_000,
  rows: rows.map(({ rowId, storeId = "store-1" }) => ({ rowId, storeId, row: leanRow })),
})

const fieldIssue = (patch: Partial<FieldIssue>): FieldIssue => ({
  field_key: "name",
  code: "required",
  parameters: {},
  severity: "blocking",
  address: { kind: "plain", field_key: "name" },
  message: "商品名称：必填",
  remediation: "填写商品名称",
  ...patch,
})

const build = (stub: OzonFreezeCore, rows: { rowId: string; storeId?: string }[], options?: OzonAdapterOptions) =>
  createOzonAdapter(stub, options).build(input(rows))

test("frozen rows keep the core's identities and provenance; no rules hand the row over untouched", async () => {
  const stub = core(({ rowId }) => frozen(rowId))
  const built = await build(stub, [{ rowId: "r1" }])
  const [item] = built.frozen
  assert.equal(item!.clientOperationId, "workflow:r1:r1:sha256:r1")
  assert.deepEqual(item!.provenance, [{ field: "offer_id", stage: "SourceFile" }])
  assert.ok(Object.isFrozen(item!.body))
  assert.equal(stub.calls[0]!.row, leanRow, "without field rules the exact row object reaches the core")
})

test("core refusals become Ozon issues with stage, field, Chinese message and remediation", async () => {
  const answers: Record<string, FreezeListingOutput> = {
    stale: { status: "refused", reason: "schema_stale", issueStage: "freeze", evidence: null, issues: [fieldIssue({ field_key: "schema_revision", code: "schema_stale", remediation: null })] },
    ai: { status: "refused", reason: "candidates_unresolved", issueStage: "freeze", evidence: null, issues: [fieldIssue({ code: "ai_candidate_unresolved" })] },
    invalid: { status: "refused", reason: "validation_failed", issueStage: "validate", evidence, issues: [fieldIssue({})] },
    freeze: { status: "refused", reason: "freeze_failed", issueStage: "freeze", evidence, issues: [fieldIssue({ field_key: "import", code: "freeze_failed", parameters: { detail: { kind: "text", value: "serde: bad" } } })] },
  }
  const built = await build(core(({ rowId }) => answers[rowId]!), Object.keys(answers).map((rowId) => ({ rowId })))
  const byKey = Object.fromEntries(built.blocked.map((item) => [item.key, item.issues[0]!]))
  assert.deepEqual(
    Object.values(byKey).map((issue) => [issue.platform, issue.stage, issue.field, issue.code]),
    [["ozon", "freeze", "schema_revision", "schema_stale"], ["ozon", "freeze", "name", "ai_candidate_unresolved"], ["ozon", "validate", "name", "required"], ["ozon", "freeze", "import", "freeze_failed"]],
  )
  assert.equal(byKey.stale!.remediation, "重新打开上架方案同步类目字段后再发送", "a missing core remediation falls back per reason")
  assert.ok(!byKey.freeze!.message.includes("serde"))
  assert.match(byKey.freeze!.diagnostic!, /serde: bad/)
})

test("blank, untrimmed and duplicate row ids are refused before any freeze", async () => {
  const stub = core(({ rowId }) => frozen(rowId))
  const built = await build(stub, [{ rowId: "dup" }, { rowId: "" }, { rowId: "ok" }, { rowId: "dup" }, { rowId: " x" }])
  assert.deepEqual(stub.calls.map((call) => call.rowId), ["ok"])
  assert.deepEqual(built.blocked.map((item) => [item.key, item.issues[0]!.code]), [["dup", "row_id_duplicate"], ["", "row_id_invalid"], [" x", "row_id_invalid"]])
  assert.deepEqual(built.frozen.map((item) => item.key), ["ok"])
})

test("an empty Ozon selection is an actionable refusal", async () => {
  const built = await createOzonAdapter(core(() => { throw new Error("unreachable") })).build({ ...input([]), rows: [] })
  assert.deepEqual(built.blocked.map((item) => item.issues[0]!.code), ["rows_empty"])
  assert.ok(built.blocked[0]!.issues[0]!.remediation)
})

test("a row without a store is blocked before the core runs; a core failure is not shown raw", async () => {
  const stub = core(() => { throw new Error("CORE_SCHEMA_HANDLE: unknown or dropped schema handle") })
  const built = await build(stub, [{ rowId: "r1", storeId: " " }, { rowId: "r2" }])
  assert.deepEqual(stub.calls.map((call) => call.rowId), ["r2"])
  const [missing, failed] = built.blocked.map((item) => item.issues[0]!)
  assert.equal(missing!.code, "target_store_missing")
  assert.equal(failed!.code, "core_unavailable")
  assert.ok(!failed!.message.includes("CORE_"))
  assert.match(failed!.diagnostic!, /CORE_SCHEMA_HANDLE/)
})

test("the same offer twice in one store blocks both rows; other stores are independent", async () => {
  const built = await build(core(() => frozen("x", "ART-1")), [{ rowId: "a" }, { rowId: "b" }, { rowId: "c", storeId: "store-2" }])
  assert.deepEqual(built.blocked.map((item) => [item.key, item.issues[0]!.code]), [["a", "offer_id_duplicate"], ["b", "offer_id_duplicate"]])
  assert.deepEqual(built.frozen.map((item) => item.key), ["c"])
})

test("replacing the freeze stage keeps the offer check, and an async core works", async () => {
  const stub: OzonFreezeCore = { freezeListing: async (_handle, { rowId }) => frozen(rowId, "SAME") }
  const built = await build(stub, [{ rowId: "a" }, { rowId: "b" }], {
    stages: {
      freezeRow: async (freezeCore, buildInput, rowInput) => {
        const output = await freezeCore.freezeListing(buildInput.schemaHandle, { card: buildInput.card, row: rowInput.row, rowId: rowInput.rowId })
        assert.equal(output.status, "frozen")
        return { key: rowInput.rowId, body: { rowId: rowInput.rowId, storeId: rowInput.storeId, offerId: "SAME", import: {}, evidence }, digest: "d", clientOperationId: "c", provenance: [] }
      },
    },
  })
  assert.deepEqual(built.blocked.map((item) => item.issues[0]!.code), ["offer_id_duplicate", "offer_id_duplicate"])
})

test("one field rule rewrites only its own field as an operator edit, on a clone", async () => {
  const seen: unknown[] = []
  const stub = core(({ rowId }) => frozen(rowId))
  const native = await wasmCore()
  const handle = native.loadSchema({ snapshot: goldenSchema })
  stub.editRow = (_handle, edit) => native.editRow(handle, edit)
  await build(stub, [{ rowId: "r1" }], {
    fields: {
      price: (current, context) => (seen.push(current, context.card.categoryKey), { value: { kind: "text", value: "120" } }),
      name: () => ({ clear: true }),
    },
  })
  assert.deepEqual(seen, [{ kind: "text", value: "90" }, "workflow:1:1"], "the rule sees the Card default when the row has no value")
  const sent = stub.calls.at(-1)!.row
  assert.deepEqual(sent.draft.values, { price: { kind: "text", value: "120" } })
  assert.deepEqual(sent.draft.cleared, ["name"])
  assert.deepEqual(sent.handEditedKeys, ["name", "price"])
  assert.deepEqual([...sent.fieldOrigins].sort((a, b) => JSON.stringify(a.address).localeCompare(JSON.stringify(b.address))), [
    { address: { kind: "plain", field_key: "name" }, kind: "manual", source_ref: null, updated_at_ms: 1_790_000_000_000 },
    { address: { kind: "plain", field_key: "price" }, kind: "manual", source_ref: null, updated_at_ms: 1_790_000_000_000 },
  ], "the rule's origin replaces the AI one at the same address; no other origin is touched")
  assert.deepEqual(sent.ai, leanRow.ai, "AI candidates are never settled by a rule")
  assert.deepEqual(leanRow.draft.values, { name: { kind: "text", value: "Картина" } }, "the input row is not mutated")
  assert.deepEqual(leanRow.handEditedKeys, [])
})

test("a rule that throws or answers nonsense blocks only its row, before the core", async () => {
  const stub = core(({ rowId }) => frozen(rowId))
  const throwing = await build(stub, [{ rowId: "r1" }], { fields: { price: () => { throw new Error("rule crashed") } } })
  assert.deepEqual(throwing.blocked[0]!.issues.map((issue) => [issue.stage, issue.field, issue.code]), [["field", "price", "field_rule_failed"]])
  assert.ok(!throwing.blocked[0]!.issues[0]!.message.includes("crashed"))
  const nonsense = await build(stub, [{ rowId: "r1" }], { fields: { price: () => ({ value: "120" }) as never } })
  assert.equal(nonsense.blocked[0]!.issues[0]!.code, "field_rule_invalid")
  assert.equal(stub.calls.length, 0)
  assert.throws(() => createOzonAdapter(stub, { fields: { " ": () => ({ clear: true }) } }), /blank field key/)
})

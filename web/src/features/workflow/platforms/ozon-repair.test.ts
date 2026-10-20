import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { LeanRow, SubmitDraft } from "@/listing-core/types"
import { createSchemaCache } from "../schema-cache"
import { createOzonRepair, type ReuploadRows } from "./ozon-repair"
import { createOzonSendCapability } from "./ozon"
import { createSendQueue } from "../submit/send-queue"
import { finalQueueHarness, golden, goldenSchema, wasmCore } from "../submit/send-test-support"

async function harness() {
  const local = await finalQueueHarness()
  local.rows.update("r0", (row) => ({ ...row, row: structuredClone(golden.row) }))
  const core = await wasmCore(), schemas = createSchemaCache(core)
  const initialHandle = (await schemas.load({ platform: "ozon", coordinate: [1], language: "default", materialDigest: "old", defaultsRevision: "1", sessionFence: "fixture" }, { snapshot: goldenSchema })).handle
  return { ...local, core, schemas, initialHandle }
}
const confirmed: ReuploadRows = async (selected) => selected.map((row) => ({
  rowId: row.id, revision: row.rev, state: "confirmed" as const, images: (row.row as LeanRow).media.images.map((image) => ({
    ...image, phase: "public_ready" as const, public_url: "https://media.example.invalid/renewed.jpg", object_key: "fixture/new.jpg", account_id: "fixture-account",
  })),
}))

test("schema refresh and confirmed media reupload change real native Drafts before one resubmit each", async () => {
  const h = await harness()
  const drafts: SubmitDraft[] = []
  let refreshes = 0, uploads = 0
  const repair = createOzonRepair({ ...h, accountId: "fixture-account", card: () => golden.card, current: () => true,
    refreshSchema: async () => {
      refreshes++
      return { identity: { platform: "ozon", coordinate: [1], language: "default", materialDigest: "new", defaultsRevision: "1", sessionFence: "fixture" }, material: { snapshot: { ...goldenSchema, schema_revision: "fixture-new" } } }
    },
    reuploadRows: async (selected, signal) => { uploads++; return confirmed(selected, signal) },
  })
  const capability = createOzonSendCapability({ ...repair, core: h.core, card: () => golden.card, cardId: h.scope.cardId })
  const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: capability } })
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), route("listingSubmit"), "no complete, probe or Cloud row request")
    const body = JSON.parse(String(init?.body)) as { items: SubmitDraft[]; store_id: string }
    drafts.push(structuredClone(body.items[0]!))
    if (drafts.length <= 2) return Response.json({ data: { server_schema_revision: "fixture-new", items: [{ row_id: "r0", outcome: "skipped", skip_reason: drafts.length === 1 ? "schema_stale" : "media_expired" }] } })
    return Response.json({ data: { server_schema_revision: "fixture-new", items: [{ row_id: "r0", outcome: "created", intent: {
      id: "i1", listing_row_id: "r0", store_id: body.store_id, row_revision: 1, client_operation_id: "server", state: "accepted", external_task_id: "42", can_resume: false,
      current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 1,
    } }] } })
  }
  try {
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    assert.equal(drafts.length, 3); assert.equal(refreshes, 1); assert.equal(uploads, 1)
    assert.equal(drafts[0]!.schemaRevision, golden.row.schemaRevision)
    assert.equal(drafts[1]!.schemaRevision, "fixture-new")
    assert.match(JSON.stringify(drafts[2]), /renewed\.jpg/)
    assert.doesNotMatch(JSON.stringify(drafts[1]), /renewed\.jpg/)
    const frozen = h.core.freezeListing(repair.schemaHandle(), { rowId: "r0", row: h.rows.get("r0")!.row as LeanRow, card: golden.card })
    assert.equal(frozen.status, "frozen")
    if (frozen.status === "frozen") assert.match(JSON.stringify(frozen.import), /renewed\.jpg/, "the actual native import uses the confirmed replacement media")
    assert.equal(h.rows.get("r0")!.submission!.state, "accepted")
    assert.deepEqual(h.rows.cardState()!.publish!.blocks[0]!.budget, { submits: 3, schema: 1, media: 1 })
  } finally { globalThis.fetch = original; await h.rows.close(); await h.schemas.close() }
})

for (const mode of ["failure", "stop", "scope", "revision", "unconfirmed", "queued", "accepted", "unproven"] as const) test(`media repair ${mode} cannot write a speculative URL or readmit`, async () => {
  const h = await harness(), stop = new AbortController()
  let current = true, uploads = 0
  h.rows.update("r0", (row) => ({ ...row, submission: { storeId: "s1", state: ["unconfirmed", "queued", "accepted"].includes(mode) ? mode as "unconfirmed" | "queued" | "accepted" : "rejected",
    receipt: { state: "rejected", canResume: true, code: "media_expired" } } }))
  const captured = h.rows.get("r0")!
  const before = structuredClone((captured.row as LeanRow).media)
  const repair = createOzonRepair({ ...h, accountId: "fixture-account", card: () => golden.card, current: () => current,
    reuploadRows: async (selected, signal) => {
      uploads++
      assert.deepEqual((h.rows.get("r0")!.row as LeanRow).media, before)
      if (mode === "failure") throw new Error("upload failed")
      if (mode === "stop") stop.abort()
      if (mode === "scope") current = false
      if (mode === "revision") h.rows.update("r0", (row) => ({ ...row }))
      const receipts = await confirmed(selected, signal)
      return mode === "unproven" ? receipts.map((receipt) => ({ ...receipt, state: "unconfirmed" as never })) : receipts
    },
  })
  try {
    await assert.rejects(repair.repair("media", [captured], stop.signal))
    assert.deepEqual((h.rows.get("r0")!.row as LeanRow).media, before)
    assert.equal(uploads, ["unconfirmed", "queued", "accepted"].includes(mode) ? 0 : 1)
  } finally { await h.rows.close(); await h.schemas.close() }
})

test("missing S15 port exposes manual repair and consumes no automatic media credit", async () => {
  const h = await harness()
  const repair = createOzonRepair({ ...h, accountId: "fixture-account", card: () => golden.card, current: () => true })
  assert.equal(repair.canRepair("media"), false)
  let submits = 0
  const native = createOzonSendCapability({ ...repair, core: h.core, card: () => golden.card, cardId: h.scope.cardId })
  const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: { ...native,
    async send(_destination, items) { submits++; return new Map(items.map((item) => [item.rowId, { state: "rejected", canResume: true, code: "media_expired" }])) },
  } } })
  try {
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    assert.equal(submits, 1)
    assert.equal(h.rows.cardState()!.publish!.blocks[0]!.budget.media, 0)
    assert.equal(h.rows.get("r0")!.submission!.state, "rejected")
  } finally { await h.rows.close(); await h.schemas.close() }
})

for (const kind of ["schema", "media"] as const) test(`native ${kind} repair cannot auto-resend a second confirmed refusal`, async () => {
  const h = await harness()
  let repairs = 0, submits = 0
  const repair = createOzonRepair({ ...h, accountId: "fixture-account", card: () => golden.card, current: () => true,
    refreshSchema: async () => { repairs++; return {
      identity: { platform: "ozon", coordinate: [1], language: "default", materialDigest: "changed", defaultsRevision: "1", sessionFence: "fixture" },
      material: { snapshot: { ...goldenSchema, schema_revision: "changed" } },
    } },
    reuploadRows: async (selected, signal) => { repairs++; return confirmed(selected, signal) },
  })
  const capability = createOzonSendCapability({ ...repair, core: h.core, card: () => golden.card, cardId: h.scope.cardId })
  const queue = createSendQueue({ rows: h.rows, ...h.scope, current: () => true, capabilities: { ozon: capability } })
  const original = globalThis.fetch
  const drafts: SubmitDraft[] = []
  globalThis.fetch = async (_url, init) => {
    submits++
    drafts.push((JSON.parse(String(init?.body)) as { items: SubmitDraft[] }).items[0]!)
    return Response.json({ data: { server_schema_revision: "changed", items: [{ row_id: "r0", outcome: "skipped", skip_reason: kind === "schema" ? "schema_stale" : "media_expired" }] } })
  }
  try {
    await queue.start([{ platform: "ozon", destination: "s1", rowIds: ["r0"] }])
    assert.equal(submits, 2); assert.equal(repairs, 1)
    if (kind === "schema") assert.equal(drafts[1]!.schemaRevision, "changed")
    else assert.equal(drafts[1]!.media!.images[0]!.public_url, "https://media.example.invalid/renewed.jpg")
    assert.notDeepEqual(drafts[0], drafts[1])
    const state = h.rows.cardState()!.publish!
    assert.equal(state.blocks[0]!.budget[kind], 1)
    assert.equal(h.rows.get("r0")!.submission!.state, "rejected")
    await queue.continue()
    assert.equal(submits, 2)
  } finally { globalThis.fetch = original; await h.rows.close(); await h.schemas.close() }
})

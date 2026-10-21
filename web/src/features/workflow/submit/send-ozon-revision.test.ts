import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { FrozenItem } from "../platforms/core"
import type { OzonBody } from "../platforms/ozon"
import { cloudRowResult, readSendHttpExchange, submitOzonChunk, type OzonSendContext } from "./send-ozon-transport"
import { revisionMismatch } from "./send-local"
import { accepted, serve } from "./send-test-support"

const ids = ["unpinned", "pinned", "stopped"]
const items: FrozenItem<OzonBody>[] = ids.map((key) => ({
  key, body: { rowId: key, storeId: "store", offerId: key, import: { name: "local preview" },
    evidence: { digest: "preview", card_defaults_digest: "defaults", sources: [] } },
  digest: "preview", clientOperationId: key, provenance: [],
}))
const context = (): OzonSendContext => ({ storeId: "store", pins: new Map([["pinned", { revision: 17 }]]),
  shouldStop: () => false, results: new Map(), syncRequired: false, replayed: false })

test("a frozen row without its click pin is locally refused without any request", async () => {
  const sending = context()
  const cloud = serve(() => { throw new Error("a missing click pin must never dispatch") })
  try {
    await submitOzonChunk(sending, [items[0]!])
    assert.equal(cloud.calls.length, 0)
    assert.deepEqual(sending.results.get("unpinned"), revisionMismatch("unpinned"))
  } finally { cloud.restore() }
})

test("only admitted rows and their original click pins travel together in the actual request", async () => {
  const sending = context()
  sending.shouldStop = (rowId) => rowId === "stopped"
  const cloud = serve(({ body }) => accepted(body))
  try {
    await submitOzonChunk(sending, items)
    assert.deepEqual(cloud.calls, [{ url: route("listingSubmit"), method: "POST", body: {
      storeId: "store", row_ids: ["pinned"], expectedRevisions: [{ rowId: "pinned", revision: 17 }],
    } }])
    assert.deepEqual(sending.results.get("unpinned"), revisionMismatch("unpinned"))
    assert.equal(sending.results.get("stopped")!.noop_reason, "cancelled")
    assert.equal(sending.results.get("pinned")!.outcome, "start")
  } finally { cloud.restore() }
})

for (const [status, code, mismatch] of [[409, "revision_mismatch", true], [409, "conflict", false], [503, "revision_mismatch", false]] as const) {
  test(`HTTP ${status} ${code} ${mismatch ? "proves a revision refusal" : "keeps the outcome unconfirmed"}`, async () => {
    const sending = context()
    const cloud = serve(() => Response.json({ code, message: "private server detail" },
      { status, headers: { "x-request-id": "revision-http-trace" } }))
    try {
      await submitOzonChunk(sending, [items[1]!])
      assert.equal(cloud.calls.length, 1, "a revision refusal is never replayed")
      const result = sending.results.get("pinned")!
      if (mismatch) assert.deepEqual(result, revisionMismatch("pinned"))
      else assert.deepEqual([result.outcome, result.noop_reason], ["unknown", "result_unconfirmed"])
      assert.deepEqual(readSendHttpExchange(result), { apiPath: route("listingSubmit"), apiStatus: status, requestId: "revision-http-trace" })
      assert.equal(sending.syncRequired, false)
      assert.doesNotMatch(JSON.stringify(result), /private server detail/)
    } finally { cloud.restore() }
  })
}

test("a per-row revision mismatch uses the local revision remedy instead of a compose failure", () => {
  const result = cloudRowResult({ row_id: "pinned", created: false, skipped: "revision_mismatch", detail: "stale row revision" })
  assert.deepEqual([result.outcome, result.noop_reason, result.error], ["blocked", "revision_mismatch", revisionMismatch("pinned").error])
})

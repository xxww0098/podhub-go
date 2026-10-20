import assert from "node:assert/strict"
import test from "node:test"
import { route } from "@/api/routes"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { captureWorkflowAccess, inspectWorkflowIntents } from "./workflow-intent-authority"
import { createWorkflowPublishCapabilities } from "./workflow-publish-capabilities"
import { publishRepairFixture } from "./product-instances-test-fixtures"
import { patchListingWorkbench, peekListingWorkbench } from "./workbench/listing-workbench-store"
import { serve } from "./submit/send-test-support"

const intent: ListingIntent = { id: "exact", listing_row_id: "row", row_revision: 1, store_id: "store", state: "unknown",
  client_operation_id: "original-operation", can_resume: false, current_issue_status: "absent",
  submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 10 }

function markUnknown() {
  patchListingWorkbench((state) => ({ rows: state.rows.map((row) => ({ ...row, publishUnconfirmed: true })),
    productDrafts: { row: { ...state.productBases.row!, lifecycle: { ...state.productBases.row!.lifecycle, stage: "outcome_unknown" } } } }))
}

test("production Intent inspection is one bounded latest-per-row read and never fabricates release authority", async () => {
  const fx = await publishRepairFixture()
  markUnknown()
  const cloud = serve(({ url, method }) => {
    assert.equal(method, "GET")
    assert.ok(url.startsWith(`${route("listingIntents")}?`))
    const query = new URL(url, "https://example.test").searchParams
    assert.equal(query.get("latestPerRow"), "true")
    assert.equal(query.get("limit"), "100")
    return { items: [intent] }
  })
  try {
    const capabilities = createWorkflowPublishCapabilities(() => fx.context)
    const result = await capabilities.inspectUnknownRows(["row"])
    assert.deepEqual(result.intents, [intent])
    assert.match(result.message, /claim.*活动 Job.*保持锁定/)
    assert.equal(capabilities.unknownRelease.capture("row"), undefined)
    assert.equal(cloud.calls.some((call) => call.method === "POST"), false)
    assert.equal(cloud.calls.length, 1)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
  } finally { cloud.restore(); fx.restore() }
})

for (const mode of ["empty", "foreign-store", "foreign-row", "stale", "accepted", "ambiguous", "paged", "read-error"] as const) {
  test(`production Intent ${mode} evidence remains fenced`, async () => {
    const fx = await publishRepairFixture()
    markUnknown()
    const cloud = serve(() => {
      if (mode === "read-error") throw new TypeError("read interrupted")
      return { items: mode === "empty" ? [] : mode === "ambiguous" ? [intent, { ...intent, id: "second" }] : [{ ...intent,
        store_id: mode === "foreign-store" ? "other" : intent.store_id,
        listing_row_id: mode === "foreign-row" ? "other" : intent.listing_row_id,
        row_revision: mode === "stale" ? 0 : 1, state: mode === "accepted" ? "accepted" : "unknown" }],
        next_cursor: mode === "paged" ? "next" : null }
    })
    try {
      await assert.rejects(inspectWorkflowIntents(1, ["row"], () => true))
      assert.equal(cloud.calls.length, 1)
      assert.equal(cloud.calls[0]!.method, "GET")
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    } finally { cloud.restore(); fx.restore() }
  })
}

test("permission and account fences use projected evidence and remain revocable", async () => {
  const fx = await publishRepairFixture()
  const cloud = serve(() => { throw new Error("missing permission must not read") })
  try {
    const access = captureWorkflowAccess(1, "store")
    assert.equal(access?.current(), true)
    rememberStoreRoster({ stores: [{ ...fx.store, permissions: { ...fx.store.permissions, manage_store: false } }] }, 1)
    assert.equal(access?.current(), false)
    assert.equal(captureWorkflowAccess(1, "store"), undefined)
    await assert.rejects(inspectWorkflowIntents(1, ["row"], () => true))
    rememberStoreRoster({ stores: [fx.store] }, 1)
    rememberAccountOverview({ ...fx.account, accounts: [{ ...fx.account.accounts[0]!, uuid: "other" }] })
    assert.equal(access?.current(), false)
    assert.equal(cloud.calls.length, 0)
  } finally { cloud.restore(); fx.restore() }
})

for (const mode of ["stop", "version", "accepted"] as const) {
  test(`explicit production inspection ignores ${mode} changes during its read`, async () => {
    const fx = await publishRepairFixture()
    markUnknown()
    const cloud = serve(() => {
      if (mode === "stop") fx.context.controlVersion++
      else patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!, lifecycle: {
        ...state.productBases.row!.lifecycle, view_revision: 2, stage: mode === "accepted" ? "accepted" : "outcome_unknown",
      } } } }))
      return { items: [intent] }
    })
    try {
      await assert.rejects(createWorkflowPublishCapabilities(() => fx.context).inspectUnknownRows(["row"]))
      assert.equal(cloud.calls.length, 1)
      assert.equal(cloud.calls[0]!.method, "GET")
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    } finally { cloud.restore(); fx.restore() }
  })
}

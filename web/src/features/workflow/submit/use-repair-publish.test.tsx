import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { components } from "@/api/schema"
import { toast } from "@/components/ui/toast"
import { product } from "../cloud-fanout-tests/fixtures"
import { createPreparationTracks } from "../prepare/preparation-tracks"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { useRepairPublish, type BrandRepairCapability } from "./use-repair-publish"
import { serve } from "./send-test-support"

const issue: components["schemas"]["ListingIssue"] = {
  code: "OZON_ROW_REJECTED", phase: "submit", allowed_actions: ["edit_row"], input_revision: 1,
  dispatch_evidence: "rejected", row_id: "row", store_id: "store", intent_id: "exact", trace_id: "trace",
  created_at_ms: 1, credential_revision: 1, endpoint: "import", request_hash: "hash", safe_message: "",
  remediation: "删除品牌词", summary: "搜索标签含品牌词", scope: "row", retry_after_fallback: false,
}
function fixture(capability?: BrandRepairCapability, onFlush?: () => void) {
  resetListingWorkbench()
  const view = product("row")
  patchListingWorkbench({ rows: [{ id: "row", draftId: "row", imageName: "row.png", status: "failed",
    ai: "done", render: "done", upload: "done", log: "", readiness: { ready_to_publish: false,
      can_start_publish_attempt: true, blockers: ["publish_conflict"], allowed_actions: ["publish", "edit_fields"] } }],
    productDrafts: { row: { ...view, lifecycle: { ...view.lifecycle, stage: "publish_rejected",
      last_error_code: "BR_hashtag_brand", submission_issue: issue } } } })
  let flushes = 0
  let hook!: ReturnType<typeof useRepairPublish>
  const notices: string[] = []
  const previous = toast.add
  toast.add = ((notice) => { notices.push(String(notice.title)); return "repair" }) as typeof toast.add
  function Capture() {
    hook = useRepairPublish({ busy: false, preparationTracks: { current: createPreparationTracks() },
      flushAutosavesFor: async () => { flushes += 1; onFlush?.(); return true }, capability })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const cloud = serve(() => { throw new Error("repair may not call any retired HTTP endpoint or send") })
  return { hook, notices, cloud, flushes: () => flushes,
    restore() { cloud.restore(); toast.add = previous; resetListingWorkbench() } }
}

test("legacy repair without a native capability is manual with zero retired requests", async () => {
  const fx = fixture()
  try {
    await fx.hook.repairRows(["row"])
    assert.equal(fx.flushes(), 0)
    assert.equal(fx.cloud.calls.length, 0)
    assert.equal(fx.notices.length, 1)
    assert.match(fx.notices[0]!, /搜索标签.*保存.*未接入一键原生修复/)
  } finally { fx.restore() }
})

for (const mode of ["permission", "no-issue", "no-action", "unknown", "accepted", "stale", "foreign-issue"] as const) {
  test(`brand repair ${mode} cannot grant a repair or send`, async () => {
    let repairs = 0
    const fx = fixture({ current: () => mode !== "permission", clearSearchTagsAndRevalidate: async () => { repairs += 1; return { current: () => true, status: { ...product("row"), readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish"] } } } } })
    try {
      patchListingWorkbench((state) => {
        const view = state.productBases.row!
        return { productDrafts: { row: { ...view, lifecycle: { ...view.lifecycle,
          ...(mode === "unknown" || mode === "accepted" ? { stage: mode === "unknown" ? "outcome_unknown" : "accepted" } : {}),
          submission_issue: mode === "no-issue" ? undefined : { ...issue,
            allowed_actions: mode === "no-action" ? [] : ["edit_row"],
            input_revision: mode === "stale" ? 0 : 1, row_id: mode === "foreign-issue" ? "foreign" : "row" },
        } } } }
      })
      await fx.hook.repairRows(["row"])
      assert.equal(repairs, 0)
      assert.equal(fx.flushes(), 0)
      assert.equal(fx.cloud.calls.length, 0)
    } finally { fx.restore() }
  })
}

test("real callback repair flushes once, revalidates and never implicitly sends", async () => {
  const calls: string[] = []
  const fx = fixture({ current: () => true, clearSearchTagsAndRevalidate: async (_row, revision) => {
    assert.equal(revision, 1)
    calls.push("native-edit-save-revalidate")
    const view = product("row")
    return { current: () => true, status: { ...view, readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish"] }, lifecycle: { ...view.lifecycle, revision: 2, view_revision: 2 } } }
  } })
  try {
    await fx.hook.repairRows(["row"])
    assert.equal(fx.flushes(), 1)
    assert.deepEqual(calls, ["native-edit-save-revalidate"])
    assert.equal(fx.cloud.calls.length, 0)
    assert.equal(peekListingWorkbench().productBases.row!.lifecycle.revision, 2)
    assert.match(peekListingWorkbench().rows[0]!.log, /尚未发送/)
  } finally { fx.restore() }
})


test("brand repair rechecks the current local Unknown fence after autosave", async () => {
  let repairs = 0
  const fx = fixture({ current: () => true, clearSearchTagsAndRevalidate: async () => {
    repairs += 1
    throw new Error("a row that became unconfirmed cannot be repaired")
  } }, () => patchListingWorkbench((state) => ({ rows: state.rows.map((row) => ({ ...row, publishUnconfirmed: true })) })))
  try {
    await fx.hook.repairRows(["row"])
    assert.equal(fx.flushes(), 1)
    assert.equal(repairs, 0)
    assert.equal(fx.cloud.calls.length, 0)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    assert.equal(fx.notices.length, 1)
  } finally { fx.restore() }
})

for (const mode of ["permission", "scope", "row-swap", "stop"] as const) {
  test(`saved repair receipt rejects ${mode} before projection`, async () => {
    const fx = fixture({ current: () => true, clearSearchTagsAndRevalidate: async () => {
      const view = product("row")
      if (mode === "scope") resetListingWorkbench()
      if (mode === "row-swap") patchListingWorkbench((state) => ({ rows: state.rows.map((row) => ({ ...row, draftId: "other" })) }))
      if (mode === "stop") patchListingWorkbench({ queuePaused: true })
      return { current: () => mode !== "permission", status: { ...view,
        lifecycle: { ...view.lifecycle, revision: 2, view_revision: 2 },
        readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish"] } } }
    } })
    try {
      await fx.hook.repairRows(["row"])
      assert.notEqual(peekListingWorkbench().productBases.row?.lifecycle.revision, 2)
      assert.equal(fx.cloud.calls.length, 0)
      assert.equal(fx.notices.length, mode === "scope" ? 0 : 1)
    } finally { fx.restore() }
  })
}

test("duplicate native repair clicks share one synchronous flight", async () => {
  let finish!: () => void
  let calls = 0
  const fx = fixture({ current: () => true, clearSearchTagsAndRevalidate: async () => {
    calls++
    await new Promise<void>((resolve) => { finish = resolve })
    const view = product("row")
    return { current: () => true, status: { ...view, lifecycle: { ...view.lifecycle, revision: 2, view_revision: 2 },
      readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish"] } } }
  } })
  try {
    const pending = fx.hook.repairRows(["row"])
    assert.equal(fx.hook.repairPending(), true)
    await fx.hook.repairRows(["row"])
    assert.equal(calls, 1)
    finish()
    await pending
    assert.equal(fx.hook.repairPending(), false)
    assert.equal(fx.notices.length, 1)
    assert.equal(fx.cloud.calls.length, 0)
  } finally { fx.restore() }
})

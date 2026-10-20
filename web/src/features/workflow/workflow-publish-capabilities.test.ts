import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import { toast } from "@/components/ui/toast"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { rowCacheScope, rememberListingRows } from "@/bindings/listing-row-cache"
import { listingProjection } from "../../../tests/listing-row-fixture"
import { createWorkflowPublishCapabilities } from "./workflow-publish-capabilities"
import { createWorkflowPublishNative } from "./workflow-publish-native"
import { publishRepairFixture } from "./product-instances-test-fixtures"
import { rowStatusView } from "./model/row-state"
import { createPreparationTracks } from "./prepare/preparation-tracks"
import { useRepairPublish } from "./submit/use-repair-publish"
import { capturePublishQueue } from "./cloud-fanout-tests/publish-queue-harness"
import { serve, warmProductionSend } from "./submit/send-test-support"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "./workbench/listing-workbench-store"

function mount(capability: Parameters<typeof useRepairPublish>[0]["capability"]) {
  let hook!: ReturnType<typeof useRepairPublish>
  function Capture() {
    hook = useRepairPublish({ busy: false, preparationTracks: { current: createPreparationTracks() }, flushAutosavesFor: async () => true, capability })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  return hook
}

test("production brand repair saves native clearing, tolerates its SSE revision, reads back, then permits explicit send", async () => {
  await warmProductionSend()
  const fx = await publishRepairFixture()
  let saved = fx.raw
  const notices: string[] = [], previous = toast.add
  toast.add = ((notice) => { notices.push(String(notice.title)); return "test" }) as typeof toast.add
  const cloud = serve(({ url, method, body }) => {
    if (url === `${route("listingRows")}/row`) {
      if (method === "PATCH") {
        fx.calls.push("save")
        assert.equal(body.baseRevision, 1)
        assert.equal(body.draft.values.native_search_tags, undefined)
        assert.ok(body.draft.cleared.includes("native_search_tags"))
        const payload = fx.lastEdit()!.row
        saved = { ...fx.raw, revision: 2, view_revision: 2, draft: body.draft, payload,
          projection: listingProjection(), build: { state: "built", sources: [] } }
        // The real stream may project this exact saved revision before PATCH resolves.
        patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!, ...rowStatusView(saved) } } }))
        return saved
      }
      fx.calls.push("readback")
      return saved
    }
    if (url === route("listingCardsById", { id: "card" })) return { ...fx.card, payload: method === "PATCH" ? body.payload : fx.card.payload }
    if (url === route("listingSubmit")) {
      fx.calls.push("explicit-send")
      return { items: [{ rowId: "row", created: true, intent: { id: "new-intent", listingRowId: "row", rowRevision: 2,
        storeId: "store", state: "accepted", externalTaskId: "42", clientOperationId: "new-operation",
        canResume: false, currentIssueStatus: "absent", submissionIssues: [], submissionReceiptStatus: "absent", updatedAtMs: 10 } }] }
    }
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [] }
    throw new Error(`unexpected ${method} ${url}`)
  })
  try {
    const capability = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core)).brandRepair
    assert.equal(capability.current(fx.row, 1), true)
    await mount(capability).repairRows(["row"])
    assert.deepEqual(fx.calls, ["op2", "op7", "schema-drop", "save", "readback", "op7", "schema-drop"])
    assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 0)
    assert.equal(peekListingWorkbench().productBases.row!.lifecycle.revision, 2)
    assert.match(peekListingWorkbench().rows[0]!.log, /尚未发送/)
    assert.equal(notices.length, 1)
    await capturePublishQueue().startPublish(["row"])
    assert.equal(fx.calls.filter((call) => call === "explicit-send").length, 1)
  } finally { cloud.restore(); toast.add = previous; fx.restore() }
})

for (const mode of ["account", "permission", "scope", "row", "revision", "stop", "dirty", "unknown"] as const) {
  test(`production repair rejects ${mode} changes after real native edit with zero writes`, async () => {
    const fx = await publishRepairFixture()
    const cloud = serve(() => { throw new Error("fenced repair cannot write") })
    fx.afterEdit(() => {
      if (mode === "account") rememberAccountOverview({ ...fx.account, accounts: [{ ...fx.account.accounts[0]!, uuid: "other" }] })
      if (mode === "permission") rememberStoreRoster({ stores: [{ ...fx.store, can_manage: false }] }, 1)
      if (mode === "scope") resetListingWorkbench()
      if (mode === "row") patchListingWorkbench({ rows: [{ ...fx.row, draftId: "other" }] })
      if (mode === "revision") rememberListingRows([{ ...fx.raw, revision: 2, view_revision: 2 }], rowCacheScope())
      if (mode === "stop") fx.context.controlVersion++
      if (mode === "dirty") patchListingWorkbench({ rowSaveStates: { row: "dirty" } })
      if (mode === "unknown") patchListingWorkbench({ rows: [{ ...fx.row, publishUnconfirmed: true }] })
    })
    try {
      const capability = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core)).brandRepair
      await assert.rejects(capability.clearSearchTagsAndRevalidate(fx.row, 1), /已变化/)
      assert.deepEqual(fx.calls, ["op2", "schema-drop"])
      assert.equal(cloud.calls.length, 0)
    } finally { cloud.restore(); fx.restore() }
  })
}

for (const mode of ["foreign", "newer", "read-error", "not-ready", "permission", "stop", "row-swap"] as const) {
  test(`saved brand repair ${mode} readback never grants send readiness`, async () => {
    const fx = await publishRepairFixture()
    const cloud = serve(({ method, body }) => {
      const saved = { ...fx.raw, revision: 2, view_revision: 2, draft: body?.draft ?? fx.lastEdit()!.row.draft,
        payload: fx.lastEdit()!.row, projection: listingProjection() }
      if (method === "PATCH") {
        if (mode === "permission") rememberStoreRoster({ stores: [{ ...fx.store, can_manage: false }] }, 1)
        if (mode === "stop") fx.context.controlVersion++
        if (mode === "row-swap") patchListingWorkbench({ rows: [{ ...fx.row, draftId: "other" }] })
        return saved
      }
      if (mode === "read-error") throw new TypeError("read disconnected")
      if (mode === "foreign") return { ...saved, store_id: "foreign" }
      if (mode === "newer") return { ...saved, revision: 3, view_revision: 3 }
      return { ...saved, projection: listingProjection({ stage: "outcome_unknown" }) }
    })
    try {
      const capability = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core)).brandRepair
      await assert.rejects(capability.clearSearchTagsAndRevalidate(fx.row, 1))
      assert.equal(peekListingWorkbench().productBases.row!.lifecycle.revision, 1)
      assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 0)
    } finally { cloud.restore(); fx.restore() }
  })
}

test("repair schema-sync refusal never spends an implicit metadata read or second save", async () => {
  const fx = await publishRepairFixture()
  const cloud = serve(() => new Response(JSON.stringify({ code: "schema_sync_required", error: "schema needs refresh" }),
    { status: 409, headers: { "Content-Type": "application/json" } }))
  try {
    const capability = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core)).brandRepair
    await assert.rejects(capability.clearSearchTagsAndRevalidate(fx.row, 1), /刷新.*未重试保存/)
    assert.equal(cloud.calls.length, 1)
    assert.equal(cloud.calls[0]!.method, "PATCH")
    assert.equal(peekListingWorkbench().productBases.row!.lifecycle.revision, 1)
  } finally { cloud.restore(); fx.restore() }
})

test("malformed resident coordinates hide repair without throwing during render", async () => {
  const fx = await publishRepairFixture()
  const cloud = serve(() => { throw new Error("availability is local") })
  try {
    rememberListingRows([{ ...fx.raw, view_revision: 2, payload: { ...(fx.raw.payload as object), language: "invalid-language" } }], rowCacheScope())
    patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!,
      lifecycle: { ...state.productBases.row!.lifecycle, view_revision: 2 } } } }))
    const capability = createWorkflowPublishCapabilities(() => fx.context).brandRepair
    assert.equal(capability.current(fx.row, 1), false)
    assert.equal(cloud.calls.length, 0)
    assert.deepEqual(fx.calls, [])
  } finally { cloud.restore(); fx.restore() }
})

test("disposed brand capability refuses before native work even when the context returns", async () => {
  const fx = await publishRepairFixture()
  const cloud = serve(() => { throw new Error("disposed capability cannot perform IO") })
  let contextReads = 0
  const owner = createWorkflowPublishCapabilities(() => { contextReads++; return fx.context }, createWorkflowPublishNative(() => fx.core))
  try {
    assert.equal(owner.brandRepair.current(fx.row, 1), true)
    owner.dispose()
    owner.dispose()
    const readsAtDisposal = contextReads
    fx.context.active = false
    assert.equal(owner.brandRepair.current(fx.row, 1), false)
    fx.context.active = true
    fx.context.generation++
    fx.context.controlVersion++
    assert.equal(owner.brandRepair.current(fx.row, 1), false)
    await assert.rejects(owner.brandRepair.clearSearchTagsAndRevalidate(fx.row, 1), /已变化/)
    assert.equal(contextReads, readsAtDisposal)
    assert.deepEqual(fx.calls, [])
    assert.equal(cloud.calls.length, 0)
  } finally { owner.dispose(); cloud.restore(); fx.restore() }
})

for (const returning of ["restored versions", "new scope"] as const) {
  test(`disposed real native edit cannot revive after returning with ${returning}`, async () => {
    const fx = await publishRepairFixture()
    const cloud = serve(() => { throw new Error("disposed edit cannot save or read back") })
    let enteredEdit = () => {}, releaseEdit = () => {}
    const started = new Promise<void>((resolve) => { enteredEdit = resolve })
    const gate = new Promise<void>((resolve) => { releaseEdit = resolve })
    const edit = fx.core.editRow.bind(fx.core)
    fx.core.editRow = async (...args) => {
      const result = await edit(...args)
      enteredEdit()
      await gate
      return result
    }
    const owner = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core))
    const initial = { ...fx.context }, product = peekListingWorkbench().productBases.row!
    const pending = owner.brandRepair.clearSearchTagsAndRevalidate(fx.row, 1)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("repair did not reach or settle its native edit boundary within 3s")), 3000)
    })
    try {
      await Promise.race([started, deadline, pending.then(() => { throw new Error("repair settled before the held native edit") })])
      assert.equal(fx.lastEdit()!.row.draft.values.native_search_tags, undefined)
      assert.ok(fx.lastEdit()!.row.draft.cleared?.includes("native_search_tags"))
      assert.deepEqual(fx.calls, ["op2"])
      assert.equal(cloud.calls.length, 0)
      fx.context.active = false
      fx.context.generation++
      fx.context.controlVersion++
      owner.dispose()
      owner.dispose()
      if (returning === "new scope") {
        resetListingWorkbench()
        patchListingWorkbench({ cardId: "card", rows: [fx.row], productDrafts: { row: product }, queueFrozenIds: ["row"] })
        fx.context.active = true
      } else {
        // Keep every original pin fact valid again: disposal itself must revoke it.
        Object.assign(fx.context, initial)
      }
      assert.equal(owner.brandRepair.current(fx.row, 1), false)
      releaseEdit()
      await assert.rejects(Promise.race([pending, deadline]), /已变化/)
      assert.deepEqual(fx.calls, ["op2", "schema-drop"])
      assert.equal(peekListingWorkbench().productBases.row!.lifecycle.revision, 1)
      await assert.rejects(owner.brandRepair.clearSearchTagsAndRevalidate(fx.row, 1), /已变化/)
      assert.deepEqual(fx.calls, ["op2", "schema-drop"])
      assert.equal(cloud.calls.length, 0)
      const fresh = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core))
      try { assert.equal(fresh.brandRepair.current(fx.row, 1), true) } finally { fresh.dispose() }
    } finally {
      owner.dispose()
      releaseEdit()
      await Promise.allSettled([pending])
      if (timer !== undefined) clearTimeout(timer)
      cloud.restore()
      fx.restore()
    }
  })
}

test("a mounted owner follows fresh context and a new owner repairs after disposal without sending", async () => {
  const fx = await publishRepairFixture()
  let saved = fx.raw
  const cloud = serve(({ url, method, body }) => {
    assert.equal(url, `${route("listingRows")}/row`)
    if (method === "PATCH") {
      fx.calls.push("save")
      assert.equal(body.baseRevision, 1)
      assert.equal(body.draft.values.native_search_tags, undefined)
      assert.ok(body.draft.cleared.includes("native_search_tags"))
      saved = { ...fx.raw, revision: 2, view_revision: 2, draft: body.draft, payload: fx.lastEdit()!.row, projection: listingProjection() }
      patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!, ...rowStatusView(saved) } } }))
      return saved
    }
    assert.equal(method, "GET")
    fx.calls.push("readback")
    return saved
  })
  const owner = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core))
  let fresh: ReturnType<typeof createWorkflowPublishCapabilities> | undefined
  try {
    assert.equal(owner.brandRepair.current(fx.row, 1), true)
    fx.context.active = false
    assert.equal(owner.brandRepair.current(fx.row, 1), false)
    fx.context.active = true
    fx.context.generation++
    fx.context.controlVersion++
    assert.equal(owner.brandRepair.current(fx.row, 1), true)
    owner.dispose()
    owner.dispose()
    fx.context.generation++
    assert.equal(owner.brandRepair.current(fx.row, 1), false)
    await assert.rejects(owner.brandRepair.clearSearchTagsAndRevalidate(fx.row, 1), /已变化/)
    assert.equal(cloud.calls.length, 0)
    assert.deepEqual(fx.calls, [])
    fresh = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core))
    assert.equal(fresh.brandRepair.current(fx.row, 1), true)
    const result = await fresh.brandRepair.clearSearchTagsAndRevalidate(fx.row, 1)
    assert.equal(result.status.lifecycle.revision, 2)
    assert.equal(result.status.lifecycle.fields, "valid")
    assert.equal(result.status.readiness.can_start_publish_attempt, true)
    assert.equal(result.current(), true)
    assert.deepEqual(fx.calls, ["op2", "op7", "schema-drop", "save", "readback", "op7", "schema-drop"])
    assert.deepEqual(cloud.calls.map((call) => call.method), ["PATCH", "GET"])
    fresh.dispose()
    fresh.dispose()
    assert.equal(result.current(), false)
    assert.equal(owner.brandRepair.current(fx.row, 1), false)
    assert.equal(cloud.calls.length, 2)
  } finally { fresh?.dispose(); owner.dispose(); cloud.restore(); fx.restore() }
})

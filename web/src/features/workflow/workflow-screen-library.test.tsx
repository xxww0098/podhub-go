/** Real screen hooks and Card/provider ports. SSR captures explicit callbacks;
 * mounted DOM interaction remains the coordinator's browser gate. */
import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import { cardDraftView, cardSummaryView } from "@/bindings/http-listing"
import { cardPayload, type ListingCardView } from "@/bindings/listing-projection"
import { renderOpfs } from "@/bindings/render-opfs"
import { refuse } from "@/bindings/refusal"
import { rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { toast } from "@/components/ui/toast"
import { clearLive } from "@/lib/notify"
import { invalidateAllSessionCaches } from "@/lib/session-cache"
import { listingProjection } from "../../../tests/listing-row-fixture"
import { closeCardSession, peekCardSession, primeCardSession } from "./card/card-session"
import { publishRepairFixture } from "./product-instances-test-fixtures"
import { serve } from "./submit/send-test-support"
import { useUnknownRelease } from "./submit/use-unknown-release"
import type { usePublishQueue } from "./submit/use-publish-queue"
import { createWorkflowPublishCapabilities } from "./workflow-publish-capabilities"
import { createWorkflowPublishNative } from "./workflow-publish-native"
import { useWorkflowScreenLibrary } from "./workflow-screen-library"
import { TEMPLATE_NOTICE_ID, useWorkflowScreenState, type WorkflowScreenState } from "./workflow-screen-state"
import { rowStatusView } from "./model/row-state"
import { setErrorTelemetryContext } from "@/lib/error-telemetry"
import { patchListingWorkbench, peekListingWorkbench } from "./workbench/listing-workbench-store"

/** A mock GET carries JSON bytes, not JS-only undefined properties. */
function wireCard(card: ListingCardView): ListingCardView {
  return JSON.parse(JSON.stringify(card))
}

async function fixture() {
  const fx = await publishRepairFixture()
  const card = wireCard({ ...fx.card, payload: { ...cardPayload(fx.card),
    psdTemplateSha256: "template-fixture", psdTemplateFileName: "fixture.psd" } })
  primeCardSession(card)
  fx.raw.projection = listingProjection({ stage: "outcome_unknown", readiness: {
    ready_to_publish: false, can_start_publish_attempt: false, blockers: ["outcome_unknown"], allowed_actions: [],
  } })
  const base = peekListingWorkbench().productBases.row!
  const schema = { description_category_id: fx.schema.description_category_id, type_id: fx.schema.type_id,
    language: "default" as const, fields: [], complex_groups: [] }
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window")
  let address = new URL("https://example.test/workflow")
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    get location() { return address },
    history: { replaceState(_data: unknown, _unused: string, url: string) { address = new URL(url, address) } },
  } })
  const templateBefore = renderOpfs.workflowRestoreTemplatePsd, toastBefore = toast.add
  let templates = 0
  renderOpfs.workflowRestoreTemplatePsd = async () => {
    templates++
    throw refuse("workflow_template_unavailable", "切片模板的本地文件不可用", "请重新导入该 PSD 模板后重试")
  }
  const notices: string[] = [], descriptions: string[] = []
  toast.add = ((notice) => {
    notices.push(String(notice.title))
    descriptions.push(renderToStaticMarkup(createElement("div", null, notice.description)))
    return "library-test"
  }) as typeof toast.add
  let state!: WorkflowScreenState, library!: ReturnType<typeof useWorkflowScreenLibrary>
  const modes: string[] = [], restored: string[] = []
  const queues: Parameters<ReturnType<typeof usePublishQueue>["projectQueueState"]>[0][] = []
  function Capture() {
    state = useWorkflowScreenState(undefined, 1, true)
    library = useWorkflowScreenLibrary({ state: { ...state, setMode(next) {
      if (typeof next === "string") modes.push(next)
      state.setMode(next)
    } }, workspaceId: 1, skipNextAutosave: { current: false }, setCustomStoreQuotas: () => {},
      resetRowAutosaves: () => {}, leaveRunner: async () => {},
      projectQueueState(queue) {
        queues.push(queue)
        patchListingWorkbench({ queuePaused: queue.paused, queueRunning: queue.running, queueFrozenIds: queue.frozen_row_ids,
          queueHaltReason: queue.halt_reason ?? null })
      },
      restoreProductInstances(card, generation) {
        restored.push(card.draft_id)
        fx.context.cardId = card.draft_id
        fx.context.generation = generation
        rememberListingRows([fx.raw], rowCacheScope())
        patchListingWorkbench({ rows: [{ ...fx.row, status: "exception", stage: "outcome_unknown", publishUnconfirmed: true }],
          productDrafts: { row: { ...base, ...rowStatusView(fx.raw) } } })
      },
    })
    return null
  }
  function restore() {
    clearLive(TEMPLATE_NOTICE_ID)
    // Drop the seeded session so no fire-and-forget error-feedback receipt
    // flushes into a later file.
    setErrorTelemetryContext({ sessionKey: null })
    renderOpfs.workflowRestoreTemplatePsd = templateBefore
    toast.add = toastBefore
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore)
    else Reflect.deleteProperty(globalThis, "window")
    fx.restore()
  }
  try { renderToStaticMarkup(<Capture />) }
  catch (reason) { restore(); throw reason }
  return { ...fx, card, nativeSchema: fx.schema, schema, library, state, queues, modes, restored, notices, descriptions, templates: () => templates, restore }
}

test("normal screen entry primes the exact Cloud Card and reuses it for queue and release inspection without Card hydration", async () => {
  const fx = await fixture()
  closeCardSession("card")
  const raw = wireCard({ ...fx.card, revision: 7, payload: { ...cardPayload(fx.card), queue: {
    paused: false, stopAfterCurrent: false, nextPosition: 3, frozenRowIds: ["row"],
  } } })
  const intent = { id: "exact", listing_row_id: "row", store_id: "store", row_revision: 1, client_operation_id: "original-operation",
    state: "unknown", can_resume: false, current_issue_status: "absent", submission_issues: [], submission_receipt_status: "absent",
    updated_at_ms: 10, has_live_reconcile_claim: false, has_unfinished_dispatch_job: false }
  const cloud = serve(({ url, method }) => {
    assert.equal(method, "GET")
    if (url === route("listingCardsById", { id: "card" })) return raw
    if (url.startsWith(`${route("catalogSchema")}?`)) return { ...fx.schema,
      nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } }
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [fx.raw], next_cursor: null }
    if (url.startsWith(`${route("listingIntents")}?`)) return { items: [intent], next_cursor: null }
    throw new Error(`unexpected screen entry request ${url}`)
  })
  const capabilities = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core), peekCardSession)
  let hook!: ReturnType<typeof useUnknownRelease>
  function Capture() { hook = useUnknownRelease(false, capabilities.unknownRelease, capabilities.inspectUnknownRows); return null }
  renderToStaticMarkup(<Capture />)
  try {
    await fx.library.openRunner(cardSummaryView(raw))
    assert.deepEqual(fx.restored, ["card"])
    assert.deepEqual(fx.modes, ["runner"])
    const session = peekCardSession("card")!
    assert.ok(session)
    assert.deepEqual(session.card(), raw)
    assert.equal(session.revision(), 7)
    assert.equal(cloud.calls.filter((call) => call.url === route("listingCardsById", { id: "card" })).length, 1)
    assert.equal(cloud.calls.filter((call) => call.url.startsWith(`${route("listingRows")}?`)).length, 1)
    assert.equal(cloud.calls.filter((call) => call.url.startsWith(`${route("catalogSchema")}?`)).length, 1)
    assert.deepEqual(fx.queues[0]?.frozen_row_ids, ["row"])
    assert.equal(fx.queues[0]?.next_position, 3)
    assert.equal(fx.templates(), 1)
    assert.equal(fx.notices[0], "切片模板的本地文件不可用 请重新导入该 PSD 模板后重试")
    assert.match(fx.descriptions[0]!, /请重试检查.*新切片暂不可用.*已完成媒体的商品仍可发送/)
    const callsBeforeInspect = cloud.calls.length
    assert.equal(hook.canReleaseUnknownRows(["row"]), false)
    await hook.inspectUnknownRows(["row"])
    assert.equal(hook.canReleaseUnknownRows(["row"]), true)
    assert.equal(cloud.calls.length, callsBeforeInspect + 1)
    assert.ok(cloud.calls.at(-1)!.url.startsWith(`${route("listingIntents")}?`))
    assert.deepEqual(fx.calls, [])
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    assert.equal(peekCardSession("card"), session)
  } finally { capabilities.dispose(); cloud.restore(); fx.restore() }
})

for (const resident of [false, true]) test(`projected screen entry uses original raw authority, never a manufactured Card (resident=${resident})`, async () => {
  const fx = await fixture()
  const raw = { ...fx.card, revision: 9 }
  const projected = cardDraftView(fx.card, fx.schema)
  if (resident) primeCardSession(raw)
  else closeCardSession("card")
  const cloud = serve(({ url, method }) => {
    assert.equal(method, "GET")
    assert.equal(url, route("listingCardsById", { id: "card" }))
    return raw
  })
  try {
    await fx.library.openRunner(projected)
    assert.equal(peekCardSession("card")?.revision(), 9)
    assert.deepEqual(peekCardSession("card")?.card(), raw)
    assert.equal(cloud.calls.length, resident ? 0 : 1)
    assert.deepEqual(fx.restored, ["card"])
    assert.equal(fx.templates(), 1)
  } finally { cloud.restore(); fx.restore() }
})

test("a superseded normal entry cannot prime a late raw Card or replace another session", async () => {
  const fx = await fixture()
  closeCardSession("card")
  let finish!: (value: unknown) => void, seen!: () => void
  const pendingRead = new Promise<void>((resolve) => { seen = resolve })
  const cloud = serve(() => { seen(); return new Promise((resolve) => { finish = resolve }) })
  let opening: ReturnType<typeof fx.library.openRunner> | undefined
  try {
    opening = fx.library.openRunner("card")
    await pendingRead
    fx.state.runnerGeneration.current++
    const replacement = primeCardSession({ ...fx.card, revision: 10 })
    finish(fx.card)
    await opening
    assert.equal(peekCardSession("card"), replacement)
    assert.deepEqual(fx.restored, [])
    assert.deepEqual(fx.modes, [])
    assert.equal(fx.templates(), 0)
    assert.equal(cloud.calls.length, 1)
  } finally {
    fx.state.runnerGeneration.current++
    finish?.(fx.card)
    try { await opening }
    finally { cloud.restore(); fx.restore() }
  }
})

test("invalid projected kinds and foreign Cloud Card identities retain normal entry refusal and never prime authority", async () => {
  const fx = await fixture()
  closeCardSession("card")
  const cloud = serve(() => ({ ...fx.card, id: "foreign-card" }))
  try {
    await fx.library.openRunner({ ...cardDraftView(fx.card, fx.schema), kind: "instance" })
    assert.equal(cloud.calls.length, 0)
    await fx.library.openRunner("card")
    assert.equal(cloud.calls.length, 1)
    assert.equal(peekCardSession("card"), undefined)
    assert.equal(peekCardSession("foreign-card"), undefined)
    assert.deepEqual(fx.restored, [])
    assert.equal(peekListingWorkbench().queuePaused, true)
    assert.equal(fx.notices.length, 2)
  } finally { cloud.restore(); fx.restore() }
})

test("supplier template recovery uses the primed Card and preserves verify-once without another Card GET", async () => {
  const fx = await fixture()
  closeCardSession("card")
  const raw = { ...fx.card, payload: { ...cardPayload(fx.card), supplierProductId: "supplier-fixture",
    psdTemplateAssetId: "", psdTemplateSha256: "" } }
  const cloud = serve(({ url, method }) => {
    if (url === route("listingCardsById", { id: "card" })) { assert.equal(method, "GET"); return raw }
    if (url.startsWith(`${route("catalogSchema")}?`)) return { ...fx.schema,
      nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } }
    assert.equal(url, route("mediaSupplierProductsByProductIdVerify", { product_id: "supplier-fixture" }))
    assert.equal(method, "POST")
    return { product_id: "supplier-fixture", psd_sha256: "template-fixture", psd_file_name: "supplier.psd", video_count: 0 }
  })
  try {
    await fx.library.openRunner("card")
    await peekCardSession("card")!.verifySupplierOnce()
    assert.equal(cloud.calls.filter((call) => call.url === route("listingCardsById", { id: "card" })).length, 1)
    assert.equal(cloud.calls.filter((call) => call.url.startsWith(`${route("catalogSchema")}?`)).length, 1)
    assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 1)
    assert.equal(fx.templates(), 1)
    assert.deepEqual(fx.modes, ["runner"])
  } finally { cloud.restore(); fx.restore() }
})

test("normal schema failure retains entry refusal without priming or attempting queue/template work", async () => {
  const fx = await fixture()
  closeCardSession("card")
  const cloud = serve(({ url }) => url === route("listingCardsById", { id: "card" }) ? fx.card
    : new Response(JSON.stringify({ code: "validation",
      error: "方案类目元数据已失效；请重新选择该类目并保存方案后再进入上架" }),
    { status: 400, headers: { "Content-Type": "application/json" } }))
  try {
    await fx.library.openRunner("card")
    assert.equal(cloud.calls.length, 2)
    assert.equal(peekCardSession("card"), undefined)
    assert.equal(fx.templates(), 0)
    assert.deepEqual(fx.queues, [])
    assert.deepEqual(fx.restored, [])
    assert.equal(peekListingWorkbench().queuePaused, true)
    assert.deepEqual(fx.notices, ["方案类目元数据已失效；请重新选择该类目并保存方案后再进入上架"])
  } finally { cloud.restore(); fx.restore() }
})

test("a normal entry without a PSD binding retains manual template guidance and performs no template restore", async () => {
  const fx = await fixture()
  closeCardSession("card")
  const raw = wireCard({ ...fx.card, payload: { ...cardPayload(fx.card),
    psdTemplateAssetId: "", psdTemplateSha256: "", supplierProductId: undefined } })
  const cloud = serve(({ url, method }) => {
    assert.equal(method, "GET")
    if (url === route("listingCardsById", { id: "card" })) return raw
    assert.ok(url.startsWith(`${route("catalogSchema")}?`))
    return { ...fx.schema, nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } }
  })
  try {
    await fx.library.openRunner("card")
    assert.deepEqual(peekCardSession("card")?.card(), raw)
    assert.equal(cloud.calls.length, 2)
    assert.equal(fx.templates(), 0)
    assert.deepEqual(fx.modes, ["runner"])
    assert.deepEqual(fx.restored, ["card"])
    assert.deepEqual(fx.notices, ["上架方案没有可用的 PSD 模板"])
    assert.match(fx.descriptions[0]!, /返回上架方案重新绑定 PSD.*AI 识别仍可用.*新切片暂不可用.*已完成媒体的商品仍可发送/)
    assert.deepEqual(fx.calls, [])
  } finally { cloud.restore(); fx.restore() }
})

for (const phase of ["card", "schema"] as const) {
  test(`an account switch during normal ${phase} loading cannot prime old Card authority or restore rows`, async () => {
    const fx = await fixture()
    closeCardSession("card")
    let finish!: (value: unknown) => void, seen!: () => void
    const requested = new Promise<void>((resolve) => { seen = resolve })
    const cloud = serve(({ url }) => {
      if (phase === "schema" && url === route("listingCardsById", { id: "card" })) return fx.card
      seen()
      return new Promise((resolve) => { finish = resolve })
    })
    let opening: ReturnType<typeof fx.library.openRunner> | undefined
    try {
      opening = fx.library.openRunner("card")
      await requested
      invalidateAllSessionCaches()
      finish(phase === "card" ? fx.card : { ...fx.schema, nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } })
      await opening
      assert.equal(peekCardSession("card"), undefined)
      assert.deepEqual(fx.restored, [])
      assert.deepEqual(fx.queues, [])
      assert.deepEqual(fx.modes, [])
      assert.equal(fx.templates(), 0)
      assert.equal(fx.notices.length, 0, "old entry does not notify the new account")
      assert.equal(cloud.calls.length, phase === "card" ? 1 : 2)
      assert.equal(fx.state.runnerOpenLock.current, false)
    } finally {
      fx.state.runnerGeneration.current++
      finish?.(phase === "card" ? fx.card : { ...fx.schema, nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } })
      try { await opening }
      finally { cloud.restore(); fx.restore() }
    }
  })
}

test("normal entry cannot overwrite a replacement Card session that arrived while category material was loading", async () => {
  const fx = await fixture()
  closeCardSession("card")
  let finish!: (value: unknown) => void, seen!: () => void
  const requested = new Promise<void>((resolve) => { seen = resolve })
  const cloud = serve(({ url }) => {
    if (url === route("listingCardsById", { id: "card" })) return fx.card
    assert.ok(url.startsWith(`${route("catalogSchema")}?`))
    seen()
    return new Promise((resolve) => { finish = resolve })
  })
  let opening: ReturnType<typeof fx.library.openRunner> | undefined
  try {
    opening = fx.library.openRunner("card")
    await requested
    const replacement = primeCardSession({ ...fx.card, revision: 12 })
    finish({ ...fx.schema, nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } })
    await opening
    assert.equal(peekCardSession("card"), replacement)
    assert.equal(peekCardSession("card")?.revision(), 12)
    assert.equal(cloud.calls.length, 2)
    assert.deepEqual(fx.restored, [])
    assert.deepEqual(fx.queues, [])
    assert.equal(fx.templates(), 0)
    assert.match(fx.notices[0]!, /载入期间方案已在本页更新/)
    assert.equal(fx.state.runnerOpenLock.current, false)
  } finally {
    fx.state.runnerGeneration.current++
    finish?.({ ...fx.schema, nativeMaterial: { snapshot: fx.nativeSchema, searchMaterials: [] } })
    try { await opening }
    finally { cloud.restore(); fx.restore() }
  }
})

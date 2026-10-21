import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { cachedListingRow, rememberListingRows, rowCacheScope } from "@/bindings/listing-row-cache"
import { toast } from "@/components/ui/toast"
import { rememberAccountOverview } from "@/features/account/account-overview-cache"
import { rememberStoreRoster } from "@/features/stores/store-roster-cache"
import { listingProjection } from "../../../tests/listing-row-fixture"
import { publishRepairFixture } from "./product-instances-test-fixtures"
import { createWorkflowPublishCapabilities } from "./workflow-publish-capabilities"
import { createWorkflowPublishNative } from "./workflow-publish-native"
import { useUnknownRelease } from "./submit/use-unknown-release"
import { serve, warmProductionSend } from "./submit/send-test-support"
import { capturePublishQueue } from "./cloud-fanout-tests/publish-queue-harness"
import { rowStatusView } from "./model/row-state"
import { nativeRow } from "./submit/send-local"
import { closeCardSession, openCardSession, peekCardSession, primeCardSession } from "./card/card-session"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "./workbench/listing-workbench-store"
import { setErrorTelemetryContext } from "@/lib/error-telemetry"

const original: ListingIntent = { id: "exact", listing_row_id: "row", store_id: "store", row_revision: 1,
  client_operation_id: "original-operation", state: "unknown", can_resume: false, current_issue_status: "absent",
  submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 10,
  has_live_reconcile_claim: false, has_unfinished_dispatch_job: false }
const released: ListingIntent = { ...original, state: "superseded", updated_at_ms: 11 }
// Mutation receipts do not carry GET-only claim / job authority.
const receipt = { ...released }
delete receipt.has_live_reconcile_claim
delete receipt.has_unfinished_dispatch_job

async function fixture(invalidNativeName = false) {
  const pendingRemovals = new Set(peekListingWorkbench().pendingRemovalIds)
  const fx = await publishRepairFixture()
  if (invalidNativeName) {
    try {
      const parsed = nativeRow(fx.raw)
      assert.ok("row" in parsed)
      const payload = structuredClone(parsed.row)
      delete payload.draft.values.name
      payload.draft.cleared = [...(payload.draft.cleared ?? []), "name"]
      fx.raw.payload = payload
      fx.raw.draft = payload.draft
    } catch (reason) { fx.restore(); throw reason }
  }
  patchListingWorkbench((state) => ({ rows: state.rows.map((row) => ({ ...row, status: "exception", stage: "outcome_unknown", publishUnconfirmed: true })),
    productDrafts: { row: { ...state.productBases.row!, lifecycle: { ...state.productBases.row!.lifecycle, stage: "outcome_unknown" } } } }))
  const fresh = { ...fx.raw, view_revision: 2, submission_state: "none", projection: listingProjection(), updated_at_ms: 11 }
  primeCardSession(fx.card)
  const capabilities = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core),
    peekCardSession)
  let hook!: ReturnType<typeof useUnknownRelease>
  function Capture() { hook = useUnknownRelease(false, capabilities.unknownRelease, capabilities.inspectUnknownRows); return null }
  try { renderToStaticMarkup(createElement(Capture)) }
  catch (reason) { capabilities.dispose(); fx.restore(); throw reason }
  const previous = toast.add, notices: string[] = []
  toast.add = ((notice) => { notices.push(String(notice.title)); return "release-test" }) as typeof toast.add
  return { ...fx, fresh, capabilities, hook, notices,
    loseResident() { closeCardSession(fx.card.id) },
    replaceCard() { primeCardSession({ ...fx.card, revision: 2 }) },
    restore() {
      capabilities.dispose()
      toast.add = previous
      // The fixture seeds a session, which arms the fire-and-forget error-feedback
      // receipts; drop the session so no late flush escapes into a later file.
      setErrorTelemetryContext({ sessionKey: null })
      // resetListingWorkbench deliberately retains real in-flight deletions.
      // This fixture must undo its simulated deletion, including on assertion failure.
      patchListingWorkbench({ pendingRemovalIds: pendingRemovals })
      fx.restore()
    } }
}

test("production exact release requires explicit inspection, POST receipt, fresh readback, Cloud readiness and compiled op7 before a separate send", async () => {
  await warmProductionSend()
  const fx = await fixture()
  let reads = 0
  const order: string[] = []
  const cloud = serve(({ url, method, body }) => {
    if (url.startsWith(`${route("listingIntents")}?`)) {
      const query = new URL(url, "https://example.test").searchParams
      assert.equal(query.get("latestPerRow"), "true")
      assert.equal(query.get("limit"), "100")
      order.push(++reads === 1 ? "inspect" : "readback")
      return { items: [reads === 1 ? original : released], next_cursor: null }
    }
    if (url === route("listingIntentsReleaseUnknown")) {
      assert.deepEqual(body.intentIds, ["exact"])
      order.push("release")
      // A release's own exact +1 view can arrive on SSE before its POST.
      rememberListingRows([fx.fresh], rowCacheScope())
      patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!, ...rowStatusView(fx.fresh) } } }))
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
      return { released_intent_ids: ["exact"], intents: [receipt] }
    }
    if (url === `${route("listingRows")}/row`) { order.push("fresh-row"); return fx.fresh }
    if (url === route("listingCardsById", { id: "card" })) return { ...fx.card, payload: method === "PATCH" ? body.payload : fx.card.payload }
    if (url === route("listingSubmit")) {
      order.push("explicit-send")
      assert.deepEqual(body.store_id, "store")
      assert.deepEqual(body.row_ids, ["row"])
      return { items: [{ row_id: "row", created: true, intent: { ...original, id: "new-intent", state: "accepted",
        client_operation_id: "new-operation", external_task_id: "42" } }] }
    }
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [] }
    throw new Error(`unexpected ${method} ${url}`)
  })
  try {
    assert.equal(fx.hook.canReleaseUnknownRows(["row"]), false)
    assert.equal(cloud.calls.length, 0)
    await fx.hook.inspectUnknownRows(["row"])
    assert.deepEqual(order, ["inspect"])
    assert.equal(fx.hook.canReleaseUnknownRows(["row"]), true)
    assert.deepEqual(fx.calls, [])
    await fx.hook.releaseUnknownRows(["row"])
    assert.deepEqual(order, ["inspect", "release", "readback", "fresh-row"])
    assert.deepEqual(fx.calls, ["op7", "schema-drop"])
    assert.equal(cachedListingRow("row"), fx.fresh, "equal-version GET does not replace the original SSE object")
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, false)
    assert.equal(peekListingWorkbench().productBases.row!.lifecycle.stage, "ready_to_publish")
    assert.equal(peekListingWorkbench().productBases.row!.lifecycle.revision, 1)
    assert.deepEqual(peekListingWorkbench().queueFrozenIds, ["row"])
    assert.match(peekListingWorkbench().rows[0]!.log, /尚未发送/)
    assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 1)
    assert.equal(fx.notices.length, 2)
    await capturePublishQueue().startPublish(["row"])
    assert.equal(order.filter((item) => item === "explicit-send").length, 1)
  } finally { cloud.restore(); fx.restore() }
})

for (const mode of ["missing", "missing-job", "missing-claim", "null", "claimed", "active-job", "foreign", "paged", "stale", "operation-missing"] as const) {
  test(`production ${mode} inspection cannot supply a release candidate or unlock`, async () => {
    const fx = await fixture()
    const facts = { ...original }
    if (mode === "missing" || mode === "missing-claim") delete facts.has_live_reconcile_claim
    if (mode === "missing" || mode === "missing-job") delete facts.has_unfinished_dispatch_job
    if (mode === "null") facts.has_live_reconcile_claim = null
    if (mode === "claimed") facts.has_live_reconcile_claim = true
    if (mode === "active-job") facts.has_unfinished_dispatch_job = true
    if (mode === "foreign") facts.store_id = "other"
    if (mode === "stale") facts.row_revision = 0
    if (mode === "operation-missing") facts.client_operation_id = ""
    const cloud = serve(() => ({ items: [facts], next_cursor: mode === "paged" ? "next" : null }))
    try {
      await fx.hook.inspectUnknownRows(["row"])
      assert.equal(fx.capabilities.unknownRelease.capture("row"), undefined)
      assert.equal(fx.hook.canReleaseUnknownRows(["row"]), false)
      await fx.hook.releaseUnknownRows(["row"])
      assert.equal(cloud.calls.length, 1)
      assert.equal(cloud.calls[0]!.method, "GET")
      assert.deepEqual(fx.calls, [])
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    } finally { cloud.restore(); fx.restore() }
  })
}

for (const mode of ["permission", "account", "route", "stop", "revision", "view", "dirty", "saving", "row", "media", "queue", "removal", "resident-missing", "card-revision"] as const) {
  test(`production inspected authority revokes on ${mode} before release with zero mutation`, async () => {
    const fx = await fixture()
    const cloud = serve(() => ({ items: [original] }))
    try {
      await fx.hook.inspectUnknownRows(["row"])
      assert.equal(fx.hook.canReleaseUnknownRows(["row"]), true)
      if (mode === "permission") rememberStoreRoster({ stores: [{ ...fx.store, can_manage: false }] }, 1)
      if (mode === "account") rememberAccountOverview({ ...fx.account, accounts: [{ ...fx.account.accounts[0]!, uuid: "other" }] })
      if (mode === "route") fx.context.active = false
      if (mode === "stop") fx.context.controlVersion++
      if (mode === "revision" || mode === "view") patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!,
        lifecycle: { ...state.productBases.row!.lifecycle, revision: mode === "revision" ? 2 : 1, view_revision: 2 } } } }))
      if (mode === "dirty" || mode === "saving") {
        patchListingWorkbench({ rowSaveStates: { row: mode } })
        patchListingWorkbench({ rowSaveStates: { row: "saved" } }) // A transient race cannot re-grant old consent.
      }
      if (mode === "row") patchListingWorkbench({ rows: [{ ...fx.row, draftId: "foreign", publishUnconfirmed: true }] })
      if (mode === "media") patchListingWorkbench({ mediaEpoch: 1 })
      if (mode === "queue") patchListingWorkbench({ queueRunning: true })
      if (mode === "removal") patchListingWorkbench({ pendingRemovalIds: new Set(["row"]) })
      if (mode === "resident-missing") fx.loseResident()
      if (mode === "card-revision") fx.replaceCard()
      assert.equal(fx.hook.canReleaseUnknownRows(["row"]), false)
      await fx.hook.releaseUnknownRows(["row"])
      assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 0)
      assert.deepEqual(fx.calls, [])
    } finally { cloud.restore(); fx.restore() }
  })
}

for (const mode of ["omitted-id", "missing-receipt", "foreign-receipt", "read-error", "read-missing-facts", "new-operation", "later-actor", "claim", "job", "row-not-ready", "row-foreign", "row-newer", "native-stop", "payload-changed", "row-conflicting-sse", "native-newer-sse"] as const) {
  test(`production release ${mode} evidence cannot unlock or autosend`, async () => {
    const fx = await fixture()
    let reads = 0
    const revalidate = fx.core.revalidate.bind(fx.core)
    fx.core.revalidate = async (...args) => {
      const result = await revalidate(...args)
      if (mode === "native-stop") fx.context.controlVersion++
      if (mode === "native-newer-sse") {
        const accepted = { ...fx.fresh, view_revision: 3, projection: listingProjection({ stage: "accepted" }) }
        rememberListingRows([accepted], rowCacheScope())
        patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!, ...rowStatusView(accepted) } } }))
      }
      return result
    }
    const cloud = serve(({ url }) => {
      if (url.startsWith(`${route("listingIntents")}?`)) {
        if (++reads === 1) return { items: [original] }
        if (mode === "read-error") throw new TypeError("explicit read failed")
        const after = { ...released }
        if (mode === "read-missing-facts") delete after.has_unfinished_dispatch_job
        if (mode === "new-operation") after.client_operation_id = "later-operation"
        if (mode === "later-actor") after.updated_at_ms = 12
        if (mode === "claim") after.has_live_reconcile_claim = true
        if (mode === "job") after.has_unfinished_dispatch_job = true
        return { items: [after] }
      }
      if (url === route("listingIntentsReleaseUnknown")) {
        if (mode === "row-conflicting-sse") {
          // Same content / view revision, but contradictory authority. The fresh
          // ready GET must not silently override this resident Unknown evidence.
          rememberListingRows([{ ...fx.fresh, submission_state: "unknown", projection: listingProjection({ stage: "outcome_unknown" }) }], rowCacheScope())
        }
        return {
          released_intent_ids: mode === "omitted-id" ? [] : ["exact"],
          intents: mode === "missing-receipt" ? [] : [{ ...receipt, store_id: mode === "foreign-receipt" ? "foreign" : "store" }],
        }
      }
      if (url === `${route("listingRows")}/row`) {
        const fresh = { ...fx.fresh, store_id: mode === "row-foreign" ? "foreign" : "store",
          view_revision: mode === "row-newer" ? 3 : 2,
          projection: mode === "row-not-ready" ? listingProjection({ stage: "outcome_unknown" }) : fx.fresh.projection }
        if (mode === "payload-changed") {
          fresh.payload = { draft: { values: {}, complex_values: [] } }
          fresh.draft = { values: {}, complex_values: [] }
        }
        return fresh
      }
      throw new Error(`unexpected ${url}`)
    })
    try {
      await fx.hook.inspectUnknownRows(["row"])
      await fx.hook.releaseUnknownRows(["row"])
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
      assert.equal(cloud.calls.filter((call) => call.url.includes("/submit")).length, 0)
      assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 1)
      assert.equal(fx.notices.length, 2, "one inspection notice and one release result")
      if (mode === "native-stop" || mode === "native-newer-sse") assert.deepEqual(fx.calls, ["op7", "schema-drop"])
      else assert.deepEqual(fx.calls, [])
      if (mode === "native-newer-sse") assert.equal(peekListingWorkbench().productBases.row!.lifecycle.stage, "accepted")
    } finally { cloud.restore(); fx.restore() }
  })
}

test("a release cannot reuse pins after disposal or silently unlock on a ready SSE alone", async () => {
  const fx = await fixture()
  const cloud = serve(() => ({ items: [original] }))
  try {
    await fx.hook.inspectUnknownRows(["row"])
    rememberListingRows([fx.fresh], rowCacheScope())
    patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!, ...rowStatusView(fx.fresh) } } }))
    assert.equal(fx.hook.canReleaseUnknownRows(["row"]), false)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    fx.capabilities.dispose()
    assert.equal(fx.capabilities.unknownRelease.capture("row"), undefined)
    await fx.hook.releaseUnknownRows(["row"])
    assert.equal(cloud.calls.length, 1)
  } finally { cloud.restore(); fx.restore() }
})

test("missing resident-only Card capability keeps production inspection manual with exactly one Intent GET", async () => {
  const fx = await fixture()
  const capabilities = createWorkflowPublishCapabilities(() => fx.context, createWorkflowPublishNative(() => fx.core))
  const cloud = serve(({ url, method }) => {
    assert.equal(method, "GET")
    assert.ok(url.startsWith(`${route("listingIntents")}?`))
    return { items: [original] }
  })
  try {
    const inspection = await capabilities.inspectUnknownRows(["row"])
    assert.match(inspection.message, /驻留 Card.*保持锁定/)
    assert.equal(capabilities.unknownRelease.capture("row"), undefined)
    assert.deepEqual(fx.calls, [])
    assert.equal(cloud.calls.length, 1)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
  } finally { capabilities.dispose(); cloud.restore(); fx.restore() }
})

for (const mode of ["missing", "pending"] as const) {
  test(`the real ${mode} resident accessor keeps release manual until normal load and a new explicit inspection`, async () => {
    const fx = await fixture()
    fx.loseResident()
    let finish: ((value: unknown) => void) | undefined, seen!: () => void
    const requested = new Promise<void>((resolve) => { seen = resolve })
    const cloud = serve(({ url, method }) => {
      assert.equal(method, "GET")
      if (url === route("listingCardsById", { id: "card" })) {
        seen()
        return new Promise((resolve) => { finish = resolve })
      }
      assert.ok(url.startsWith(`${route("listingIntents")}?`))
      return { items: [original], next_cursor: null }
    })
    const opening = mode === "pending" ? openCardSession("card") : undefined
    try {
      if (opening) await requested
      assert.equal(peekCardSession("card"), undefined)
      await fx.hook.inspectUnknownRows(["row"])
      assert.equal(fx.hook.canReleaseUnknownRows(["row"]), false)
      await fx.hook.releaseUnknownRows(["row"])
      assert.equal(cloud.calls.length, mode === "pending" ? 2 : 1)
      assert.equal(cloud.calls.filter((call) => call.url === route("listingCardsById", { id: "card" })).length, mode === "pending" ? 1 : 0)
      assert.deepEqual(fx.calls, [])
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
      if (opening) { finish!(fx.card); await opening }
      else primeCardSession(fx.card)
      assert.ok(peekCardSession("card"))
      assert.equal(fx.hook.canReleaseUnknownRows(["row"]), false, "Card arrival alone cannot grant a release candidate")
      await fx.hook.inspectUnknownRows(["row"])
      assert.equal(fx.hook.canReleaseUnknownRows(["row"]), true)
      assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 0)
      assert.equal(cloud.calls.some((call) => call.url.includes("/schema") || call.url.includes("/submit")), false)
      assert.deepEqual(fx.calls, [])
    } finally {
      try { if (opening) { finish?.(fx.card); await opening } }
      finally { cloud.restore(); fx.restore() }
    }
  })
}

test("compiled op7 rejects an invalid resident draft despite a fresh Cloud ready projection and retains the unknown fence", async () => {
  const fx = await fixture(true)
  let reads = 0
  const cloud = serve(({ url }) => {
    if (url.startsWith(`${route("listingIntents")}?`)) return { items: [++reads === 1 ? original : released] }
    if (url === route("listingIntentsReleaseUnknown")) return { released_intent_ids: ["exact"], intents: [receipt] }
    if (url === `${route("listingRows")}/row`) return fx.fresh
    throw new Error(`unexpected ${url}`)
  })
  try {
    await fx.hook.inspectUnknownRows(["row"])
    await fx.hook.releaseUnknownRows(["row"])
    assert.deepEqual(fx.calls, ["op7", "schema-drop"])
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    assert.equal(peekListingWorkbench().productBases.row!.lifecycle.stage, "outcome_unknown")
    assert.equal(cloud.calls.some((call) => call.url.includes("/submit")), false)
    assert.equal(fx.notices.length, 2)
  } finally { cloud.restore(); fx.restore() }
})

test("production duplicate release and late route departure keep the exact POST alone", async () => {
  const fx = await fixture()
  let finish: ((value: unknown) => void) | undefined
  let pending: ReturnType<typeof fx.hook.releaseUnknownRows> | undefined
  const cloud = serve(({ url }) => url === route("listingIntentsReleaseUnknown")
    ? new Promise((resolve) => { finish = resolve }) : { items: [original] })
  try {
    await fx.hook.inspectUnknownRows(["row"])
    pending = fx.hook.releaseUnknownRows(["row"])
    await fx.hook.releaseUnknownRows(["row"])
    assert.equal(cloud.calls.filter((call) => call.method === "POST").length, 1)
    resetListingWorkbench()
    fx.context.generation++
    finish!({ released_intent_ids: ["exact"], intents: [receipt] })
    await pending
    assert.equal(cloud.calls.length, 2)
    assert.deepEqual(fx.calls, [])
    assert.equal(fx.notices.length, 1, "late receipt cannot notify another workbench")
  } finally {
    fx.context.active = false
    finish?.({ released_intent_ids: ["exact"], intents: [receipt] })
    try { await pending }
    finally { cloud.restore(); fx.restore() }
  }
})

test("partial exact-ID release validates only the proven row, preserves a different operation's fence and cohort, and never sends", async () => {
  const fx = await fixture()
  const second = { ...fx.raw, id: "row-two", submission_state: "unknown", projection: listingProjection({ stage: "outcome_unknown",
    readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["outcome_unknown"], allowed_actions: [] } }) }
  const secondIntent = { ...original, id: "exact-two", listing_row_id: second.id, client_operation_id: "different-operation" }
  rememberListingRows([second], rowCacheScope())
  patchListingWorkbench((state) => ({ rows: [...state.rows, { ...state.rows[0]!, id: second.id, draftId: second.id }],
    productDrafts: { ...state.productBases, [second.id]: { ...state.productBases.row!, draft_id: second.id, ...rowStatusView(second) } }, queueFrozenIds: ["row", second.id] }))
  let reads = 0
  const cloud = serve(({ url, body }) => {
    if (url.startsWith(`${route("listingIntents")}?`)) return { items: [++reads === 1 ? original : released, secondIntent] }
    if (url === route("listingIntentsReleaseUnknown")) {
      assert.deepEqual(body.intentIds, ["exact", "exact-two"])
      return { released_intent_ids: ["exact"], intents: [receipt] }
    }
    if (url === `${route("listingRows")}/row`) return fx.fresh
    throw new Error(`unexpected ${url}`)
  })
  try {
    await fx.hook.inspectUnknownRows(["row", second.id])
    assert.equal(fx.hook.canReleaseUnknownRows(["row", second.id]), true)
    await fx.hook.releaseUnknownRows(["row", second.id])
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, false)
    assert.equal(peekListingWorkbench().rows[1]!.publishUnconfirmed, true)
    assert.equal(peekListingWorkbench().productBases[second.id]!.lifecycle.stage, "outcome_unknown")
    assert.deepEqual(peekListingWorkbench().queueFrozenIds, ["row", second.id])
    assert.deepEqual(fx.calls, ["op7", "schema-drop"])
    assert.equal(cloud.calls.filter((call) => call.url.includes("/submit")).length, 0)
    assert.equal(cloud.calls.filter((call) => call.url.startsWith(`${route("listingRows")}/`)).length, 1)
    assert.match(fx.notices[1]!, /部分或全部.*保持锁定/)
  } finally { cloud.restore(); fx.restore() }
})

test("mixed Store inspection and over-100 selections use zero backend calls and grant no release candidates", async () => {
  const fx = await fixture()
  const second = { ...fx.raw, id: "other-row", store_id: "other-store", projection: listingProjection({ stage: "outcome_unknown",
    readiness: { ready_to_publish: false, can_start_publish_attempt: false, blockers: ["outcome_unknown"], allowed_actions: [] } }) }
  rememberListingRows([second], rowCacheScope())
  patchListingWorkbench((state) => ({ rows: [...state.rows, { ...state.rows[0]!, id: second.id, draftId: second.id }],
    productDrafts: { ...state.productBases, [second.id]: { ...state.productBases.row!, draft_id: second.id, ...rowStatusView(second) } } }))
  const cloud = serve(() => { throw new Error("mixed Store / oversized inspection is local only") })
  try {
    await fx.hook.inspectUnknownRows(["row", second.id])
    await fx.hook.inspectUnknownRows(Array.from({ length: 101 }, (_, i) => `row-${i}`))
    assert.equal(cloud.calls.length, 0)
    assert.equal(fx.hook.canReleaseUnknownRows(["row", second.id]), false)
    assert.equal(peekListingWorkbench().rows.every((row) => row.publishUnconfirmed === true), true)
  } finally { cloud.restore(); fx.restore() }
})

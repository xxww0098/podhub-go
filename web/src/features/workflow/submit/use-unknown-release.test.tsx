import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { ListingIntent } from "@/bindings/http-listing-intents"
import { toast } from "@/components/ui/toast"
import { invalidateAccountOverview } from "@/features/account/account-overview-cache"
import { cloudRow, product } from "../cloud-fanout-tests/fixtures"
import { capturePublishQueue } from "../cloud-fanout-tests/publish-queue-harness"
import { patchListingWorkbench, peekListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { golden, goldenSchema, nativeCardPayload, serve, warmProductionSend, wasmCore } from "./send-test-support"
import { useUnknownRelease, type UnknownReleaseCapability, type UnknownReleaseTarget } from "./use-unknown-release"

const original: ListingIntent = {
  id: "exact-intent", listing_row_id: "row", store_id: "store", client_operation_id: "original-operation",
  row_revision: 1, state: "unknown", can_resume: false, current_issue_status: "absent",
  submission_issues: [], submission_receipt_status: "absent", updated_at_ms: 10,
  has_live_reconcile_claim: false, has_unfinished_dispatch_job: false,
}
const released: ListingIntent = { ...original, state: "superseded", updated_at_ms: 11 }
function mount(capability?: UnknownReleaseCapability) {
  let hook!: ReturnType<typeof useUnknownRelease>
  function Capture() { hook = useUnknownRelease(false, capability); return null }
  renderToStaticMarkup(<Capture />)
  return hook
}
function seed() {
  resetListingWorkbench()
  const view = product("row")
  patchListingWorkbench({
    rows: [{ id: "row", draftId: "row", imageName: "row.png", status: "failed", stage: "outcome_unknown",
      publishUnconfirmed: true, ai: "done", render: "done", upload: "done", log: "未确认" }],
    productDrafts: { row: { ...view, lifecycle: { ...view.lifecycle, stage: "outcome_unknown" } } },
    queueFrozenIds: ["row"],
  })
}
function authority(): UnknownReleaseTarget {
  return { platform: "ozon", intent: { ...original }, canManage: true, storeVisible: true, claimActive: false, jobsActive: false }
}
function notices() {
  const items: string[] = []
  const previous = toast.add
  toast.add = ((item) => { items.push(String(item.title)); return "release-test" }) as typeof toast.add
  return { items, restore() { toast.add = previous } }
}

for (const mode of ["missing-capability", "no-id", "accepted", "receipt-only", "canResume-only", "permission-missing", "store-hidden", "claimed", "jobs-active", "foreign-row", "read-facts-missing", "read-facts-null", "read-claim-active", "read-job-active"] as const) {
  test(`unknown release fails closed before any request for ${mode}`, async () => {
    seed()
    const target = authority()
    if (mode === "no-id" || mode === "receipt-only") target.intent.id = ""
    if (mode === "receipt-only") target.intent.submission_receipt = { batch_id: "receipt", item_count: 1, http_status: 200 }
    if (mode === "accepted") target.intent.state = "accepted"
    if (mode === "canResume-only") { target.intent.state = "rejected"; target.intent.can_resume = true }
    if (mode === "permission-missing") target.canManage = false
    if (mode === "store-hidden") target.storeVisible = false
    if (mode === "claimed") target.claimActive = true
    if (mode === "jobs-active") target.jobsActive = true
    if (mode === "foreign-row") target.intent.listing_row_id = "another-row"
    if (mode === "read-facts-missing") delete target.intent.has_live_reconcile_claim
    if (mode === "read-facts-null") target.intent.has_unfinished_dispatch_job = null
    if (mode === "read-claim-active") target.intent.has_live_reconcile_claim = true
    if (mode === "read-job-active") target.intent.has_unfinished_dispatch_job = true
    const cloud = serve(() => { throw new Error("no request is authorized") })
    const seen = notices()
    let checks = 0
    const hook = mount(mode === "missing-capability" ? undefined : {
      capture: () => target, current: () => true, revalidate: async () => { checks += 1; return undefined },
    })
    try {
      await hook.releaseUnknownRows(["row"])
      assert.equal(cloud.calls.length, 0)
      assert.equal(checks, 0)
      assert.equal(seen.items.length, 1)
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
    } finally { cloud.restore(); seen.restore(); resetListingWorkbench() }
  })
}

for (const mode of ["empty", "lost", "foreign", "readback-error", "stale", "new-operation", "claim-changed", "readback-empty", "native-blocked", "paged", "readback-claim", "readback-job", "readback-missing-facts"] as const) {
  test(`release ${mode} cannot unlock the row or send`, async () => {
    seed()
    const target = authority()
    let current = true
    let checks = 0
    const seen = notices()
    const cloud = serve(({ url, method }) => {
      if (method === "POST") {
        assert.equal(url, route("listingIntentsReleaseUnknown"))
        if (mode === "lost") throw new TypeError("connection lost after commit")
        if (mode === "empty") return { released_intent_ids: [], intents: [] }
        if (mode === "claim-changed") current = false
        return { released_intent_ids: [original.id], intents: [{ ...released, store_id: mode === "foreign" ? "other-store" : original.store_id }] }
      }
      if (url === route("listingIntentsById", { id: original.id })) return original
      if (url.startsWith(`${route("listingIntents")}?`)) {
        if (mode === "readback-error") throw new TypeError("readback disconnected")
        const after = { ...released }
        if (mode === "readback-missing-facts") delete after.has_unfinished_dispatch_job
        if (mode === "readback-claim") after.has_live_reconcile_claim = true
        if (mode === "readback-job") after.has_unfinished_dispatch_job = true
        return { items: mode === "readback-empty" ? [] : [{ ...after,
          row_revision: mode === "stale" ? 0 : 1,
          client_operation_id: mode === "new-operation" ? "other-operation" : original.client_operation_id }], next_cursor: mode === "paged" ? "next" : null }
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const hook = mount({ capture: () => target, current: () => current,
      revalidate: async () => { checks += 1; return undefined } })
    try {
      await hook.releaseUnknownRows(["row"])
      assert.equal(checks, mode === "native-blocked" ? 1 : 0)
      assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
      assert.equal(cloud.calls.some((call) => call.url.includes("/submit")), false)
      assert.equal(seen.items.length, 1)
    } finally { cloud.restore(); seen.restore(); resetListingWorkbench() }
  })
}

test("exact release, new readback and real Native validation precede a separate explicit hook send", async () => {
  await warmProductionSend()
  const core = await wasmCore()
  const handle = core.loadSchema({ snapshot: goldenSchema })
  seed()
  const target = authority()
  const order: string[] = []
  const seen = notices()
  const cloud = serve(({ url, method, body }) => {
    if (url === route("listingIntentsById", { id: original.id })) { order.push("capture-read"); return original }
    if (url === route("listingIntentsReleaseUnknown")) {
      assert.deepEqual(body.intentIds, [original.id]); order.push("release")
      return { released_intent_ids: [original.id], intents: [released] }
    }
    if (url.startsWith(`${route("listingIntents")}?`)) { order.push("new-readback"); return { items: [released] } }
    if (url === route("listingCardsById", { id: "card" })) return { id: "card", revision: 1, payload: method === "PATCH" ? body.payload : nativeCardPayload(), updated_at_ms: 1 }
    if (url === route("listingSubmit")) {
      order.push("user-send")
      return { items: [{ row_id: "row", created: true, intent: { ...original, state: "accepted", external_task_id: "42" } }] }
    }
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [] }
    if (url.startsWith(`${route("listingRows")}/`)) return cloudRow("row")
    throw new Error(`unexpected ${method} ${url}`)
  })
  const hook = mount({ capture: () => target, current: () => true, revalidate: async () => {
    order.push("native-check")
    const result = core.revalidate(handle, { row: structuredClone(golden.row), card: golden.card, nowMs: 10 })
    assert.equal(result.fact, "Passed")
    return { ...product("row"), lifecycle: { ...product("row").lifecycle, fields: "valid", stage: "ready_to_publish" },
      readiness: { ready_to_publish: true, can_start_publish_attempt: true, blockers: [], allowed_actions: ["publish"] } }

  } })
  try {
    await hook.releaseUnknownRows(["row"])
    assert.deepEqual(order, ["release", "new-readback", "native-check"])
    assert.equal(cloud.calls.filter((call) => call.url.includes("/submit")).length, 0)
    await capturePublishQueue().startPublish(["row"])
    assert.deepEqual(order.slice(0, 3), ["release", "new-readback", "native-check"])
    assert.equal(order.filter((step) => step === "user-send").length, 1)
  } finally { core.dropSchema(handle); cloud.restore(); seen.restore(); invalidateAccountOverview(); resetListingWorkbench() }
})

test("repeat release clicks share one flight and a departed workbench ignores its late receipt", async () => {
  seed()
  let finish!: (value: { released_intent_ids: string[]; intents: ListingIntent[] }) => void
  const cloud = serve(() => new Promise<{ released_intent_ids: string[]; intents: ListingIntent[] }>((resolve) => { finish = resolve }))
  const seen = notices()
  let checks = 0
  const hook = mount({ capture: authority, current: () => true, revalidate: async () => { checks += 1; return undefined } })
  try {
    const first = hook.releaseUnknownRows(["row"])
    await hook.releaseUnknownRows(["row"])
    assert.equal(cloud.calls.length, 1)
    resetListingWorkbench()
    finish({ released_intent_ids: [original.id], intents: [released] })
    await first
    assert.equal(cloud.calls.length, 1)
    assert.equal(checks, 0)
    assert.equal(seen.items.length, 0)
  } finally { cloud.restore(); seen.restore(); resetListingWorkbench() }
})

test("explicit inspection deduplicates clicks and never invokes release or send", async () => {
  seed()
  const seen = notices()
  const cloud = serve(() => { throw new Error("the inspector is the only injected read") })
  let finish!: () => void, reads = 0
  let hook!: ReturnType<typeof useUnknownRelease>
  function Capture() {
    hook = useUnknownRelease(false, undefined, async () => {
      reads++
      await new Promise<void>((resolve) => { finish = resolve })
      return { message: "缺少 claim 和 Job 证据，保持锁定" }
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  try {
    const pending = hook.inspectUnknownRows(["row"])
    await hook.inspectUnknownRows(["row"])
    await hook.releaseUnknownRows(["row"])
    assert.equal(reads, 1)
    finish()
    await pending
    assert.equal(seen.items.length, 1)
    assert.equal(cloud.calls.length, 0)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
  } finally { cloud.restore(); seen.restore(); resetListingWorkbench() }
})

test("late explicit inspection cannot notify a different workbench", async () => {
  seed()
  const seen = notices()
  let finish!: () => void
  let hook!: ReturnType<typeof useUnknownRelease>
  function Capture() {
    hook = useUnknownRelease(false, undefined, async () => {
      await new Promise<void>((resolve) => { finish = resolve })
      return { message: "旧行证据" }
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  try {
    const pending = hook.inspectUnknownRows(["row"])
    resetListingWorkbench()
    finish()
    await pending
    assert.equal(seen.items.length, 0)
    assert.equal(peekListingWorkbench().rows.length, 0)
  } finally { seen.restore(); resetListingWorkbench() }
})

test("fresh accepted authority dominates a stale local unconfirmed flag before release", async () => {
  seed()
  patchListingWorkbench((state) => ({ productDrafts: { row: { ...state.productBases.row!,
    lifecycle: { ...state.productBases.row!.lifecycle, stage: "accepted" } } } }))
  const cloud = serve(() => { throw new Error("accepted rows cannot release") })
  const seen = notices()
  try {
    await mount({ capture: authority, current: () => true, revalidate: async () => { throw new Error("no validation") } }).releaseUnknownRows(["row"])
    assert.equal(cloud.calls.length, 0)
    assert.equal(seen.items.length, 1)
    assert.equal(peekListingWorkbench().rows[0]!.publishUnconfirmed, true)
  } finally { cloud.restore(); seen.restore(); resetListingWorkbench() }
})

import { patchListingCard } from "../card/card-writes"
/**
 * A Card saved before the system media write guard: its stored defaults
 * still hold a video group and a cover value. The send's queue write is a
 * whole-payload Card PATCH, so that legacy subset rides along unchanged;
 * Cloud answers 200 with the defaults cleaned and the send reaches dispatch.
 * When Cloud refuses the PATCH, nothing is dispatched and the error toast names
 * the cause. Real Hook callbacks, card session and send rail; only Cloud (and,
 * while warming, the compiled module's own bytes) is played by the fetch stub.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test, { before } from "node:test"
import { route } from "@/api/routes"
import { toast } from "@/components/ui/toast"
import { invalidateAccountOverview } from "@/features/account/account-overview-cache"
import type { ListingRow } from "../model/listing-row"
import {
  nativeCardPayload,
  refusal,
  serve,
  warmProductionSend,
  type SendCall,
} from "../submit/send-test-support"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { cloudRow, product } from "./fixtures"
import { capturePublishQueue } from "./publish-queue-harness"

/** The compiled module `defaultSendCore` fetches, from the repo-root `wasm/dist/` tree. */
const WASM_URL = new URL("../../../../../wasm/dist/browser/listing-state.wasm", import.meta.url).href

// The send rail freezes through the real native core against resident material.
// Production fetches the compiled module, which the network guard refuses for
// `file:`, so the warm-up is answered for that one URL with the current
// compiled bytes; any other request it makes is an error.
before(async () => {
  const bytes = readFileSync(new URL(WASM_URL))
  const wasm = serve(({ url, method }) => {
    if (method === "GET" && url === WASM_URL) {
      return new Response(bytes, { headers: { "Content-Type": "application/wasm" } })
    }
    throw new Error(`unexpected request while warming the send rail: ${method} ${url}`)
  })
  try {
    await warmProductionSend()
  } finally {
    wasm.restore()
  }
})

const CARD_URL = route("listingCardsById", { id: "card" })
const SUBMIT_URL = route("listingSubmit")
const FORGED_COVER = { kind: "url", value: "https://evil.example.invalid/forged-cover.jpg" }
const LEGACY_VIDEO = {
  complex_id: 100001,
  items: [{
    item_id: "legacy-video-1",
    values: { attribute_21841: { kind: "url", value: "https://evil.example.invalid/forged.mp4" } },
  }],
}
/** Cloud's refusal of a write that adds system media, as the Native owner words it. */
const REFUSAL = "系统媒体由发送时的媒体证据填写，方案默认值不能新增或修改：系统媒体组 100001。" +
  "请在方案默认值中删除这些字段或组后重新保存；视频和封面请在方案媒体中上传"

/** The golden Card as it was stored before the guard: system media in its defaults. */
function legacyCard() {
  const card = nativeCardPayload()
  // Fixture premise: the golden Card stores defaults for the legacy subset to join.
  assert.ok(card.defaults, "the golden Card carries defaults")
  return {
    ...card,
    defaults: {
      ...card.defaults,
      values: { ...card.defaults.values, attribute_21845: FORGED_COVER },
      complex_values: [...card.defaults.complex_values, LEGACY_VIDEO],
    },
  }
}

function queueRows(ids: readonly string[]) {
  const rows = ids.map((id): ListingRow => ({
    id, draftId: id, imageName: `${id}.png`,
    status: "ready", ai: "done", render: "done", upload: "done", log: "",
  }))
  patchListingWorkbench({
    rows,
    queueFrozenIds: [...ids],
    productDrafts: Object.fromEntries(ids.map((id) => [id, product(id)])),
  })
}

/**
 * Plays Cloud around one stored Card: `patch` answers its PATCH; the rest are
 * the reads the send rail makes and the one dispatch it may reach.
 */
function playCloud(patch: (call: SendCall) => unknown) {
  let stored: object = legacyCard()
  let revision = 1
  return serve((call) => {
    const { url, method, body } = call
    if (url === CARD_URL) {
      if (method !== "PATCH") return { id: "card", revision, payload: stored, updated_at_ms: revision }
      const answer = patch(call)
      if (answer instanceof Response) return answer
      stored = answer as object
      revision += 1
      return { id: "card", revision, payload: stored, updated_at_ms: revision }
    }
    if (url === SUBMIT_URL) {
      return { items: body.row_ids.map((rowId: string) => ({ row_id: rowId, created: true, intent: { id: `intent-${rowId}` } })) }
    }
    if (url.startsWith(`${route("listingRows")}?`)) return { items: [] }
    if (url.startsWith(`${route("listingRows")}/`)) return cloudRow(url.split("/").at(-1)!)
    if (url.startsWith(`${route("listingIntents")}?`)) return { items: [] }
    throw new Error(`unexpected request ${method} ${url}`)
  })
}

const writes = (calls: readonly SendCall[]) =>
  calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.url}`)

test("a legacy Card's whole queue PATCH is answered clean and the send reaches dispatch", async () => {
  resetListingWorkbench()
  const ids = ["legacy-a", "legacy-b"]
  queueRows(ids)
  const hook = capturePublishQueue()
  const clean = nativeCardPayload()
  const cloud = playCloud(({ body }) => {
    // The whole stored document travels back: the legacy subset rides along
    // untouched, beside the new queue cursor.
    assert.deepEqual(body.payload.defaults.values.attribute_21845, FORGED_COVER)
    assert.deepEqual(
      body.payload.defaults.complex_values.find((group: { complex_id: number }) => group.complex_id === 100001),
      LEGACY_VIDEO,
    )
    assert.deepEqual(body.payload.queue.frozenRowIds, ids)
    return { ...clean, queue: body.payload.queue }
  })
  try {
    await hook.startPublish()
    assert.deepEqual(writes(cloud.calls), [`PATCH ${CARD_URL}`, `POST ${SUBMIT_URL}`])
    const submit = cloud.calls.find((call) => call.url === SUBMIT_URL)
    assert.deepEqual(submit?.body.row_ids, ids, "both queued rows are dispatched")
    // Dispatch is not publication: `created` with an Intent id carries no
    // authoritative projection, so both rows keep waiting for their result.
    const state = peekListingWorkbench()
    for (const id of ids) {
      assert.equal(state.productBases[id]?.lifecycle.stage, "submitting", `${id} waits for its authoritative result`)
    }
    assert.equal(hook.submissionPending(), false, "this click's HTTP flight has ended")
    assert.equal(state.queueRunning, true, "accepted rows awaiting their authoritative result keep the queue active")
  } finally {
    cloud.restore()
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

test("a refused legacy Card PATCH dispatches nothing and names the cause", async () => {
  resetListingWorkbench()
  const ids = ["legacy-refused"]
  queueRows(ids)
  const hook = capturePublishQueue()
  const cloud = playCloud(() => refusal(400, "validation", REFUSAL))
  // The operator sees the refusal as an error toast; diagnostics stay redacted.
  const errors: Array<{ title?: unknown }> = []
  const stop = toast[" subscribe"]((event) => {
    if (event.action === "add" && event.options.type === "error") errors.push(event.options)
  })
  try {
    await hook.startPublish()
    assert.deepEqual(writes(cloud.calls), [`PATCH ${CARD_URL}`], "one PATCH, no dispatch")
    const state = peekListingWorkbench()
    assert.equal(state.queueRunning, false)
    assert.equal(state.rows[0]?.log, `发送未执行：${REFUSAL}`)
    assert.doesNotMatch(state.rows[0]!.log, /请重试/)
    assert.equal(state.rows[0]?.status, "ready", "the optimistic row status is restored")
    assert.equal(errors.length, 1, "one refusal notification")
    const named = errors.map((error) => String(error.title))
    assert.ok(named.some((title) =>
      title.includes("系统媒体组 100001") && title.includes("请在方案默认值中删除这些字段或组后重新保存")),
    named.join("\n"))
  } finally {
    stop()
    cloud.restore()
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})


test("removing refused system media via a real Card save allows the next explicit hook send", async () => {
  resetListingWorkbench()
  queueRows(["legacy-fixed"])
  const hook = capturePublishQueue()
  const cloud = playCloud(({ body }) => {
    const defaults = body.payload.defaults
    if (defaults.values.attribute_21845 || defaults.complex_values.some((group: { complex_id: number }) => group.complex_id === 100001)) {
      return refusal(400, "validation", REFUSAL)
    }
    return body.payload
  })
  try {
    await hook.startPublish()
    assert.deepEqual(writes(cloud.calls), [`PATCH ${CARD_URL}`])
    assert.match(peekListingWorkbench().rows[0]!.log, /系统媒体组 100001.*删除这些字段或组后重新保存/)
    await patchListingCard("card", (payload) => {
      const defaults = structuredClone(payload.defaults!)
      delete defaults.values.attribute_21845
      defaults.complex_values = defaults.complex_values.filter((group) => group.complex_id !== 100001)
      return { ...payload, defaults }
    })
    assert.equal(cloud.calls.filter((call) => call.url === SUBMIT_URL).length, 0, "saving does not send")
    await hook.startPublish()
    assert.deepEqual(writes(cloud.calls), [`PATCH ${CARD_URL}`, `PATCH ${CARD_URL}`, `PATCH ${CARD_URL}`, `POST ${SUBMIT_URL}`])
    assert.equal(hook.submissionPending(), false)
    assert.equal(peekListingWorkbench().productBases["legacy-fixed"]?.lifecycle.stage, "submitting")
  } finally {
    cloud.restore()
    invalidateAccountOverview()
    resetListingWorkbench()
  }
})

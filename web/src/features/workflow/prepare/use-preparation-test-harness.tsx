import { route } from "@/api/routes"
import { listingRow, listingProjection } from "../../../../tests/listing-row-fixture"
/** Real callbacks and HTTP adapter; SSR supplies refs, without mounting effects. */
import assert from "node:assert/strict"
import { setImmediate as tick } from "node:timers/promises"
import { renderToStaticMarkup } from "react-dom/server"
import type { WorkflowDraftView, WorkflowImageLifecycle } from "@/bindings/commands"
import { renderOpfs } from "@/bindings/render-opfs"
import type { ListingRow } from "../model/listing-row"
import { currentCardContext, requestStop, setCardContext } from "./execution-context"
import { patchListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { createPreparationTracks } from "./preparation-tracks"
import { rowStatusView } from "../model/row-state"
import { usePreparation } from "./use-preparation"
import { resetCardSessions } from "../card/card-session"

/** Fixed across every fixture: `usePreparation` needs a card id to open a
 * session for `verifySupplierOnce`; the id's value carries no meaning here. */
const CARD_ID = "card"

export const slice: WorkflowImageLifecycle = { index: 0, file_name: "slice.jpg", content_hash: "slice",
  group_name: "main", width: 100, height: 100, phase: "rendered" }
function cloudRow(id: string, images: WorkflowImageLifecycle[] = []) {
  const completed = images.filter((image) => image.phase === "public_ready").length
  return listingRow({ projection: listingProjection({ stage: "awaiting_content", ai: "pending", media: images.length && completed === images.length ? "ready" : images.length ? "rendered" : "pending", image_total: images.length, image_completed: completed, fields: "dirty" }), id, card_id: "card", store_id: "store", revision: 1,
    content_state: "draft", media_state: "pending", validation_state: "stale", submission_state: "none",
    draft: { values: {}, complex_values: [] }, validation_issues: [], media: { images, videos: [] },
    ai: { candidates: [] }, source: { sha256: id, fileName: `${id}.png` },
    payload: {}, updated_at_ms: 1 })
}
export function product(id: string, images: WorkflowImageLifecycle[] = []): WorkflowDraftView {
  return { draft_id: id, kind: "instance", display_name: id,
    schema: { description_category_id: 1, type_id: 1, fields: [
      { key: "name", name: "Name", description: "", group_name: "Basic", editor: "text",
        source: "fixed", complex_group_collection: false, read_only: false, aspect: null,
        constraints: { required: true, collection: false }, options: [], options_truncated: false },
    ], complex_groups: [] }, draft: cloudRow(id).draft, validation_state: "draft", issues: [],
    ai_prompt_id: "", ai_prompt: "", ai_prompt_file_name: "", psd_template_asset_id: "template",
    psd_template_file_name: "template.psd", target_store_id: "store",
    ai_field_policy: { allowed_field_keys: [], protected_field_keys: [] },
    lifecycle: rowStatusView(cloudRow(id, images)).lifecycle, updated_at_ms: 1 }
}
export const reply = (data: unknown) => new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
export const prepared = () => reply({ outcome: "prepared", jobs: [] })
export const refusal = () => new Response(JSON.stringify({ error: "Cloud refused preparation", code: "prepare_refused" }), {
  status: 500, headers: { "Content-Type": "application/json" } })
export function deferred() {
  let resolve!: (value: Response) => void
  const promise = new Promise<Response>((done) => { resolve = done })
  return { promise, resolve }
}
export function setup(ids: string[], options: { images?: WorkflowImageLifecycle[], template?: boolean, statusFailure?: boolean, supplierProductId?: string } = {}) {
  resetListingWorkbench()
  // A card session opened by a prior test must not answer this one: each
  // fixture reuses the same `CARD_ID`, and a stale cached session would skip
  // the GET this fixture's own fetch mock expects to serve.
  resetCardSessions()
  const tracks = { current: createPreparationTracks() }
  const guidedLock = { current: false }
  const rows: ListingRow[] = ids.map((id) => ({ id, draftId: id, imageName: `${id}.png`,
    source: { handle: id, file_name: `${id}.png` }, status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" }))
  patchListingWorkbench({ rows, productDrafts: Object.fromEntries(ids.map((id) => [id, product(id, options.images)])) })
  let hook!: ReturnType<typeof usePreparation>
  function Capture() {
    hook = usePreparation({ active: true, ready: true,
      cardId: CARD_ID,
      supplierProductId: options.supplierProductId,
      psdTemplateAssetId: options.template === false ? "" : "template",
      psdAsset: options.template === false ? undefined : { handle: "template", file_name: "template.psd" },
      setPsdAsset: () => {}, psdAssetTemplateIdRef: { current: "template" },
      preparationTracks: tracks, guidedPreparationLock: guidedLock })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const previousContext = currentCardContext()
  setCardContext({ psdTemplateSha256: "template" })
  const running: Promise<void>[] = []
  const responses: ReturnType<typeof deferred>[] = []
  let closing = false
  function holdResponse() {
    const held = deferred()
    responses.push(held)
    return held
  }
  function start(method: "runAiRows" | "runRenderRows" | "runDeliverRows" | "runGuidedPreparation", ids: string[]) {
    const operation = hook[method](ids)
    running.push(operation)
    return operation
  }
  const pins: { id: string, operation: string, done?: boolean, resolve: (response: Response) => void }[] = []
  const cancels: string[] = []
  let cancelReply: () => Promise<Response> = async () => reply({ jobs: [{ id: "cancelled-job" }] })
  const previousFetch = globalThis.fetch
  const previousRestore = renderOpfs.workflowRestoreTemplatePsd
  // This fixture exercises scheduling with a fake render asset. Byte recovery
  // and digest verification are covered by template-assets.test.ts.
  renderOpfs.workflowRestoreTemplatePsd = async (assetId, _supplier, cardId) => {
    assert.equal(assetId, "template")
    assert.equal(cardId, CARD_ID)
    return { asset_id: assetId, asset: { handle: assetId, file_name: "template.psd" }, summary: {
      handle: assetId, file_name: "template.psd", canvas: { width: 1, height: 1, bits_per_channel: 8 },
      features: { layers: 0, groups: 0, smart_objects: 0, masks: 0, warped_smart_objects: 0, blend_modes: {} },
      top_groups: [], slots: [], capabilities: [],
    } }
  }
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url === `${route("listingCards")}/${CARD_ID}`) {
      assert.equal(init?.method ?? "GET", "GET")
      return reply({
        id: CARD_ID,
        revision: 1,
        title: "",
        storeId: null,
        updatedAtMs: 0,
        payload: { supplierProductId: options.supplierProductId },
      })
    }
    const match = /^\/api\/listing\/rows\/([^/]+)(.*)$/.exec(url)
    if (match) {
      const [, id, suffix] = match
      if (suffix === "/prepare") {
        assert.equal(init?.method, "POST")
        const held = holdResponse()
        pins.push({ id, operation: JSON.parse(String(init?.body)).operation, resolve: held.resolve })
        if (closing) held.resolve(prepared())
        return held.promise
      }
      if (suffix === "/prepare/cancel") {
        assert.equal(init?.method, "POST")
        cancels.push(id)
        return cancelReply()
      }
      assert.equal(suffix, "")
      if (options.statusFailure) return refusal()
      return reply(cloudRow(id, options.images))
    }
    if (url.startsWith(`${route("listingIntents")}?`)) return reply({ items: [] })
    throw new Error(`unexpected request ${url}`)
  }
  return { hook, start, holdResponse, tracks, guidedLock, pins, cancels,
    setCancelReply(next: typeof cancelReply) { cancelReply = next },
    // Admit any follow-up planning that arrives while settling the operation.
    async flush() {
      for (let i = 0; i < 20; i += 1) {
        await tick()
        const pending = pins.find(pin => !pin.done)
        if (!pending) return
        pending.done = true
        pending.resolve(prepared())
      }
    },
    async restore() {
      closing = true
      requestStop(ids)
      for (const response of responses) response.resolve(prepared())
      await Promise.allSettled(running)
      await tick()
      globalThis.fetch = previousFetch
      renderOpfs.workflowRestoreTemplatePsd = previousRestore
      setCardContext(previousContext)
          resetListingWorkbench()
    } }
}

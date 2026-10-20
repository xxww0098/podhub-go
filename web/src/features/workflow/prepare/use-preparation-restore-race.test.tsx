/**
 * What a preparation batch does with rows whose facts moved while it waited on
 * a template restore or supplier verification. Real callbacks and HTTP
 * adapter; SSR supplies refs, without mounting effects.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { PickedPsdAsset, WorkflowProductLifecycle } from "@/bindings/commands"
import { renderOpfs } from "@/bindings/render-opfs"
import { toast } from "@/components/ui/toast"
import { patchListingWorkbench, peekListingWorkbench } from "../workbench/listing-workbench-store"
import { currentCardContext, setCardContext } from "./execution-context"
import { usePreparation } from "./use-preparation"
import { deferred, refusal, reply, setup, slice } from "./use-preparation-test-harness"

const SEALED_STAGES = ["outcome_unknown", "accepted", "operator_attested"] as const
const RESTORE_FAILURE = "PSD 模板暂时无法读取，请稍后重试切片"

/** Hold the fixture's template restore until released, then resolve or reject. */
function gatedRestore(outcome: "resolve" | "reject") {
  const fixture = renderOpfs.workflowRestoreTemplatePsd
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  renderOpfs.workflowRestoreTemplatePsd = async (...args) => {
    await gate
    if (outcome === "reject") throw new Error(RESTORE_FAILURE)
    return fixture(...args)
  }
  return { release }
}

/** Every business request from here on, on top of the fixture's own mock. */
function recordRequests() {
  const inner = globalThis.fetch
  const urls: string[] = []
  globalThis.fetch = async (input, init) => {
    urls.push(String(input))
    return inner(input, init)
  }
  return urls
}

const touches = (urls: readonly string[], rowId: string) =>
  urls.filter((url) => new RegExp(`/rows/${rowId}(/|\\?|$)`).test(url))

function patchLifecycle(id: string, patch: Partial<WorkflowProductLifecycle>) {
  patchListingWorkbench((current) => {
    const draft = current.productDrafts[id]!
    return { productDrafts: { ...current.productDrafts, [id]: { ...draft, lifecycle: { ...draft.lifecycle, ...patch } } } }
  })
}

async function until(done: () => boolean) {
  for (let i = 0; i < 50 && !done(); i += 1) await tick()
}

const rowById = (id: string) => peekListingWorkbench().rows.find((row) => row.id === id)!

for (const stage of SEALED_STAGES) {
  test(`a row sealed (${stage}) while its template restores is not sliced`, async () => {
    const f = setup(["a", "b"])
    const restore = gatedRestore("resolve")
    const urls = recordRequests()
    try {
      const running = f.start("runRenderRows", ["a", "b"])
      assert.deepEqual([...f.tracks.current.snapshot().render].sort(), ["a", "b"])
      patchLifecycle("a", { stage })
      const before = rowById("a")
      restore.release()
      await until(() => f.pins.length > 0)
      assert.deepEqual(f.pins.map(({ id, operation }) => ({ id, operation })), [{ id: "b", operation: "slice" }])
      assert.deepEqual([...f.tracks.current.snapshot().render], ["b"], "the sealed row's claim is released at admission")
      await f.flush()
      await running
      assert.deepEqual(f.pins.map((pin) => pin.id), ["b"], "no later slice for the sealed row")
      assert.deepEqual(touches(urls, "a"), [], "no business request names the sealed row")
      assert.deepEqual(rowById("a"), before, "the sealed row keeps every fact it had")
      const p = peekListingWorkbench().preparationProgress.render!
      assert.deepEqual([p.total, p.settled, p.active], [2, 2, false])
      assert.equal(f.tracks.current.snapshot().render.size, 0)
    } finally {
      restore.release()
      await f.restore()
    }
  })
}

test("a row sealed while supplier media verifies is not uploaded", async () => {
  const f = setup(["a", "b"], { images: [slice], supplierProductId: "online-product" })
  const listingFetch = globalThis.fetch
  const verification = deferred()
  const urls: string[] = []
  globalThis.fetch = async (input, init) => {
    urls.push(String(input))
    return String(input) === route("mediaSupplierProductsByProductIdVerify", { product_id: "online-product" })
      ? verification.promise
      : listingFetch(input, init)
  }
  try {
    const upload = f.start("runDeliverRows", ["a", "b"])
    await tick()
    patchLifecycle("a", { stage: "outcome_unknown" })
    verification.resolve(reply({ psdSha256: "current-template" }))
    await until(() => f.pins.length > 0)
    assert.deepEqual(f.pins.map(({ id, operation }) => ({ id, operation })), [{ id: "b", operation: "upload" }])
    await f.flush()
    await upload
    assert.deepEqual(touches(urls, "a"), [])
    assert.notEqual(rowById("a").upload, "failed")
    assert.equal(peekListingWorkbench().preparationProgress.deliver?.settled, 2)
    assert.equal(f.tracks.current.snapshot().deliver.size, 0)
  } finally {
    verification.resolve(refusal())
    await f.restore()
  }
})

for (const media of ["rendered", "uploading", "ready"] as const) {
  test(`a late restore failure does not overwrite a render that meanwhile reached ${media}`, async () => {
    const f = setup(["a", "b"])
    const restore = gatedRestore("reject")
    const urls = recordRequests()
    try {
      const running = f.start("runRenderRows", ["a", "b"])
      patchLifecycle("a", { media })
      const before = rowById("a")
      restore.release()
      await running
      assert.deepEqual(rowById("a"), before, "the current render facts, source, progress and log stand")
      assert.equal(rowById("b").render, "failed")
      assert.equal(rowById("b").preparationRender?.message, RESTORE_FAILURE)
      assert.equal(peekListingWorkbench().productDrafts.a!.lifecycle.media, media)
      const p = peekListingWorkbench().preparationProgress.render!
      assert.deepEqual([p.settled, p.failed, p.active], [2, 1, false], "only the row it still describes is failed")
      assert.equal(f.pins.length, 0)
      assert.deepEqual(urls, [], "a failed restore spends no business request")
      assert.equal(f.tracks.current.snapshot().render.size, 0)
    } finally {
      restore.release()
      await f.restore()
    }
  })
}

test("a late restore failure does not fail a row whose source changed", async () => {
  const f = setup(["a"])
  const restore = gatedRestore("reject")
  try {
    const running = f.start("runRenderRows", ["a"])
    patchListingWorkbench((current) => ({
      rows: current.rows.map((row) => row.id === "a" ? { ...row, source: { handle: "a-replaced", file_name: "a2.png" }, log: "源图已替换" } : row),
    }))
    const before = rowById("a")
    restore.release()
    await running
    assert.deepEqual(rowById("a"), before)
    assert.deepEqual(rowById("a").source, { handle: "a-replaced", file_name: "a2.png" })
    const p = peekListingWorkbench().preparationProgress.render!
    assert.deepEqual([p.settled, p.failed, p.active], [1, 0, false])
  } finally {
    restore.release()
    await f.restore()
  }
})

test("Stop during a template restore keeps the claim until the attempt settles, then fails nothing", async () => {
  const f = setup(["a", "b"])
  const restore = gatedRestore("reject")
  try {
    const running = f.start("runRenderRows", ["a", "b"])
    const before = peekListingWorkbench().rows
    const stopping = f.hook.stopPreparation()
    await tick()
    assert.deepEqual(
      [...f.tracks.current.snapshot().render].sort(),
      ["a", "b"],
      "Stop does not release a claim before its attempt settles",
    )
    restore.release()
    await running
    await stopping
    for (const row of before) {
      assert.equal(rowById(row.id).render, row.render, "a stopped row is not failed by the late restore")
      assert.equal(rowById(row.id).preparationRender, undefined)
      assert.equal(rowById(row.id).log, row.log)
    }
    const p = peekListingWorkbench().preparationProgress.render!
    assert.deepEqual([p.settled, p.failed, p.active], [2, 0, false])
    assert.equal(f.pins.length, 0)
    assert.equal(f.tracks.current.snapshot().render.size, 0)
  } finally {
    restore.release()
    await f.restore()
  }
})

/**
 * The same real hook over the fixture's store and claims, with the template
 * writes it makes — asset and ref — observable; the fixture's own are inert.
 */
function templateHook(f: ReturnType<typeof setup>) {
  const assets: (PickedPsdAsset | undefined)[] = []
  const templateRef = { current: "template" }
  let hook!: ReturnType<typeof usePreparation>
  function Capture() {
    hook = usePreparation({ active: true, ready: true, cardId: "card",
      psdTemplateAssetId: "template", psdAsset: { handle: "template", file_name: "template.psd" },
      setPsdAsset: (asset) => { assets.push(asset) }, psdAssetTemplateIdRef: templateRef,
      preparationTracks: f.tracks, guidedPreparationLock: f.guidedLock })
    return null
  }
  renderToStaticMarkup(<Capture />)
  return { hook, assets, templateRef }
}

/**
 * What the screen has applied once a card-level invalidation lands for a
 * template swap: the existing mediaEpoch bumped, the new template bound in the
 * card context and ref, and the refetched rows — same draft and source, still
 * owing a render.
 */
function swapTemplate(templateRef: { current: string }) {
  setCardContext({ psdTemplateSha256: "new-template" })
  templateRef.current = "new-template"
  patchListingWorkbench((current) => ({
    mediaEpoch: current.mediaEpoch + 1,
    productDrafts: Object.fromEntries(Object.entries(current.productDrafts).map(([id, draft]) =>
      [id, { ...draft, psd_template_asset_id: "new-template", psd_template_file_name: "new.psd" }])),
    rows: current.rows.map((row) => ({ ...row, log: "模板已更换" })),
  }))
}

function recordNotices() {
  const previousAdd = toast.add
  const titles: string[] = []
  toast.add = ((notice: { title?: unknown }) => {
    titles.push(String(notice.title))
    return "notice"
  }) as typeof toast.add
  return { titles, restore() { toast.add = previousAdd } }
}

for (const outcome of ["reject", "resolve"] as const) {
  test(`a template restore that ${outcome}s after a card-level template swap is stale`, async () => {
    const f = setup(["a", "b"])
    const t = templateHook(f)
    const restore = gatedRestore(outcome)
    const urls = recordRequests()
    const notices = recordNotices()
    try {
      const running = t.hook.runRenderRows(["a", "b"])
      assert.deepEqual([...f.tracks.current.snapshot().render].sort(), ["a", "b"])
      swapTemplate(t.templateRef)
      const before = peekListingWorkbench().rows
      const drafts = peekListingWorkbench().productDrafts
      restore.release()
      await running
      await f.flush()
      assert.deepEqual(peekListingWorkbench().rows, before, "the new template's rows keep every fact, progress and log")
      for (const row of before) assert.equal(row.preparationRender, undefined, "no old template cause")
      assert.deepEqual(peekListingWorkbench().productDrafts, drafts)
      assert.deepEqual(t.assets, [], "the old managed asset is not set as current")
      assert.equal(t.templateRef.current, "new-template")
      assert.deepEqual(currentCardContext(), { psdTemplateSha256: "new-template" })
      assert.equal(f.pins.length, 0, "no slice under the old template")
      assert.deepEqual(urls, [], "a stale restore spends no business request")
      assert.deepEqual(notices.titles, [], "no toast for the old template")
      const p = peekListingWorkbench().preparationProgress.render!
      assert.deepEqual([p.total, p.settled, p.failed, p.active], [2, 2, 0, false])
      assert.equal(f.tracks.current.snapshot().render.size, 0, "every claim is released")
    } finally {
      restore.release()
      notices.restore()
      await f.restore()
    }
  })
}

import { route } from "@/api/routes"
/** Real callbacks and HTTP adapter; SSR supplies refs, without mounting effects. */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { renderOpfs } from "@/bindings/render-opfs"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { currentCardContext } from "./execution-context"
import {
  deferred,
  prepared,
  product,
  refusal,
  reply,
  setup,
  slice,
} from "./use-preparation-test-harness"

test("supplier upload waits for current media verification and releases claims on refusal", async () => {
  const f = setup(["a"], { images: [slice], supplierProductId: "online-product" })
  const listingFetch = globalThis.fetch
  const verification = deferred()
  let verifications = 0
  globalThis.fetch = async (input, init) => {
    if (String(input) === route("mediaSupplierProductsByProductIdVerify", { product_id: "online-product" })) {
      assert.equal(init?.method, "POST")
      verifications += 1
      return verifications === 1 ? verification.promise : reply({ psdSha256: "current-template" })
    }
    return listingFetch(input, init)
  }
  try {
    const upload = f.start("runDeliverRows", ["a"])
    await tick()
    assert.equal(verifications, 1)
    assert.equal(f.pins.length, 0, "planning must not race ahead of media verification")
    verification.resolve(refusal())
    await upload
    assert.equal(f.pins.length, 0, "unverified media must not be uploaded")
    assert.equal(f.tracks.current.snapshot().deliver.size, 0)
    assert.equal(peekListingWorkbench().rows[0].upload, "failed")
    assert.equal(peekListingWorkbench().rows[0].log, "上传准备失败")
    assert.equal(peekListingWorkbench().preparationProgress.deliver?.failed, 1)

    const retry = f.start("runDeliverRows", ["a"])
    await tick()
    assert.equal(verifications, 2, "retry must check the online source again")
    assert.deepEqual(f.pins.map(({ id, operation }) => ({ id, operation })), [{ id: "a", operation: "upload" }])
    await f.flush()
    await retry
    assert.equal(f.tracks.current.snapshot().deliver.size, 0)
  } finally {
    verification.resolve(refusal())
    await f.restore()
  }
})

test("supplier slice keeps a locally bound PSD instead of replacing it with the supplier default", async () => {
  const f = setup(["a"], { supplierProductId: "online-product" })
  try {
    const slicing = f.start("runRenderRows", ["a"])
    await tick()
    assert.deepEqual(f.pins.map(({ operation }) => operation), ["slice"])
    assert.equal(currentCardContext().psdTemplateSha256, "template")
    await f.flush()
    await slicing
  } finally {
    await f.restore()
  }
})

test("stopping during supplier verification prevents upload admission", async () => {
  const f = setup(["a"], { images: [slice], supplierProductId: "online-product" })
  const listingFetch = globalThis.fetch
  const verification = deferred()
  globalThis.fetch = async (input, init) => String(input) === route("mediaSupplierProductsByProductIdVerify", { product_id: "online-product" })
    ? verification.promise
    : listingFetch(input, init)
  try {
    const upload = f.start("runDeliverRows", ["a"])
    await tick()
    f.hook.stopPreparation()
    verification.resolve(reply({ psdSha256: "current-template" }))
    await upload
    assert.equal(f.pins.length, 0, "a successful late verification must not undo Stop")
    assert.equal(f.tracks.current.snapshot().deliver.size, 0)
  } finally {
    verification.resolve(refusal())
    await f.restore()
  }
})

for (const fails of [false, true]) {
  test(`supplier verification cannot repaint a newly opened card (${fails ? "failure" : "success"})`, async () => {
    const f = setup(["a"], { images: [slice], supplierProductId: "online-product" })
    const listingFetch = globalThis.fetch
    const verification = deferred()
    globalThis.fetch = async (input, init) => String(input) === route("mediaSupplierProductsByProductIdVerify", { product_id: "online-product" })
      ? verification.promise
      : listingFetch(input, init)
    try {
      const upload = f.start("runDeliverRows", ["a"])
      await tick()
      resetListingWorkbench()
      patchListingWorkbench({ rows: [{ id: "a", draftId: "new-draft", imageName: "new.png", status: "pending", ai: "idle", render: "idle", upload: "idle", log: "new card" }] })
      const nextCard = peekListingWorkbench()
      verification.resolve(fails ? refusal() : reply({ psdSha256: "old-template" }))
      await upload
      assert.equal(f.pins.length, 0)
      assert.deepEqual(peekListingWorkbench(), nextCard, "even matching row IDs must not receive the old card's result")
      assert.equal(f.tracks.current.snapshot().deliver.size, 0)
    } finally {
      verification.resolve(refusal())
      await f.restore()
    }
  })
}

test("an operation failure with status refresh failure keeps the last row state", async () => {
  const f = setup(["a"], { statusFailure: true })
  try {
    const running = f.start("runAiRows", ["a"])
    await tick()
    f.pins[0]!.resolve(refusal())
    await running
    const current = peekListingWorkbench().rows[0]!
    assert.notEqual(current.status, "failed")
    assert.equal(current.status, "pending")
    assert.equal(current.ai, "idle")
    assert.equal(peekListingWorkbench().productDrafts.a!.lifecycle.stage, "awaiting_content")
    assert.equal(current.log, "Cloud refused preparation")
  } finally { await f.restore() }
})

test("same-tick AI clicks share claims; an old batch cannot release a new claim", async () => {
  const f = setup(["a", "b"])
  try {
    const first = f.start("runAiRows", ["a", "b"])
    await f.start("runAiRows", ["a", "b"])
    assert.deepEqual(f.pins.map((pin) => pin.id), ["a", "b"])
    f.pins[0].resolve(prepared())
    await tick()
    assert.deepEqual([...f.tracks.current.snapshot().ai], ["b"])
    assert.equal(peekListingWorkbench().preparationProgress.ai?.settled, 1)
    const next = f.start("runAiRows", ["a"])
    assert.equal(f.pins.length, 3)
    f.pins[1].resolve(prepared())
    await first
    assert.deepEqual([...f.tracks.current.snapshot().ai], ["a"])
    assert.equal(peekListingWorkbench().preparationProgress.ai?.active, true)
    f.pins[2].resolve(prepared())
    await next
    assert.equal(f.tracks.current.snapshot().ai.size, 0)
    const p = peekListingWorkbench().preparationProgress.ai!
    assert.deepEqual([p.total, p.settled, p.failed, p.active, p.open], [3, 3, 0, false, 0])
  } finally { await f.restore() }
})

test("AI and render overlap while render fences upload of the same row", async () => {
  const f = setup(["a"])
  try {
    const ai = f.start("runAiRows", ["a"])
    const render = f.start("runRenderRows", ["a"])
    await tick()
    assert.deepEqual(f.pins.map((pin) => pin.operation).sort(), ["recognize", "slice"])
    patchListingWorkbench({ productDrafts: { a: product("a", [slice]) } })
    await f.start("runDeliverRows", ["a"])
    assert.equal(f.pins.length, 2)
    for (const pin of f.pins) pin.resolve(prepared())
    await Promise.all([ai, render])
    assert.equal(f.tracks.current.snapshot().ai.size + f.tracks.current.snapshot().render.size, 0)
  } finally { await f.restore() }
})

for (const [method, verb, operation] of [
  ["runAiRows", "ai", "recognize"], ["runRenderRows", "render", "slice"],
  ["runDeliverRows", "deliver", "upload"], ["runGuidedPreparation", "deliver", "prepare"],
] as const) {
  test(`${method} clears claims and progress after Cloud failure, then admits retry`, async () => {
    const options = { images: method === "runDeliverRows" ? [slice] : [] }
    const f = setup(["a"], options)
    try {
      const running = f.start(method, ["a"])
      await tick()
      await f.start(method, ["a"])
      assert.equal(f.pins.length, 1)
      assert.equal(f.pins[0].operation, operation)
      f.pins[0].resolve(refusal())
      await running
      assert.equal(f.tracks.current.snapshot()[verb].size, 0)
      assert.equal(f.guidedLock.current, false)
      assert.equal(peekListingWorkbench().guidedPreparation.active, false)
      const p = peekListingWorkbench().preparationProgress[verb]!
      assert.deepEqual([p.total, p.settled, p.failed, p.active], [1, 1, 1, false])
      const retry = f.start(method, ["a"])
      await tick()
      assert.equal(f.pins.length, 2)
      options.images = [{ ...slice, phase: "public_ready" }]
      f.pins[1].done = true
      f.pins[1].resolve(prepared())
      await f.flush()
      await retry
      assert.equal(peekListingWorkbench().preparationProgress[verb]?.failed, 0)
    } finally { await f.restore() }
  })
}
for (const method of ["runRenderRows"] as const) {
  test(`${method} frees its guard when the template is absent`, async () => {
    const f = setup(["a"], { template: false })
    try {
      await f.start(method, ["a"])
      assert.equal(f.pins.length, 0)
      assert.equal(f.guidedLock.current, false)
      assert.equal(peekListingWorkbench().guidedPreparation.active, false)
      assert.equal(f.tracks.current.snapshot().render.size, 0)
      assert.equal(peekListingWorkbench().rows[0].status, "failed")
      if (method === "runRenderRows") {
        assert.equal(peekListingWorkbench().preparationProgress.render?.active, false)
        assert.equal(peekListingWorkbench().preparationProgress.render?.failed, 1)
      }
    } finally { await f.restore() }
  })
}

test("render admission rereads durable products and closes rows removed after its claim", async () => {
  const f = setup(["a"])
  try {
    const running = f.start("runRenderRows", ["a"])
    assert.equal(f.tracks.current.snapshot().render.size, 1)
    patchListingWorkbench({ productDrafts: {} })
    await running
    assert.equal(f.pins.length, 0)
    assert.equal(f.tracks.current.snapshot().render.size, 0)
    const p = peekListingWorkbench().preparationProgress.render!
    assert.deepEqual([p.settled, p.failed, p.active], [1, 1, false])
    assert.deepEqual(peekListingWorkbench().rows, [], "a removed product must not leave a failed placeholder row")
  } finally { await f.restore() }
})

test("a missing card template records this attempt's own cause on the render leg", async () => {
  const f = setup(["a"], { template: false })
  const handle = peekListingWorkbench().rows[0]!.source
  const started = Date.now()
  try {
    await f.start("runRenderRows", ["a"])
    const current = peekListingWorkbench().rows[0]!
    assert.equal(current.render, "failed")
    assert.equal(current.log, "请先在建卡页配置 PSD 模板。")
    assert.equal(current.preparationRender?.stage, "render")
    assert.equal(current.preparationRender?.state, "failed")
    assert.equal(current.preparationRender?.message, "请先在建卡页配置 PSD 模板。")
    assert.ok((current.preparationRender?.since_ms ?? 0) >= started, "the cause belongs to this attempt")
    assert.deepEqual(current.source, handle, "a template failure never rewrites the source handle")
  } finally { await f.restore() }
})

test("a template restore failure names its cause and the next attempt clears it", async () => {
  const f = setup(["a"])
  const restore = renderOpfs.workflowRestoreTemplatePsd
  renderOpfs.workflowRestoreTemplatePsd = async () => { throw new Error("PSD 模板摘要不匹配，请重新上传模板") }
  try {
    await f.start("runRenderRows", ["a"])
    const failed = peekListingWorkbench().rows[0]!
    assert.equal(f.pins.length, 0, "no slice is planned without a restored template")
    assert.equal(failed.render, "failed")
    assert.equal(failed.log, "PSD 模板摘要不匹配，请重新上传模板")
    assert.equal(failed.preparationRender?.message, "PSD 模板摘要不匹配，请重新上传模板")
    assert.equal(peekListingWorkbench().preparationProgress.render?.failed, 1)
    assert.equal(f.tracks.current.snapshot().render.size, 0)

    renderOpfs.workflowRestoreTemplatePsd = restore
    const retryStarted = Date.now()
    const retry = f.start("runRenderRows", ["a"])
    await tick()
    assert.deepEqual(f.pins.map((pin) => pin.operation), ["slice"])
    // The new attempt's start patch drops the old cause, and the executor
    // (`run-rows.ts`) then streams this attempt's own render entry: waiting
    // for its stage, stamped with this attempt's start.
    const current = peekListingWorkbench().rows[0]!
    assert.notEqual(current.render, "failed", "the new attempt is not failed by the older cause")
    assert.notEqual(current.log, "PSD 模板摘要不匹配，请重新上传模板")
    const { since_ms: since, ...entry } = current.preparationRender ?? { since_ms: 0 }
    assert.deepEqual(
      entry,
      { stage: "render", state: "waiting", message: "等待阶段执行" },
      "the older attempt's cause does not stand in for this one",
    )
    assert.ok(since >= retryStarted, "the render entry belongs to this attempt")
    await f.flush()
    await retry
  } finally {
    renderOpfs.workflowRestoreTemplatePsd = restore
    await f.restore()
  }
})

test("a row sealed while its template restores gets no failure and no retry invitation", async () => {
  const f = setup(["a", "b"])
  const restore = renderOpfs.workflowRestoreTemplatePsd
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  renderOpfs.workflowRestoreTemplatePsd = async () => {
    await gate
    throw new Error("PSD 模板暂时无法读取，请稍后重试切片")
  }
  try {
    const running = f.start("runRenderRows", ["a", "b"])
    const sealed = product("a")
    patchListingWorkbench((current) => ({ productDrafts: {
      ...current.productDrafts,
      a: { ...sealed, lifecycle: { ...sealed.lifecycle, stage: "outcome_unknown" } },
    } }))
    release()
    await running
    const rowById = (id: string) => peekListingWorkbench().rows.find((row) => row.id === id)!
    assert.notEqual(rowById("a").render, "failed", "an Unknown row is not failed by a template it never used")
    assert.equal(rowById("a").preparationRender, undefined)
    assert.equal(rowById("b").render, "failed")
    assert.equal(rowById("b").preparationRender?.message, "PSD 模板暂时无法读取，请稍后重试切片")
    const p = peekListingWorkbench().preparationProgress.render!
    assert.deepEqual([p.settled, p.failed, p.active], [2, 1, false])
    assert.equal(f.tracks.current.snapshot().render.size, 0)
  } finally {
    release()
    renderOpfs.workflowRestoreTemplatePsd = restore
    await f.restore()
  }
})


test("AI-only and guided hooks carry their opening model selection through the batch coordinator", async () => {
  for (const method of ["runAiRows", "runGuidedPreparation"] as const) {
    const f = setup(["a", "b"])
    const listingFetch = globalThis.fetch
    const routing: unknown[] = []
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/prepare")) routing.push(JSON.parse(String(init?.body)).model_routing)
      return listingFetch(input, init)
    }
    try {
      patchListingWorkbench({ modelRouting: { primary_model: "primary", backup_model: "backup" } })
      const run = f.start(method, ["a", "b"])
      patchListingWorkbench({ modelRouting: { primary_model: "later" } })
      await tick()
      await f.flush()
      await run
      assert.deepEqual(routing, [
        { primary_model: "primary", backup_model: "backup" },
        { primary_model: "primary", backup_model: "backup" },
      ])
    } finally { await f.restore() }
  }
})

/** Real Hook callbacks, command adapters and HTTP boundaries. SSR supplies React's
 * refs; these checks cover explicit actions, not mounted effects or rerenders. */
import assert from "node:assert/strict"
import test from "node:test"
import { setImmediate as tick } from "node:timers/promises"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import type { WorkflowDraftView } from "@/bindings/commands"
import { useRowAutosaves } from "../editing/use-row-autosaves"
import type { ListingRow } from "../model/listing-row"
import {
  patchListingWorkbench,
  peekListingWorkbench,
  resetListingWorkbench,
} from "../workbench/listing-workbench-store"
import { cloudRow, product } from "./fixtures"

for (const scope of ["all", "selected"] as const) {
  test(`${scope} row flush persists edits within the write budget`, async () => {
    resetListingWorkbench()
    const ids = Array.from({ length: 5 }, (_, i) => `row-${i}`)
    const selected = scope === "all" ? ids : ids.slice(0, 4)
    const stored = new Map(ids.map((id) => [id, cloudRow(id)]))
    patchListingWorkbench({
      rows: ids.map((id): ListingRow => ({ id, draftId: id, imageName: `${id}.png`,
        status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" })),
      productDrafts: Object.fromEntries(ids.map((id) => [id, product(id)])),
    })
    let hook!: ReturnType<typeof useRowAutosaves>
    function Capture() {
      hook = useRowAutosaves({ schema: product("card").schema })
      return null
    }
    renderToStaticMarkup(createElement(Capture))
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    Object.defineProperty(globalThis, "window", {
      configurable: true, value: { setTimeout, clearTimeout },
    })
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let active = 0
    let peak = 0
    const writes: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = String(input)
      let data: unknown
      if (url.startsWith(`${route("listingIntents")}?`)) data = { items: [] }
      else {
        assert.ok(url.startsWith(`${route("listingRows")}/`), url)
        const id = url.split("/").at(-1)!
        if (init?.method === "PATCH") {
          active += 1
          peak = Math.max(peak, active)
          await held
          active -= 1
          const body = JSON.parse(String(init.body))
          assert.equal(body.draft.values.name.value, `edited-${id}`)
          writes.push(id)
          stored.set(id, { ...stored.get(id)!, revision: 2, view_revision: 2, draft: body.draft })
        }
        data = stored.get(id)
      }
      return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
    }
    let flushing = Promise.resolve(true)
    try {
      for (const id of ids) hook.editRowCell(id, "name", `edited-${id}`)
      flushing = scope === "all" ? hook.flushRowAutosaves() : hook.flushRowsFor(selected)
      await tick()
      assert.equal(active, 3, "only three pending HTTP writes occupy the budget")
      release()
      assert.equal(await flushing, true)
      await tick()
      assert.equal(peak, 3)
      assert.deepEqual(writes.sort(), [...selected].sort())
      assert.equal(hook.pendingRowEdits(), scope === "selected")
      for (const id of selected) {
        assert.deepEqual(peekListingWorkbench().productDrafts[id]!.draft.values.name,
          { kind: "text", value: `edited-${id}` })
      }
    } finally {
      release()
      await flushing
      hook.resetRowAutosaves()
      globalThis.fetch = originalFetch
      if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
      else Reflect.deleteProperty(globalThis, "window")
      resetListingWorkbench()
    }
  })
}

test("duplicate row flushes share one budget slot and cannot starve other rows", async () => {
  resetListingWorkbench()
  const ids = ["row-a", "row-b", "row-c", "row-d"]
  const stored = new Map(ids.map((id) => [id, cloudRow(id)]))
  patchListingWorkbench({
    rows: ids.map((id): ListingRow => ({ id, draftId: id, imageName: id + ".png",
      status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" })),
    productDrafts: Object.fromEntries(ids.map((id) => [id, product(id)])),
  })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema: product("card").schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { setTimeout, clearTimeout },
  })
  let releaseA!: () => void
  const aGate = new Promise<void>((resolve) => { releaseA = resolve })
  let aReachedFetch!: () => void
  const aStarted = new Promise<void>((resolve) => { aReachedFetch = resolve })
  const patches = new Map<string, number>()
  const writes: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    let data: unknown
    if (url.startsWith(`${route("listingIntents")}?`)) data = { items: [] }
    else {
      assert.ok(url.startsWith(`${route("listingRows")}/`), url)
      const id = url.split("/").at(-1)!
      if (init?.method === "PATCH") {
        patches.set(id, (patches.get(id) ?? 0) + 1)
        const body = JSON.parse(String(init.body))
        if (id === "row-a") {
          aReachedFetch()
          await aGate
        }
        writes.push(id)
        const current = stored.get(id)!
        stored.set(id, { ...current, revision: current.revision + 1,
          view_revision: current.view_revision + 1, draft: body.draft })
      }
      data = stored.get(id)
    }
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
  }
  let flushing = Promise.resolve(true)
  try {
    for (const id of ids) hook.editRowCell(id, "name", "edited-" + id)
    // The same row is asked for four times before its first PATCH can settle:
    // a second queue entry per ask would hold all three global slots behind the
    // held row and keep B/C/D away from the fetch boundary entirely.
    void hook.flushRowsFor(["row-a"])
    void hook.flushRowsFor(["row-a"])
    flushing = hook.flushRowAutosaves()
    void hook.flushRowAutosaves()
    await aStarted
    for (let i = 0; i < 5; i += 1) await tick()
    assert.equal(patches.get("row-a"), 1, "duplicate asks issued exactly one PATCH for the held row")
    assert.deepEqual(writes.sort(), ["row-b", "row-c", "row-d"],
      "every other row reached the fetch boundary while row-a was still held")
    releaseA()
    assert.equal(await flushing, true)
    assert.deepEqual(writes.sort(), ids)
    assert.equal(hook.pendingRowEdits(), false)
  } finally {
    releaseA()
    await flushing
    hook.resetRowAutosaves()
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})

test("an edit landing while a row PATCH is held is drained by the shared flush", async () => {
  resetListingWorkbench()
  const id = "row-latest"
  const stored = new Map([[id, cloudRow(id)]])
  patchListingWorkbench({
    rows: [{ id, draftId: id, imageName: id + ".png", status: "pending",
      ai: "idle", render: "idle", upload: "idle", log: "" }],
    productDrafts: { [id]: product(id) },
  })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema: product("card").schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", {
    configurable: true, value: { setTimeout, clearTimeout },
  })
  let releaseFirst!: () => void
  const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve })
  const bodies: string[] = []
  const drafts: WorkflowDraftView["draft"][] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    let data: unknown
    if (url.startsWith(`${route("listingIntents")}?`)) data = { items: [] }
    else {
      const rowId = url.split("/").at(-1)!
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body))
        bodies.push(body.draft.values.name.value)
        drafts.push(body.draft)
        if (bodies.length === 1) await firstHeld
        const current = stored.get(rowId)!
        stored.set(rowId, { ...current, revision: current.revision + 1,
          view_revision: current.view_revision + 1, draft: body.draft })
      }
      data = stored.get(rowId)
    }
    return new Response(JSON.stringify({ data }), { headers: { "Content-Type": "application/json" } })
  }
  let shared = Promise.resolve(true)
  try {
    hook.editRowCell(id, "name", "first")
    shared = hook.flushRowsFor([id])
    const duplicate = hook.flushRowsFor([id])
    await tick()
    assert.deepEqual(bodies, ["first"])
    let resolved: boolean | undefined
    void shared.then((ok) => { resolved = ok })
    await tick()
    assert.equal(resolved, undefined, "the shared flush cannot resolve before the newest edit is written")
    hook.editRowCell(id, "name", "second")
    releaseFirst()
    assert.equal(await shared, true)
    assert.equal(await duplicate, true)
    assert.deepEqual(bodies, ["first", "second"], "the held ticket drained the edit that landed behind it")
    assert.equal(drafts.at(-1)!.values.name!.value, "second", "the newest revision was the one persisted")
    assert.equal(peekListingWorkbench().productDrafts[id]!.draft.values.name!.value, "second")
    assert.equal(peekListingWorkbench().rowSaveStates[id], "saved")
    assert.equal(hook.pendingRowEdits(), false)
  } finally {
    releaseFirst()
    await shared
    hook.resetRowAutosaves()
    globalThis.fetch = originalFetch
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})

test("reversing a pending save survives a lost response and requires confirmation before retry", async () => {
  resetListingWorkbench()
  const initial = product("reversal")
  initial.draft = { ...initial.draft, values: { ...initial.draft.values, name: { kind: "text", value: "A" } } }
  let stored = { ...cloudRow(initial.draft_id), draft: initial.draft }
  patchListingWorkbench({
    productDrafts: { [initial.draft_id]: initial },
    rows: [{ id: "reversal", draftId: initial.draft_id, imageName: "reversal.png", status: "pending", ai: "idle", render: "idle", upload: "idle", log: "" }],
  })
  let hook!: ReturnType<typeof useRowAutosaves>
  function Capture() {
    hook = useRowAutosaves({ schema: product("card").schema })
    return null
  }
  renderToStaticMarkup(createElement(Capture))
  let rejectFirst!: (reason: Error) => void
  const held = new Promise<void>((_resolve, reject) => { rejectFirst = reject })
  let keepMine = false
  let confirmations = 0
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setTimeout, clearTimeout, confirm: () => { confirmations += 1; return keepMine },
  } })
  const previousFetch = globalThis.fetch
  let writes = 0
  globalThis.fetch = async (input, init) => {
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body))
      assert.equal(body.baseRevision, stored.revision)
      stored = { ...stored, draft: body.draft, revision: stored.revision + 1, view_revision: stored.view_revision + 1 }
      if (++writes === 1) await held
    }
    return new Response(JSON.stringify({ data: String(input).includes("/intents") ? { items: [] } : stored }))
  }
  let flushing = Promise.resolve(true)
  try {
    hook.editRowCell(initial.draft_id, "name", "B")
    flushing = hook.flushRowsFor([initial.draft_id])
    await tick()
    assert.equal(stored.draft.values.name!.value, "B")
    hook.editRowCell(initial.draft_id, "name", "A")
    rejectFirst(new Error("save response lost"))
    assert.equal(await flushing, false)
    assert.equal(peekListingWorkbench().productDrafts[initial.draft_id]!.draft.values.name!.value, "A")
    await hook.retryRowSave(initial.draft_id)
    assert.equal(confirmations, 1)
    assert.equal(writes, 1, "cancelling the retry must not write")
    keepMine = true
    await hook.retryRowSave(initial.draft_id)
    flushing = hook.flushRowsFor([initial.draft_id])
    assert.equal(await flushing, true)
    assert.equal(confirmations, 2)
    assert.equal(stored.draft.values.name!.value, "A")
    assert.equal(peekListingWorkbench().productDrafts[initial.draft_id]!.draft.values.name!.value, "A")
    assert.equal(peekListingWorkbench().rowSaveStates[initial.draft_id], "saved")
  } finally {
    rejectFirst(new Error("test cleanup"))
    await flushing
    hook.resetRowAutosaves()
    globalThis.fetch = previousFetch
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
    else Reflect.deleteProperty(globalThis, "window")
    resetListingWorkbench()
  }
})

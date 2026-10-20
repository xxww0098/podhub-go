import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { route } from "@/api/routes"
import { stageFile } from "@/bindings/file-picker"
import type { CategorySchemaView, WorkflowDraftView, WorkflowProductLifecycle } from "@/bindings/commands"
import { listingProjection, listingRow } from "../../../tests/listing-row-fixture"
import { device } from "./prepare/execution-context"
import { createPreparationTracks } from "./prepare/preparation-tracks"
import { importSourcePaths } from "./product-instances"
import { MAX_SOURCE_BATCH } from "./source-batch"
import { useSourceImport } from "./use-source-import"
import {
  listingWorkbenchScope,
  patchListingWorkbench,
  peekListingWorkbench,
  projectListingRows,
  receiveListingProducts,
  resetListingWorkbench,
  type ListingWorkbenchRuntime,
  type ProductEdit,
} from "./workbench/listing-workbench-store"

const CARD_ID = "card-recover"

const SCHEMA = {
  description_category_id: 17027906,
  type_id: 91976,
  language: "zh_hans",
  fetched_at_ms: 0,
  fields: [{ key: "offer_id", label: "货号", group: "基础", editor: "text", required: true, collection: false }],
  complex_groups: [],
} as unknown as CategorySchemaView

const CARD = {
  id: CARD_ID,
  title: "海报卡片",
  storeId: "store-1",
  revision: 2,
  payload: {
    categoryKey: "17027906:91976:zh_hans",
    descriptionCategoryId: 17027906,
    typeId: 91976,
    language: "zh_hans",
    schemaRevision: "rev-1",
    defaults: { values: {}, complex_values: [] },
    aiPrompt: "识图提示词",
    psdTemplateSha256: "template-sha",
    targetStoreId: "store-1",
    aiFieldPolicy: { allowed_field_keys: [], protected_field_keys: [] },
    queue: { paused: false, stopAfterCurrent: false, nextPosition: 0, frozenRowIds: [] },
  },
  updatedAtMs: 0,
}

const LIFECYCLE: WorkflowProductLifecycle = {
  revision: 1,
  view_revision: 1,
  image_total: 0,
  image_completed: 0,
  stage: "awaiting_content",
  ai: "pending",
  media: "pending",
  fields: "dirty",
  images: [],
  failure_log: [],
  ai_candidates: [],
  product_videos: [],
}

async function digest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/** OPFS is browser-only: the stub files nothing but answers the real digest of the bytes. */
function stubDevice(onPut?: (fileName: string) => void) {
  const original = device.putSource
  const puts: string[] = []
  device.putSource = (async (bytes: Uint8Array<ArrayBuffer>, fileName: string) => {
    puts.push(fileName)
    onPut?.(fileName)
    return digest(bytes)
  }) as typeof device.putSource
  return { puts, restore: () => { device.putSource = original } }
}

type Call = { method: string, url: string, body: any }

function recordFetch(reply: (call: Call) => unknown = (call) => {
  throw new Error(`unexpected request ${call.method} ${call.url}`)
}) {
  const previous = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    }
    calls.push(call)
    return new Response(JSON.stringify({ data: reply(call) }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof globalThis.fetch
  return { calls, restore: () => { globalThis.fetch = previous } }
}

/** Card, Schema and create, as the normal import contract answers them. */
function cloudImport(call: Call) {
  if (call.method === "GET" && call.url.startsWith(route("listingCardsById", { id: CARD_ID }))) return CARD
  if (call.method === "GET" && call.url.startsWith(route("catalogSchema"))) return SCHEMA
  assert.equal(`${call.method} ${call.url}`, `POST ${route("listingRows")}`)
  return listingRow({
    id: `row-new-${call.body.source.fileName}`,
    card_id: CARD_ID,
    store_id: call.body.storeId,
    source: { assetId: "", ...call.body.source },
  })
}

function product(id: string, handle: string, lifecycle: Partial<WorkflowProductLifecycle> = {}): WorkflowDraftView {
  return {
    draft_id: id,
    kind: "instance",
    display_name: "",
    parent_card_id: CARD_ID,
    target_store_id: "store-1",
    schema: SCHEMA,
    draft: { values: { offer_id: { kind: "text", value: id } }, complex_values: [] },
    issues: [],
    lifecycle: {
      ...LIFECYCLE,
      source_asset_handle: handle,
      source_file_name: handle.slice(handle.indexOf("/") + 1),
      ...lifecycle,
    },
  } as unknown as WorkflowDraftView
}

/** The open Card's loaded rows, as the card stream delivers them: no local source yet. */
function seed(products: WorkflowDraftView[], runtime: Partial<ListingWorkbenchRuntime> = {}) {
  resetListingWorkbench()
  patchListingWorkbench({ cardId: CARD_ID })
  receiveListingProducts(
    products.map((item) => ({ product: item, readiness: listingProjection().readiness })),
    new Set(),
    listingWorkbenchScope(),
  )
  patchListingWorkbench(runtime)
}

function pick(bytes: number[], name: string): string {
  return stageFile(new File([new Uint8Array(bytes)], name, { type: "image/jpeg" }))
}

/** SSR supplies Hook refs; the real import action runs, no mounted effects are claimed. */
function sourceImport(flushAutosave: () => Promise<boolean>) {
  let hook!: ReturnType<typeof useSourceImport>
  function Capture() {
    hook = useSourceImport({
      cardTemplateId: CARD_ID,
      schema: SCHEMA,
      boundStoreIds: ["store-1"],
      customStoreQuotas: {},
      preparationTracks: { current: createPreparationTracks() },
      flushAutosave,
      setBusy: () => undefined,
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  return hook
}

const BYTES_A = [1, 2, 3]
const BYTES_NEW = [7, 7, 7]

test("re-picking a missing source restores every exact row with zero HTTP, even on a full, queued, unsaved card", async () => {
  const handleA = `${await digest(new Uint8Array(BYTES_A))}/poster-a.jpg`
  const unknown = product("row-unknown", handleA, { stage: "outcome_unknown" })
  const prepared = product("row-prepared", handleA, {
    stage: "ready_to_publish",
    ai: "ready",
    media: "ready",
    images: [{ index: 0, file_name: "slice.jpg", content_hash: "sha256:slice", group_name: "主图", width: 900, height: 1200, phase: "public_ready" }],
  })
  const other = product("row-other", `${await digest(new Uint8Array([9]))}/poster-b.jpg`)
  const fillers = Array.from({ length: MAX_SOURCE_BATCH - 3 }, (_, index) =>
    product(`row-filler-${index}`, `filler-${index}/filler-${index}.jpg`))
  seed([unknown, prepared, other, ...fillers], { queueRunning: true })
  const edit = { id: 1, base: prepared, view: prepared, fields: {} } as unknown as ProductEdit
  patchListingWorkbench({ selectedIds: ["row-other"], dirtyProducts: { "row-prepared": edit } })
  const before = peekListingWorkbench()
  const opfs = stubDevice()
  const http = recordFetch()
  let flushes = 0
  // A failing autosave would refuse a new import; a restore never asks.
  const hook = sourceImport(async () => { flushes += 1; return false })
  try {
    assert.equal(await hook.importSourceSelection([pick(BYTES_A, "poster-a.jpg")]), true)
    assert.equal(http.calls.length, 0, "a pure restore makes no request")
    assert.equal(flushes, 0, "a pure restore does not flush autosaves")
    assert.deepEqual(opfs.puts, ["poster-a.jpg"], "the file is staged once")
    const after = peekListingWorkbench()
    assert.deepEqual(after.rows.map((row) => row.id), before.rows.map((row) => row.id))
    for (const id of ["row-unknown", "row-prepared"]) {
      const row = after.rows.find((candidate) => candidate.draftId === id)!
      const prior = before.rows.find((candidate) => candidate.draftId === id)!
      assert.deepEqual(row.source, { handle: handleA, file_name: "poster-a.jpg" })
      assert.deepEqual(
        [row.status, row.ai, row.render, row.upload, row.stage, row.candidates],
        [prior.status, prior.ai, prior.render, prior.upload, prior.stage, prior.candidates],
      )
    }
    assert.equal(after.rows.find((row) => row.draftId === "row-other")!.source, undefined)
    assert.equal(after.productBases, before.productBases, "lifecycle, Unknown and media stay untouched")
    assert.equal(after.productDrafts, before.productDrafts)
    assert.equal(after.dirtyProducts, before.dirtyProducts, "dirty edits stay pending")
    assert.deepEqual(after.selectedIds, ["row-other"], "a restore selects nothing to prepare")
    assert.equal(after.queueRunning, true)
    assert.equal(after.productBases["row-unknown"]!.lifecycle.stage, "outcome_unknown")

    // The same file again reuses the valid source; a new file is held by the
    // running queue and full card, not filed.
    assert.equal(
      await hook.importSourceSelection([pick(BYTES_A, "poster-a.jpg"), pick(BYTES_NEW, "fresh.jpg")]),
      false,
    )
    assert.equal(http.calls.length, 0)
    assert.equal(flushes, 0)
    assert.equal(peekListingWorkbench().rows, after.rows, "nothing was restored or added")
  } finally {
    http.restore()
    opfs.restore()
    resetListingWorkbench()
  }
})

test("the same name with other bytes, or the same bytes under another name, never restores the old row", async () => {
  const handleA = `${await digest(new Uint8Array(BYTES_A))}/poster-a.jpg`
  seed([product("row-old", handleA)])
  const opfs = stubDevice()
  const http = recordFetch(cloudImport)
  try {
    const result = await importSourcePaths({
      paths: [pick([4, 5, 6], "poster-a.jpg"), pick(BYTES_A, "poster-a-copy.jpg")],
      cardTemplateId: CARD_ID,
      importedLog: "已导入",
      storeResolver: () => "store-1",
    })
    assert.equal(result.restoredRows, 0)
    assert.equal(result.presentFiles, 0)
    assert.equal(peekListingWorkbench().rows.find((row) => row.draftId === "row-old")!.source, undefined)
    // Bounded concurrent creates complete in any order; the order is not the contract.
    const byFileName = (left: { source: { fileName: string } }, right: { source: { fileName: string } }) =>
      left.source.fileName < right.source.fileName ? -1 : left.source.fileName > right.source.fileName ? 1 : 0
    const creates = http.calls.filter((call) => call.method === "POST")
    assert.deepEqual(
      creates.map((call) => call.body).sort(byFileName),
      [
        { cardId: CARD_ID, storeId: "store-1", source: { sha256: await digest(new Uint8Array([4, 5, 6])), fileName: "poster-a.jpg" } },
        { cardId: CARD_ID, storeId: "store-1", source: { sha256: await digest(new Uint8Array(BYTES_A)), fileName: "poster-a-copy.jpg" } },
      ].sort(byFileName),
      "both import normally, as new rows with their own identity",
    )
    assert.equal(result.rows.length, 2)
  } finally {
    http.restore()
    opfs.restore()
    resetListingWorkbench()
  }
})

test("a mixed batch restores its match locally and files only the new file, staging each once", async () => {
  const handleA = `${await digest(new Uint8Array(BYTES_A))}/poster-a.jpg`
  const handleNew = `${await digest(new Uint8Array(BYTES_NEW))}/fresh.jpg`
  seed([product("row-old", handleA)])
  const opfs = stubDevice()
  const http = recordFetch(cloudImport)
  let restoredBeforeFlush: string | undefined
  const hook = sourceImport(async () => {
    restoredBeforeFlush = peekListingWorkbench().rows.find((row) => row.draftId === "row-old")!.source?.handle
    return true
  })
  try {
    assert.equal(await hook.importSourceSelection([pick(BYTES_A, "poster-a.jpg"), pick(BYTES_NEW, "fresh.jpg")]), true)
    assert.equal(restoredBeforeFlush, handleA, "the restore is on the workbench before new files reach Cloud")
    assert.deepEqual([...opfs.puts].sort(), ["fresh.jpg", "poster-a.jpg"])
    assert.deepEqual(
      http.calls.map((call) => call.method === "POST" ? "create"
        : call.url.startsWith(route("catalogSchema")) ? "schema" : "card"),
      ["card", "schema", "create"],
      "only the new file reaches the normal Card / Schema / create contract",
    )
    assert.deepEqual(http.calls[2]!.body, {
      cardId: CARD_ID,
      storeId: "store-1",
      source: { sha256: handleNew.split("/")[0], fileName: "fresh.jpg" },
    })
    const state = peekListingWorkbench()
    assert.deepEqual(state.rows.map((row) => row.draftId), ["row-old", "row-new-fresh.jpg"])
    assert.equal(state.rows[0]!.source?.handle, handleA)
    assert.equal(state.rows[1]!.source?.handle, handleNew)
    assert.deepEqual(state.selectedIds, ["row-new-fresh.jpg"], "only the new row is pre-ticked")
  } finally {
    http.restore()
    opfs.restore()
    resetListingWorkbench()
  }
})

test("a workbench scope change while staging fences both the restore and the create", async () => {
  const handleA = `${await digest(new Uint8Array(BYTES_A))}/poster-a.jpg`
  seed([product("row-old", handleA)])
  let reopened = false
  // The operator reopens the Card while the first file is still staging.
  const opfs = stubDevice(() => {
    if (reopened) return
    reopened = true
    seed([product("row-old", handleA)])
  })
  const http = recordFetch()
  try {
    const result = await importSourcePaths({
      paths: [pick(BYTES_A, "poster-a.jpg"), pick(BYTES_NEW, "fresh.jpg")],
      cardTemplateId: CARD_ID,
      importedLog: "已导入",
    })
    assert.equal(http.calls.length, 0, "no Card read or create for the old scope")
    assert.equal(result.restoredRows, 0)
    assert.equal(result.rows.length, 0)
    assert.equal(result.cancelled, 2)
    assert.equal(peekListingWorkbench().rows[0]!.source, undefined, "the new scope's row is not patched")
  } finally {
    http.restore()
    opfs.restore()
    resetListingWorkbench()
  }
})

test("restoring a row does not relabel a row that already showed the source", async () => {
  const handleA = `${await digest(new Uint8Array(BYTES_A))}/poster-a.jpg`
  seed([product("row-shown", handleA), product("row-missing", handleA)])
  projectListingRows((rows) => rows.map((row) => row.draftId === "row-shown"
    ? { ...row, source: { handle: handleA, file_name: "poster-a.jpg" }, log: "已恢复 · awaiting_content" }
    : row))
  const shown = peekListingWorkbench().rows.find((row) => row.draftId === "row-shown")
  const opfs = stubDevice()
  const http = recordFetch()
  try {
    const result = await importSourcePaths({
      paths: [pick(BYTES_A, "poster-a.jpg"), pick(BYTES_A, "poster-a.jpg")],
      cardTemplateId: CARD_ID,
      importedLog: "已导入",
    })
    assert.equal(http.calls.length, 0)
    assert.equal(result.restoredRows, 1, "the one missing row, counted once for a file picked twice")
    assert.equal(result.presentFiles, 1)
    assert.equal(result.rows.length, 0)
    const rows = peekListingWorkbench().rows
    assert.equal(rows.find((row) => row.draftId === "row-shown"), shown)
    assert.equal(rows.find((row) => row.draftId === "row-missing")!.source?.handle, handleA)
  } finally {
    http.restore()
    opfs.restore()
    resetListingWorkbench()
  }
})

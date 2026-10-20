import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowDraftView } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { patchListingWorkbench, resetListingWorkbench } from "../workbench/listing-workbench-store"
import { prepareRowSaveRetry } from "./use-row-autosaves"

const DRAFT = "draft-A"
const ROW: ListingRow = {
  id: "A", draftId: DRAFT, imageName: "A.png", status: "pending",
  ai: "idle", render: "idle", upload: "idle", log: "",
}
const VIEW = {
  draft_id: DRAFT,
  lifecycle: { view_revision: 1 },
  draft: { values: {}, complex_values: [] },
} as unknown as WorkflowDraftView

/** One retry with every Cloud request and conflict prompt counted. */
async function retry() {
  const requests: string[] = []
  let prompts = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requests.push(String(input))
    throw new Error("a retry with nothing to save never reaches Cloud")
  }) as typeof fetch
  try {
    const edit = await prepareRowSaveRetry(DRAFT, () => {
      prompts += 1
      return true
    })
    return { edit, requests, prompts }
  } finally {
    globalThis.fetch = previousFetch
    resetListingWorkbench()
  }
}

test("a retry on a row without a local edit makes no request", async () => {
  resetListingWorkbench()
  patchListingWorkbench({ rows: [ROW], productDrafts: { [DRAFT]: VIEW } })
  assert.deepEqual(await retry(), { edit: undefined, requests: [], prompts: 0 })
})

test("a retry on an edit whose Product Instance is gone makes no request", async () => {
  resetListingWorkbench()
  patchListingWorkbench({
    rows: [ROW],
    dirtyProducts: { [DRAFT]: { id: 1, base: VIEW, view: VIEW, fields: new Set<`values.${string}`>(["values.name"]) } },
  })
  assert.deepEqual(await retry(), { edit: undefined, requests: [], prompts: 0 })
})

test("a retry on an unknown draft makes no request", async () => {
  resetListingWorkbench()
  patchListingWorkbench({ rows: [{ ...ROW, id: "B", draftId: "draft-B" }] })
  assert.deepEqual(await retry(), { edit: undefined, requests: [], prompts: 0 })
})

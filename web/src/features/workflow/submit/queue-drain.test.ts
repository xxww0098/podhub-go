import { listingProjection } from "../../../../tests/listing-row-fixture"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import type { RowStage } from "@/bindings/commands"
import { rowStatusView } from "../model/row-state"
import type { ListingRow } from "../model/listing-row"
import {
  listingWorkbenchScope,
  patchListingWorkbench,
  peekListingWorkbench,
  receiveListingProducts,
  resetListingWorkbench,
  type ListingWorkbenchRuntime,
} from "../workbench/listing-workbench-store"
import { cloudRow, product } from "../cloud-fanout-tests/fixtures"
import { cohortInFlight, queueDrained, watchQueueDrain } from "./queue-drain"

function streamed(id: string, stage: RowStage, viewRevision: number) {
  const status = rowStatusView({
    ...cloudRow(id), revision: viewRevision, view_revision: viewRevision,
    projection: listingProjection({ stage }),
  })
  return {
    product: { ...product(id), lifecycle: status.lifecycle, updated_at_ms: viewRevision },
    readiness: status.readiness,
  }
}

function seed(ids: readonly string[], stage: "queued" | "submitting", queueRunning = true) {
  resetListingWorkbench()
  const rows: ListingRow[] = ids.map((id) => ({
    id, draftId: id, imageName: `${id}.png`, status: "running", stage,
    ai: "done", render: "done", upload: "done", log: "",
  }))
  patchListingWorkbench({
    cardId: "card",
    queueRunning,
    queuePaused: false,
    rows,
    productDrafts: Object.fromEntries(ids.map((id) => [id, streamed(id, stage, 1).product])),
  })
}

/** Same expression as the send queue's refresh: a held flight still counts as running. */
function rederive(held: () => boolean) {
  const calls: number[] = []
  const stop = watchQueueDrain((scope) => {
    calls.push(scope)
    patchListingWorkbench((current) => ({
      queueRunning: held() || cohortInFlight(current),
    }), scope)
  })
  return { calls, stop }
}

function stageOf(id: string) {
  return peekListingWorkbench().productBases[id]?.lifecycle.stage
}

test("the queue stops once the last queued row is accepted", () => {
  seed(["a", "b"], "queued")
  const watch = rederive(() => false)
  try {
    const scope = listingWorkbenchScope()
    receiveListingProducts([streamed("a", "accepted", 2)], new Set(), scope)
    assert.equal(peekListingWorkbench().queueRunning, true, "a sibling is still queued")
    assert.deepEqual(watch.calls, [])
    receiveListingProducts([streamed("b", "accepted", 2)], new Set(), scope)
    assert.equal(peekListingWorkbench().queueRunning, false)
    assert.equal(stageOf("a"), "accepted")
    assert.equal(stageOf("b"), "accepted")
    assert.equal(peekListingWorkbench().rows.every((row) => row.stage === "accepted"), true)
    assert.deepEqual(watch.calls, [scope])
  } finally {
    watch.stop()
    resetListingWorkbench()
  }
})

test("opening a card does not treat unloaded rows as a drained cohort", () => {
  resetListingWorkbench()
  patchListingWorkbench({ cardId: "card", queueRunning: true, rows: [] })
  const watch = rederive(() => false)
  try {
    receiveListingProducts([streamed("a", "accepted", 1)], new Set(), listingWorkbenchScope())
    assert.deepEqual(watch.calls, [])
    assert.equal(peekListingWorkbench().queueRunning, true)
    assert.equal(stageOf("a"), "accepted")
  } finally {
    watch.stop()
    resetListingWorkbench()
  }
})

test("a held publish flight keeps the queue running across the empty edge", () => {
  seed(["a"], "submitting")
  let held = true
  const watch = rederive(() => held)
  try {
    receiveListingProducts([streamed("a", "accepted", 2)], new Set(), listingWorkbenchScope())
    assert.equal(watch.calls.length, 1)
    assert.equal(peekListingWorkbench().queueRunning, true)
    assert.equal(stageOf("a"), "accepted")
    held = false
    patchListingWorkbench({ cardName: "still open" })
    assert.equal(watch.calls.length, 1, "dropping the hold is not a second empty edge")
    assert.equal(peekListingWorkbench().queueRunning, true)
  } finally {
    watch.stop()
    resetListingWorkbench()
  }
})

test("queue drain boundaries stay on this card's in-flight cohort", () => {
  seed(["a"], "queued")
  const watch = rederive(() => false)
  try {
    const scope = listingWorkbenchScope()
    receiveListingProducts([streamed("a", "submitting", 2)], new Set(), scope)
    assert.deepEqual(watch.calls, [], "queued to submitting is still in flight")
    assert.equal(peekListingWorkbench().queueRunning, true)

    patchListingWorkbench({ queueRunning: false })
    receiveListingProducts([streamed("a", "accepted", 3)], new Set(), scope)
    assert.deepEqual(watch.calls, [], "an idle queue is not re-derived")
    assert.equal(stageOf("a"), "accepted")
    assert.equal(peekListingWorkbench().queueRunning, false)
  } finally {
    watch.stop()
    resetListingWorkbench()
  }

  seed(["a"], "submitting")
  patchListingWorkbench({ queuePaused: true })
  const removal = rederive(() => false)
  try {
    receiveListingProducts([], new Set(["a"]), listingWorkbenchScope())
    assert.equal(removal.calls.length, 1)
    assert.equal(peekListingWorkbench().queueRunning, false)
    assert.equal(peekListingWorkbench().queuePaused, true, "pause is the card document, not this flag")
    assert.equal(peekListingWorkbench().rows.length, 0)
  } finally {
    removal.stop()
    resetListingWorkbench()
  }

  const submitting = (stage: string) => ({ lifecycle: { stage } }) as ListingWorkbenchRuntime["productBases"][string]
  const row = { draftId: "a" } as ListingRow
  const snapshot = (
    partial: Pick<ListingWorkbenchRuntime, "scope" | "cardId" | "queueRunning" | "rows" | "productBases">,
  ): ListingWorkbenchRuntime => partial as unknown as ListingWorkbenchRuntime
  const previous = snapshot({
    scope: 1, cardId: "card", queueRunning: true, rows: [row],
    productBases: { a: submitting("submitting") },
  })
  const emptied = snapshot({
    ...previous,
    productBases: { a: submitting("accepted") },
  })
  assert.equal(queueDrained(previous, emptied), true)
  assert.equal(queueDrained({ ...previous, rows: [] }, emptied), false, "unloaded rows are not a cohort")
  assert.equal(queueDrained(previous, { ...emptied, cardId: "other" }), false)
  assert.equal(queueDrained(previous, { ...emptied, scope: 2 }), false)
  assert.equal(queueDrained(previous, { ...emptied, queueRunning: false }), false)
  assert.equal(cohortInFlight(emptied), false)
  assert.equal(cohortInFlight(previous), true)
})

test("the mounted send queue watches the workbench for that empty edge", () => {
  const source = readFileSync(new URL("./use-publish-queue.ts", import.meta.url), "utf8")
  assert.match(source, /watchQueueDrain\(\(scope\) => refreshQueue\.current\(scope\)\)/)
  assert.match(source, /held \|\| cohortInFlight\(current\)/)
})

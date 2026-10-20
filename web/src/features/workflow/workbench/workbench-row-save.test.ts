import assert from "node:assert/strict"
import test from "node:test"
import { listingProjection } from "../../../../tests/listing-row-fixture"
import { persistRowEdit } from "../batch-actions"
import { writeWorkflowValue } from "../workflow-draft"
import { instance, row } from "./workbench-test-fixtures"
import { cloudRow, installFetch, routes } from "./workbench-test-harness"

// ---------------------------------------------------------------------------
// One edited cell → save, then mark
// ---------------------------------------------------------------------------

test("an authoring save preserves another operator's unrelated field and rejects their same-field edit", async () => {
  const target = row(1)
  const baseline = instance(target)
  baseline.draft.values.name = { kind: "text", value: "original" }
  baseline.draft.values.price = { kind: "text", value: "100" }
  const edited = { ...baseline, draft: writeWorkflowValue(baseline.draft, "name", { kind: "text", value: "my title" }) }
  let current: import("@/bindings/listing-projection").ListingRowView = cloudRow(target.draftId, {
    revision: 12,
    draft: writeWorkflowValue(baseline.draft, "price", { kind: "text", value: "200" }),
  })
  const previous = globalThis.fetch
  installFetch((call) => {
    if (call.method === "PATCH") {
      assert.equal(call.body.baseRevision, current.revision)
      current = { ...current, revision: current.revision + 1, draft: call.body.draft }
    }
    return current
  })
  try {
    const saved = await persistRowEdit(edited, baseline)
    assert.equal(saved.saved.draft.values.price?.value, "200")
    assert.equal(saved.saved.draft.values.name?.value, "my title")
    current = { ...current, revision: 14, draft: writeWorkflowValue(current.draft, "name", { kind: "text", value: "their newer title" }) }
    await assert.rejects(persistRowEdit(edited, baseline), /冲突/)
    assert.equal(current.draft.values.name?.value, "their newer title")
  } finally {
    globalThis.fetch = previous
  }
})

test("an edited cell is saved to that row's Product Instance before the field verdict is dropped", async () => {
  const target = row(1)
  const baseline = instance(target)
  const edited = structuredClone(baseline)
  edited.draft.values.name = { kind: "text", value: "手改的名称" }
  const reads = installFetch((call) =>
    cloudRow(target.draftId, {
      revision: call.method === "GET" ? 3 : 4,
      validation_state: "stale",
      projection: listingProjection({ stage: "build_stale", fields: "dirty" }),
      draft: call.method === "GET" ? { values: {}, complex_values: [] } : call.body.draft,
    }),
  )

  const result = await persistRowEdit(edited, baseline)

  // Read then write: the read supplies `baseRevision`, and there is no second
  // "mark changed" call — `PATCH rows/{id}` with a `draft` re-validates inside
  // the one CAS and answers with the row it wrote, verdict included.
  assert.deepEqual(routes(reads), [
    `GET /api/listing/rows/${target.draftId}`,
    `PATCH /api/listing/rows/${target.draftId}`,
  ])
  const write = reads[1]!.body
  assert.equal(write.baseRevision, 3)
  assert.deepEqual(write.draft.values.name, { kind: "text", value: "手改的名称" })
  assert.equal(result.saved.draft_id, target.draftId)
  assert.equal(result.status.lifecycle.fields, "dirty")
  assert.equal(result.status.lifecycle.revision, 4, "the lifecycle is the written row's, not the read's")
})

test("a failed save never reports a field change that did not happen", async () => {
  const target = row(1)
  const previous = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) =>
    (init?.method ?? "GET") === "GET"
      ? new Response(JSON.stringify({ data: cloudRow(target.draftId) }), { status: 200 })
      : new Response(JSON.stringify({ error: "队列锁定", code: "conflict" }), {
          status: 409,
        })) as typeof globalThis.fetch
  try {
    await assert.rejects(persistRowEdit(instance(target), instance(target)), /队列锁定/)
  } finally {
    globalThis.fetch = previous
  }
})

test("a row save moves an editable row through Cloud's store CAS", async () => {
  const target = row(1)
  const moved = { ...instance(target), target_store_id: "store-2" }
  const reads = installFetch((call) =>
    cloudRow(target.draftId, {
      store_id: call.method === "PATCH" ? "store-2" : "store-1",
      revision: call.method === "PATCH" ? 4 : 3,
    }),
  )

  const saved = await persistRowEdit(moved, instance(target))
  assert.equal(saved.saved.target_store_id, "store-2")
  assert.deepEqual(routes(reads), [
    `GET /api/listing/rows/${target.draftId}`,
    `PATCH /api/listing/rows/${target.draftId}`,
  ])
  assert.equal(reads[1]!.body.storeId, "store-2")
})

test("a concurrent background write is rebased once through the row CAS", async () => {
  const target = row(1)
  const baseline = instance(target)
  const edited = { ...baseline, draft: writeWorkflowValue(baseline.draft, "name", { kind: "text", value: "my title" }) }
  let current: import("@/bindings/listing-projection").ListingRowView = cloudRow(target.draftId, { revision: 1, draft: baseline.draft })
  let raced = false
  const previous = globalThis.fetch
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "PATCH") {
      if (!raced) {
        raced = true
        current = { ...current, revision: 2, draft: writeWorkflowValue(current.draft, "price", { kind: "text", value: "200" }) }
        return new Response(JSON.stringify({ code: "conflict", error: "revision changed" }), { status: 409 })
      }
      const body = JSON.parse(String(init.body))
      if (body.baseRevision !== current.revision) return new Response("{}", { status: 409 })
      current = { ...current, revision: 3, draft: body.draft }
    }
    return new Response(JSON.stringify({ data: current }), { status: 200 })
  }) as typeof fetch
  try {
    const saved = await persistRowEdit(edited, baseline)
    assert.equal(saved.saved.draft.values.name?.value, "my title")
    assert.equal(saved.saved.draft.values.price?.value, "200")
  } finally {
    globalThis.fetch = previous
  }
})


test("a same-length complex-item reorder conflicts instead of merging by array index", async () => {
  const target = row(1)
  const baseline = instance(target)
  baseline.draft.complex_values = [{ complex_id: 7, items: [
    { values: { name: { kind: "text", value: "first" } } },
    { values: { name: { kind: "text", value: "second" } } },
  ] }]
  const edited = structuredClone(baseline)
  edited.draft.complex_values[0]!.items[0]!.values.description = { kind: "text", value: "my first-item note" }
  const current = cloudRow(target.draftId, { revision: 12, draft: {
    ...baseline.draft,
    complex_values: [{ complex_id: 7, items: [...baseline.draft.complex_values[0]!.items].reverse() }],
  } })
  const previous = globalThis.fetch
  const calls = installFetch(() => current)
  try {
    await assert.rejects(persistRowEdit(edited, baseline), /complex_values.*冲突/)
    assert.equal(calls.some((call) => call.method === "PATCH"), false)
  } finally {
    globalThis.fetch = previous
  }
})

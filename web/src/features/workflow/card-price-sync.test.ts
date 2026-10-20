import assert from "node:assert/strict"
import test from "node:test"
import type {
  WorkflowAiPhase,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  RowStage,
} from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import {
  syncCardFieldToRows,
  type CardFieldSyncDeps,
  type FieldEqualityEditor,
} from "./card-price-sync"

type RowSpec = {
  id?: string
  revision?: number
  price?: string
  cleared?: string[]
  handEdited?: string[]
  stage?: RowStage
  ai?: WorkflowAiPhase
}

function fakeRow(spec: RowSpec): ListingRowView {
  const draft: WorkflowCategoryDraft = {
    values:
      spec.price === undefined
        ? {}
        : { price: { kind: "text", value: spec.price } },
    complex_values: [],
    ...(spec.cleared ? { cleared: spec.cleared } : {}),
  }
  return {
    id: spec.id ?? "row-1",
    card_id: "card-1",
    revision: spec.revision ?? 1,
    view_revision: spec.revision ?? 1,
    updated_at_ms: 0,
    draft,
    payload: { handEditedKeys: spec.handEdited ?? [] },
    store_id: "store-1",
    submission_state: "none",
    content_state: "draft",
    media_state: "pending",
    validation_state: "draft",
    validation_issues: [],
    ai: {},
    media: {},
    source: {},
    projection: {
      stage: spec.stage ?? "awaiting_content",
      ai: spec.ai ?? "pending",
      media: "pending",
      image_total: 0,
      image_completed: 0,
      fields: "dirty",
      readiness: {
        allowed_actions: [],
        blockers: [],
        can_start_publish_attempt: false,
        ready_to_publish: false,
      },
      current_issue_status: "absent",
      can_resume: false,
      submission_receipt_status: "absent",
    },
    build: { state: "stale", sources: [] },
  } as ListingRowView
}

type PatchCall = { rowId: string; body: Record<string, unknown> }

/** Answers recorded from `workflow_values_equal`. This file does not own a second rule. */
async function injectedSemanticFixture(
  editor: FieldEqualityEditor,
  left: WorkflowDraftValue | undefined,
  right: WorkflowDraftValue | undefined,
): Promise<boolean> {
  if (left === undefined || right === undefined) return left === right
  if (editor === "dictionary") {
    return dictionaryIds(left) === dictionaryIds(right)
  }
  if (editor === "decimal" || editor === "integer") {
    const leftNumber = Number(scalarText(left))
    const rightNumber = Number(scalarText(right))
    return Number.isFinite(leftNumber) && leftNumber === rightNumber
  }
  return scalarText(left) === scalarText(right)
}

function dictionaryIds(value: WorkflowDraftValue): string {
  if (value.kind === "single_select") return String(value.value.dictionary_value_id)
  if (value.kind === "multi_select") {
    return value.value
      .map((item) => item.dictionary_value_id)
      .sort((left, right) => left - right)
      .join(",")
  }
  return ""
}

function scalarText(value: WorkflowDraftValue): string {
  if (value.kind === "text" || value.kind === "url") return value.value.trim()
  if (value.kind === "decimal" || value.kind === "integer" || value.kind === "boolean") {
    return String(value.value)
  }
  return ""
}

function depsFor(
  rows: ListingRowView[],
  patch?: (call: PatchCall) => Promise<ListingRowView>,
) {
  const calls: PatchCall[] = []
  const byId = new Map(rows.map((row) => [row.id, row]))
  const deps: CardFieldSyncDeps = {
    cardRows: async () => rows,
    readListingRow: async (rowId) => {
      const row = byId.get(rowId)
      assert.ok(row, `readListingRow(${rowId}) 的行必须存在`)
      return row
    },
    patchListingRow: async (rowId, body) => {
      calls.push({ rowId, body })
      const row = byId.get(rowId)
      assert.ok(row, `patchListingRow(${rowId}) 的行必须存在`)
      if (patch) return patch({ rowId, body })
      return row
    },
    valuesEqual: injectedSemanticFixture,
  }
  return { calls, deps }
}

test("未标记的行继续继承卡价，不被写", async () => {
  const rows = [fakeRow({ id: "a", price: "22" })]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 0, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 0)
})

test("手改过的行被卡价盖回", async () => {
  const rows = [
    fakeRow({ id: "a", price: "22", handEdited: ["price"] }),
    fakeRow({ id: "b", price: "22" }),
  ]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.rowId, "a")
  assert.equal(calls[0]!.body.baseRevision, 1)
  const draft = calls[0]!.body.draft as WorkflowCategoryDraft
  assert.deepEqual(draft.values.price, { kind: "decimal", value: 2 })
})

test("被清掉的行在卡价回填时恢复", async () => {
  const rows = [fakeRow({ id: "a", cleared: ["price"] })]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  const draft = calls[0]!.body.draft as WorkflowCategoryDraft
  assert.deepEqual(draft.values.price, { kind: "decimal", value: 2 })
  assert.ok(!(draft.cleared ?? []).includes("price"))
})

test("卡价清空时手改行被清掉", async () => {
  const rows = [fakeRow({ id: "a", price: "22", handEdited: ["price"] })]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "price", undefined, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  const draft = calls[0]!.body.draft as WorkflowCategoryDraft
  assert.ok(!("price" in draft.values))
  assert.ok((draft.cleared ?? []).includes("price"))
})

test("手改行的值已与卡价一致时跳过", async () => {
  const rows = [fakeRow({ id: "a", price: "2", handEdited: ["price"] })]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 0, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 0)
})

test("发送中与已封板的行不动", async () => {
  const rows = [
    fakeRow({ id: "a", price: "22", handEdited: ["price"], stage: "submitting" }),
    fakeRow({ id: "b", price: "22", handEdited: ["price"], stage: "queued" }),
    fakeRow({ id: "c", price: "22", handEdited: ["price"], stage: "accepted" }),
    fakeRow({ id: "d", price: "22", handEdited: ["price"], stage: "accepted" }),
  ]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 0, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 0)
})

test("划线价只写 old_price", async () => {
  const rows = [fakeRow({ id: "a", price: "30", handEdited: ["old_price"] })]
  const { calls, deps } = depsFor(rows)
  const result = await syncCardFieldToRows("card-1", "old_price", { kind: "decimal", value: 36 }, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  const draft = calls[0]!.body.draft as WorkflowCategoryDraft
  assert.deepEqual(draft.values.old_price, { kind: "decimal", value: 36 })
  assert.deepEqual(draft.values.price, { kind: "text", value: "30" })
})

test("CAS 冲突重读一次再写", async () => {
  const stale = fakeRow({ id: "a", revision: 1, price: "22", handEdited: ["price"] })
  const fresh = fakeRow({ id: "a", revision: 2, price: "22", handEdited: ["price"] })
  const rows = [stale]
  let attempts = 0
  const { calls, deps } = depsFor(rows, async () => {
    attempts += 1
    if (attempts === 1) {
      const error = new Error("conflict") as Error & { status: number }
      error.status = 409
      throw error
    }
    return fresh
  })
  const byId = new Map([[stale.id, fresh]])
  deps.readListingRow = async (rowId) => byId.get(rowId)!
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.body.baseRevision, 2)
})

test("第二次仍冲突记为失败", async () => {
  const rows = [fakeRow({ id: "a", price: "22", handEdited: ["price"] })]
  const { deps } = depsFor(rows, async () => {
    const error = new Error("conflict") as Error & { status: number }
    error.status = 409
    throw error
  })
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 0, failed: 1, conflicts: 0 })
})

test("主题的卡默认盖回手改行", async () => {
  const picked = {
    kind: "multi_select" as const,
    value: [
      { dictionary_value_id: 1, value: "花卉和植物" },
      { dictionary_value_id: 2, value: "猫" },
    ],
  }
  const before = fakeRow({ id: "a", handEdited: ["attribute_7109"] })
  before.draft.values.attribute_7109 = { kind: "multi_select", value: [picked.value[0]!] }
  const { calls, deps } = depsFor([before])
  const result = await syncCardFieldToRows("card-1", "attribute_7109", picked, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  const draft = calls[0]!.body.draft as WorkflowCategoryDraft
  assert.deepEqual(draft.values.attribute_7109, picked)
})

test("主题未手改的行不被写", async () => {
  const picked = {
    kind: "multi_select" as const,
    value: [{ dictionary_value_id: 1, value: "花卉和植物" }],
  }
  const seeded = fakeRow({ id: "a" })
  seeded.draft.values.attribute_7109 = { kind: "multi_select", value: [] }
  const { calls, deps } = depsFor([seeded])
  const result = await syncCardFieldToRows("card-1", "attribute_7109", picked, deps)
  assert.deepEqual(result, { updated: 0, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 0)
})

test("富内容清空时手改行被清掉", async () => {
  const row = fakeRow({ id: "a", handEdited: ["attribute_11254"] })
  row.draft.values.attribute_11254 = { kind: "text", value: "{\"content\":[]}" }
  const { calls, deps } = depsFor([row])
  const result = await syncCardFieldToRows("card-1", "attribute_11254", undefined, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  const draft = calls[0]!.body.draft as WorkflowCategoryDraft
  assert.ok(!("attribute_11254" in draft.values))
  assert.ok((draft.cleared ?? []).includes("attribute_11254"))
})

test("409 后最新值仍是原值时只再 PATCH 一次，且只改目标字段", async () => {
  const stale = fakeRow({ id: "a", revision: 1, price: "22", handEdited: ["price"] })
  const fresh = fakeRow({ id: "a", revision: 4, price: "22", handEdited: ["price"] })
  fresh.draft.values.name = { kind: "text", value: "keep" }
  let attempts = 0
  const { calls, deps } = depsFor([stale], async () => {
    attempts += 1
    if (attempts === 1) {
      const error = new Error("conflict") as Error & { status: number }
      error.status = 409
      throw error
    }
    return fresh
  })
  deps.readListingRow = async () => fresh
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.body.baseRevision, 4)
  const draft = calls[1]!.body.draft as WorkflowCategoryDraft
  assert.deepEqual(draft.values.price, { kind: "decimal", value: 2 })
  assert.deepEqual(draft.values.name, { kind: "text", value: "keep" })
})

test("409 后最新值已是目标时不再 PATCH", async () => {
  const stale = fakeRow({ id: "a", revision: 1, price: "22", handEdited: ["price"] })
  const fresh = fakeRow({ id: "a", revision: 3, price: "2", handEdited: ["price"] })
  const { calls, deps } = depsFor([stale], async () => {
    const error = new Error("conflict") as Error & { status: number }
    error.status = 409
    throw error
  })
  deps.readListingRow = async () => fresh
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 1, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 1)
})

test("409 后第三值是字段冲突，不再 PATCH", async () => {
  const stale = fakeRow({ id: "a", revision: 1, price: "22", handEdited: ["price"] })
  const third = fakeRow({ id: "a", revision: 5, price: "99", handEdited: ["price"] })
  const { calls, deps } = depsFor([stale], async () => {
    const error = new Error("conflict") as Error & { status: number }
    error.status = 409
    throw error
  })
  deps.readListingRow = async () => third
  const result = await syncCardFieldToRows("card-1", "price", { kind: "decimal", value: 2 }, deps)
  assert.deepEqual(result, { updated: 0, failed: 0, conflicts: 1 })
  assert.equal(calls.length, 1)
})

test("相同字典 id、不同文案视为相等，不写行", async () => {
  const row = fakeRow({ id: "a", handEdited: ["attribute_7109"] })
  row.draft.values.attribute_7109 = {
    kind: "multi_select",
    value: [{ dictionary_value_id: 5, value: "红" }],
  }
  const { calls, deps } = depsFor([row])
  const result = await syncCardFieldToRows(
    "card-1",
    "attribute_7109",
    { kind: "multi_select", value: [{ dictionary_value_id: 5, value: "Red" }] },
    deps,
  )
  assert.deepEqual(result, { updated: 0, failed: 0, conflicts: 0 })
  assert.equal(calls.length, 0)
})

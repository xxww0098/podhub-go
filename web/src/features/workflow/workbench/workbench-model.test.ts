/**
 * 型号 (Ozon attribute 9048) is its own column and its own batch verbs: the
 * pure half of the split. The durable half — the single-row autosave and the
 * PATCH bodies — is driven in `cloud-fanout-tests/model.test.ts`.
 */
import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowCategoryDraft, WorkflowDraftView } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { planProseColumnFill } from "./workbench-cell-edit"
import { proseCellText } from "./workbench-contract"
import {
  associatedImportedRow,
  effectiveModel,
  independentModel,
  knownModels,
  modelBatchRefusalCopy,
  modelBatchSkipCopy,
  modelField,
  modelText,
  planModelBatch,
  runModelBatch,
  sourceFileStem,
  type ModelBatchRefusal,
} from "./workbench-model"
import { idleLifecycle, instance, row, schema } from "./workbench-test-fixtures"

/** The 型号 field of the shared fixture schema — a live schema names it `attribute_9048`. */
const field = modelField(schema)!

function explicit(
  target: ListingRow,
  model: string,
  lifecycle = idleLifecycle,
): WorkflowDraftView {
  const product = instance(target, lifecycle)
  return {
    ...product,
    draft: {
      ...product.draft,
      values: { ...product.draft.values, [field.key]: { kind: "text", value: model } },
    },
  }
}

function draftsOf(rows: readonly ListingRow[]): Record<string, WorkflowDraftView> {
  return Object.fromEntries(rows.map((entry) => [entry.draftId, instance(entry)]))
}

test("型号 resolves by attribute 9048, wherever the schema placed it", () => {
  assert.equal(field.attribute_id, 9048)
  assert.equal(field.key, "model_name")

  const target = row(1)
  const product = instance(target)
  // Nothing written yet: the row's own 型号 is empty and the file-name stem is
  // what the build would send.
  assert.equal(modelText(product.draft, field), "")
  assert.equal(effectiveModel(target, product.draft, field), "SZ-0001")
  assert.equal(effectiveModel(target, product.draft, field), independentModel(target, product.draft))

  const written = explicit(target, "SZ-ART-01")
  assert.equal(modelText(written.draft, field), "SZ-ART-01")
  assert.equal(effectiveModel(target, written.draft, field), "SZ-ART-01")

  // A live schema has put 9048 inside a complex group; the value then lives on
  // that group's first item, which is where the editor writes it too.
  const complex: WorkflowCategoryDraft = {
    values: {},
    complex_values: [
      { complex_id: 4, items: [{ values: { model_name: { kind: "text", value: "SZ-GROUP" } } }] },
    ],
  }
  assert.equal(modelText(complex, { ...field, complex_id: 4 }), "SZ-GROUP")

  assert.equal(
    modelField({ ...schema, fields: schema.fields.filter((entry) => entry.attribute_id !== 9048) }),
    undefined,
  )
})

test("a row without a model of its own falls back to its file name, then to its 货号", () => {
  assert.equal(sourceFileStem("SZ-0001.png"), "SZ-0001")
  // One extension, like 货号: the same stem `offerIdForSource` gates on import.
  assert.equal(sourceFileStem("  archive.v2.tar.gz "), "archive.v2.tar")

  const named = row(2)
  assert.equal(independentModel(named, instance(named).draft), "SZ-0002")

  // The source file name is gone: the 货号 is still this row's own identity.
  const unnamed = { ...row(3), imageName: "" }
  const product = {
    ...instance(unnamed),
    draft: { values: { offer_id: { kind: "text" as const, value: "PH-ROW-3" } }, complex_values: [] },
  }
  assert.equal(independentModel(unnamed, product.draft), "PH-ROW-3")
})

test("known models are the card's own, in row order, with how many rows carry each", () => {
  const first = row(1)
  const second = row(2)
  const third = row(3)
  const drafts = {
    [first.draftId]: explicit(first, "SZ-ART-01"),
    [second.draftId]: instance(second),
    [third.draftId]: explicit(third, "SZ-ART-01"),
  }
  assert.deepEqual(knownModels([first, second, third], drafts, field), [
    { value: "SZ-ART-01", count: 2 },
    { value: "SZ-0002", count: 1 },
  ])
})

test("the three batch verbs write the selected rows and nothing else", () => {
  const first = row(1)
  const second = row(2)
  const third = row(3)
  const drafts = draftsOf([first, second, third])
  const selected = new Set([first.id, second.id])
  const plan = (mode: "common" | "join" | "independent", value?: string) =>
    planModelBatch({
      rows: [first, second, third],
      productDrafts: drafts,
      selectedRowIds: selected,
      field,
      mode,
      value,
    })

  const common = plan("common", "  SZ-COMMON  ")
  assert.deepEqual(common.writes, [
    { rowId: first.id, draftId: first.draftId, imageName: first.imageName, value: "SZ-COMMON" },
    { rowId: second.id, draftId: second.draftId, imageName: second.imageName, value: "SZ-COMMON" },
  ])
  assert.deepEqual(common.refusals, [])

  assert.deepEqual(
    plan("join", "SZ-ART-01").writes.map((write) => write.value),
    ["SZ-ART-01", "SZ-ART-01"],
  )

  // 恢复独立型号 assigns each row its own value — never a clear the next build
  // would refill from the same file name.
  const independent = plan("independent")
  assert.deepEqual(independent.writes.map((write) => write.value), ["SZ-0001", "SZ-0002"])
  assert.equal(independent.writes.every((write) => write.value.trim().length > 0), true)
})

test("a sealed row and a row without a draft are refused, never silently skipped", () => {
  const open = row(1)
  const sealed = row(2)
  const missing = row(3)
  const plan = planModelBatch({
    rows: [open, sealed, missing],
    productDrafts: {
      [open.draftId]: instance(open),
      [sealed.draftId]: instance(sealed, { ...idleLifecycle, stage: "accepted" }),
    },
    selectedRowIds: new Set([open.id, sealed.id, missing.id]),
    field,
    mode: "common",
    value: "SZ-COMMON",
  })

  assert.deepEqual(plan.writes.map((write) => write.draftId), [open.draftId])
  assert.deepEqual(plan.refusals, [
    { rowId: sealed.id, draftId: sealed.draftId, imageName: sealed.imageName, reason: "sealed" },
    { rowId: missing.id, draftId: missing.draftId, imageName: missing.imageName, reason: "missing" },
  ])
  // One sentence names the failures; a long selection counts the rest instead
  // of growing a toast per row.
  assert.equal(
    modelBatchRefusalCopy(plan.refusals),
    "2 行未写入：SZ-0002.png（已上架）、SZ-0003.png（无草稿）",
  )
  assert.equal(modelBatchSkipCopy(plan.refusals), "1 行已上架、1 行无草稿，未写入")

  const many: ModelBatchRefusal[] = Array.from({ length: 5 }, (_, index) => ({
    rowId: `row-${index}`,
    draftId: `draft-${index}`,
    imageName: `SZ-000${index}.png`,
    reason: "sealed",
  }))
  assert.equal(
    modelBatchRefusalCopy(many),
    "5 行未写入：SZ-0000.png（已上架）、SZ-0001.png（已上架）、SZ-0002.png（已上架） 等 5 行",
  )
  assert.equal(modelBatchRefusalCopy([]), "")
})

test("a batch flushes the related edits, writes only the writable rows and reports once", async () => {
  const open = row(1)
  const sealed = row(2)
  const calls: string[] = []
  const plan = planModelBatch({
    rows: [open, sealed],
    productDrafts: {
      [open.draftId]: instance(open),
      [sealed.draftId]: instance(sealed, { ...idleLifecycle, stage: "accepted" }),
    },
    selectedRowIds: new Set([open.id, sealed.id]),
    field,
    mode: "common",
    value: "SZ-COMMON",
  })

  await runModelBatch({
    plan,
    edit: (draftId, value) => calls.push(`edit ${draftId} ${value}`),
    flush: async (draftIds) => {
      calls.push(`flush ${draftIds.join(",")}`)
      return true
    },
    report: (message) => calls.push(`report ${message}`),
  })

  // The pending edits land first, then the model, then the model lands — and
  // the refused row never rolls the written one back.
  assert.deepEqual(calls, [
    `flush ${open.draftId}`,
    `edit ${open.draftId} SZ-COMMON`,
    `flush ${open.draftId}`,
    `report 1 行未写入：${sealed.imageName}（已上架）`,
  ])
})

test("「填入 N 行」never overwrites a written 型号", () => {
  const written = row(1)
  const inherited = row(2)
  const writtenProduct = explicit(written, "SZ-COMMON")
  const inheritedProduct = instance(inherited)
  const scope = (product: WorkflowDraftView, draftId: string) => {
    const text = proseCellText("model", product, { model: field }).trim()
    return { draftId, writable: true, empty: !text, skip: null }
  }

  assert.equal(proseCellText("model", writtenProduct, { model: field }), "SZ-COMMON")
  // The file-name fallback is not the row's own answer, so an untouched row
  // still counts as empty and the column fill reaches it.
  assert.equal(proseCellText("model", inheritedProduct, { model: field }), "")

  const plan = planProseColumnFill({
    selected: true,
    openedDraftId: written.draftId,
    emptyOnly: true,
    rows: [scope(writtenProduct, written.draftId), scope(inheritedProduct, inherited.draftId)],
  })
  assert.deepEqual(plan.writeDraftIds, [inherited.draftId])
  assert.equal(plan.skip.occupied, 1)
})

test("同源多规格导入的实例由服务端盖的货号认出，普通行不会", () => {
  const imported = row(1)
  // The server stamps 货号 = PH-<rowId> for an associated row, and nothing
  // else writes that exact value; a replay re-derives it from the row id.
  const associated = instance(imported)
  associated.draft.values.offer_id = { kind: "text", value: `PH-${imported.id}` }
  assert.equal(associatedImportedRow(associated.draft, imported.id), true)
  // A 货号 the operator typed is not an associated import, whatever it spells.
  const manual = instance(imported)
  manual.draft.values.offer_id = { kind: "text", value: "ART-001" }
  assert.equal(associatedImportedRow(manual.draft, imported.id), false)
  // No 货号 at all is the ordinary source-stem injection, not an association.
  assert.equal(associatedImportedRow(instance(imported).draft, imported.id), false)
  assert.equal(associatedImportedRow(undefined, imported.id), false)
  // Case is a spelling: the identity is the row id.
  const shouted = instance(imported)
  shouted.draft.values.offer_id = { kind: "text", value: `ph-${imported.id.toUpperCase()}` }
  assert.equal(associatedImportedRow(shouted.draft, imported.id), true)
})

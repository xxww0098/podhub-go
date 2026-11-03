import assert from "node:assert/strict"
import test from "node:test"
import type { WorkflowCategoryDraft } from "@/bindings/commands"
import { changedProductFields, mergeProductEdit, productEditBaseline } from "./product-edit"
import { writeWorkflowValue } from "../workflow-draft"

const empty = (): { draft: WorkflowCategoryDraft; target_store_id: string } => ({
  draft: { values: {}, complex_values: [] }, target_store_id: "store",
})

test("clearing an inherited field is an edit even when the row has no value", () => {
  const base = empty()
  const edited = { ...base, draft: writeWorkflowValue(base.draft, "name", undefined) }
  assert.deepEqual([...changedProductFields(base, edited)], ["values.name"])
  assert.deepEqual(mergeProductEdit(base, edited, base).draft.cleared, ["name"])
})

test("refilling a cleared field removes its marker and keeps unrelated server clears", () => {
  const base = { ...empty(), draft: { ...empty().draft, cleared: ["name"] } }
  const edited = { ...base, draft: writeWorkflowValue(base.draft, "name", { kind: "text", value: "typed" }) }
  const current = { ...base, draft: { ...base.draft, cleared: ["name", "price"] } }
  const merged = mergeProductEdit(base, edited, current)
  assert.deepEqual(merged.draft.cleared, ["price"])
  assert.equal(merged.draft.values.name?.value, "typed")
})

test("a remote clear conflicts with a local fill instead of leaving value and clear together", () => {
  const base = empty()
  const edited = { ...base, draft: writeWorkflowValue(base.draft, "name", { kind: "text", value: "typed" }) }
  const current = { ...base, draft: writeWorkflowValue(base.draft, "name", undefined) }
  assert.throws(() => mergeProductEdit(base, edited, current), /当前已保存内容：已清空/)
})

test("a save acknowledgment advances the clear marker baseline for the next keystroke", () => {
  const base = empty()
  const first = { ...base, draft: writeWorkflowValue(base.draft, "name", undefined) }
  const fields = changedProductFields(base, first)
  const baseline = productEditBaseline(base, first, base, first, fields)
  assert.deepEqual(baseline.draft.cleared, ["name"])
  const next = { ...base, draft: writeWorkflowValue(first.draft, "name", { kind: "text", value: "typed" }) }
  assert.deepEqual(mergeProductEdit(baseline, next, first).draft.values.name, { kind: "text", value: "typed" })
  assert.equal("cleared" in mergeProductEdit(baseline, next, first).draft, false)
  assert.equal("cleared" in productEditBaseline(first, next, first, next).draft, false)
})

test("unrelated edits preserve an absent or empty cleared property", () => {
  for (const draft of [empty().draft, { ...empty().draft, cleared: [] }]) {
    const base = { ...empty(), draft }
    const edited = { ...base, draft: { ...draft, values: { name: { kind: "text" as const, value: "typed" } } } }
    assert.deepEqual(mergeProductEdit(base, edited, base).draft, edited.draft)
    assert.deepEqual(productEditBaseline(base, edited, base).draft, base.draft)
  }
})

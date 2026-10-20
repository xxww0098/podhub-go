/** SKU import: when it is offered, what it says, and how candidates land on the draft. */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SkuImportCandidate } from "../../src/bindings/commands"
import { SkuImportPanel } from "../../src/features/workflow/sku-import-panel"
import {
  applySkuImportCandidates,
  createWorkflowDraft,
  isCategoryDraftBlank,
  writeWorkflowValue,
} from "../../src/features/workflow/workflow-draft"
import { schema } from "./workflow-fixtures"

test("SKU import is available only for a truly blank category draft", () => {
  const blank = createWorkflowDraft(schema)
  assert.equal(isCategoryDraftBlank(schema, blank), true)
  const filled = writeWorkflowValue(blank, "price", { kind: "decimal", value: 90 })
  assert.equal(isCategoryDraftBlank(schema, filled), false)
})

test("filled listing card renders the SKU import entry disabled", () => {
  const markup = renderToStaticMarkup(
    <SkuImportPanel
      blank={false}
      disabled={false}
      onPreview={async () => {
        throw new Error("disabled")
      }}
      onApply={() => undefined}
    />,
  )
  assert.match(markup, /disabled=""/)
  assert.match(markup, /aria-label="输入来源 Ozon SKU"/)
  assert.match(markup, /清空类目字段后才能导入/)
})

test("SKU import copy separates reusable parameters from reference copy", () => {
  const source = readFileSync(
    new URL("../../src/features/workflow/sku-import-panel.tsx", import.meta.url),
    "utf8",
  )

  assert.match(source, /导入可复用参数/)
  assert.match(source, /商品名称只作参考/)
  assert.doesNotMatch(source, /覆盖全部字段|覆盖写入/)
})

test("confirmed SKU import applies every plain and complex candidate at once", () => {
  const candidates = [
    {
      candidate_id: "plain:name",
      field_key: "name",
      field_name: "商品名称",
      group_name: "Fixed",
      location: { kind: "plain" },
      value: { kind: "text", value: "装饰画 40×50" },
    },
    {
      candidate_id: "plain:price",
      field_key: "price",
      field_name: "价格",
      group_name: "Fixed",
      location: { kind: "plain" },
      value: { kind: "decimal", value: 90 },
    },
    {
      candidate_id: "complex:99:1:attr_20",
      field_key: "attr_20",
      field_name: "复杂属性",
      group_name: "复杂属性",
      location: { kind: "complex", complex_id: 99, item_index: 1 },
      value: { kind: "integer", value: 40 },
    },
  ] satisfies SkuImportCandidate[]
  const imported = applySkuImportCandidates(createWorkflowDraft(schema), candidates)
  assert.deepEqual(imported.values.name, { kind: "text", value: "装饰画 40×50" })
  assert.deepEqual(imported.values.price, { kind: "decimal", value: 90 })
  assert.deepEqual(imported.complex_values[0]?.items[1]?.values.attr_20, {
    kind: "integer",
    value: 40,
  })
})

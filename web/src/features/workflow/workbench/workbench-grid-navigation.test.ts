import assert from "node:assert/strict"
import test from "node:test"
import type { CategoryFieldView, CategorySchemaView, WorkflowDraftValue, WorkflowDraftView, WorkflowProductLifecycle } from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import {
  colIndexFor,
  columnAt,
  editableColumnForIndex,
  gridActionFromKey,
  nextGridCoordinate,
  planFillDown,
  readCellRawText,
  type GridCoordinate,
} from "./workbench-grid-navigation"
import { WORKBENCH_COLUMNS } from "./workbench-columns"

test("columnAt and colIndexFor map columns bi-directionally", () => {
  assert.equal(colIndexFor("select"), 0)
  assert.equal(colIndexFor("name"), 3)
  assert.equal(colIndexFor("offer_id"), 4)
  assert.equal(colIndexFor("model"), 5)
  assert.equal(colIndexFor("price"), 6)
  assert.equal(colIndexFor("old_price"), 7)
  assert.equal(colIndexFor("description"), 8)
  assert.equal(colIndexFor("tags"), 9)
  assert.equal(colIndexFor("theme"), 10)
  assert.equal(colIndexFor("rich_content"), 11)
  assert.equal(columnAt(3)?.id, "name")
  assert.equal(columnAt(4)?.id, "offer_id")
  assert.equal(columnAt(5)?.id, "model")
  assert.equal(columnAt(6)?.id, "price")
  assert.equal(columnAt(7)?.id, "old_price")
  assert.equal(columnAt(8)?.id, "description")
  assert.equal(columnAt(9)?.id, "tags")
  assert.equal(columnAt(10)?.id, "theme")
  assert.equal(columnAt(11)?.id, "rich_content")
})

test("editableColumnForIndex accurately identifies editable columns", () => {
  assert.equal(editableColumnForIndex(0), null)
  assert.equal(editableColumnForIndex(1), null)
  assert.equal(editableColumnForIndex(2), null)
  assert.equal(editableColumnForIndex(3), "name")
  // 货号 is re-injected by Rust, 销售价 / 划线价 edit in place and 主题 opens the
  // dictionary picker — none of them is an editor-dialog cell.
  assert.equal(editableColumnForIndex(4), null)
  assert.equal(editableColumnForIndex(5), "model")
  assert.equal(editableColumnForIndex(6), null)
  assert.equal(editableColumnForIndex(7), null)
  assert.equal(editableColumnForIndex(8), "description")
  assert.equal(editableColumnForIndex(9), "tags")
  assert.equal(editableColumnForIndex(10), null)
  assert.equal(editableColumnForIndex(11), "rich_content")
  // The four media role columns start here; none of them is typed into.
  assert.equal(editableColumnForIndex(12), null)
})

test("nextGridCoordinate handles boundary constraints and all directions", () => {
  const rowCount = 5
  const colCount = WORKBENCH_COLUMNS.length

  // Start from null
  assert.deepEqual(nextGridCoordinate(null, "down", rowCount, colCount), { rowIndex: 0, colIndex: 0 })

  const origin: GridCoordinate = { rowIndex: 2, colIndex: 3 }
  assert.deepEqual(nextGridCoordinate(origin, "up", rowCount, colCount), { rowIndex: 1, colIndex: 3 })
  assert.deepEqual(nextGridCoordinate(origin, "down", rowCount, colCount), { rowIndex: 3, colIndex: 3 })
  assert.deepEqual(nextGridCoordinate(origin, "left", rowCount, colCount), { rowIndex: 2, colIndex: 2 })
  assert.deepEqual(nextGridCoordinate(origin, "right", rowCount, colCount), { rowIndex: 2, colIndex: 4 })
  assert.deepEqual(nextGridCoordinate(origin, "home", rowCount, colCount), { rowIndex: 2, colIndex: 0 })
  assert.deepEqual(nextGridCoordinate(origin, "end", rowCount, colCount), { rowIndex: 2, colIndex: colCount - 1 })

  // Clamp at top and left
  const topLeft: GridCoordinate = { rowIndex: 0, colIndex: 0 }
  assert.deepEqual(nextGridCoordinate(topLeft, "up", rowCount, colCount), { rowIndex: 0, colIndex: 0 })
  assert.deepEqual(nextGridCoordinate(topLeft, "left", rowCount, colCount), { rowIndex: 0, colIndex: 0 })

  // Clamp at bottom and right
  const bottomRight: GridCoordinate = { rowIndex: rowCount - 1, colIndex: colCount - 1 }
  assert.deepEqual(nextGridCoordinate(bottomRight, "down", rowCount, colCount), { rowIndex: rowCount - 1, colIndex: colCount - 1 })
  assert.deepEqual(nextGridCoordinate(bottomRight, "right", rowCount, colCount), { rowIndex: rowCount - 1, colIndex: colCount - 1 })
})

test("gridActionFromKey translates keyboard shortcuts properly", () => {
  assert.equal(gridActionFromKey({ key: "ArrowUp" }), "up")
  assert.equal(gridActionFromKey({ key: "ArrowDown" }), "down")
  assert.equal(gridActionFromKey({ key: "ArrowLeft" }), "left")
  assert.equal(gridActionFromKey({ key: "ArrowRight" }), "right")
  assert.equal(gridActionFromKey({ key: " " }), "select-toggle")
  assert.equal(gridActionFromKey({ key: "Enter" }), "open-edit")
  assert.equal(gridActionFromKey({ key: "F2" }), "open-edit")
  assert.equal(gridActionFromKey({ key: "Escape" }), "escape")

  // Modifiers
  assert.equal(gridActionFromKey({ key: "d", metaKey: true }), "fill-down")
  assert.equal(gridActionFromKey({ key: "D", ctrlKey: true }), "fill-down")
  assert.equal(gridActionFromKey({ key: "c", metaKey: true }), "copy")
  assert.equal(gridActionFromKey({ key: "a", metaKey: true }), "select-all")
})

const stubSchema: CategorySchemaView = {
  description_category_id: 1,
  type_id: 1,
  fields: [],
  complex_groups: [],
}

const stubLifecycle: WorkflowProductLifecycle = {
  revision: 1,
  view_revision: 1,
    image_total: 0, image_completed: 0,
  stage: "awaiting_content",
  ai: "ready",
  media: "ready",
  fields: "valid",
  images: [],
  failure_log: [],
  ai_summary: { tags: ["墙面", "装饰"], model: "gpt" },
  ai_candidates: [],
  product_videos: [],
}

function mockRow(id: string, draftId: string, imageName: string): ListingRow {
  return {
    id,
    draftId,
    imageName,
    source: { handle: id, file_name: imageName },
    status: "pending",
    ai: "idle",
    render: "idle",
    upload: "idle",
    log: "",
  }
}

function mockDraft(draftId: string, nameValue: string): WorkflowDraftView {
  return {
    draft_id: draftId,
    kind: "instance",
    parent_card_id: "card-1",
    display_name: nameValue,
    schema: stubSchema,
    draft: {
      values: {
        name: { kind: "text", value: nameValue },
      },
      complex_values: [],
    },
    validation_state: "draft",
    issues: [],
    ai_prompt_id: "prompt-1",
    ai_prompt: "",
    ai_prompt_file_name: "",
    psd_template_asset_id: "",
    psd_template_file_name: "",
    target_store_id: "store-1",
    ai_field_policy: {
      allowed_field_keys: ["name", "description"],
      protected_field_keys: [],
    },
    lifecycle: stubLifecycle,
    updated_at_ms: Date.now(),
  }
}

const mockField: CategoryFieldView = {
  key: "name",
  attribute_id: 100,
  name: "商品名称",
  description: "商品名称",
  group_name: "基本信息",
  source: "attribute",
  editor: "text",
  complex_group_collection: false,
  read_only: false,
  aspect: null,
  constraints: {
    required: true,
    collection: false,
  },
  options: [],
  options_truncated: false,
}

test("planFillDown fills down to selected or subsequent writable rows", () => {
  const rows: ListingRow[] = [
    mockRow("row-1", "draft-1", "img-1.jpg"),
    mockRow("row-2", "draft-2", "img-2.jpg"),
    mockRow("row-3", "draft-3", "img-3.jpg"),
  ]
  const productDrafts: Record<string, WorkflowDraftView> = {
    "draft-1": mockDraft("draft-1", "壁画 A"),
    "draft-2": mockDraft("draft-2", ""),
    "draft-3": mockDraft("draft-3", ""),
  }
  const fields = {
    name: mockField,
  }

  // 1. Fill down from row 0 with no selection -> should target row 1 and row 2
  const plan = planFillDown({
    focusedCell: { rowIndex: 0, colIndex: 3 }, // name column
    rows,
    productDrafts,
    selectedRowIds: new Set(),
    fields,
  })

  assert.ok(plan)
  assert.equal(plan.column, "name")
  assert.equal(plan.sourceValue, "壁画 A")
  assert.deepEqual(plan.targetDraftIds, ["draft-2", "draft-3"])

  // 2. Fill down with explicit selection of row-1 and row-3
  const selectedPlan = planFillDown({
    focusedCell: { rowIndex: 0, colIndex: 3 },
    rows,
    productDrafts,
    selectedRowIds: new Set(["row-1", "row-3"]),
    fields,
  })

  assert.ok(selectedPlan)
  assert.deepEqual(selectedPlan.targetDraftIds, ["draft-1", "draft-3"])
})

test("planFillDown reads a hand-edited price and plans the price column", () => {
  const priceField: CategoryFieldView = {
    ...mockField,
    key: "price",
    name: "销售价",
  }
  const source = mockDraft("draft-1", "")
  source.draft.values.price = { kind: "decimal", value: 1500 }
  source.hand_edited_keys = ["price"]
  const rows = [
    mockRow("row-1", "draft-1", "img-1.jpg"),
    mockRow("row-2", "draft-2", "img-2.jpg"),
  ]

  const plan = planFillDown({
    focusedCell: { rowIndex: 0, colIndex: colIndexFor("price") },
    rows,
    productDrafts: { "draft-1": source, "draft-2": mockDraft("draft-2", "") },
    selectedRowIds: new Set(),
    fields: { price: priceField },
  })

  assert.equal(plan?.column, "price")
  assert.equal(plan?.sourceValue, "1500")
  assert.equal(plan?.field?.key, "price")
  assert.deepEqual(plan?.draftValue, { kind: "decimal", value: 1500 })
  assert.deepEqual(plan?.targetDraftIds, ["draft-2"])
})

test("planFillDown copies the picked theme value to the rows below", () => {
  const themeField: CategoryFieldView = {
    ...mockField,
    key: "attribute_7109",
    attribute_id: 7109,
    name: "主题",
    editor: "multi_select",
  }
  const themeValue: WorkflowDraftValue = {
    kind: "multi_select",
    value: [
      { dictionary_value_id: 101, value: "картина" },
      { dictionary_value_id: 102, value: "море" },
    ],
  }
  const source = mockDraft("draft-1", "")
  source.draft.values.attribute_7109 = themeValue
  // An inherited card-default copy is not the row's own answer: filling down
  // stamps nothing until the operator actually picks a theme on this row.
  const planBefore = planFillDown({
    focusedCell: { rowIndex: 0, colIndex: colIndexFor("theme") },
    rows: [
      mockRow("row-1", "draft-1", "img-1.jpg"),
      mockRow("row-2", "draft-2", "img-2.jpg"),
    ],
    productDrafts: { "draft-1": source, "draft-2": mockDraft("draft-2", "") },
    selectedRowIds: new Set(),
    fields: { theme: themeField },
  })
  assert.equal(planBefore?.draftValue, undefined)

  source.hand_edited_keys = ["attribute_7109"]
  const rows = [
    mockRow("row-1", "draft-1", "img-1.jpg"),
    mockRow("row-2", "draft-2", "img-2.jpg"),
  ]

  const plan = planFillDown({
    focusedCell: { rowIndex: 0, colIndex: colIndexFor("theme") },
    rows,
    productDrafts: { "draft-1": source, "draft-2": mockDraft("draft-2", "") },
    selectedRowIds: new Set(),
    fields: { theme: themeField },
  })

  assert.equal(plan?.column, "theme")
  assert.equal(plan?.field?.key, "attribute_7109")
  assert.deepEqual(plan?.draftValue, themeValue)
  assert.deepEqual(plan?.targetDraftIds, ["draft-2"])
})

test("planFillDown ignores a field column the schema does not carry", () => {
  const rows = [
    mockRow("row-1", "draft-1", "img-1.jpg"),
    mockRow("row-2", "draft-2", "img-2.jpg"),
  ]

  const plan = planFillDown({
    focusedCell: { rowIndex: 0, colIndex: colIndexFor("old_price") },
    rows,
    productDrafts: {
      "draft-1": mockDraft("draft-1", ""),
      "draft-2": mockDraft("draft-2", ""),
    },
    selectedRowIds: new Set(),
    fields: {},
  })

  assert.equal(plan, null)
})

test("the persisted tag field wins over the recognition summary", () => {
  const product = mockDraft("draft-1", "壁画 A")
  const tagsField: CategoryFieldView = {
    ...mockField,
    key: "attribute_23171",
    attribute_id: 23171,
    name: "#主题标签",
  }
  product.schema = { ...product.schema, fields: [tagsField] }
  product.draft.values.attribute_23171 = {
    kind: "text",
    value: "#ручная #правка",
  }

  assert.equal(
    readCellRawText(
      colIndexFor("tags"),
      mockRow("row-1", product.draft_id, "img-1.jpg"),
      product,
      { tags: tagsField },
    ),
    "#ручная #правка",
  )

  product.draft.values.attribute_23171 = { kind: "text", value: "" }
  assert.equal(
    readCellRawText(
      colIndexFor("tags"),
      mockRow("row-1", product.draft_id, "img-1.jpg"),
      product,
      { tags: tagsField },
    ),
    "",
    "an explicit clear must not revive recognition evidence",
  )
})

test("JSON富内容 shows the typed value only, like the two price columns", () => {
  const product = mockDraft("draft-1", "壁画 A")
  const richField: CategoryFieldView = {
    ...mockField,
    key: "attribute_11254",
    attribute_id: 11254,
    name: "JSON富内容",
  }
  const target = mockRow("row-1", product.draft_id, "img-1.jpg")
  const raw = '{"content":[{"type":"text","text":"油画"}]}'
  product.draft.values.attribute_11254 = { kind: "text", value: raw }

  assert.equal(
    readCellRawText(colIndexFor("rich_content"), target, product, {
      richContent: richField,
    }),
    "",
    "a card default copied into the row is not the row's own answer",
  )

  product.hand_edited_keys = ["attribute_11254"]
  assert.equal(
    readCellRawText(colIndexFor("rich_content"), target, product, {
      richContent: richField,
    }),
    raw,
  )
})

test("销售价 and 划线价 show the typed value only; a seeded copy or a cleared cell inherits", () => {
  const product = mockDraft("draft-1", "壁画 A")
  const priceField: CategoryFieldView = { ...mockField, key: "price", name: "销售价" }
  const oldPriceField: CategoryFieldView = { ...mockField, key: "old_price", name: "划线价" }
  const fields = { price: priceField, oldPrice: oldPriceField }
  const target = mockRow("row-1", product.draft_id, "img-1.jpg")

  assert.equal(readCellRawText(colIndexFor("price"), target, product, fields), "")
  // A card default copied into the row at creation is not the row's own
  // answer — `handEditedKeys` is what makes a value read as typed.
  product.draft.values.price = { kind: "decimal", value: 1990 }
  assert.equal(readCellRawText(colIndexFor("price"), target, product, fields), "")
  product.hand_edited_keys = ["price"]
  assert.equal(readCellRawText(colIndexFor("price"), target, product, fields), "1990")
  delete product.draft.values.price
  product.draft.cleared = ["price"]
  assert.equal(
    readCellRawText(colIndexFor("price"), target, product, fields),
    "",
    "a cleared 销售价 cell stays empty rather than inheriting",
  )
  assert.equal(
    readCellRawText(colIndexFor("old_price"), target, product, fields),
    "",
    "an empty 划线价 cell inherits the card default instead of inventing one",
  )
})

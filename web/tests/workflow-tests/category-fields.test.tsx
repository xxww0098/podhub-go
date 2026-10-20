/** Category field editing: dictionaries, fixed selects, draft values and complex groups. */
import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { CategorySchemaView } from "../../src/bindings/commands"
import { CategoryFieldsForm } from "../../src/features/workflow/category-fields-form"
import {
  dictionaryOptionsForDisplay,
  dictionaryOptionStateClasses,
  nextDictionarySelection,
} from "../../src/features/workflow/dictionary-drawer-field"
import {
  addComplexItem,
  createWorkflowDraft,
  fieldDisplayValueAsText,
  fixedTextValue,
  humanValidationMessage,
  isBrandField,
  issuesForField,
  NO_BRAND_OPTION,
  readWorkflowValue,
  requiredProgress,
  textValue,
  writeWorkflowValue,
} from "../../src/features/workflow/workflow-draft"
import {
  SimpleFieldPanels,
  dictionarySelectionText,
  fixedSelectOptions,
  toggleDictionarySelection,
} from "../../src/features/workflow/workflow-fields"
import { field, schema } from "./workflow-fixtures"

test("selected dictionary options use production semantic colors", () => {
  const selected = dictionaryOptionStateClasses({ selected: true, collection: true })
  assert.match(selected.row, /bg-primary/)
  assert.match(selected.indicator, /border-primary/)
  assert.match(selected.indicator, /bg-primary/)
  assert.match(selected.check, /opacity-100/)
  assert.doesNotMatch(`${selected.row} ${selected.indicator}`, /cabinet-/)
})

test("dictionary selections can be toggled off", () => {
  const option = { id: 7, value: "垂直", info: "", picture: "" }
  const selected = [{ dictionary_value_id: 7, value: "垂直" }]

  assert.deepEqual(
    nextDictionarySelection({ selected, option, collection: false }),
    { value: undefined, close: false },
    "clicking the current single choice clears it and keeps the drawer open",
  )
  assert.deepEqual(
    nextDictionarySelection({ selected, option, collection: true }),
    { value: { kind: "multi_select", value: [] }, close: false },
    "clicking a selected multi choice removes only that choice",
  )
})

test("selecting a dictionary option preserves Ozon display order", () => {
  const inline = [
    { id: 1, value: "垂直", info: "", picture: "" },
    { id: 2, value: "水平", info: "", picture: "" },
    { id: 3, value: "任意", info: "", picture: "" },
  ]
  assert.deepEqual(
    dictionaryOptionsForDisplay({
      inline,
      remote: [],
      selected: [inline[2]],
    }).map((option) => option.id),
    [1, 2, 3],
  )
})

test("brand field exposes an immediate built-in no-brand choice", () => {
  const brand = field({
    key: "attribute_85",
    name: "品牌",
    source: "attribute",
    editor: "dictionary_search",
    attribute_id: 85,
    options_truncated: true,
    constraints: { required: true, collection: false, dictionary_id: 1 },
    options: [],
  })
  assert.equal(isBrandField(brand), true)
  assert.deepEqual(
    nextDictionarySelection({ selected: [], option: NO_BRAND_OPTION, collection: false }).value,
    {
      kind: "single_select",
      value: { dictionary_value_id: 126745801, value: "Нет бренда" },
    },
  )
  const noBrandDraftValue = {
    kind: "single_select" as const,
    value: {
      dictionary_value_id: NO_BRAND_OPTION.id,
      value: NO_BRAND_OPTION.value,
    },
  }
  assert.equal(fieldDisplayValueAsText(brand, noBrandDraftValue), "无品牌")

  const markup = renderToStaticMarkup(
    <SimpleFieldPanels
      fieldGroups={[{ name: "商品信息", fields: [brand] }]}
      schema={{ ...schema, fields: [brand], complex_groups: [] }}
      targetStoreId="store-1"
      draft={{ values: { attribute_85: noBrandDraftValue }, complex_values: [] }}
      issues={[]}
      onUpdateValue={() => undefined}
    />,
  )
  assert.match(markup, /data-no-brand-quick-choice="true"/)
  assert.match(markup, />无品牌</)
  assert.doesNotMatch(markup, /Нет бренда/)
  assert.doesNotMatch(markup, /animate-spin/)
})

test("production dictionary drawer summarizes and toggles real draft selections", () => {
  const multi = schema.fields.find((candidate) => candidate.key === "attr_11")!
  const option = multi.options[0]!
  const selected = toggleDictionarySelection(multi, undefined, option)
  assert.deepEqual(selected, {
    kind: "multi_select",
    value: [{ dictionary_value_id: 2, value: "现代" }],
  })
  assert.equal(
    dictionarySelectionText(selected?.kind === "multi_select" ? selected.value : []),
    "现代",
  )
  assert.equal(toggleDictionarySelection(multi, selected, option), undefined)

  const single = schema.fields.find((candidate) => candidate.key === "attr_10")!
  const singleValue = toggleDictionarySelection(single, undefined, single.options[0]!)
  assert.equal(singleValue?.kind, "single_select")
  assert.equal(toggleDictionarySelection(single, singleValue, single.options[0]!), undefined)
})

test("schema snapshots with legacy null complex ids still render simple fields", () => {
  const legacySnapshot = {
    ...schema,
    fields: schema.fields.map((candidate) =>
      candidate.complex_id === undefined
        ? { ...candidate, complex_id: null }
        : candidate,
    ),
  } as unknown as CategorySchemaView
  const html = renderToStaticMarkup(
    <CategoryFieldsForm
      schema={legacySnapshot}
      targetStoreId="store-1"
      draft={createWorkflowDraft(legacySnapshot)}
      issues={[]}
      onUpdateValue={() => undefined}
      onAddComplexItem={() => undefined}
      onRemoveComplexItem={() => undefined}
    />,
  )
  assert.match(html, /销售价/)
  assert.match(html, /颜色/)
  const progress = requiredProgress(legacySnapshot, createWorkflowDraft(legacySnapshot))
  assert.equal(progress.total, 8)
})

test("fixed selects pin the Ozon wire values; 尺寸/重量单位只列英文符号", () => {
  assert.deepEqual(fixedSelectOptions("dimension_unit"), [
    { value: "mm", label: "mm" },
    { value: "cm", label: "cm" },
    { value: "in", label: "in" },
  ])
  assert.deepEqual(fixedSelectOptions("weight_unit")?.map((option) => option.value), ["g", "kg", "lb"])
  assert.deepEqual(fixedSelectOptions("currency_code")?.map((option) => option.value), [
    "RUB",
    "CNY",
    "USD",
    "EUR",
  ])
  assert.deepEqual(fixedSelectOptions("vat")?.map((option) => option.value), ["0", "0.1", "0.2"])
  assert.equal(fixedSelectOptions("price"), undefined)
})

test("backend draft wire values render as seller-facing option labels", () => {
  const guarantee = field({
    key: "attribute_10400",
    name: "保证",
    editor: "single_select",
    options: [{ id: 970716397, value: "1 年", info: "", picture: "" }],
    constraints: { required: false, collection: false, dictionary_id: 1 },
  })
  const selected = {
    kind: "single_select" as const,
    value: { dictionary_value_id: 970716397, value: "1 年" },
  }

  assert.equal(fieldDisplayValueAsText(guarantee, selected), "1 年")
  assert.notEqual(fieldDisplayValueAsText(guarantee, selected), "970716397")
  assert.equal(
    fieldDisplayValueAsText(guarantee, {
      ...selected,
      value: { ...selected.value, value: "" },
    }),
    "1 年",
    "legacy drafts with an empty label resolve the same schema fallback as import serialization",
  )

  const plain = field({ key: "plain", editor: "text" })
  assert.deepEqual(
    [
      fieldDisplayValueAsText(plain, { kind: "text", value: "发送文本" }),
      fieldDisplayValueAsText(plain, { kind: "integer", value: 42 }),
      fieldDisplayValueAsText(plain, { kind: "integer_list", value: [42, 43] }),
      fieldDisplayValueAsText(plain, { kind: "decimal", value: 0.2 }),
      fieldDisplayValueAsText(plain, { kind: "decimal_list", value: [0.1, 0.2] }),
      fieldDisplayValueAsText(plain, { kind: "boolean", value: true }),
      fieldDisplayValueAsText(plain, { kind: "boolean_list", value: [true, false] }),
      fieldDisplayValueAsText(plain, { kind: "url", value: "https://example.test/a.jpg" }),
      fieldDisplayValueAsText(plain, {
        kind: "url_list",
        value: ["https://example.test/a.jpg", "https://example.test/b.jpg"],
      }),
      fieldDisplayValueAsText(plain, { kind: "text_list", value: ["A", "B"] }),
      fieldDisplayValueAsText(guarantee, selected),
      fieldDisplayValueAsText(guarantee, {
        kind: "multi_select",
        value: [
          { dictionary_value_id: 970716397, value: "1 年" },
          { dictionary_value_id: 2, value: "2 年" },
        ],
      }),
    ],
    [
      "发送文本",
      "42",
      "42\n43",
      "0.2",
      "0.1\n0.2",
      "true",
      "true\nfalse",
      "https://example.test/a.jpg",
      "https://example.test/a.jpg\nhttps://example.test/b.jpg",
      "A\nB",
      "1 年",
      "1 年\n2 年",
    ],
  )

  const dimension = schema.fields.find((candidate) => candidate.key === "dimension_unit")!
  const available = schema.fields.find((candidate) => candidate.key === "available")!
  const style = schema.fields.find((candidate) => candidate.key === "attr_11")!
  const guaranteeSchema = {
    ...schema,
    fields: [guarantee, dimension, available, style],
    complex_groups: [],
  }
  const markup = renderToStaticMarkup(
    <SimpleFieldPanels
      fieldGroups={[{ name: "商品信息", fields: guaranteeSchema.fields }]}
      schema={guaranteeSchema}
      targetStoreId="store-1"
      draft={{
        values: {
          attribute_10400: selected,
          dimension_unit: { kind: "text", value: "cm" },
          available: { kind: "boolean", value: true },
          attr_11: {
            kind: "multi_select",
            value: [
              { dictionary_value_id: 2, value: "现代" },
              { dictionary_value_id: 3, value: "经典" },
              { dictionary_value_id: 4, value: "极简" },
            ],
          },
        },
        complex_values: [],
      }}
      issues={[]}
      onUpdateValue={() => undefined}
    />,
  )
  assert.match(markup, />1 年</)
  assert.doesNotMatch(markup, />970716397</)
  assert.match(markup, /data-slot="select-value"[^>]*>cm</)
  assert.match(markup, /data-slot="select-value"[^>]*>是</)
  assert.match(markup, /现代、经典 等 3 项/)
})

test("workflow draft pins coordinates and keeps complex values separate", () => {
  const draft = createWorkflowDraft(schema)
  assert.deepEqual(draft.values.description_category_id, { kind: "integer", value: 17027906 })
  assert.deepEqual(draft.values.type_id, { kind: "integer", value: 91976 })
  assert.deepEqual(draft.values.dimension_unit, { kind: "text", value: "mm" })
  assert.deepEqual(draft.values.weight_unit, { kind: "text", value: "g" })
  assert.deepEqual(draft.values.vat, { kind: "text", value: "0" })
  assert.equal(draft.values.currency_code, undefined)
  assert.deepEqual(fixedTextValue("kg"), { kind: "text", value: "kg" })
  assert.equal(fixedTextValue(""), undefined)
  assert.equal(draft.complex_values[0]?.complex_id, 99)
  assert.equal(draft.complex_values[0]?.items.length, 1)

  const next = writeWorkflowValue(
    draft,
    "attr_20",
    { kind: "integer", value: 40 },
    { complexId: 99, itemIndex: 0 },
  )
  assert.equal(next.values.attr_20, undefined)
  assert.deepEqual(next.complex_values[0]?.items[0]?.values.attr_20, {
    kind: "integer",
    value: 40,
  })
})

test("refreshed category fields start blank and new complex fields retain their first edit", () => {
  const refreshedSchema: CategorySchemaView = {
    ...schema,
    fields: [
      ...schema.fields,
      field({ key: "attr_30", name: "新增普通字段", source: "attribute" }),
      field({ key: "attr_31", name: "新增复杂字段", source: "attribute", complex_id: 100 }),
    ],
    complex_groups: [
      ...schema.complex_groups,
      { complex_id: 100, name: "新增复杂组", collection: true, field_keys: ["attr_31"] },
    ],
  }
  let existing = writeWorkflowValue(createWorkflowDraft(schema), "name", { kind: "text", value: "旧名称" })
  existing = writeWorkflowValue(existing, "attr_20", { kind: "integer", value: 40 }, { complexId: 99 })
  existing = writeWorkflowValue(existing, "attr_10", undefined)

  for (const emptyGroup of [[], [{ complex_id: 100, items: [] }]]) {
    const draft = { ...existing, complex_values: [...existing.complex_values, ...emptyGroup] }
    const before = structuredClone(draft)
    const markup = renderToStaticMarkup(
      <CategoryFieldsForm
        schema={refreshedSchema}
        targetStoreId="store-1"
        draft={draft}
        issues={[]}
        onUpdateValue={() => undefined}
        onAddComplexItem={() => undefined}
        onRemoveComplexItem={() => undefined}
      />,
    )
    assert.match(markup, /新增普通字段/)
    assert.match(markup, /新增复杂字段/)
    assert.equal(readWorkflowValue(draft, "attr_30"), undefined)
    assert.equal(readWorkflowValue(draft, "attr_31", { complexId: 100 }), undefined)

    const edited = writeWorkflowValue(draft, "attr_31", { kind: "text", value: "首次填写" }, { complexId: 100 })
    assert.deepEqual(readWorkflowValue(edited, "attr_31", { complexId: 100 }), { kind: "text", value: "首次填写" })
    assert.deepEqual(edited.values, before.values)
    assert.deepEqual(edited.cleared, ["attr_10"])
    assert.deepEqual(edited.complex_values[0], before.complex_values[0])
    assert.deepEqual(draft, before)
  }
})

test("adding to a new or empty complex group retains the visible blank item", () => {
  const existing = writeWorkflowValue(createWorkflowDraft(schema), "attr_20", { kind: "integer", value: 40 }, { complexId: 99 })
  for (const emptyGroup of [[], [{ complex_id: 100, items: [] }]]) {
    const draft = { ...existing, cleared: ["attr_10"], complex_values: [...existing.complex_values, ...emptyGroup] }
    const before = structuredClone(draft)
    const added = addComplexItem(draft, 100)
    assert.deepEqual(added.complex_values.find((group) => group.complex_id === 100)?.items, [
      { values: {} },
      { values: {} },
    ])
    assert.deepEqual(added.values, before.values)
    assert.deepEqual(added.cleared, before.cleared)
    assert.deepEqual(added.complex_values[0], before.complex_values[0])
    assert.deepEqual(draft, before)
  }
  const added = addComplexItem(existing, 99)
  const items = added.complex_values[0]?.items
  assert.equal(items?.length, 2)
  assert.equal(items?.[0]?.item_id, existing.complex_values[0]?.items[0]?.item_id)
  assert.match(items?.[0]?.item_id ?? "", /^ci_[0-9a-f]{32}$/)
  assert.deepEqual(items?.[0]?.values, { attr_20: { kind: "integer", value: 40 } })
  assert.deepEqual(items?.[1], { values: {} })
})

test("collection input preserves invalid intermediate text for canonical validation", () => {
  const images = schema.fields.find((candidate) => candidate.key === "images")!
  assert.deepEqual(textValue(images, "https://a.test/1.jpg\nnot-a-url\n"), {
    kind: "url_list",
    value: ["https://a.test/1.jpg", "not-a-url"],
  })
  const numberList = field({
    editor: "integer",
    constraints: { required: false, collection: true },
  })
  assert.deepEqual(textValue(numberList, "12\nnot-a-number"), {
    kind: "text_list",
    value: ["12", "not-a-number"],
  })
})

test("required progress and issue routing include complex item position", () => {
  let draft = createWorkflowDraft(schema)
  draft = writeWorkflowValue(draft, "name", { kind: "text", value: "海报" })
  const progress = requiredProgress(schema, draft)
  assert.equal(progress.total, 8)
  assert.equal(progress.complete, 4)

  const issues = [
    {
      field_key: "attr_20",
      code: "range" as const,
      message: "value must be greater than zero",
      complex_id: 99,
      item_index: 0,
    },
  ]
  assert.equal(issuesForField(issues, "attr_20", { complexId: 99, itemIndex: 0 }).length, 1)
  assert.equal(issuesForField(issues, "attr_20").length, 0)
  assert.equal(humanValidationMessage(issues[0]!), "数值超出 Ozon 接受的范围。")
})

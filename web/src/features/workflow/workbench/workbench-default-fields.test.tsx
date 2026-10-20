import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { Children, isValidElement, type ReactElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { CategoryFieldsForm } from "../category-fields-form"
import { DefaultFieldsDialog } from "../default-fields-dialog"
import { SkuImportPanel } from "../sku-import-panel"
import { valueAsText, writeWorkflowValue } from "../workflow-draft"
import { tableOwnedFields } from "./workbench-columns"
import { field, idleLifecycle, instance, row, schema } from "./workbench-test-fixtures"
import { fieldMarkup } from "./workbench-test-harness"

// ---------------------------------------------------------------------------
// 默认字段
// ---------------------------------------------------------------------------

test("the SKU import flow starts as a direct input instead of another tab or reveal step", () => {
  const html = renderToStaticMarkup(
    <SkuImportPanel
      blank
      disabled={false}
      onPreview={async () => ({
        source_sku: 1,
        source_product_id: 1,
        source_offer_id: "",
        source_name: "",
        source_description_category_id: 1,
        source_type_id: 1,
        category_matches: true,
        candidates: [],
        skipped_fields: 0,
      })}
      onApply={() => undefined}
    />,
  )

  assert.match(html, /aria-label="输入来源 Ozon SKU"/)
  assert.match(html, /读取 SKU/)
  assert.doesNotMatch(html, /关闭 SKU 导入|从 SKU 填充/)
})

test("完整类目字段 explains a table-owned field without presenting a dead input value", () => {
  const schemaWithTags = {
    ...schema,
    fields: [
      ...schema.fields,
      field({
        key: "attribute_23171",
        name: "#主题标签",
        group_name: "商品属性",
        source: "attribute",
        attribute_id: 23171,
        constraints: { required: false, collection: false },
      }),
    ],
  }
  const html = renderToStaticMarkup(
    <CategoryFieldsForm
      schema={schemaWithTags}
      targetStoreId="store-1"
      draft={{ values: {}, complex_values: [] }}
      issues={[]}
      initialFilter="all"
      lockedFields={tableOwnedFields(schemaWithTags)}
      onUpdateValue={() => undefined}
      onAddComplexItem={() => undefined}
      onRemoveComplexItem={() => undefined}
    />,
  )

  // The table header and this input carry the same field id, and the table wins:
  // Rust re-injects the source file stem before every publish, so an edit typed
  // here would be erased on the way out.
  const offerId = fieldMarkup(html, "offer_id")
  assert.match(offerId, /商家货号/)
  assert.match(offerId, /role="note"/)
  assert.match(offerId, /逐行生成/)
  assert.match(offerId, /最终值不在此处配置/)
  assert.doesNotMatch(offerId, /disabled=""/)
  assert.match(offerId, /由原图文件名构建（表格列「货号」）/)

  // 型号名称 has its own editable 型号 column, so its lock points there instead
  // of at the 货号 the two used to share.
  const modelName = fieldMarkup(html, "model_name")
  assert.match(modelName, /型号名称/)
  assert.match(modelName, /最终值不在此处配置/)
  assert.match(modelName, /由原图文件名构建（表格列「型号」）/)

  const tags = fieldMarkup(html, "attribute_23171")
  assert.match(tags, /#主题标签/)
  assert.match(tags, /最终值不在此处配置/)
  assert.match(tags, /由 AI 识图逐图构建（表格列「搜索标签」）/)

  // A key no column writes stays the card default it has always been.
  assert.doesNotMatch(fieldMarkup(html, "price"), /role="note"/)
})

test("default fields show occupancy and mark server issues without painting them in the page", () => {
  const html = renderToStaticMarkup(
    <CategoryFieldsForm
      schema={schema}
      targetStoreId="store-1"
      draft={{
        values: { price: { kind: "decimal", value: 0 } },
        complex_values: [],
        cleared: ["vat"],
      }}
      issues={[
        {
          field_key: "vat",
          code: "required",
          message: "server",
        },
      ]}
      initialFilter="all"
      onUpdateValue={() => undefined}
      onAddComplexItem={() => undefined}
      onRemoveComplexItem={() => undefined}
    />,
  )
  assert.doesNotMatch(html, /aria-label="字段问题定位"/)
  assert.doesNotMatch(html, /有 1 个字段问题/)
  assert.doesNotMatch(html, /这是必填字段/)
  assert.match(fieldMarkup(html, "vat"), /aria-invalid="true"/)
  assert.match(fieldMarkup(html, "price"), /data-occupancy="value"/)
  assert.match(fieldMarkup(html, "price"), /已填/)
  assert.match(fieldMarkup(html, "vat"), /data-occupancy="cleared"/)
  assert.match(fieldMarkup(html, "vat"), /已清空/)
})

/** Inspect the real component's emitted tree before Base UI's portal boundary.
 * SSR does not mount that portal or run the cache-probe effect. */
function defaultFieldsTree() {
  let tree!: ReturnType<typeof DefaultFieldsDialog>
  function Capture() {
    tree = DefaultFieldsDialog({
      open: true, onOpenChange: () => undefined, schema,
      draft: { values: {}, complex_values: [] }, issues: [], fieldOrigins: [],
      targetStoreId: "store-1", onFetchSchema: async () => undefined,
      onUpdateValue: () => undefined,
    })
    return null
  }
  renderToStaticMarkup(<Capture />)
  const pending: ReactNode[] = [tree]
  const elements: ReactElement<Record<string, unknown>>[] = []
  while (pending.length) {
    const element = pending.pop()
    if (!isValidElement<Record<string, unknown>>(element)) continue
    elements.push(element)
    pending.push(...Children.toArray(element.props.children as ReactNode))
  }
  return elements
}

test("the open fields dialog emits its last loaded fields before refreshing", () => {
  const form = defaultFieldsTree().find((element) => element.type === CategoryFieldsForm)
  assert.ok(form, "the open dialog must include its form immediately")
  assert.equal(form.props.schema, schema)
  const html = renderToStaticMarkup(form)
  assert.match(html, /data-field-key="offer_id"/)
  assert.doesNotMatch(html, /获取类目字段/)
})

test("the fields dialog keeps SKU cloning and pack management without pack import", () => {
  const tree = defaultFieldsTree()
  const save = tree.find((element) => element.props.children === "保存字段包")
  assert.ok(save)
  assert.equal(typeof save.props.onClick, "function")
  const copy = tree.map((element) => String(element.props.children ?? "")).join("\n")
  assert.doesNotMatch(copy, /从字段库载入|套用到当前方案|确认套用空字段/)
  const sku = tree.find((element) => element.type === SkuImportPanel)
  assert.ok(sku, "SKU cloning remains available")
  assert.equal(typeof sku.props.onPreview, "function")
  assert.equal(typeof sku.props.onApply, "function")
})

test("the fields dialog deletes a Pack only after confirm and never promotes another", () => {
  const source = readFileSync(
    new URL("../default-fields-dialog.tsx", import.meta.url),
    "utf8",
  )
  assert.match(source, /fieldPackDelete/)
  assert.match(source, /<ConfirmDialog/)
  assert.match(source, /title="删除字段包？"/)
  assert.match(source, /已用它创建的上架方案和商品不受影响/)
  assert.match(source, /不会自动改设其他字段包/)
  assert.match(source, /无法删除这个字段包/)
  assert.match(source, /aria-label=\{`删除 \$\{pack\.name\}`\}/)
  assert.equal(
    source.match(/fieldPackSetActive/g)?.length,
    1,
    "delete must refresh the list, not PATCH another Pack active",
  )
  assert.doesNotMatch(source, /fieldPackSetActive\(\{[^}]*pendingDelete/)
})

test("the runner exposes neither PSD replacement nor prompt editing", () => {
  const dialogHtml = renderToStaticMarkup(
    <DefaultFieldsDialog
      open
      onOpenChange={() => undefined}
      schema={schema}
      draft={{ values: {}, complex_values: [] }}
      issues={[]}
      fieldOrigins={[]}
      targetStoreId="store-1"
      onFetchSchema={async () => undefined}
      onUpdateValue={() => undefined}
    />,
  )
  assert.doesNotMatch(dialogHtml, /PSD 与提示词|AI 商品文案提示词/)
})

test("an edit after AI fill is the Draft the next publish step reads", () => {
  const target = row(1)
  const filled = instance(target, {
    ...idleLifecycle,
    ai: "ready",
    ai_summary: { tags: ["море"], model: "test" },
  })
  filled.draft.values.name = { kind: "text", value: "Постер с морем" }
  filled.draft.values.description = { kind: "text", value: "Печать на холсте." }

  const edited = writeWorkflowValue(filled.draft, "name", { kind: "text", value: "Правка названия" })
  const withDesc = writeWorkflowValue(edited, "description", {
    kind: "text",
    value: "Правка описания\nвторая строка",
  })

  assert.equal(valueAsText(withDesc.values.name), "Правка названия")
  assert.equal(valueAsText(withDesc.values.description), "Правка описания\nвторая строка")
})

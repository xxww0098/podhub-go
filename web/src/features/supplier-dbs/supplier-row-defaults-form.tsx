import { useDeferredValue, useState } from "react"

import type { CategoryFieldView, CategorySchemaView, WorkflowCategoryDraft, WorkflowDraftValue } from "@/bindings/commands"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { matchesCategoryField } from "@/features/workflow/category-fields-form"
import { ComplexGroups, SimpleFieldPanels } from "@/features/workflow/workflow-fields"
import { displayFieldName } from "@/features/workflow/workflow-shared"
import { readWorkflowValue, valueAsText, type WorkflowValueLocation } from "@/features/workflow/workflow-draft"
import { LISTING_DEFAULT_COORDINATE_KEYS, rowOwnedFields } from "./supplier-listing-defaults"

const FILTERS = { filled: "已填写", required: "必填", all: "全部", empty: "待填写" } as const
type Filter = keyof typeof FILTERS

/** Complex supplier defaults have one item; zero and false are filled values. */
function isFilled(field: CategoryFieldView, draft: WorkflowCategoryDraft) {
  const value = readWorkflowValue(draft, field.key, field.complex_id == null ? {} : {
    complexId: field.complex_id, itemIndex: 0,
  })
  if (value?.kind === "single_select") return true
  if (value?.kind === "multi_select") return value.value.length > 0
  return Boolean(valueAsText(value).trim())
}

export function supplierDefaultFields(
  schema: CategorySchemaView,
  draft: WorkflowCategoryDraft,
  filter: Filter,
  query: string,
  editingKey: string | null = null,
) {
  const owned = rowOwnedFields(schema)
  const editable = schema.fields.filter((field) =>
    !owned.has(field.key) && !LISTING_DEFAULT_COORDINATE_KEYS.has(field.key),
  )
  return {
    owned,
    total: editable.length,
    filled: editable.filter((field) => isFilled(field, draft)).length,
    visible: editable.filter((field) =>
      matchesCategoryField(field, query, filter === "required" ? "required" : "all") &&
      (field.key === editingKey || (
        (filter !== "filled" || isFilled(field, draft)) &&
        (filter !== "empty" || !isFilled(field, draft))
      )),
    ),
  }
}

/** Keep field encoding, dictionaries and unsupported types in the shared renderer. */
export function SupplierRowDefaultsForm({ schema, draft, onUpdateValue, onAddComplexItem, onRemoveComplexItem }: {
  schema: CategorySchemaView
  draft: WorkflowCategoryDraft
  onUpdateValue: (fieldKey: string, value: WorkflowDraftValue | undefined, location: WorkflowValueLocation) => void
  onAddComplexItem: (complexId: number) => void
  onRemoveComplexItem: (complexId: number, itemIndex: number) => void
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("filled")
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const fields = supplierDefaultFields(schema, draft, filter, deferredQuery, editingKey)
  const simpleGroups = [
    { name: "物流与税务", fields: fields.visible.filter((field) => field.complex_id == null && field.source === "fixed") },
    { name: "类目属性", fields: fields.visible.filter((field) => field.complex_id == null && field.source !== "fixed") },
  ].filter((group) => group.fields.length)
  return (
    <div className="flex flex-col gap-4" data-supplier-row-defaults-form=""
      onFocusCapture={(event) => {
        setEditingKey((event.target as HTMLElement).closest<HTMLElement>("[data-field-key]")?.dataset.fieldKey ?? null)
      }}
      onBlurCapture={(event) => {
        // Keep an edited field visible until focus leaves it, even if its filled state changes.
        const next = event.relatedTarget instanceof HTMLElement
          ? event.relatedTarget.closest<HTMLElement>("[data-field-key]")?.dataset.fieldKey
          : null
        setEditingKey(next ?? null)
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <Input type="search" aria-label="搜索平台字段" placeholder="搜索字段名称…" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        <Select value={filter} onValueChange={(next) => { if (next && next in FILTERS) setFilter(next as Filter) }}>
          <SelectTrigger aria-label="平台字段筛选"><SelectValue>{() => FILTERS[filter]}</SelectValue></SelectTrigger>
          <SelectContent>{Object.entries(FILTERS).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <p className="text-meta text-muted-foreground" data-supplier-row-defaults-summary="">
        {fields.filled} 项已填写 · {fields.total} 项可配置
      </p>
      {simpleGroups.length ? <SimpleFieldPanels
        fieldGroups={simpleGroups} schema={schema} targetStoreId="" draft={draft} issues={[]}
        defaultOpen="all" forceOpen onUpdateValue={onUpdateValue}
      /> : null}
      <ComplexGroups schema={schema} targetStoreId="" draft={draft} issues={[]}
        visibleFieldKeys={new Set(fields.visible.map((field) => field.key))} forceOpen
        onChange={onUpdateValue} onAdd={onAddComplexItem} onRemove={onRemoveComplexItem}
      />
      {!fields.visible.length ? <p className="py-6 text-center text-compact text-muted-foreground">没有符合筛选条件的字段。</p> : null}
      {fields.owned.size ? <section className="flex flex-col gap-3 border-t border-border pt-4">
        <h3 className="text-compact font-semibold">逐图生成的字段</h3>
        <p className="text-meta text-muted-foreground">这些字段由商品资料、识图或上架表格填写。</p>
        <dl className="flex flex-col gap-3">{schema.fields.filter((field) => fields.owned.has(field.key)).map((field) =>
          <div key={field.key} className="flex flex-wrap justify-between gap-2 text-meta" data-field-key={field.key}>
            <dt>{displayFieldName(field)}</dt><dd className="text-muted-foreground">{fields.owned.get(field.key)}</dd>
          </div>,
        )}</dl>
      </section> : null}
    </div>
  )
}

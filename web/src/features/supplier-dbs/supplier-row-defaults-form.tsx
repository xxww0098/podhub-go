import { useDeferredValue, useEffect, useRef, useState } from "react"
import { ChevronRight, Search } from "lucide-react"

import type { CategoryFieldView, CategorySchemaView, WorkflowCategoryDraft, WorkflowDraftValue, WorkflowValidationIssue } from "@/bindings/commands"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { matchesCategoryField } from "@/features/workflow/category-fields-form"
import { categoryFieldDomId, ComplexGroups, focusCategoryField, SimpleFieldPanels } from "@/features/workflow/workflow-fields"
import { displayFieldName } from "@/features/workflow/workflow-shared"
import { readWorkflowValue, valueAsText, type WorkflowValueLocation } from "@/features/workflow/workflow-draft"
import { LISTING_DEFAULT_COORDINATE_KEYS, rowOwnedFields } from "./supplier-listing-defaults"

const FILTERS = { filled: "已填写", required: "必填", all: "全部", empty: "待填写", invalid: "有误" } as const
type Filter = keyof typeof FILTERS

/** A field is filled when any repeated item has a value; zero and false count. */
function isFilled(field: CategoryFieldView, draft: WorkflowCategoryDraft, everyItem = false) {
  const count = field.complex_id == null
    ? 1
    : Math.max(1, draft.complex_values.find((group) => group.complex_id === field.complex_id)?.items.length ?? 1)
  const filled = Array.from({ length: count }, (_, itemIndex) => readWorkflowValue(
    draft, field.key, field.complex_id == null ? {} : { complexId: field.complex_id, itemIndex },
  )).map((value) => {
    if (value?.kind === "single_select") return true
    if (value?.kind === "multi_select") return value.value.length > 0
    return Boolean(valueAsText(value).trim())
  })
  return everyItem ? filled.every(Boolean) : filled.some(Boolean)
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
    !owned.has(field.key) &&
    !LISTING_DEFAULT_COORDINATE_KEYS.has(field.key) &&
    // The destination Store's contract decides the currency at send.
    field.key !== "currency_code",
  )
  return {
    owned,
    total: editable.length,
    filled: editable.filter((field) => isFilled(field, draft)).length,
    required: editable.filter((field) => field.constraints.required && !field.read_only).length,
    missingRequired: editable.filter((field) => field.constraints.required && !field.read_only && !isFilled(field, draft, true)).length,
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
export function SupplierRowDefaultsForm({ schema, draft, action, issues = [], validationAttempt = 0, onUpdateValue, onAddComplexItem, onRemoveComplexItem }: {
  schema: CategorySchemaView
  draft: WorkflowCategoryDraft
  action?: React.ReactNode
  issues?: WorkflowValidationIssue[]
  validationAttempt?: number
  onUpdateValue: (fieldKey: string, value: WorkflowDraftValue | undefined, location: WorkflowValueLocation) => void
  onAddComplexItem: (complexId: number) => void
  onRemoveComplexItem: (complexId: number, itemIndex: number) => void
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("required")
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)
  const summaryRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLDivElement>(null)
  const [focusTarget, setFocusTarget] = useState<string | null>(null)
  useEffect(() => {
    // Move focus only after an explicit validation, never during autosave.
    if (validationAttempt > 0 && summaryRef.current) {
      setQuery("")
      setFilter("invalid")
      summaryRef.current.focus()
    }
  }, [validationAttempt])
  useEffect(() => {
    if (focusTarget && focusCategoryField(formRef.current, focusTarget)) setFocusTarget(null)
  }, [focusTarget, filter, deferredQuery])
  const fields = supplierDefaultFields(schema, draft, filter, deferredQuery, editingKey)
  if (filter === "invalid") {
    fields.visible = fields.visible.filter((field) => field.key === editingKey || issues.some((issue) =>
      issue.field_key === field.key || issue.complex_id != null && issue.complex_id === field.complex_id,
    ))
  }
  const fixedOrder = ["width", "height", "depth", "dimension_unit", "weight", "weight_unit", "vat", "barcode"]
  const simpleGroups = [
    { name: "物流与税务", fields: fields.visible.filter((field) => field.complex_id == null && field.source === "fixed")
      .sort((a, b) => (fixedOrder.indexOf(a.key) < 0 ? 99 : fixedOrder.indexOf(a.key)) - (fixedOrder.indexOf(b.key) < 0 ? 99 : fixedOrder.indexOf(b.key))) },
    { name: "类目属性", fields: fields.visible.filter((field) => field.complex_id == null && field.source !== "fixed")
      .sort((a, b) => Number(b.constraints.required) - Number(a.constraints.required)) },
  ].filter((group) => group.fields.length)
  const ownedFields = schema.fields.filter((field) => fields.owned.has(field.key))
  const quickFilters = [
    { value: "required", label: "必填", count: fields.required },
    { value: "invalid", label: "有误", count: issues.length },
    { value: "all", label: "全部", count: fields.total },
  ] as const
  return (
    <div ref={formRef} className="flex min-h-0 min-w-0 flex-1 flex-col" data-supplier-row-defaults-form=""
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
      <div className="supplier-ozon-toolbar flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 sm:px-4">
        <InputGroup className="min-w-36 flex-1">
          <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="搜索OZON字段" placeholder="搜索字段…" value={query} onChange={(event) => {
            setQuery(event.target.value)
            if (event.target.value.trim()) setFilter("all")
          }} />
        </InputGroup>
        <div role="group" aria-label="OZON字段筛选" className="flex min-w-0 flex-wrap items-center gap-1">
          {quickFilters.map(({ value, label, count }) => <Button key={value} type="button" size="sm"
            variant={filter === value ? "secondary" : "ghost"} aria-pressed={filter === value}
            onClick={() => setFilter(value)} className="gap-1.5 px-2">
            {label}<span className="text-meta tabular-nums text-muted-foreground">{count}</span>
          </Button>)}
          <Select value={filter === "filled" || filter === "empty" ? filter : null}
            onValueChange={(next) => { if (next === "filled" || next === "empty") setFilter(next) }}>
            <SelectTrigger className="w-auto gap-1 border-transparent bg-transparent px-2 text-compact shadow-none" aria-label="更多字段筛选">
              <SelectValue>{() => filter === "filled" || filter === "empty" ? FILTERS[filter] : "更多"}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="filled">已填写 {fields.filled}</SelectItem>
              <SelectItem value="empty">待填写 {fields.total - fields.filled}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="supplier-ozon-actions flex min-w-0 flex-wrap items-center gap-2" role="region" aria-label="Ozon 配置操作">
          <p className="text-meta text-muted-foreground" data-supplier-row-defaults-summary="">
            {fields.missingRequired ? <span className="mr-2 font-medium text-foreground">待补 {fields.missingRequired} 项必填</span> : null}
            已填 {fields.filled}/{fields.total}
          </p>
          {action}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3 outline-none [scrollbar-gutter:stable] [scroll-padding-block:1rem] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:p-4"
        tabIndex={0} role="region" aria-label="Ozon 字段列表" data-supplier-row-fields-scroll="">
      <div className="flex min-w-0 flex-col gap-3">
      {issues.length ? <div ref={summaryRef} tabIndex={-1} role="region" aria-label="Ozon 配置校验问题" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-compact outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <p className="font-medium text-destructive">{issues.length} 处未通过校验</p>
        <ul className="mt-1 space-y-1">{issues.map((issue, index) => {
          const field = schema.fields.find((field) => field.key === issue.field_key)
          const id = categoryFieldDomId(issue.field_key, issue.complex_id == null
            ? undefined
            : `${issue.field_key}-${issue.complex_id}-${issue.item_index ?? 0}`)
          return <li key={`${id}-${issue.code}-${index}`}>
            {field ? <button type="button" className="text-left text-destructive underline-offset-2 hover:underline focus-visible:underline" onClick={() => {
              setQuery("")
              setFilter("all")
              setFocusTarget(id)
            }}>{displayFieldName(field)}{issue.item_index == null ? "" : ` · 第 ${issue.item_index + 1} 项`}：{issue.message}</button>
              : <span>{issue.message}</span>}
          </li>
        })}</ul>
      </div> : null}
      {simpleGroups.length ? <SimpleFieldPanels
        fieldGroups={simpleGroups} schema={schema} targetStoreId="" draft={draft} issues={issues}
        defaultOpen="all" onUpdateValue={onUpdateValue}
      /> : null}
      <ComplexGroups schema={schema} targetStoreId="" draft={draft} issues={issues}
        visibleFieldKeys={new Set(fields.visible.map((field) => field.key))} forceOpen={Boolean(deferredQuery.trim()) || filter === "invalid"} compact
        onChange={onUpdateValue} onAdd={onAddComplexItem} onRemove={onRemoveComplexItem}
      />
      {!fields.visible.length ? <p className="py-3 text-center text-compact text-muted-foreground">没有符合筛选条件的字段。</p> : null}
      {ownedFields.length ? <details className="group border-t border-border" data-supplier-row-owned-fields="">
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 py-2 text-compact outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronRight aria-hidden className="size-3.5 shrink-0 transition-transform group-open:rotate-90" />
          <span className="flex-1 font-medium">逐图生成的字段</span>
          <span className="text-meta text-muted-foreground">{ownedFields.length} 项</span>
        </summary>
        <dl className="flex flex-col">{ownedFields.map((field) =>
          <div key={field.key} className="flex flex-wrap justify-between gap-2 border-b border-border/60 py-2 text-meta" data-field-key={field.key}>
            <dt>{displayFieldName(field)}</dt><dd className="text-muted-foreground">{fields.owned.get(field.key)}</dd>
          </div>,
        )}</dl>
      </details> : null}
      </div>
      </div>
    </div>
  )
}

import { memo, useMemo, useState } from "react"
import { Search } from "lucide-react"

import type {
  CategoryFieldView,
  CategorySchemaView,
  FieldValueOrigin,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowValidationIssue,
} from "@/bindings/commands"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { WorkflowValueLocation } from "./workflow-draft"
import { ComplexGroups, SimpleFieldPanels } from "./workflow-fields"
import { displayFieldName } from "./workflow-shared"

export type CategoryFieldFilter = "all" | "required" | "dictionary" | "complex"

export function matchesCategoryField(
  field: CategoryFieldView,
  query: string,
  filter: CategoryFieldFilter,
) {
  if (filter === "required" && (!field.constraints.required || field.read_only)) return false
  if (filter === "dictionary" && !field.constraints.dictionary_id) return false
  if (filter === "complex" && field.complex_id == null) return false

  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return [
    displayFieldName(field),
    field.name,
    field.description,
    field.group_name,
    field.key,
    field.raw_type ?? "",
  ].some((value) => value.toLocaleLowerCase().includes(needle))
}

function groupSimpleFields(fields: CategoryFieldView[]) {
  const groups = new Map<string, CategoryFieldView[]>()
  for (const field of fields) {
    if (field.complex_id != null) continue
    const group = groups.get(field.group_name) ?? []
    group.push(field)
    groups.set(field.group_name, group)
  }
  return [...groups].map(([name, groupFields]) => ({ name, fields: groupFields }))
}

export const CategoryFieldsForm = memo(function CategoryFieldsForm({
  schema,
  targetStoreId,
  draft,
  issues,
  initialFilter = "required",
  fieldOrigins,
  lockedFields,
  onOpenMedia,
  onUpdateValue,
  onAddComplexItem,
  onRemoveComplexItem,
}: {
  schema: CategorySchemaView
  /** Target Store the dictionary lookups behind these fields are bound to. */
  targetStoreId: string
  draft: WorkflowCategoryDraft
  issues: WorkflowValidationIssue[]
  initialFilter?: CategoryFieldFilter
  fieldOrigins?: FieldValueOrigin[]
  /**
   * Keys another surface writes, mapped to why. Listing every category field
   * means listing the ones the batch table owns too, so they render here as
   * locked inputs rather than as an edit that the next row write erases.
   */
  lockedFields?: ReadonlyMap<string, string>
  onOpenMedia?: () => void
  onUpdateValue: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onAddComplexItem: (complexId: number) => void
  onRemoveComplexItem: (complexId: number, itemIndex: number) => void
}) {
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<CategoryFieldFilter>(initialFilter)

  const categoryFields = useMemo(
    () => schema.fields,
    [schema],
  )
  const visibleFields = useMemo(
    () => categoryFields.filter((field) => matchesCategoryField(field, query, filter)),
    [categoryFields, filter, query],
  )
  const visibleFieldKeys = useMemo(
    () => new Set(visibleFields.map((field) => field.key)),
    [visibleFields],
  )
  const simpleGroups = useMemo(() => groupSimpleFields(visibleFields), [visibleFields])
  const requiredCount = categoryFields.filter(
    (field) => field.constraints.required && !field.read_only,
  ).length
  const dictionaryCount = categoryFields.filter(
    (field) => Boolean(field.constraints.dictionary_id),
  ).length
  const complexCount = categoryFields.filter((field) => field.complex_id != null).length
  const forceOpen = Boolean(query.trim()) || filter !== "all"

  return (
    <div className="flex flex-col gap-3" data-category-fields-form>
      <section className="rounded-xl border border-border/80 bg-card p-3 shadow-2xs">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-faint-foreground"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="查找字段"
              className="h-8.5 pl-8.5 text-xs shadow-2xs"
            />
          </div>
          <div className="flex items-center gap-1 overflow-x-auto rounded-lg border border-border/70 bg-muted/30 p-1">
            {([
              ["required", "必填", requiredCount],
              ["all", "全部", categoryFields.length],
              ["dictionary", "字典", dictionaryCount],
              ["complex", "复杂", complexCount],
            ] as const).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                aria-pressed={filter === key}
                onClick={() => setFilter(key)}
                className={cn(
                  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-meta outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring cursor-pointer",
                  filter === key
                    ? "bg-foreground font-medium text-background shadow-2xs"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/60",
                )}
              >
                <span>{label}</span>
                <span
                  className={cn(
                    "rounded px-1 py-0.2 font-mono text-meta tabular-nums",
                    filter === key
                      ? "bg-background/20 text-background font-semibold"
                      : "bg-muted text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            ))}
          </div>
        </div>
      </section>

      {simpleGroups.length ? (
        <SimpleFieldPanels
          fieldGroups={simpleGroups}
          schema={schema}
          targetStoreId={targetStoreId}
          draft={draft}
          issues={issues}
          defaultOpen={forceOpen ? "all" : "none"}
          forceOpen={forceOpen}
          fieldOrigins={fieldOrigins}
          lockedFields={lockedFields}
          onOpenMedia={onOpenMedia}
          onUpdateValue={onUpdateValue}
        />
      ) : null}

      <ComplexGroups
        schema={schema}
        targetStoreId={targetStoreId}
        draft={draft}
        issues={issues}
        visibleFieldKeys={visibleFieldKeys}
        forceOpen={forceOpen}
        lockedFields={lockedFields}
        onChange={onUpdateValue}
        onAdd={onAddComplexItem}
        onRemove={onRemoveComplexItem}
      />

      {!visibleFields.length ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          当前筛选没有匹配字段。
        </div>
      ) : null}
    </div>
  )
})

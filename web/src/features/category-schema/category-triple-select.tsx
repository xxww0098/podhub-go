import { useMemo, useState } from "react"
import { Search, X } from "lucide-react"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import { FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  buildCategorySearchIndex,
  categoryPathLabel,
  searchCategoryIndex,
  type CategoryTreeSelection,
} from "./category-tree"

/** Searchable Seller category picker. A leaf `type_id` is what the form stores. */
export function CategoryTripleSelect({
  tree,
  selection,
  onSelectL1,
  onSelectType,
  disabled = false,
  loading = false,
  id = "category",
  query: initialQuery = "",
  describedBy,
  invalid = false,
}: {
  tree: CategoryTreeNodeView[]
  selection: CategoryTreeSelection
  onSelectL1: (l1Id: number) => void
  onSelectL2: (l2Id: number) => void
  onSelectType: (descriptionCategoryId: number, typeId: number) => void
  disabled?: boolean
  /** Tree fetch in flight — search waits, breadcrumb still shows a prior leaf. */
  loading?: boolean
  id?: string
  /** Initial search text so tests can paint filtered hits on first render. */
  query?: string
  describedBy?: string
  invalid?: boolean
  orientation?: "stack" | "row"
}) {
  const [categoryQuery, setCategoryQuery] = useState(initialQuery)
  const searchIndex = useMemo(() => buildCategorySearchIndex(tree), [tree])
  const categoryResults = useMemo(
    () => searchCategoryIndex(searchIndex, categoryQuery),
    [categoryQuery, searchIndex],
  )

  const treeReady = !loading && tree.length > 0
  const leafChosen = selection.descriptionCategoryId > 0 && selection.typeId > 0
  const pathLabel = leafChosen
    ? categoryPathLabel(selection.descriptionCategoryId, selection.typeId, tree)
    : ""
  const searchId = `${id}-search`

  return (
    <div className={cn("grid gap-2", disabled && "pointer-events-none opacity-60")}>
      <div className="grid gap-1.5">
        <FieldLabel htmlFor={searchId}>搜索类目</FieldLabel>
        <div className={cn("relative", categoryQuery.trim() && "z-20")}>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            id={searchId}
            value={categoryQuery}
            disabled={disabled || !treeReady}
            placeholder={
              loading
                ? "正在拉取类目…"
                : treeReady
                  ? "输入名称或 ID"
                  : "等待类目树"
            }
            aria-invalid={invalid || undefined}
            aria-describedby={describedBy}
            onChange={(event) => setCategoryQuery(event.target.value)}
            className="h-9 px-8 text-xs"
          />
          {categoryQuery ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-label="清空类目搜索"
                    onClick={() => setCategoryQuery("")}
                    className="absolute top-1/2 right-1.5 grid size-6 -translate-y-1/2 cursor-pointer place-items-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  />
                }
              >
                <X aria-hidden className="size-3.5" />
              </TooltipTrigger>
              <TooltipContent>清空类目搜索</TooltipContent>
            </Tooltip>
          ) : null}
          {categoryQuery.trim() ? (
            <div
              role="listbox"
              aria-label="类目搜索结果"
              className="absolute top-[calc(100%+0.375rem)] right-0 left-0 z-50 max-h-52 overflow-y-auto overscroll-contain rounded-lg border border-border bg-popover shadow-overlay"
            >
              {categoryResults.length ? (
                categoryResults.map((leaf) => (
                  <button
                    key={`${leaf.descriptionCategoryId}-${leaf.typeId}`}
                    type="button"
                    role="option"
                    data-type-id={leaf.typeId}
                    className="flex w-full cursor-pointer border-b border-border/60 px-3 py-2 text-left last:border-0 outline-none hover:bg-brand-soft focus-visible:bg-brand-soft focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
                    onClick={() => {
                      onSelectType(leaf.descriptionCategoryId, leaf.typeId)
                      setCategoryQuery("")
                    }}
                  >
                    <span className="min-w-0 text-xs font-medium whitespace-nowrap text-foreground">
                      <span className="block truncate">{leaf.pathLabel}</span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-3 text-center text-meta text-muted-foreground">
                  没有匹配类目
                </p>
              )}
            </div>
          ) : null}
        </div>
      </div>
      {loading && tree.length === 0 ? (
        <div className="grid gap-2" data-category-tree-skeleton="" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      ) : null}
      {leafChosen ? (
        <div className="flex min-w-0 items-center gap-1.5">
          <p
            className="min-w-0 flex-1 truncate text-meta whitespace-nowrap text-muted-foreground"
            aria-label={`已选类目 ${pathLabel}`}
          >
            {pathLabel}
          </p>
          <button
            type="button"
            aria-label="清除已选类目"
            onClick={() => onSelectL1(0)}
            className="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}

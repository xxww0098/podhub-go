/** Row filtering, presets and pagination share the same readiness predicate. */
import { useEffect, useMemo, useRef, useState } from "react"
import { Search, ChevronLeft, ChevronRight } from "lucide-react"
import type { SupplierDbRow } from "@/bindings/http-supplier-dbs"
import type { CategoryTreeNodeView } from "@/bindings/commands"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { missingReadiness } from "./supplier-readiness"
import { categoryShortLabel } from "./supplier-prop-editors"

/** 状态筛选（就绪口径）：全部 / 就绪 / 待完善（缺项）/ 待复核（类目更新待人工）。 */
export type SupplierDbRowStatus =
  | "all"
  | "ready"
  | "incomplete"
  | "needs_review"

/** 状态筛选谓词——筛选与统计页签共用同一刀，两处不会漂。 */
export function rowMatchesStatus(
  row: SupplierDbRow,
  status: SupplierDbRowStatus,
): boolean {
  if (status === "ready") return missingReadiness(row).length === 0
  if (status === "incomplete") return missingReadiness(row).length > 0
  if (status === "needs_review") {
    return row.denial === "config_needs_reconfiguration"
  }
  return true
}

type PublishFilter = "all" | "published" | "unpublished"

/**
 * Base UI Select 收起时只认 `items` 里的 label。不传时触发器显示 value
 * （all / incomplete），和菜单里的中文对不上。
 */
const STATUS_FILTERS: ReadonlyArray<{
  value: SupplierDbRowStatus
  label: string
}> = [
  { value: "all", label: "全部状态" },
  { value: "ready", label: "就绪" },
  { value: "incomplete", label: "待完善" },
  { value: "needs_review", label: "待复核" },
]

const PUBLISH_FILTERS: ReadonlyArray<{
  value: PublishFilter
  label: string
}> = [
  { value: "all", label: "全部上架状态" },
  { value: "published", label: "已上架" },
  { value: "unpublished", label: "未上架" },
]

/** 类目筛选值："none" = 未设类目，其余为 `descriptionCategoryId:typeId`。 */
const rowCategoryKey = (row: SupplierDbRow): string =>
  row.descriptionCategoryId == null
    ? "none"
    : `${row.descriptionCategoryId}:${row.typeId ?? ""}`

const PAGE_SIZE_OPTIONS = [5, 10, 20, 50] as const
const PAGE_SIZE_ITEMS = PAGE_SIZE_OPTIONS.map((size) => ({
  value: String(size),
  label: `${size} 条/页`,
}))

/** 页码窗口：≤7 全展示；否则两端 + 当前页邻位，中间以省略号占位。 */
export function pageList(page: number, count: number): Array<number | "…"> {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i + 1)
  const items: Array<number | "…"> = [1]
  const start = Math.max(2, page - 1)
  const end = Math.min(count - 1, page + 1)
  if (start > 2) items.push("…")
  for (let i = start; i <= end; i++) items.push(i)
  if (end < count - 1) items.push("…")
  items.push(count)
  return items
}

export function useSupplierDbFilters(rows: SupplierDbRow[], categoryTree: CategoryTreeNodeView[]) {
  const [query, setQuery] = useState("")
  const [statusFilter, setStatusFilter] = useState<SupplierDbRowStatus>("all")
  const [publishFilter, setPublishFilter] = useState<PublishFilter>("all")
  const [categoryFilter, setCategoryFilter] = useState("all")
  const [pageSize, setPageSize] = useState(10)
  const [page, setPage] = useState(1)
  const searchRef = useRef<HTMLInputElement>(null)
  /** 非归档行 — 归档行不进商品表（docs §4）；统计页签与筛选都在这个口径上。 */
  const liveRows = useMemo(() => rows.filter((row) => !row.archived), [rows])

  const statCounts = useMemo(
    () => ({
      all: liveRows.length,
      published: liveRows.filter((row) => row.published).length,
      incomplete: liveRows.filter(
        (row) => missingReadiness(row).length > 0,
      ).length,
    }),
    [liveRows],
  )

  /** 类目筛选选项 = 库里实际出现的坐标，标签借类目树解析。 */
  const categoryOptions = useMemo(() => {
    const labels = new Map<string, string>()
    for (const row of liveRows) {
      const key = rowCategoryKey(row)
      if (!labels.has(key)) {
        labels.set(
          key,
          key === "none"
            ? "未设置类目"
            : categoryShortLabel(
                row.descriptionCategoryId,
                row.typeId,
                categoryTree,
              ) || `类目 ${row.descriptionCategoryId}`,
        )
      }
    }
    return [...labels.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], "zh"),
    )
  }, [liveRows, categoryTree])
  const categoryFilterItems = useMemo(
    () => [
      { value: "all", label: "全部类目" },
      ...categoryOptions.map(([value, label]) => ({ value, label })),
    ],
    [categoryOptions],
  )

  const filteredRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return liveRows.filter((row) => {
      if (
        needle &&
        !row.title.toLowerCase().includes(needle) &&
        !row.platformCode.toLowerCase().includes(needle)
      ) {
        return false
      }
      if (!rowMatchesStatus(row, statusFilter)) return false
      if (publishFilter === "published" && !row.published) return false
      if (publishFilter === "unpublished" && row.published) return false
      if (categoryFilter !== "all" && rowCategoryKey(row) !== categoryFilter) {
        return false
      }
      return true
    })
  }, [liveRows, query, statusFilter, publishFilter, categoryFilter])

  // 任何收窄都回第一页——停在旧页码会落空或跳视角。
  useEffect(() => {
    setPage(1)
  }, [query, statusFilter, publishFilter, categoryFilter, pageSize])

  const pageCount = Math.max(1, Math.ceil(filteredRows.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = useMemo(
    () => filteredRows.slice((safePage - 1) * pageSize, safePage * pageSize),
    [filteredRows, safePage, pageSize],
  )

  /** 统计页签 = 行筛选预设：上架/就绪两轴一起摆到对应组合。 */
  const activeStat =
    publishFilter === "all" && statusFilter === "all"
      ? "all"
      : publishFilter === "published" && statusFilter === "all"
        ? "published"
        : publishFilter === "all" && statusFilter === "incomplete"
          ? "incomplete"
          : null
  const applyStat = (stat: "all" | "published" | "incomplete") => {
    if (stat === "published") {
      setPublishFilter("published")
      setStatusFilter("all")
    } else if (stat === "incomplete") {
      setPublishFilter("all")
      setStatusFilter("incomplete")
    } else {
      setPublishFilter("all")
      setStatusFilter("all")
    }
  }

  return { query, setQuery, statusFilter, setStatusFilter, publishFilter, setPublishFilter, categoryFilter, setCategoryFilter,
    pageSize, setPageSize, page: safePage, setPage, pageCount, pageRows, liveRows, filteredRows, categoryFilterItems, statCounts, activeStat, applyStat, searchRef }
}
type Filters = ReturnType<typeof useSupplierDbFilters>

/**
 * 筛选/分页共用的下拉。Base UI Select 收起时只认 `items` 里的 label，
 * 所以触发器与菜单选项必须同源；`filterName` 落到 data-filter 测试锚点。
 */
function FilterSelect<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  filterName,
  className = "cursor-pointer",
  align,
}: {
  items: ReadonlyArray<{ value: T; label: string }>
  value: T
  onChange: (next: T) => void
  ariaLabel: string
  filterName?: string
  className?: string
  align?: "start" | "center" | "end"
}) {
  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
    >
      <SelectTrigger
        size="sm"
        aria-label={ariaLabel}
        data-filter={filterName}
        className={className}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent align={align}>
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            className="cursor-pointer"
          >
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function SupplierDbFilterBar({ filters }: { filters: Filters }) {
  const { query, setQuery, statusFilter, setStatusFilter, publishFilter, setPublishFilter, categoryFilter, setCategoryFilter, categoryFilterItems, searchRef } = filters
  return (
      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <div className="w-full min-w-0 shrink-0 sm:w-56">
          <InputGroup>
            <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
            <InputGroupInput ref={searchRef} type="search" aria-label="搜索商品" placeholder="搜索商品名称或编号…" title="搜索名称或编号（/ 聚焦）" value={query} onChange={(event) => setQuery(event.target.value)} />
          </InputGroup>
        </div>
        <FilterSelect
          items={STATUS_FILTERS}
          value={statusFilter}
          onChange={setStatusFilter}
          ariaLabel="状态筛选"
          filterName="status"
        />
        <FilterSelect
          items={categoryFilterItems}
          value={categoryFilter}
          onChange={setCategoryFilter}
          ariaLabel="类目筛选"
          filterName="category"
          className="max-w-48 cursor-pointer"
        />
        <FilterSelect
          items={PUBLISH_FILTERS}
          value={publishFilter}
          onChange={setPublishFilter}
          ariaLabel="上架状态筛选"
          filterName="publish"
        />
      </div>

  )
}
export function SupplierDbPagination({ filters }: { filters: Filters }) {
  const { filteredRows, liveRows, page: safePage, pageCount, setPage, pageSize, setPageSize } = filters
  return (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2">
          <span className="text-meta text-faint-foreground tabular-nums">
            共 {filteredRows.length} 条
            {filteredRows.length !== liveRows.length
              ? `（全部 ${liveRows.length} 条）`
              : ""}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="上一页"
              disabled={safePage <= 1}
              className="cursor-pointer"
              onClick={() => setPage(safePage - 1)}
            >
              <ChevronLeft aria-hidden />
            </Button>
            {pageList(safePage, pageCount).map((item, index) =>
              item === "…" ? (
                <span
                  key={`gap-${index}`}
                  aria-hidden
                  className="px-1 text-meta text-faint-foreground"
                >
                  …
                </span>
              ) : (
                <Button
                  key={item}
                  type="button"
                  variant={item === safePage ? "brand" : "ghost"}
                  size="icon-sm"
                  aria-label={`第 ${item} 页`}
                  aria-current={item === safePage ? "page" : undefined}
                  className="cursor-pointer"
                  data-page={item}
                  onClick={() => setPage(item)}
                >
                  {item}
                </Button>
              ),
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="下一页"
              disabled={safePage >= pageCount}
              className="cursor-pointer"
              onClick={() => setPage(safePage + 1)}
            >
              <ChevronRight aria-hidden />
            </Button>
            <FilterSelect
              items={PAGE_SIZE_ITEMS}
              value={String(pageSize)}
              onChange={(next) => setPageSize(Number(next))}
              ariaLabel="每页条数"
              align="end"
            />
          </div>
        </div>
  )
}

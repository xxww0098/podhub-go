/**
 * 画廊工具条 + 结果带（图 1 形态）——
 *
 * 工具条一行扫完：搜索吃掉余量，facet 下拉/价格区间/排序收紧到刚好，
 * 尾部是 刷新 + 密度分段 + 收藏筛 + 「上架清单」入口（`tray` 槽由画廊塞入
 * ListingQueueTray 的 toolbar 形态）。
 * 结果带左「共 N 件商品」，右「已选条件」chips + 清空筛选——库/类目两个
 * 下拉各镜像一枚 chip，挑了哪一档、还能摘掉，在这条上能读完。
 */
import { useId, type ReactNode, type RefObject } from "react"
import {
  Heart,
  LayoutGrid,
  RefreshCw,
  Rows2,
  Rows3,
  Search,
  X,
  type LucideIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

import {
  DENSITY_LABELS,
  SORT_LABELS,
  type GalleryDensity,
  type GalleryFacet,
  type GallerySort,
} from "./gallery-model"

/** 「全部」选项的 Select 值——空串留给 filters，哨兵给控件。 */
const ALL = "__all__"

/** 密度分段图标：compact 最密、large 最稀疏（DENSITY_LABELS 保留作提示文案）。 */
const DENSITY_ICONS: Record<GalleryDensity, LucideIcon> = {
  compact: Rows3,
  standard: LayoutGrid,
  large: Rows2,
}

export function GalleryToolbar({
  searchRef,
  query,
  onQueryChange,
  dbFacet,
  catFacet,
  priceMin,
  priceMax,
  priceMinInvalid,
  priceMaxInvalid,
  onPriceMinChange,
  onPriceMaxChange,
  sort,
  onSortChange,
  density,
  onDensityChange,
  favOnly,
  favoriteCount,
  onFavOnlyChange,
  refreshing,
  onRefresh,
  tray,
}: {
  searchRef: RefObject<HTMLInputElement | null>
  /** 关键词草稿（输入即筛，250ms 提交由画廊负责）。 */
  query: string
  onQueryChange: (next: string) => void
  /** 库 facet；undefined = 单库目录，控件让位不渲染。 */
  dbFacet?: {
    items: GalleryFacet[]
    /** "" = 全部平台货源。 */
    value: string
    /** 当前库名（选中态的 trigger/chip 文案）。 */
    label: string
    onChange: (value: string) => void
  }
  catFacet: {
    items: GalleryFacet[]
    value: string
    label: string
    onChange: (value: string) => void
  }
  /** 价格区间草稿；invalid 标记不合法的未提交输入。 */
  priceMin: string
  priceMax: string
  priceMinInvalid: boolean
  priceMaxInvalid: boolean
  onPriceMinChange: (value: string) => void
  onPriceMaxChange: (value: string) => void
  sort: GallerySort
  onSortChange: (next: GallerySort) => void
  density: GalleryDensity
  onDensityChange: (next: GalleryDensity) => void
  /** 「只看收藏」视图态开关与收藏总数。 */
  favOnly: boolean
  favoriteCount: number
  onFavOnlyChange: (next: boolean) => void
  refreshing?: boolean
  onRefresh?: () => void
  /** 行尾动作槽——画廊塞入上架清单浮窗的 toolbar 形态。 */
  tray?: ReactNode
}) {
  const searchId = useId()

  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="relative min-w-44 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          aria-hidden
        />
        <Input
          ref={searchRef}
          id={searchId}
          type="search"
          aria-label="搜索商品"
          value={query}
          placeholder="搜索商品名称、编号或标签"
          className="h-9 pr-8 pl-8 [&::-webkit-search-cancel-button]:hidden"
          onChange={(event) => onQueryChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") onQueryChange("")
          }}
        />
        {query ? (
          <button
            type="button"
            aria-label="清空搜索"
            className="absolute top-1/2 right-1.5 inline-flex size-5 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              onQueryChange("")
              searchRef.current?.focus()
            }}
          >
            <X className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
      {dbFacet ? (
        <FacetSelect
          label="平台货源"
          allLabel="全部平台货源"
          items={dbFacet.items}
          value={dbFacet.value}
          currentLabel={dbFacet.label}
          onChange={dbFacet.onChange}
        />
      ) : null}
      <FacetSelect
        label="类目"
        allLabel="全部类目"
        items={catFacet.items}
        value={catFacet.value}
        currentLabel={catFacet.label}
        onChange={catFacet.onChange}
      />
      {/* 价格是卖家输入的区间，不是预制分段：两个 元 输入框，空 = 不限。 */}
      <div
        role="group"
        aria-label="价格区间"
        data-gallery-price-range=""
        className="flex h-9 items-center gap-1.5"
      >
        <PriceBoundInput
          label="最低价"
          value={priceMin}
          invalid={priceMinInvalid}
          onChange={onPriceMinChange}
        />
        <span aria-hidden className="text-muted-foreground">
          –
        </span>
        <PriceBoundInput
          label="最高价"
          value={priceMax}
          invalid={priceMaxInvalid}
          onChange={onPriceMaxChange}
        />
      </div>
      <Select
        value={sort}
        onValueChange={(next) => {
          if (next) onSortChange(next as GallerySort)
        }}
      >
        <SelectTrigger aria-label="排序" className="h-9 w-32 cursor-pointer">
          <SelectValue>{() => SORT_LABELS[sort]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(SORT_LABELS) as GallerySort[]).map((option) => (
            <SelectItem key={option} value={option} className="cursor-pointer">
              {SORT_LABELS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* 尾部控件（刷新 + 密度 + 收藏筛 + 清单入口）是一组：工具行换行时它们
          整体下移，收藏筛不会自己单落一行。 */}
      <div className="flex shrink-0 items-center gap-2">
        {onRefresh ? (
          <Button
            type="button"
            variant="outline"
            className="cursor-pointer"
            disabled={refreshing}
            onClick={onRefresh}
          >
            <RefreshCw
              aria-hidden
              className={refreshing ? "animate-spin" : undefined}
            />
            刷新
          </Button>
        ) : null}
        <div
          role="radiogroup"
          aria-label="密度"
          data-gallery-density-toggle=""
          className="inline-flex items-center gap-0.5 self-center rounded-lg border border-border bg-card p-0.5"
        >
          {(Object.keys(DENSITY_LABELS) as GalleryDensity[]).map((option) => {
            const Icon = DENSITY_ICONS[option]
            return (
              <Button
                key={option}
                type="button"
                size="icon-sm"
                variant={density === option ? "default" : "ghost"}
                role="radio"
                aria-checked={density === option}
                aria-label={DENSITY_LABELS[option]}
                className="cursor-pointer"
                onClick={() => onDensityChange(option)}
              >
                <Icon aria-hidden />
              </Button>
            )
          })}
        </div>
        <Button
          type="button"
          size="icon"
          variant={favOnly ? "secondary" : "outline"}
          aria-pressed={favOnly}
          aria-label={
            favoriteCount ? `只看收藏（${favoriteCount}）` : "只看收藏"
          }
          title={favoriteCount ? `只看收藏（${favoriteCount}）` : "只看收藏"}
          data-gallery-favonly=""
          className={cn(
            "cursor-pointer",
            favOnly && "border-st-attest/50 bg-st-attest-soft text-st-attest-ink",
          )}
          onClick={() => onFavOnlyChange(!favOnly)}
        >
          <Heart
            aria-hidden
            className={cn(favOnly && "fill-current text-st-attest-ink")}
          />
        </Button>
        {tray}
      </div>
    </div>
  )
}

/**
 * 结果带——左「共 N 件商品」活计数，右「已选条件」chips + 清空筛选。
 * 库/类目下拉的当前档也镜像成 chip：默认档（全部平台货源/全部类目）照列，
 * × 即是把那档清回「全部」。
 */
export function GalleryResultBar({
  count,
  chips,
  onClearAll,
}: {
  count: string
  chips: ReadonlyArray<{ key: string; label: string; onRemove: () => void }>
  onClearAll: () => void
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
      data-gallery-resultbar=""
    >
      <p
        className="text-xs text-muted-foreground tabular-nums"
        aria-live="polite"
        data-gallery-count=""
      >
        {count}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs text-muted-foreground">已选条件：</span>
        {chips.map((chip) => (
          <FilterChip key={chip.key} label={chip.label} onRemove={chip.onRemove} />
        ))}
        <Button
          type="button"
          size="xs"
          variant="link"
          className="cursor-pointer"
          onClick={onClearAll}
        >
          清空筛选
        </Button>
      </div>
    </div>
  )
}

/**
 * One narrowing statement with its own way out — each chip is the only control
 * that removes its own term.
 */
function FilterChip({ label, onRemove }: { label: string; onRemove: () => void }) {
  return (
    <span
      className="inline-flex h-6 items-center gap-0.5 rounded-full bg-brand-soft pr-1 pl-2.5 text-xs text-brand-ink"
      data-gallery-chip=""
    >
      {label}
      <button
        type="button"
        aria-label={`移除筛选 ${label}`}
        className="inline-flex size-4 cursor-pointer items-center justify-center rounded-full hover:bg-brand-ink/10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
        onClick={onRemove}
      >
        <X className="size-3" aria-hidden />
      </button>
    </span>
  )
}

/** 库/类目共用的 facet 下拉：「全部{域}」哨兵项 + 计数项，空值落回全部档。 */
function FacetSelect({
  label,
  allLabel,
  items,
  value,
  currentLabel,
  onChange,
}: {
  /** 无障碍名，也是下拉域的名字（「平台货源」/「类目」）。 */
  label: string
  /** 「全部」档文案；value 为空串时 trigger 也显示它。 */
  allLabel: string
  items: GalleryFacet[]
  /** "" = 全部档。 */
  value: string
  /** 当前档名（trigger 文案）。 */
  currentLabel: string
  onChange: (value: string) => void
}) {
  return (
    <Select
      value={value || ALL}
      onValueChange={(next) => onChange(next === ALL || !next ? "" : next)}
    >
      <SelectTrigger aria-label={label} className="h-9 w-32 cursor-pointer">
        <SelectValue>{() => (value ? currentLabel : allLabel)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL} className="cursor-pointer">
          {allLabel}
        </SelectItem>
        {items.map((item) => (
          <SelectItem
            key={item.value}
            value={item.value}
            className="cursor-pointer"
          >
            {item.label} ({item.count})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/**
 * One 元 bound of the price range. Empty = unbounded; junk (negative or
 * unparseable) keeps the field marked invalid and never reaches the filter.
 */
function PriceBoundInput({
  label,
  value,
  invalid,
  onChange,
}: {
  label: string
  value: string
  invalid: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="relative">
      <span
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-xs text-muted-foreground"
      >
        ¥
      </span>
      <Input
        type="number"
        min={0}
        step={0.01}
        inputMode="decimal"
        aria-label={label}
        placeholder={label}
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-24 pl-6 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  )
}

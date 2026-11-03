/**
 * 画廊工具条 + 结果带（图 1 形态）——
 *
 * 工具条将搜索、筛选和页面操作按空间横向排列；结果带（`results` 槽）：
 * 左「共 N 件商品」，右「已选条件」chips + 清空筛选，只列生效中的条件。
 */
import { useId, type ReactNode, type RefObject } from "react"
import {
  FilterX,
  Heart,
  Search,
  X,
} from "lucide-react"

import { IconButton } from "@/components/ui/icon-button"
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
  SORT_LABELS,
  type GalleryFacet,
  type GallerySort,
} from "./gallery-model"

/** 「全部」选项的 Select 值——空串留给 filters，哨兵给控件。 */
const ALL = "__all__"

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
  favOnly,
  favoriteCount,
  onFavOnlyChange,
  tray,
  results,
}: {
  searchRef: RefObject<HTMLInputElement | null>
  /** 关键词草稿（输入即筛，250ms 提交由画廊负责）。 */
  query: string
  onQueryChange: (next: string) => void
  /** 库 facet；undefined = 单库目录，控件让位不渲染。 */
  dbFacet?: {
    items: GalleryFacet[]
    /** "" = 全部平台商品库。 */
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
  /** 「只看收藏」视图态开关与收藏总数。 */
  favOnly: boolean
  favoriteCount: number
  onFavOnlyChange: (next: boolean) => void
  /** 行尾动作槽——画廊塞入上架清单浮窗的 toolbar 形态。 */
  tray?: ReactNode
  results?: ReactNode
}) {
  const searchId = useId()

  return (
    <div data-slot="gallery-toolbar" className="flex min-w-0 flex-col gap-2">
      <div data-gallery-controls="" className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="relative min-w-40 flex-[1_1_16rem] sm:max-w-80">
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
            placeholder="搜索名称、编号、标签或类目"
            className="h-9 pr-8 pl-8 max-md:h-11 max-md:pr-11 [&::-webkit-search-cancel-button]:hidden"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onQueryChange("")
            }}
          />
          {query ? (
            <IconButton
              icon={X}
              label="清空搜索"
              size="icon-xs"
              variant="ghost"
              className="absolute inset-y-0 right-0 my-auto rounded-full"
              onClick={() => {
                onQueryChange("")
                searchRef.current?.focus()
              }}
            />
          ) : null}
        </div>
        <Select
          value={sort}
          onValueChange={(next) => {
            if (next) onSortChange(next as GallerySort)
          }}
        >
          <SelectTrigger aria-label="排序" className="h-9 w-26 cursor-pointer">
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
        {dbFacet ? (
          <FacetSelect
            label="平台商品库"
            allLabel="全部平台商品库"
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
          className="flex h-9 items-center gap-1.5 max-md:h-11"
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
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 max-md:w-full">
          <IconButton
            icon={Heart}
            iconClassName={cn(favOnly && "fill-current text-st-attest-ink")}
            label={favoriteCount ? `只看收藏（${favoriteCount}）` : "只看收藏"}
            size="icon-sm"
            variant={favOnly ? "secondary" : "outline"}
            aria-pressed={favOnly}
            data-gallery-favonly=""
            className={cn(favOnly && "border-st-attest/50 bg-st-attest-soft text-st-attest-ink")}
            onClick={() => onFavOnlyChange(!favOnly)}
          />
          {tray}
        </div>
      </div>
      {results}
    </div>
  )
}

/**
 * 结果带——左「共 N 件商品」活计数，右「已选条件」chips + 清空筛选。
 * 只列真正在收窄结果的条件（库/类目选了某一档、价格、标签、关键词），
 * 默认的「全部」档不占位；没有计数也没有条件时整条不渲染。
 */
export function GalleryResultBar({
  count,
  chips,
  onClearAll,
  selection,
}: {
  count: string
  chips: ReadonlyArray<{ key: string; label: string; onRemove: () => void }>
  onClearAll: () => void
  selection?: ReactNode
}) {
  if (!count && chips.length === 0) return null
  return (
    <div
      className="flex min-h-6 min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5"
      data-gallery-resultbar=""
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-4">
        {selection}
        <p
          className="text-sm text-muted-foreground tabular-nums"
          aria-live="polite"
          data-gallery-count=""
        >
          {count}
        </p>
      </div>
      {chips.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <FilterChip key={chip.key} label={chip.label} onRemove={chip.onRemove} />
          ))}
          <IconButton
            icon={FilterX}
            label="清空筛选"
            variant="ghost"
            size="icon-xs"
            onClick={onClearAll}
          />
        </div>
      ) : null}
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
      className="inline-flex h-6 items-center gap-0.5 rounded-full bg-brand-soft pr-1 pl-2.5 text-xs text-brand-ink max-md:h-11 max-md:pr-0"
      data-gallery-chip=""
    >
      {label}
      <IconButton
        icon={X}
        label={`移除筛选 ${label}`}
        size="icon-xs"
        variant="ghost"
        className="size-4 rounded-full text-brand-ink hover:bg-brand-ink/10"
        onClick={onRemove}
      />
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
  /** 无障碍名，也是下拉域的名字（「平台商品库」/「类目」）。 */
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
      <SelectTrigger
        aria-label={label}
        className={cn("h-9 w-26 cursor-pointer", label === "平台商品库" && "w-32")}
      >
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
        className="h-9 w-20 pl-6 max-md:h-11 [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </div>
  )
}

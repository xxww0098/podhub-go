/**
 * 平台商品库列表（卖家端货盘）。
 *
 * 参考图 1 的形态：顶部一行工具条（搜索 + 库/类目下拉 + 价格区间 + 排序 +
 * 收藏筛，「上架清单」与批量上架入口收在行尾——gallery-toolbar.tsx），
 * 「共 N 件商品」计数行 + 已选条件 chips，接着是商品卡片，右下角极简翻页。
 * 选品模式（`picking`，屏从 `?pick=1` 读）把清单浮窗开局就摊开：从「批量上架」
 * 进来的人先看到下一步，而不是自己找入口。
 * 没有左栏——facet 全部收进下拉；固定 tags 由搜索词与 `?tags=` 深链覆盖。
 * 点击商品海报打开只读详情页（屏级受控的 `detail`），主动作「进入上架」交给
 * app 导航；物流注入保留为独立次动作。
 */
import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type {
  SellerSupplierDbCatalogData,
  SellerSupplierDbRowData,
} from "@/bindings/http-supplier-dbs-catalog"
import { useScreenActive } from "@/components/screen-pane"
import { Checkbox } from "@/components/ui/checkbox"

import { GalleryCard } from "./gallery-card"
import { GalleryDetail } from "./gallery-detail"
import { GalleryEmpty } from "./gallery-empty"
import {
  EMPTY_FILTERS,
  GALLERY_PAGE_SIZE,
  categoryFacets,
  categoryIndex,
  categoryLabelFor,
  categoryLabelOf,
  catalogListingIdentity,
  dbFacets,
  filterGallery,
  groupGalleryRows,
  hasFacetFilters,
  normalizePriceYuan,
  paginate,
  priceRangeLabel,
  propDefsFor,
  queryRows,
  typeLabelFor,
  variantsForRow,
  type CatalogListingIdentity,
  type GalleryFilters,
  type GallerySort,
} from "./gallery-model"
import { GalleryPager } from "./gallery-pager"
import { GalleryResultBar, GalleryToolbar } from "./gallery-toolbar"
import { ListingQueueTray } from "./listing-queue-tray"
import { useGalleryCollection } from "./listing-queue"

export function SupplierDbsGallery({
  catalog,
  filters,
  onFiltersChange,
  categoryTree,
  detail,
  onOpenDetail,
  picking = false,
  onOpenListing,
  onOpenShipping,
  refreshing,
  onRefresh,
}: {
  catalog: SellerSupplierDbCatalogData
  filters: GalleryFilters
  onFiltersChange: (next: GalleryFilters) => void
  categoryTree: CategoryTreeNodeView[]
  /** 打开的行详情页——屏级受控：壳层面包屑要知道正在看哪个商品。 */
  detail?: SellerSupplierDbRowData
  /** 打开该商品的详情页。 */
  onOpenDetail: (row: SellerSupplierDbRowData) => void
  /**
   * 选品模式（屏从 `?pick=1` 读）：清单浮窗开局即摊开——从「批量上架」进来的
   * 人第一眼就看到「下一步」；模式条在屏上（catalog-screen）。
   */
  picking?: boolean
  /** 单件（详情页）或批量（上架清单）都只递最小商品身份数组。 */
  onOpenListing: (products: CatalogListingIdentity[]) => void | Promise<void>
  onOpenShipping: (row: SellerSupplierDbRowData) => void
  /** 打开清单与批量进入上架前重读货盘。 */
  refreshing?: boolean
  onRefresh?: () => Promise<SellerSupplierDbRowData[] | undefined>
}) {
  const screenActive = useScreenActive()
  const searchRef = useRef<HTMLInputElement>(null)
  const [draftQuery, setDraftQuery] = useState(filters.q)
  // 价格区间是卖家输入的两个草稿；与关键词同拍：输入合法就上屏，未输完保留前值。
  const [draftPriceMin, setDraftPriceMin] = useState(filters.priceMin)
  const [draftPriceMax, setDraftPriceMax] = useState(filters.priceMax)
  const [page, setPage] = useState(1)
  const [sort, setSort] = useState<GallerySort>("listed-desc")
  // 收藏/上架清单：本机选品草稿（listing-queue.ts），「只看收藏」是视图态不进 URL。
  const collection = useGalleryCollection()
  const [favOnly, setFavOnly] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  // 选品模式开局把清单摊开；卖家自己收起来后 picking 不再变，不会自己弹回。
  useEffect(() => {
    setQueueOpen(picking)
  }, [picking])
  const catIndex = useMemo(() => categoryIndex(categoryTree), [categoryTree])

  // The draft follows the committed query only: a seller who typed a keyword
  // and then clicked a facet keeps the text.
  useEffect(() => {
    setDraftQuery(filters.q)
  }, [filters.q])

  // 外部改区间（chip 移除 / 清除筛选）时，草稿跟上已提交值。
  useEffect(() => {
    setDraftPriceMin(filters.priceMin)
    setDraftPriceMax(filters.priceMax)
  }, [filters.priceMin, filters.priceMax])

  useEffect(() => {
    setPage(1)
  }, [filters.db, filters.cat, filters.priceMin, filters.priceMax, filters.q, filters.tags, sort, favOnly])

  // Typing filters. Search is a browsing act: it must not require Enter.
  const latest = useRef({ filters, onFiltersChange })
  latest.current = { filters, onFiltersChange }
  useEffect(() => {
    const next = draftQuery.trim()
    if (next === latest.current.filters.q) return
    const timer = setTimeout(() => {
      latest.current.onFiltersChange({ ...latest.current.filters, q: next })
    }, 250)
    return () => clearTimeout(timer)
  }, [draftQuery])

  // Same beat as the keyword: a bound commits once it parses; junk (negative or
  // unparseable) stays in the input and out of the filter.
  useEffect(() => {
    const min = normalizePriceYuan(draftPriceMin)
    const max = normalizePriceYuan(draftPriceMax)
    if (min === null || max === null) return
    if (min === latest.current.filters.priceMin && max === latest.current.filters.priceMax) return
    const timer = setTimeout(() => {
      latest.current.onFiltersChange({ ...latest.current.filters, priceMin: min, priceMax: max })
    }, 250)
    return () => clearTimeout(timer)
  }, [draftPriceMin, draftPriceMax])

  // "/" focuses the search box, the way a catalog is scanned.
  useEffect(() => {
    if (!screenActive) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [screenActive])

  const rows = catalog.rows
  // The keyword-matched rows: the facet rail counts from these, so a count and
  // the list it opens can never disagree.
  const railRows = useMemo(() => queryRows(rows, filters.q, catIndex), [rows, filters.q, catIndex])
  const matched = useMemo(() => {
    const listed = filterGallery(rows, filters, catIndex, sort)
    const visible = favOnly
      ? listed.filter((row) => collection.favoriteIds.has(row.productId))
      : listed
    return groupGalleryRows(visible)
  }, [rows, filters, catIndex, sort, favOnly, collection.favoriteIds])
  const paged = paginate(matched, page, GALLERY_PAGE_SIZE)
  const selectableRows = paged.rows.filter((group) => group.rows.length === 1).map((group) => group.row)
  const selectedCount = selectableRows.filter((row) => collection.queueIds.has(row.productId)).length
  const favoriteCount = useMemo(
    () => rows.filter((row) => collection.favoriteIds.has(row.productId)).length,
    [rows, collection.favoriteIds],
  )
  const query = filters.q.trim()
  const emptyKind =
    rows.length === 0
      ? "empty"
      : matched.length === 0
        ? favOnly && !query && !hasFacetFilters(filters)
          ? "fav"
          : query && !hasFacetFilters(filters) && !favOnly
            ? "search"
            : "zero"
        : null

  const dbName = (sourceId: string) =>
    catalog.dbs.find((db) => db.source_id === sourceId)?.name ?? sourceId

  /** 库/类目下拉的当前档只在选了某一档时镜像成 chip；价格/标签/关键词同理。 */
  const catLabel = filters.cat
    ? categoryLabelFor(Number(filters.cat), catIndex) || `类目 ${filters.cat}`
    : "全部类目"
  const chips: Array<{ key: string; label: string; onRemove: () => void }> = []
  if (catalog.dbs.length > 1 && filters.db) {
    chips.push({
      key: "db",
      label: dbName(filters.db),
      // A category belongs to one 库, so dropping the 库 drops it too.
      onRemove: () => onFiltersChange({ ...filters, db: "", cat: "" }),
    })
  }
  if (filters.cat) {
    chips.push({
      key: "cat",
      label: catLabel,
      onRemove: () => onFiltersChange({ ...filters, cat: "" }),
    })
  }
  if (filters.priceMin || filters.priceMax) {
    chips.push({
      key: "price",
      label: `价格 ${priceRangeLabel(filters.priceMin, filters.priceMax)}`,
      onRemove: () => onFiltersChange({ ...filters, priceMin: "", priceMax: "" }),
    })
  }
  for (const tag of filters.tags) {
    chips.push({
      key: "tag-" + tag,
      label: `标签 ${tag}`,
      onRemove: () =>
        onFiltersChange({ ...filters, tags: filters.tags.filter((item) => item !== tag) }),
    })
  }
  if (query) {
    chips.push({
      key: "q",
      label: `关键词 ${query}`,
      onRemove: () => onFiltersChange({ ...filters, q: "" }),
    })
  }
  const specificationCount = matched.reduce((count, group) => count + group.rows.length, 0)
  const resultCount = `${matched.length} 件商品${specificationCount !== matched.length ? ` · ${specificationCount} 个规格` : ""}`
  const countLabel = emptyKind
    ? ""
    : query
      ? `为「${query}」找到 ${resultCount}`
      : `共 ${resultCount}`

  // 类目下拉在已选库范围内，计数与商品卡片同口径。价格是输入区间，无 facet。
  const catItems = categoryFacets(railRows, filters.db, catIndex)
  const dbItems = dbFacets(catalog.dbs, railRows)

  const invalidPriceMin = draftPriceMin.trim() !== "" && normalizePriceYuan(draftPriceMin) === null
  const invalidPriceMax = draftPriceMax.trim() !== "" && normalizePriceYuan(draftPriceMax) === null

  // 上架清单入口：画廊里是工具行尾的常态按钮（toolbar 形态），详情页/空态
  // 换成右下角悬浮钮（fab 形态），三个落点渲染同一份配置。
  const queueTray = (variant: "fab" | "toolbar") => (
    <ListingQueueTray
      variant={variant}
      open={queueOpen}
      onOpenChange={(open) => {
        setQueueOpen(open)
        if (open) onRefresh?.()
      }}
      refreshing={refreshing}
      refreshRows={onRefresh}
      rows={rows}
      onOpenDetail={(row) => {
        setQueueOpen(false)
        onOpenDetail(row)
      }}
      onOpenListing={onOpenListing}
    />
  )

  // 详情页保留当前列表的页码、排序、搜索与价格草稿。
  if (detail) {
    return (
      <div
        className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2"
        data-gallery=""
      >
        <GalleryDetail
          row={detail}
          variantRows={variantsForRow(rows, detail)}
          propDefs={propDefsFor(catalog, detail.sourceId)}
          categoryLabel={categoryLabelFor(
            detail.descriptionCategoryId ?? 0,
            catIndex,
          )}
          typeLabel={typeLabelFor(
            detail.descriptionCategoryId,
            detail.typeId,
            categoryTree,
          )}
          onOpenListing={(item) => onOpenListing([catalogListingIdentity(item)])}
          onSelectVariant={onOpenDetail}
          onOpenShipping={onOpenShipping}
        />
        {queueTray("fab")}
      </div>
    )
  }

  return (
    <div
      className="relative flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      data-gallery=""
    >
      <GalleryToolbar
        searchRef={searchRef}
        query={draftQuery}
        onQueryChange={setDraftQuery}
        dbFacet={
          catalog.dbs.length > 1
            ? {
                items: dbItems,
                value: filters.db,
                label: filters.db ? dbName(filters.db) : "",
                onChange: (value) =>
                  onFiltersChange({ ...filters, db: value, cat: "" }),
              }
            : undefined
        }
        catFacet={{
          items: catItems,
          value: filters.cat,
          label: catLabel,
          onChange: (value) => onFiltersChange({ ...filters, cat: value }),
        }}
        priceMin={draftPriceMin}
        priceMax={draftPriceMax}
        priceMinInvalid={invalidPriceMin}
        priceMaxInvalid={invalidPriceMax}
        onPriceMinChange={setDraftPriceMin}
        onPriceMaxChange={setDraftPriceMax}
        sort={sort}
        onSortChange={setSort}
        favOnly={favOnly}
        favoriteCount={favoriteCount}
        onFavOnlyChange={setFavOnly}
        tray={queueTray("toolbar")}
        results={
          <GalleryResultBar
            count={countLabel}
            chips={chips}
            onClearAll={() => onFiltersChange({ ...EMPTY_FILTERS })}
            selection={!emptyKind ? (
              <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground" title="多规格商品请先选择规格">
                <Checkbox
                  aria-label="选择本页单规格商品"
                  checked={selectableRows.length > 0 && selectedCount === selectableRows.length}
                  indeterminate={selectedCount > 0 && selectedCount < selectableRows.length}
                  disabled={selectableRows.length === 0}
                  onCheckedChange={(checked) => {
                    for (const row of selectableRows) {
                      if (collection.queueIds.has(row.productId) !== checked) collection.toggleQueued(row)
                    }
                  }}
                />
                全选
              </label>
            ) : undefined}
          />
        }
      />

      <div data-gallery-grid="" className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {emptyKind ? (
          <GalleryEmpty
            kind={emptyKind}
            query={query}
            onClear={() => onFiltersChange({ ...EMPTY_FILTERS })}
          />
        ) : (
          <ul aria-label="平台商品库商品列表" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11.5rem),1fr))] content-start gap-x-5 gap-y-6">
            {paged.rows.map((group) => (
              <li key={group.row.productId} className="flex min-w-0">
                <GalleryCard
                  row={group.row}
                  categoryLabel={categoryLabelOf(group.row, catIndex)}
                  onOpen={onOpenDetail}
                  variantCount={group.rows.length}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      {!emptyKind ? (
        <GalleryPager
          page={paged.page}
          pages={paged.pages}
          onPage={setPage}
        />
      ) : null}
    </div>
  )
}

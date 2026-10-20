/**
 * 卖家货盘画廊 — pure helpers over `SellerSupplierDbCatalogData`.
 *
 * One filter model, one URL shape (`?db=&cat=&pmin=&pmax=&q=&tags=`), one set of
 * facet counts — the rail and the result list must never disagree, so both
 * read from the functions here. Nothing in this file talks to a transport or
 * the DOM beyond `window.location`/`localStorage` accessors that take their
 * host object as an argument.
 */
import type { CategoryTreeNodeView } from "@/bindings/commands"
import type {
  SellerSupplierDbCatalogData,
  SellerSupplierDbData,
  SellerSupplierDbRowData,
  SupplierDbPropDefData,
} from "@/bindings/http-supplier-dbs-catalog"
import {
  indexCategoryNodes,
  resolveLeaf,
} from "@/features/category-schema/category-tree"
import {
  listabilityClass,
  type ListabilityClass,
  type SupplierOzonConfigDenial,
} from "../listability-copy"
import { replaceAddress } from "@/lib/address"

// ---------- filters ----------

export type GallerySort = "listed-desc" | "price-asc" | "price-desc" | "lead-time"

export type GalleryFilters = {
  /** sourceId of the selected 平台货源, "" = all. */
  db: string
  /** descriptionCategoryId as string, "" = all. */
  cat: string
  /** 平台价 lower bound in 元 text, "" = unbounded. */
  priceMin: string
  /** 平台价 upper bound in 元 text, "" = unbounded. */
  priceMax: string
  /** Selected fixed_tags — every selected tag must be on the row (叠加 = AND). */
  tags: string[]
  q: string
}

export const EMPTY_FILTERS: GalleryFilters = {
  db: "",
  cat: "",
  priceMin: "",
  priceMax: "",
  tags: [],
  q: "",
}

export const SORT_LABELS: Record<GallerySort, string> = {
  "listed-desc": "最新上架",
  "price-asc": "平台价从低到高",
  "price-desc": "平台价从高到低",
  "lead-time": "交期短优先",
}

// ---------- price range (平台价, yuan text in filters, cents on rows) ----------

/**
 * Canonical 元 text for a price bound: "" when empty, a normalized number text
 * when parseable, `null` for junk or negatives (the caller keeps its draft and
 * refuses to commit). `"10.50"` → `"10.5"`, so URL and chip read the same value.
 */
export function normalizePriceYuan(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed) return ""
  const yuan = Number(trimmed)
  if (!Number.isFinite(yuan) || yuan < 0) return null
  return String(yuan)
}

function priceCentsOf(text: string): number | null {
  const canonical = normalizePriceYuan(text)
  return canonical ? Math.round(Number(canonical) * 100) : null
}

/** Cents bounds of a min/max pair; an inverted pair reads low-to-high. */
export function priceRangeCents(
  minText: string,
  maxText: string,
): { min: number | null; max: number | null } {
  const lower = priceCentsOf(minText)
  const upper = priceCentsOf(maxText)
  if (lower !== null && upper !== null && lower > upper) {
    return { min: upper, max: lower }
  }
  return { min: lower, max: upper }
}

/** True when a 平台价 falls in [min, max] (inclusive); unpriced rows survive only while unbounded. */
export function priceInRange(
  cents: number | null | undefined,
  minText: string,
  maxText: string,
): boolean {
  const { min, max } = priceRangeCents(minText, maxText)
  if (min === null && max === null) return true
  if (cents === null || cents === undefined) return false
  if (min !== null && cents < min) return false
  if (max !== null && cents > max) return false
  return true
}

/** Chip label for an active range: `¥10–20` / `¥10 起` / `¥20 以下`. */
export function priceRangeLabel(minText: string, maxText: string): string {
  const { min, max } = priceRangeCents(minText, maxText)
  const yuan = (cents: number) => String(cents / 100)
  if (min !== null && max !== null) return `¥${yuan(min)}–${yuan(max)}`
  if (min !== null) return `¥${yuan(min)} 起`
  if (max !== null) return `¥${yuan(max)} 以下`
  return ""
}

// ---------- URL ⇄ filters ----------

const URL_KEYS = ["db", "cat", "pmin", "pmax", "q", "tags"] as const

/** Parse a querystring (`?db=…`) into filters. Unknown/foreign values drop out. */
export function filtersFromSearch(search: string): GalleryFilters {
  const params = new URLSearchParams(search)
  const bound = (key: string) => normalizePriceYuan(params.get(key) ?? "") ?? ""
  return {
    db: params.get("db")?.trim() ?? "",
    cat: params.get("cat")?.trim() ?? "",
    priceMin: bound("pmin"),
    priceMax: bound("pmax"),
    tags: (params.get("tags") ?? "")
      .split(",")
      .map((tag) => tag.trim())
      .filter(Boolean),
    q: params.get("q")?.trim() ?? "",
  }
}

/** Serialize filters into a querystring fragment; empty terms leave no key. */
export function searchFromFilters(filters: GalleryFilters): string {
  const params = new URLSearchParams()
  if (filters.db) params.set("db", filters.db)
  if (filters.cat) params.set("cat", filters.cat)
  if (filters.priceMin) params.set("pmin", filters.priceMin)
  if (filters.priceMax) params.set("pmax", filters.priceMax)
  if (filters.q.trim()) params.set("q", filters.q.trim())
  if (filters.tags.length) params.set("tags", filters.tags.join(","))
  return params.toString()
}

/** Read the gallery filters off the current URL; "" everywhere without a window. */
export function readGalleryFiltersFromUrl(): GalleryFilters {
  if (typeof window === "undefined") return { ...EMPTY_FILTERS }
  try {
    return filtersFromSearch(window.location.search)
  } catch {
    return { ...EMPTY_FILTERS }
  }
}

/**
 * Write the filters back to the URL without disturbing foreign params
 * (`screen=`, `invite=`…). replaceState, not pushState: the shell navigates by
 * screen param, and a filter tweak is not a history entry.
 */
export function writeGalleryFiltersToUrl(filters: GalleryFilters): void {
  if (typeof window === "undefined") return
  try {
    const url = new URL(window.location.href)
    const screen = url.searchParams.get("screen")
    if (screen && screen !== "catalog") return
    for (const key of URL_KEYS) url.searchParams.delete(key)
    const search = searchFromFilters(filters)
    for (const [key, value] of new URLSearchParams(search)) {
      url.searchParams.set(key, value)
    }
    replaceAddress(url.href)
  } catch {
    // A URL the browser refuses is not worth failing the screen for.
  }
}

/** Product IDs address both cards and individual variants; retain gallery filters. */
export function writeGalleryProductToUrl(productId?: string): void {
  if (typeof window === "undefined") return
  const url = new URL(window.location.href)
  const screen = url.searchParams.get("screen")
  if (productId) {
    if (screen && screen !== "catalog") return
    url.searchParams.set("screen", "catalog")
    url.searchParams.set("product", productId)
  } else {
    url.searchParams.delete("product")
  }
  replaceAddress(url.href)
}

// ---------- facet counts ----------

export type GalleryFacet = { value: string; label: string; count: number }

/**
 * The keyword match: 名称 / 编号 / fixed_tags. One declaration, because the
 * facet counts and the result list must agree on what "matching" means.
 */
export function matchesQuery(row: SellerSupplierDbRowData, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const haystack = `${row.title} ${row.platformCode} ${row.fixedTags.join(" ")}`
  return haystack.toLowerCase().includes(needle)
}

/** Rows in scope for the facet rail: everything the keyword already matched. */
export function queryRows(
  rows: SellerSupplierDbRowData[],
  query: string,
): SellerSupplierDbRowData[] {
  return rows.filter((row) => matchesQuery(row, query))
}

/** 库 facets: one row per listed db, counted over the keyword-matched rows. */
export function dbFacets(
  dbs: SellerSupplierDbData[],
  rows: SellerSupplierDbRowData[],
): GalleryFacet[] {
  return dbs.map((db) => ({
    value: db.sourceId,
    label: db.name,
    count: rows.filter((row) => row.sourceId === db.sourceId).length,
  }))
}

export function categoryKey(row: SellerSupplierDbRowData): string {
  return row.descriptionCategoryId ? String(row.descriptionCategoryId) : ""
}

export type CategoryIndex = Map<number, CategoryTreeNodeView>

export function categoryIndex(tree: CategoryTreeNodeView[]): CategoryIndex {
  return indexCategoryNodes(tree)
}

/**
 * 类目 facets inside the selected 库 (or everything when none is picked).
 * Labels resolve through the Ozon category tree; a row whose category is not
 * in the tree still owes the seller a readable label, not a bare number.
 */
export function categoryFacets(
  rows: SellerSupplierDbRowData[],
  db: string,
  index: CategoryIndex,
): GalleryFacet[] {
  const scoped = db ? rows.filter((row) => row.sourceId === db) : rows
  const counts = new Map<string, number>()
  for (const row of scoped) {
    const key = categoryKey(row)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([value, count]) => ({
      value,
      label:
        index.get(Number(value))?.category_name ??
        (Number(value) > 0 ? `类目 ${value}` : "未分类"),
      count,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
}

export function categoryLabelFor(id: number, index: CategoryIndex): string {
  if (!(id > 0)) return ""
  return index.get(id)?.category_name ?? `类目 ${id}`
}

/**
 * 「类型」事实的标签：类目坐标的末段即类型叶子——详情页不再读默认字段，
 * 按行的 (descriptionCategoryId, typeId) 经类目树解析出类型名；树未到场
 * 或坐标解析不到时留空，不呈现裸 id。
 */
export function typeLabelFor(
  descriptionCategoryId: number | null | undefined,
  typeId: number | null | undefined,
  tree: readonly CategoryTreeNodeView[],
): string {
  if (
    !(descriptionCategoryId != null && descriptionCategoryId > 0) ||
    !(typeId != null && typeId > 0)
  ) {
    return ""
  }
  const leaf = resolveLeaf(descriptionCategoryId, typeId, [...tree])
  return leaf?.pathLabel.split(" / ").at(-1) ?? ""
}

export function categoryLabelOf(
  row: SellerSupplierDbRowData,
  index: CategoryIndex,
): string {
  return categoryLabelFor(row.descriptionCategoryId ?? 0, index)
}

function scopedRows(
  rows: SellerSupplierDbRowData[],
  db: string,
  cat: string,
): SellerSupplierDbRowData[] {
  return rows.filter(
    (row) =>
      (!db || row.sourceId === db) &&
      (!cat || categoryKey(row) === cat),
  )
}

/** Top tags by frequency inside 库+类目 scope — the chip cloud reads these. */
export const TAG_CLOUD_LIMIT = 24

export function tagFacets(
  rows: SellerSupplierDbRowData[],
  db: string,
  cat: string,
): GalleryFacet[] {
  const counts = new Map<string, number>()
  for (const row of scopedRows(rows, db, cat)) {
    for (const tag of row.fixedTags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, label: value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, TAG_CLOUD_LIMIT)
}

// ---------- filter + sort ----------

export function hasFacetFilters(filters: GalleryFilters): boolean {
  return Boolean(
    filters.db || filters.cat || filters.priceMin || filters.priceMax || filters.tags.length,
  )
}

export function filterGallery(
  rows: SellerSupplierDbRowData[],
  filters: GalleryFilters,
  sort: GallerySort = "listed-desc",
): SellerSupplierDbRowData[] {
  const matched = rows.filter((row) => {
    if (filters.db && row.sourceId !== filters.db) return false
    if (filters.cat && categoryKey(row) !== filters.cat) return false
    if (!priceInRange(row.platformPriceCents, filters.priceMin, filters.priceMax)) return false
    if (filters.tags.some((tag) => !row.fixedTags.includes(tag))) return false
    return matchesQuery(row, filters.q)
  })
  return sortGallery(matched, sort)
}

export type GalleryProductGroup = {
  row: SellerSupplierDbRowData
  rows: SellerSupplierDbRowData[]
}

/** Group only by the explicit backend key; titles are never an identity. */
export function groupGalleryRows(rows: SellerSupplierDbRowData[]): GalleryProductGroup[] {
  const groups = new Map<string, SellerSupplierDbRowData[]>()
  for (const row of rows) {
    const variantGroup = row.variantGroup?.trim()
    const key = variantGroup ? `${row.sourceId}\0${variantGroup}` : `${row.sourceId}\0${row.productId}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  return [...groups.values()].map((rows) => ({ row: rows[0], rows }))
}

export function variantsForRow(rows: SellerSupplierDbRowData[], row: SellerSupplierDbRowData): SellerSupplierDbRowData[] {
  const group = row.variantGroup?.trim()
  return rows.filter((candidate) =>
    group
      ? candidate.sourceId === row.sourceId && candidate.variantGroup?.trim() === group
      : candidate.productId === row.productId,
  )
}

/** First number in a 交期 string ("2–3 天" → 2); unparseable sorts last. */
export function leadTimeKey(text: string): number {
  const match = /(\d+(?:\.\d+)?)/.exec(text)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

export function sortGallery(
  rows: SellerSupplierDbRowData[],
  sort: GallerySort,
): SellerSupplierDbRowData[] {
  const out = [...rows]
  const byId = (a: SellerSupplierDbRowData, b: SellerSupplierDbRowData) =>
    a.productId.localeCompare(b.productId)
  const price = (row: SellerSupplierDbRowData) => row.platformPriceCents
  if (sort === "listed-desc") {
    out.sort((a, b) => b.listedAtMs - a.listedAtMs || byId(a, b))
  } else if (sort === "price-asc") {
    out.sort(
      (a, b) =>
        (price(a) ?? Number.MAX_SAFE_INTEGER) - (price(b) ?? Number.MAX_SAFE_INTEGER) ||
        byId(a, b),
    )
  } else if (sort === "price-desc") {
    out.sort((a, b) => (price(b) ?? -1) - (price(a) ?? -1) || byId(a, b))
  } else if (sort === "lead-time") {
    out.sort((a, b) => leadTimeKey(a.leadTime) - leadTimeKey(b.leadTime) || byId(a, b))
  }
  return out
}

// ---------- card facts ----------

export function formatCny(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "¥—"
  return `¥${(cents / 100).toFixed(2)}`
}

/**
 * 「2–3 天」按发货口径读成「2–3 天发货」。纯数字或数字区间没有「天」时补上
 * （「3-5」/「3-5发货」→「3-5 天发货」）；「当天」本身已是交期口径，不补。
 * 文案自带「发货」不重复后缀。
 */
export function leadTimeLabel(leadTime: string): string {
  const text = leadTime.trim()
  if (!text) return "交期待定"
  let body = text.replace(/发货$/, "").trim()
  if (/^\d+(\s*[–\-~至到]\s*\d+)?$/.test(body)) {
    body = `${body} 天`
  }
  return body.includes("发货") ? body : `${body}发货`
}

/** Prop values arrive as plain JSON; render them, never raw-object dumps. */
export function propValueText(def: SupplierDbPropDefData, value: unknown): string {
  if (value === null || value === undefined || value === "") return ""
  const optionLabel = (raw: string) =>
    def.options.find((option) => option.value === raw)?.label ?? raw
  if (def.type === "multi_select" && Array.isArray(value)) {
    return value.map((item) => optionLabel(String(item))).join("、")
  }
  if (def.type === "select") return optionLabel(String(value))
  if (def.type === "checkbox") return value === true ? "是" : value === false ? "否" : String(value)
  if (Array.isArray(value)) return value.map((item) => String(item)).join("、")
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

// ---------- paging ----------

export const GALLERY_PAGE_SIZE = 24

export function paginate<T>(
  items: readonly T[],
  page: number,
  pageSize: number = GALLERY_PAGE_SIZE,
): { rows: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / pageSize))
  const safePage = Math.min(Math.max(1, page), pages)
  const start = (safePage - 1) * pageSize
  return { rows: items.slice(start, start + pageSize), page: safePage, pages }
}

export function pageNumbers(page: number, pages: number): Array<number | "ellipsis"> {
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const marks = new Set([1, pages, page, page - 1, page + 1])
  const ordered = [...marks].filter((value) => value >= 1 && value <= pages).sort((a, b) => a - b)
  const window: Array<number | "ellipsis"> = []
  for (const value of ordered) {
    const previous = window[window.length - 1]
    if (typeof previous === "number" && value - previous > 1) window.push("ellipsis")
    window.push(value)
  }
  return window
}

// ---------- density (localStorage view preference, never a filter) ----------

export type GalleryDensity = "compact" | "standard" | "large"

export const DENSITY_LABELS: Record<GalleryDensity, string> = {
  compact: "紧凑",
  standard: "标准",
  large: "大图",
}

export const GALLERY_DENSITY_KEY = "podhub.supplier-dbs-gallery.density"

export function readGalleryDensity(
  storage: Pick<Storage, "getItem"> | undefined,
): GalleryDensity {
  if (!storage) return "standard"
  try {
    const raw = storage.getItem(GALLERY_DENSITY_KEY)
    return raw === "compact" || raw === "large" ? raw : "standard"
  } catch {
    return "standard"
  }
}

export function writeGalleryDensity(
  storage: Pick<Storage, "setItem"> | undefined,
  density: GalleryDensity,
): void {
  if (!storage) return
  try {
    storage.setItem(GALLERY_DENSITY_KEY, density)
  } catch {
    // A full or private-mode store is not worth failing the screen for.
  }
}

// ---------- listing hand-off ----------

/**
 * 一行的上架可行性（前置门）——只读 `listable`/`denial` 两枚行事实
 * （行投影），不从类目/价格等其他字段另推。`listable` 缺省视为「不确知
 * 受阻」放行（后端 `require_listable` 409 仍是最终门）；`listable:false`
 * 而 denial 缺席时归 `platform_pending`——不臆造停售事实。
 */
export type RowListability =
  | { listable: true }
  | { listable: false; class: ListabilityClass }

export function listabilityOf(row: {
  listable?: boolean
  denial?: SupplierOzonConfigDenial | null
}): RowListability {
  if (row.listable !== false) return { listable: true }
  return {
    listable: false,
    class: row.denial ? listabilityClass(row.denial) : "platform_pending",
  }
}

/**
 * 「进入上架」递给上架屏的最小商品身份——上架侧只需要找到那件货，
 * 物流/规格/默认字段都留在货盘里重读。上架清单的批量导入也是这组字段的数组。
 *
 * `listable`/`denial` 只在该行受阻时随行——导入入口兜底按这份点击时的
 * 行事实快照再过滤一次（清单点击到逐件建卡之间行可能转为不可上架）。
 */
export type CatalogListingIdentity = Pick<
  SellerSupplierDbRowData,
  "productId" | "sourceId" | "title" | "platformCode" | "size" | "variantGroup"
> & {
  listable?: boolean
  denial?: SupplierOzonConfigDenial | null
}

export function catalogListingIdentity(
  row: CatalogListingIdentity,
): CatalogListingIdentity {
  const { productId, sourceId, title, platformCode, size, variantGroup } = row
  return {
    productId,
    sourceId,
    title,
    platformCode,
    ...(size ? { size } : {}),
    // 同款来源随行：非空款号是「同源多规格导入」关联同一设计的唯一输入，
    // 空款号不携带（空款号不自动关联）。它只是请求输入——服务端自行派生
    // association/型号，并核对卡自身的货源绑定，客户端覆盖不了它。
    ...(variantGroup?.trim() ? { variantGroup: variantGroup.trim() } : {}),
    // 可行时身份保持最小——受阻行才携带 listable/denial 快照供入口兜底。
    ...(listabilityOf(row).listable
      ? {}
      : { listable: false, ...(row.denial ? { denial: row.denial } : {}) }),
  }
}

// ---------- catalog shape helpers ----------

export function propDefsFor(
  catalog: Pick<SellerSupplierDbCatalogData, "propDefs">,
  sourceId: string,
): SupplierDbPropDefData[] {
  return catalog.propDefs
    .filter((def) => def.sourceId === sourceId && def.sellerVisible)
    .sort((a, b) => a.position - b.position)
}

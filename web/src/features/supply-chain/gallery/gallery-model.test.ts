import assert from "node:assert/strict"
import test from "node:test"

import type { CategoryTreeNodeView } from "@/bindings/commands"
import type {
  SellerSupplierDbCatalogData,
  SellerSupplierDbRowData,
  SupplierDbPropDefData,
} from "@/bindings/http-supplier-dbs-catalog"

import {
  EMPTY_FILTERS,
  GALLERY_PAGE_SIZE,
  categoryFacets,
  categoryIndex,
  categoryKey,
  categoryLabelFor,
  categoryLabelOf,
  dbFacets,
  filterGallery,
  groupGalleryRows,
  filtersFromSearch,
  hasFacetFilters,
  leadTimeKey,
  leadTimeLabel,
  listabilityOf,
  catalogListingIdentity,
  matchesQuery,
  normalizePriceYuan,
  pageNumbers,
  paginate,
  priceInRange,
  priceRangeLabel,
  propDefsFor,
  propValueText,
  queryRows,
  readGalleryDensity,
  searchFromFilters,
  sortGallery,
  tagFacets,
  typeLabelFor,
  writeGalleryDensity,
  writeGalleryProductToUrl,
  writeGalleryFiltersToUrl,
  type GalleryFilters,
} from "./gallery-model"

const DAY = 24 * 60 * 60 * 1000
const NOW = 1_800_000_000_000

function row(partial: Partial<SellerSupplierDbRowData>): SellerSupplierDbRowData {
  return {
    productId: "prd_x",
    sourceId: "src_1",
    title: "货品",
    platformCode: "P000",
    listable: true,
    descriptionCategoryId: 17030122,
    typeId: 971000156,
    platformPriceCents: 1600,
    suggestedRetailCents: null,
    suggestedOldPriceCents: null,
    leadTime: "2–3 天",
    gallery: [],
    productVideos: [],
    fixedTags: [],
    description: "",
    props: {},
    listedAtMs: NOW - 5 * DAY,
    ...partial,
  }
}

const ROWS: SellerSupplierDbRowData[] = [
  row({
    productId: "prd_1",
    sourceId: "src_1",
    title: "圣诞帽",
    platformCode: "P001",
    descriptionCategoryId: 17030122,
    platformPriceCents: 1600,
    leadTime: "2–3 天",
    fixedTags: ["节日", "红色"],
    listedAtMs: NOW - 5 * DAY,
  }),
  row({
    productId: "prd_2",
    sourceId: "src_1",
    title: "收纳盒",
    platformCode: "P002",
    descriptionCategoryId: 17030000,
    platformPriceCents: 800,
    leadTime: "5 天",
    fixedTags: ["家居"],
    listedAtMs: NOW - 40 * DAY,
  }),
  row({
    productId: "prd_3",
    sourceId: "src_2",
    title: "LED 灯带",
    platformCode: "P003",
    descriptionCategoryId: 20000000,
    platformPriceCents: 6000,
    leadTime: "当天",
    fixedTags: ["节日", "灯"],
    listedAtMs: NOW - 1 * DAY,
  }),
]

const tree: CategoryTreeNodeView[] = [
  {
    description_category_id: 1,
    category_name: "服饰",
    type_id: 0,
    type_name: "",
    disabled: false,
    children: [
      {
        description_category_id: 17030122,
        category_name: "节日用品",
        type_id: 0,
        type_name: "",
        disabled: false,
        children: [
          {
            description_category_id: 0,
            category_name: "",
            type_id: 971000156,
            type_name: "圣诞帽",
            disabled: false,
            children: [],
          },
        ],
      },
    ],
  },
]

const index = categoryIndex(tree)

test("URL roundtrip: filters ⇄ querystring preserve every term", () => {
  const filters: GalleryFilters = {
    db: "src_1",
    cat: "17030122",
    priceMin: "10",
    priceMax: "20",
    tags: ["节日", "红色"],
    q: "圣诞",
  }
  const search = searchFromFilters(filters)
  assert.match(search, /db=src_1/)
  assert.match(search, /cat=17030122/)
  assert.match(search, /pmin=10/)
  assert.match(search, /pmax=20/)
  assert.match(search, /q=/i)
  assert.match(search, /tags=/)
  assert.deepEqual(filtersFromSearch("?" + search), filters)
  // Empty filters serialize to nothing and parse back clean.
  assert.equal(searchFromFilters(EMPTY_FILTERS), "")
  assert.deepEqual(filtersFromSearch(""), { ...EMPTY_FILTERS })
  // Foreign params are ignored; a junk bound drops instead of silently
  // filtering by a number that cannot render. The retired `price` band key
  // is simply unknown now.
  assert.deepEqual(filtersFromSearch("?screen=catalog&price=bogus&pmin=-1&db=x"), {
    ...EMPTY_FILTERS,
    db: "x",
  })
})

test("db facets count keyword-matched rows; 库 select cascades 类目", () => {
  const dbs = [
    { sourceId: "src_1", name: "美国3C厂", country: "US", icon: "🏭" },
    { sourceId: "src_2", name: "美东厂", country: "US", icon: "" },
  ]
  const facets = dbFacets(dbs, queryRows(ROWS, ""))
  assert.deepEqual(
    facets.map((f) => [f.value, f.count]),
    [
      ["src_1", 2],
      ["src_2", 1],
    ],
  )
  // Keyword narrows the counts a facet may promise.
  const narrowed = dbFacets(dbs, queryRows(ROWS, "灯带"))
  assert.deepEqual(
    narrowed.map((f) => [f.value, f.count]),
    [
      ["src_1", 0],
      ["src_2", 1],
    ],
  )
  // 类目 group cascades: scoped to src_1 it lists only that db's categories.
  // Equal counts order by label: 类目 … fallbacks (Latin) before CJK names.
  const allCats = categoryFacets(ROWS, "", index)
  assert.deepEqual(
    allCats.map((f) => [f.value, f.label, f.count]),
    [
      ["17030000", "类目 17030000", 1],
      ["20000000", "类目 20000000", 1],
      ["17030122", "节日用品", 1],
    ],
  )
  const scopedCats = categoryFacets(ROWS, "src_1", index)
  assert.deepEqual(
    scopedCats.map((f) => f.value),
    ["17030000", "17030122"],
  )
})

test("price range reads 元 bounds inclusively; unpriced rows survive only unbounded", () => {
  assert.equal(normalizePriceYuan("10.50"), "10.5")
  assert.equal(normalizePriceYuan(" 20 "), "20")
  assert.equal(normalizePriceYuan(""), "")
  assert.equal(normalizePriceYuan("abc"), null)
  assert.equal(normalizePriceYuan("-1"), null)
  assert.equal(priceInRange(1600, "10", "20"), true)
  assert.equal(priceInRange(2000, "10", "20"), true)
  assert.equal(priceInRange(800, "10", ""), false)
  assert.equal(priceInRange(6000, "", "50"), false)
  // An inverted pair is read low-to-high, the way a range reads.
  assert.equal(priceInRange(1600, "20", "10"), true)
  assert.equal(priceInRange(null, "", ""), true)
  assert.equal(priceInRange(null, "10", ""), false)
  assert.equal(priceRangeLabel("10", "20"), "¥10–20")
  assert.equal(priceRangeLabel("10", ""), "¥10 起")
  assert.equal(priceRangeLabel("", "20"), "¥20 以下")
  assert.equal(priceRangeLabel("", ""), "")
})

test("tag cloud counts fixed_tags in scope and caps the list", () => {
  const facets = tagFacets(ROWS, "", "")
  assert.deepEqual(facets[0], { value: "节日", label: "节日", count: 2 })
  assert.equal(facets.length, 4)
  const scoped = tagFacets(ROWS, "src_2", "")
  assert.deepEqual(
    scoped.map((f) => f.value),
    ["灯", "节日"],
  )
})

test("filterGallery combines db + cat + price range + tags(AND) + q", () => {
  assert.equal(filterGallery(ROWS, EMPTY_FILTERS).length, 3)
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, db: "src_1" }).map((r) => r.productId),
    idsByListedDesc(["prd_1", "prd_2"]),
  )
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, cat: "20000000" }).map((r) => r.productId),
    ["prd_3"],
  )
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, priceMax: "10" }).map((r) => r.productId),
    ["prd_2"],
  )
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, priceMin: "16", priceMax: "60" }).map(
      (r) => r.productId,
    ),
    idsByListedDesc(["prd_1", "prd_3"]),
  )
  // tags stack (AND): 节日 alone matches two rows, 节日+红色 one.
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, tags: ["节日"] }).map((r) => r.productId),
    idsByListedDesc(["prd_1", "prd_3"]),
  )
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, tags: ["节日", "红色"] }).map((r) => r.productId),
    ["prd_1"],
  )
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, q: "p003" }).map((r) => r.productId),
    ["prd_3"],
  )
  // q matches tags too.
  assert.deepEqual(
    filterGallery(ROWS, { ...EMPTY_FILTERS, q: "家居" }).map((r) => r.productId),
    ["prd_2"],
  )
  assert.equal(hasFacetFilters(EMPTY_FILTERS), false)
  assert.equal(hasFacetFilters({ ...EMPTY_FILTERS, priceMax: "50" }), true)
})

test("gallery groups only explicit variants and keeps same-title rows separate", () => {
  const grouped = groupGalleryRows([
    row({ productId: "a", title: "同名", variantGroup: "g", size: "S" }),
    row({ productId: "b", title: "同名", variantGroup: "g", size: "M" }),
    row({ productId: "c", title: "同名", size: "L" }),
    row({ productId: "d", title: "同名", size: "XL" }),
  ])
  assert.deepEqual(grouped.map((group) => group.rows.map((item) => item.productId)), [["a", "b"], ["c"], ["d"]])
})

test("sort orders: 最新上架 default, 平台价 asc/desc, 交期", () => {
  assert.deepEqual(
    sortGallery(ROWS, "listed-desc").map((r) => r.productId),
    ["prd_3", "prd_1", "prd_2"],
  )
  assert.deepEqual(
    sortGallery(ROWS, "price-asc").map((r) => r.productId),
    ["prd_2", "prd_1", "prd_3"],
  )
  assert.deepEqual(
    sortGallery(ROWS, "price-desc").map((r) => r.productId),
    ["prd_3", "prd_1", "prd_2"],
  )
  // 交期 parses the first number; 「当天」 has none and sorts last.
  assert.deepEqual(
    sortGallery(ROWS, "lead-time").map((r) => r.productId),
    ["prd_1", "prd_2", "prd_3"],
  )
  assert.equal(leadTimeKey("2–3 天"), 2)
  assert.equal(leadTimeKey("当天"), Number.MAX_SAFE_INTEGER)
})

test("leadTimeLabel 数字区间补「天」，已有交期口径只加发货", () => {
  assert.equal(leadTimeLabel(""), "交期待定")
  assert.equal(leadTimeLabel("  "), "交期待定")
  assert.equal(leadTimeLabel("3-5"), "3-5 天发货")
  assert.equal(leadTimeLabel("3-5发货"), "3-5 天发货")
  assert.equal(leadTimeLabel("2–3 天"), "2–3 天发货")
  assert.equal(leadTimeLabel("5 天"), "5 天发货")
  assert.equal(leadTimeLabel("当天"), "当天发货")
  assert.equal(leadTimeLabel("当天发货"), "当天发货")
})

test("matchesQuery covers 名称/编号/tags", () => {
  const target = row({ title: "圣诞帽", platformCode: "P001", fixedTags: ["节日"] })
  assert.equal(matchesQuery(target, "圣诞"), true)
  assert.equal(matchesQuery(target, "p001"), true)
  assert.equal(matchesQuery(target, "节日"), true)
  assert.equal(matchesQuery(target, "收纳"), false)
  assert.equal(matchesQuery(target, "  "), true)
})

test("paginate clamps and pageNumbers ellipsizes", () => {
  const items = Array.from({ length: 50 }, (_, i) => i)
  const first = paginate(items, 1, GALLERY_PAGE_SIZE)
  assert.equal(first.rows.length, 24)
  const last = paginate(items, 9, GALLERY_PAGE_SIZE)
  assert.equal(last.page, 3)
  assert.equal(last.rows.length, 2)
  assert.deepEqual(pageNumbers(1, 10), [1, 2, "ellipsis", 10])
  assert.deepEqual(pageNumbers(5, 10), [1, "ellipsis", 4, 5, 6, "ellipsis", 10])
  assert.deepEqual(pageNumbers(2, 3), [1, 2, 3])
})

test("density persists to storage and tolerates junk", () => {
  const store = new Map<string, string>()
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  }
  assert.equal(readGalleryDensity(storage), "standard")
  writeGalleryDensity(storage, "compact")
  assert.equal(readGalleryDensity(storage), "compact")
  store.set("podhub.supplier-dbs-gallery.density", "huge")
  assert.equal(readGalleryDensity(storage), "standard")
  assert.equal(readGalleryDensity(undefined), "standard")
})

test("propValueText renders each def type; select maps option labels", () => {
  const def = (partial: Partial<SupplierDbPropDefData>): SupplierDbPropDefData => ({
    propId: "pp_1",
    sourceId: "src_1",
    name: "材质",
    type: "text",
    options: [],
    position: 1,
    sellerVisible: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...partial,
  })
  const select = def({
    type: "select",
    options: [{ value: "cotton", label: "棉" }],
  })
  assert.equal(propValueText(select, "cotton"), "棉")
  assert.equal(propValueText(select, "other"), "other")
  const multi = def({
    type: "multi_select",
    options: [
      { value: "a", label: "甲" },
      { value: "b", label: "乙" },
    ],
  })
  assert.equal(propValueText(multi, ["a", "b"]), "甲、乙")
  assert.equal(propValueText(def({ type: "checkbox" }), true), "是")
  assert.equal(propValueText(def({ type: "checkbox" }), false), "否")
  assert.equal(propValueText(def({ type: "number" }), 42), "42")
  assert.equal(propValueText(def({}), ""), "")
})

test("propDefsFor keeps only this db's seller_visible defs, position-ordered", () => {
  const def = (partial: Partial<SupplierDbPropDefData>): SupplierDbPropDefData => ({
    propId: "pp_1",
    sourceId: "src_1",
    name: "材质",
    type: "text",
    options: [],
    position: 1,
    sellerVisible: true,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...partial,
  })
  const catalog: Pick<SellerSupplierDbCatalogData, "propDefs"> = {
    propDefs: [
      def({ propId: "pp_b", position: 2 }),
      def({ propId: "pp_a", position: 1 }),
      def({ propId: "pp_hidden", sellerVisible: false }),
      def({ propId: "pp_other_db", sourceId: "src_2" }),
    ],
  }
  assert.deepEqual(
    propDefsFor(catalog, "src_1").map((d) => d.propId),
    ["pp_a", "pp_b"],
  )
})

test("category labels resolve through the tree and stay readable without it", () => {
  assert.equal(categoryLabelFor(17030122, index), "节日用品")
  assert.equal(categoryLabelFor(999, index), "类目 999")
  assert.equal(categoryKey(row({ descriptionCategoryId: null })), "")
  assert.equal(categoryLabelOf(row({ descriptionCategoryId: 17030122 }), index), "节日用品")
})

test("typeLabelFor resolves 类型 from the tree leaf and stays empty without it", () => {
  assert.equal(typeLabelFor(17030122, 971000156, tree), "圣诞帽")
  assert.equal(typeLabelFor(17030122, 971000156, []), "")
  assert.equal(typeLabelFor(null, 971000156, tree), "")
  assert.equal(typeLabelFor(17030122, null, tree), "")
  assert.equal(typeLabelFor(999, 971000156, tree), "")
})

function idsByListedDesc(ids: string[]): string[] {
  // listed-desc default ordering: newer listedAtMs first.
  return [...ids].sort(
    (a, b) =>
      (ROWS.find((r) => r.productId === b)?.listedAtMs ?? 0) -
      (ROWS.find((r) => r.productId === a)?.listedAtMs ?? 0),
  )
}


test("product URLs distinguish variants, preserve filters, and clear on gallery return", () => {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  const location = new URL("http://localhost/?q=帽子&db=src_1#gallery")
  globals.window = {
    location,
    history: {
      replaceState(_state: unknown, _title: string, href: string) {
        location.href = new URL(href, location).href
      },
    },
  }
  try {
    writeGalleryProductToUrl("prd_1")
    const first = location.href
    assert.equal(location.searchParams.get("screen"), "catalog")
    assert.equal(location.searchParams.get("product"), "prd_1")
    writeGalleryProductToUrl("prd_2 / 中文")
    assert.notEqual(location.href, first)
    assert.equal(new URL(location.href).searchParams.get("product"), "prd_2 / 中文")
    assert.equal(location.searchParams.get("q"), "帽子")
    assert.equal(location.hash, "#gallery")
    writeGalleryFiltersToUrl({ ...EMPTY_FILTERS, db: "src_2" })
    assert.equal(location.searchParams.get("product"), "prd_2 / 中文")
    writeGalleryProductToUrl()
    assert.equal(location.searchParams.has("product"), false)
    assert.equal(location.searchParams.get("db"), "src_2")
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
})

test("listabilityOf 只读 listable/denial 两枚行事实", () => {
  assert.deepEqual(listabilityOf(row({ listable: true })), { listable: true })
  assert.deepEqual(
    listabilityOf(row({ listable: false, denial: "catalog_expired" })),
    { listable: false, class: "platform_pending" },
  )
  assert.deepEqual(
    listabilityOf(row({ listable: false, denial: "product_archived" })),
    { listable: false, class: "delisted" },
  )
  // denial 缺席的阻断仍挡下，归不臆造事实的「平台待处理」。
  assert.deepEqual(listabilityOf(row({ listable: false })), {
    listable: false,
    class: "platform_pending",
  })
  // 不从其他字段另推：缺价/缺类目/缺规格都不是阻断信号。
  assert.deepEqual(
    listabilityOf(
      row({
        listable: true,
        platformPriceCents: null,
        descriptionCategoryId: null,
        typeId: null,
      }),
    ),
    { listable: true },
  )
})

test("catalogListingIdentity 只在受阻行携带 listable/denial 快照", () => {
  // 可上架行的身份保持最小——多一个字段就是多一分泄漏面。
  assert.deepEqual(catalogListingIdentity(row({ productId: "prd_1" })), {
    productId: "prd_1",
    sourceId: "src_1",
    title: "货品",
    platformCode: "P000",
  })
  // 受阻行随行携带点击时的行事实，供导入入口兜底再过滤。
  assert.deepEqual(
    catalogListingIdentity(
      row({ productId: "prd_b", listable: false, denial: "catalog_expired" }),
    ),
    {
      productId: "prd_b",
      sourceId: "src_1",
      title: "货品",
      platformCode: "P000",
      listable: false,
      denial: "catalog_expired",
    },
  )
  // 受阻但 denial 缺席：只带 listable:false，不编一个 denial。
  assert.deepEqual(
    catalogListingIdentity(row({ productId: "prd_b2", listable: false })),
    {
      productId: "prd_b2",
      sourceId: "src_1",
      title: "货品",
      platformCode: "P000",
      listable: false,
    },
  )
})

test("gallery URL writers do not leak onto another screen", () => {
  const globals = globalThis as { window?: unknown }
  const previous = globals.window
  const location = new URL("http://localhost/?screen=listing&product=scp_1")
  globals.window = {
    location,
    history: {
      replaceState(_state: unknown, _title: string, href: string) {
        location.href = new URL(href, location).href
      },
    },
  }
  try {
    writeGalleryProductToUrl("prd_1")
    assert.equal(location.searchParams.get("screen"), "listing")
    assert.equal(location.searchParams.get("product"), "scp_1")
    writeGalleryFiltersToUrl({ ...EMPTY_FILTERS, q: "hat", db: "src_2" })
    assert.equal(location.searchParams.has("q"), false)
    assert.equal(location.searchParams.has("db"), false)
    writeGalleryProductToUrl()
    assert.equal(location.searchParams.has("product"), false)
    assert.equal(location.searchParams.get("screen"), "listing")
  } finally {
    if (previous === undefined) delete globals.window
    else globals.window = previous
  }
})

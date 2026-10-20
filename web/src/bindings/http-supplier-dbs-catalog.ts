/**
 * Seller 平台货源 catalog HTTP — the 货盘 read (docs/supplier-dbs.md §5/§7).
 *
 * GET /api/supplier-dbs/catalog returns the upgraded catalog payload in one
 * read: listed databases + listed rows + seller_visible prop defs. The seller
 * types below mirror the frozen wire contract `SellerSupplierDbCatalogData`
 * (src/wire/cloud_api/supplier_dbs.rs); shared value/prop shapes come from
 * `./http-supplier-dbs` (the admin slice's wire file) so the two halves cannot
 * drift. The seller DTO has no cost / prompt body / psd / internal-note keys
 * at all — the firewall is structural, nothing here strips.
 *
 * The generated `route("supplierDbsCatalog")` key is the path authority.
 */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"

import type {
  SupplierDbGalleryItem,
  SupplierDbPropDef,
  SupplierDbVideoItem,
} from "./http-supplier-dbs"

export type SellerPlatformProduct = components["schemas"]["SellerPlatformProductData"]

export type {
  SupplierDbGalleryItem,
  SupplierDbPropDef,
  SupplierDbPropDef as SupplierDbPropDefData,
  SupplierDbPropOption,
  SupplierDbPropType,
  SupplierDbVideoItem,
} from "./http-supplier-dbs"

// ---------- seller view (gallery) ----------

export type SellerSupplierDbData = {
  sourceId: string
  name: string
  /** `''` or an ISO-3166-1 alpha-2 code. */
  country: string
  icon: string
}

export type SellerSupplierDbRowData = {
  /**
   * Whether the shared listability predicate admits this row right now — the
   * gallery pre-gates on it so a denied click is impossible by rendering.
   */
  listable: boolean
  /**
   * The specific denial when `listable` is false — the same snake_case code
   * the 409 `supplier_not_listable` refusal carries. Absent means no denial.
   */
  denial?: components["schemas"]["SupplierOzonConfigDenial"] | null
  productId: string
  sourceId: string
  /** Same source + non-empty group identifies explicit variants; empty is standalone. */
  variantGroup?: string
  title: string
  platformCode: string
  descriptionCategoryId?: number | null
  typeId?: number | null
  /** 平台价, 人民币分. */
  platformPriceCents?: number | null
  /** 建议零售价, 人民币分. */
  suggestedRetailCents?: number | null
  /** 平台划线价（平台价的划线锚点，平台优惠展示用）, 人民币分. */
  suggestedOldPriceCents?: number | null
  /** 供货运费, 人民币分; null / 0 即零运费. */
  shippingCostCents?: number | null
  leadTime: string
  /** 商品尺码（厂家口径自由文本）。 */
  size?: string
  /** 商品材质（厂家口径自由文本）。 */
  material?: string
  /** 商品工艺（厂家口径自由文本）。 */
  craft?: string
  /** 毛重（克）。 */
  grossWeightG?: number | null
  /** 品牌（厂家口径自由文本）。 */
  brand?: string
  /** 包装三边（毫米）与包装重量（克）。 */
  packWidthMm?: number | null
  packHeightMm?: number | null
  packDepthMm?: number | null
  packWeightG?: number | null
  /** 清单（厂家口径自由文本：商品包含什么）。 */
  contents?: string
  gallery: SupplierDbGalleryItem[]
  productVideos: SupplierDbVideoItem[]
  fixedTags: string[]
  description: string
  /** Values keyed by prop_id, already restricted to seller_visible defs. */
  props: Record<string, unknown>
  listedAtMs: number
}

export type SellerSupplierDbCatalogData = {
  dbs: SellerSupplierDbData[]
  propDefs: SupplierDbPropDef[]
  rows: SellerSupplierDbRowData[]
}

export function listSupplierDbCatalog(): Promise<SellerSupplierDbCatalogData> {
  return api.get<SellerSupplierDbCatalogData>(route("supplierDbsCatalog"))
}

/**
 * Adopt seam: the gallery row is a product, and adopting it still needs the
 * per-SKU detail the firewalled catalog row does not carry. The existing
 * seller product read answers that — the product-first flow is unchanged.
 */
export async function getPlatformProduct(
  productId: string,
): Promise<SellerPlatformProduct> {
  const data = await api.get<components["schemas"]["SellerPlatformProductViewData"]>(
    route("platformCatalogProductsByProductId", { product_id: productId }),
  )
  return data.product
}

export const supplierDbsCatalogHttp = {
  listSupplierDbCatalog,
  getPlatformProduct,
}

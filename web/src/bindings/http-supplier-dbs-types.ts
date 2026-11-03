/** Supplier database wire value shapes and requests. */
// ---------- shared value shapes ----------

export type SupplierDbPropType =
  | "text"
  | "long_text"
  | "number"
  | "select"
  | "multi_select"
  | "checkbox"

export type SupplierDbPropOption = {
  value: string
  label: string
}

export type SupplierDbGalleryItem = {
  url: string
  w: number
  h: number
}

export type SupplierDbFileItem = {
  url: string
  name: string
  bytes: number
}

export type SupplierDbVideoItem = {
  url: string
  coverUrl: string
  durationMs: number
}

// ---------- admin view ----------

export type SupplierDb = {
  factoryId?: string | null
  sourceId: string
  name: string
  /** `''` or an ISO-3166-1 alpha-2 code. */
  country: string
  contact: string
  internalNote: string
  listed: boolean
  icon: string
  /** 接受委托生产 (ADR-0100)：只挡新绑定，不动既有绑定与在途派发。 */
  acceptsDelegate?: boolean
  viewPrefs: unknown
  rowCount: number
  publishedCount: number
  createdAtMs: number
  updatedAtMs: number
  /** 已绑定的履约账号；成员邮箱本身不代表履约授权。 */
  fulfillerEmail?: string | null
  /** 库创建人的公开账号 UUID；历史归属仅超级管理员可见。 */
  createdBy?: string
  /** 公开显示名，不含邮箱。 */
  creatorName?: string | null
}

export type SupplierDbPropDef = {
  propId: string
  sourceId: string
  name: string
  /** Wire key is `type` — mirrors `sc_source_prop_defs.type`. */
  type: SupplierDbPropType
  options: SupplierDbPropOption[]
  position: number
  sellerVisible: boolean
  createdAtMs: number
  updatedAtMs: number
}

/** Publish preconditions (ADR-0095.7): `false` keys are what the row still misses. */
export type SupplierDbReadiness = {
  category: boolean
  prompt: boolean
  fixedTags: boolean
  platformPrice: boolean
  ozonConfig: boolean
}

/**
 * The shared listability denial wire enum (`SupplierOzonConfigDenial`,
 * snake_case). Absent on a row means the shared predicate admits it.
 */
export type SupplierOzonConfigDenial =
  | "source_not_listed"
  | "product_archived"
  | "sku_not_published"
  | "catalog_missing"
  | "catalog_expired"
  | "config_needs_reconfiguration"
  | "catalog_digest_mismatch"
  | "prompt_invalid"

/** 一条追加式平台价版本，人民币分；列表按版本从新到旧。 */
export type SupplierDbPriceVersion = {
  priceCents: number
  createdAtMs: number
}

export type SupplierDbRow = {
  productId: string
  skuId: string
  sourceId: string
  title: string
  platformCode: string
  descriptionCategoryId: number | null
  typeId: number | null
  published: boolean
  archived: boolean
  readiness: SupplierDbReadiness
  /** 共享谓词的拒绝码 —— 与上架准入 409 同一个原因；缺省即可上架。 */
  denial?: SupplierOzonConfigDenial | null
  /** 配置轴自身的拒绝码（销售态视为已满足）；缺省即 Ozon 配置就绪。 */
  ozonConfigDenial?: SupplierOzonConfigDenial | null
  /** 供货成本，人民币分 — admin only. */
  costCents: number | null
  /** 供货运费，人民币分；同时用于平台商品库展示。 */
  shippingCostCents: number | null
  /** 当前平台价（sc_price_versions 最新一条），人民币分。 */
  platformPriceCents: number | null
  /** 平台价版本，最新在前；首项即当前价。旧响应可以缺省。 */
  priceHistory?: SupplierDbPriceVersion[]
  /** 建议零售价，人民币分。 */
  suggestedRetailCents: number | null
  /** 平台划线价，人民币分 — 平台价的划线锚点（平台优惠展示用），不是 Ozon old_price 建议值。 */
  suggestedOldPriceCents: number | null
  leadTime: string
  /** 商品尺码（厂家口径自由文本，如 40×50cm）。 */
  size: string
  /** 同一厂家内相同款号的行组成一件商品；空值为独立商品。 */
  variantGroup?: string
  /** 商品材质（厂家口径自由文本，如 纯棉）。 */
  material: string
  /** 商品工艺（厂家口径自由文本，如 数码直喷）。 */
  craft: string
  /** 毛重（克）。 */
  grossWeightG: number | null
  /** 品牌（厂家口径自由文本，如 无品牌）。 */
  brand: string
  /** 包装三边（毫米）与包装重量（克）。 */
  packWidthMm: number | null
  packHeightMm: number | null
  packDepthMm: number | null
  packWeightG: number | null
  /** 清单（厂家口径自由文本：商品包含什么，套件内容/装箱清单）。 */
  contents: string
  gallery: SupplierDbGalleryItem[]
  psd: SupplierDbFileItem[]
  productVideos: SupplierDbVideoItem[]
  promptName: string
  promptFileName: string
  /** Admin only — never on the seller DTO. Current confirmed facts. */
  promptContent: string
  /** 1–30 when set (validate_fixed_tags contract). */
  fixedTags: string[]
  description: string
  /** Admin only. */
  internalNote: string
  /** Custom property values keyed by prop_id. */
  props: Record<string, unknown>
  revision: number
  createdAtMs: number
  updatedAtMs: number
  createdBy?: string
  creatorName?: string | null
}

export type SupplierPromptPreview = {
  text: string
  sha256: string
  templateSha256: string
}

export type SupplierDbDetail = {
  db: SupplierDb
  propDefs: SupplierDbPropDef[]
  rows: SupplierDbRow[]
}

// ---------- requests / responses ----------

export type UpsertSupplierDbRequest = {
  factoryId?: string
  name: string
  country: string
  contact: string
  internalNote: string
  listed: boolean
  icon: string
  /** 接受委托生产 (ADR-0100)；缺省关。 */
  acceptsDelegate?: boolean
  /** Absent/undefined → blank database; a template id pre-seeds prop defs. */
  template?: string | null
  viewPrefs?: unknown
}

export type UpsertSupplierDbPropRequest = {
  name: string
  type: SupplierDbPropType
  options: SupplierDbPropOption[]
  position?: number | null
  sellerVisible: boolean
}

export type UpsertSupplierDbRowRequest = {
  title: string
  platformCode: string
  descriptionCategoryId: number | null
  typeId: number | null
  suggestedRetailCents: number | null
  suggestedOldPriceCents: number | null
  /** 供货成本（人民币分）— writes sc_source_offers. */
  costCents: number | null
  /** 供货运费（人民币分）— same offer row; an offer exists while either is set. */
  shippingCostCents: number | null
  leadTime: string
  /** 商品尺码（厂家口径自由文本）。 */
  size: string
  /** 同一厂家内相同款号的行组成一件商品；空值为独立商品。 */
  variantGroup?: string
  /** 商品材质（厂家口径自由文本）。 */
  material: string
  /** 商品工艺（厂家口径自由文本）。 */
  craft: string
  /** 毛重（克）。 */
  grossWeightG: number | null
  /** 品牌（厂家口径自由文本）。 */
  brand: string
  /** 包装三边（毫米）与包装重量（克）。 */
  packWidthMm: number | null
  packHeightMm: number | null
  packDepthMm: number | null
  packWeightG: number | null
  /** 清单（厂家口径自由文本：商品包含什么）。 */
  contents: string
  gallery: SupplierDbGalleryItem[]
  psd: SupplierDbFileItem[]
  productVideos: SupplierDbVideoItem[]
  promptName: string
  promptFileName: string
  promptContent: string
  fixedTags: string[]
  description: string
  internalNote: string
  props: Record<string, unknown>
  /** Archive leaves the gallery and the default table; absent/false on create. */
  archived?: boolean
  /** CAS: required on update, absent on create. */
  expectedRevision?: number | null
}



/** 调价 → new sc_price_versions row (人民币分). */
export type AdjustSupplierDbPriceRequest = {
  priceCents: number
  note: string
}

export type SupplierDbUploadKind = "gallery" | "psd" | "video"

export type PresignSupplierDbUploadRequest = {
  kind: SupplierDbUploadKind
  sha256: string
  filename: string
  contentType: string
  bytes: number
}

export type SupplierDbUploadTarget = {
  upload?: import("./direct-upload").DirectUploadGrant | null
  uploadTicket: string
  multipart?: import("./multipart-upload").MultipartPlan | null
  alreadyPresent?: boolean
}

/** DELETE prop returns how many rows still carry a value under it. */
export type SupplierDbPropDeleteResult = {
  propId: string
  rowsWithValues: number
}

export type SupplierDbListData = { dbs: SupplierDb[] }
export type SupplierDbMutationData = { db: SupplierDb }
export type SupplierDbPropMutationData = { prop: SupplierDbPropDef }
export type SupplierDbRowMutationData = { row: SupplierDbRow }
export type SupplierDbOkData = { sourceId: string }
export type SupplierDbRowOkData = { productId: string }
export type SupplierDbUploadData = { upload: SupplierDbUploadTarget }

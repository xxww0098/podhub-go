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
  /** 最早绑定的厂家登录邮箱。没有成员时缺省。 */
  accountEmail?: string | null
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
  /** 供货运费，人民币分 — admin only. */
  shippingCostCents: number | null
  /** 当前平台价（sc_price_versions 最新一条），人民币分。 */
  platformPriceCents: number | null
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
  /** Admin only — never on the seller DTO. Latest revision when one exists. */
  promptContent: string
  /** 1–30 when set (validate_fixed_tags contract). */
  fixedTags: string[]
  /** Latest prompt_revisions.revision. Absent until the first sealed brief. */
  draftPromptRevision?: number | null
  /** supplier_ozon_configs.published_revision. Jobs read this revision. */
  publishedPromptRevision?: number | null
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

export type SupplierPrompt = {
  productId: string
  sourceId: string
  productTitle: string
  descriptionCategoryId: number
  typeId: number
  promptName: string
  promptFileName: string
  promptContent: string
  fixedTags: string[]
  draftPromptRevision?: number | null
  publishedPromptRevision?: number | null
  revision: number
}

export type SupplierPromptPreview = {
  text: string
  sha256: string
  templateSha256: string
}

export type SupplierPromptDiffLine = {
  label: string
  published: string
  draft: string
  changed: boolean
}

export type SupplierPromptAiOutput = {
  title: boolean
  description: boolean
  tags: boolean
}

export type SupplierPromptDiff = {
  revision: number
  publishedRevision?: number | null
  lines: SupplierPromptDiffLine[]
  publishedFixedTags: string[]
  draftFixedTags: string[]
  fixedTagsChanged: boolean
  publishedAiOutput: SupplierPromptAiOutput
  draftAiOutput: SupplierPromptAiOutput
  aiOutputChanged: boolean
}

export type PublishSupplierPromptResult = {
  productId: string
  revision: number
  publishedRevision: number
  productRevision: number
  configRevision: number
}

export type SupplierDbDetail = {
  db: SupplierDb
  propDefs: SupplierDbPropDef[]
  rows: SupplierDbRow[]
}

// ---------- requests / responses ----------

export type UpsertSupplierDbRequest = {
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
  /** 厂家登录邮箱。创建时开通或绑定；更新时换成这个邮箱。缺省不改绑定。 */
  accountEmail?: string | null
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

export type PatchSupplierPromptRequest = {
  promptName: string
  promptFileName: string
  promptContent: string
  fixedTags: string[]
  expectedRevision: number
}

/** 无匹配的两种原因：类目里没有这个文件名，或同名文件有多条。 */
export type SupplierPromptSyncMissReason = "no_match" | "ambiguous"

/** 四类结果计数；明细封顶时计数仍是精确值。 */
export type SupplierPromptSyncCounts = {
  updated: number
  upToDate: number
  unmatched: number
  failed: number
}

/** 已同步（或本次改好）的一条供应商副本。 */
export type SupplierPromptSyncEntry = {
  productId: string
  productTitle: string
  promptFileName: string
  revision: number
}

export type SupplierPromptSyncMiss = {
  productId: string
  productTitle: string
  promptFileName: string
  reason: SupplierPromptSyncMissReason
}

export type SupplierPromptSyncFailure = {
  productId: string
  productTitle: string
  promptFileName: string
  /** 可直接展示的原因；存储细节只在服务端日志里。 */
  reason: string
}

/** 「按文件名从类目提示词同步供应商副本」的结果（wire: SupplierPromptSyncData）。 */
export type SupplierPromptSync = {
  counts: SupplierPromptSyncCounts
  updated: SupplierPromptSyncEntry[]
  upToDate: SupplierPromptSyncEntry[]
  unmatched: SupplierPromptSyncMiss[]
  failed: SupplierPromptSyncFailure[]
  /** 服务端封顶了某一类明细（每类最多 200 条）。 */
  detailsTruncated: boolean
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
  resumeTicket?: string
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
export type SupplierDbMutationData = { db: SupplierDb; initialPassword?: string | null }
export type SupplierDbPropMutationData = { prop: SupplierDbPropDef }
export type SupplierDbRowMutationData = { row: SupplierDbRow }
export type SupplierPromptListData = { prompts: SupplierPrompt[] }
export type SupplierPromptMutationData = { prompt: SupplierPrompt }
export type SupplierDbOkData = { sourceId: string }
export type SupplierDbRowOkData = { productId: string }
export type SupplierDbUploadData = { upload: SupplierDbUploadTarget }

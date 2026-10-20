/** Supplier database state, commands and editable request conversions. */
import {
  supplierDbsHttp,
  type SupplierDb,
  type SupplierDbDetail,
  type SupplierDbPropDef,
  type SupplierDbRow,
  type UpsertSupplierDbPropRequest,
  type UpsertSupplierDbRequest,
  type UpsertSupplierDbRowRequest,
  type PresignSupplierDbUploadRequest,
  type SupplierDbPropDeleteResult,
  type SupplierDbUploadTarget,
} from "@/bindings/http-supplier-dbs"

export type SupplierDbsClient = Pick<
  typeof supplierDbsHttp,
  | "supplierDbsList"
  | "supplierDbGet"
  | "supplierDbCreate"
  | "supplierDbUpdate"
  | "supplierDbDelete"
  | "supplierDbPropCreate"
  | "supplierDbPropUpdate"
  | "supplierDbPropDelete"
  | "supplierDbRowCreate"
  | "supplierDbRowUpdate"
  | "supplierDbRowDelete"
  | "supplierDbRowAdjustPrice"
  | "supplierDbRowPublish"
  | "supplierDbRowUnpublish"
  | "supplierDbUploadPresign"
>

export type SupplierDbsStatus = "idle" | "loading" | "ready" | "error"

export type SupplierDbDetailStatus = "idle" | "loading" | "ready" | "error"

export type SupplierDbDetailState = {
  status: SupplierDbDetailStatus
  error?: string
  reason?: unknown
  detail?: SupplierDbDetail
}

export type SupplierDbsState = {
  status: SupplierDbsStatus
  error?: string
  reason?: unknown
  dbs: SupplierDb[]
  /** Per-database detail keyed by sourceId; absent until first loadDetail. */
  details: Record<string, SupplierDbDetailState>
  /** productIds with an in-flight row write — the table greys those rows. */
  pendingRows: string[]
}

/** `reason` is the raw host reject, so a caller can hand it to `notifyCommandError`. */
export type MutationResult<T> =
  | { ok: true; value: T; initialPassword?: string }
  | { ok: false; issues: FieldIssue[]; reason?: unknown }

export type FieldIssue = { field: string; message: string }

export type DuplicatedRow = { row: SupplierDbRow; configCopyError?: unknown }

/** The form fields the 建库 / 改库 dialogs collect — a subset of the upsert body. */
export type SupplierDbDraft = {
  name: string
  country: string
  contact: string
  internalNote: string
  listed: boolean
  icon: string
  /** 接受委托生产 (ADR-0100)：编辑表单开关；缺省不写入。 */
  acceptsDelegate?: boolean
  template?: string | null
  /** 厂家登录邮箱。创建必填；编辑时换绑，和当前一样则不提交。 */
  accountEmail?: string
}

export const EMPTY_DB_DRAFT: SupplierDbDraft = {
  name: "",
  country: "",
  contact: "",
  internalNote: "",
  listed: true,
  icon: "",
  accountEmail: "",
}

/** A blank 行 = 新商品; the server fills ids/revision. */
export const EMPTY_ROW_REQUEST: UpsertSupplierDbRowRequest = {
  title: "",
  platformCode: "",
  descriptionCategoryId: null,
  typeId: null,
  suggestedRetailCents: null,
  suggestedOldPriceCents: null,
  costCents: null,
  shippingCostCents: null,
  leadTime: "",
  size: "",
  variantGroup: "",
  material: "",
  craft: "",
  grossWeightG: null,
  brand: "",
  packWidthMm: null,
  packHeightMm: null,
  packDepthMm: null,
  packWeightG: null,
  contents: "",
  gallery: [],
  psd: [],
  productVideos: [],
  promptName: "",
  promptFileName: "",
  promptContent: "",
  fixedTags: [],
  description: "",
  internalNote: "",
  props: {},
}

/** The whole editable row as an upsert body — update sends it back with CAS. */
export function rowToUpsert(row: SupplierDbRow): UpsertSupplierDbRowRequest {
  return {
    title: row.title,
    platformCode: row.platformCode,
    descriptionCategoryId: row.descriptionCategoryId,
    typeId: row.typeId,
    suggestedRetailCents: row.suggestedRetailCents,
    suggestedOldPriceCents: row.suggestedOldPriceCents,
    costCents: row.costCents,
    shippingCostCents: row.shippingCostCents,
    leadTime: row.leadTime,
    size: row.size,
    variantGroup: row.variantGroup ?? "",
    material: row.material,
    craft: row.craft,
    grossWeightG: row.grossWeightG,
    brand: row.brand,
    packWidthMm: row.packWidthMm,
    packHeightMm: row.packHeightMm,
    packDepthMm: row.packDepthMm,
    packWeightG: row.packWeightG,
    contents: row.contents,
    gallery: row.gallery,
    psd: row.psd,
    productVideos: row.productVideos,
    promptName: row.promptName,
    promptFileName: row.promptFileName,
    promptContent: row.promptContent,
    fixedTags: row.fixedTags,
    description: row.description,
    internalNote: row.internalNote,
    props: row.props,
    expectedRevision: row.revision,
  }
}

/** A prop def back into its upsert body — rename/retype/reorder reuse one write. */
export function propToUpsert(def: SupplierDbPropDef): UpsertSupplierDbPropRequest {
  return {
    name: def.name,
    type: def.type,
    options: def.options,
    position: def.position,
    sellerVisible: def.sellerVisible,
  }
}

/** A db row back into its upsert body, so 改名/改国家 reuses one write path. */
export function dbToUpsert(db: SupplierDb): UpsertSupplierDbRequest {
  return {
    name: db.name,
    country: db.country,
    contact: db.contact,
    internalNote: db.internalNote,
    listed: db.listed,
    icon: db.icon,
    acceptsDelegate: db.acceptsDelegate ?? false,
    viewPrefs: db.viewPrefs,
  }
}

export type SupplierDbsStore = {
  /** Fences in-flight replies when account or authority changes. */
  reset: () => void
  getState: () => SupplierDbsState
  subscribe: (listener: () => void) => () => void
  loadList: () => Promise<void>
  loadDetail: (sourceId: string, options?: { force?: boolean }) => Promise<void>
  createDb: (draft: SupplierDbDraft) => Promise<MutationResult<SupplierDb>>
  updateDb: (
    sourceId: string,
    patch: Partial<SupplierDbDraft> &
      { viewPrefs?: unknown; acceptsDelegate?: boolean },
  ) => Promise<MutationResult<SupplierDb>>
  deleteDb: (sourceId: string) => Promise<MutationResult<void>>
  saveProp: (
    sourceId: string,
    request: UpsertSupplierDbPropRequest,
    propId?: string,
  ) => Promise<MutationResult<SupplierDbPropDef>>
  createProp: (
    sourceId: string,
    request: UpsertSupplierDbPropRequest,
  ) => Promise<MutationResult<SupplierDbPropDef>>
  updateProp: (
    sourceId: string,
    propId: string,
    request: UpsertSupplierDbPropRequest,
  ) => Promise<MutationResult<SupplierDbPropDef>>
  /**
   * Create a property and land it at `index` in the sorted prop list — the
   * 左插/右插 path. The create POST carries `position`, then positions are
   * normalized to the visible order so the column lands exactly there even
   * when the server keeps caller positions verbatim.
   */
  insertPropAt: (
    sourceId: string,
    request: UpsertSupplierDbPropRequest,
    index: number,
  ) => Promise<MutationResult<SupplierDbPropDef>>
  /** Compact positions to `propIds` order; untouched props are not rewritten. */
  reorderProps: (
    sourceId: string,
    propIds: string[],
  ) => Promise<MutationResult<void>>
  deleteProp: (
    sourceId: string,
    propId: string,
  ) => Promise<MutationResult<SupplierDbPropDeleteResult>>
  createRow: (sourceId: string, initial?: Partial<Pick<UpsertSupplierDbRowRequest, "title" | "size" | "variantGroup" | "descriptionCategoryId" | "typeId">>) => Promise<MutationResult<SupplierDbRow>>
  updateRow: (
    sourceId: string,
    productId: string,
    patch: Partial<UpsertSupplierDbRowRequest>,
  ) => Promise<MutationResult<SupplierDbRow>>
  /**
   * Cell-level write — the inline editors' seam. Same merged row PUT with
   * `expectedRevision` CAS as updateRow; exists so call sites read as
   * "one cell changed" while the payload stays a whole-row upsert.
   * Writes to one row serialize on a per-row chain: a second commit waits for
   * the in-flight PUT, then re-reads the reconciled row (fresh revision) so
   * the user's own edits never 409 against each other.
   */
  patchCell: (
    sourceId: string,
    productId: string,
    patch: Partial<UpsertSupplierDbRowRequest>,
  ) => Promise<MutationResult<SupplierDbRow>>
  /**
   * Notion duplicate: same row payload, title carries the「副本」suffix, and
   * the source's 默认字段 (Ozon config) follow. A failed config copy keeps the
   * new row — the create already committed — and reports `configCopyError`.
   */
  duplicateRow: (
    sourceId: string,
    productId: string,
  ) => Promise<MutationResult<DuplicatedRow>>
  /**
   * Archive a row (archived 标记 — the row leaves the default table and the
   * gallery). Rides the row PUT with `archived: true` on the upsert wire.
   */
  archiveRow: (
    sourceId: string,
    productId: string,
  ) => Promise<MutationResult<SupplierDbRow>>
  deleteRow: (
    sourceId: string,
    productId: string,
  ) => Promise<MutationResult<void>>
  publishRow: (
    sourceId: string,
    productId: string,
  ) => Promise<MutationResult<SupplierDbRow>>
  unpublishRow: (
    sourceId: string,
    productId: string,
  ) => Promise<MutationResult<SupplierDbRow>>
  adjustPrice: (
    sourceId: string,
    productId: string,
    priceCents: number,
    note: string,
  ) => Promise<MutationResult<SupplierDbRow>>
  presignUpload: (
    sourceId: string,
    request: PresignSupplierDbUploadRequest,
  ) => Promise<MutationResult<SupplierDbUploadTarget>>
}

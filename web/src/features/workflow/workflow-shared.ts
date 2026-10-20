import type {
  CategoryFieldOption,
  CategoryFieldView,
  CategorySchemaRequest,
  CategorySchemaView,
  ListingCardSummary,
  WorkflowDraftSelection,
  WorkflowDraftValue,
  WorkflowDraftView,
} from "@/bindings/commands"
import { readWorkflowValue, valueAsText } from "./workflow-draft"

export const DEFAULT_AI_PROMPT =
  "识别画面主体、风格和可见颜色，生成适合 Ozon 的中俄文商品标题、俄文搜索标签和客观商品描述。"

export type WorkflowShellMode = "library" | "runner"

export function singleSelection(option: CategoryFieldOption): WorkflowDraftValue {
  return { kind: "single_select", value: selection(option) }
}

export function selection(option: CategoryFieldOption): WorkflowDraftSelection {
  return { dictionary_value_id: option.id, value: option.value }
}

/**
 * Ozon attribute ids the workbench resolves by number, never by key. A live
 * schema names an attribute field `attribute_{id}` while the local category
 * fixture uses a prose key for the same attribute, so only the id is stable.
 */
export const DESCRIPTION_ATTRIBUTE_ID = 4191
export const SELLER_CODE_ATTRIBUTE_ID = 9024
export const MODEL_NAME_ATTRIBUTE_ID = 9048
/** Live label `#主题标签`. The workbench column still says 搜索标签. */
export const SEARCH_TAGS_ATTRIBUTE_ID = 23171
/**
 * Ozon 的 `JSON富内容`（rich-content JSON）属性。富内容里嵌的是这一件商品自己的
 * 图片/视频，任何一份卡默认值都拼不出它，所以它由操作员逐行填写，并且是表格列。
 */
export const RICH_CONTENT_ATTRIBUTE_ID = 11254
/**
 * Ozon 的 `主题` 属性（字典 726，44 个选项、最多 5 项）。卡默认是批量回退，
 * 行里打过的值在发送时赢。数字油画没选主题时，空白方案和读侧投影填「抽象化」，
 * 避免字典第一项「汽车和摩托车」被当成默认。货源行默认字段不配置它。
 */
export const THEME_ATTRIBUTE_ID = 7109

export function fieldByAttributeId(
  schema: CategorySchemaView | undefined,
  attributeId: number,
): CategoryFieldView | undefined {
  return schema?.fields.find((field) => field.attribute_id === attributeId)
}

/**
 * Where a field's value lives in a Workflow draft. The Rust source-identity
 * injector only accepts plain fields, so a complex placement here is a schema
 * the workbench reads but never writes back into item 0 by accident.
 */
export function fieldLocation(field: CategoryFieldView): {
  complexId?: number
  itemIndex?: number
} {
  return field.complex_id == null
    ? {}
    : { complexId: field.complex_id, itemIndex: 0 }
}

export function schemaRequest(schema: CategorySchemaView): CategorySchemaRequest {
  return {
    description_category_id: schema.description_category_id,
    type_id: schema.type_id,
    language: schema.language,
  }
}

/** Seller-facing labels for stable fixed product/import keys. */
const FIXED_FIELD_LABELS: Record<string, string> = {
  offer_id: "商家货号",
  name: "商品名称",
  price: "销售价",
  description_category_id: "类目 ID",
  type_id: "商品类型 ID",
  barcode: "商品条码",
  width: "包装宽度",
  height: "包装高度",
  depth: "包装长度",
  dimension_unit: "尺寸单位",
  weight: "包装重量",
  weight_unit: "重量单位",
  images: "商品图片",
  images360: "360° 图片",
  primary_image: "主图",
  color_image: "颜色样本",
  currency_code: "价格币种",
  old_price: "划线价",
  vat: "增值税率",
}

/** Localize fixed fields without changing their stable schema or Draft keys. */
export function displayFieldName(field: CategoryFieldView) {
  if (field.source !== "fixed") return field.name
  return FIXED_FIELD_LABELS[field.key] ?? field.name
}

/** Seller-facing labels for Ozon / schema group keys. */
const GROUP_LABELS: Record<string, string> = {
  fixed: "售价与包装",
  aspect: "卖点规格",
  "卖点维": "卖点规格",
  аспекты: "卖点规格",
  "ozon.视频": "商品视频",
  "ozon.video": "商品视频",
  ozon视频封面: "视频封面",
  "ozon video cover": "视频封面",
  "pdf 文件": "说明书文档",
  "pdf файл": "说明书文档",
}

/** Map raw schema / Ozon group names to commercial panel titles. */
export function displayGroupName(name: string) {
  const trimmed = name.trim()
  if (!trimmed) return "其他参数"
  const mapped = GROUP_LABELS[trimmed.toLocaleLowerCase()]
  if (mapped) return mapped
  if (/视频封面/i.test(trimmed)) return "视频封面"
  if (/ozon.*视频|视频.*ozon/i.test(trimmed)) return "商品视频"
  if (/^pdf\b/i.test(trimmed)) return "说明书文档"
  return trimmed
}

export function fieldPlaceholder(field: CategoryFieldView) {
  if (field.key === "dimension_unit") return "例如：mm"
  if (field.key === "weight_unit") return "例如：g"
  if (field.key === "currency_code") return "留空则使用店铺币种"
  if (field.key === "vat") return "例如：0.2"
  if (field.editor === "url") return "https://…"
  if (field.editor === "integer") return "输入整数"
  if (field.editor === "decimal") return "输入数字"
  return `填写${displayFieldName(field)}`
}

export function cardSummaryFromDraft(
  form: WorkflowDraftView,
): ListingCardSummary {
  return {
    supplier_product_id: form.supplier_product_id,
    draft_id: form.draft_id,
    display_name: form.display_name,
    description_category_id: form.schema.description_category_id,
    type_id: form.schema.type_id,
    language: form.schema.language || "zh_hans",
    size: form.size?.trim() || undefined,
    price: valueAsText(form.draft.values.price).trim() || undefined,
    old_price: valueAsText(form.draft.values.old_price).trim() || undefined,
    defaults: form.draft,
    ai_prompt_file_name: form.ai_prompt_file_name,
    psd_template_file_name: form.psd_template_file_name,
    target_store_id: form.target_store_id,
    video_count: form.lifecycle.product_videos.length,
    gallery_item_id: galleryItemIdFromHandle(form.lifecycle.source_asset_handle),
    updated_at_ms: form.updated_at_ms,
  }
}

/** Card 主图: Gallery Item UUID in `source_asset_handle`. Instance `asset:` handles are ignored. */
export function galleryItemIdFromHandle(handle?: string): string | undefined {
  const value = handle?.trim()
  if (!value) return undefined
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  )
    ? value
    : undefined
}

export function upsertSavedForm<T extends { draft_id: string; updated_at_ms: number }>(
  forms: T[],
  saved: T,
): T[] {
  return [saved, ...forms.filter((form) => form.draft_id !== saved.draft_id)].sort(
    (left, right) => right.updated_at_ms - left.updated_at_ms,
  )
}

export function savedFormTitle(
  form:
    | WorkflowDraftView
    | Pick<ListingCardSummary, "display_name" | "description_category_id">,
) {
  if ("kind" in form) {
    if (form.kind === "template" && form.display_name.trim()) return form.display_name.trim()
    const title = valueAsText(readWorkflowValue(form.draft, "name")).trim()
    if (title) return title
    if (form.display_name.trim()) return form.display_name.trim()
    return form.kind === "instance"
      ? `新商品草稿 · 类目 ${form.schema.description_category_id}`
      : `类目 ${form.schema.description_category_id} 模板`
  }
  if (form.display_name.trim()) return form.display_name.trim()
  return `类目 ${form.description_category_id} 模板`
}

export function commandCode(reason: unknown): string | undefined {
  if (typeof reason !== "object" || reason === null || !("code" in reason)) {
    return undefined
  }
  const code = reason.code
  return typeof code === "string" ? code : undefined
}

export async function copyListingCardTemplate(
  cardDraftId: string,
  copy: (draftId: string) => Promise<WorkflowDraftView>,
) {
  if (!cardDraftId.trim()) throw new Error("缺少上架方案标识。")
  const copied = await copy(cardDraftId)
  if (
    copied.kind !== "template" ||
    copied.draft_id === cardDraftId ||
    copied.parent_card_id
  ) {
    throw new Error("无法打开这个上架方案，请稍后重试。")
  }
  return copied
}

export function commandError(reason: unknown, fallback: string) {
  if (typeof reason === "object" && reason !== null && "message" in reason) {
    const message = reason.message
    if (typeof message === "string" && message.trim()) {
      const remediation = "remediation" in reason ? reason.remediation : undefined
      return typeof remediation === "string" && remediation.trim()
        ? `${message}。${remediation}`
        : message
    }
  }
  if (typeof reason === "string" && reason.trim()) return reason
  return fallback
}

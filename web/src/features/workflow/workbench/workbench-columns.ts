import type { CategoryFieldView, CategorySchemaView } from "@/bindings/commands"
import { MEDIA_ROLE_LABEL, type MediaRoleKey } from "../media/workflow-media-roles"
import {
  DESCRIPTION_ATTRIBUTE_ID,
  MODEL_NAME_ATTRIBUTE_ID,
  RICH_CONTENT_ATTRIBUTE_ID,
  SEARCH_TAGS_ATTRIBUTE_ID,
  SELLER_CODE_ATTRIBUTE_ID,
  THEME_ATTRIBUTE_ID,
  fieldByAttributeId,
} from "../workflow-shared"

/**
 * How a column names the category field it writes. A live schema calls 简介
 * `attribute_4191` while the local fixture calls it `description`, so only the
 * attribute id is stable; the Seller import keys (`name`, `offer_id`, the four
 * media roles) are stable as keys because they are not attributes at all.
 */
type ColumnFieldRef =
  | { by: "key"; key: string }
  | { by: "attribute"; id: number }

export type WorkbenchColumn = {
  id: string
  /** Header text. The select column carries the checkbox instead. */
  label: string
  /** Width classes the head and the body cell share, so the two cannot drift. */
  width: string
  /** Frozen-left offset; each side adds its own z-index and fill. */
  sticky?: string
  /** The stronger divider that closes the frozen group. */
  edge?: boolean
  /**
   * The category field this column writes per row. Absent means the column is
   * not a field at all — see the declaration below for which ones and why.
   */
  field?: ColumnFieldRef
  /**
   * Why 默认字段 locks this field (the dialog sentence). This is the lock
   * reason only — the cell's own source claim is the per-row build marker.
   */
  lockReason?: string
  /**
   * 逐行输入列：值是操作员在这一行打上去的，卡/行默认字段仍可留一份批量兜底 ——
   * Rust 的 `handEditedKeys` 让打过的值在发送 overlay 里赢
   * （`instance_defaults.rs::overlay_current_card_defaults`）。它因此不进
   * `tableOwnedFields`：把那面锁掉等于扔掉批量默认值。
   */
  tableInput?: true
}

const FROM_SOURCE_FILE = "由原图文件名构建"
const FROM_AI_PER_IMAGE = "由 AI 识图逐图构建"
const FROM_MEDIA_PIPELINE = "由 PSD 切片与公网交付构建"
const FROM_OPERATOR_PER_ROW = "由操作员逐行填写"

/** The four media role columns, in the order the table renders them. */
export const MEDIA_ROLE_COLUMNS: readonly MediaRoleKey[] = [
  "images",
  "images360",
  "primary_image",
  "color_image",
]

/**
 * Every column of the batch table, in render order.
 *
 * Three of them carry no `field`, and that is the design rather than an omission:
 * 原图 is the source file a row was built from, 发布状态 is lifecycle, and the
 * select column is selection. None of them can lock anything in the 默认字段
 * dialog, because there is no field id for the two surfaces to collide on.
 *
 * 搜索标签 owns attribute 23171 (`#主题标签`). The cell still edits
 * `lifecycle.ai_summary` until that write path lands; the column already owns
 * the field so 默认字段 locks it the same way it locks 名称.
 *
 * JSON富内容 owns attribute 11254. Nothing can build it but the operator: rich
 * content embeds this row's own media. It is still a `tableInput` — the card
 * default is the batch starting point an untouched row inherits.
 *
 * 主题 owns attribute 7109 — an Ozon dictionary (44 options, at most 5). Picking
 * them is a per-row judgement an operator makes while reviewing the batch, but the
 * card default may still carry one theme for untouched rows.
 *
 * 销售价 (`price`) and 划线价 (`old_price`), 主题 and JSON富内容 are the four
 * `tableInput` columns: the operator types them on the row, but a 默认字段 may
 * still carry the batch value that untouched rows inherit. That is why they carry
 * a `lockReason` and yet stay out of `tableOwnedFields` — locking the card input
 * would throw the fallback away.
 *
 * The columns that do carry a field are the whole of the collision: the same
 * key addresses a column here and an input there, and this list is where that
 * fact is stated once.
 */
export const WORKBENCH_COLUMNS: readonly WorkbenchColumn[] = [
  { id: "select", label: "", width: "w-10 min-w-10 max-w-10", sticky: "left-0" },
  {
    id: "source",
    label: "原图",
    width: "w-20 min-w-20 max-w-20",
    sticky: "left-10",
  },
  {
    id: "publish_state",
    label: "发布状态",
    width: "w-48 min-w-48",
    sticky: "left-[7.5rem]",
    edge: true,
  },
  {
    id: "name",
    label: "名称",
    width: "min-w-56",
    field: { by: "key", key: "name" },
    lockReason: FROM_AI_PER_IMAGE,
  },
  {
    id: "offer_id",
    label: "货号",
    width: "w-40 min-w-40",
    field: { by: "key", key: "offer_id" },
    lockReason: FROM_SOURCE_FILE,
  },
  {
    id: "model",
    label: "型号",
    width: "w-40 min-w-40",
    field: { by: "attribute", id: MODEL_NAME_ATTRIBUTE_ID },
    // 型号 is the row's own value the operator types here; the pipeline only
    // fills a blank one from the source file name, which is why the lock reason
    // still says the file builds it and why the cell shows that stem as its
    // fallback placeholder. Rust keeps 9048 instance-owned
    // (`product_instance_owned_keys`), so a written 型号 is what the card
    // default, the Seller-SKU import, AI and the file name may not overwrite.
    lockReason: FROM_SOURCE_FILE,
  },
  {
    id: "price",
    label: "销售价",
    width: "w-24 min-w-24",
    field: { by: "key", key: "price" },
    // 销售价是逐行输入：卡默认字段留批量价，操作员在这一行打过的值赢（handEditedKeys）。
    tableInput: true,
    lockReason: FROM_OPERATOR_PER_ROW,
  },
  {
    id: "old_price",
    label: "划线价",
    width: "w-24 min-w-24",
    field: { by: "key", key: "old_price" },
    tableInput: true,
    lockReason: FROM_OPERATOR_PER_ROW,
  },
  {
    id: "description",
    label: "简介",
    width: "min-w-48",
    field: { by: "attribute", id: DESCRIPTION_ATTRIBUTE_ID },
    lockReason: FROM_AI_PER_IMAGE,
  },
  {
    id: "tags",
    label: "搜索标签",
    width: "w-40 min-w-40",
    field: { by: "attribute", id: SEARCH_TAGS_ATTRIBUTE_ID },
    lockReason: FROM_AI_PER_IMAGE,
  },
  {
    id: "theme",
    label: "主题",
    width: "min-w-48",
    field: { by: "attribute", id: THEME_ATTRIBUTE_ID },
    // 主题是字典里的运营选择：行里选的赢，没选的行走卡默认的批量主题
    // （与两列价格同一套 tableInput 语义）。
    tableInput: true,
    lockReason: FROM_OPERATOR_PER_ROW,
  },
  {
    id: "rich_content",
    label: "JSON富内容",
    width: "min-w-48",
    field: { by: "attribute", id: RICH_CONTENT_ATTRIBUTE_ID },
    // 富内容嵌的是本行的媒体：操作员逐行粘贴，没贴过的行才继承卡默认。
    tableInput: true,
    lockReason: FROM_OPERATOR_PER_ROW,
  },
  ...MEDIA_ROLE_COLUMNS.map((role): WorkbenchColumn => ({
    id: role,
    label: MEDIA_ROLE_LABEL[role],
    width: "w-44 min-w-44",
    field: { by: "key", key: role },
    lockReason: FROM_MEDIA_PIPELINE,
  })),
]

const COLUMN_BY_ID = new Map(WORKBENCH_COLUMNS.map((column) => [column.id, column]))

function resolveFieldRef(
  schema: CategorySchemaView,
  ref: ColumnFieldRef,
): CategoryFieldView | undefined {
  return ref.by === "key"
    ? schema.fields.find((field) => field.key === ref.key)
    : fieldByAttributeId(schema, ref.id)
}

/** One column by id. An unknown id is a typo in the table, not a runtime state. */
export function workbenchColumn(id: string): WorkbenchColumn {
  const column = COLUMN_BY_ID.get(id)
  if (!column) throw new Error(`未知的工作台列：${id}`)
  return column
}

/** The schema field one column writes, or undefined when this category has none. */
export function workbenchColumnField(
  schema: CategorySchemaView,
  columnId: string,
): CategoryFieldView | undefined {
  const ref = workbenchColumn(columnId).field
  return ref ? resolveFieldRef(schema, ref) : undefined
}

/**
 * Every schema field one column writes. Both lock maps read a column through
 * here, so neither surface can lock a field the other leaves editable. One
 * column writes exactly the field it declares: 货号 and 型号 shared a column
 * until 型号 got an editor of its own.
 */
export function workbenchColumnFields(
  schema: CategorySchemaView,
  columnId: string,
): CategoryFieldView[] {
  const field = workbenchColumnField(schema, columnId)
  return field ? [field] : []
}

/**
 * Fields the pipeline writes with no column of their own. Rust's
 * `inject_source_identity` puts the source file stem into the seller code
 * attribute alongside `offer_id` and 型号名称, so it is overwritten before every
 * publish exactly like a column would be — the operator just never sees it in
 * the table, and saying「表格列」about it would be a lie. (型号名称 has its own
 * 型号 column and `offer_id` its own 货号 column, so neither is listed here.)
 */
const PIPELINE_INJECTED: ReadonlyArray<{ attributeId: number; lockReason: string }> = [
  { attributeId: SELLER_CODE_ATTRIBUTE_ID, lockReason: FROM_SOURCE_FILE },
]

/**
 * Every field key the batch table (or the injector behind it) owns per row,
 * mapped to why that surface owns it. `tableInput` columns are the exception:
 * they write the field without taking it away from the defaults.
 *
 * A column and a 默认字段 input address a field by the same key, so a key in
 * both has to resolve one way: the row write wins, because it happens after the
 * card default and on every publish. The dialog still renders the field —
 * hiding 商家货号 only sends an operator hunting for it — but locked, carrying
 * this sentence.
 */
export function tableOwnedFields(
  schema: CategorySchemaView,
): ReadonlyMap<string, string> {
  const owned = new Map<string, string>()
  for (const column of WORKBENCH_COLUMNS) {
    if (column.tableInput) continue
    for (const field of workbenchColumnFields(schema, column.id)) {
      owned.set(field.key, `${column.lockReason}（表格列「${column.label}」）`)
    }
  }
  for (const { attributeId, lockReason } of PIPELINE_INJECTED) {
    const field = fieldByAttributeId(schema, attributeId)
    if (field && !owned.has(field.key)) {
      owned.set(field.key, `${lockReason}（发布前由管线注入，表格不显示）`)
    }
  }
  return owned
}

/**
 * Card defaults are batch-wide; these fields are not. They are produced from
 * source identity, AI recognition, or media delivery for each Product
 * Instance. AI write permission is not ownership: required card defaults may
 * also be AI-editable, so the table ownership map is the complete boundary.
 */
export function productInstanceDefaultExclusions(
  schema: CategorySchemaView,
): string[] {
  return [...tableOwnedFields(schema).keys()]
}

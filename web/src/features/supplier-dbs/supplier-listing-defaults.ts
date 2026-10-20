/**
 * 「默认字段」分区的草稿助手 —— 配置事实在 `supplier_ozon_configs`
 * （`supplier-ozon-config.ts` 负责 wire ↔ `WorkflowCategoryDraft`），这里
 * 只管草稿内计数、行内锁定口径与进度统计。草稿与上架方案卡
 * `payload.defaults` 同构（values / complex_values / cleared）。
 *
 * 行上的默认字段 jsonb 槽位与早期平铺 `{字段: 值}` 形状随单一事实源退场，
 * 读侧不再有任何兜底解析。
 */
import type {
  CategorySchemaView,
  WorkflowCategoryDraft,
} from "@/bindings/commands"
import { fieldOccupancy } from "@/features/workflow/workflow-draft"
import {
  SELLER_CODE_ATTRIBUTE_ID,
  fieldByAttributeId,
} from "@/features/workflow/workflow-shared"
import {
  WORKBENCH_COLUMNS,
  workbenchColumnFields,
} from "@/features/workflow/workbench/workbench-columns"

/** 类目坐标键随草稿存，但它们不算「已配置字段」——摘要与进度一律排除。 */
export const LISTING_DEFAULT_COORDINATE_KEYS = new Set([
  "description_category_id",
  "type_id",
])

/** 「已配置 N 项」的口径：草稿里出现的字段键，坐标键与已清空字段不算。 */
export function rowDefaultsSummary(
  draft: WorkflowCategoryDraft,
): string[] {
  const keys = new Set<string>()
  for (const key of Object.keys(draft.values)) {
    if (!LISTING_DEFAULT_COORDINATE_KEYS.has(key)) keys.add(key)
  }
  for (const group of draft.complex_values) {
    for (const item of group.items) {
      for (const key of Object.keys(item.values)) keys.add(key)
    }
  }
  return [...keys]
}

/**
 * 列 id → 行内分区名。锁理由把操作员送去行页面里改这个值的那一块。
 *
 * 按列 id 而不是字段键：货号与型号已拆成两列，型号没写时回落到货号，
 * 所以两列拿同一条行内理由。
 */
const ROW_SOURCE_BY_COLUMN: Record<string, string> = {
  name: "基本信息·名称",
  offer_id: "基本信息·编号",
  // 型号列（Ozon 9048）逐行取值，没写时回落到货号/原图名，故理由与货号同源。
  model: "基本信息·编号",
  description: "描述",
  tags: "固定 tags",
  images: "媒体",
  images360: "媒体",
  primary_image: "媒体",
  color_image: "媒体",
}

/**
 * 上架表格里由操作员逐行打 / 逐行选的列：理由直接指到表格，不套「取自行内」
 * 句式 —— 行页面里没有这一块可指。按列 id 而不是字段键。
 *
 * 售价 / 划线价 / 主题 / JSON富内容在 `workbench-columns.ts` 里都标了
 * `tableInput`：卡默认字段仍留一份批量值给没打过的行，行里打过的值发送时赢。
 */
const ROW_TABLE_COLUMNS: Record<string, string> = {
  theme: "在上架表格中逐行选择主题",
  rich_content: "在上架表格中逐行填写 JSON富内容",
  price: "在上架表格中逐行设置",
  old_price: "在上架表格中逐行设置划线价",
}

/**
 * 逐行生成的字段锁：与上架表格 `tableOwnedFields` 同一套碰撞边界 —— 同一份
 * `WORKBENCH_COLUMNS`、同一条字段解析（货号与型号已拆列，型号未写时回落货号，
 * 两个字段一起锁），但理由指到行内分区：行页面没有「原图 / 表格列」，这些字段
 * 的值在采纳生成方案时从行自身的数据写回去。
 *
 * 售价 / 划线价 / 主题 / JSON富内容是反向例外：它们是上架表格里的逐行输入
 * （见 `ROW_TABLE_COLUMNS`），行默认字段只展示这条说明，不参与配置。
 */
export function rowOwnedFields(
  schema: CategorySchemaView,
): ReadonlyMap<string, string> {
  const owned = new Map<string, string>()
  for (const column of WORKBENCH_COLUMNS) {
    const source = ROW_SOURCE_BY_COLUMN[column.id]
    const reason =
      ROW_TABLE_COLUMNS[column.id] ??
      (source
        ? `生成方案时逐行写入，取自行内「${source}」`
        : "生成方案时逐行写入")
    for (const field of workbenchColumnFields(schema, column.id)) {
      owned.set(field.key, reason)
    }
  }
  const sellerCode = fieldByAttributeId(schema, SELLER_CODE_ATTRIBUTE_ID)
  if (sellerCode && !owned.has(sellerCode.key)) {
    owned.set(sellerCode.key, "生成方案时逐行写入，取自行内「基本信息·编号」")
  }
  return owned
}

/**
 * 分区头部的两条账本事实：`已配置` = 草稿里有的字段数，
 * `必填` = 可在此编辑的必填字段覆盖率 —— 锁定/只读/复杂组内的必填不在这处分母。
 */
export function rowDefaultsProgress(
  schema: CategorySchemaView,
  draft: WorkflowCategoryDraft,
  lockedFields: ReadonlyMap<string, string>,
): { configured: number; requiredFilled: number; requiredTotal: number } {
  const editable = schema.fields.filter(
    (field) =>
      field.constraints.required &&
      !field.read_only &&
      field.complex_id == null &&
      !lockedFields.has(field.key),
  )
  return {
    configured: rowDefaultsSummary(draft).length,
    requiredFilled: editable.filter(
      (field) => fieldOccupancy(draft, field.key) === "value",
    ).length,
    requiredTotal: editable.length,
  }
}

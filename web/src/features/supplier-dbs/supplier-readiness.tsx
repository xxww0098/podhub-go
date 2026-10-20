/** 行字段预览与服务端 Ozon 配置校验共同决定就绪状态。 */
import type {
  SupplierDbReadiness,
  SupplierDbRow,
  SupplierOzonConfigDenial,
} from "@/bindings/http-supplier-dbs"
import { fixedTagsReady } from "@/lib/fixed-tags"
import { cn } from "@/lib/utils"

// 固定 tags 契约（ocr_tags.rs 镜像）归 @/lib/fixed-tags——re-export 保住
// 既有 ./supplier-readiness 引用路径，新代码请直接引 @/lib/fixed-tags。


/** 检查键 → 中文缺项名（表格/行页面共用同一份文案）。 */
export const READINESS_LABELS: Record<keyof SupplierDbReadiness, string> = {
  category: "类目",
  prompt: "提示词",
  fixedTags: "固定 tags",
  platformPrice: "平台价",
  ozonConfig: "Ozon 配置未校验",
}

/**
 * 管理员看具体码：`ozonConfig` 缺项时按配置轴 denial（`ozonConfigDenial`，
 * 销售态视为已满足）给管理级短语，而不是一句固定的「未校验」。与卖家文案
 * 分属两份表——卖家只看两类，这里报的是同一个原因码。
 */
const OZON_CONFIG_DENIAL_LABELS: Partial<
  Record<SupplierOzonConfigDenial, string>
> = {
  catalog_missing: "目录缺失",
  catalog_expired: "目录已过期",
  config_needs_reconfiguration: "类目更新后待复核",
  catalog_digest_mismatch: "目录摘要不一致",
}

/**
 * 普通字段即时预览；提示词（`validate_brief`）与 Ozon 配置必须由服务端判定，
 * 缺失时不视为就绪——前端不镜像商品说明格式。
 */
export function computeReadiness(row: SupplierDbRow): SupplierDbReadiness {
  return {
    category: row.descriptionCategoryId != null && row.typeId != null,
    prompt: row.readiness.prompt === true,
    fixedTags: fixedTagsReady(row.fixedTags),
    platformPrice: row.platformPriceCents != null,
    ozonConfig: row.readiness.ozonConfig === true,
  }
}

/** 未过检查项的中文标签列表（按声明顺序）。 */
export function missingReadiness(row: SupplierDbRow): string[] {
  const readiness = computeReadiness(row)
  return (Object.keys(READINESS_LABELS) as Array<keyof SupplierDbReadiness>)
    .filter((key) => !readiness[key])
    .map((key) =>
      key === "ozonConfig"
        ? (row.ozonConfigDenial &&
            OZON_CONFIG_DENIAL_LABELS[row.ozonConfigDenial]) ||
          READINESS_LABELS[key]
        : READINESS_LABELS[key],
    )
}

/** 服务端 400 的缺项清单（SupplierDbErrorResponse.missing）→ 中文标签。 */
export function missingFromRefusal(reason: unknown): string[] {
  const missing =
    reason && typeof reason === "object" && "missing" in reason
      ? (reason as { missing?: unknown }).missing
      : undefined
  if (!Array.isArray(missing)) return []
  return missing
    .filter((key): key is string => typeof key === "string")
    .map((key) => READINESS_LABELS[key as keyof SupplierDbReadiness] ?? key)
}

/**
 * 就绪徽标：●就绪 / ◐ 缺 N 项，hover title 列出缺项。
 * 状态列与 publish 按钮旁的接法由并行切片落——这里只交组件。
 */
export function SupplierReadinessBadge({ row }: { row: SupplierDbRow }) {
  const missing = missingReadiness(row)
  const ready = missing.length === 0
  return (
    <span
      data-supplier-readiness=""
      title={ready ? "就绪：上架前置齐备" : `缺：${missing.join("、")}`}
      className={cn(
        "inline-flex items-center whitespace-nowrap text-meta",
        ready ? "text-st-good" : "text-faint-foreground",
      )}
    >
      {ready ? "●就绪" : `◐ 缺 ${missing.length} 项`}
    </span>
  )
}

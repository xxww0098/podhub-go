/**
 * 供应商商品「能否上架」的卖家文案收口——
 * code → 文案的映射全网只有这一个模块：
 *
 * - 行事实 `row.listable` / `row.denial`（行投影）经 `listabilityOf`
 *   （gallery-model.ts）落成两态，这里只管类名与文案；
 * - `cloud_supplier_not_listable` 拒绝（`require_listable` 门）携带
 *   精确 snake_case `denial`（`CloudRefusal.denial`），经
 *   `listabilityFromRefusal` 归到同一两类。
 *
 * 卖家侧只分两类：内部码名对卖家无意义，「平台待处理」
 * （Ozon 配置复核中，自愈/待平台处理）与「已停售」（货源侧不再卖）就够了。
 */
import type { components } from "@/api/schema"
import type { CloudRefusal } from "@/api/client"
import { commandErrorCode } from "@/lib/error-message"

/** `SupplierOzonConfigDenial` 的 schema 别名——调用方与 wire 用同一枚举。 */
export type SupplierOzonConfigDenial =
  components["schemas"]["SupplierOzonConfigDenial"]

/**
 * 卖家侧的可上架性归类：
 * - `platform_pending` — 平台正在复核/恢复该商品的 Ozon 配置；
 * - `delisted` — 商品在货源侧已停售。
 */
export type ListabilityClass = "platform_pending" | "delisted"

/** 货源侧已停售的 denial 集；其余 denial 一律归「平台待处理」。 */
const DELISTED_DENIALS = new Set<SupplierOzonConfigDenial>([
  "source_not_listed",
  "product_archived",
  "sku_not_published",
])

const KNOWN_DENIALS = new Set<string>([
  "source_not_listed",
  "product_archived",
  "sku_not_published",
  "catalog_missing",
  "catalog_expired",
  "config_needs_reconfiguration",
  "catalog_digest_mismatch",
  "prompt_invalid",
])

export function listabilityClass(
  denial: SupplierOzonConfigDenial,
): ListabilityClass {
  return DELISTED_DENIALS.has(denial) ? "delisted" : "platform_pending"
}

/** 动作条下一行的说明句——解释「为什么现在不可上架」，不是错误、不是告警。 */
export const LISTABILITY_EXPLAIN: Record<ListabilityClass, string> = {
  platform_pending: "平台正在复核该商品的 Ozon 配置，暂不可上架",
  delisted: "该商品已停售，不可上架",
}

/** 卡片/清单行的小徽标。 */
export const LISTABILITY_BADGE: Record<ListabilityClass, string> = {
  platform_pending: "暂不可上架",
  delisted: "已停售",
}

/** Cloud `supplier_not_listable` 拒绝到浏览器侧的落名（client.ts 的 cloud_ 前缀口径）。 */
export const SUPPLIER_NOT_LISTABLE_CODE = "cloud_supplier_not_listable"

/** 批量导入跳过暂不可上架行的一次性报数。 */
export function listabilitySkippedNotice(skipped: number): string {
  return `已跳过 ${skipped} 件暂不可上架的商品`
}

/**
 * 拒绝 → 归类。只认 `cloud_supplier_not_listable` 这一个 code；denial 缺失
 * 或是不认识的未来码时归 `platform_pending`——不臆造停售事实，也不退回
 * 通用重试文案（重试救不回一条 fail-closed 拒绝）。
 */
export function listabilityFromRefusal(
  reason: unknown,
): ListabilityClass | null {
  if (commandErrorCode(reason) !== SUPPLIER_NOT_LISTABLE_CODE) return null
  const denial = (reason as CloudRefusal).denial
  return denial && KNOWN_DENIALS.has(denial)
    ? listabilityClass(denial as SupplierOzonConfigDenial)
    : "platform_pending"
}

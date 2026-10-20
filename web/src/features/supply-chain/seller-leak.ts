/**
 * Seller DTO / UI firewall (ADR-0093, ADR-0094).
 *
 * Mirrors `tests/cloud/common/seller_leak.rs` key rules and adds the SHIP-04
 * copy phrases the SPA must never render. Scanner mechanics live in
 * `@/lib/leak-scan` (shared with the supplier firewall).
 */
import { collectLeakedKeys } from "@/lib/leak-scan"

const FORBIDDEN_KEYS = [
  "supplierid",
  "suppliername",
  "sourcename",
  "sourcesku",
  "channelsku",
  "channelorderref",
  "factoryid",
  "factoryname",
  "factorysku",
  "route",
  "routing",
  "scsources",
  "procurementid",
  "operationid",
  "suppliercost",
  "suppliercostsnapshotcents",
  "presetid",
  // supplier-dbs admin-only keys (docs/supplier-dbs.md §7.2): the seller DTO
  // drops them structurally; their appearance in a payload is always a leak.
  "internalnote",
  "contact",
  "psd",
  "promptcontent",
  "promptfilename",
  "createdby",
  "viewprefs",
  "rowcount",
  "publishedcount",
  "expectedrevision",
  // 默认字段是行级上架配置（Ozon payload），不是画廊展示事实——seller DTO
  // 结构性不含它，出现即泄漏。
  "listingdefaults",
] as const

const FORBIDDEN_PREFIXES = [
  "supplier",
  "factory",
  "procurement",
  "upstream",
  "channel",
  // cost* is admin-only on the new seller DTO — `sourceId` is NOT forbidden:
  // SellerSupplierDbCatalogData legitimately carries it as the db linkage.
  "cost",
] as const

/** Visible copy / raw payload tokens that must not appear in seller UI. */
export const FORBIDDEN_SELLER_PHRASES = [
  "再创建一次",
  "供货来源",
  "供应商",
  "supplier_id",
  "supplierId",
  "operationId",
  "operation_id",
  "procurement_id",
  "channel_sku",
  "warehouseName",
  "sellerPayment",
] as const

/** Keys in `value` that violate the seller DTO firewall. */
export function sellerLeakKeys(value: unknown): string[] {
  return collectLeakedKeys(value, FORBIDDEN_KEYS, FORBIDDEN_PREFIXES)
}

export function sellerLeakPhrases(text: string): string[] {
  // 「平台货源」 is the seller-facing name of the new domain (docs/supplier-dbs.md
  // §7.1 rail group); the bare 「供应商」 phrase guards the retired channel
  // catalog's vocabulary, so the legitimate term leaves the text first.
  const stripped = text.replace(/平台货源/g, "")
  return FORBIDDEN_SELLER_PHRASES.filter((phrase) => stripped.includes(phrase))
}

export function assertSellerSurfaceClean(value: unknown, text: string): void {
  const leaked = sellerLeakKeys(value)
  if (leaked.length > 0) {
    throw new Error(`seller surface leaked keys ${JSON.stringify(leaked)}`)
  }
  const phrases = sellerLeakPhrases(text)
  if (phrases.length > 0) {
    throw new Error(`seller surface leaked phrases ${JSON.stringify(phrases)}`)
  }
}

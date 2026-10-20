/**
 * Supplier DTO / UI firewall (ADR-0100, `docs/delegate-orders.md` §8).
 *
 * Mirrors `tests/cloud/common/supplier_leak.rs`: every factory-visible shape
 * is whitelist-assembled, so the appearance of any ownership key — org /
 * store / seller identity, store name, workspace, Ozon sku, dispatch
 * internals (attemptedBy, attempt counters) — is always a leak, `null`
 * values included. `sourceId` is deliberately absent: the factory's own
 * linkage (`/api/supplier/me`, `SellerSupplierDbData` header) legitimately
 * carries it.
 */

import { collectLeakedKeys } from "@/lib/leak-scan"

const FORBIDDEN_KEYS = [
  "orgid",
  "orguuid",
  "organizationid",
  "storeid",
  "storeuuid",
  "storename",
  "seller",
  "sellerid",
  "sellername",
  "sourcename",
  "supplierid",
  "suppliername",
  "factoryid",
  "factoryname",
  "attemptedby",
  "attemptedat",
  "attemptcount",
  "attempts",
  "dispatchattempts",
] as const

const FORBIDDEN_PREFIXES = ["workspace", "attempt", "sku"] as const

/** Keys in `value` that violate the supplier DTO firewall. */
export function supplierLeakKeys(value: unknown): string[] {
  return collectLeakedKeys(value, FORBIDDEN_KEYS, FORBIDDEN_PREFIXES)
}

export function assertSupplierSurfaceClean(value: unknown): void {
  const leaked = supplierLeakKeys(value)
  if (leaked.length > 0) {
    throw new Error(`supplier surface leaked keys ${JSON.stringify(leaked)}`)
  }
}

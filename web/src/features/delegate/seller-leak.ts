/**
 * Seller-side firewall mirror for the delegate feature (ADR-0100,
 * `docs/delegate-orders.md` §8).
 *
 * Mirrors `tests/cloud/common/seller_leak.rs` for the keys the 委托订单
 * seller surface must never render: factory internals (contact / internal
 * note / cost), the misnamed factory-name keys (`name` is the only legit
 * factory-name key) and the dispatch internals the seller wire drops
 * (no dispatchId / attemptedBy / attempt counters). Scanner mechanics live
 * in `@/lib/leak-scan`, shared with the supplier and supply-chain firewalls.
 */
import { collectLeakedKeys } from "@/lib/leak-scan"

const FORBIDDEN_KEYS = [
  "contact",
  "internalnote",
  "sourcename",
  "factoryid",
  "factoryname",
  "supplierid",
  "suppliername",
  "suppliercost",
  "suppliercostsnapshotcents",
  "dispatchid",
  "attemptedby",
  "attemptcount",
  "attempts",
  "dispatchattempts",
] as const

const FORBIDDEN_PREFIXES = [
  // cost* / factory* / supplier* / attempt* — `sourceId` is NOT forbidden:
  // SellerSupplierDbData legitimately carries it as the factory linkage, and
  // `sellerNote` is the seller's own随单备注.
  "cost",
  "factory",
  "supplier",
  "attempt",
] as const

/** Keys in `value` that violate the delegate seller firewall. */
export function delegateLeakKeys(value: unknown): string[] {
  return collectLeakedKeys(value, FORBIDDEN_KEYS, FORBIDDEN_PREFIXES)
}

export function assertDelegateSurfaceClean(value: unknown): void {
  const leaked = delegateLeakKeys(value)
  if (leaked.length > 0) {
    throw new Error(`delegate seller surface leaked keys ${JSON.stringify(leaked)}`)
  }
}

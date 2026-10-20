/**
 * Freshness vocabulary — the SPA half of the threshold table
 * `src/store/product_sync/freshness.rs` owns. The shared fixture
 * `web/tests/fixtures/product-freshness.json` pins both sides to the same
 * numbers; drift fails `freshness.test.ts` here and the Rust test there.
 *
 * The read APIs already stamp `freshness` per store; these helpers exist for
 * what the wire does not say — the age labels the table paints and the unit
 * tests' parity check.
 */

export type ProductFreshness = "fresh" | "stale" | "expired" | "never"

/** Reconcile cadence (choices D14): the one period freshness ages against. */
export const RECONCILE_PERIOD_MS = 4 * 60 * 60 * 1000
/** Past three days a mirror cannot be trusted at all (choices D17). */
export const EXPIRED_AFTER_MS = 3 * 24 * 60 * 60 * 1000
export const FAILURE_EXPIRES_AT = 3

/**
 * One fact's freshness against its refresh period. `undefined` reference =
 * never learned = `never`; the three-day cap (choices D17) bounds `fresh`
 * even for two reconcile periods.
 */
export function classifyFreshness(
  referenceMs: number | undefined | null,
  periodMs: number,
  consecutiveFailures: number,
  nowMs: number,
): ProductFreshness {
  if (referenceMs === undefined || referenceMs === null) return "never"
  if (consecutiveFailures >= FAILURE_EXPIRES_AT) return "expired"
  const age = Math.max(0, nowMs - referenceMs)
  if (age < 2 * periodMs && age < EXPIRED_AFTER_MS) return "fresh"
  if (age < EXPIRED_AFTER_MS) return "stale"
  return "expired"
}

/** A store answers with its reconcile commit — badge and numbers share it. */
export function storeFreshness(
  lastFullSyncAtMs: number | undefined | null,
  consecutiveFailures: number,
  nowMs: number,
): ProductFreshness {
  return classifyFreshness(
    lastFullSyncAtMs,
    RECONCILE_PERIOD_MS,
    consecutiveFailures,
    nowMs,
  )
}

/** The label the tables paint — `never` is a state, never a zero. */
export function freshnessLabel(freshness: ProductFreshness): string {
  switch (freshness) {
    case "fresh":
      return "新鲜"
    case "stale":
      return "过期"
    case "expired":
      return "失效"
    case "never":
      return "暂无数据"
  }
}

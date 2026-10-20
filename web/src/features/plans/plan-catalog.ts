import type { SeatCatalogData, SeatCatalogTierView } from "@/bindings/commands"

/**
 * Display mapping for plan keys: Chinese names, taglines, billing-term labels
 * and the checkout's quick-pick quantities.
 *
 * This file deliberately holds **no price, discount or entitlement facts**.
 * The purchasable catalog — tiers, per-seat-month prices, terms + discounts,
 * seat bounds, Store bindings — lives in Cloud's `billing::seats` price book
 * and reaches the UI as `GET /api/plans` → `data.seat_catalog`. Nothing here
 * may feed a quote; a price change lands server-side only (B6).
 */
export type PlanKey = "lite" | "pro" | "max" | "ultra"
export type PaidTier = Exclude<PlanKey, "lite">

/** Default entitlement badge — a Workspace with no unexpired paid lot. */
export const DEFAULT_BADGE: PlanKey = "lite"

export type PlanDef = { key: PlanKey; name: string; tagline: string }

/**
 * Column order and display names for the compare table and badge mapping.
 * Per-tier seats/prices/features come from the seat catalog — a tier is a
 * purchasable member-seat class, not a fixed bundle.
 */
export const PLAN_CATALOG: PlanDef[] = [
  { key: "lite", name: "免费版", tagline: "默认 · 1 名成员 · 1 家店铺" },
  { key: "pro", name: "Plus 版", tagline: "Plus 档 · 按成员席位计费" },
  { key: "max", name: "商业版", tagline: "商业档 · 按成员席位计费" },
  { key: "ultra", name: "企业版", tagline: "企业档 · 按成员席位计费" },
]

/**
 * One Workspace's member-seat ceiling (`billing::seats`
 * `MAX_MEMBER_SEATS_PER_WORKSPACE`). Purchasable bounds ship on the seat
 * catalog; this constant only remains for the admin code-minting form's
 * input clamp, which predates the catalog endpoint.
 */
export const MAX_MEMBER_SEATS_PER_WORKSPACE = 20

/**
 * Quick-pick seat counts on the checkout. These are UI affordances — not SKUs —
 * clamped against the seat catalog's workspace headroom; Cloud stays
 * authoritative and the dialog re-checks at submit.
 */
export const SEAT_QUICK_QUANTITIES = [1, 5, 10, 20] as const

/** Billing-term display labels keyed by `SeatCatalogTermView::key`. */
export const SEAT_TERM_LABELS: Record<string, string> = {
  month: "月付",
  quarter: "季付",
  year: "年付",
}

export function seatTermLabel(key: string): string {
  return SEAT_TERM_LABELS[key] ?? key
}

export function normalizePlanKey(plan?: string | null): PlanKey | undefined {
  const key = plan?.trim().toLowerCase()
  if (key === "free") return "lite"
  return PLAN_CATALOG.some((plan) => plan.key === key) ? (key as PlanKey) : undefined
}

/**
 * Tier rank for display-only comparisons (which lots an upgrade supersedes).
 * Money never depends on this: credit comes from the server projection.
 */
export function planRank(key?: string | null): number {
  const normalized = normalizePlanKey(key) ?? DEFAULT_BADGE
  return PLAN_CATALOG.findIndex((plan) => plan.key === normalized)
}

export function planByKey(key?: PlanKey | null): PlanDef {
  return PLAN_CATALOG.find((plan) => plan.key === key) ?? PLAN_CATALOG[0]
}

export function planDisplayName(plan?: string | null): string {
  return planByKey(normalizePlanKey(plan)).name
}

/** The catalog row for a paid tier; `undefined` while the catalog loads. */
export function seatCatalogTier(
  catalog: SeatCatalogData | undefined,
  key: string,
): SeatCatalogTierView | undefined {
  return catalog?.tiers.find((tier) => tier.key === key)
}

/** `term.key`'s row on `catalog.terms`. */
export function seatCatalogTerm(catalog: SeatCatalogData | undefined, key: string) {
  return catalog?.terms.find((term) => term.key === key)
}

/**
 * The per-term seat-month price `quote_seats` would freeze — read straight
 * off the catalog projection, never recomputed from constants.
 */
export function seatUnitMonthCents(
  catalog: SeatCatalogData | undefined,
  tier: string,
  term: string,
): number | undefined {
  return seatCatalogTier(catalog, tier)?.terms.find((row) => row.term === term)
    ?.unit_month_cents
}

export function yuanLabel(cents: number): string {
  if (cents % 100 === 0) return `¥${cents / 100}`
  return `¥${(cents / 100).toFixed(2)}`
}

const GIB = 1024 ** 3

export function bytesLabel(bytes: number): string {
  if (bytes >= GIB) {
    const gib = bytes / GIB
    return `${Number.isInteger(gib) ? gib : gib.toFixed(1)} GiB`
  }
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`
  return `${bytes} B`
}

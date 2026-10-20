import { peekAccountOverview } from "@/features/account/account-overview-cache"

import type { MonitorProduct, StorePerformance, SyncState } from "./product-list-model"

/**
 * The 商品 screen's last successful sweep, kept per Account and Store.
 *
 * The screen's rule is that entering it never reads Ozon — the Store-wide sweep
 * stays operator-triggered. But a reload, a remount or a re-login must not throw
 * away what 「同步整店」 already paid for, so the *derived* render state is stashed
 * here and repainted on entry. The sync chip carries `lastSyncAtMs` from the
 * stashed sync states, so restored data can never pass as freshly read.
 *
 * `sessionStorage`, not `localStorage`: the stash belongs to this tab's visit
 * and dies with the tab, while surviving reloads and dev-server page reloads.
 * The key carries the active Account so a second Account signing in on this tab
 * never inherits the first one's snapshot.
 */
const STORAGE_KEY_PREFIX = "podhub.products.snapshot.v1"

/** A day, the same ceiling the category tree cache uses. */
const MAX_AGE_MS = 24 * 60 * 60 * 1000

export type ProductSnapshot = {
  products: MonitorProduct[]
  syncStates: SyncState[]
  performance: StorePerformance
}

type CachedSnapshot = ProductSnapshot & {
  storeUid: string
  /**
   * The newest Ozon read this stash holds, not the stash's write time: reading
   * or repainting a stash must not extend how long it stays servable, or a
   * never-synced tab could keep an old sweep alive forever.
   */
  syncedAtMs: number
}

/** Every primitive `MonitorProduct` field the table reads; arrays checked separately. */
const PRODUCT_FIELDS = {
  productId: "number",
  offerId: "string",
  sku: "number",
  name: "string",
  categoryName: "string",
  primaryImageUrl: "string",
  imageCount: "number",
  officialState: "string",
  statusName: "string",
  isArchived: "boolean",
  issueCount: "number",
  issueLevel: "string",
  issueCode: "string",
  issueMessage: "string",
  price: "number",
  oldPrice: "number",
  currencyCode: "string",
  stockPresent: "number",
  stockReserved: "number",
  promotionDiscountPercent: "number",
  promotionActionTitle: "string",
  promotionActionPrice: "string",
  hitsView: "number",
  sessionView: "number",
  orderedUnits: "number",
  revenue: "number",
  staleUnsold: "boolean",
} as const satisfies Record<
  keyof Omit<MonitorProduct, "sessionViewSeries">,
  "string" | "number" | "boolean"
>

const SYNC_DOMAINS = ["products", "prices", "stocks", "metrics"] as const

function isProduct(value: unknown): value is MonitorProduct {
  if (!value || typeof value !== "object") return false
  const product = value as Record<string, unknown>
  if (
    !Array.isArray(product.sessionViewSeries) ||
    !product.sessionViewSeries.every((point) => typeof point === "number")
  ) {
    return false
  }
  return Object.entries(PRODUCT_FIELDS).every(
    ([field, kind]) => typeof product[field] === kind,
  )
}

function isSyncState(value: unknown): value is SyncState {
  if (!value || typeof value !== "object") return false
  const item = value as Record<string, unknown>
  return (
    SYNC_DOMAINS.some((domain) => item.domain === domain) &&
    typeof item.lastSyncAtMs === "number" &&
    typeof item.lastError === "string" &&
    typeof item.rateLimitedUntilMs === "number"
  )
}

function isPerformance(value: unknown): value is StorePerformance {
  if (!value || typeof value !== "object") return false
  const performance = value as Record<string, unknown>
  return (
    typeof performance.periodDays === "number" &&
    typeof performance.hitsView === "number" &&
    typeof performance.sessionView === "number" &&
    typeof performance.orderedUnits === "number" &&
    typeof performance.revenue === "number" &&
    typeof performance.throughDay === "string"
  )
}

function isCachedSnapshot(value: unknown, storeUid: string): value is CachedSnapshot {
  if (!value || typeof value !== "object") return false
  const cached = value as Record<string, unknown>
  return (
    cached.storeUid === storeUid &&
    typeof cached.syncedAtMs === "number" &&
    Array.isArray(cached.products) &&
    cached.products.every(isProduct) &&
    Array.isArray(cached.syncStates) &&
    cached.syncStates.every(isSyncState) &&
    isPerformance(cached.performance)
  )
}

function storageKey(storeUid: string): string | null {
  const account = peekAccountOverview()?.accounts?.find((item) => item.active)?.uuid
  if (!account || !storeUid) return null
  return `${STORAGE_KEY_PREFIX}:${account}:${storeUid}`
}

function sessionStorageOrNull(): Storage | null {
  if (typeof window === "undefined") return null
  try {
    return window.sessionStorage
  } catch {
    // The accessor itself is refused in some privacy modes; run uncached.
    return null
  }
}

/** Read this tab's last sweep for one Store; null when absent, stale or corrupt. */
export function readProductSnapshot(storeUid: string): ProductSnapshot | null {
  const key = storageKey(storeUid)
  const storage = sessionStorageOrNull()
  if (!key || !storage) return null
  try {
    const raw = storage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isCachedSnapshot(parsed, storeUid)) return null
    // An unparseable stamp is NaN and a clock that moved backwards is negative;
    // both mean "cannot tell how old this is", which is a miss, not a hit.
    const age = Date.now() - parsed.syncedAtMs
    if (!(age >= 0 && age <= MAX_AGE_MS)) {
      storage.removeItem(key)
      return null
    }
    const { storeUid: _storeUid, syncedAtMs: _syncedAtMs, ...snapshot } = parsed
    return snapshot
  } catch {
    return null
  }
}

/** Stash a sweep this tab may repaint later; a full quota costs only the cache. */
export function writeProductSnapshot(storeUid: string, snapshot: ProductSnapshot): void {
  const syncedAtMs = snapshot.syncStates.reduce(
    (newest, item) => Math.max(newest, item.lastSyncAtMs),
    0,
  )
  if (syncedAtMs <= 0) return
  const key = storageKey(storeUid)
  const storage = sessionStorageOrNull()
  if (!key || !storage) return
  const payload = JSON.stringify({ ...snapshot, storeUid, syncedAtMs })
  try {
    storage.setItem(key, payload)
  } catch {
    // The sweep is the largest thing this tab keeps; drop the previous one and
    // try once more, then run uncached rather than hold the small keys hostage.
    try {
      storage.removeItem(key)
    } catch {
      // Nothing to drop.
    }
    try {
      storage.setItem(key, payload)
    } catch {
      // Still over quota: this visit runs uncached.
    }
  }
}

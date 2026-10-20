import { useMemo } from "react"

import type { OzonStoresOverview, OzonStoreView } from "@/bindings/commands"
import { integrationsHttp } from "@/bindings/http-integrations"
import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { isCredentialExpiredAt } from "@/lib/credential-expiry"
import { createSessionCache, type SessionCacheEntry } from "@/lib/session-cache"

/** Keep a recent Workspace roster local while operators move between modules. */
export const STORE_ROSTER_TTL_MS = 60_000

export type StoreRosterCacheEntry = {
  overview: OzonStoresOverview
  cachedAt: number
}

const cache = createSessionCache<OzonStoresOverview>(
  // The shell already holds the account standing. Reuse it so the roster
  // read does not issue a second overview GET when that snapshot is present.
  () => integrationsHttp.integrationsListOzonStores(peekAccountOverview()),
  { ttlMs: STORE_ROSTER_TTL_MS },
)

function toEntry(
  entry: SessionCacheEntry<OzonStoresOverview> | undefined,
): StoreRosterCacheEntry | undefined {
  return entry && { overview: entry.value, cachedAt: entry.cachedAt }
}

/**
 * A lapsed Seller key is refused by every Ozon exit until it is re-registered,
 * so the Store stays in the roster (it must still paint its badge and accept a
 * new key) but no ops screen may treat it as usable.
 */
export function isStoreKeyExpired(
  store: Pick<OzonStoreView, "key_expires_at_ms">,
  now = Date.now(),
): boolean {
  return isCredentialExpiredAt(store.key_expires_at_ms, now)
}

/** Cloud is the Seller credential owner; device-local re-entry is irrelevant to reads. */
export function activeCloudStoreUid(
  store: OzonStoreView,
  now = Date.now(),
): string | undefined {
  const uid = store.cloud_store_uuid?.trim()
  return store.configured &&
    store.cloud_status === "active" &&
    !isStoreKeyExpired(store, now) &&
    uid
    ? uid
    : undefined
}

/** Active Cloud stores with `id` rewritten to the Cloud UUID ops screens send. */
export function cloudConfiguredStores(overview: OzonStoresOverview): OzonStoreView[] {
  return overview.stores.flatMap((store) => {
    const uid = activeCloudStoreUid(store)
    return uid ? [{ ...store, id: uid }] : []
  })
}

export function rosterHasUnavailableStores(
  overview: OzonStoresOverview,
  now = Date.now(),
): boolean {
  return overview.stores.some(
    (store) =>
      store.configured &&
      Boolean(store.cloud_store_uuid?.trim()) &&
      (store.cloud_status === "manual_disabled" ||
        store.cloud_status === "quota_suspended" ||
        isStoreKeyExpired(store, now)),
  )
}

/** Unkeyed reads must not share a "session" slot across Workspace switches. */
export function storeRosterCacheKey(workspaceId?: number): string | undefined {
  return workspaceId === undefined ? undefined : String(workspaceId)
}

export function isStoreRosterCacheFresh(
  entry: StoreRosterCacheEntry,
  now = Date.now(),
  ttlMs = STORE_ROSTER_TTL_MS,
): boolean {
  return now - entry.cachedAt < ttlMs
}

export function rememberStoreRoster(
  overview: OzonStoresOverview,
  workspaceId?: number,
  now = Date.now(),
): void {
  const key = storeRosterCacheKey(workspaceId)
  if (key === undefined) return
  cache.remember(key, overview, now)
}

export function peekStoreRoster(workspaceId?: number): StoreRosterCacheEntry | undefined {
  const key = storeRosterCacheKey(workspaceId)
  if (key === undefined) return undefined
  return toEntry(cache.peek(key))
}

/** Drop one Workspace's painted roster without caching an empty miss as fresh. */
export function forgetStoreRoster(workspaceId?: number): void {
  const key = storeRosterCacheKey(workspaceId)
  if (key === undefined) return
  cache.drop(key)
}

export function invalidateStoreRoster(): void {
  cache.invalidate()
}

export function subscribeStoreRoster(onStoreChange: () => void): () => void {
  return cache.subscribe(onStoreChange)
}

export function useStoreRoster(workspaceId?: number): StoreRosterCacheEntry | undefined {
  const entry = cache.use(storeRosterCacheKey(workspaceId))
  return useMemo(() => toEntry(entry), [entry])
}

export async function loadStoreRoster(options?: {
  workspaceId?: number
  force?: boolean
}): Promise<OzonStoresOverview> {
  const key = storeRosterCacheKey(options?.workspaceId)
  if (key === undefined) {
    return integrationsHttp.integrationsListOzonStores()
  }
  return cache.load(key, { force: options?.force })
}

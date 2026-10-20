/**
 * One-time move of browser-local state from the pre-rebrand `ozon-pod` names
 * to `podhub` (specs/podhub-rebrand P1).
 * The interim `podx` names never reached production; only dev browsers hold
 * `podx` keys, so nothing is moved from them (their render-cache log is
 * dropped below).
 *
 * Preferences and user-built lists are copied to the new key when it is still
 * empty; pure caches are dropped because they rebuild on demand.
 *
 * Removal: delete this module and its call sites (main.tsx,
 * media-object mirror) 90 days after the release
 * that ships it (specs/podhub-rebrand P5). Until then every call is idempotent.
 * The gallery's legacy database move left with the 本地图库 feature.
 */

const PREFERENCE_KEYS = [
  "theme",
  "sidebar-open",
  "store-colors.v1",
  "message-center.replies",
  "media-objects.v2",
  "supplier-dbs-gallery.density",
  "supplier-dbs-gallery.listing-queue",
  "supplier-dbs-gallery.favorites",
] as const

const COLON_KEYS = ["active-store", "spa-device-id"] as const

/** Old-name prefixes whose entries are caches; they are removed, not moved. */
const CACHE_PREFIXES = [
  "ozon-pod.workflow.category-tree.",
  "ozon-pod.products.snapshot.",
  "ozon-pod.render-cache.",
  "ozon-pod.upload-slot.",
  // The interim `podx` render-cache use log, held only by dev browsers: it is
  // a cache log, so there is nothing to move.
  "podx.render-cache.",
] as const

export const LEGACY_MEDIA_DB = "ozon-pod-media"

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">

function moveKey(storage: KeyValueStorage, from: string, to: string): void {
  const value = storage.getItem(from)
  if (value === null) return
  if (storage.getItem(to) === null) storage.setItem(to, value)
  storage.removeItem(from)
}

/** Synchronous; run once before the first render. Failures (quota, blocked storage) leave the old keys in place. */
export function migrateLegacyStorage(
  local: KeyValueStorage | undefined = globalThis.localStorage,
  session: KeyValueStorage | undefined = globalThis.sessionStorage,
): void {
  try {
    if (local) {
      for (const key of PREFERENCE_KEYS) moveKey(local, `ozon-pod.${key}`, `podhub.${key}`)
      for (const key of COLON_KEYS) moveKey(local, `ozon-pod:${key}`, `podhub:${key}`)
    }
    for (const storage of [local, session]) {
      if (!storage) continue
      const stale: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix))) stale.push(key)
      }
      for (const key of stale) storage.removeItem(key)
    }
  } catch {
    // Storage can throw in locked-down browsers; the new names simply start empty.
  }
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve) => {
    const req = factory.deleteDatabase(name)
    req.onsuccess = () => resolve()
    req.onerror = () => resolve()
    req.onblocked = () => resolve()
  })
}

async function legacyExists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases !== "function") return true
  const list = await factory.databases()
  return list.some((entry) => entry.name === name)
}

/** The media mirror is a cache of Cloud confirmations; the old database is simply dropped. */
export async function dropLegacyMediaMirror(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): Promise<void> {
  if (!factory || !(await legacyExists(factory, LEGACY_MEDIA_DB))) return
  await deleteDatabase(factory, LEGACY_MEDIA_DB)
}

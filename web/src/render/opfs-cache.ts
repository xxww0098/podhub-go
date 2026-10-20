/**
 * Origin Private File System cache policy for the render module.
 *
 * The first write of a tab claims storage persistence and no later one does.
 * An unpersisted origin is evictable; saved templates can be downloaded again,
 * while unsaved sources still require the operator's original files.
 *
 * ## Eviction policy
 *
 * Persistence is what stops the *browser* from reclaiming this directory, so
 * once it is granted nothing but this module ever frees a byte. Two rules
 * bound it:
 *
 * 1. `renders/{rowId}` is dropped the moment it is dead weight — its slices
 *    reached the Public Media URL, which `docs/listing-design.md` §3.1.1 makes
 *    the source a delivered chip reads, or its row was deleted. This is exact,
 *    not a heuristic, so it never waits for a ceiling.
 * 2. Everything else is a cache under one byte ceiling, evicted
 *    least-recently-used. Use is recorded by `touch` in an in-memory log
 *    mirrored to localStorage on a debounce, because an OPFS read cannot
 *    restamp the file it read and rewriting 254 MiB to record a read is not
 *    a cache, it is a copy. LRU rather than oldest-first because the entry a
 *    batch is using right now is by definition the most recently used one,
 *    and that is the entry eviction must not take.
 *
 * The use log is a mirror of OPFS, never its truth, and the two desync in one
 * direction that does not heal itself: a log that has lost entries reports a
 * smaller cache than there is, so the ceiling stops tripping and the bytes it
 * can no longer see are evictable by nothing. Every device that already holds a
 * cache starts in exactly that state, and so does one whose localStorage was
 * cleared or half-written. So the first sweep of a tab `survey`s the four
 * family directories and rebuilds the log from what is actually on disk, taking
 * each entry's last write as the stand-in for a use nobody recorded. The other
 * direction needs no help: an entry in the log with no file behind it is a
 * `removeEntry` that finds nothing, which is the wanted end state anyway.
 *
 * The ceiling counts the bytes this module wrote, not the origin-wide
 * `estimate()` the 设置 panel reports: a sweep can only free what it wrote, and
 * measuring against IndexedDB and Cache Storage too would evict the render
 * cache to pay for another store's growth. A device whose whole quota is under
 * the ceiling therefore meets `QuotaExceededError` before the sweep ever runs,
 * and 清理本机缓存 on 设置 is the escape hatch for that — and for a use log that
 * a cleared localStorage left behind bytes it can no longer see.
 */
import { OpfsUnavailable, remove, root } from "./opfs-io"

/**
 * Rule 2 of the eviction policy. Chromium's own quota is a share of free disk
 * and says nothing about what a render cache is worth keeping, so the ceiling
 * is this module's own number and this is the knob to turn when a machine
 * wants a bigger or smaller working set.
 */
const CACHE_CEILING_BYTES = 4 * 1024 ** 3

export const USE_LOG_KEY = "podhub.render-cache.v1"

/**
 * The evictable families. Every entry directly under one of these is one
 * evictable unit, which is why a static-slice cache is keyed by its template
 * fingerprint alone: the render profiles under it are the same template's
 * slices, and evicting them together keeps the survey a single flat walk.
 * A new family that is not listed here is a new unbounded leak.
 */
const CACHE_FAMILIES = ["templates", "sources", "renders", "static-slices"]

/** When each cache entry was last used, and what it costs to keep. */
type CacheUse = Record<string, { at: number, size: number }>

/**
 * The log lives in memory for the life of the tab; localStorage is a mirror
 * written on a debounce, never per use. A batch touches the log once per
 * slice, and the old per-touch parse-mutate-stringify of the whole map was
 * the most expensive part of a cache hit. A crashed tab loses at most one
 * debounce window of uses, which the next survey rebuilds from disk anyway.
 */
let cachedLog: CacheUse | undefined
let logDirty = false
let logFlushTimer: ReturnType<typeof setTimeout> | undefined
let logLifecycleBound = false

const USE_LOG_FLUSH_MS = 500

function readUseLog(): CacheUse {
  if (cachedLog) return cachedLog
  try {
    const raw = globalThis.localStorage?.getItem(USE_LOG_KEY)
    cachedLog = raw ? (JSON.parse(raw) as CacheUse) : {}
  } catch {
    // A corrupt or unavailable log costs a cold cache, never a failed render.
    cachedLog = {}
  }
  return cachedLog
}

/**
 * Write the in-memory log to localStorage now. The debounce timer calls it,
 * `pagehide` / a hidden tab call it so the mirror is fresh at the moment it
 * matters, and tests call it before asserting on the mirror. A refused write
 * stays dirty so the next flush retries it.
 */
export function flushUseLog(): void {
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = undefined
  }
  if (!logDirty) return
  logDirty = false
  try {
    globalThis.localStorage?.setItem(USE_LOG_KEY, JSON.stringify(cachedLog ?? {}))
  } catch {
    // Same bargain: an unrecorded use is evicted early, not a broken write.
    logDirty = true
  }
}

function bindLogLifecycle(): void {
  if (logLifecycleBound || typeof window === "undefined" || !window.addEventListener) return
  logLifecycleBound = true
  window.addEventListener("pagehide", flushUseLog)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushUseLog()
  })
}

function writeUseLog(log: CacheUse): void {
  cachedLog = log
  logDirty = true
  bindLogLifecycle()
  logFlushTimer ??= setTimeout(flushUseLog, USE_LOG_FLUSH_MS)
}

/** Test-only: a freshly stubbed origin rereads its log and asks for persistence. */
export function resetUseLogForTest(): void {
  persistence = undefined
  if (logFlushTimer) {
    clearTimeout(logFlushTimer)
    logFlushTimer = undefined
  }
  cachedLog = undefined
  logDirty = false
  surveyed = false
}

function totalBytes(log: CacheUse): number {
  return Object.values(log).reduce((total, entry) => total + entry.size, 0)
}

/**
 * Record that `key` — one evictable entry, `templates/{sha}.psd` or a
 * directory — was just used, and how big it is. A read omits the size and
 * keeps whatever the write logged.
 */
export function touch(key: string, size?: number): void {
  const log = readUseLog()
  log[key] = { at: Date.now(), size: size ?? log[key]?.size ?? 0 }
  writeUseLog(log)
  // An unsurveyed tab cannot trust the total it just computed, so the first
  // write of the tab starts a sweep whatever the log says.
  if (!surveyed || totalBytes(log) > CACHE_CEILING_BYTES) {
    void sweep()
  }
}

export function forget(key: string): void {
  const log = readUseLog()
  delete log[key]
  writeUseLog(log)
}

function fileUse(file: File): { size: number, at: number } {
  return { size: file.size, at: file.lastModified }
}

/** Bytes under one entry, and the last time any of them was written. */
async function measure(handle: FileSystemDirectoryHandle): Promise<{ size: number, at: number }> {
  let size = 0
  let at = 0
  for await (const [, entry] of handle.entries()) {
    const found =
      entry.kind === "file"
        ? fileUse(await (entry as FileSystemFileHandle).getFile())
        : await measure(entry as FileSystemDirectoryHandle)
    size += found.size
    at = Math.max(at, found.at)
  }
  return { size, at }
}

/**
 * Whether this tab has swept once. Only a trigger: eviction itself never reads
 * it, so a sweep called directly always measures first.
 */
let surveyed = false

/**
 * Rebuild the use log from OPFS itself: what is on disk decides what is
 * evictable, and the log only decides the order. A recorded use survives — it
 * is better evidence than a file timestamp — but every size is re-measured, so
 * drift a partial write left behind is corrected here rather than accumulated.
 *
 * Every sweep does this, because a sweep is about to delete and measuring
 * first is the cheap half. Sweeps are rare: over the ceiling, or the one the
 * first write of a tab starts.
 */
async function survey(): Promise<CacheUse> {
  surveyed = true
  const log = readUseLog()
  for (const family of CACHE_FAMILIES) {
    let directory: FileSystemDirectoryHandle
    try {
      directory = await (await root()).getDirectoryHandle(family)
    } catch {
      // A family this device has never written, or an engine with no OPFS.
      continue
    }
    for await (const [name, entry] of directory.entries()) {
      const found =
        entry.kind === "file"
          ? fileUse(await (entry as FileSystemFileHandle).getFile())
          : await measure(entry as FileSystemDirectoryHandle)
      const key = `${family}/${name}`
      log[key] = { at: log[key]?.at ?? found.at, size: found.size }
    }
  }
  writeUseLog(log)
  // A survey is a commit point: the mirror a crash would read is refreshed
  // here rather than a debounce later.
  flushUseLog()
  return log
}

let sweeping: Promise<void> | undefined

/**
 * Evict least-recently-used entries until the cache is back under the ceiling.
 * Single-flight because a source import fans out four wide and four concurrent
 * sweeps would each evict against the same stale total. Failures are swallowed:
 * a sweep that cannot free bytes must not fail the write that triggered it.
 */
export function sweep(): Promise<void> {
  sweeping ??= evict()
    .catch(() => undefined)
    .finally(() => {
      sweeping = undefined
    })
  return sweeping
}

/**
 * `min(4 GiB, half the origin quota)`. The fixed ceiling bounds what the
 * cache may hold on a roomy device; on one whose whole quota is smaller it
 * is a promise the hardware cannot keep, so the stop line follows the
 * reported quota instead. An engine that cannot report one keeps the fixed
 * ceiling. The log still counts only this module's bytes — the quota half is
 * a budget, not a measurement.
 */
async function evictionTarget(): Promise<number> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return CACHE_CEILING_BYTES
  }
  try {
    const quota = (await navigator.storage.estimate()).quota
    if (typeof quota === "number" && quota > 0) {
      return Math.min(CACHE_CEILING_BYTES, Math.floor(quota / 2))
    }
  } catch {
    // No answer keeps the fixed ceiling.
  }
  return CACHE_CEILING_BYTES
}

/**
 * The row store's "which source digests still back a local row" query
 * (`RowRepo.sourcesInUse()`), injected here because `opfs-cache.ts`
 * owns cache eviction and pinning but must not depend on the row store —
 * `web/src/features/workflow/rows/` depends the other way. The default is a
 * no-op returning an empty set, so a build that has not wired a provider yet
 * behaves exactly as before this slice: every source stays evictable.
 */
let pinnedSourcesProvider: () => Promise<Set<string>> = async () => new Set()

/**
 * `setPinnedSources` never caches its own answer across calls — rows are
 * created and deleted between sweeps, so `evict()` and `clearCache()` each
 * ask fresh rather than trusting a snapshot that may already be stale.
 */
export function setPinnedSources(provider: () => Promise<Set<string>>): void {
  pinnedSourcesProvider = provider
}

/** Is `key` (a use-log entry, `sources/{digest}` or another family's) a source pinned by a local row? */
function isPinnedSourceKey(key: string, pinned: Set<string>): boolean {
  return key.startsWith("sources/") && pinned.has(key.slice("sources/".length))
}

async function evict(): Promise<void> {
  const log = await survey()
  const pinned = await pinnedSourcesProvider()
  let total = totalBytes(log)
  const target = await evictionTarget()
  for (const [key, entry] of Object.entries(log).sort((a, b) => a[1].at - b[1].at)) {
    if (total <= target) {
      return
    }
    // A source backing a local row is its only copy (README D3) — eviction
    // must skip it even if that means the sweep can never reach `target`
    // while pinned entries alone are already over it. That is the contract,
    // not a bug: the ceiling yields to "never evicted", never the reverse.
    if (isPinnedSourceKey(key, pinned)) continue
    await remove(key)
    total -= entry.size
    forget(key)
  }
}

/**
 * Drops one family for `clearCache` and `clearCacheFamily` alike. `sources`
 * cannot be a wholesale `remove` any more — a pinned digest is the only copy
 * of that design image on any device (README D3) — so it is walked one
 * digest at a time, the same shape `survey()` already walks, and only the
 * digests nothing pins are removed. The other three families are still pure
 * cache, dropped whole exactly as before this slice.
 */
async function clearFamily(family: string, pinned: Set<string>): Promise<void> {
  if (family !== "sources") {
    await remove(family)
    return
  }
  let directory: FileSystemDirectoryHandle
  try {
    directory = await (await root()).getDirectoryHandle("sources")
  } catch {
    return
  }
  for await (const [digest] of directory.entries()) {
    if (!pinned.has(digest)) await remove(`sources/${digest}`)
  }
}

/** Drop `family`'s use-log entries, keeping whatever `clearFamily` kept on disk. */
function forgetFamily(log: CacheUse, family: string, pinned: Set<string>): void {
  for (const key of Object.keys(log)) {
    if (key !== family && !key.startsWith(`${family}/`)) continue
    if (isPinnedSourceKey(key, pinned)) continue
    delete log[key]
  }
}

/**
 * 清理本机缓存. Everything here except a pinned source is rebuildable — Cloud
 * holds the rows, the operator holds the PSD and the design images — so the
 * escape hatch drops the other families whole rather than reasoning about
 * which of their bytes are still wanted. Sources are narrower: only the
 * digests nothing pins.
 */
export async function clearCache(): Promise<void> {
  const pinned = await pinnedSourcesProvider()
  const log = readUseLog()
  for (const family of CACHE_FAMILIES) {
    await clearFamily(family, pinned)
    forgetFamily(log, family, pinned)
  }
  writeUseLog(log)
  flushUseLog()
}

/** One family's footprint: the evictable entries under it and their bytes. */
export interface CacheFamilyUsage {
  family: string
  entries: number
  bytes: number
}

/**
 * The 本机存储 panel's per-family view — a survey, not an estimate: the
 * numbers come from the same on-disk walk a sweep makes, so a family row
 * reports what a 清理 would actually free.
 */
export async function usageByFamily(): Promise<CacheFamilyUsage[]> {
  const log = await survey()
  const usage = new Map<string, CacheFamilyUsage>(
    CACHE_FAMILIES.map((family) => [family, { family, entries: 0, bytes: 0 }]),
  )
  for (const [key, entry] of Object.entries(log)) {
    const row = usage.get(key.split("/", 1)[0]!)
    if (row) {
      row.entries += 1
      row.bytes += entry.size
    }
  }
  return [...usage.values()]
}

/**
 * Clear one family — the panel's per-row 清理, narrower than `clearCache`'s
 * drop-everything. A name outside `CACHE_FAMILIES` refuses: a typo must not
 * delete a directory the eviction policy never heard of. Routes through the
 * same `clearFamily` as `clearCache`, so the per-family 清理 button is not a
 * second, unpinned way to delete a source a local row still needs.
 */
export async function clearCacheFamily(family: string): Promise<void> {
  if (!CACHE_FAMILIES.includes(family)) {
    throw new Error(`unknown cache family: ${family}`)
  }
  const pinned = await pinnedSourcesProvider()
  await clearFamily(family, pinned)
  const log = readUseLog()
  forgetFamily(log, family, pinned)
  writeUseLog(log)
  flushUseLog()
}

/**
 * The `sources` family's pinned subset: how many digests a local row still
 * references, and how many bytes they hold. `usageByFamily` keeps reporting
 * the family's gross total (pinned and not — every entry is still real bytes
 * on disk); this is the narrower number 设置's 清理 copy needs to say what
 * survives a clear.
 */
export async function pinnedSourceUsage(): Promise<{ count: number, bytes: number }> {
  const log = await survey()
  const pinned = await pinnedSourcesProvider()
  let count = 0
  let bytes = 0
  for (const [key, entry] of Object.entries(log)) {
    if (!isPinnedSourceKey(key, pinned)) continue
    count += 1
    bytes += entry.size
  }
  return { count, bytes }
}

let persistence: Promise<boolean> | undefined

/**
 * Asked once per tab, on the first write. Chromium answers from its own site
 * engagement heuristic and shows no prompt, so a fresh profile is refused —
 * measured on a first visit to the dev origin, `persist()` returned `false`.
 * That is the honest default, not a broken call: the grant arrives once the
 * operator actually uses the app, and the 本机存储 panel on 设置 reports which
 * side of it this profile is on. A `false` never fails a write.
 */
export function requestPersistence(): Promise<boolean> {
  persistence ??=
    typeof navigator === "undefined" || !navigator.storage?.persist
      ? Promise.resolve(false)
      : navigator.storage.persist()
  return persistence
}

/**
 * What this origin holds on the device. `estimate()` is origin-wide — OPFS
 * renders plus IndexedDB, Cache Storage and localStorage — so a screen must
 * present it as 本机存储, not as the render cache alone.
 */
export async function usage(): Promise<{
  usedBytes: number
  quotaBytes: number
  persisted: boolean
}> {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    throw new OpfsUnavailable("navigator.storage.estimate")
  }
  const estimate = await navigator.storage.estimate()
  return {
    usedBytes: estimate.usage ?? 0,
    quotaBytes: estimate.quota ?? 0,
    persisted: (await navigator.storage.persisted?.()) ?? false,
  }
}

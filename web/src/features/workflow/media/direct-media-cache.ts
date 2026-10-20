/** Session/batch-local mirror of authenticated Cloud confirmations, never upload authority. */
import { peekAccountOverview } from "@/features/account/account-overview-cache"
import { browserMediaMirror, type MirrorEntry } from "./media-object-mirror"
import type { CloudAnswer, DeliveredMediaObject, MediaDeliveryScope } from "./direct-media-types"

export const LOCAL_TTL_MS = 1 * 60 * 60 * 1000
/** Persisted entries beyond this are dropped oldest-first. */
export const LOCAL_CAPACITY = 5_000
export const STORAGE_KEY = "podhub.media-objects.v2"

type ObjectClass = "images" | "videos"

/** `media::object_key::MediaObjectClass::from_ext`, as far as the door needs it. */
export function mediaObjectClass(extension: string): ObjectClass {
  return ["mp4", "mov"].includes(extension.toLowerCase()) ? "videos" : "images"
}

let known: Map<string, MirrorEntry> | undefined
const batchKnown = new Map<string, Map<string, MirrorEntry>>()
export const batchExpiresAt = new Map<string, number>()
const storageIdentities = new Map<string, { accountId: string; storageRevision: number }>()

export function activeWorkspaceUuid(): string | undefined {
  return peekAccountOverview()?.active_workspace?.uuid || undefined
}

function identityKey(workspaceUuid: string, extension: string): string {
  return `${workspaceUuid}|${mediaObjectClass(extension)}`
}

export function localKey(
  workspaceUuid: string,
  extension: string,
  digest: string,
  identity?: { accountId?: string; storageRevision?: number },
): string {
  const accountId = identity?.accountId ?? "*"
  const storageRevision = identity?.storageRevision == null ? "*" : String(identity.storageRevision)
  return `${workspaceUuid}|${extension.toLowerCase()}|${digest.toLowerCase()}|${accountId}|${storageRevision}`
}

function localPrefix(workspaceUuid: string, extension: string, digest: string): string {
  return `${workspaceUuid}|${extension.toLowerCase()}|${digest.toLowerCase()}|`
}

/** Drop every entry sharing one workspace/extension/digest prefix. */
function forgetPrefixed(
  entries: Map<string, MirrorEntry>,
  workspaceUuid: string,
  extension: string,
  digest: string,
): void {
  for (const candidate of entries.keys()) {
    if (!candidate.startsWith(localPrefix(workspaceUuid, extension, digest))) continue
    entries.delete(candidate)
    noteDelete(candidate)
  }
}

function legacyStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage
  } catch {
    return undefined
  }
}

function load(): Map<string, MirrorEntry> {
  if (!known) known = new Map()
  return known
}

/**
 * The in-memory map is the source of truth. IndexedDB stores one record per
 * object, debounced, never a single JSON blob. A crashed tab loses a debounce
 * window — a miss only costs the probe the entry would have saved.
 */
const mirror = browserMediaMirror()
const dirtyPuts = new Map<string, MirrorEntry>()
const dirtyDeletes = new Set<string>()
let persistTimer: ReturnType<typeof setTimeout> | undefined
let persistLifecycleBound = false
let hydratePromise: Promise<void> | undefined

const PERSIST_DEBOUNCE_MS = 500

function schedulePersist(): void {
  bindPersistLifecycle()
  persistTimer ??= setTimeout(() => void flushMediaObjects(), PERSIST_DEBOUNCE_MS)
}

function notePut(key: string, entry: MirrorEntry): void {
  dirtyDeletes.delete(key)
  dirtyPuts.set(key, entry)
  schedulePersist()
}

function noteDelete(key: string): void {
  dirtyPuts.delete(key)
  dirtyDeletes.add(key)
  schedulePersist()
}

function trim(entries: Map<string, MirrorEntry>): void {
  while (entries.size > LOCAL_CAPACITY) {
    const oldest = entries.keys().next().value
    if (oldest === undefined) break
    entries.delete(oldest)
    noteDelete(oldest)
  }
}

export function readyMediaObjects(): Promise<void> {
  hydratePromise ??= hydrate()
  return hydratePromise
}

async function hydrate(): Promise<void> {
  let rows: Array<[string, MirrorEntry]> = []
  try {
    rows = await mirror.load()
  } catch {
    rows = []
  }
  const now = Date.now()
  const fromDisk = new Map<string, MirrorEntry>()
  for (const [key, entry] of rows) {
    if (!entry || typeof entry.confirmedAtMs !== "number" || now - entry.confirmedAtMs >= LOCAL_TTL_MS) {
      noteDelete(key)
      continue
    }
    fromDisk.set(key, entry)
  }
  if (!known) known = fromDisk
  else {
    for (const [key, entry] of fromDisk) {
      if (!known.has(key)) known.set(key, entry)
    }
  }
  trim(known)
  try { legacyStorage()?.removeItem(STORAGE_KEY) } catch { /* private mode */ }
}

/**
 * Write dirty records now — the debounce timer, `pagehide` / a hidden tab,
 * and tests before asserting on the mirror. A refused write stays dirty.
 */
export async function flushMediaObjects(): Promise<void> {
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  if (dirtyPuts.size === 0 && dirtyDeletes.size === 0) return
  const puts = [...dirtyPuts]
  const deletes = [...dirtyDeletes]
  dirtyPuts.clear()
  dirtyDeletes.clear()
  try {
    if (deletes.length > 0) await mirror.remove(deletes)
    if (puts.length > 0) await mirror.put(puts)
  } catch {
    for (const key of deletes) if (!dirtyPuts.has(key)) dirtyDeletes.add(key)
    for (const [key, entry] of puts) if (!dirtyDeletes.has(key) && !dirtyPuts.has(key)) dirtyPuts.set(key, entry)
  }
}

/** Drop memory and read the mirror again. A new document does this on its own. */
export async function reloadMediaObjects(): Promise<void> {
  known = undefined
  hydratePromise = undefined
  await readyMediaObjects()
}

function bindPersistLifecycle(): void {
  if (persistLifecycleBound || typeof window === "undefined" || !window.addEventListener) return
  persistLifecycleBound = true
  const flush = () => { void flushMediaObjects() }
  window.addEventListener("pagehide", flush)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush()
  })
}

/** A Cloud-confirmed object, kept only when Cloud's key sits under the active Workspace. */
export function rememberMediaObject(
  answer: CloudAnswer,
  digest: string,
  extension: string,
  now = Date.now(),
  scope?: MediaDeliveryScope,
): void {
  const workspace = scope?.workspaceUuid ?? answer.workspaceUuid ?? activeWorkspaceUuid()
  if (!workspace || activeWorkspaceUuid() !== workspace || !answer.objectKey.includes(`/teams/${workspace}/`)) return
  if (scope?.uploadBatch) {
    rememberBatchObject(scope.uploadBatch, answer, digest, extension, now, workspace)
    return
  }
  // Timestamped objects are intentionally session/batch scoped. A recovery
  // response without its batch must never poison the legacy cache.
  if (answer.objectKey.startsWith("uploads/") || answer.objectKey.includes("/uploads/")) return
  const workspacePrefix = `/teams/${workspace}/`
  const objectTail = answer.objectKey.split(workspacePrefix)[1]
  const shaAt = objectTail?.lastIndexOf("/sha256/") ?? -1
  if (shaAt > 0) return
  const entries = load()
  const identity = { accountId: answer.accountId, storageRevision: answer.storageRevision }
  const key = localKey(workspace, extension, digest, identity)
  // Re-insert so iteration order is confirmation order and capacity trims the oldest.
  forgetPrefixed(entries, workspace, extension, digest)
  const entry = {
    objectKey: answer.objectKey,
    publicUrl: answer.publicUrl,
    accountId: answer.accountId,
    workspaceUuid: workspace,
    storageRevision: answer.storageRevision,
    confirmedAtMs: now,
  }
  entries.set(key, entry)
  trim(entries)
  if (entries.has(key)) notePut(key, entry)
  if (answer.storageRevision != null) {
    storageIdentities.set(identityKey(workspace, extension), {
      accountId: answer.accountId,
      storageRevision: answer.storageRevision,
    })
  }
}

export function lookupMediaObject(
  digest: string,
  extension: string,
  now = Date.now(),
): DeliveredMediaObject | undefined {
  const workspace = activeWorkspaceUuid()
  if (!workspace) return undefined
  const entries = load()
  const identity = storageIdentities.get(identityKey(workspace, extension))
  const exact = identity
    ? entries.get(localKey(workspace, extension, digest, identity))
    : undefined
  const entry = identity
    ? exact
    : [...entries.entries()]
      .filter(([key]) => key.startsWith(localPrefix(workspace, extension, digest)))
      .sort(([, left], [, right]) => right.confirmedAtMs - left.confirmedAtMs)[0]?.[1]
  if (!entry) return undefined
  if (now - entry.confirmedAtMs >= LOCAL_TTL_MS) {
    forgetPrefixed(entries, workspace, extension, digest)
    return undefined
  }
  return {
    publicUrl: entry.publicUrl,
    objectKey: entry.objectKey,
    accountId: entry.accountId,
    workspaceUuid: entry.workspaceUuid ?? workspace,
    storageRevision: entry.storageRevision,
    via: "local",
  }
}
/** Sign-out and tests: nothing local survives. */
export function forgetMediaObjects(): void {
  known = new Map()
  storageIdentities.clear()
  batchKnown.clear()
  batchExpiresAt.clear()
  dirtyPuts.clear()
  dirtyDeletes.clear()
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = undefined
  }
  hydratePromise = Promise.resolve()
  void mirror.clear()
  try { legacyStorage()?.removeItem(STORAGE_KEY) } catch { /* private mode */ }
}

export function forgetCachedObject(workspace: string, extension: string, digest: string, uploadBatch?: string): void {
  if (uploadBatch) {
    batchKnown.get(uploadBatch)?.delete(batchCacheKey(uploadBatch, workspace, extension, digest))
    return
  }
  forgetPrefixed(load(), workspace, extension, digest)
}

function batchCacheKey(batch: string, workspace: string, extension: string, digest: string): string {
  return localKey(workspace, extension, digest) + `|batch:${batch}`
}

export function lookupBatchObject(batch: string, workspace: string, extension: string, digest: string): DeliveredMediaObject | undefined {
  const expiresAt = batchExpiresAt.get(batch)
  if (expiresAt != null && Date.now() >= expiresAt) {
    batchKnown.delete(batch)
    return undefined
  }
  const entry = batchKnown.get(batch)?.get(batchCacheKey(batch, workspace, extension, digest))
  return entry && { ...entry, workspaceUuid: entry.workspaceUuid ?? workspace, via: "local" }
}

export function matchesUploadBatch(batch: string, objectKey: string): boolean {
  const [timestamp, uuid] = batch.split(".")
  const afterUploads = objectKey.startsWith("uploads/")
    ? objectKey.slice("uploads/".length) : objectKey.split("/uploads/")[1]
  return Boolean(timestamp && uuid && afterUploads?.split("/")[1] === `${timestamp}-${uuid}`)
}
function rememberBatchObject(batch: string, answer: CloudAnswer, digest: string, extension: string, now: number, workspace: string): void {
  if (!matchesUploadBatch(batch, answer.objectKey)) return
  const entries = batchKnown.get(batch) ?? new Map<string, MirrorEntry>()
  entries.set(batchCacheKey(batch, workspace, extension, digest), {
    objectKey: answer.objectKey, publicUrl: answer.publicUrl, accountId: answer.accountId,
    workspaceUuid: workspace, storageRevision: answer.storageRevision, confirmedAtMs: now,
  })
  batchKnown.set(batch, entries)
}

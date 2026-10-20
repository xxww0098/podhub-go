/**
 * Origin Private File System storage for the render module.
 *
 * The layout is the Desktop one, path for path, so a render is addressable by
 * the same keys on either executor:
 *
 * ```text
 * templates/{sha256}.psd
 * sources/{sha256}/{fileName}
 * renders/{rowId}/{fileName} + renders/{rowId}/manifest.json
 * static-slices/{sha256(templateFingerprint)}/{sha256(renderProfile)}/slice-{n}.jpg + manifest.json
 * ```
 *
 * Byte IO and worker fallback live in `opfs-io.ts`; eviction, persistence
 * and pinning policy live in `opfs-cache.ts`.
 */
import {
  DEFAULT_RENDER_INTENT,
  type RenderBytes,
  type RenderIntent,
  type RenderSlice,
} from "./wasm"
import { OpfsChannelDead } from "./opfs-channel"
import { buryChannel, io, readFile, remove, writeBlob, writeOnce } from "./opfs-io"
import { forget, requestPersistence, sweep, touch } from "./opfs-cache"

/** The Desktop cache validity key, field for field. */
export interface StaticSliceEntry {
  groupIndex: number
  groupName: string
  width: number
  height: number
  byteSize: number
  contentHash: string
}

interface StaticSliceCache {
  version: number
  templateFingerprint: string
  renderProfile: string
  slices: StaticSliceEntry[]
}

const STATIC_SLICE_CACHE_VERSION = 3
const encoder = new TextEncoder()
const decoder = new TextDecoder()

export async function sha256Hex(input: Uint8Array | string): Promise<string> {
  const bytes = typeof input === "string" ? encoder.encode(input) : input
  // WebCrypto accepts an ArrayBuffer view, not SharedArrayBuffer. Keep the
  // exact byte window without copying ordinary renderer and upload buffers.
  const data = bytes.buffer instanceof ArrayBuffer
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The renderer's own `sha256:{hex}` form, for comparing against a slice. */
export async function contentHash(bytes: RenderBytes): Promise<string> {
  return `sha256:${await sha256Hex(bytes)}`
}

/**
 * `v{n}:{trim|canvas}:{exportScale bits, hex}:{presentationQuality}` — n is
 * `STATIC_SLICE_CACHE_VERSION`. The scale goes in as its IEEE-754 bits so two
 * scales that print alike cannot share a cache.
 */
export function renderProfile(intent: RenderIntent = DEFAULT_RENDER_INTENT): string {
  const bits = new DataView(new ArrayBuffer(8))
  bits.setFloat64(0, intent.exportScale)
  const hex = (offset: number) => bits.getUint32(offset).toString(16).padStart(8, "0")
  return `v${STATIC_SLICE_CACHE_VERSION}:${intent.exportBounds}:${hex(0)}${hex(4)}:${intent.presentationQuality}`
}

export function staticSliceFileName(groupIndex: number): string {
  return `slice-${groupIndex + 1}.jpg`
}

export function staticSliceEntry(slice: RenderSlice): StaticSliceEntry {
  return {
    groupIndex: slice.index,
    groupName: slice.groupName,
    width: slice.width,
    height: slice.height,
    byteSize: slice.bytes.length,
    contentHash: slice.contentHash,
  }
}

/**
 * A device whose whole quota is under the cache ceiling meets
 * `QuotaExceededError` before the byte trigger ever trips a sweep. Freeing
 * least-recently-used entries and trying once more is the only honest
 * recovery; a quota that still refuses after a sweep fails the write.
 */
async function surviveQuota(write: () => Promise<void>): Promise<void> {
  try {
    await write()
  } catch (error) {
    if ((error as DOMException).name !== "QuotaExceededError") throw error
    await sweep()
    await write()
  }
}

async function writeFile(path: string[], name: string, bytes: RenderBytes): Promise<void> {
  // Every OPFS write in this module funnels through here, so this is the one
  // place that has to claim persistence: without it the browser may evict the
  // whole directory under storage pressure and a 254 MiB template is simply
  // gone. Memoised in `requestPersistence`, and never awaited — the answer
  // does not change what this write does.
  void requestPersistence()
  await surviveQuota(() => writeOnce(path, name, bytes))
}

/** `templates/{sha256}.psd`. Returns the digest the template is filed under. */
export async function putTemplate(bytes: RenderBytes): Promise<string> {
  const digest = await sha256Hex(bytes)
  await writeFile(["templates"], `${digest}.psd`, bytes)
  touch(`templates/${digest}.psd`, bytes.length)
  return digest
}

const templateWrites = new Map<string, Promise<void>>()

/** File a PSD whose digest is already known. Chunks, so the caller can upload the same File. */
export function putKnownTemplate(digest: string, file: Blob): Promise<void> {
  const pending = (async () => {
    await surviveQuota(() => writeBlob(["templates"], `${digest}.psd`, file))
    touch(`templates/${digest}.psd`, file.size)
  })()
  templateWrites.set(digest, pending)
  void pending.finally(() => {
    if (templateWrites.get(digest) === pending) templateWrites.delete(digest)
  })
  return pending
}

export async function getTemplate(digest: string): Promise<RenderBytes | null> {
  await templateWrites.get(digest)
  const bytes = await readFile(["templates"], `${digest}.psd`)
  if (bytes) touch(`templates/${digest}.psd`, bytes.length)
  return bytes
}

/** `sources/{sha256}/{fileName}` — the design image, keyed by its own bytes. */
export async function putSource(bytes: RenderBytes, fileName: string): Promise<string> {
  const digest = await sha256Hex(bytes)
  await writeFile(["sources", digest], fileName, bytes)
  touch(`sources/${digest}`, bytes.length)
  return digest
}

export async function getSource(digest: string, fileName: string): Promise<RenderBytes | null> {
  const bytes = await readFile(["sources", digest], fileName)
  if (bytes) touch(`sources/${digest}`, bytes.length)
  return bytes
}

/** Who may replace or delete `renders/{rowId}`. A lower generation cannot. */
export interface RenderArtifactOwner {
  jobId: string
  generation: number
}

async function readRenderOwner(rowId: string): Promise<RenderArtifactOwner | null> {
  const bytes = await readFile(["renders", rowId], "owner.json")
  if (!bytes) return null
  try {
    const owner = JSON.parse(decoder.decode(bytes)) as RenderArtifactOwner
    return typeof owner.jobId === "string" && Number.isFinite(owner.generation) ? owner : null
  } catch {
    return null
  }
}

function ownerIsNewer(existing: RenderArtifactOwner, candidate: RenderArtifactOwner): boolean {
  return existing.generation > candidate.generation
    || (existing.generation === candidate.generation && existing.jobId !== candidate.jobId)
}

/** `renders/{rowId}/{fileName}` plus the manifest, written last. */
export async function putRender(
  rowId: string,
  slices: RenderSlice[],
  manifest: unknown,
  owner?: RenderArtifactOwner,
): Promise<boolean> {
  if (owner) {
    const existing = await readRenderOwner(rowId)
    if (existing && ownerIsNewer(existing, owner)) return false
  }
  for (const slice of slices) {
    await writeFile(["renders", rowId], slice.fileName, slice.bytes)
  }
  const document = encoder.encode(JSON.stringify(manifest))
  await writeFile(["renders", rowId], "manifest.json", document)
  if (owner) {
    await writeFile(["renders", rowId], "owner.json", encoder.encode(JSON.stringify(owner)))
  }
  touch(
    `renders/${rowId}`,
    slices.reduce((total, slice) => total + slice.bytes.length, document.length),
  )
  return true
}

export async function getRender(rowId: string, fileName: string): Promise<RenderBytes | null> {
  const bytes = await readFile(["renders", rowId], fileName)
  if (bytes) touch(`renders/${rowId}`)
  return bytes
}

/** A stored file's preview: the bytes to show, and the original's real size. */
export interface StoredPreview {
  bytes: RenderBytes
  byteSize: number
}

/**
 * A stored file downscaled so its longest edge is `edge` — by the OPFS worker
 * when it is up, where the full image never leaves the worker; without one the
 * stored bytes come back whole and `edge` is advisory, exactly as callers
 * behaved before downscaling existed. A preview is a use of its entry either
 * way. `mime` is the re-encode format: JPEG unless the caller keeps alpha.
 */
async function storedPreview(
  path: string[],
  fileName: string,
  edge: number,
  mime: string | undefined,
): Promise<StoredPreview | null> {
  const key = path.slice(0, 2).join("/")
  const channel = await io()
  if (channel) {
    try {
      const preview = await channel.preview(path, fileName, edge, mime)
      if (!preview) return null
      touch(key)
      return { bytes: preview.bytes as RenderBytes, byteSize: preview.byteSize }
    } catch (error) {
      if (!(error instanceof OpfsChannelDead)) throw error
      buryChannel()
    }
  }
  const bytes = await readFile(path, fileName)
  if (!bytes) return null
  touch(key)
  return { bytes, byteSize: bytes.length }
}

/**
 * `renders/{rowId}/{fileName}` downscaled so its longest edge is `edge` — by
 * the OPFS worker when it is up, where the full image never leaves the
 * worker; without one the stored bytes come back whole and `edge` is
 * advisory, exactly as callers behaved before downscaling existed. A preview
 * is a use of its row's cache entry either way.
 */
export function getRenderPreview(
  rowId: string,
  fileName: string,
  edge: number,
): Promise<StoredPreview | null> {
  return storedPreview(["renders", rowId], fileName, edge, "image/jpeg")
}

/**
 * `sources/{sha256}/{fileName}`, same bargain as `getRenderPreview`. PNG
 * sources re-encode as PNG so a transparent design keeps its alpha in the
 * thumbnail.
 */
export function getSourcePreview(
  digest: string,
  fileName: string,
  edge: number,
): Promise<StoredPreview | null> {
  const mime = /\.png$/i.test(fileName) ? "image/png" : undefined
  return storedPreview(["sources", digest], fileName, edge, mime)
}

/**
 * Rule 1 of the eviction policy: this row's slices are no longer worth a byte
 * on the device. Callers name the two moments — delivery (§3.1.1 sends the chip
 * to the Public Media URL) and deletion of the row itself.
 */
export async function dropRender(rowId: string, owner?: Pick<RenderArtifactOwner, "jobId"> | RenderArtifactOwner): Promise<void> {
  if (owner) {
    const existing = await readRenderOwner(rowId)
    if (existing && existing.jobId !== owner.jobId) return
    if (existing && "generation" in owner && owner.generation !== undefined && ownerIsNewer(existing, owner as RenderArtifactOwner)) {
      return
    }
  }
  await remove(`renders/${rowId}`)
  forget(`renders/${rowId}`)
}

async function staticSlicePath(templateFingerprint: string, profile: string): Promise<string[]> {
  return ["static-slices", await sha256Hex(templateFingerprint), await sha256Hex(profile)]
}

/**
 * The cached manifest, or `null` for anything a reader cannot trust: no file,
 * torn bytes, a foreign schema version, another template or profile, or a
 * `slices` list that is not a list of entries. Every failure is a miss and
 * never an exception — the cache is an optimisation, so a corrupt one has to
 * cost a full render rather than the row. `writeStaticSlices` then overwrites
 * the manifest it could not read, so a miss heals the entry as a side effect.
 */
async function readStaticSliceCache(
  path: string[],
  templateFingerprint: string,
  profile: string,
): Promise<StaticSliceCache | null> {
  const bytes = await readFile(path, "manifest.json")
  if (!bytes) {
    return null
  }
  let cache: Partial<StaticSliceCache> | null
  try {
    cache = JSON.parse(decoder.decode(bytes)) as Partial<StaticSliceCache> | null
  } catch {
    return null
  }
  // JSON holds any value, so "parsed" is not "a manifest": a scalar, an array
  // or a null root is as unusable as torn bytes, and so is a `slices` entry
  // that is not an object — `openStaticSliceCache` reads fields off each one.
  if (!cache || typeof cache !== "object" || !Array.isArray(cache.slices)
    || !cache.slices.every((entry) => Boolean(entry) && typeof entry === "object")) {
    return null
  }
  return cache.version === STATIC_SLICE_CACHE_VERSION &&
    cache.templateFingerprint === templateFingerprint &&
    cache.renderProfile === profile
    ? (cache as StaticSliceCache)
    : null
}

/**
 * Open one row's view of the static cache. The renderer determines which
 * groups it skipped after this manifest read; only those groups need bytes.
 * Keep the manifest within this call's reader, never across rows or batches.
 */
export async function openStaticSliceCache(
  templateFingerprint: string,
  profile: string,
) {
  const path = await staticSlicePath(templateFingerprint, profile)
  const cache = await readStaticSliceCache(path, templateFingerprint, profile)
  if (!cache?.slices.length) return null
  return {
    async read(groups: Pick<RenderSlice, "index" | "groupName">[]) {
      const slices = await Promise.all(groups.map(async ({ index, groupName }) => {
        const entry = cache.slices.find(
          (candidate) => candidate.groupIndex === index && candidate.groupName === groupName,
        )
        if (!entry || entry.width === 0 || entry.height === 0 || entry.byteSize === 0) return null
        const bytes = await readFile(path, staticSliceFileName(entry.groupIndex))
        if (!bytes || bytes.length !== entry.byteSize || (await contentHash(bytes)) !== entry.contentHash) return null
        return { ...entry, bytes }
      }))
      if (slices.some(slice => slice !== null)) touch(path.slice(0, 2).join("/"))
      return slices
    },
  }
}

/**
 * Publishes this render's cacheable groups. Entries for groups outside this
 * batch survive — the selected design decides which groups are static, so a
 * later design fills in the ones this one could not.
 */
export async function writeStaticSlices(
  templateFingerprint: string,
  profile: string,
  slices: RenderSlice[],
): Promise<void> {
  if (slices.length === 0) {
    return
  }
  const path = await staticSlicePath(templateFingerprint, profile)
  const previous = await readStaticSliceCache(path, templateFingerprint, profile)
  const kept = (previous?.slices ?? []).filter(
    (entry) => !slices.some((slice) => slice.index === entry.groupIndex),
  )
  for (const slice of slices) {
    await writeFile(path, staticSliceFileName(slice.index), slice.bytes)
  }
  const cache: StaticSliceCache = {
    version: STATIC_SLICE_CACHE_VERSION,
    templateFingerprint,
    renderProfile: profile,
    slices: [...kept, ...slices.map(staticSliceEntry)].sort((a, b) => a.groupIndex - b.groupIndex),
  }
  // The manifest commits the directory, so it goes last: readers validate every
  // slice they hand back, and an unreadable manifest reads as no cache, so an
  // interrupted write costs one full render instead of serving bad pixels.
  const document = encoder.encode(JSON.stringify(cache))
  await writeFile(path, "manifest.json", document)
  touch(
    path.slice(0, 2).join("/"),
    cache.slices.reduce((total, entry) => total + entry.byteSize, document.length),
  )
}

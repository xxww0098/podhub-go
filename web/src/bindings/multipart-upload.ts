/** Browser multipart PUT. Progress is per finished part: fetch has no upload bytes. */
import { retryAfterMs } from "@/api/client"
import { uploadFailureMessage } from "./upload-failure-copy"
import { slidingRate, etaSeconds, type RateSample } from "./upload-rate"
import {
  deleteResume, psdResumeId, readResume, writeResume, type UploadResumeRecord,
} from "./upload-resume-store"

export const PSD_PART_BYTES = 16 * 1024 * 1024
export const PSD_PART_CONCURRENCY = 4

export type MultipartPart = {
  partNumber: number
  url: string
  byteLength: number
  expiresAtMs: number
}
export type MultipartPlan = {
  uploadId: string
  partSize: number
  ticket: string
  parts: MultipartPart[]
}
export type PartEtag = { partNumber: number; etag: string }
export type UploadProgress = {
  loaded: number
  total: number
  bytesPerSec: number
  etaSec: number
  phase: "hash" | "upload"
}

type Saved = { uploadId: string; ticket: string; partSize: number; bytes: number; completed: PartEtag[] }

const STORAGE_PREFIX = "podhub.psd.v1."

export function sessionKey(sha256: string): string {
  return `${STORAGE_PREFIX}${sha256}`
}

function browserStorage(): Storage | null {
  const candidate = globalThis.localStorage
  if (
    !candidate
    || typeof candidate.getItem !== "function"
    || typeof candidate.setItem !== "function"
    || typeof candidate.removeItem !== "function"
  ) return null
  return candidate
}

export function readSession(sha256: string): Saved | null {
  try {
    const raw = browserStorage()?.getItem(sessionKey(sha256))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Saved
    if (!parsed || typeof parsed.uploadId !== "string" || !Array.isArray(parsed.completed)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeSession(sha256: string, value: Saved): void {
  try {
    browserStorage()?.setItem(sessionKey(sha256), JSON.stringify(value))
  } catch {
    // Private mode or a full quota must not fail the upload itself.
  }
}

export function clearSession(sha256: string): void {
  try {
    browserStorage()?.removeItem(sessionKey(sha256))
  } catch {
    // Same as write: losing the resume note is safer than failing a finished upload.
  }
  void deleteResume(psdResumeId(sha256))
}

function savedFrom(record: UploadResumeRecord | null): Saved | null {
  if (!record?.uploadId || !Array.isArray(record.completedParts)) return null
  return {
    uploadId: record.uploadId,
    ticket: record.ticket ?? "",
    partSize: record.partSize ?? 0,
    bytes: record.byteLength,
    completed: record.completedParts,
  }
}

/** IndexedDB first, then the older localStorage note, which is copied across once. */
export async function loadSession(sha256: string): Promise<Saved | null> {
  const stored = savedFrom(await readResume(psdResumeId(sha256)))
  if (stored) return stored
  const legacy = readSession(sha256)
  if (!legacy) return null
  await saveSession(sha256, legacy)
  try { browserStorage()?.removeItem(sessionKey(sha256)) } catch { /* migration is best-effort */ }
  return legacy
}

export async function saveSession(
  sha256: string,
  value: Saved,
  extra: { rowId?: string; workspaceUuid?: string; fileName?: string; handle?: FileSystemFileHandle } = {},
): Promise<void> {
  writeSession(sha256, value)
  const previous = await readResume(psdResumeId(sha256))
  const record: UploadResumeRecord = {
    id: psdResumeId(sha256),
    kind: "psd",
    sha256: sha256.toLowerCase(),
    rowId: extra.rowId || previous?.rowId || "",
    workspaceUuid: extra.workspaceUuid || previous?.workspaceUuid || "",
    fileName: extra.fileName || previous?.fileName || "",
    byteLength: value.bytes,
    updatedAt: Date.now(),
    descriptionCategoryId: previous?.descriptionCategoryId,
    typeId: previous?.typeId,
    uploadId: value.uploadId,
    ticket: value.ticket,
    partSize: value.partSize,
    completedParts: value.completed,
    objects: previous?.objects ?? [],
    handle: extra.handle ?? previous?.handle,
  }
  await writeResume(record)
}

export function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return ""
  const mb = bytesPerSec / (1000 * 1000)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`
}

export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 24 * 60 * 60) return ""
  const rounded = Math.max(1, Math.round(seconds))
  if (rounded < 60) return `剩余 ${rounded} 秒`
  const minutes = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest === 0 ? `剩余 ${minutes} 分` : `剩余 ${minutes} 分 ${rest} 秒`
}

/**
 * Shared pipe: every byte still crosses once, and each request pays overhead.
 * Concurrent parts overlap that overhead. A per-connection cap is the other model.
 */
export function estimateSeconds(input: {
  bytes: number
  mode: "single" | "multipart"
  overheadSec: number
  bytesPerSec: number
  concurrency?: number
  partSize?: number
  /** When true, connections share one pipe. When false, each connection gets the full rate. */
  sharedPipe?: boolean
}): number {
  const rate = Math.max(1, input.bytesPerSec)
  const overhead = Math.max(0, input.overheadSec)
  if (input.mode === "single") return overhead + input.bytes / rate
  const part = input.partSize ?? PSD_PART_BYTES
  const count = Math.ceil(input.bytes / part)
  const concurrency = Math.max(1, input.concurrency ?? PSD_PART_CONCURRENCY)
  const waves = Math.ceil(count / concurrency)
  if (input.sharedPipe !== false) return waves * overhead + input.bytes / rate
  let seconds = 0
  let left = input.bytes
  for (let wave = 0; wave < waves; wave += 1) {
    const inWave = Math.min(concurrency, count - wave * concurrency)
    const waveBytes = Math.min(left, part * inWave)
    left -= waveBytes
    seconds += overhead + waveBytes / inWave / rate
  }
  return seconds
}

function partError(status: number | undefined, delay?: number): Error {
  const named = status == null
    ? Object.assign(new Error("网络已断开"), { outcomeUnknown: true, name: "TypeError" })
    : { status, code: status === 404 ? "psd_part_gone" : "direct_upload_failed" }
  return Object.assign(new Error(uploadFailureMessage(named)), {
    code: status === 404 ? "psd_part_gone" : "direct_upload_failed",
    status,
    retryAfterMs: delay,
    outcomeUnknown: status == null,
  })
}

function etagMissing(): Error {
  return Object.assign(
    new Error("对象存储没有返回分片 ETag。请在桶的跨域规则里暴露 ETag 后重试"),
    { code: "psd_etag_missing" },
  )
}

async function putPart(
  url: string,
  body: Blob,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
): Promise<string> {
  let response: Response | undefined
  try {
    response = await fetchImpl(url, {
      method: "PUT",
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
      headers: { "Content-Type": "application/octet-stream" },
      body,
    })
  } catch {
    throw partError(undefined)
  }
  try {
    if (!response.ok) throw partError(response.status, retryAfterMs(response.headers))
    const etag = response.headers.get("etag")
    if (!etag) throw etagMissing()
    return etag
  } finally {
    await response.body?.cancel().catch(() => {})
  }
}

async function putWithRetry(
  part: MultipartPart,
  file: Blob,
  partSize: number,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  const start = (part.partNumber - 1) * partSize
  const slice = file.slice(start, start + part.byteLength)
  const body = new Blob([slice], { type: "application/octet-stream" })
  let last: unknown
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (signal?.aborted) throw new DOMException("已取消", "AbortError")
    try {
      return await putPart(part.url, body, signal, fetchImpl)
    } catch (error) {
      last = error
      const status = (error as { status?: number; code?: string }).status
      const code = (error as { code?: string }).code
      if (code === "psd_etag_missing" || code === "psd_part_gone" || signal?.aborted) throw error
      const retry = status == null || status === 429 || status === 503 || status >= 500
      if (!retry || attempt === 3) throw error
      const hinted = (error as { retryAfterMs?: number }).retryAfterMs
      const delay = Math.min(hinted && hinted > 0 ? hinted : 1000 * 2 ** attempt, 8000)
      await sleep(delay)
    }
  }
  throw last
}

export async function uploadParts(
  file: Blob,
  plan: MultipartPlan,
  options: {
    signal?: AbortSignal
    sha256?: string
    onProgress?: (progress: UploadProgress) => void
    fetchImpl?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    target?: { rowId?: string; workspaceUuid?: string; fileName?: string }
  } = {},
): Promise<PartEtag[]> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  const saved = options.sha256 ? await loadSession(options.sha256) : null
  const completed = new Map<number, string>()
  if (saved && saved.uploadId === plan.uploadId && saved.bytes === file.size) {
    for (const part of saved.completed) completed.set(part.partNumber, part.etag)
  }
  const total = file.size
  let loaded = plan.parts.reduce((sum, part) => sum + (completed.has(part.partNumber) ? part.byteLength : 0), 0)
  let samples: RateSample[] = [{ at: Date.now(), bytes: loaded }]
  let displayedRate = 0
  const report = () => {
    const now = Date.now()
    samples.push({ at: now, bytes: loaded })
    const rated = slidingRate(samples, now, displayedRate)
    samples = rated.samples
    displayedRate = rated.rate
    options.onProgress?.({
      loaded,
      total,
      bytesPerSec: displayedRate,
      etaSec: etaSeconds(total - loaded, displayedRate),
      phase: "upload",
    })
  }
  const snapshot = (): Saved => ({
    uploadId: plan.uploadId,
    ticket: plan.ticket,
    partSize: plan.partSize,
    bytes: file.size,
    completed: [...completed.entries()].map(([partNumber, value]) => ({ partNumber, etag: value })),
  })
  report()
  if (options.sha256) await saveSession(options.sha256, snapshot(), options.target)
  let cursor = 0
  const pending = plan.parts.filter((part) => !completed.has(part.partNumber))
  const workers = Array.from({ length: Math.min(PSD_PART_CONCURRENCY, Math.max(1, pending.length || 1)) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      const part = pending[index]
      if (!part) return
      const etag = await putWithRetry(part, file, plan.partSize, options.signal, fetchImpl, sleep)
      completed.set(part.partNumber, etag)
      loaded += part.byteLength
      if (options.sha256) await saveSession(options.sha256, snapshot(), options.target)
      report()
    }
  })
  await Promise.all(workers)
  return plan.parts.map((part) => {
    const etag = completed.get(part.partNumber)
    if (!etag) throw partError(undefined)
    return { partNumber: part.partNumber, etag }
  })
}

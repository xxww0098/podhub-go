/**
 * Structured logs for one listing run: bind, render, encode, upload, submit, verify.
 *
 * Collection follows `client_log_collect` on the account overview the shell
 * already loads. While that flag is off, nothing is buffered and nothing is
 * sent. While it is on, records stay in a capped buffer and leave as one POST.
 */

import { route } from "@/api/routes"
import { productVersion } from "@/lib/product-version"
import { isUuid } from "@/lib/utils"

export type ListingLogLevel = "debug" | "info" | "warn" | "error"

export interface ListingCorrelation {
  batchId?: string
  rowId?: string
  offerId?: string
  intentId?: string
  jobId?: string
  psdId?: string
}

export interface ListingLogInput {
  level?: ListingLogLevel
  module: string
  event: string
  durationMs?: number
  rowId?: string
  errorCode?: string
  errorMessage?: string
  correlation?: ListingCorrelation
  fields?: Record<string, string | number | boolean | null | undefined>
}

interface ListingLogRecord {
  id: string
  ts: string
  level: ListingLogLevel
  module: string
  event: string
  sessionId: string
  version: string
  durationMs?: number
  batchId?: string
  rowId?: string
  offerId?: string
  intentId?: string
  jobId?: string
  psdId?: string
  errorCode?: string
  errorMessage?: string
  fields?: Record<string, string | number | boolean>
}

interface Transport {
  post: (url: string, body: string, keepalive: boolean) => Promise<number>
  beacon: (url: string, body: string) => boolean
  online: () => boolean
  schedule: (run: () => void, delayMs: number) => void
}

const MAX_BUFFER = 200
const MAX_BATCH = 40
const MAX_BODY = 96 * 1024
const MAX_ATTEMPTS = 3

const correlations = new Map<string, ListingCorrelation>()
let enabled = false
let buffer: ListingLogRecord[] = []
let sending = false
let attempts = 0
let retryTimer: ReturnType<typeof setTimeout> | undefined
let memorySession = ""
const collectListeners = new Set<(enabled: boolean) => void>()

let transport: Transport = {
  post: async (url, body, keepalive) => {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      keepalive,
      headers: { "Content-Type": "application/json" },
      body,
    })
    return response.status
  },
  beacon: (url, body) => {
    if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return false
    return navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))
  },
  online: () => typeof navigator === "undefined" || navigator.onLine !== false,
  schedule: (run, delayMs) => {
    retryTimer = setTimeout(run, delayMs)
  },
}

export function configureListingLogTransport(next: Partial<Transport>): void {
  transport = { ...transport, ...next }
}

/** OCR contract failures are recognition, even when another job kind was in hand. */
export function listingRowFailureStage(kind: string, code: string | undefined): string {
  if (
    code === "OCR_CONTRACT_VIOLATION"
    || code === "cloud_ocr_contract_violation"
    || code === "workflow_ai_result_unusable"
  ) return "ai"
  return kind
}

/** Which listing stage a media-job failure belongs to. Upload jobs stay on
 * upload unless the code says the PSD or source never bound. */
export function listingFailureModule(
  kind: string | undefined,
  code: string | undefined,
): "bind" | "render" | "upload" {
  if (code === "workflow_template_missing" || code === "workflow_source_missing") return "bind"
  if (kind === "media.upload") return "upload"
  return "render"
}

export function listingLogCollectEnabled(): boolean {
  return enabled
}

export function subscribeListingLogCollect(listener: (enabled: boolean) => void): () => void {
  collectListeners.add(listener)
  return () => { collectListeners.delete(listener) }
}

export function setListingLogCollect(next: boolean): void {
  if (next === enabled) return
  enabled = next
  for (const listener of collectListeners) listener(next)
  if (!next) {
    buffer = []
    sending = false
    attempts = 0
    if (retryTimer) clearTimeout(retryTimer)
    removePageListeners()
    return
  }
  installPageListeners()
}

export function bindListingRows(batchId: string, rowIds: readonly string[], shared: ListingCorrelation = {}): void {
  for (const rowId of rowIds) {
    const previous = correlations.get(rowId)
    correlations.set(rowId, { ...previous, ...cleanCorrelation(shared), batchId, rowId })
  }
  while (correlations.size > 2_000) {
    const oldest = correlations.keys().next().value
    if (!oldest) break
    correlations.delete(oldest)
  }
}

export function noteListingRow(rowId: string, patch: ListingCorrelation): void {
  const previous = correlations.get(rowId) ?? { rowId }
  correlations.set(rowId, { ...previous, ...cleanCorrelation(patch), rowId })
}

/** The batch has been flushed. The row keeps its ids so a later status read
 * still sits on the same listing. A new batch overwrites `batchId`. The map
 * itself stays capped. */
export function releaseListingBatch(_batchId: string): void {
  while (correlations.size > 2_000) {
    const oldest = correlations.keys().next().value
    if (!oldest) break
    correlations.delete(oldest)
  }
}

export function listingCorrelation(rowId: string): ListingCorrelation {
  return correlations.get(rowId) ?? { rowId }
}

export function offerIdText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined
  const field = value as { kind?: unknown; value?: unknown }
  if (field.kind !== "text" || typeof field.value !== "string") return undefined
  return cleanOffer(field.value)
}

export function psdIdOf(value: string | undefined): string | undefined {
  if (!value) return undefined
  const hex = value.startsWith("sha256:") ? value.slice(7) : value
  return /^[0-9a-f]{64}$/i.test(hex) ? `sha256:${hex.toLowerCase()}` : undefined
}

export function listingLog(input: ListingLogInput): void {
  if (!enabled) return
  const record = buildRecord(input)
  if (!record) return
  buffer.push(record)
  if (buffer.length > MAX_BUFFER) buffer.splice(0, buffer.length - MAX_BUFFER)
  if (record.level === "error") void flush("error")
  else if (buffer.length >= MAX_BATCH || bodyBytes(buffer) >= MAX_BODY * 0.8) void flush("full")
}

export function ingestRenderListingLog(input: ListingLogInput): void {
  listingLog(input)
}

export function flushListingLogs(reason: "batch" | "error" | "hide" | "online" = "batch"): void {
  if (!enabled) return
  void flush(reason)
}

function buildRecord(input: ListingLogInput): ListingLogRecord | undefined {
  const moduleName = token(input.module, 64)
  const event = token(input.event, 64)
  if (!moduleName || !event) return undefined
  const stored = input.rowId ? correlations.get(input.rowId) : undefined
  const correlation = cleanCorrelation({ ...stored, ...input.correlation, ...(input.rowId ? { rowId: input.rowId } : {}) })
  const fields = cleanFields(input.fields)
  const message = input.errorMessage ? sanitizeMessage(input.errorMessage) : undefined
  const errorCode = storedErrorCode(input.errorCode)
  return {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level: input.level ?? (input.errorCode || message ? "error" : "info"),
    module: moduleName,
    event,
    sessionId: sessionId(),
    version: token(productVersion() || "dev", 32) ?? "dev",
    ...(typeof input.durationMs === "number" && input.durationMs >= 0 ? { durationMs: Math.round(input.durationMs) } : {}),
    ...correlation,
    ...(errorCode ? { errorCode } : {}),
    ...(message ? { errorMessage: message } : {}),
    ...(Object.keys(fields).length ? { fields } : {}),
  }
}

async function flush(reason: "batch" | "error" | "full" | "hide" | "online"): Promise<void> {
  if (!enabled || buffer.length === 0) return
  if (reason !== "hide" && sending) return
  if (reason !== "hide" && !transport.online()) return
  const batch = takeBatch()
  if (!batch) return
  const body = JSON.stringify({ records: batch })
  if (reason === "hide") {
    try {
      const status = await transport.post(endpoint(), body, true)
      if (status === 401 || status === 403) setListingLogCollect(false)
    } catch {
      transport.beacon(endpoint(), body)
    }
    return
  }
  sending = true
  try {
    const status = await transport.post(endpoint(), body, false)
    if (status === 401 || status === 403) {
      setListingLogCollect(false)
      return
    }
    if (status === 429 || status >= 500) {
      retry(batch)
      return
    }
    attempts = 0
  } catch {
    if (!transport.online()) {
      buffer = [...batch, ...buffer].slice(-MAX_BUFFER)
      attempts = 0
      return
    }
    retry(batch)
  } finally {
    sending = false
    if (enabled && buffer.length > 0 && attempts === 0) void flush("full")
  }
}

function retry(batch: ListingLogRecord[]): void {
  attempts += 1
  if (attempts >= MAX_ATTEMPTS) {
    attempts = 0
    return
  }
  buffer = [...batch, ...buffer].slice(-MAX_BUFFER)
  const delay = 1_000 * 2 ** (attempts - 1)
  transport.schedule(() => { void flush("online") }, delay)
}

function takeBatch(): ListingLogRecord[] | undefined {
  const batch: ListingLogRecord[] = []
  while (buffer.length && batch.length < MAX_BATCH) {
    const next = buffer[0]!
    const candidate = [...batch, next]
    if (bodyBytes(candidate) > MAX_BODY && batch.length > 0) break
    buffer.shift()
    batch.push(next)
  }
  return batch.length ? batch : undefined
}

function bodyBytes(records: ListingLogRecord[]): number {
  return new TextEncoder().encode(JSON.stringify({ records })).byteLength
}

function endpoint(): string {
  return route("listingClientLogs")
}

function sessionId(): string {
  const key = "podhub.listingLog.session"
  try {
    const existing = sessionStorage.getItem(key)
    if (existing && isUuid(existing)) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    if (!memorySession) memorySession = crypto.randomUUID()
    return memorySession
  }
}

function cleanCorrelation(input: ListingCorrelation): ListingCorrelation {
  return {
    ...(isUuid(input.batchId) ? { batchId: input.batchId!.toLowerCase() } : {}),
    ...(isUuid(input.rowId) ? { rowId: input.rowId!.toLowerCase() } : {}),
    ...(cleanOffer(input.offerId) ? { offerId: cleanOffer(input.offerId) } : {}),
    ...(isUuid(input.intentId) ? { intentId: input.intentId!.toLowerCase() } : {}),
    ...(isUuid(input.jobId) ? { jobId: input.jobId!.toLowerCase() } : {}),
    ...(psdIdOf(input.psdId) ? { psdId: psdIdOf(input.psdId) } : {}),
  }
}

function cleanOffer(value: string | undefined): string | undefined {
  if (!value) return undefined
  const text = value.trim()
  if (!text || [...text].length > 128) return undefined
  if (text.includes("://") || /[\s?#&\\/]/.test(text)) return undefined
  if (/token|secret|password/i.test(text)) return undefined
  return text
}

function cleanFields(fields: ListingLogInput["fields"]): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  if (!fields) return out
  for (const key of ["slices", "bytes", "waitedMs", "encodeMs", "presignMs", "putMs", "completeMs", "status", "revision", "rows", "attempt"] as const) {
    const value = fields[key]
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = Math.round(value)
  }
  const concurrency = fields.concurrency
  if (typeof concurrency === "number" && Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 64) {
    out.concurrency = concurrency
  }
  if (typeof fields.effectiveType === "string" && /^(?:slow-2g|2g|3g|4g)$/.test(fields.effectiveType)) {
    out.effectiveType = fields.effectiveType
  }
  if (fields.applied === true) out.applied = true
  for (const key of ["verb", "outcome", "stage"] as const) {
    const value = token(typeof fields[key] === "string" ? fields[key] : undefined, 32)
    if (value) out[key] = value
  }
  if (typeof fields.worker === "string" && /^[0-9a-f]{8}$/i.test(fields.worker)) out.worker = fields.worker.toLowerCase()
  const refusal = token(typeof fields.refusal === "string" ? fields.refusal : undefined, 64)
  if (refusal && refusal !== "operation_failed" && refusal !== "-") out.refusal = refusal
  return out
}

function storedErrorCode(value: string | undefined): string | undefined {
  const code = token(value, 64)
  return code && code !== "operation_failed" && code !== "-" ? code : undefined
}

export function sanitizeMessage(input: string): string | undefined {
  let text = input.replace(/[\n\r\t]+/g, " ")
  text = text.replace(/https?:\/\/\S+|data:\S+|blob:\S+/gi, "[omitted]")
  text = text.replace(/\b(?:bearer\s+\S+|token\s*[:=]\s*\S+|password\s*[:=]\s*\S+|secret\s*[:=]\s*\S+|api[_-]?key\s*[:=]\s*\S+|signature\s*[:=]\s*\S+|x-amz-\S+)/gi, "[omitted]")
  text = text.replace(/\s+/g, " ").trim()
  if (!text) return undefined
  return [...text].slice(0, 240).join("")
}

function token(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined
  const text = value.trim()
  if (!text || text.length > max || !/^[A-Za-z0-9_.:+-]+$/.test(text)) return undefined
  return text
}

let pageListeners = false
function onHide(): void { void flush("hide") }
function onOnline(): void { void flush("online") }
function onVisibility(): void {
  if (typeof document !== "undefined" && document.visibilityState === "hidden") void flush("hide")
}

function installPageListeners(): void {
  if (pageListeners || typeof window === "undefined") return
  pageListeners = true
  window.addEventListener("pagehide", onHide)
  window.addEventListener("online", onOnline)
  document.addEventListener("visibilitychange", onVisibility)
}

function removePageListeners(): void {
  if (!pageListeners || typeof window === "undefined") return
  pageListeners = false
  window.removeEventListener("pagehide", onHide)
  window.removeEventListener("online", onOnline)
  document.removeEventListener("visibilitychange", onVisibility)
}

export function resetListingLogForTests(): void {
  setListingLogCollect(false)
  correlations.clear()
  memorySession = ""
  transport = {
    post: async () => 204,
    beacon: () => false,
    online: () => true,
    schedule: (run) => run(),
  }
}

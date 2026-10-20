import type { DiagnosticEvent, DiagnosticFieldSummary } from "./diagnostic-summary"
import type { DiagnosticClock, DiagnosticTimer } from "./diagnostic-window"

export type ExactOperation = Readonly<{
  provenance: "native_freeze" | "submitted_http_body"
  /** Unchanged JSON text owned by freeze/HTTP, never reconstructed from an error or response. */
  jsonText: string
}>
export type ReadonlyDiagnosticEvent = Readonly<Omit<DiagnosticEvent, "summary">> & {
  readonly summary: readonly Readonly<DiagnosticFieldSummary>[]
}
export type OriginalUnavailableReason = "no_exact_payload" | "oversize" | "expired" | "byte_limit" | "not_retained"
export type DiagnosticDetail = Readonly<{
  diagnosticId: string
  /** Null when the entire bounded record was evicted or identity changed. */
  event: ReadonlyDiagnosticEvent | null
  hasOriginal: boolean
  originalUnavailableReason: OriginalUnavailableReason | null
}>
export type DiagnosticCopyData = Readonly<{
  detail: DiagnosticDetail
  provenance: ExactOperation["provenance"] | null
  originalJson: string | null
}>

const ITEM_LIMIT = 100
const BYTE_LIMIT = 32 * 1024 * 1024
const SINGLE_LIMIT = 8 * 1024 * 1024
const TTL_MS = 30 * 60 * 1000

type RecordEntry = {
  event: ReadonlyDiagnosticEvent
  original: ExactOperation | null
  provenance: ExactOperation["provenance"] | null
  reason: OriginalUnavailableReason | null
  at: number
  bytes: number
  metadataBytes: number
}

/** Session memory only. UI reads detail freely; original access is a separate explicit copy port. */
export function createDiagnosticMemory(
  now: () => number = Date.now,
  timers: Pick<DiagnosticClock, "setTimer" | "clearTimer"> = {
    setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
    clearTimer: (timer) => globalThis.clearTimeout(timer),
  },
) {
  let generation = 0
  let bytes = 0
  const entries = new Map<string, RecordEntry>()
  let expiryTimer: DiagnosticTimer | undefined
  let expiryToken = 0
  const clearExpiry = () => {
    expiryToken++
    if (expiryTimer !== undefined) timers.clearTimer(expiryTimer)
    expiryTimer = undefined
  }
  const key = (id: string) => `${generation}:${id}`
  const discardOriginal = (entry: RecordEntry, reason: OriginalUnavailableReason) => {
    bytes -= entry.bytes - entry.metadataBytes
    entry.bytes = entry.metadataBytes
    entry.original = null
    entry.reason = reason
  }
  const expire = () => {
    for (const entry of entries.values()) {
      if (entry.original && now() - entry.at >= TTL_MS) discardOriginal(entry, "expired")
    }
  }
  const scheduleExpiry = () => {
    clearExpiry()
    let deadline = Infinity
    for (const entry of entries.values()) if (entry.original) deadline = Math.min(deadline, entry.at + TTL_MS)
    if (deadline === Infinity) return
    const token = expiryToken
    expiryTimer = timers.setTimer(() => {
      if (token !== expiryToken) return
      expiryTimer = undefined
      expire()
      scheduleExpiry()
    }, Math.max(0, deadline - now()))
    // Node/Bun checks should not keep the process alive solely for session-memory cleanup.
    const handle = expiryTimer as DiagnosticTimer & { unref?: () => void }
    handle.unref?.()
  }
  const clear = () => {
    clearExpiry()
    generation++
    entries.clear()
    bytes = 0
  }
  const retain = (event: DiagnosticEvent, original: ExactOperation | null) => {
    expire()
    if (entries.has(key(event.diagnostic_id))) return
    const frozen = Object.freeze({ ...event, summary: Object.freeze(event.summary.map((field) => Object.freeze({ ...field }))) })
    const metadataBytes = new TextEncoder().encode(JSON.stringify({ event: frozen, provenance: original?.provenance ?? null })).length
    const originalBytes = original ? new TextEncoder().encode(original.jsonText).length : 0
    const retained = original && originalBytes <= SINGLE_LIMIT ? Object.freeze({ ...original }) : null
    const entry: RecordEntry = {
      event: frozen, original: retained, provenance: original?.provenance ?? null, at: now(), metadataBytes,
      reason: original ? retained ? null : "oversize" : "no_exact_payload",
      bytes: metadataBytes + (retained ? originalBytes : 0),
    }
    while (entries.size >= ITEM_LIMIT) {
      const oldest = entries.keys().next().value!
      bytes -= entries.get(oldest)!.bytes
      entries.delete(oldest)
    }
    entries.set(key(event.diagnostic_id), entry)
    bytes += entry.bytes
    for (const candidate of entries.values()) {
      if (bytes <= BYTE_LIMIT) break
      if (candidate.original) discardOriginal(candidate, "byte_limit")
    }
    scheduleExpiry()
  }
  const detail = (diagnosticId: string): DiagnosticDetail => {
    expire()
    const entry = entries.get(key(diagnosticId))
    return Object.freeze({
      diagnosticId, event: entry?.event ?? null, hasOriginal: !!entry?.original,
      originalUnavailableReason: entry ? entry.reason : "not_retained",
    })
  }
  const copyData = (diagnosticId: string): DiagnosticCopyData => {
    const current = detail(diagnosticId)
    const entry = entries.get(key(diagnosticId))
    return Object.freeze({ detail: current, provenance: entry?.provenance ?? null, originalJson: entry?.original?.jsonText ?? null })
  }
  return { retain, detail, copyData, clear }
}

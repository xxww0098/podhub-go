/**
 * One `[prepare] upload` line per row and one `[prepare] upload.batch` line
 * per prepare/upload call. Per-slice byte counts and phase times ride the
 * row's `upload.slices` line so the console does not grow a line per slice.
 */
import { PREPARE_LOG, diagLog } from "@/lib/diag-log"
import { listingLog, type ListingLogInput } from "@/lib/listing-log"
import { SLICE_PUT_CONCURRENCY } from "./slice-batch-upload"
import type { MediaTransferTiming } from "../media/direct-media-types"
import { logStage } from "./execution-context"

export type SliceTransferVia = "put" | "ready" | "local" | "probe"

export type SliceTransferStat = {
  index: number
  bytes: number
  /** Present when this tab encoded the slice. A cache fill or a reload omits it. */
  encodeMs?: number
  readMs: number
  hashMs: number
  presignMs: number
  putMs: number
  completeMs: number
  via: SliceTransferVia
  /** Set when this slice's PUT was signed, or confirm trusted the store checksum. */
  checksum?: "trusted" | "signed"
}

export type UploadRowStat = {
  rowId: string
  startedAt: number
  endedAt: number
  /** Listing bind, already batched per wave. Not part of each slice's storage confirm. */
  bindMs: number
  slices: SliceTransferStat[]
}

type BatchAccount = {
  rows: number
  slices: number
  manifestBytes: number
  putBytes: number
  encodeMs: number
  encodeKnown: boolean
  readMs: number
  hashMs: number
  presignMs: number
  putMs: number
  completeMs: number
  bindMs: number
  wallStart: number
  wallEnd: number
  via: Record<SliceTransferVia, number>
  checksum?: string
}

const batches = new WeakMap<object, BatchAccount>()
const VIA_ORDER: SliceTransferVia[] = ["put", "ready", "local", "probe"]

export function statForSlice(
  index: number,
  manifestBytes: number | undefined,
  encodeMs: number | undefined,
  delivered?: { via: SliceTransferVia, timing?: MediaTransferTiming, checksum?: SliceTransferStat["checksum"] },
): SliceTransferStat {
  const via = delivered?.via ?? "local"
  const timing = delivered?.timing
  return {
    index,
    bytes: timing?.bytes ?? manifestBytes ?? 0,
    encodeMs,
    readMs: timing?.readMs ?? 0,
    hashMs: timing?.hashMs ?? 0,
    presignMs: timing?.presignMs ?? 0,
    putMs: via === "put" ? timing?.putMs ?? 0 : 0,
    completeMs: timing?.completeMs ?? 0,
    via,
    checksum: delivered?.checksum,
  }
}

/** Decimal megabytes per second of bytes that actually left the tab. */
function formatMegabytesPerSecond(bytes: number, wallMs: number): string {
  if (bytes <= 0 || wallMs <= 0) return "0"
  const value = (bytes / 1_000_000) / (wallMs / 1000)
  return value >= 10 ? value.toFixed(1) : value.toFixed(2)
}

/** Fold a later delivery (expired-proof refresh) into a slice already counted. */
export function addTransfer(
  stat: SliceTransferStat,
  delivered?: { via: SliceTransferVia, timing?: MediaTransferTiming },
): void {
  const extra = statForSlice(stat.index, stat.bytes, stat.encodeMs, delivered)
  stat.readMs += extra.readMs
  stat.hashMs += extra.hashMs
  stat.presignMs += extra.presignMs
  stat.putMs += extra.putMs
  stat.completeMs += extra.completeMs
  if (extra.bytes > stat.bytes) stat.bytes = extra.bytes
  if (extra.via === "put" || stat.via === "local") stat.via = extra.via
  if (extra.checksum && (!stat.checksum || checksumRank(extra.checksum) >= checksumRank(stat.checksum))) {
    stat.checksum = extra.checksum
  }
}

/** Browser network hint. Absent outside Chromium, and absent when the value is not one of the four labels. */
export function navigatorEffectiveType(): string | undefined {
  if (typeof navigator === "undefined") return undefined
  const connection = (navigator as Navigator & { connection?: { effectiveType?: unknown } }).connection
  const value = connection?.effectiveType
  return typeof value === "string" && /^(?:slow-2g|2g|3g|4g)$/.test(value) ? value : undefined
}

/**
 * Phase times for `upload.end`. `presignMs` and `completeMs` are the shared
 * round trips split across slices and summed back, so they track wall time.
 * `putMs` is the sum of each slice's PUT, which can exceed the row wall clock
 * when several PUTs run together.
 */
export function uploadEndFields(slices: SliceTransferStat[]): ListingLogInput["fields"] {
  const totals = summarize(slices)
  const puts = totals.via.put
  return {
    slices: slices.length,
    bytes: totals.putBytes,
    presignMs: totals.presignMs,
    putMs: totals.putMs,
    completeMs: totals.completeMs,
    ...(puts > 0 ? { concurrency: Math.min(puts, SLICE_PUT_CONCURRENCY) } : {}),
    effectiveType: navigatorEffectiveType(),
  }
}

export function logUploadRow(stat: UploadRowStat, batch?: object): void {
  const slices = [...stat.slices].sort((left, right) => left.index - right.index)
  const totals = summarize(slices)
  const wallMs = Math.max(0, Math.round(stat.endedAt - stat.startedAt))
  listingLog({
    module: "upload",
    event: "upload.end",
    rowId: stat.rowId,
    durationMs: wallMs,
    fields: uploadEndFields(stat.slices),
  })
  logStage("upload", stat.rowId, {
    slices: stat.slices.length,
    manifestBytes: totals.manifestBytes,
    putBytes: totals.putBytes,
    encodeMs: totals.encodeKnown ? totals.encodeMs : undefined,
    readMs: totals.readMs,
    hashMs: totals.hashMs,
    presignMs: totals.presignMs,
    putMs: totals.putMs,
    completeMs: totals.completeMs,
    bindMs: stat.bindMs,
    wallMs,
    MBps: formatMegabytesPerSecond(totals.putBytes, wallMs),
    via: viaSummary(totals.via),
    checksum: checksumSummary(slices),
  })
  if (slices.length) {
    logStage("upload.slices", stat.rowId, {
      parts: slices.map(sliceToken).join(" "),
    })
  }
  if (!batch) return
  const account = accountFor(batch)
  account.rows += 1
  account.slices += stat.slices.length
  account.manifestBytes += totals.manifestBytes
  account.putBytes += totals.putBytes
  account.encodeMs += totals.encodeMs
  account.encodeKnown = account.encodeKnown || totals.encodeKnown
  account.readMs += totals.readMs
  account.hashMs += totals.hashMs
  account.presignMs += totals.presignMs
  account.putMs += totals.putMs
  account.completeMs += totals.completeMs
  account.bindMs += stat.bindMs
  account.wallStart = Math.min(account.wallStart, stat.startedAt)
  account.wallEnd = Math.max(account.wallEnd, stat.endedAt)
  for (const via of VIA_ORDER) account.via[via] += totals.via[via]
  const checksum = checksumSummary(slices)
  if (checksum) account.checksum = mergeChecksum(account.checksum, checksum)
}

export function finishUploadBatch(batch: object): void {
  const account = batches.get(batch)
  if (!account || account.rows === 0) return
  batches.delete(batch)
  const wallMs = Math.max(0, Math.round(account.wallEnd - account.wallStart))
  diagLog(PREPARE_LOG, "upload.batch", {
    rows: account.rows,
    slices: account.slices,
    manifestBytes: account.manifestBytes,
    putBytes: account.putBytes,
    encodeMs: account.encodeKnown ? account.encodeMs : undefined,
    readMs: account.readMs,
    hashMs: account.hashMs,
    presignMs: account.presignMs,
    putMs: account.putMs,
    completeMs: account.completeMs,
    bindMs: account.bindMs,
    wallMs,
    MBps: formatMegabytesPerSecond(account.putBytes, wallMs),
    via: viaSummary(account.via),
    checksum: checksumSummaryFrom(account.checksum),
  })
}

function summarize(slices: SliceTransferStat[]): Omit<BatchAccount, "rows" | "wallStart" | "wallEnd"> {
  const via = emptyVia()
  let manifestBytes = 0
  let putBytes = 0
  let encodeMs = 0
  let encodeKnown = false
  let readMs = 0
  let hashMs = 0
  let presignMs = 0
  let putMs = 0
  let completeMs = 0
  for (const slice of slices) {
    manifestBytes += slice.bytes
    if (slice.via === "put") putBytes += slice.bytes
    if (slice.encodeMs != null) {
      encodeMs += slice.encodeMs
      encodeKnown = true
    }
    readMs += slice.readMs
    hashMs += slice.hashMs
    presignMs += slice.presignMs
    putMs += slice.putMs
    completeMs += slice.completeMs
    via[slice.via] += 1
  }
  return {
    slices: slices.length, manifestBytes, putBytes, encodeMs, encodeKnown,
    readMs, hashMs, presignMs, putMs, completeMs, bindMs: 0, via,
  }
}

function sliceToken(slice: SliceTransferStat): string {
  const token = [
    slice.index,
    slice.bytes,
    slice.encodeMs == null ? "-" : slice.encodeMs,
    slice.readMs,
    slice.hashMs,
    slice.presignMs,
    slice.putMs,
    slice.completeMs,
    slice.via,
  ].join(":")
  return slice.checksum ? `${token}:${slice.checksum}` : token
}

function checksumRank(value: "trusted" | "signed"): number {
  return value === "trusted" ? 2 : 1
}

function checksumSummary(slices: SliceTransferStat[]): string | undefined {
  let trusted = 0
  let signed = 0
  for (const slice of slices) {
    if (slice.checksum === "trusted") trusted += 1
    else if (slice.checksum === "signed") signed += 1
  }
  const parts = []
  if (trusted) parts.push(`trusted:${trusted}`)
  if (signed) parts.push(`signed:${signed}`)
  return parts.length ? parts.join(",") : undefined
}

function mergeChecksum(current: string | undefined, extra: string): string {
  const counts = { trusted: 0, signed: 0 }
  for (const part of `${current ?? ""},${extra}`.split(",")) {
    const [name, raw] = part.split(":")
    if (name === "trusted" || name === "signed") counts[name] += Number(raw) || 0
  }
  const parts = []
  if (counts.trusted) parts.push(`trusted:${counts.trusted}`)
  if (counts.signed) parts.push(`signed:${counts.signed}`)
  return parts.join(",")
}

function checksumSummaryFrom(value: string | undefined): string | undefined {
  return value || undefined
}

function viaSummary(via: Record<SliceTransferVia, number>): string {
  return VIA_ORDER.filter((name) => via[name] > 0).map((name) => `${name}:${via[name]}`).join(",") || "-"
}

function emptyVia(): Record<SliceTransferVia, number> {
  return { put: 0, ready: 0, local: 0, probe: 0 }
}

function accountFor(batch: object): BatchAccount {
  const existing = batches.get(batch)
  if (existing) return existing
  const created: BatchAccount = {
    rows: 0, slices: 0, manifestBytes: 0, putBytes: 0, encodeMs: 0, encodeKnown: false,
    readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: 0, bindMs: 0,
    wallStart: Number.POSITIVE_INFINITY, wallEnd: 0, via: emptyVia(),
  }
  batches.set(batch, created)
  return created
}

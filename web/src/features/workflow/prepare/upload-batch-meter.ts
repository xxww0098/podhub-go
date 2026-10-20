/**
 * One meter for the slice batch that is uploading now.
 * Counts are objects. Speed is transferred bytes, smoothed over a window.
 */
import { useSyncExternalStore } from "react"
import { etaSeconds, slidingRate, type RateSample } from "@/bindings/upload-rate"

export type UploadMeter = {
  active: boolean
  completed: number
  total: number
  bytesPerSec: number
  etaSec: number
  failedRows: number
  failureMessage: string
  /** Set while this tab waits for a local confirm slot. */
  gateNote: string
}

type RowAccount = {
  objects: number
  done: number
  bytesLeft: number
  failed: boolean
  open: boolean
}

const EMPTY: UploadMeter = {
  active: false,
  completed: 0,
  total: 0,
  bytesPerSec: 0,
  etaSec: 0,
  failedRows: 0,
  failureMessage: "",
  gateNote: "",
}

const rows = new Map<string, RowAccount>()
let samples: RateSample[] = []
let transferred = 0
let displayedRate = 0
let failureMessage = ""
let gateNote = ""
let snapshot: UploadMeter = EMPTY
const listeners = new Set<() => void>()

function publish(): void {
  let completed = 0
  let total = 0
  let bytesLeft = 0
  let failedRows = 0
  let open = 0
  for (const row of rows.values()) {
    completed += row.done
    total += row.objects
    bytesLeft += row.bytesLeft
    if (row.failed) failedRows += 1
    if (row.open) open += 1
  }
  const rated = slidingRate(samples, Date.now(), displayedRate)
  samples = rated.samples
  displayedRate = rated.rate
  snapshot = {
    active: open > 0,
    completed,
    total,
    bytesPerSec: displayedRate,
    etaSec: etaSeconds(bytesLeft, displayedRate),
    failedRows,
    failureMessage: failedRows > 0 ? failureMessage : "",
    gateNote,
  }
  for (const listener of listeners) listener()
}

export function resetUploadMeter(): void {
  rows.clear()
  samples = []
  transferred = 0
  displayedRate = 0
  failureMessage = ""
  gateNote = ""
  snapshot = EMPTY
  for (const listener of listeners) listener()
}

function anyOpen(): boolean {
  for (const row of rows.values()) if (row.open) return true
  return false
}

export function trackSliceRow(rowId: string, objects: number, bytes: number): {
  objectDone: (byteLength: number, transferredBytes: boolean) => void
  fail: (message: string) => void
  done: () => void
} {
  if (!anyOpen()) resetUploadMeter()
  rows.set(rowId, { objects, done: 0, bytesLeft: Math.max(0, bytes), failed: false, open: true })
  publish()
  const account = () => rows.get(rowId)
  return {
    objectDone(byteLength, transferredBytes) {
      const row = account()
      if (!row || row.failed || !row.open) return
      row.done += 1
      row.bytesLeft = Math.max(0, row.bytesLeft - Math.max(0, byteLength))
      if (transferredBytes && byteLength > 0) {
        transferred += byteLength
        samples.push({ at: Date.now(), bytes: transferred })
      }
      publish()
    },
    fail(message) {
      const row = account()
      if (!row || !row.open) return
      row.failed = true
      row.open = false
      row.bytesLeft = 0
      if (message.trim()) failureMessage = message.trim()
      publish()
    },
    done() {
      const row = account()
      if (!row || !row.open) return
      row.open = false
      row.bytesLeft = 0
      publish()
    },
  }
}

/** Visible while a confirm waits for this browser's two-slot budget. */
export function noteUploadGate(message: string): void {
  gateNote = message.trim()
  publish()
}

export function failedUploadRowIds(
  list: readonly { id: string; upload: string }[],
  busy: ReadonlySet<string>,
): string[] {
  return list.filter((row) => row.upload === "failed" && !busy.has(row.id)).map((row) => row.id)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function uploadMeterSnapshot(): UploadMeter {
  return snapshot
}

export function useUploadBatchMeter(): UploadMeter {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

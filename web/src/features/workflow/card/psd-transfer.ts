/** In-tab PSD bind progress. The card shows status; failures go through notify. */
import { useSyncExternalStore } from "react"
import { formatEta, formatRate, type UploadProgress } from "@/bindings/multipart-upload"
import { uploadFailureMessage } from "@/bindings/upload-failure-copy"

type PsdTransfer = {
  draftId: string
  sha256?: string
  fileName: string
  phase: "hash" | "upload" | "error"
  label: string
  abort?: () => void
  retry?: () => void
}

const byDraft = new Map<string, PsdTransfer>()
const draftOfSha = new Map<string, string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function beginPsdTransfer(input: {
  draftId: string
  fileName: string
  abort?: () => void
}): void {
  byDraft.set(input.draftId, {
    draftId: input.draftId,
    fileName: input.fileName,
    phase: "hash",
    label: "正在校验",
    abort: input.abort,
  })
  emit()
}

export function notePsdHash(draftId: string, loaded: number, total: number): void {
  const current = byDraft.get(draftId)
  if (!current || current.phase === "error") return
  const percent = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0
  current.phase = "hash"
  current.label = `校验 ${percent}%`
  emit()
}

export function linkPsdTransfer(draftId: string, sha256: string, abort?: () => void): void {
  const current = byDraft.get(draftId)
  if (!current) return
  current.sha256 = sha256
  if (abort) current.abort = abort
  draftOfSha.set(sha256, draftId)
  emit()
}

export function notePsdUpload(sha256: string, progress: UploadProgress): void {
  const draftId = draftOfSha.get(sha256)
  if (!draftId) return
  const current = byDraft.get(draftId)
  if (!current || current.phase === "error") return
  const percent = progress.total > 0 ? Math.min(100, Math.floor((progress.loaded / progress.total) * 100)) : 0
  const rate = formatRate(progress.bytesPerSec)
  const eta = formatEta(progress.etaSec)
  current.phase = "upload"
  current.label = ["上传 " + percent + "%", rate, eta].filter(Boolean).join(" · ")
  emit()
}

export function failPsdTransfer(draftId: string, retry?: () => void, reason?: unknown): void {
  const current = byDraft.get(draftId)
  if (!current) return
  current.phase = "error"
  current.label = uploadFailureMessage(reason)
  current.retry = retry
  emit()
}

export function clearPsdTransfer(draftId: string): void {
  const current = byDraft.get(draftId)
  if (current?.sha256) draftOfSha.delete(current.sha256)
  byDraft.delete(draftId)
  emit()
}

export function draftIdForSha(sha256: string): string | undefined {
  return draftOfSha.get(sha256)
}

export function clearPsdTransferBySha(sha256: string): void {
  const draftId = draftOfSha.get(sha256)
  if (draftId) clearPsdTransfer(draftId)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function usePsdTransfer(draftId: string | undefined): PsdTransfer | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (draftId ? byDraft.get(draftId) : undefined),
    () => undefined,
  )
}

/** In-tab PSD bind progress. The card shows status; failures go through notify. */
import { useSyncExternalStore } from "react"
import { errorMessage } from "@/lib/error-message"

type PsdTransfer = {
  draftId: string
  fileName: string
  phase: "hash" | "error"
  label: string
  abort?: () => void
  retry?: () => void
}

const byDraft = new Map<string, PsdTransfer>()
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
  byDraft.set(draftId, { ...current, phase: "hash", label: `校验 ${percent}%` })
  emit()
}

export function failPsdTransfer(draftId: string, retry?: () => void, reason?: unknown): void {
  const current = byDraft.get(draftId)
  if (!current) return
  byDraft.set(draftId, { ...current, phase: "error", label: errorMessage(reason, "PSD 绑定失败"), retry })
  emit()
}

export function clearPsdTransfer(draftId: string): void {
  byDraft.delete(draftId)
  emit()
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

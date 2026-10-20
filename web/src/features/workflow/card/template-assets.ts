/** Local PSD bindings are usable immediately; Cloud is only a recovery backup. */
import { abortPsdMultipart, completePsdMultipart, confirmPsdTemplate, registerPsdTemplate, uploadPsdTemplate } from "@/bindings/http-templates"
import type { MultipartPlan } from "@/bindings/multipart-upload"
import { clearSession, loadSession, uploadParts } from "@/bindings/multipart-upload"
import type { CardPayload } from "@/bindings/listing-projection"
import { rowCacheScope } from "@/bindings/listing-row-cache"
import { refuse } from "@/bindings/refusal"
import { notifyLive } from "@/lib/notify"
import { onSessionInvalidated } from "@/lib/session-cache"
import { hashUploadBody } from "@/bindings/direct-upload"
import { getTemplate } from "@/render/opfs"
import { rememberTemplateFile, rememberTemplateHandle, rememberedTemplateFile, rememberedTemplateHandle } from "@/bindings/template-file"
import { fileFromGrantedHandle, listResumes, psdResumeId, readResume, writeResume } from "@/bindings/upload-resume-store"
import { clearPsdTransferBySha, draftIdForSha, failPsdTransfer, notePsdUpload } from "./psd-transfer"

type TemplateBackup = Pick<CardPayload, "psdTemplateSha256" | "psdTemplateFileName" | "descriptionCategoryId" | "typeId">

const MAX_RETRIES = 3
const uploads = new Map<string, { pending: Promise<void>; current: () => boolean }>()
const aborts = new Map<string, () => void>()
const openMultipart = new Map<string, { id: string; ticket: string }>()
const cancelledSha = new Set<string>()

/** A new bind of this digest may upload again. Cancel only stops the attempt in flight. */
export function acceptUserTemplate(sha256: string): void {
  cancelledSha.delete(sha256)
}

export function cancelUserTemplate(sha256: string): void {
  cancelledSha.add(sha256)
  const open = openMultipart.get(sha256)
  aborts.get(sha256)?.()
  if (open) {
    openMultipart.delete(sha256)
    clearSession(sha256)
    void abortPsdMultipart(open.id, open.ticket).catch(() => {})
  }
  clearPsdTransferBySha(sha256)
}
// One background transfer at a time leaves connections/memory for normal work.
// Queued jobs hold references only; PSD bytes are read when their turn starts.
let tail = Promise.resolve()

export function backupUserTemplate(payload: TemplateBackup, current = rowCacheScope().current, targetId = ""): void {
  // Keep the scope of the original binding click, not that of a late PATCH reply.
  if (!current() || cancelledSha.has(payload.psdTemplateSha256)) return
  const key = `${payload.descriptionCategoryId}/${payload.typeId}/${payload.psdTemplateSha256}`
  if (uploads.get(key)?.current()) return
    void persistUserTemplate(payload.psdTemplateSha256, payload.psdTemplateFileName,
    payload.descriptionCategoryId, payload.typeId, current, targetId).catch((reason: unknown) => {
    if (!current()) return
    const code = (reason as { code?: string })?.code
    if (code === "workflow_template_cancelled" || code === "workflow_cancelled" || (reason as { name?: string })?.name === "AbortError") {
      clearPsdTransferBySha(payload.psdTemplateSha256)
      return
    }
    const localMissing = code === "workflow_template_missing" || code === "workflow_template_digest_mismatch"
    const retry = () => {
      cancelledSha.delete(payload.psdTemplateSha256)
      backupUserTemplate(payload, current, targetId)
    }
    const draftId = draftIdForSha(payload.psdTemplateSha256)
    if (draftId) failPsdTransfer(draftId, retry, reason)
    notifyLive({
      id: `psd-backup:${payload.psdTemplateSha256}`,
      type: "error",
      title: "PSD 云端备份未完成",
      reason,
      description: localMissing
        ? "本机 PSD 缓存已缺失或损坏，请重新选择原文件；其他方案仍可正常工作。"
        : "本机 PSD 仍可正常上架；可以重试云端备份。",
      action: { label: "重试", onClick: retry },
    })
  })
}

export function persistUserTemplate(sha256: string, fileName: string, descriptionCategoryId: number, typeId: number, current = rowCacheScope().current, targetId = ""): Promise<void> {
  if (!current()) return Promise.reject(refuse("workflow_scope_changed", "账号或工作空间已切换，PSD 备份已停止"))
  const key = `${descriptionCategoryId}/${typeId}/${sha256}`
  const existing = uploads.get(key)
  if (existing?.current()) return existing.pending
  const controller = new AbortController()
  const abort = () => controller.abort()
  aborts.set(sha256, abort)
  if (cancelledSha.has(sha256)) controller.abort()
  const unsubscribe = onSessionInvalidated(abort)
  const pending = tail.then(() => persist(sha256, fileName, descriptionCategoryId, typeId, current, controller.signal, targetId))
    .finally(() => {
      unsubscribe()
      if (aborts.get(sha256) === abort) aborts.delete(sha256)
      if (uploads.get(key)?.pending === pending) uploads.delete(key)
    })
  uploads.set(key, { pending, current })
  // A failed backup must not poison the queue or reject an unrelated card write.
  tail = pending.catch(() => {})
  return pending
}

function requireCurrent(current: () => boolean): void {
  if (!current()) throw refuse("workflow_scope_changed", "账号或工作空间已切换，PSD 备份已停止")
}

function retryDelay(reason: unknown, retry: number): number | undefined {
  const error = reason as { status?: number; code?: string; retryAfterMs?: number } | null
  if (!error || !(error.code === "cloud_unavailable" || error.code === "cloud_bad_response"
    || error.code === "cloud_template_object_missing"
    || (error.code === "workflow_template_upload_failed" && error.status === 409)
    || error.status === 408 || error.status === 429 || (error.status != null && error.status >= 500))) return undefined
  const delay = Math.max(1000 * 2 ** retry, error.retryAfterMs ?? 0)
  // Do not keep a background job parked indefinitely on a server refusal.
  return Number.isFinite(delay) && delay <= 30_000 ? delay : undefined
}

function waitForRetry(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, delay)
    const abort = () => { clearTimeout(timer); reject(signal.reason) }
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function localBytes(sha256: string, current: () => boolean): Promise<Uint8Array<ArrayBuffer>> {
  requireCurrent(current)
  const bytes = await getTemplate(sha256)
  requireCurrent(current)
  if (!bytes) throw refuse("workflow_template_missing", "本机没有 PSD 文件，无法备份")
  if (await hashUploadBody(bytes) !== sha256) {
    throw refuse("workflow_template_digest_mismatch", "本机 PSD 缓存损坏，请重新选择文件")
  }
  requireCurrent(current)
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength))
  copy.set(bytes)
  return copy
}

async function sourceBlob(sha256: string, current: () => boolean): Promise<Blob> {
  const file = rememberedTemplateFile(sha256)
  if (file) return file
  return new Blob([await localBytes(sha256, current)])
}

function multipartOf(template: { multipart?: MultipartPlan | null }): MultipartPlan | undefined {
  return template.multipart ?? undefined
}

async function rememberPsdTarget(sha256: string, fileName: string, byteLength: number, descriptionCategoryId: number, typeId: number, targetId: string): Promise<void> {
  const previous = await readResume(psdResumeId(sha256))
  await writeResume({
    id: psdResumeId(sha256),
    kind: "psd",
    sha256: sha256.toLowerCase(),
    rowId: targetId || previous?.rowId || "",
    workspaceUuid: previous?.workspaceUuid ?? "",
    fileName,
    byteLength,
    updatedAt: Date.now(),
    descriptionCategoryId,
    typeId,
    uploadId: previous?.uploadId,
    ticket: previous?.ticket,
    partSize: previous?.partSize,
    completedParts: previous?.completedParts ?? [],
    objects: previous?.objects ?? [],
    uploadBatch: previous?.uploadBatch,
    batchExpiresAt: previous?.batchExpiresAt,
    handle: rememberedTemplateHandle(sha256) ?? previous?.handle,
  })
}

async function persist(sha256: string, fileName: string, descriptionCategoryId: number, typeId: number, current: () => boolean, signal: AbortSignal, targetId = ""): Promise<void> {
  const source = await sourceBlob(sha256, current)
  await rememberPsdTarget(sha256, fileName, source.size, descriptionCategoryId, typeId, targetId)
  let bytes: Uint8Array<ArrayBuffer> = new Uint8Array()
  const session = await loadSession(sha256)
  const body = {
    sha256, file_name: fileName, bytes: source.size, description_category_id: descriptionCategoryId, type_id: typeId,
    resume_ticket: session?.ticket,
  }
  let template: Awaited<ReturnType<typeof registerPsdTemplate>> | undefined
  let mustConfirm = false
  let uploadFailure: unknown
  let resigned = false
  for (let attempt = 0; ; attempt++) {
    requireCurrent(current)
    let stage: "register" | "upload" | "confirm" = "register"
    try {
      template ??= await registerPsdTemplate(body, signal)
      requireCurrent(current)
      if (typeof template.ready !== "boolean" || template.sha256 !== sha256 || template.bytes !== body.bytes
        || template.description_category_id !== descriptionCategoryId || template.type_id !== typeId) {
        throw refuse("workflow_template_unconfirmed", "云端 PSD 登记身份不一致")
      }
      if (template.ready) {
        clearSession(sha256)
        clearPsdTransferBySha(sha256)
        return
      }
      const multipart = multipartOf(template as { multipart?: MultipartPlan | null })
      if (multipart) {
        openMultipart.set(sha256, { id: template.id, ticket: multipart.ticket })
        stage = "upload"
        let parts
        try {
          parts = await uploadParts(source, multipart, {
            signal, sha256, onProgress: (progress) => notePsdUpload(sha256, progress),
            target: { rowId: targetId, fileName },
          })
        } catch (reason) {
          if ((reason as { code?: string }).code === "psd_part_gone") {
            await abortPsdMultipart(template.id, multipart.ticket, signal).catch(() => {})
            clearSession(sha256)
            template = undefined
          }
          throw reason
        }
        stage = "confirm"
        const confirmed = await completePsdMultipart(template.id, { ticket: multipart.ticket, parts }, signal)
        requireCurrent(current)
        if (confirmed.ready !== true || confirmed.sha256 !== sha256 || confirmed.bytes !== body.bytes) {
          throw refuse("workflow_template_unconfirmed", "PSD 云端备份身份尚未确认")
        }
        openMultipart.delete(sha256)
        clearSession(sha256)
        clearPsdTransferBySha(sha256)
        return
      }
      if (!mustConfirm) {
        if (bytes.length === 0) bytes = source instanceof File
          ? new Uint8Array(await source.arrayBuffer())
          : await localBytes(sha256, current)
        stage = "upload"
        try {
          await uploadPsdTemplate(template, bytes, signal)
          uploadFailure = undefined
        } catch (reason) {
          if (!(reason as { outcomeUnknown?: boolean })?.outcomeUnknown) throw reason
          uploadFailure = reason
        }
        mustConfirm = true
        // Success, existence or response loss all probe the exact object before another PUT.
        // A proved-missing object can reload verified OPFS bytes; keep no 500 MiB buffer.
        bytes = new Uint8Array(0)
      }
      requireCurrent(current)
      stage = "confirm"
      let confirmed: Awaited<ReturnType<typeof confirmPsdTemplate>>
      try { confirmed = await confirmPsdTemplate(template.id, signal) } catch (reason) {
        if ((reason as { code?: string })?.code !== "cloud_template_object_missing") throw reason
        // Only this authoritative absence permits re-PUT, never an integrity conflict.
        mustConfirm = false
        template = undefined
        stage = "upload"
        throw uploadFailure ?? reason
      }
      requireCurrent(current)
      if (confirmed.ready !== true || confirmed.sha256 !== sha256 || confirmed.bytes !== body.bytes
        || confirmed.description_category_id !== descriptionCategoryId || confirmed.type_id !== typeId) {
        throw refuse("workflow_template_unconfirmed", "PSD 云端备份身份尚未确认")
      }
      clearPsdTransferBySha(sha256)
      return
    } catch (reason) {
      requireCurrent(current)
      if (attempt >= MAX_RETRIES) throw reason
      const expired = stage === "upload" && (reason as { status?: number })?.status === 403 && !resigned
      const delay = expired ? 0 : retryDelay(reason, attempt)
      if (delay === undefined) throw reason
      if (expired) resigned = true
      // Re-register failed uploads to refresh the capability / discover a
      // completed backup. A lost confirmation never uploads the bytes again.
      if (stage !== "confirm") template = undefined
      if (delay > 0) await waitForRetry(delay, signal)
    }
  }
}

/** Continue a PSD backup when the picked handle is still readable. Same file, same ticket. */
export async function resumeReadablePsdUploads(): Promise<number> {
  const tasks = await listResumes("psd")
  let started = 0
  for (const task of tasks) {
    if (!task.handle || !task.sha256 || !task.descriptionCategoryId || !task.typeId) continue
    if (!task.ticket && !task.completedParts.length) continue
    const file = await fileFromGrantedHandle(task.handle)
    if (!file || file.size !== task.byteLength) continue
    rememberTemplateFile(task.sha256, file)
    rememberTemplateHandle(task.sha256, task.handle)
    backupUserTemplate({
      psdTemplateSha256: task.sha256,
      psdTemplateFileName: task.fileName || file.name,
      descriptionCategoryId: task.descriptionCategoryId,
      typeId: task.typeId,
    }, rowCacheScope().current, task.rowId)
    started += 1
  }
  return started
}

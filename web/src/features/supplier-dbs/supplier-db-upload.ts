/** Supplier-owned upload lifecycle: bounded hash → anonymous immutable PUT → authenticated confirmation. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { request } from "@/api/client"
import { route } from "@/api/routes"
import { retryWhenBusy } from "@/api/busy-retry"
import { hashUploadBody, putDirectUpload, type DirectUploadGrant } from "@/bindings/direct-upload"
import { hashFile } from "@/bindings/sha256-stream"
import {
  clearSession, readSession, uploadParts, type MultipartPlan, type PartEtag, type UploadProgress,
} from "@/bindings/multipart-upload"
import { validateVideoResolution } from "@/lib/video-duration"

import type {
  PresignSupplierDbUploadRequest,
  SupplierDbUploadKind,
} from "@/bindings/http-supplier-dbs"
import type { MutationResult } from "./supplier-dbs-store"
import { supplierDbs } from "./supplier-dbs-store"

/** presign 503 的 renderer 命名空间（client.ts `cloud_<lowercased>`）。 */
export const STORAGE_NOT_CONFIGURED_CODE = "cloud_storage_not_configured"

// ---------- 上传约束（docs/supplier-dbs.md §4 白名单 + 上限） ----------

export const GALLERY_MAX_BYTES = 20 * 1024 * 1024
export const PSD_MAX_BYTES = 500 * 1024 * 1024
export const VIDEO_MAX_BYTES = 200 * 1024 * 1024

/** 行内数组上限（服务端 normalize_row 同值）。 */
export const GALLERY_MAX_ITEMS = 20
export const PSD_MAX_ITEMS = 1
export const VIDEO_MAX_ITEMS = 10

export const GALLERY_EXTENSIONS = ["jpg", "jpeg", "png", "webp"] as const
export const PSD_EXTENSIONS = ["psd"] as const
export const VIDEO_EXTENSIONS = ["mp4", "mov"] as const

/** `<input accept>` 值——扩展名口径，MIME 各端不一致（.mov 尤其）。 */
export const GALLERY_ACCEPT = ".jpg,.jpeg,.png,.webp"
export const PSD_ACCEPT = ".psd"
export const VIDEO_ACCEPT = ".mp4,.mov"

const KIND_RULES: Record<
  SupplierDbUploadKind,
  {
    extensions: readonly string[]
    maxBytes: number
    maxItems: number
    label: string
    limitLabel: string
  }
> = {
  gallery: {
    extensions: GALLERY_EXTENSIONS,
    maxBytes: GALLERY_MAX_BYTES,
    maxItems: GALLERY_MAX_ITEMS,
    label: "图集图片",
    limitLabel: "20MB",
  },
  psd: {
    extensions: PSD_EXTENSIONS,
    maxBytes: PSD_MAX_BYTES,
    maxItems: PSD_MAX_ITEMS,
    label: "PSD",
    limitLabel: "500MB",
  },
  video: {
    extensions: VIDEO_EXTENSIONS,
    maxBytes: VIDEO_MAX_BYTES,
    maxItems: VIDEO_MAX_ITEMS,
    label: "视频",
    limitLabel: "200MB",
  },
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ""
}

/**
 * 本地预检：扩展名白名单 + 字节上限。返回中文提示或 `null`（放行）。
 * presign 与服务端 finalize 仍会复核——这层只为省一次注定失败的往返。
 */
export function uploadFileError(
  kind: SupplierDbUploadKind,
  file: { name: string; size: number },
): string | null {
  const rules = KIND_RULES[kind]
  const ext = extensionOf(file.name)
  if (!rules.extensions.includes(ext)) {
    return `${rules.label}仅支持 ${rules.extensions.join("/")} 格式`
  }
  if (file.size <= 0) {
    return `${rules.label}「${file.name}」是空文件`
  }
  if (file.size > rules.maxBytes) {
    return `${rules.label}「${file.name}」超过 ${rules.limitLabel} 上限`
  }
  return null
}

/** 行内数组已满时拦在 presign 之前；返回提示或 `null`（还有余位）。 */
export function uploadCountError(
  kind: SupplierDbUploadKind,
  currentCount: number,
): string | null {
  const rules = KIND_RULES[kind]
  return currentCount >= rules.maxItems
    ? `${rules.label}最多 ${rules.maxItems} 个`
    : null
}

/**
 * 声明给 presign 的 Content-Type：浏览器给的 `file.type` 优先；认不出时按
 * 扩展名兜底——服务端对图集/视频有 `image/*`/`video/*` 前缀校验，裸
 * `application/octet-stream` 会被 400 退回。
 */
export function uploadContentType(
  kind: SupplierDbUploadKind,
  file: { name: string; type: string },
): string {
  const ext = extensionOf(file.name)
  switch (kind) {
    case "gallery":
      return (
        {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
        }[ext] ?? "application/octet-stream"
      )
    case "video":
      return (
        { mp4: "video/mp4", mov: "video/quicktime" }[ext] ??
        "application/octet-stream"
      )
    default:
      return "image/vnd.adobe.photoshop"
  }
}

// ---------- direct upload lifecycle ----------
export type SupplierDbUploadTarget = {
  upload?: DirectUploadGrant | null
  uploadTicket: string
  multipart?: MultipartPlan | null
  alreadyPresent?: boolean
}
export type SupplierDbPresign = (
  sourceId: string, request: PresignSupplierDbUploadRequest & { sha256: string },
) => Promise<MutationResult<SupplierDbUploadTarget>>
export type SupplierDbConfirm = (
  sourceId: string, uploadTicket: string, signal?: AbortSignal, parts?: PartEtag[],
) => Promise<SupplierDbUploadResult>
export type SupplierDbUploadProgress = UploadProgress
export type SupplierDbUploadInput = {
  kind: SupplierDbUploadKind; file: File; lane?: SupplierDbUploadKind
  onProgress?: (progress: SupplierDbUploadProgress) => void; signal?: AbortSignal
}
export type SupplierDbUploadResult = { publicUrl: string; key: string }
export type SupplierUploadAttempt = {
  sourceId: string
  kind: SupplierDbUploadKind
  target: SupplierDbUploadTarget
  sha256: string
}
export type SupplierUploadAttempts = WeakMap<File, SupplierUploadAttempt>

export function isUploadAbort(reason: unknown): boolean {
  return reason instanceof Error && (reason.name === "AbortError" || reason.message === "AbortError")
}
function checkCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("已取消", "AbortError")
}
function actualObjectMissing(reason: unknown): boolean {
  return reason instanceof Error && "code" in reason && reason.code === "cloud_upload_object_missing"
}
const confirmUpload: SupplierDbConfirm = (sourceId, uploadTicket, signal, parts) =>
  retryWhenBusy(() => request("POST", route("adminSupplierDbsBySourceIdUploadsConfirm", { source_id: sourceId }),
    { uploadTicket, ...(parts ? { parts } : {}) }, {}, parts ? 60_000 : 65 * 60 * 1000,
    undefined, { callerSignal: signal, reportOwner: "caller" }),
  { cancelled: () => signal?.aborted === true })

function abortSupplierMultipart(sourceId: string, uploadTicket: string): void {
  void request("POST", route("adminSupplierDbsBySourceIdUploadsAbort", { source_id: sourceId }),
    { uploadTicket }, {}, 30_000, undefined, { reportOwner: "caller" }).catch(() => {})
}

/** A retry keeps the original intent and confirms it FIRST. Only actual-object-missing permits PUT. */
export async function supplierDbUploadFile(
  presign: SupplierDbPresign, sourceId: string, input: SupplierDbUploadInput,
  options: { confirm?: SupplierDbConfirm; attempts?: SupplierUploadAttempts } = {},
): Promise<SupplierDbUploadResult> {
  const confirm = options.confirm ?? confirmUpload
  const attempts = options.attempts
  checkCancelled(input.signal)
  const cached = attempts?.get(input.file)
  const sameAttempt = cached?.sourceId === sourceId && cached.kind === input.kind ? cached : undefined
  let target = sameAttempt?.target
  let sha256 = sameAttempt?.sha256 ?? ""
  try {
    if (target && !target.multipart && !target.alreadyPresent && target.upload) {
      try {
        const ready = await confirm(sourceId, target.uploadTicket, input.signal)
        checkCancelled(input.signal)
        attempts?.delete(input.file)
        return ready
      } catch (reason) {
        checkCancelled(input.signal)
        if (!actualObjectMissing(reason)) throw reason
        if (target.upload.expires_at_ms <= Date.now() + 5000) target = undefined
      }
    }
    if (!target) {
      const problem = uploadFileError(input.kind, input.file)
      if (problem) throw new Error(problem)
      if (input.kind === "video") await validateVideoResolution(input.file, input.signal)
      checkCancelled(input.signal)
      const largePsd = input.kind === "psd" && input.file.size > 16 * 1024 * 1024
      sha256 = largePsd
        ? await hashFile(input.file, {
          signal: input.signal,
          onProgress: (loaded, total) => input.onProgress?.({ loaded, total, bytesPerSec: 0, etaSec: Number.POSITIVE_INFINITY, phase: "hash" }),
        })
        : await hashUploadBody(input.file, input.signal)
      checkCancelled(input.signal)
      const session = largePsd ? readSession(sha256) : null
      const result = await retryWhenBusy(() => presign(sourceId, { kind: input.kind, filename: input.file.name,
        contentType: uploadContentType(input.kind, input.file), bytes: input.file.size, sha256,
        ...(session ? { resumeTicket: session.ticket } : {}) }), { cancelled: () => input.signal?.aborted === true })
      checkCancelled(input.signal)
      if (!result.ok) throw result.reason instanceof Error ? result.reason : new Error(result.issues[0]?.message ?? "无法创建上传")
      target = result.value
      attempts?.set(input.file, { sourceId, kind: input.kind, target, sha256 })
    }
    if (target.alreadyPresent) {
      const ready = await confirm(sourceId, target.uploadTicket, input.signal)
      attempts?.delete(input.file)
      return ready
    }
    if (target.multipart) {
      try {
        const parts = await uploadParts(input.file, target.multipart, {
          signal: input.signal,
          sha256: sha256 || undefined,
          onProgress: input.onProgress,
        })
        const ready = await confirm(sourceId, target.uploadTicket, input.signal, parts)
        attempts?.delete(input.file)
        if (sha256) clearSession(sha256)
        return ready
      } catch (reason) {
        const gone = (reason as { code?: string }).code === "psd_part_gone"
        if (gone || input.signal?.aborted) {
          abortSupplierMultipart(sourceId, target.uploadTicket)
          attempts?.delete(input.file)
          if (sha256) clearSession(sha256)
        }
        throw reason
      }
    }
    if (!target.upload) throw new Error("文件上传授权无效，请重新选择文件")
    let putFailure: unknown
    try {
      await putDirectUpload(target.upload, input.file, { expectedByteLength: input.file.size, signal: input.signal,
        onProgress: input.onProgress ? (loaded, total) => input.onProgress?.({ loaded, total, bytesPerSec: 0, etaSec: 0, phase: "upload" }) : undefined })
    } catch (reason) { checkCancelled(input.signal); putFailure = reason }
    checkCancelled(input.signal)
    try {
      const ready = await confirm(sourceId, target.uploadTicket, input.signal)
      checkCancelled(input.signal)
      attempts?.delete(input.file)
      return ready
    } catch (reason) {
      if (putFailure && actualObjectMissing(reason)) throw putFailure
      throw reason
    }
  } catch (reason) { checkCancelled(input.signal); throw reason }
}

// ---------- hook ----------

export type SupplierDbUploader = {
  /**
   * hash → PUT → confirm。成功回 `{publicUrl, key}`；失败抛 reason（abort 抛
   * AbortError）。调用方负责 notify 纪律。
   */
  upload: (input: SupplierDbUploadInput) => Promise<SupplierDbUploadResult>
  /** 某条泳道（图集/PSD/视频）有上传在途——三组按钮互不跟着转。 */
  busyFor: (lane: SupplierDbUploadKind) => boolean
  /** 中止全部在途上传（组件卸载时调用）。 */
  cancelAll: () => void
}

/**
 * `useSupplierDbUpload(sourceId)`：行媒体区唯一的上传入口。
 * `presign` 可注入（测试替身）；缺省走生产 store 的 `presignUpload`。
 *
 * busy 按泳道计：一个图集上传不该把 PSD/视频按钮一起转圈。上传按
 * `input.lane ?? input.kind` 归道（视频封面按 gallery kind 传、归视频道）。
 */
export function useSupplierDbUpload(
  sourceId: string,
  options?: { presign?: SupplierDbPresign; confirm?: SupplierDbConfirm },
): SupplierDbUploader {
  const presign = useMemo<SupplierDbPresign>(
    () =>
      options?.presign ??
      ((id, request) => supplierDbs.presignUpload(id, request)),
    [options?.presign],
  )
  const [pendingByLane, setPendingByLane] = useState<
    Record<SupplierDbUploadKind, number>
  >({ gallery: 0, psd: 0, video: 0 })
  const controllers = useRef(new Set<AbortController>())
  const attempts = useRef<SupplierUploadAttempts>(new WeakMap())
  const mounted = useRef(true)
  const scopeGeneration = useRef(0)

  // 卸载即收尾：中止在途上传，之后的 finally 不再碰 state。
  useEffect(() => {
    mounted.current = true
    scopeGeneration.current += 1
    setPendingByLane({ gallery: 0, psd: 0, video: 0 })
    return () => {
      scopeGeneration.current += 1
      mounted.current = false
      for (const controller of controllers.current) controller.abort()
      controllers.current.clear()
    }
  }, [sourceId])

  const upload = useCallback(
    async (input: SupplierDbUploadInput) => {
      const lane = input.lane ?? input.kind
      const generation = scopeGeneration.current
      const controller = new AbortController()
      controllers.current.add(controller)
      setPendingByLane((count) => ({ ...count, [lane]: count[lane] + 1 }))
      // 调用方可自带 signal（如批量取消）；两处任一 abort 都中止本次上传。
      const upstream = input.signal
      const onAbort = () => controller.abort()
      upstream?.addEventListener("abort", onAbort, { once: true })
      if (upstream?.aborted) controller.abort()
      try {
        return await supplierDbUploadFile(presign, sourceId, {
          ...input,
          signal: controller.signal,
        }, { confirm: options?.confirm, attempts: attempts.current })
      } finally {
        upstream?.removeEventListener("abort", onAbort)
        controllers.current.delete(controller)
        if (mounted.current && generation === scopeGeneration.current) {
          setPendingByLane((count) => ({
            ...count,
            [lane]: Math.max(0, count[lane] - 1),
          }))
        }
      }
    },
    [presign, sourceId, options?.confirm],
  )

  const busyFor = useCallback(
    (lane: SupplierDbUploadKind) => pendingByLane[lane] > 0,
    [pendingByLane],
  )

  const cancelAll = useCallback(() => {
    for (const controller of controllers.current) controller.abort()
    controllers.current.clear()
  }, [])

  return {
    upload,
    busyFor,
    cancelAll,
  }
}

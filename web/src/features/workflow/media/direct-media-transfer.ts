/** One image/video transport: restricted PUT, authenticated native confirmation, no relay fallback. */
import { request as apiRequest } from "@/api/client"
import { BUSY_RETRY_DEFAULTS, isBusyRefusal, retryWhenBusy, type BusyRetryOptions } from "@/api/busy-retry"
import { route } from "@/api/routes"
import { hashUploadBody, putDirectUpload } from "@/bindings/direct-upload"
import { cancelledError } from "@/lib/error-message"
import { acquireComplete, acquireDelivery } from "./direct-media-budget"
import { activeWorkspaceUuid, matchesUploadBatch, rememberMediaObject } from "./direct-media-cache"
import type { CloudAnswer, DeliverMediaObjectRequest, DeliveredMediaObject, MediaObjectTarget,
  MediaObjectPresignData, MediaObjectCompleteData, MediaTransferTiming } from "./direct-media-types"

const CONTROL_TIMEOUT_MS = 35_000
// Origin hash/read + public readiness are expensive server reads, not byte PUT slots.
const COMPLETE_TIMEOUT_MS = 65 * 60_000
type PendingTransfer = { target: MediaObjectPresignData; byteLength: number; at: number; uploadBatch?: string; reconcile: boolean }
const pending = new Map<string, PendingTransfer>()
/** The direct operation owns all post-PUT retries; a stage must not replenish them. */
export function isDirectMediaTransferFinal(reason: unknown): boolean {
  return (reason as { mediaTransferFinal?: unknown } | null)?.mediaTransferFinal === true
}
function finalTransferError(reason: unknown): Error {
  const error = isBusyRefusal(reason)
    ? Object.assign(invalidPresign(
      reason.status === 429 ? "请求过于频繁，存储限流，请稍后重试" : "媒体直传重试已耗尽，请稍后重试",
      "media_direct_retry_exhausted",
    ), { cause: reason, status: reason.status })
    : reason instanceof Error ? reason : invalidPresign("媒体直传未完成", "media_direct_failed")
  return Object.assign(error, { mediaTransferFinal: true })
}
function pendingTransfer(request: DeliverMediaObjectRequest, key: string, suffix: string): [string, PendingTransfer] | undefined {
  for (const [candidate, prior] of pending) {
    if (Date.now() - prior.at >= 4 * 60 * 60 * 1000) { pending.delete(candidate); continue }
    if (candidate === key || (prior.reconcile && prior.target.workspaceUuid === request.workspaceUuid
      && prior.target.objectKey.endsWith(suffix))) return [candidate, prior]
  }
}
export function clearPendingDirectMedia(): void { pending.clear() }
/** Rejected authorization cannot confirm these PUTs; retained OPFS bytes can use a fresh batch. */
export function discardPendingUploadBatch(workspaceUuid: string, uploadBatch: string): void {
  for (const [key, transfer] of pending) {
    if (transfer.target.workspaceUuid === workspaceUuid && transfer.uploadBatch === uploadBatch) pending.delete(key)
  }
}
export function invalidPresign(message: string, code = "media_presign_invalid"): Error {
  return Object.assign(new Error(message), { code })
}
export function assertDeliveryCurrent(request: DeliverMediaObjectRequest): void {
  if (!request.workspaceUuid || activeWorkspaceUuid() !== request.workspaceUuid) {
    throw invalidPresign("Workspace 已切换，请重新准备当前商品", "workflow_workspace_changed")
  }
  if (request.retry?.cancelled?.()) throw cancelledError()
}
export function scopedRetry(request: DeliverMediaObjectRequest): BusyRetryOptions {
  return { ...request.retry, cancelled: () => Boolean(request.retry?.cancelled?.())
    || activeWorkspaceUuid() !== request.workspaceUuid }
}
function workspaceMissingError(): Error { return invalidPresign("当前没有可用的 Workspace", "workflow_workspace_missing") }
/** The wire spells the object identity snake_case; the media feature keeps its camel projection. */
type WireTarget = { account_id?: unknown, object_key?: unknown, public_url?: unknown, workspace_uuid?: unknown, storage_revision?: unknown }

function requireTarget(value: unknown, workspace: string, digest: string, extension: string): MediaObjectTarget {
  if (!value || typeof value !== "object") throw invalidPresign("云端未返回媒体对象身份")
  const wire = value as WireTarget
  const storageRevision = wire.storage_revision
  if (typeof storageRevision !== "number" || !Number.isSafeInteger(storageRevision) || storageRevision < 0
    || typeof wire.account_id !== "string" || !wire.account_id
    || typeof wire.object_key !== "string" || !wire.object_key
    || typeof wire.public_url !== "string" || !wire.public_url
    || typeof wire.workspace_uuid !== "string" || wire.workspace_uuid !== workspace
    || !wire.object_key.includes(`/teams/${workspace}/`)) {
    throw invalidPresign("云端返回的媒体对象身份无效")
  }
  const suffix = `${digest}.${extension}`
  if (!wire.object_key.endsWith(suffix)) throw invalidPresign("云端返回的媒体对象键与摘要不一致")
  return { accountId: wire.account_id, objectKey: wire.object_key, publicUrl: wire.public_url,
    workspaceUuid: wire.workspace_uuid, storageRevision } as MediaObjectTarget
}

type WirePresign = WireTarget & {
  transport?: unknown, upload?: { url?: unknown, expires_at_ms?: unknown, headers?: { content_type?: unknown, if_none_match?: unknown } } | null,
  upload_ticket?: unknown, upload_batch?: unknown,
}

export function requirePresign(value: unknown, request: DeliverMediaObjectRequest, digest: string, extension: string): MediaObjectPresignData {
  if (!value || typeof value !== "object") throw invalidPresign("云端未返回媒体上传准备")
  const data = value as WirePresign
  if (data.transport !== "ready" && data.transport !== "direct") {
    throw invalidPresign("云端返回了未知的媒体传输方式")
  }
  const workspace = request.workspaceUuid
  if (!workspace) throw workspaceMissingError()
  const target = requireTarget(data, workspace, digest, extension)
  if (["jpg", "png"].includes(extension) && request.uploadBatch && !matchesUploadBatch(request.uploadBatch, target.objectKey)) {
    throw invalidPresign("云端上传目录与当前批次不一致", "media_upload_batch_mismatch")
  }
  if (data.transport === "direct") {
    if (!data.upload || typeof data.upload !== "object" || typeof data.upload.url !== "string"
      || !data.upload.url || !Number.isFinite(data.upload.expires_at_ms)
      || data.upload.headers?.content_type !== request.contentType || data.upload.headers?.if_none_match !== "*"
      || typeof data.upload_ticket !== "string" || !data.upload_ticket) {
      throw invalidPresign("直传授权格式无效", "media_direct_headers_invalid")
    }
  }
  return { ...target, transport: data.transport,
    ...(data.upload ? { upload: data.upload as MediaObjectPresignData["upload"] } : {}),
    ...(typeof data.upload_ticket === "string" ? { uploadTicket: data.upload_ticket } : {}),
    ...(typeof data.upload_batch === "string" ? { uploadBatch: data.upload_batch } : {}) } as MediaObjectPresignData
}


async function presign(request: DeliverMediaObjectRequest, digest: string, extension: string,
  byteLength: number): Promise<MediaObjectPresignData> {
  const page = await retryWhenBusy(() => {
    assertDeliveryCurrent(request)
    // The single-object presign response is a flat grant without the object
    // identity the confirm needs, so one object rides the batch presign.
    return apiRequest<{ objects: unknown[] }>("POST", route("mediaObjectsPresignBatch"), {
      workspace_uuid: request.workspaceUuid,
      ...(request.uploadBatch ? { upload_batch: request.uploadBatch } : {}),
      store_checksum: "sha256",
      objects: [{ digest, extension, byte_length: byteLength }],
    }, {}, CONTROL_TIMEOUT_MS)
  }, scopedRetry(request))
  assertDeliveryCurrent(request)
  if (!page || !Array.isArray(page.objects) || page.objects.length !== 1)  throw invalidPresign("云端未返回媒体上传准备")
  return requirePresign(page.objects[0], request, digest, extension)
}
function remember(request: DeliverMediaObjectRequest, target: MediaObjectTarget, via: "put" | "ready"): DeliveredMediaObject {
  const answer: CloudAnswer = { accountId: target.accountId, objectKey: target.objectKey,
    publicUrl: target.publicUrl, workspaceUuid: target.workspaceUuid, storageRevision: target.storageRevision }
  rememberMediaObject(answer, request.digest, request.extension, Date.now(), {
    workspaceUuid: target.workspaceUuid, uploadBatch: request.uploadBatch,
  })
  return { ...answer, via }
}
async function complete(request: DeliverMediaObjectRequest, target: MediaObjectPresignData,
  byteLength: number): Promise<DeliveredMediaObject> {
  try {
    const result = await retryWhenBusy(async () => {
      const release = await acquireComplete(scopedRetry(request).cancelled)
      try {
        assertDeliveryCurrent(request)
        return await apiRequest<unknown>("POST", route("mediaObjectsByDigestByExtensionComplete", {
          digest: request.digest.toLowerCase(), extension: request.extension.toLowerCase(),
        }), {
          workspace_uuid: target.workspaceUuid, account_id: target.accountId, object_key: target.objectKey,
          storage_revision: target.storageRevision, byte_length: byteLength, upload_ticket: target.uploadTicket,
          ...(request.uploadBatch ? { upload_batch: request.uploadBatch } : {}),
        }, {}, COMPLETE_TIMEOUT_MS)
      } finally { release() }
    }, { ...scopedRetry(request), attempts: BUSY_RETRY_DEFAULTS.attempts, maxWaitMs: BUSY_RETRY_DEFAULTS.maxWaitMs, paceShortHints: true })
    assertDeliveryCurrent(request)
    if (!confirmedReceipt(result, target, byteLength)) {
      throw invalidPresign("云端完成确认与直传对象不一致", "media_complete_mismatch")
    }
    return finishConfirmed(request, target, byteLength, result)
  } catch (reason) {
    assertDeliveryCurrent(request)
    if (isBusyRefusal(reason)) throw invalidPresign("完成确认服务繁忙，请稍后重试", "media_complete_busy")
    throw reason
  }
}
type WireComplete = { transport?: unknown, deduplicated?: unknown, account_id?: unknown, object_key?: unknown,
  public_url?: unknown, workspace_uuid?: unknown, storage_revision?: unknown, byte_length?: unknown, checksum_trusted?: unknown }

function confirmedReceipt(result: unknown, target: MediaObjectTarget, byteLength: number): result is MediaObjectCompleteData {
  if (!result || typeof result !== "object") return false
  const wire = result as WireComplete
  return Boolean(wire.transport === "ready" && typeof wire.deduplicated === "boolean"
    && wire.account_id === target.accountId && wire.object_key === target.objectKey
    && wire.public_url === target.publicUrl && wire.workspace_uuid === target.workspaceUuid
    && wire.storage_revision === target.storageRevision && wire.byte_length === byteLength)
}
function checksumMark(target: MediaObjectPresignData, trusted: boolean): DeliveredMediaObject["checksum"] {
  if (trusted) return "trusted"
  return target.upload?.headers.checksum_sha256 ? "signed" : undefined
}
function finishConfirmed(request: DeliverMediaObjectRequest, target: MediaObjectPresignData, byteLength: number,
  result: MediaObjectCompleteData | (WireComplete & object)): DeliveredMediaObject {
  pending.delete(pendingKey(request, request.digest.toLowerCase(), request.extension.toLowerCase()))
  const trusted = (result as WireComplete).checksum_trusted === true || (result as MediaObjectCompleteData).checksumTrusted === true
  return { ...remember(request, target, "put"), checksum: checksumMark(target, trusted) }
}
/** One storage confirm. Batch fallback uses this when complete-batch fails. */
export async function completeGrantedMedia(request: DeliverMediaObjectRequest, target: MediaObjectPresignData,
  byteLength: number): Promise<DeliveredMediaObject> {
  return complete(request, target, byteLength)
}
/** Apply a complete-batch receipt without another round trip. */
export function acceptConfirmedUpload(request: DeliverMediaObjectRequest, target: MediaObjectPresignData,
  byteLength: number, result: unknown): DeliveredMediaObject {
  if (!confirmedReceipt(result, target, byteLength)) {
    throw invalidPresign("云端完成确认与直传对象不一致", "media_complete_mismatch")
  }
  return finishConfirmed(request, target, byteLength, result)
}
function pendingKey(request: DeliverMediaObjectRequest, digest: string, extension: string): string {
  return `${request.workspaceUuid}|${request.uploadBatch ?? "legacy"}|${digest}|${extension}`
}
function objectMissing(reason: unknown): boolean {
  const error = reason as { status?: number; code?: string }
  return error?.status === 404 && ["media_complete_missing", "cloud_media_complete_missing"].includes(error.code ?? "")
}
function uncertainPut(reason: unknown): boolean {
  const error = reason as { status?: number; outcomeUnknown?: boolean }
  return error?.outcomeUnknown === true || error?.status === 403 || error?.status === 408
    || error?.status === 429 || (error?.status != null && error.status >= 500)
}
function lengthOf(request: DeliverMediaObjectRequest, bytes: Uint8Array): number {
  if (request.byteLength != null && request.byteLength !== bytes.byteLength) {
    throw invalidPresign("切片字节数与清单不一致", "media_byte_length_mismatch")
  }
  if (!bytes.byteLength) throw invalidPresign("媒体字节数无效", "media_byte_length_invalid")
  return bytes.byteLength
}
async function digestBody(request: DeliverMediaObjectRequest, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
  if ((await hashUploadBody(bytes, signal)).toLowerCase() !== request.digest.toLowerCase()) {
    throw Object.assign(invalidPresign("文件校验失败，切片与清单不一致", "media_digest_mismatch"), { remediation: "重新切片后再上传" })
  }
  assertDeliveryCurrent(request)
}

type TransferPhase = "readMs" | "hashMs" | "presignMs" | "putMs" | "completeMs"

function clock(): {
  measured: <T>(phase: TransferPhase, work: () => T | Promise<T>) => Promise<T>
  stamp: (value: DeliveredMediaObject, bytes: number) => DeliveredMediaObject
} {
  const timing: MediaTransferTiming = { bytes: 0, readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: 0 }
  return {
    measured: async (phase, work) => {
      const started = performance.now()
      try { return await work() }
      finally { timing[phase] += Math.max(0, Math.round(performance.now() - started)) }
    },
    stamp: (value, bytes) => ({ ...value, timing: { ...timing, bytes } }),
  }
}

/** Finish an uncertain PUT from an earlier attempt before minting a new grant. */
export async function reconcilePendingDirectMedia(request: DeliverMediaObjectRequest): Promise<DeliveredMediaObject | null> {
  assertDeliveryCurrent(request)
  const digest = request.digest.toLowerCase(), extension = request.extension.toLowerCase()
  const key = pendingKey(request, digest, extension)
  const { measured, stamp } = clock()
  let attempted = false
  try {
    // Later explicit uploads mint a new batch. Reconcile only settled uncertainty,
    // using its ORIGINAL signed scope; never probe another active batch's PUT.
    for (let prior = pendingTransfer(request, key, `${digest}.${extension}`); prior;
      prior = pendingTransfer(request, key, `${digest}.${extension}`)) {
      const [priorKey, transfer] = prior
      attempted = true
      const previousScope = { ...request, uploadBatch: transfer.uploadBatch }
      try {
        const value = await measured("completeMs", () => complete(previousScope, transfer.target, transfer.byteLength))
        pending.delete(priorKey)
        return stamp(value, transfer.byteLength)
      } catch (reason) {
        if (!objectMissing(reason)) throw reason
        pending.delete(priorKey)
        attempted = false
      }
    }
    return null
  } catch (reason) {
    const unresolved = pending.get(key)
    if (unresolved) unresolved.reconcile = true
    if (attempted) throw finalTransferError(reason)
    throw reason
  }
}

export async function prepareDirectMedia(request: DeliverMediaObjectRequest): Promise<DeliveredMediaObject> {
  assertDeliveryCurrent(request)
  const reconciled = await reconcilePendingDirectMedia(request)
  if (reconciled) return reconciled
  const digest = request.digest.toLowerCase(), extension = request.extension.toLowerCase()
  if (request.byteLength != null && (!Number.isSafeInteger(request.byteLength) || request.byteLength < 1)) {
    throw invalidPresign("媒体字节数无效", "media_byte_length_invalid")
  }
  const key = pendingKey(request, digest, extension)
  const { measured, stamp } = clock()
  let bytes: Uint8Array<ArrayBuffer> | undefined
  let hashed: Uint8Array<ArrayBuffer> | undefined
  let release: (() => void) | undefined
  let byteLength = request.byteLength
  let attempted = false
  try {
    if (byteLength == null) {
      release = await acquireDelivery(undefined, scopedRetry(request).cancelled)
      assertDeliveryCurrent(request)
      const read = await measured("readMs", () => request.bytes())
      bytes = read
      assertDeliveryCurrent(request)
      byteLength = lengthOf(request, read)
      // Verify before presign so a `ready` lease cannot skip a mismatched buffer.
      // The same reference is not hashed again on the first PUT attempt.
      await measured("hashMs", () => digestBody(request, read))
      hashed = read
    }
    if (byteLength == null) throw invalidPresign("媒体字节数无效", "media_byte_length_invalid")
    const size = byteLength
    // A row-level presign batch already validated and projected this grant.
    let target = request.issued
      ? { ...request.issued }
      : await measured("presignMs", () => presign(request, digest, extension, size))
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (target.transport === "ready") return stamp(remember(request, target, "ready"), size)
      if (!release) release = await acquireDelivery(size, scopedRetry(request).cancelled)
      let putFailure: unknown
      const controller = new AbortController()
      const cancelPoll = setInterval(() => { if (scopedRetry(request).cancelled?.()) controller.abort() }, 100)
      try {
        assertDeliveryCurrent(request)
        const body = bytes ?? await measured("readMs", () => request.bytes())
        bytes = body
        assertDeliveryCurrent(request)
        if (lengthOf(request, body) !== size) throw invalidPresign("媒体字节数无效", "media_byte_length_mismatch")
        if (hashed !== body || attempt > 0) {
          await measured("hashMs", () => digestBody(request, body, controller.signal))
          hashed = body
        }
        assertDeliveryCurrent(request)
        attempted = true
        pending.set(key, { target, byteLength: size, at: Date.now(), uploadBatch: request.uploadBatch, reconcile: false })
        try {
          await measured("putMs", () => putDirectUpload(target.upload!, body, { expectedByteLength: size, signal: controller.signal }))
        } catch (reason) {
          assertDeliveryCurrent(request)
          if (!uncertainPut(reason)) { pending.delete(key); throw reason }
          putFailure = reason
          // Unknown network outcome, expired grant or busy response: complete FIRST.
        }
        assertDeliveryCurrent(request)
      } finally {
        clearInterval(cancelPoll)
        bytes = undefined
        release?.(); release = undefined
      }
      if (request.deferComplete && putFailure == null) {
        return stamp({
          accountId: target.accountId, objectKey: target.objectKey, publicUrl: target.publicUrl,
          workspaceUuid: target.workspaceUuid, storageRevision: target.storageRevision, via: "put",
          pendingConfirm: true, uploadTicket: target.uploadTicket,
          checksum: checksumMark(target, false),
        }, size)
      }
      try {
        const value = await measured("completeMs", () => complete(request, target, size))
        pending.delete(key)
        return stamp(value, size)
      } catch (reason) {
        assertDeliveryCurrent(request)
        if (!objectMissing(reason)) throw reason
        pending.delete(key)
        const limited = isBusyRefusal(putFailure)
        if (limited ? attempt >= 3 : attempt >= 1) {
          throw invalidPresign("媒体对象仍未写入，请重试准备", "media_complete_missing_after_retry")
        }
        if (limited) {
          // Storage congestion is reconciled first; only authoritative absence permits
          // the bounded wait/renewal. Bytes and native permits are already released.
          let first = true
          await retryWhenBusy(async () => { if (first) { first = false; throw putFailure } },
            { ...scopedRetry(request), attempts: 2 })
          assertDeliveryCurrent(request)
        }
        target = await measured("presignMs", () => presign(request, digest, extension, size))
      }
    }
    throw invalidPresign("媒体直传未完成", "media_direct_failed")
  } catch (reason) {
    const unresolved = pending.get(key)
    if (unresolved) unresolved.reconcile = true
    if (attempted) throw finalTransferError(reason)
    throw reason
  } finally { bytes = undefined; release?.() }
}

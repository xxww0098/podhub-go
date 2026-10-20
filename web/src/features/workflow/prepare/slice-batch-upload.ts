/** One presign and one storage confirm for every slice of a row. Each object is still its own PUT. */
import { BUSY_RETRY_DEFAULTS, retryWhenBusy } from "@/api/busy-retry"
import { request as apiRequest } from "@/api/client"
import { route } from "@/api/routes"
import { elapsedMs } from "@/lib/diag-log"
import { acquireComplete } from "../media/direct-media-budget"
import {
  acceptConfirmedUpload, completeGrantedMedia, invalidPresign, requirePresign,
} from "../media/direct-media-transfer"
import type {
  DeliveredMediaObject, DeliverMediaObjectRequest, MediaObjectPresignData,
} from "../media/direct-media-types"
import { noteUploadGate } from "./upload-batch-meter"
import { planConfirm, planConfirmRetry, type ConfirmCandidate } from "./stage-plan"

export const SLICE_PUT_CONCURRENCY = 6

const flights = new Map<string, Promise<DeliveredMediaObject>>()

/** Rows that share one slice join the upload already in flight instead of PUT-ing again. */
export function shareSliceDelivery(
  request: DeliverMediaObjectRequest,
  run: () => Promise<DeliveredMediaObject>,
): Promise<DeliveredMediaObject> {
  const key = `${request.workspaceUuid}|${request.uploadBatch ?? "legacy"}|${request.digest.toLowerCase()}|${request.extension.toLowerCase()}`
  const existing = flights.get(key)
  if (existing) return existing
  const flight = run().finally(() => {
    if (flights.get(key) === flight) flights.delete(key)
  })
  flights.set(key, flight)
  return flight
}
const MAX_OBJECTS = 32
const CONTROL_TIMEOUT_MS = 35_000
const COMPLETE_TIMEOUT_MS = 65 * 60_000

function batchShape(count: number, actual: number): void {
  if (actual !== count) throw invalidPresign("云端批量回执与切片清单不一致", "media_batch_mismatch")
}

export async function presignSliceBatch(items: readonly DeliverMediaObjectRequest[]): Promise<{
  grants: MediaObjectPresignData[]
  presignMs: number
}> {
  const grants: MediaObjectPresignData[] = []
  const started = performance.now()
  for (let offset = 0; offset < items.length; offset += MAX_OBJECTS) {
    const chunk = items.slice(offset, offset + MAX_OBJECTS)
    const first = chunk[0]!
    const data = await retryWhenBusy(() => apiRequest<{ objects: unknown[] }>("POST", route("mediaObjectsPresignBatch"), {
      workspace_uuid: first.workspaceUuid,
      ...(first.uploadBatch ? { upload_batch: first.uploadBatch } : {}),
      store_checksum: "sha256",
      objects: chunk.map((item) => ({
        digest: item.digest.toLowerCase(),
        extension: item.extension.toLowerCase(),
        byte_length: item.byteLength,
      })),
    }, {}, CONTROL_TIMEOUT_MS), first.retry)
    batchShape(chunk.length, data?.objects?.length ?? 0)
    for (let index = 0; index < chunk.length; index += 1) {
      grants.push(requirePresign(data.objects[index], chunk[index]!, chunk[index]!.digest.toLowerCase(), chunk[index]!.extension.toLowerCase()))
    }
  }
  return { grants, presignMs: elapsedMs(started) }
}

function share(totalMs: number, count: number): number {
  return count > 0 ? Math.max(0, Math.round(totalMs / count)) : 0
}

function candidateOf(item: { request: DeliverMediaObjectRequest, delivered: DeliveredMediaObject }, index: number): ConfirmCandidate {
  const delivered = item.delivered
  return {
    index,
    digest: item.request.digest.toLowerCase(),
    extension: item.request.extension.toLowerCase(),
    objectKey: delivered.objectKey,
    byteLength: delivered.timing?.bytes ?? item.request.byteLength ?? 0,
    storageRevision: delivered.storageRevision ?? -1,
    uploadTicket: delivered.uploadTicket ?? "",
    accountId: delivered.accountId,
    workspaceUuid: delivered.workspaceUuid ?? item.request.workspaceUuid ?? "",
    pendingConfirm: delivered.pendingConfirm === true,
  }
}

interface BatchOutcomeError { status?: number, code?: string, error?: string, retry_after?: number }

async function confirmChunk(items: readonly { request: DeliverMediaObjectRequest, delivered: DeliveredMediaObject }[],
  startedAt: number): Promise<(DeliveredMediaObject | undefined)[]> {
  const first = items[0]!
  const data = await retryWhenBusy(async () => {
    noteUploadGate("本机已核对，排队确认")
    try {
      const release = await acquireComplete(first.request.retry?.cancelled)
      noteUploadGate("")
      try {
        return await apiRequest<{ objects: Array<{ object?: unknown, error?: BatchOutcomeError }> }>("POST", route("mediaObjectsCompleteBatch"), {
        workspace_uuid: first.request.workspaceUuid,
        ...(first.request.uploadBatch ? { upload_batch: first.request.uploadBatch } : {}),
        objects: items.map(({ request, delivered }) => ({
          digest: request.digest.toLowerCase(),
          extension: request.extension.toLowerCase(),
          upload_ticket: delivered.uploadTicket,
          account_id: delivered.accountId,
          object_key: delivered.objectKey,
          byte_length: delivered.timing?.bytes ?? request.byteLength,
          storage_revision: delivered.storageRevision,
        })),
        }, {}, COMPLETE_TIMEOUT_MS)
      } finally {
        release()
      }
    } finally {
      noteUploadGate("")
    }
  }, { ...first.request.retry, attempts: BUSY_RETRY_DEFAULTS.attempts, maxWaitMs: BUSY_RETRY_DEFAULTS.maxWaitMs, paceShortHints: true })
  batchShape(items.length, data?.objects?.length ?? 0)
  const completeMs = share(elapsedMs(startedAt), items.length)
  return items.map((item, index) => {
    const confirmed = data.objects[index]?.object
    if (!confirmed) return undefined
    const target = item.delivered.uploadTicket
      ? { ...grantOf(item), uploadTicket: item.delivered.uploadTicket }
      : grantOf(item)
    const bytes = item.delivered.timing?.bytes ?? item.request.byteLength ?? 0
    const accepted = acceptConfirmedUpload(item.request, target, bytes, confirmed)
    return { ...accepted, timing: { bytes, readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs } }
  })
}

function grantOf(item: { request: DeliverMediaObjectRequest, delivered: DeliveredMediaObject }): MediaObjectPresignData {
  const delivered = item.delivered
  if (!delivered.workspaceUuid || delivered.storageRevision == null || !delivered.uploadTicket) {
    throw invalidPresign("云端完成确认与直传对象不一致", "media_complete_mismatch")
  }
  return {
    transport: "direct",
    accountId: delivered.accountId,
    objectKey: delivered.objectKey,
    publicUrl: delivered.publicUrl,
    workspaceUuid: delivered.workspaceUuid,
    storageRevision: delivered.storageRevision,
    uploadTicket: delivered.uploadTicket,
    upload: item.request.issued?.upload,
  }
}

function keptBatch(reason: unknown): Error {
  const error = reason instanceof Error ? reason : invalidPresign("完成确认繁忙，本机保持整批，不拆成单张", "media_complete_kept_batch")
  return Object.assign(error, { code: "media_complete_kept_batch" })
}

/** Confirm every deferred PUT. Admission refusals stay on this batch; a single failed object falls back to `/complete`. Successes stay. */
export async function confirmSliceBatch(items: readonly { request: DeliverMediaObjectRequest, delivered: DeliveredMediaObject }[]): Promise<DeliveredMediaObject[]> {
  const out = items.map((item) => item.delivered)
  const pending = items.flatMap((item, index) => item.delivered.pendingConfirm ? [{ item, index }] : [])
  if (!pending.length) return out
  const plan = await planConfirm(pending.map((entry, index) => candidateOf(entry.item, index)))
  const admitted = new Set(plan.batch)
  const rejected = plan.items.find((item) => item.kind === "reject")
  const ready = pending.filter((_, index) => admitted.has(index))
  if (!ready.length) {
    if (rejected?.kind === "reject") throw invalidPresign(rejected.message, rejected.code)
    return out
  }
  const started = performance.now()
  let batchError: unknown
  try {
    for (let offset = 0; offset < ready.length; offset += MAX_OBJECTS) {
      const chunk = ready.slice(offset, offset + MAX_OBJECTS)
      const confirmed = await confirmChunk(chunk.map((entry) => entry.item), started)
      confirmed.forEach((delivered, index) => {
        if (delivered) out[chunk[index]!.index] = delivered
      })
    }
    if (ready.some((entry) => out[entry.index]?.pendingConfirm)) {
      batchError = invalidPresign("媒体直传未完成", "media_direct_failed")
    }
  } catch (reason) {
    batchError = reason
    if ((await planConfirmRetry(reason)).after === "keep_batch") throw keptBatch(reason)
  }
  if (!batchError) {
    if (rejected?.kind === "reject") throw invalidPresign(rejected.message, rejected.code)
    return out
  }
  for (const entry of ready) {
    if (!out[entry.index]?.pendingConfirm) continue
    const byteLength = entry.item.delivered.timing?.bytes ?? entry.item.request.byteLength
    if (byteLength == null) continue
    const oneStarted = performance.now()
    try {
      const delivered = await completeGrantedMedia(entry.item.request, grantOf(entry.item), byteLength)
      out[entry.index] = {
        ...delivered,
        timing: {
          bytes: entry.item.delivered.timing?.bytes ?? byteLength,
          readMs: 0, hashMs: 0, presignMs: 0, putMs: 0, completeMs: elapsedMs(oneStarted),
        },
      }
    } catch (reason) {
      batchError = reason
    }
  }
  if (out.some((item) => item.pendingConfirm)) throw batchError ?? invalidPresign("媒体直传未完成", "media_direct_failed")
  return out
}

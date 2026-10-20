/** Committed slices: bounded native transfer waves, durable receipts, and byte-free recovery. */
import { isBusyRefusal } from "@/api/busy-retry"
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import type { WorkflowImageLifecycle } from "@/bindings/commands"
import type { ListingRowView } from "@/bindings/listing-projection"
import { readListingRow } from "@/bindings/http-listing"
import { elapsedMs } from "@/lib/diag-log"
import { cancelledError } from "@/lib/error-message"
import { listingLog, noteListingRow } from "@/lib/listing-log"
import { discardPendingUploadBatch, isDirectMediaTransferFinal, prepareDirectMedia, reconcilePendingDirectMedia } from "../media/direct-media-transfer"
import { assertMediaWorkspace, currentMediaWorkspaceUuid, deliverMediaObject, MEDIA_UPLOAD_CONCURRENCY,
  rememberMediaObject, type DeliveredMediaObject, type DeliverMediaObjectRequest, type MediaUploadBatch } from "../media/media-objects"
import { mapLimit } from "../source-batch"
import { CONTROL_PLANE_TIMEOUT_MS, device, errorFields, type MediaExecution } from "./execution-context"
import { lookupBatchObject, lookupMediaObject } from "../media/direct-media-cache"
import { confirmSliceBatch, presignSliceBatch, shareSliceDelivery, SLICE_PUT_CONCURRENCY } from "./slice-batch-upload"
import { lookupSliceEncode } from "./slice-encode-memory"
import { openSliceResume } from "./slice-resume"
import { trackSliceRow } from "./upload-batch-meter"
import { uploadFailureMessage } from "@/bindings/upload-failure-copy"
import { addTransfer, logUploadRow, statForSlice, uploadEndFields, type SliceTransferStat } from "./upload-transfer-log"

export const UPLOAD_CONCURRENCY = MEDIA_UPLOAD_CONCURRENCY
export type MediaJobData = Omit<components["schemas"]["CompleteListingRowMediaData"], "row"> & { row?: ListingRowView | null }
/** Per-image receipt: compact on intermediate confirms, row only when the Job settles. */
type ConfirmImageData = Omit<components["schemas"]["ConfirmListingRowImageData"], "row"> & { row?: ListingRowView | null }

function isDelivered(value: unknown): value is DeliveredMediaObject {
  return Boolean(value && typeof value === "object" && "objectKey" in value && "via" in value)
}
export function digestOf(contentHash: string): string {
  return contentHash.startsWith("sha256:") ? contentHash.slice(7) : contentHash
}
export function rowImages(row: ListingRowView): WorkflowImageLifecycle[] {
  const media = row.media as { images?: WorkflowImageLifecycle[] } | null
  return Array.isArray(media?.images) ? media.images : []
}
export async function uploadMediaJob(
  row: ListingRowView,
  job: components["schemas"]["ListingRunView"],
  execution: MediaExecution,
  uploadBatch?: (rejectedBatch?: string) => Promise<MediaUploadBatch>,
): Promise<MediaJobData | null> {
  const pin = job.payload as { manifest_digest?: string, manifest?: { images?: WorkflowImageLifecycle[] } }
  if ((row.render_evidence as { manifest_digest?: string } | null)?.manifest_digest !== pin.manifest_digest || !pin.manifest?.images?.length) {
    throw Object.assign(new Error("切片清单已变化，请重新准备"), { code: "workflow_media_manifest_changed" })
  }
  const uploadStartedAt = performance.now()
  noteListingRow(row.id, { jobId: job.id })
  listingLog({ module: "upload", event: "upload.start", rowId: row.id })
  const images = rowImages(row)
  const workspaceUuid = currentMediaWorkspaceUuid()
  if (!workspaceUuid) {
    listingLog({ level: "error", module: "upload", event: "upload.end", rowId: row.id, errorCode: "workflow_workspace_missing" })
    throw Object.assign(new Error("当前没有可用的 Workspace"), { code: "workflow_workspace_missing" })
  }
  const pending = images.filter((image) => image.phase !== "public_ready")
  // A Store change can reset the media rail while retaining valid receipts.
  // Reconfirm those identities against the current immutable upload record.
  const work = pending.length ? pending : images
  const resume = await openSliceResume({
    workspaceUuid,
    rowId: row.id,
    manifestDigest: pin.manifest_digest ?? "",
  })
  execution.assertCurrent()
  assertMediaWorkspace(workspaceUuid)
  const meter = trackSliceRow(
    row.id,
    work.length,
    work.reduce((sum, image) => sum + (image.byte_size ?? 0), 0),
  )
  // Do not spend the four-hour batch TTL while a render/AI stage is waiting.
  // A saved batch keeps the same object keys, so a reload can confirm instead of PUT.
  let batch = resume.batch
  if (pending.length && !batch) {
    try {
      batch = await uploadBatch?.()
    } catch (reason) {
      meter.fail(uploadFailureMessage(reason))
      throw reason
    }
  }
  if (batch && resume.batch) resume.rememberBatch(batch)
  let coolingDown = false
  let confirmedCount = 0
  let bindMs = 0
  const receipts: ConfirmImageData[] = []
  const sliceStats: SliceTransferStat[] = []
  // One presign and one storage confirm for the row. PUTs stay per object, six at a time,
  // so a retry wait does not read the slices past this wave.
  try {
  type SliceSuccess = {
    image: WorkflowImageLifecycle
    request: DeliverMediaObjectRequest
    delivered: DeliveredMediaObject
    stat: SliceTransferStat
    confirmIndividually: () => Promise<ConfirmImageData | null>
    rememberConfirmation: (landed: ConfirmImageData) => ConfirmImageData
  }
  const successes: SliceSuccess[] = []
  const failures: { error: unknown }[] = []
  let interrupted = false
  const fresh: SliceSuccess["request"][] = []
  const freshPlans: { image: WorkflowImageLifecycle, request: DeliverMediaObjectRequest, encodeMs: number | undefined }[] = []
  const note = (image: WorkflowImageLifecycle, request: DeliverMediaObjectRequest, delivered: DeliveredMediaObject, encodeMs: number | undefined, viaLocal = false, transferredNow = false) => {
    const extension = request.extension
    const stat = statForSlice(image.index, image.byte_size, encodeMs, viaLocal ? { via: "local" } : delivered)
    sliceStats.push(stat)
    const confirm = async (object: { objectKey: string, accountId: string }) => {
      assertMediaWorkspace(workspaceUuid)
      const landed = await api.post<ConfirmImageData>(route("listingRowsByIdMediaImagesByIndex", { id: row.id, index: image.index }),
        { job_id: job.id, object_key: object.objectKey, account_id: object.accountId },
        CONTROL_PLANE_TIMEOUT_MS)
      assertMediaWorkspace(workspaceUuid)
      return landed
    }
    successes.push({
      image, request, delivered, stat,
      confirmIndividually: async () => {
        execution.assertCurrent()
        if (execution.stopped()) return null
        try { return await confirm(delivered) }
        catch (reason) {
          if (errorFields(reason).code !== "cloud_media_confirmation_required") throw reason
          if (execution.stopped()) return null
          if (!batch) batch = await uploadBatch?.()
          const { byteLength: _manifestLength, issued: _issued, deferComplete: _defer, ...confirmationRequest } = request
          const refreshed = await deliverMediaObject({
            ...confirmationRequest,
            ...(batch ? { uploadBatch: batch.uploadBatch } : {}),
            refreshConfirmation: true,
          })
          addTransfer(stat, refreshed)
          execution.assertCurrent()
          if (execution.stopped()) return null
          return confirm(refreshed)
        }
      },
      rememberConfirmation: (landed) => {
        assertMediaWorkspace(workspaceUuid)
        if (landed.public_url && landed.object_key && landed.account_id) {
          rememberMediaObject(
            {
              objectKey: landed.object_key,
              publicUrl: landed.public_url,
              accountId: landed.account_id,
              workspaceUuid,
              storageRevision: landed.storage_revision ?? delivered.storageRevision,
            },
            digestOf(image.content_hash),
            extension,
            Date.now(),
            { workspaceUuid, ...(batch ? { uploadBatch: batch.uploadBatch } : {}) },
          )
        }
        confirmedCount += 1
        return landed
      },
    })
    resume.rememberObject(request.digest, extension, image.byte_size ?? delivered.timing?.bytes ?? 0, delivered, batch)
    meter.objectDone(image.byte_size ?? 0, transferredNow)
  }
  for (const image of work) {
    if (coolingDown || execution.stopped()) { interrupted = true; break }
    try {
      execution.assertCurrent()
      const expected = pin.manifest!.images![image.index]
      if (expected?.content_hash !== image.content_hash || expected.file_name !== image.file_name) {
        throw Object.assign(new Error("切片不属于当前清单"), { code: "workflow_media_manifest_changed" })
      }
      const extension = image.file_name.toLowerCase().endsWith(".png") ? "png" : "jpg"
      const request: DeliverMediaObjectRequest = {
        digest: digestOf(image.content_hash), extension, contentType: extension === "png" ? "image/png" : "image/jpeg",
        byteLength: image.byte_size,
        workspaceUuid,
        ...(batch ? { uploadBatch: batch.uploadBatch } : {}),
        bytes: async () => {
          if (execution.stopped()) throw cancelledError()
          const bytes = await device.getRender(row.id, image.file_name)
          if (!bytes) throw Object.assign(new Error("本机缺少待上传切片，请重新导入源图后点击切片，再上传"), { code: "workflow_render_missing" })
          return bytes
        },
        retry: {
          attempts: 1,
          cancelled: () => execution.stopped() || currentMediaWorkspaceUuid() !== workspaceUuid,
          onWait: ({ status, delayMs }: { status: number; delayMs: number }) => {
            execution.feedback?.("waiting", "等待媒体存储恢复容量", { queue: "media_upload", status, delay: delayMs })
          },
        },
      }
      const existing = image.phase === "public_ready" && image.object_key && image.account_id
        ? { objectKey: image.object_key, accountId: image.account_id, publicUrl: image.public_url ?? "", workspaceUuid } : undefined
      const encodeMs = lookupSliceEncode(image.content_hash)
      const resumed = resume.delivery(request.digest, extension)
      if (resumed) {
        note(image, request, resumed, encodeMs, resumed.via === "local")
        continue
      }
      if (existing) {
        note(image, request, { ...existing, via: "local" }, encodeMs, true)
        continue
      }
      const cached = request.uploadBatch
        ? lookupBatchObject(request.uploadBatch, workspaceUuid, extension, request.digest)
        : lookupMediaObject(request.digest, extension)
      if (cached) {
        note(image, request, cached, encodeMs)
        continue
      }
      const prior = await reconcilePendingDirectMedia(request)
      if (prior) {
        note(image, request, prior, encodeMs)
        continue
      }
      fresh.push(request)
      freshPlans.push({ image, request, encodeMs })
    } catch (error) {
      if (isBusyRefusal(error)) coolingDown = true
      failures.push({ error })
    }
  }
  let grants: Awaited<ReturnType<typeof presignSliceBatch>>["grants"] = []
  let presignShare = 0
  const blocked = coolingDown || interrupted || failures.some((item) => isDirectMediaTransferFinal(item.error))
  if (freshPlans.length === 1 && !blocked) {
    const plan = freshPlans[0]!
    try {
      const landed = await shareSliceDelivery(plan.request, async () => {
        const timed = await presignSliceBatch([plan.request])
        const issued = { ...plan.request, issued: timed.grants[0], deferComplete: true as const }
        const delivered = await prepareDirectMedia(issued)
        if (delivered.timing) delivered.timing.presignMs += timed.presignMs
        if (!delivered.pendingConfirm) return delivered
        const [confirmed] = await confirmSliceBatch([{ request: issued, delivered }])
        if (!confirmed) return delivered
        return {
          ...confirmed,
          checksum: confirmed.checksum ?? delivered.checksum,
          timing: delivered.timing
            ? { ...delivered.timing, completeMs: delivered.timing.completeMs + (confirmed.timing?.completeMs ?? 0) }
            : confirmed.timing,
        }
      })
      note(plan.image, plan.request, landed, plan.encodeMs, false, landed.via === "put")
    } catch (error) {
      if (isBusyRefusal(error)) coolingDown = true
      failures.push({ error })
    }
  } else if (fresh.length && !blocked) {
    try {
      const timed = await presignSliceBatch(fresh)
      grants = timed.grants
      presignShare = fresh.length ? Math.round(timed.presignMs / fresh.length) : 0
    } catch (error) {
      if (isBusyRefusal(error)) coolingDown = true
      failures.push({ error })
    }
  }
  if (grants.length === fresh.length && fresh.length && !coolingDown && !interrupted) {
    let halt = false
    for (let offset = 0; offset < freshPlans.length && !halt && !coolingDown && !interrupted; offset += SLICE_PUT_CONCURRENCY) {
      execution.feedback?.("running", `正在上传切片 (${work.length} 张)`)
      const wave = freshPlans.slice(offset, offset + SLICE_PUT_CONCURRENCY)
      const results = await mapLimit(wave, SLICE_PUT_CONCURRENCY, async (plan, index) => {
        if (coolingDown || execution.stopped()) return null
        try {
          execution.assertCurrent()
          const landed = await prepareDirectMedia({
            ...plan.request,
            issued: grants[offset + index],
            deferComplete: true,
          })
          if (landed.timing) landed.timing.presignMs += presignShare
          return landed
        } catch (error) {
          if (isBusyRefusal(error)) coolingDown = true
          return error
        }
      })
      results.forEach((result, index) => {
        const plan = wave[index]!
        if (isDelivered(result)) {
          note(plan.image, { ...plan.request, issued: grants[offset + index] }, result, plan.encodeMs, false, result.via === "put")
        } else if (result == null) interrupted = true
        else failures.push({ error: result })
      })
      if (failures.length) halt = true
    }
  }
  const deferred = successes.filter((item) => item.delivered.pendingConfirm)
  if (deferred.length && !execution.stopped()) {
    try {
      const confirmed = await confirmSliceBatch(deferred.map((item) => ({ request: item.request, delivered: item.delivered })))
      confirmed.forEach((delivered, index) => {
        const success = deferred[index]!
        success.stat.completeMs += delivered.timing?.completeMs ?? 0
        if (delivered.checksum) success.stat.checksum = delivered.checksum
        success.delivered = { ...delivered, timing: success.delivered.timing
          ? { ...success.delivered.timing, completeMs: success.delivered.timing.completeMs + (delivered.timing?.completeMs ?? 0) }
          : delivered.timing }
        resume.rememberObject(
          success.request.digest,
          success.request.extension,
          success.image.byte_size ?? delivered.timing?.bytes ?? 0,
          success.delivered,
          batch,
        )
      })
    } catch (error) {
      failures.push({ error })
    }
  }
  const successful = successes.filter((item) => !item.delivered.pendingConfirm)
    .sort((left, right) => left.image.index - right.image.index)
  if (successful.length && !execution.stopped()) {
      execution.assertCurrent()
      assertMediaWorkspace(workspaceUuid)
      const bindStarted = performance.now()
      try {
        const response = await api.post<components["schemas"]["ConfirmListingRowImagesResponse"]>(route("listingRowsByIdMediaImages", { id: row.id }), {
          job_id: job.id,
          images: successful.map(({ image, delivered }) => ({
            index: image.index, object_key: delivered.objectKey, account_id: delivered.accountId,
          })),
        }, CONTROL_PLANE_TIMEOUT_MS)
        assertMediaWorkspace(workspaceUuid)
        const landed = response?.items
        if (!Array.isArray(landed) || landed.length !== successful.length
          || landed.some((receipt, index) => receipt.index !== successful[index]!.image.index)) {
          throw Object.assign(new Error("图片确认回执与切片清单不一致"), { code: "workflow_media_confirmation_mismatch" })
        }
        receipts.push(...landed.map((receipt, index) => successful[index]!.rememberConfirmation(receipt as ConfirmImageData)))
      } catch (reason) {
        if (errorFields(reason).code !== "cloud_media_confirmation_required") {
          // A receipt-binding refusal must not hide an exhausted transfer and
          // accidentally let the outer busy/stage retry replenish its PUT budget.
          failures.push({ error: reason })
        } else {
          // Old cached proofs are rare: isolate their recovery through the existing
          // per-image endpoint so valid objects still keep their durable receipts.
          await mapLimit(successful, UPLOAD_CONCURRENCY, async result => {
            try {
              const landed = await result.confirmIndividually()
              if (landed) receipts.push(result.rememberConfirmation(landed))
              else interrupted = true
            } catch (error) { failures.push({ error }) }
          })
        }
      } finally {
        bindMs += elapsedMs(bindStarted)
      }
    }
    const failure = failures.find(result => isDirectMediaTransferFinal(result.error))
      ?? failures.find(result => !isBusyRefusal(result.error)) ?? failures.sort((a, b) =>
      ((b.error as { retryAfterMs?: number }).retryAfterMs ?? 0) - ((a.error as { retryAfterMs?: number }).retryAfterMs ?? 0))[0]
    if (failure) {
      const batchRejected = errorFields(failure.error).code === "cloud_media_upload_batch_invalid"
      if (batchRejected && batch && uploadBatch && !execution.stopped()) {
        execution.assertCurrent()
        assertMediaWorkspace(workspaceUuid)
        await uploadBatch(batch.uploadBatch)
        assertMediaWorkspace(workspaceUuid)
        discardPendingUploadBatch(workspaceUuid, batch.uploadBatch)
        await resume.clear()
      }
      // Exhausted direct recovery is final. Only rejected batch authorization
      // can replan using retained bytes and the existing bounded stage budget.
      if (isDirectMediaTransferFinal(failure.error) && !batchRejected) Object.assign(failure.error as object, { terminalJob: true })
      const message = uploadFailureMessage(failure.error)
      if (failure.error instanceof Error) failure.error.message = message
      listingLog({
        level: "error", module: "upload", event: "upload.end", rowId: row.id,
        durationMs: performance.now() - uploadStartedAt,
        errorCode: errorFields(failure.error).code ?? "upload_failed",
        errorMessage: message,
        fields: uploadEndFields(sliceStats),
      })
      meter.fail(message)
      throw failure.error instanceof Error ? failure.error : Object.assign(new Error(message), failure.error)
    }
    if (interrupted || execution.stopped()) return null
  // Only the settling (or replayed) receipt carries the row projection.
  // Partial receipts share its view revision; prefer the full row on a tie.
  const landed = receipts
    .sort((a, b) => (b.row?.view_revision ?? b.view_revision ?? 0) - (a.row?.view_revision ?? a.view_revision ?? 0)
      || Number(Boolean(b.row)) - Number(Boolean(a.row)))[0]
  const current = landed?.row ?? await readListingRow(row.id)
  if (landed?.media_state === "ready" || current.media_state === "ready") {
    await resume.clear()
    await device.dropRender(row.id, { jobId: job.id }).catch(() => undefined)
  }
  return { applied: landed?.applied ?? true, row: current, jobs: [] }
  } finally {
    meter.done()
    // A stop or a failure before any delivery already has its own error line.
    if (sliceStats.length > 0) {
      logUploadRow({
        rowId: row.id,
        startedAt: uploadStartedAt,
        endedAt: performance.now(),
        bindMs,
        slices: sliceStats,
      }, execution.uploadAccount)
      if (confirmedCount > 0) {
        execution.feedback?.("running", `已确认上传 ${confirmedCount}/${work.length}`)
      }
    }
  }
}

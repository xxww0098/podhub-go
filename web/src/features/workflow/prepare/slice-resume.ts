/**
 * Which slice objects can continue after a reload, and which batch token
 * still names the same keys. Confirmed objects bind again. A finished PUT
 * confirms again while its batch token is still inside the server window.
 */
import type { DeliveredMediaObject, MediaUploadBatch } from "../media/direct-media-types"
import {
  deleteResume, readResume, sliceResumeId, writeResume,
  type ResumeObject, type UploadResumeRecord,
} from "@/bindings/upload-resume-store"

const BATCH_SKEW_MS = 60_000

export function batchStillValid(record: Pick<UploadResumeRecord, "uploadBatch" | "batchExpiresAt"> | null, now = Date.now()): boolean {
  if (!record?.uploadBatch || !record.batchExpiresAt) return false
  const expires = Date.parse(record.batchExpiresAt)
  return Number.isFinite(expires) && expires > now + BATCH_SKEW_MS
}

export function resumedDelivery(
  object: ResumeObject | undefined,
  batchValid: boolean,
): DeliveredMediaObject | undefined {
  if (!object?.objectKey || !object.accountId) return undefined
  if (object.confirmed) {
    return {
      objectKey: object.objectKey,
      accountId: object.accountId,
      publicUrl: object.publicUrl ?? "",
      workspaceUuid: object.workspaceUuid,
      storageRevision: object.storageRevision,
      via: "local",
      uploadTicket: object.uploadTicket,
    }
  }
  if (!batchValid || !object.putDone || !object.uploadTicket || !object.workspaceUuid || object.storageRevision == null) {
    return undefined
  }
  return {
    objectKey: object.objectKey,
    accountId: object.accountId,
    publicUrl: object.publicUrl ?? "",
    workspaceUuid: object.workspaceUuid,
    storageRevision: object.storageRevision,
    via: "put",
    pendingConfirm: true,
    uploadTicket: object.uploadTicket,
  }
}

export type SliceResume = {
  batch?: MediaUploadBatch
  delivery(digest: string, extension: string): DeliveredMediaObject | undefined
  rememberBatch(batch: MediaUploadBatch): void
  rememberObject(
    digest: string,
    extension: string,
    byteLength: number,
    delivered: DeliveredMediaObject,
    batch?: MediaUploadBatch,
  ): void
  clear(): Promise<void>
}

export async function openSliceResume(input: {
  workspaceUuid: string
  rowId: string
  manifestDigest: string
}): Promise<SliceResume> {
  const id = input.manifestDigest
    ? sliceResumeId(input.workspaceUuid, input.rowId, input.manifestDigest)
    : ""
  const saved = id ? await readResume(id) : null
  const valid = batchStillValid(saved)
  const needsSameBatch = Boolean(saved?.objects.some((object) => resumedDelivery(object, valid)?.pendingConfirm))
  let record: UploadResumeRecord | null = saved
  const persist = () => {
    if (!id || !record) return
    void writeResume(record)
  }
  return {
    batch: needsSameBatch && saved?.uploadBatch && saved.batchExpiresAt
      ? { uploadBatch: saved.uploadBatch, expiresAt: saved.batchExpiresAt }
      : undefined,
    delivery(digest, extension) {
      const object = record?.objects.find((item) =>
        item.digest === digest.toLowerCase() && item.extension === extension.toLowerCase())
      return resumedDelivery(object, batchStillValid(record))
    },
    rememberBatch(batch) {
      if (!id) return
      record = {
        id,
        kind: "slice",
        sha256: input.manifestDigest.toLowerCase(),
        rowId: input.rowId,
        workspaceUuid: input.workspaceUuid,
        fileName: "",
        byteLength: record?.byteLength ?? 0,
        updatedAt: Date.now(),
        completedParts: [],
        objects: record?.objects ?? [],
        uploadBatch: batch.uploadBatch,
        batchExpiresAt: batch.expiresAt,
      }
      persist()
    },
    rememberObject(digest, extension, byteLength, delivered, batch?: MediaUploadBatch) {
      if (!id || !delivered.objectKey || !delivered.accountId) return
      const next: ResumeObject = {
        digest: digest.toLowerCase(),
        extension: extension.toLowerCase(),
        byteLength,
        objectKey: delivered.objectKey,
        accountId: delivered.accountId,
        uploadTicket: delivered.uploadTicket,
        publicUrl: delivered.publicUrl,
        workspaceUuid: delivered.workspaceUuid,
        storageRevision: delivered.storageRevision,
        putDone: true,
        confirmed: delivered.pendingConfirm !== true,
      }
      const objects = (record?.objects ?? []).filter((item) =>
        !(item.digest === next.digest && item.extension === next.extension))
      objects.push(next)
      record = {
        id,
        kind: "slice",
        sha256: input.manifestDigest.toLowerCase(),
        rowId: input.rowId,
        workspaceUuid: input.workspaceUuid,
        fileName: "",
        byteLength: objects.reduce((sum, item) => sum + item.byteLength, 0),
        updatedAt: Date.now(),
        completedParts: [],
        objects,
        uploadBatch: batch?.uploadBatch ?? record?.uploadBatch,
        batchExpiresAt: batch?.expiresAt ?? record?.batchExpiresAt,
      }
      persist()
    },
    clear() {
      record = null
      return id ? deleteResume(id) : Promise.resolve()
    },
  }
}

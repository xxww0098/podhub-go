import type { BusyRetryOptions } from "@/api/busy-retry"
import type { DirectUploadGrant } from "@/bindings/direct-upload"

export interface MediaDeliveryScope { workspaceUuid: string; uploadBatch?: string }
export interface MediaUploadBatch { uploadBatch: string; expiresAt: string }
export interface CloudAnswer {
  objectKey: string; publicUrl: string; accountId: string
  workspaceUuid?: string; storageRevision?: number
}
export interface MediaObjectTarget extends CloudAnswer { workspaceUuid: string; storageRevision: number }
export interface MediaObjectPresignData extends MediaObjectTarget {
  transport: "ready" | "direct"; upload?: DirectUploadGrant; uploadTicket?: string; uploadBatch?: string
}
export interface MediaObjectCompleteData extends MediaObjectTarget {
  transport: "ready"
  byteLength: number
  deduplicated: boolean
  /** Confirm trusted the store checksum and skipped hashing the body. */
  checksumTrusted?: boolean
}
/** Wall time of one direct delivery. Retries add; a thrown attempt still counts. */
export interface MediaTransferTiming {
  bytes: number
  readMs: number
  hashMs: number
  presignMs: number
  putMs: number
  completeMs: number
}
export interface DeliveredMediaObject {
  publicUrl: string
  objectKey: string
  accountId: string
  workspaceUuid?: string
  storageRevision?: number
  /** Local authenticated confirmation mirror, recovery probe, or receipt-confirmed upload. */
  via: "local" | "probe" | "ready" | "put"
  /** Present when this call measured a presign, PUT, or storage confirm. Cache hits omit it. */
  timing?: MediaTransferTiming
  /**
   * `trusted`: confirm used the store's full-object SHA-256.
   * `signed`: the PUT covered `x-amz-checksum-sha256` and confirm still hashed.
   * Omitted when this delivery did not opt into a store checksum.
   */
  checksum?: "trusted" | "signed"
  /** Storage confirm is owned by a row-level complete-batch. Not a ready object yet. */
  pendingConfirm?: boolean
  uploadTicket?: string
}

export interface DeliverMediaObjectRequest {
  /** Lowercase SHA-256 of the bytes. */
  digest: string
  /** `jpg`, `png`, `mp4` or `mov` — Cloud normalises. */
  extension: string
  contentType: string
  /** Known encoded size from the rendered manifest. Missing means read once before presign. */
  byteLength?: number
  /** Read only when the bytes have to travel, so a hit never touches them. */
  bytes: () => Uint8Array<ArrayBuffer> | Promise<Uint8Array<ArrayBuffer>>
  /** Captured when a workflow starts; prevents a later active-Workspace drift. */
  workspaceUuid?: string
  /** API-issued directory for this upload run. */
  uploadBatch?: string
  retry?: BusyRetryOptions
  /** Cloud rejected a cached proof: recheck public presence before asking for bytes. */
  refreshConfirmation?: boolean
  /** Row presign-batch already issued this grant. Skips the single-object presign. */
  issued?: MediaObjectPresignData
  /** Happy-path storage confirm is a later complete-batch. Uncertain PUTs still confirm here. */
  deferComplete?: boolean
}


/** Workflow media delivery and session-scoped singleflight. */
import { request as apiRequest } from "@/api/client"
import { retryWhenBusy } from "@/api/busy-retry"
import { route } from "@/api/routes"
import { onSessionSweep } from "@/lib/query-client"
import { activeWorkspaceUuid, batchExpiresAt, localKey, lookupBatchObject, lookupMediaObject, mediaObjectClass,
  forgetCachedObject, readyMediaObjects, rememberMediaObject, forgetMediaObjects as clearCache } from "./direct-media-cache"
import { clearResumes } from "@/bindings/upload-resume-store"
import { assertDeliveryCurrent, clearPendingDirectMedia, invalidPresign, prepareDirectMedia, scopedRetry } from "./direct-media-transfer"
import type { CloudAnswer, DeliverMediaObjectRequest, DeliveredMediaObject, MediaUploadBatch } from "./direct-media-types"

export type { DeliverMediaObjectRequest, DeliveredMediaObject, MediaUploadBatch } from "./direct-media-types"
export { MEDIA_UPLOAD_CONCURRENCY } from "./direct-media-budget"
export { activeWorkspaceUuid as currentMediaWorkspaceUuid } from "./direct-media-cache"
export function assertMediaWorkspace(workspaceUuid: string): void {
  if (!workspaceUuid || activeWorkspaceUuid() !== workspaceUuid) {
    throw invalidPresign("Workspace 已切换，请重新准备当前商品", "workflow_workspace_changed")
  }
}
export { LOCAL_TTL_MS, LOCAL_CAPACITY, STORAGE_KEY, rememberMediaObject,
  lookupMediaObject, flushMediaObjects, reloadMediaObjects } from "./direct-media-cache"
const inFlight = new Map<string, Promise<DeliveredMediaObject>>()
export function forgetMediaObjects(): void {
  clearCache()
  inFlight.clear()
  clearPendingDirectMedia()
  void clearResumes()
}
onSessionSweep(forgetMediaObjects)

export async function createMediaUploadBatch(workspaceUuid: string): Promise<MediaUploadBatch> {
  if (!workspaceUuid || activeWorkspaceUuid() !== workspaceUuid) throw workspaceMissingError()
  const wire = await apiRequest<{ upload_batch?: unknown, expires_at?: unknown }>("POST", route("mediaUploadBatches"), { workspace_uuid: workspaceUuid }, {}, 35_000)
  if (!wire || typeof wire.upload_batch !== "string" || !wire.upload_batch
    || typeof wire.expires_at !== "string" || !Number.isFinite(Date.parse(wire.expires_at))) {
    throw invalidPresign("云端上传目录格式无效", "media_upload_batch_invalid")
  }
  if (activeWorkspaceUuid() !== workspaceUuid) throw invalidPresign("Workspace 已切换", "workflow_workspace_changed")
  batchExpiresAt.set(wire.upload_batch, Date.parse(wire.expires_at))
  return { uploadBatch: wire.upload_batch, expiresAt: wire.expires_at }
}
function workspaceMissingError(): Error { return invalidPresign("当前没有可用的 Workspace", "workflow_workspace_missing") }
export function deliverMediaObject(request: DeliverMediaObjectRequest): Promise<DeliveredMediaObject> {
  const workspace = request.workspaceUuid ?? activeWorkspaceUuid()
  if (!workspace) return Promise.reject(workspaceMissingError())
  const scoped = request.workspaceUuid === workspace ? request : { ...request, workspaceUuid: workspace }
  try { assertDeliveryCurrent(scoped) } catch (reason) { return Promise.reject(reason) }
  if (scoped.refreshConfirmation) forgetCachedObject(workspace, scoped.extension, scoped.digest, scoped.uploadBatch)
  const cached = scoped.refreshConfirmation ? undefined : scoped.uploadBatch
    ? lookupBatchObject(scoped.uploadBatch, workspace, scoped.extension, scoped.digest)
    : lookupMediaObject(scoped.digest, scoped.extension)
  if (cached) return Promise.resolve(cached)
  const key = `${localKey(workspace, scoped.extension, scoped.digest)}|batch:${scoped.uploadBatch ?? "legacy"}`
  const existing = inFlight.get(key)
  if (existing) return existing.catch((reason: unknown) => {
    if ((reason as { code?: string })?.code === "workflow_cancelled" && !scoped.retry?.cancelled?.()) return deliverMediaObject(scoped)
    throw reason
  })
  const flight = prepare(scoped).finally(() => { inFlight.delete(key) })
  inFlight.set(key, flight)
  return flight
}
async function prepare(request: DeliverMediaObjectRequest): Promise<DeliveredMediaObject> {
  assertDeliveryCurrent(request)
  await readyMediaObjects()
  assertDeliveryCurrent(request)
  if (!request.refreshConfirmation && !request.uploadBatch) {
    const cached = lookupMediaObject(request.digest, request.extension)
    if (cached) return cached
  }
  // Existing rendered image recovery without a local byte source stays byte-free.
  // Probe/HEAD remains metadata-confirmed only; NEW image/video uploads always use receipts.
  if (request.refreshConfirmation && request.byteLength == null && mediaObjectClass(request.extension) === "images") {
    const answer = await retryWhenBusy(() => {
      assertDeliveryCurrent(request)
      return apiRequest<{ account_id?: unknown, object_key?: unknown, public_url?: unknown, workspace_uuid?: unknown, exists?: unknown }>("POST", route("mediaObjectsByDigestByExtensionProbe", {
        digest: request.digest.toLowerCase(), extension: request.extension.toLowerCase(),
      }), undefined, {}, 35_000)
    }, scopedRetry(request))
    assertDeliveryCurrent(request)
    if (answer.exists === true && typeof answer.account_id === "string" && typeof answer.object_key === "string" && typeof answer.public_url === "string") {
      const found: CloudAnswer & { exists: boolean } = { accountId: answer.account_id, objectKey: answer.object_key,
        publicUrl: answer.public_url, workspaceUuid: typeof answer.workspace_uuid === "string" ? answer.workspace_uuid : request.workspaceUuid, exists: true }
      rememberMediaObject(found, request.digest, request.extension, Date.now(), { workspaceUuid: request.workspaceUuid! })
      return { ...found, workspaceUuid: found.workspaceUuid ?? request.workspaceUuid, via: "probe" }
    }
  }
  return prepareDirectMedia(request)
}

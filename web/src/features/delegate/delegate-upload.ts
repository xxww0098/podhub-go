/** Delegate originals: streamed hash -> restricted anonymous PUT -> authenticated confirmation.
 * An uncertain PUT is never retransmitted until Cloud explicitly proves object missing.
 */
import { request } from "@/api/client"
import { route } from "@/api/routes"
import { hashUploadBody } from "@/bindings/direct-upload"
import { reportError } from "@/lib/diag-log"
import { onSessionInvalidated } from "@/lib/session-cache"
import { spaDeviceId } from "@/lib/spa-device-id"
import { assetContentType } from "./delegate-model"
import { delegateHttp, type DelegateAssetView } from "./delegate-http"

/** `billing.object-upload-usage.v1` 的 payload（服务端 fail-closed 白名单）。 */
export type ObjectUploadUsagePayload = {
  schemaVersion: 1
  bytes: number
  occurredAt: string
  objectKey: string
  contentHash: string
  outcome: "uploaded"
}

const USAGE_KIND = "billing.object-upload-usage.v1"
export type UsagePost = (
  path: string,
  body: unknown,
  deviceId: string,
) => Promise<unknown>

function defaultUsagePost(path: string, body: unknown, deviceId: string): Promise<unknown> {
  return request("POST", path, body, { "X-Podhub-Device-Id": deviceId })
}

/** 一次成功上传的流量上报。失败被吞进诊断日志——旁路不打断主流程。 */
export async function reportUploadUsage(
  payload: ObjectUploadUsagePayload,
  post: UsagePost = defaultUsagePost,
  deviceId: () => string = spaDeviceId,
): Promise<void> {
  try {
    await post(
      route("eventsInbox"),
      {
        events: [
          {
            id: `asset-upload-${payload.contentHash}-${payload.bytes}`,
            kind: USAGE_KIND,
            schema_version: 1,
            payload_json: JSON.stringify(payload),
          },
        ],
      },
      deviceId(),
    )
  } catch (reason) {
    reportError("[delegate-upload]", reason, { kind: "usage-report" })
  }
}

export type UploadAssetDeps = {
  presign: typeof delegateHttp.presignAsset
  putObject: typeof delegateHttp.putAssetObject
  finalize: typeof delegateHttp.finalizeAsset
  report?: typeof reportUploadUsage
  now?: () => Date
  /** Test seam for the bounded retry delay, not a second retry policy. */
  wait?: (ms: number, signal: AbortSignal) => Promise<void>
}

export type UploadAssetInput = {
  binding_id: string
  file: File
  position?: number
  signal?: AbortSignal
  /** Optional native caller fence in addition to the actor/workspace invalidation fence. */
  isCurrent?: () => boolean
  onProgress?: (loaded: number, total: number) => void
}

type Refusal = { code?: string; status?: number; outcomeUnknown?: boolean; retryAfterMs?: number }
function refusal(reason: unknown): Refusal {
  return typeof reason === "object" && reason !== null ? reason as Refusal : {}
}
function retryable(reason: unknown): boolean {
  const error = refusal(reason)
  return error.outcomeUnknown === true || error.code === "cloud_unavailable" || error.code === "cloud_bad_response"
    || error.status === 408 || error.status === 429 || (error.status !== undefined && error.status >= 500)
}
function cancelled(): Error {
  return Object.assign(new Error("上传已取消或登录/工作空间已变化"), { code: "upload_cancelled" })
}
function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(cancelled()); return }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(cancelled()) }
    signal.addEventListener("abort", abort, { once: true })
  })
}

/** Three retries total across grant/PUT/confirmation, and at most one 403 grant renewal. */
export async function uploadDelegateAsset(deps: UploadAssetDeps, input: UploadAssetInput): Promise<DelegateAssetView> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const unregister = onSessionInvalidated(abort)
  input.signal?.addEventListener("abort", abort, { once: true })
  if (input.signal?.aborted) abort()
  const signal = controller.signal
  const guard = () => {
    if (signal.aborted || input.isCurrent?.() === false) { abort(); throw cancelled() }
  }
  let retries = 0
  let renewed = false
  const retry = async (reason: unknown) => {
    guard()
    if (retries >= 3) throw reason
    const after = refusal(reason).retryAfterMs
    // A long admission delay is not permission for an unbounded upload wait.
    if (after !== undefined && after > 30_000) throw reason
    const delay = Math.max(after ?? 0, 250 * 2 ** retries++)
    await (deps.wait ?? waitForRetry)(delay, signal)
    guard()
  }
  try {
    guard()
    const contentHash = await hashUploadBody(input.file, signal).catch((reason: unknown) => { guard(); throw reason })
    guard()
    const spec = { binding_id: input.binding_id, bytes: input.file.size, mime: assetContentType(input.file),
      file_name: input.file.name, sha256: contentHash }
    const grant = async () => {
      for (;;) {
        guard()
        try {
          const target = await deps.presign(spec, signal)
          guard()
          return target
        } catch (reason) {
          guard()
          if (!retryable(reason)) throw reason
          await retry(reason)
        }
      }
    }
    let target = await grant()
    let put = true
    let putError: unknown
    let transmitted = false
    for (;;) {
      guard()
      if (put) {
        putError = undefined
        try {
          await deps.putObject(target, input.file, { signal, onProgress: (loaded, total) => {
            if (signal.aborted || input.isCurrent?.() === false) return
            if (loaded > 0) transmitted = true
            input.onProgress?.(loaded, total)
          } })
        } catch (reason) {
          // Even network loss or 403 may follow a committed object: confirm first.
          putError = reason
        }
        guard()
        put = false
      }
      try {
        const asset = await deps.finalize({ binding_id: input.binding_id, upload_ticket: target.upload_ticket,
          file_name: input.file.name, position: input.position }, signal)
        guard()
        // 412 without an actual byte step is a replay, not billable upload traffic.
        if (transmitted) {
          await (deps.report ?? reportUploadUsage)({ schemaVersion: 1, bytes: input.file.size,
            occurredAt: (deps.now ?? (() => new Date()))().toISOString(), objectKey: target.object_key,
            contentHash, outcome: "uploaded" }).catch(() => undefined)
          guard()
        }
        return asset
      } catch (reason) {
        guard()
        if (refusal(reason).code !== "cloud_media_complete_missing") {
          if (!retryable(reason)) throw reason
          // Lost confirmation response replays the same ticket; never replay bytes.
          await retry(reason)
          continue
        }
        const status = refusal(putError).status
        if (status === 403) {
          if (renewed) throw putError
          renewed = true
          await retry(putError)
          target = await grant()
        } else {
          if (putError !== undefined && !retryable(putError)) throw putError
          await retry(putError ?? reason)
        }
        put = true
      }
    }
  } finally {
    unregister()
    input.signal?.removeEventListener("abort", abort)
  }
}

/** OCR-only private ingress; it never sends bytes to Cloud or URLs to the provider. */
import { request } from "@/api/client"
import type { components } from "@/api/schema"
import { route } from "@/api/routes"
import { hashUploadBody, putDirectUpload, type DirectUploadGrant } from "@/bindings/direct-upload"
import { cancelledError } from "@/lib/error-message"
import { stopAwareSleep, untilStopped, type BrowserExecution } from "./execution-context"

export const OCR_MAX_IMAGE_BYTES = 1_400_000
const UPLOADS = route("aiOcrUploads")
const CONFIRM = route("aiOcrUploadsConfirm")
const ATTEMPTS = 3
const STEP_TIMEOUT_MS = 25_000
export type PreparedOcrImage = { bytes: Uint8Array; mimeType: "image/png" | "image/jpeg" }
type Spec = { bytes: number; sha256: string; content_type: string }
type Target = components["schemas"]["DirectUploadTarget"]
export type OcrPurchaseBody = { uploadTicket: string }
export type OcrUploadBudget = { grants: number; puts: number; confirms: number }

/** Kept as the explicit firstparty body builder: no Chat Completions/base64 ingress. */
export function analyzeImageBody(uploadTicket: string): OcrPurchaseBody { return { uploadTicket } }

export function prepareOcrImage(bytes: Uint8Array): PreparedOcrImage {
  if (bytes.byteLength === 0 || bytes.byteLength > OCR_MAX_IMAGE_BYTES) {
    throw Object.assign(new Error("识图图片超过大小上限，请更换更小的源图后重新准备"), { code: "workflow_ocr_body_too_large" })
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, i) => bytes[i] === byte)
  return { bytes, mimeType: png ? "image/png" : "image/jpeg" }
}
function code(reason: unknown): string { return String((reason as { serverCode?: string; code?: string })?.serverCode ?? (reason as { code?: string })?.code ?? "").toUpperCase() }
export function isOcrImageMissing(reason: unknown): boolean { return ["MEDIA_COMPLETE_MISSING", "CLOUD_MEDIA_COMPLETE_MISSING"].includes(code(reason)) }
function transient(reason: unknown): boolean {
  const status = (reason as { status?: number })?.status
  return ["CLOUD_UNAVAILABLE", "UNAVAILABLE"].includes(code(reason)) || status === 429 || status === 503 || status === 500 || status === 502 || status === 504
}

/** Each step is bounded, and every uncertain PUT is confirmed before another PUT. */
export async function stageOcrImage(image: PreparedOcrImage, headers: Record<string, string>, options: {
  signal?: AbortSignal; stopped?: () => boolean; assertCurrent?: () => void; cardId?: string; budget?: OcrUploadBudget
} = {}): Promise<OcrPurchaseBody> {
  const assert = () => { options.assertCurrent?.(); if (options.signal?.aborted || options.stopped?.()) throw cancelledError() }
  const post = <T>(path: string, body: unknown) => request<T>("POST", path, body, headers, STEP_TIMEOUT_MS, undefined, {
    callerSignal: options.signal, reportOwner: "caller",
  })
  const step = async <T>(run: () => Promise<T>): Promise<T> => {
    for (let attempt = 1; ; attempt++) {
      assert()
      try { const result = await run(); assert(); return result }
      catch (reason) {
        assert()
        if (attempt >= ATTEMPTS || !transient(reason)) throw reason
        await stopAwareSleep(100 * 2 ** (attempt - 1), () => Boolean(options.signal?.aborted || options.stopped?.()))
      }
    }
  }
  assert()
  prepareOcrImage(image.bytes)
  const spec: Spec = { bytes: image.bytes.byteLength, sha256: await hashUploadBody(image.bytes, options.signal), content_type: image.mimeType }
  const card = options.cardId ? { card_id: options.cardId } : {}
  const budget = options.budget ?? { grants: 0, puts: 0, confirms: 0 }
  const grant = () => step(() => {
    if (++budget.grants > ATTEMPTS) throw Object.assign(new Error("识图上传授权重试次数已达上限"), { code: "workflow_ocr_upload_unconfirmed" })
    return post<Target>(UPLOADS, { ...card, image: spec })
  })
  let target = await grant()
  // The wire target carries an optional grant; this staging path always PUTs.
  const granted = (value: components["schemas"]["DirectUploadTarget"]): DirectUploadGrant => {
    if (!value?.upload) throw Object.assign(new Error("识图上传未获得直传授权"), { code: "direct_upload_unavailable" })
    return value.upload
  }
  const confirm = async () => {
    for (;;) {
      assert()
      if (++budget.confirms > ATTEMPTS) throw Object.assign(new Error("识图上传确认未完成，请稍后重新准备"), { code: "workflow_ocr_upload_unconfirmed" })
      try {
        const verified = await post<Spec>(CONFIRM, { ...card, upload_ticket: target.upload_ticket })
        assert()
        if (verified.sha256 !== spec.sha256 || verified.bytes !== spec.bytes || verified.content_type !== spec.content_type) {
          throw Object.assign(new Error("识图上传校验不一致"), { code: "workflow_ocr_upload_mismatch" })
        }
        return true
      } catch (reason) {
        assert()
        if (isOcrImageMissing(reason)) return false
        if (budget.confirms >= ATTEMPTS || !transient(reason)) throw reason
        await stopAwareSleep(100 * 2 ** (budget.confirms - 1), () => Boolean(options.signal?.aborted || options.stopped?.()))
      }
    }
  }
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    assert()
    if (++budget.puts > ATTEMPTS) throw Object.assign(new Error("识图图片上传重试次数已达上限"), { code: "workflow_ocr_upload_unconfirmed" })
    try {
      await putDirectUpload(granted(target), image.bytes, { expectedByteLength: spec.bytes, signal: options.signal, timeoutMs: STEP_TIMEOUT_MS })
      assert()
      return analyzeImageBody(target.upload_ticket)
    } catch (reason) {
      assert()
      // A denied or corrupt object is never permission to overwrite/re-upload it.
      if ((reason as { outcomeUnknown?: boolean })?.outcomeUnknown !== true && (reason as { status?: number })?.status !== 403) throw reason
      if (await confirm()) return analyzeImageBody(target.upload_ticket)
      if (attempt >= ATTEMPTS || budget.puts >= ATTEMPTS) throw reason
      // Only the authenticated explicit missing result above permits a new grant/PUT.
      if (granted(target).expires_at_ms <= Date.now() + 5000) target = await grant()
    }
  }
  throw new Error("识图上传未完成")
}

/** Stop interrupts pre-purchase transfer only; the existing paid request remains wait-only. */
export async function stageClaimedOcrImage(image: PreparedOcrImage, headers: Record<string, string>, execution: BrowserExecution, budget?: OcrUploadBudget): Promise<OcrPurchaseBody> {
  const controller = new AbortController()
  let finished!: () => void
  const done = new Promise<void>(resolve => { finished = resolve })
  void untilStopped(done, execution.cancelled).then(() => { if (execution.cancelled()) controller.abort() })
  try { return await stageOcrImage(image, headers, { signal: controller.signal, stopped: execution.cancelled, assertCurrent: execution.assertCurrent, budget }) }
  finally { finished() }
}

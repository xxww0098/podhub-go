/** S3 is not Cloud: anonymous bounded transfer, no envelope parsing or URL-bearing errors. */
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { retryAfterMs } from "@/api/client"
import { requestDeadline } from "@/api/client-options"
import { uploadFailureMessage } from "./upload-failure-copy"

export type DirectUploadGrant = {
  url: string
  headers: { content_type: string; if_none_match: string; checksum_sha256?: string | null }
  expires_at_ms: number
}
export type DirectUploadOptions = {
  expectedByteLength: number
  signal?: AbortSignal
  onProgress?: (loaded: number, total: number) => void
  timeoutMs?: number
}

function failure(status?: number, outcomeUnknown = false, delay?: number): Error {
  const reason = {
    status,
    outcomeUnknown,
    name: status == null ? "TypeError" : undefined,
    code: "direct_upload_failed",
  }
  return Object.assign(new Error(uploadFailureMessage(reason)), {
    code: "direct_upload_failed", status, outcomeUnknown, retryAfterMs: delay,
  })
}
function invalid(): Error {
  return Object.assign(new Error("文件上传授权无效，请重新选择文件"), { code: "direct_upload_unavailable" })
}

/** Standard base64 of a raw SHA-256, the only shape `x-amz-checksum-sha256` may take. */
function checksumHeader(value: string | null | undefined): Record<string, string> {
  if (value == null || value === "") return {}
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw invalid()
  return { "x-amz-checksum-sha256": value }
}

/** C0 controls and DEL are the exact set the header regex used to reject. */
function hasControlCode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

export async function putDirectUpload(grant: DirectUploadGrant, body: Blob | Uint8Array, options: DirectUploadOptions): Promise<void> {
  const length = body instanceof Uint8Array ? body.byteLength : body.size
  if (!grant || !Number.isSafeInteger(options.expectedByteLength) || options.expectedByteLength <= 0
    || length !== options.expectedByteLength || !Number.isFinite(grant.expires_at_ms)
    || !grant.headers || grant.headers.if_none_match !== "*" || typeof grant.headers.content_type !== "string"
    || grant.headers.content_type.length === 0 || grant.headers.content_type.length > 128
    || hasControlCode(grant.headers.content_type)) throw invalid()
  let url: URL
  try { url = new URL(grant.url) } catch { throw invalid() }
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.hash) throw invalid()
  if (grant.expires_at_ms <= Date.now() + 5000) throw failure(403)
  if (options.signal?.aborted) throw failure(undefined, false)
  const deadline = requestDeadline(options.timeoutMs ?? 65 * 60 * 1000, options.signal)
  let response: Response | undefined
  // Fetch has no upload byte progress. Expose only truthful start/end boundaries;
  // XHR cannot refuse redirects or omit same-origin credentials, so never use it for bearer PUT.
  options.onProgress?.(0, length)
  try {
    try {
      response = await fetch(grant.url, {
        method: "PUT", mode: "cors", credentials: "omit", cache: "no-store",
        redirect: "error", referrerPolicy: "no-referrer", signal: deadline.signal,
        headers: {
          "Content-Type": grant.headers.content_type,
          "If-None-Match": grant.headers.if_none_match,
          ...checksumHeader(grant.headers.checksum_sha256),
        },
        // Native Content-Length includes only this exact Blob / typed-array view.
        body: body as BodyInit,
      })
    } catch { throw failure(undefined, true) }
    if (response.ok || response.status === 412) {
      if (response.ok) options.onProgress?.(length, length)
      return // Only authenticated native confirmation can turn this into a ready asset.
    }
    const unknown = response.status === 409 || response.status === 408 || response.status >= 500
    throw failure(response.status, unknown, retryAfterMs(response.headers))
  } finally {
    if (response?.body) await response.body.cancel().catch(() => {})
    deadline.clear()
  }
}

const HASH_CHUNK_BYTES = 1024 * 1024

/**
 * Bounded File/Blob hashing keeps 2GiB storage-tree uploads out of full ArrayBuffers.
 * A contiguous in-memory body of at least 1 MiB (user PSD templates, staged video)
 * is hashed with WebCrypto so the main thread can keep serving other PUTs.
 * Listing slices stay on the synchronous path: they are smaller than that, and a
 * WebCrypto hop per slice does not move a bandwidth-bound batch.
 */
export async function hashUploadBody(body: Blob | Uint8Array, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw invalid()
  if (body instanceof Uint8Array) return hashBytes(body, signal)
  const hasher = sha256.create()
  try {
    for (let offset = 0; offset < body.size; offset += HASH_CHUNK_BYTES) {
      if (signal?.aborted) throw invalid()
      const chunk = new Uint8Array(await body.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer())
      if (signal?.aborted) throw invalid()
      hasher.update(chunk)
    }
    return bytesToHex(hasher.digest())
  } finally { hasher.destroy() }
}

async function hashBytes(body: Uint8Array, signal?: AbortSignal): Promise<string> {
  const coversBuffer = body.byteOffset === 0
    && body.byteLength === body.buffer.byteLength
    && body.buffer instanceof ArrayBuffer
  if (coversBuffer && body.byteLength >= HASH_CHUNK_BYTES && typeof crypto.subtle?.digest === "function") {
    try {
      // WebCrypto accepts an ArrayBuffer view, not SharedArrayBuffer. This view
      // is the whole buffer, so it is the same window the incremental path hashes.
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(body.buffer, 0, body.byteLength))
      if (signal?.aborted) throw invalid()
      return bytesToHex(new Uint8Array(digest))
    } catch (reason) {
      if (signal?.aborted || (reason as { code?: string } | null)?.code === "direct_upload_unavailable") throw reason
    }
  }
  const hasher = sha256.create()
  try {
    if (body.byteLength <= HASH_CHUNK_BYTES) {
      hasher.update(body)
    } else {
      for (let offset = 0; offset < body.byteLength; offset += HASH_CHUNK_BYTES) {
        if (signal?.aborted) throw invalid()
        hasher.update(body.subarray(offset, Math.min(body.byteLength, offset + HASH_CHUNK_BYTES)))
        await Promise.resolve()
      }
    }
    if (signal?.aborted) throw invalid()
    return bytesToHex(hasher.digest())
  } finally { hasher.destroy() }
}

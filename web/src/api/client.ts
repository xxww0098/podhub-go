/**
 * The SPA's one door to the Cloud API. The SPA is served same-origin with the
 * axum service, so every path is relative by
 * construction — there is no base URL to configure, no CORS, and no token: the
 * Cookie session rides on `credentials: "include"` and nothing else
 * authenticates a call.
 *
 * Failures reject in the renderer's existing `CommandError` shape — `code`,
 * `message`, `remediation` — because `@/lib/error-message` reads those three
 * fields off whatever a call rejects with, and screens branch on codes such as
 * `cloud_workspace_limit_reached`. The rejection is an `Error` instance so the
 * `reason instanceof Error` path keeps working too.
 */

import { requestDeadline, type RequestOptions } from "./client-options"
import { reportError, type DiagFields } from "@/lib/diag-log"
import type { DiagnosticContextInput } from "@/lib/diagnostic-context"

/**
 * A 401 says the Cookie session is gone. The client cannot re-render the app
 * shell, so it says so on `window` and the shell falls back to the login
 * screen — one event per refused response, no redirect from inside a fetch.
 */
export const UNAUTHENTICATED_EVENT = "podhub:unauthenticated"

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

/**
 * What a refusal carries beyond the `CommandError` triple: the HTTP status and,
 * when Cloud sent one, `Retry-After` in milliseconds. Admission (429 Workspace
 * budget / 503 saturated) and the AI relay's `BUSY` both set the header; a
 * caller that wants to wait instead of fail reads it here (`busy-retry.ts`).
 */
export interface CloudRefusal extends Error {
  code: string
  remediation: string | null
  serverCode?: string
  /** HTTP x-request-id; independent of the OCR purchase identity below. */
  traceId?: string
  /** Path this client called, without query or fragment. Not an OCR id. */
  apiPath?: string
  /** OCR recovery purchase identity, never an HTTP trace or diagnostic ID. */
  requestId?: string
  status?: number
  retryAfterMs?: number
  /**
   * A provider-create refusal names the pending order it already committed
   * (`pending_order_id`) so the caller can resume or recover it instead of
   * minting a second one. Absent on every other refusal.
   */
  pendingOrderId?: string
  /**
   * HTTP 422 listing refusals carry `op_workflow` blockers. The envelope
   * message is generic; callers map these codes for the row log.
   */
  blockers?: unknown[]
  /** Supplier publish-gate readiness keys, localized by supplier-readiness. */
  missing?: unknown[]
  /**
   * A `supplier_not_listable` refusal carries the precise snake_case denial
   * (`catalog_expired`, `product_archived`, …). Passed through as-is — the
   * copy mapping lives in `features/supply-chain/listability-copy.ts`, not here.
   */
  denial?: string
}

function commandError(code: string, message: string, remediation: string | null = null): Error {
  return Object.assign(new Error(message), { code, remediation })
}

/** The path this process requested. Query, fragment and anything else stay off the error. */
function apiPathOf(path: string): string | undefined {
  const clean = path.split(/[?#]/, 1)[0] ?? ""
  return /^\/api\/[A-Za-z0-9_./-]{1,154}$/.test(clean) && !clean.includes("..") && !clean.includes("//")
    ? clean : undefined
}

/** `Retry-After` as delay-seconds or an HTTP-date; `undefined` when absent or unreadable. */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  const raw = headers.get("Retry-After")?.trim()
  if (!raw) return undefined
  if (/^\d+$/.test(raw)) return Number(raw) * 1000
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function diagnosticFields(method: Method, path: string, startedAt: number, response?: Response): DiagFields {
  const fields: DiagFields = {
    method,
    path: path.split(/[?#]/, 1)[0],
    durationMs: Date.now() - startedAt,
  }
  if (response) {
    fields.status = response.status
    const requestId = text(response.headers.get("x-request-id"))
    if (requestId) fields.requestId = requestId
  }
  return fields
}

/** The session is gone the moment the status says so, whatever the body holds. */
function announceUnauthenticated(response: Response) {
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(UNAUTHENTICATED_EVENT))
  }
}

function badResponse(
  reason: unknown, method: Method, path: string, startedAt: number, response: Response, diagnostic?: DiagnosticContextInput, options?: RequestOptions,
): Error {
  const error = commandError(
    "cloud_bad_response",
    "云端响应无法读取或格式错误，本次操作结果未被确认",
    "请刷新核对云端记录；不要重复提交已发起的操作。",
  )
  Object.assign(error, { cause: reason, status: response.status, traceId: response.headers.get("x-request-id") ?? undefined, apiPath: apiPathOf(path) })
  if (options?.reportOwner !== "caller") reportError("[api]", error, { ...diagnosticFields(method, path, startedAt, response), kind: "json" }, diagnostic)
  return error
}

async function readPayload(
  response: Response,
  method: Method,
  path: string,
  startedAt: number,
  diagnostic?: DiagnosticContextInput,
  options?: RequestOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  let raw: string
  try {
    raw = await response.text()
  } catch (reason) {
    if (signal?.aborted) throw unavailable(reason, method, path, startedAt, diagnostic, options, response)
    throw badResponse(reason, method, path, startedAt, response, diagnostic, options)
  }
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch (reason) {
    // JSON.parse errors can quote the response body, including private data.
    throw badResponse(
      new SyntaxError("Invalid JSON response", { cause: reason }),
      method, path, startedAt, response, diagnostic, options,
    )
  }
}

/**
 * Existing `/api` success bodies use `{"data": …}`; an empty body stays a
 * legal `void`. Anything else on a 2xx is a protocol break, not an empty
 * result — callers must not mistake it for a confirmed empty response.
 */
function envelopeData<T>(
  payload: unknown, method: Method, path: string, startedAt: number, response: Response, diagnostic?: DiagnosticContextInput, options?: RequestOptions,
): T {
  if (payload === undefined) return undefined as T
  if (typeof payload !== "object" || payload === null || !("data" in payload)) {
    throw badResponse(new Error("missing data envelope"), method, path, startedAt, response, diagnostic, options)
  }
  return (payload as { data: T }).data
}

function unavailable(reason: unknown, method: Method, path: string, startedAt: number, diagnostic?: DiagnosticContextInput, options?: RequestOptions, response?: Response): Error {
  // A lost write response cannot prove whether Cloud committed the operation.
  const write = method !== "GET"
  const error = commandError(
    "cloud_unavailable",
    write ? "云端连接中断，本次操作结果未被确认" : "云端服务暂时不可用",
    write ? "请刷新核对云端记录；不要重复提交已发起的操作。" : "请稍后重试；若问题持续，请检查网络连接。",
  )
  Object.assign(error, { cause: reason, status: response?.status, traceId: response?.headers.get("x-request-id") ?? undefined, apiPath: apiPathOf(path) })
  if (options?.reportOwner !== "caller") reportError("[api]", error, { ...diagnosticFields(method, path, startedAt, response), kind: "network" }, diagnostic)
  return error
}

/**
 * Cloud writes a refusal into one of two bodies: `{error, code}` for the domain
 * responses and `{code, message}` for `CloudErrorResponse`. Both carry the
 * domain's own code, which reaches the renderer as `cloud_<lowercased>` so
 * `WORKSPACE_LIMIT_REACHED` arrives as the `cloud_workspace_limit_reached` the
 * Workspace screens branch on. Cloud writes the actionable next step into the
 * message, which travels as-is.
 */
export function cloudRefusal(response: Pick<Response, "status" | "headers">, body: unknown, method: Method, path?: string): Error {
  const status = response.status
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>
  const message = text(fields.error) ?? text(fields.message)
  const code = text(fields.code)
  const unconfirmed = method !== "GET" && !message && status !== 401
  const recovery = fields.ocrRecovery
  const recoveryId = recovery && typeof recovery === "object"
    ? text((recovery as { requestId?: unknown }).requestId)
    : undefined
  return Object.assign(
    commandError(
      status === 401 ? "unauthenticated" : code ? `cloud_${code.toLowerCase()}` : "cloud_request_failed",
      message ?? (unconfirmed ? `云端未确认本次操作结果（HTTP ${status}）` : `云端请求失败（HTTP ${status}）`),
      unconfirmed ? "请刷新核对云端记录；不要重复提交已发起的操作。" : null,
    ),
    {
      status,
      serverCode: typeof fields.code === "string" ? fields.code : undefined,
      traceId: response.headers.get("x-request-id") ?? undefined,
      ...(path ? { apiPath: apiPathOf(path) } : {}),
      retryAfterMs: retryAfterMs(response.headers),
      requestId: recoveryId,
      pendingOrderId: text(fields.pending_order_id),
      blockers: Array.isArray(fields.blockers) ? fields.blockers : undefined,
      missing: Array.isArray(fields.missing) ? fields.missing : undefined,
      denial: text(fields.denial),
    },
  )
}

/** Grant routes whose presign may sign `x-amz-checksum-sha256`. Confirm routes stay out. */
export function storeChecksumGrantPath(method: string, path: string): boolean {
  if (method !== "POST") return false
  const clean = path.split("?")[0] ?? path
  if (clean.endsWith("/confirm") || clean.endsWith("/finalize")) return false
  if (clean.endsWith("/presign") || clean.endsWith("/presign-batch")) return true
  if (clean.endsWith("/listing/templates")) return true
  return clean.endsWith("/uploads") || clean.endsWith("/upload")
}

export async function request<T>(
  method: Method,
  path: string,
  body?: unknown,
  /** Extra request headers. The AI relay requires `Idempotency-Key`. */
  headers: Record<string, string> = {},
  /** Client wait only. Aborting does not cancel a Cloud purchase. */
  timeoutMs?: number,
  /**
   * The operation's own business input for a failure report, passed only by
   * callers that choose to (e.g. the frozen Ozon item a submit carried).
   * Sanitized by `createDiagnosticContext`; this argument is independent of
   * the opt-in, request-local transport body observation in `onEvidence`.
   */
  diagnostic?: DiagnosticContextInput,
  options: RequestOptions = {},
): Promise<T> {
  const startedAt = Date.now()
  let response: Response | undefined
  let jsonText: string | null = null
  const timeout = requestDeadline(timeoutMs, options.callerSignal)
  try {
    try {
      const outbound = { ...headers }
      if (storeChecksumGrantPath(method, path) && outbound["x-podhub-store-checksum"] == null) {
        outbound["x-podhub-store-checksum"] = "sha256"
      }
      const init: RequestInit = {
        method,
        credentials: "include",
        headers: body === undefined ? outbound : { "Content-Type": "application/json", ...outbound },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: timeout.signal,
      }
      // Reuse the exact serialized string handed to fetch, including failed transports.
      // A serialization failure leaves jsonText null because no body was dispatched.
      jsonText = typeof init.body === "string" ? init.body : null
      try { if (!timeout.signal.aborted) options.onDispatch?.() } catch { /* An observer cannot change submission. */ }
      response = await fetch(path, init)
    } catch (reason) {
      timeout.clear()
      throw unavailable(reason, method, path, startedAt, diagnostic, options)
    }
    announceUnauthenticated(response)
    // `fetch` resolves on response headers; the deadline must cover the body too,
    // so the timer stays armed until `text()` finishes or the body stalls out.
    let payload: unknown
    try {
      payload = await readPayload(response, method, path, startedAt, diagnostic, options, timeout.signal)
    } finally {
      timeout.clear()
    }
    if (!response.ok) {
      const error = cloudRefusal(response, payload, method, path)
      if (options.reportOwner !== "caller") reportError("[api]", error, { ...diagnosticFields(method, path, startedAt, response), kind: "http" }, diagnostic)
      throw error
    }
    // Raw DTO routes opt in explicitly. Never silently accept a malformed envelope.
    if (options.responseBody === "json") return payload as T
    return envelopeData<T>(payload, method, path, startedAt, response, diagnostic, options)
  } finally {
    try {
      options.onEvidence?.(Object.freeze({ jsonText, traceId: response?.headers.get("x-request-id") ?? null }))
    } catch {
      // This observer cannot undo an accepted write or replace its original failure.
      // Do not log, enqueue diagnostics or make another request for observer failures.
    }
  }
}

/** Authenticated binary GET with the same refusal and session semantics. */
export async function getBytes(path: string, timeoutMs?: number): Promise<{ bytes: Uint8Array<ArrayBuffer>, headers: Headers }> {
  const startedAt = Date.now()
  const timeout = requestDeadline(timeoutMs)
  let response: Response
  try {
    response = await fetch(path, { method: "GET", credentials: "include", signal: timeout?.signal })
  } catch (reason) {
    timeout?.clear()
    throw unavailable(reason, "GET", path, startedAt)
  }
  announceUnauthenticated(response)
  try {
    if (!response.ok) {
      const payload = await readPayload(response, "GET", path, startedAt)
      const error = cloudRefusal(response, payload, "GET", path)
      reportError("[api]", error, { ...diagnosticFields("GET", path, startedAt, response), kind: "http" })
      throw error
    }
    let bytes: ArrayBuffer
    try {
      bytes = await response.arrayBuffer()
    } catch (reason) {
      throw badResponse(reason, "GET", path, startedAt, response)
    }
    return { bytes: new Uint8Array(bytes), headers: response.headers }
  } finally {
    timeout?.clear()
  }
}

export const api = {
  get: <T>(path: string, timeoutMs?: number) => request<T>("GET", path, undefined, {}, timeoutMs),
  post: <T>(path: string, body?: unknown, timeoutMs?: number, diagnostic?: DiagnosticContextInput) =>
    request<T>("POST", path, body, {}, timeoutMs, diagnostic),
  put: <T>(path: string, body?: unknown, timeoutMs?: number) => request<T>("PUT", path, body, {}, timeoutMs),
  patch: <T>(path: string, body?: unknown, timeoutMs?: number) => request<T>("PATCH", path, body, {}, timeoutMs),
  del: <T>(path: string, timeoutMs?: number) => request<T>("DELETE", path, undefined, {}, timeoutMs),
}

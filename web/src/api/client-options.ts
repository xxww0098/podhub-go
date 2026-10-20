/** Request-local facts; any diagnostic capture and lifetime belong to the caller. */
export type RequestEvidence = Readonly<{ jsonText: string | null; traceId: string | null }>

/** Transport controls, independent of business diagnostic payloads. */
export type RequestOptions = {
  callerSignal?: AbortSignal
  /** Publishing normalizes and reports once at its own boundary. */
  reportOwner?: "api" | "caller"
  /** Explicit endpoint contract. WB catalog returns its DTO directly; existing routes use data. */
  responseBody?: "data" | "json"
  /** Synchronous, caller-scoped observation at settlement; never persisted or reported here. */
  onEvidence?: (evidence: RequestEvidence) => void
  /** Immediately before fetch, after serialization. Observation never controls the request. */
  onDispatch?: () => void
}

/** Keep the deadline active through body consumption; remove caller listeners. */
export function requestDeadline(timeoutMs?: number, callerSignal?: AbortSignal) {
  const controller = new AbortController()
  const abort = () => controller.abort(callerSignal?.reason)
  if (callerSignal?.aborted) abort()
  else callerSignal?.addEventListener("abort", abort, { once: true })
  const timer = timeoutMs != null && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(new DOMException("Request deadline exceeded", "TimeoutError")), timeoutMs)
    : undefined
  return {
    signal: controller.signal,
    clear() {
      if (timer !== undefined) clearTimeout(timer)
      callerSignal?.removeEventListener("abort", abort)
    },
  }
}

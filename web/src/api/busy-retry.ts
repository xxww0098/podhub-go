/**
 * Wait out a busy Cloud instead of failing the row.
 *
 * Cloud answers congestion with two codes it never interchanges
 * (`src/http/admission.rs`): 429 when this Workspace's own budget for the route
 * class is spent, 503 when the process is saturated. Both carry `Retry-After`,
 * and so does the AI relay's `BUSY` (lease refused). None of them did any
 * work — a 429 OCR bought nothing, a shed probe touched no origin — so the
 * honest client answer is to wait with jitter on a budget of its own, then
 * try the same request again (`docs/media-probe-locality.md` P0 / P3).
 *
 * What is *not* retried here: a 503 without `Retry-After`. Cloud sends that
 * for "the platform has no media storage configured" or an origin that
 * refused, and waiting on those only delays the same answer.
 *
 * 上游不确定失败不以 429 呈现: an uncertain upstream
 * failure arrives as a terminal 502/504 that demands a NEW Idempotency-Key —
 * `isBusyRefusal` must never learn to accept it; it rides the OCR
 * pause-recovery path instead.
 */
import type { CloudRefusal } from "./client"
import { cancelledError } from "@/lib/error-message"

export interface BusyRetryOptions {
  /** Attempts in total, the first one included. */
  attempts?: number
  /** Ceiling on the sum of every wait; past it the last refusal is thrown. */
  maxWaitMs?: number
  /** First backoff when the refusal carries no `Retry-After`; doubles per attempt. */
  baseDelayMs?: number
  /** Ceiling on local exponential backoff; never shortens `Retry-After`. */
  maxDelayMs?: number
  /**
   * Grow a short `Retry-After` with the attempt so complete and prepare do
   * not wake together. The wait is never shorter than the hint. A hint at or
   * above `maxDelayMs` — including an hour — stays within 20%.
   */
  paceShortHints?: boolean
  /** Polled before each wait; `true` throws the refusal instead of waiting. */
  cancelled?: () => boolean
  /** Observability hook: called with the wait about to happen. */
  onWait?: (wait: { attempt: number; delayMs: number; status: number }) => void
  /** Waits out `reason`; a caller may route a refusal it minted to its own wait. */
  sleep?: (ms: number, reason: CloudRefusal) => Promise<void>
  random?: () => number
}

export const BUSY_RETRY_DEFAULTS = {
  attempts: 6,
  maxWaitMs: 60_000,
  baseDelayMs: 1_000,
  maxDelayMs: 10_000,
} as const

/** 429 always; 503 only when Cloud said how long to wait. */
export function isBusyRefusal(reason: unknown): reason is CloudRefusal {
  const status = (reason as { status?: unknown } | null)?.status
  if (status === 429) return true
  return status === 503 && typeof (reason as { retryAfterMs?: unknown }).retryAfterMs === "number"
}

/**
 * Server hints are a lower bound, with up to 20% extra jitter. Missing hints
 * use capped exponential backoff. `attempt` counts refusals from zero.
 */
export function busyDelayMs(
  reason: CloudRefusal,
  attempt: number,
  options: Pick<BusyRetryOptions, "baseDelayMs" | "maxDelayMs" | "random" | "paceShortHints"> = {},
): number {
  const base = Math.max(1, options.baseDelayMs ?? BUSY_RETRY_DEFAULTS.baseDelayMs)
  const cap = Math.max(base, options.maxDelayMs ?? BUSY_RETRY_DEFAULTS.maxDelayMs)
  const random = options.random ?? Math.random
  const hint = reason.retryAfterMs
  if (typeof hint === "number" && Number.isFinite(hint) && hint >= 0) {
    const hinted = Math.ceil((hint || base) * (1 + 0.2 * random()))
    if (!options.paceShortHints || hint >= cap) return hinted
    const grown = Math.min(base * 2 ** attempt, cap)
    const jittered = Math.max(1, Math.min(cap, Math.round(grown * (0.5 + random()))))
    return Math.max(hinted, jittered)
  }
  const capped = Math.min(base * 2 ** attempt, cap)
  return Math.max(1, Math.min(cap, Math.round(capped * (0.5 + random()))))
}

async function defaultSleep(ms: number, cancelled?: () => boolean): Promise<void> {
  while (ms > 0 && !cancelled?.()) {
    const step = cancelled ? Math.min(ms, 250) : ms
    await new Promise<void>((resolve) => setTimeout(resolve, step))
    ms -= step
  }
}

export async function retryWhenBusy<T>(
  run: () => Promise<T>,
  options: BusyRetryOptions = {},
): Promise<T> {
  const attempts = options.attempts ?? BUSY_RETRY_DEFAULTS.attempts
  const maxWaitMs = options.maxWaitMs ?? BUSY_RETRY_DEFAULTS.maxWaitMs
  const sleep = options.sleep ?? ((ms: number) => defaultSleep(ms, options.cancelled))
  let waited = 0
  if (options.cancelled?.()) throw cancelledError()
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run()
    } catch (reason) {
      if (!isBusyRefusal(reason)) throw reason
      if (options.cancelled?.()) throw cancelledError()
      if (attempt + 1 >= attempts) throw reason
      const delayMs = busyDelayMs(reason, attempt, options)
      if (waited + delayMs > maxWaitMs) throw reason
      waited += delayMs
      options.onWait?.({ attempt, delayMs, status: reason.status ?? 0 })
      await sleep(delayMs, reason)
      if (options.cancelled?.()) throw cancelledError()
    }
  }
}

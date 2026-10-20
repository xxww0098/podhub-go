/** Batch-owned OCR claim coalescing and empty-window backoff; media never claims here. */
import { api } from "@/api/client"
import { route } from "@/api/routes"
import type { components } from "@/api/schema"
import { CONTROL_PLANE_TIMEOUT_MS } from "../execution-context"

type BrowserClaim = components["schemas"]["ListingBrowserJobClaimData"]
/** Server clamps `limit` to 1..16; do not invent a tighter client cap. */
const CLAIM_WINDOW_CAP = 16
/**
 * An empty window mostly means the User's `ai_ocr` permits are held elsewhere
 * — another tab, or leases a reload left behind — or a Job's `run_at` is still
 * ahead. Its rows wait out one shared tick (5 s, then 10 s, back to 5 s after
 * a grant): a queued batch asks once per tick, not every row every second.
 */
const CLAIM_TICK_MIN_MS = 5_000
const CLAIM_TICK_MAX_MS = 10_000

/**
 * One coordinator per `runRows`: same-tick pending ids share one window POST,
 * and rows whose window came back empty share one tick before the next.
 */
export function createClaimCoordinator() {
  type Waiter = { id: string, resolve: (claim: BrowserClaim | null) => void, reject: (reason: unknown) => void }
  const queues = new Map<string, Waiter[]>()
  let scheduled = false
  let tick: { wait: Promise<void>, ms: number } | undefined
  let tickTimer: ReturnType<typeof setTimeout> | undefined
  let tickMs = CLAIM_TICK_MIN_MS
  const flush = () => {
    scheduled = false
    const batches = [...queues.entries()]
    queues.clear()
    void Promise.all(batches.map(async ([kind, waiters]) => {
      const jobIds = waiters.map((waiter) => waiter.id)
      try {
        const claimed = await api.post<BrowserClaim[]>(
          route("listingJobsClaimWindow"),
          { jobIds, kind, limit: Math.min(CLAIM_WINDOW_CAP, jobIds.length) },
          CONTROL_PLANE_TIMEOUT_MS,
        )
        const granted = new Map((claimed ?? []).map((item) => [item.job.id, item]))
        if (granted.size) tickMs = CLAIM_TICK_MIN_MS
        for (const waiter of waiters) waiter.resolve(granted.get(waiter.id) ?? null)
      } catch (reason) {
        for (const waiter of waiters) waiter.reject(reason)
      }
    }))
  }
  return {
    claim(id: string, kind: string): Promise<BrowserClaim | null> {
      return new Promise((resolve, reject) => {
        const list = queues.get(kind) ?? []
        list.push({ id, resolve, reject })
        queues.set(kind, list)
        if (!scheduled) {
          scheduled = true
          setTimeout(flush, 0)
        }
      })
    },
    /** The batch's pending tick, or a new one: every empty-window row wakes on the same one. */
    nextTick(): { wait: Promise<void>, ms: number } {
      if (!tick) {
        const ms = tickMs
        tickMs = Math.min(tickMs * 2, CLAIM_TICK_MAX_MS)
        tick = { ms, wait: new Promise((resolve) => { tickTimer = setTimeout(() => { tick = undefined; resolve() }, ms) }) }
      }
      return tick
    },
    dispose: () => clearTimeout(tickTimer),
  }
}
export type ClaimCoordinator = ReturnType<typeof createClaimCoordinator>

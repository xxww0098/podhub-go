/**
 * One timer per tab for every lease renewal.
 *
 * One timer, aimed at the soonest due lease. Each entry counts down on its
 * own period, so a longer lease is not renewed early and an in-flight renewal
 * is skipped instead of started twice. Joining a shorter lease keeps the time
 * the current timer has already waited.
 */

export type CancelSchedule = () => void

export type LeaseScheduler = {
  keep(id: string, everyMs: number, pulse: () => Promise<void> | void): () => void
}

type Entry = {
  everyMs: number
  wait: number
  inflight: boolean
  pulse: () => Promise<void> | void
}

export function createLeaseScheduler(
  schedule: (run: () => void, ms: number) => CancelSchedule = defaultSchedule,
  now: () => number = () => Date.now(),
): LeaseScheduler {
  const entries = new Map<string, Entry>()
  let cancel: CancelSchedule = () => {}
  let period = 0
  let armedReal = 0

  const stopTimer = () => {
    cancel()
    cancel = () => {}
    period = 0
  }

  const soonest = () => {
    let wait = Number.POSITIVE_INFINITY
    for (const entry of entries.values()) {
      // In-flight entries already hold the wait until their next renewal.
      // Skipping them would aim the timer at a later lease and drop ticks.
      if (entry.wait < wait) wait = entry.wait
    }
    return wait
  }

  const arm = (fresh?: Entry) => {
    if (entries.size === 0) {
      stopTimer()
      return
    }
    const wait = soonest()
    if (wait === Number.POSITIVE_INFINITY) return
    const next = Math.max(1, wait)
    // A longer wait still arrives on the current tick. Restarting would throw
    // away the time already spent and can miss a short lease's deadline.
    // `armedReal` must stay the real time the current period started — fire()
    // derives its elapsed from it.
    if (period === next || (period > 0 && next > period)) return
    if (period > 0) {
      const elapsed = Math.min(period, Math.max(0, now() - armedReal))
      stopTimer()
      for (const entry of entries.values()) {
        if (entry === fresh || entry.inflight) continue
        entry.wait -= elapsed
      }
    }
    const after = soonest()
    if (after === Number.POSITIVE_INFINITY) return
    period = Math.max(1, after)
    armedReal = now()
    cancel = schedule(() => fire(), period)
  }

  const fire = () => {
    // Book the REAL time since the period armed, floored at the nominal
    // period (a timer never fires early): under main-thread jank or
    // background-tab throttling the fire arrives late, and booking only the
    // nominal period lets renewals drift past their lease deadlines.
    const firedAt = now()
    const elapsed = period <= 0 ? 0 : Math.max(period, firedAt - armedReal)
    armedReal = firedAt
    if (period <= 0) return
    const due: Entry[] = []
    for (const entry of entries.values()) {
      if (entry.inflight) continue
      entry.wait -= elapsed
      if (entry.wait > 0) continue
      do entry.wait += entry.everyMs
      while (entry.wait <= 0)
      entry.inflight = true
      due.push(entry)
    }
    for (const entry of due) {
      try {
        void Promise.resolve(entry.pulse()).finally(() => { entry.inflight = false })
      } catch {
        entry.inflight = false
      }
    }
    const wait = soonest()
    if (wait === Number.POSITIVE_INFINITY) return
    const next = Math.max(1, wait)
    if (next === period) return
    stopTimer()
    period = next
    armedReal = now()
    cancel = schedule(() => fire(), period)
  }

  return {
    keep(id, everyMs, pulse) {
      const ms = Math.max(1, everyMs)
      const entry: Entry = { everyMs: ms, wait: ms, inflight: false, pulse }
      entries.set(id, entry)
      arm(entry)
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        if (entries.get(id) === entry) {
          entries.delete(id)
          arm()
        }
      }
    },
  }
}

function defaultSchedule(run: () => void, ms: number): CancelSchedule {
  const id = setInterval(run, ms)
  return () => clearInterval(id)
}

let shared: LeaseScheduler | undefined

/** The one renewal timer for this tab. */
export function tabLeaseScheduler(): LeaseScheduler {
  shared ??= createLeaseScheduler()
  return shared
}

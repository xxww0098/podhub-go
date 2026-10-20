/**
 * Upload admission for this browser: an in-flight byte window, and one
 * shared slot count across tabs. No server coordination.
 *
 * The byte window is how many bytes are on the wire, not a speed estimate.
 * A slow PUT holds its bytes, so the next one waits and concurrency falls.
 * One object larger than the window still runs alone, otherwise a video
 * would never start.
 */
import { cancelledError } from "@/lib/error-message"

export const MEDIA_UPLOAD_BYTE_BUDGET = 8 * 1024 * 1024
/** Today's per-tab count, now summed across tabs of this browser profile. */
export const UPLOAD_USER_CAP = 16
const SLOT_TTL_MS = 15_000
const SLOT_PREFIX = "podhub.upload-slot."

export function byteCost(byteLength: number | undefined, budget: number): number {
  // An unknown/invalid size charges the FULL window, not zero: cost 0 admits
  // any number of concurrent uploads and voids the "one oversized object
  // runs alone" invariant.
  if (byteLength == null || !Number.isFinite(byteLength) || byteLength <= 0) return budget
  return Math.min(budget, Math.ceil(byteLength))
}

export function createByteWindow(budget: number) {
  let used = 0
  type Waiter = { cost: number, grant: () => void, reject: (reason: unknown) => void }
  const waiting: Waiter[] = []

  const grantWaiting = () => {
    while (waiting.length > 0) {
      const next = waiting[0]!
      if (used + next.cost > budget) return
      waiting.shift()
      used += next.cost
      next.grant()
    }
  }

  return {
    async acquire(byteLength: number | undefined, cancelled?: () => boolean): Promise<() => void> {
      const cost = byteCost(byteLength, budget)
      if (cost === 0) return () => {}
      if (cancelled?.()) throw cancelledError()
      if (waiting.length === 0 && used + cost <= budget) {
        used += cost
      } else {
        await new Promise<void>((resolve, reject) => {
          const waiter: Waiter = {
            cost,
            grant: () => { clearInterval(timer); resolve() },
            reject: (reason) => { clearInterval(timer); reject(reason) },
          }
          const timer = cancelled ? setInterval(() => {
            if (!cancelled()) return
            const index = waiting.indexOf(waiter)
            if (index < 0) return
            waiting.splice(index, 1)
            waiter.reject(cancelledError())
          }, 250) : undefined
          waiting.push(waiter)
        })
      }
      let released = false
      return () => {
        if (released) return
        released = true
        used -= cost
        if (used < 0) used = 0
        grantWaiting()
      }
    },
  }
}

export type SlotStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  keys(): string[]
}

type SlotRecord = { slots: number, until: number }

export function createTabUploadSlots(options: {
  storage: SlotStorage
  tabId: string
  cap?: number
  now?: () => number
  ttlMs?: number
  /** Isolates this counter from the PUT slots. Defaults to the upload prefix. */
  prefix?: string
}) {
  const cap = options.cap ?? UPLOAD_USER_CAP
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? SLOT_TTL_MS
  const prefix = options.prefix ?? SLOT_PREFIX
  const key = prefix + options.tabId
  let slots = 0

  // ponytail: two tabs can both pass the sum check before either write lands,
  // so the cap can overshoot by a few slots. Per-tab keys avoid clobbering
  // the other tab's count. A server lease is the upgrade if a fixture shows it.
  // Storage access can throw (quota / private mode); degrade to skipping the
  // broken entry instead of letting the throw escape into the admission path.
  const safeRemove = (storageKey: string) => {
    try {
      options.storage.removeItem(storageKey)
    } catch {
      // unreachable entries are ignored
    }
  }
  const liveUsed = (at: number) => {
    let used = 0
    let keys: string[] = []
    try {
      keys = [...options.storage.keys()]
    } catch {
      return used
    }
    for (const storageKey of keys) {
      if (!storageKey.startsWith(prefix)) continue
      let raw: string | null = null
      try {
        raw = options.storage.getItem(storageKey)
      } catch {
        continue
      }
      if (!raw) continue
      let record: SlotRecord
      try {
        record = JSON.parse(raw) as SlotRecord
      } catch {
        safeRemove(storageKey)
        continue
      }
      if (typeof record?.slots !== "number" || typeof record.until !== "number") {
        safeRemove(storageKey)
        continue
      }
      if (record.until <= at || record.slots <= 0) continue
      used += record.slots
    }
    return used
  }

  const write = () => {
    try {
      if (slots <= 0) {
        options.storage.removeItem(key)
        return
      }
      options.storage.setItem(key, JSON.stringify({ slots, until: now() + ttlMs } satisfies SlotRecord))
    } catch {
      // This tab's count stays memory-local; admission keeps working off the
      // keys that still read.
    }
  }

  return {
    tryAcquire(): boolean {
      if (liveUsed(now()) >= cap) return false
      slots += 1
      write()
      return true
    },
    release(): void {
      if (slots <= 0) return
      slots -= 1
      write()
    },
    /** Refresh the TTL while this tab still holds slots. */
    touch(): void {
      if (slots > 0) write()
    },
    close(): void {
      slots = 0
      options.storage.removeItem(key)
    },
    used(): number {
      return liveUsed(now())
    },
  }
}

function browserSlotStorage(): SlotStorage {
  const storage = window.localStorage
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
    keys: () => {
      const out: string[] = []
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index)
        if (key) out.push(key)
      }
      return out
    },
  }
}

let sharedSlots: ReturnType<typeof createTabUploadSlots> | null | undefined
let sharedCompleteSlots: ReturnType<typeof createTabUploadSlots> | null | undefined

function browserSlots(
  cache: "upload" | "complete",
  options: { cap?: number; prefix?: string },
): ReturnType<typeof createTabUploadSlots> | null {
  const current = cache === "upload" ? sharedSlots : sharedCompleteSlots
  if (current !== undefined) return current
  const empty = () => {
    if (cache === "upload") sharedSlots = null
    else sharedCompleteSlots = null
    return null
  }
  if ("Bun" in globalThis || typeof window === "undefined") return empty()
  try {
    if (!window.localStorage) return empty()
  } catch {
    return empty()
  }
  const slots = createTabUploadSlots({
    storage: browserSlotStorage(),
    tabId: crypto.randomUUID(),
    ...options,
  })
  const timer = window.setInterval(() => slots.touch(), SLOT_TTL_MS / 3)
  window.addEventListener("pagehide", () => {
    window.clearInterval(timer)
    slots.close()
  })
  if (cache === "upload") sharedSlots = slots
  else sharedCompleteSlots = slots
  return slots
}

/** Null outside a browser page (tests, no storage): the tab's own count cap still applies. */
export function tabUploadSlots(): ReturnType<typeof createTabUploadSlots> | null {
  return browserSlots("upload", {})
}

/** Cross-tab cap for storage confirm. Matches the per-user media-upload budget of 2. */
export function completeTabSlots(): ReturnType<typeof createTabUploadSlots> | null {
  return browserSlots("complete", { cap: 2, prefix: "podhub.complete-slot." })
}

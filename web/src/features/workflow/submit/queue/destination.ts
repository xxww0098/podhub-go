/** Native platform identity is part of every concurrency/budget/offer key. */
export function destinationKey(platform: string, destination: string): string {
  return JSON.stringify([platform, destination])
}

// All final-queue instances in this tab share the same two destination slots.
const active = new Set<string>()
const changed = new Set<() => void>()
export async function withDestination(key: string, signal: AbortSignal, work: () => Promise<void>): Promise<void> {
  while (!signal.aborted) {
    if (active.size < 2 && !active.has(key)) {
      active.add(key)
      try { await work() }
      finally { active.delete(key); for (const wake of changed) wake() }
      return
    }
    await new Promise<void>((resolve) => {
      const wake = () => { changed.delete(wake); signal.removeEventListener("abort", wake); resolve() }
      changed.add(wake)
      signal.addEventListener("abort", wake, { once: true })
      if (signal.aborted) wake()
    })
  }
}

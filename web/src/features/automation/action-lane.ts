/** Per-action concurrency. A free action does not wait on a busy one. */

export function createActionLanes(limit: number) {
  const lanes = new Map<string, { active: number, queue: Array<() => void> }>()

  const lane = (action: string) => {
    const existing = lanes.get(action)
    if (existing) return existing
    const created = { active: 0, queue: [] as Array<() => void> }
    lanes.set(action, created)
    return created
  }

  return {
    take(action: string): Promise<void> {
      const current = lane(action)
      if (current.active < limit) {
        current.active += 1
        return Promise.resolve()
      }
      return new Promise((resolve) => { current.queue.push(resolve) })
    },
    free(action: string): void {
      const current = lanes.get(action)
      if (!current) return
      const next = current.queue.shift()
      if (next) next()
      else current.active -= 1
    },
  }
}

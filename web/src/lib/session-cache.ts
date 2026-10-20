import { create } from "zustand"

import { clearAllQueries } from "@/lib/query-client"

export type SessionCacheEntry<T> = {
  value: T
  cachedAt: number
}

type SessionCacheState<T> = {
  entries: Record<string, SessionCacheEntry<T>>
}

type CommitArgs<T> = {
  key: string
  next: T
  current: T | undefined
  write: (value: T) => void
}

export type SessionCacheOptions<T> = {
  /** Entries younger than this are returned without refetching; omit to always refetch. */
  ttlMs?: number
  /** Runs inside the generation fence instead of the default `write(next)`. */
  commit?: (args: CommitArgs<T>) => void
}

/**
 * One session-fact cache: a private zustand store keyed by string, shared
 * in-flight requests, and generation fencing so a reply born before an
 * invalidate/remember cannot repopulate the cache. Singleton
 * facts use a single fixed key ("").
 */
const allCaches: Array<{ invalidate: () => void }> = []
const invalidationListeners = new Set<() => void>()

/** Release non-cache session resources (e.g. optional uploads) on identity changes. */
export function onSessionInvalidated(listener: () => void): () => void {
  invalidationListeners.add(listener)
  return () => { invalidationListeners.delete(listener) }
}

/**
 * Sign-out empties every session-fact cache in one sweep. Registration happens
 * at cache creation, so a cache module that was never imported has no state to
 * clear and is correctly absent. The TanStack Query snapshot owned by the
 * migrated modules rides the same sweep — they are session-fact caches too.
 */
export function invalidateAllSessionCaches(): void {
  for (const cache of allCaches) cache.invalidate()
  for (const listener of invalidationListeners) listener()
  clearAllQueries()
}

export function createSessionCache<T>(
  fetcher: (key: string) => Promise<T>,
  options: SessionCacheOptions<T> = {},
) {
  const useStore = create<SessionCacheState<T>>(() => ({ entries: {} }))
  const inFlight = new Map<string, Promise<T>>()
  const generations = new Map<string, number>()

  function nextGeneration(key: string): number {
    const next = (generations.get(key) ?? 0) + 1
    generations.set(key, next)
    return next
  }

  /** Plain write: no fencing, in-flight requests keep their claim on the key. */
  function set(key: string, value: T, now = Date.now()): void {
    useStore.setState((state) => ({
      entries: { ...state.entries, [key]: { value, cachedAt: now } },
    }))
  }

  function peek(key: string): SessionCacheEntry<T> | undefined {
    return useStore.getState().entries[key]
  }

  function subscribe(onStoreChange: () => void): () => void {
    return useStore.subscribe(onStoreChange)
  }

  function invalidate(): void {
    inFlight.clear()
    for (const key of generations.keys()) nextGeneration(key)
    useStore.setState({ entries: {} })
  }

  /** Publish a locally known value; fences out any in-flight fetch for the key. */
  function remember(key: string, value: T, now = Date.now()): void {
    nextGeneration(key)
    inFlight.delete(key)
    set(key, value, now)
  }

  /** Drop one key without caching the miss; fences out any in-flight fetch. */
  function drop(key: string): void {
    nextGeneration(key)
    inFlight.delete(key)
    useStore.setState((state) => {
      if (!(key in state.entries)) return state
      const { [key]: _dropped, ...entries } = state.entries
      return { entries }
    })
  }

  /**
   * Read-only guard for a write the caller publishes itself (an SSE event, a
   * mutation reply). False once `remember`/`drop`/`load` touched the key or the
   * cache was invalidated. An absent key is registered so `invalidate` covers it.
   */
  function captureFence(key: string): () => boolean {
    if (!generations.has(key)) generations.set(key, 0)
    const generation = generations.get(key)
    return () => generations.get(key) === generation
  }

  function defaultCommit({ next, write }: CommitArgs<T>): void {
    write(next)
  }

  async function load(key: string, loadOptions?: { force?: boolean }): Promise<T> {
    const cached = peek(key)
    if (
      cached &&
      !loadOptions?.force &&
      options.ttlMs !== undefined &&
      Date.now() - cached.cachedAt < options.ttlMs
    ) {
      return cached.value
    }

    const existing = inFlight.get(key)
    if (existing && !loadOptions?.force) return existing

    const generation = nextGeneration(key)
    const request = fetcher(key).then((next) => {
      if (generations.get(key) === generation) {
        const commit = options.commit ?? defaultCommit
        commit({ key, next, current: peek(key)?.value, write: (value) => set(key, value) })
      }
      return next
    })
    inFlight.set(key, request)
    try {
      return await request
    } finally {
      if (inFlight.get(key) === request) inFlight.delete(key)
    }
  }

  /** React read. Selectors must return referentially stable values (zustand v5). */
  function use(key: string | undefined): SessionCacheEntry<T> | undefined
  function use<R>(
    key: string | undefined,
    select: (entry: SessionCacheEntry<T> | undefined) => R,
  ): R
  function use<R>(
    key: string | undefined,
    select?: (entry: SessionCacheEntry<T> | undefined) => R,
  ): R | SessionCacheEntry<T> | undefined {
    return useStore((state) => {
      const entry = key === undefined ? undefined : state.entries[key]
      return select ? select(entry) : entry
    })
  }

  allCaches.push({ invalidate })
  return { peek, subscribe, invalidate, load, use, set, remember, drop, captureFence }
}

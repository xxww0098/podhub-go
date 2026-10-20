import { focusManager, QueryClient } from "@tanstack/react-query"

/**
 * One QueryClient for the whole SPA. Default policy mirrors the
 * session-cache contract it replaces: a read under staleTime is served from
 * the cache, nothing refetches unless the window is visible, and Workspace
 * switches are explicit `removeQueries`/`invalidateQueries` calls at the
 * module boundary rather than reactive magic.
 *
 * `refetchOnWindowFocus` is off by default: `useVisiblePolling` already
 * owns focus/visibility wake-ups, so letting Query also fire on focus would
 * double the same read.
 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Session-fact default: a fresh write is fresh for the TTL window.
      staleTime: 60_000,
      // Keep entries past unmount like session-cache did (keep-alive panes
      // share the snapshot), but do not let the process accumulate forever.
      gcTime: 10 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
      refetchOnReconnect: true,
      // Polled reads that fail must not stack one toast per tick; the
      // observer that owns the notice decides whether a failure is news.
      refetchIntervalInBackground: false,
    },
  },
})

// The SPA already paints its own foreground clock; Query's focus manager must
// agree that a hidden document never counts as focused, or `refetchInterval`
// would keep firing while minimized.
// Node-side tests import the module without a DOM; registering window listeners
// there would crash, and a headless worker never has a foreground to track.
if (typeof window !== "undefined" && typeof document !== "undefined") {
  focusManager.setEventListener((handleFocus) => {
    const onVisibility = () => handleFocus(document.visibilityState === "visible")
    window.addEventListener("visibilitychange", onVisibility)
    window.addEventListener("focus", onVisibility)
    return () => {
      window.removeEventListener("visibilitychange", onVisibility)
      window.removeEventListener("focus", onVisibility)
    }
  })
}

/**
 * Session boundary: sign-out and account switches drop every cached fact in
 * one sweep, matching `invalidateAllSessionCaches`. Modules that fence reads
 * by generation subscribe to this sweep: it is the invalidate, and the
 * listener is the fence.
 */
const sweepListeners = new Set<() => void>()

/** Notify every query-backed cache that the session was swept. */
export function onSessionSweep(listener: () => void): () => void {
  sweepListeners.add(listener)
  return () => sweepListeners.delete(listener)
}

export function clearAllQueries(): void {
  queryClient.clear()
  for (const listener of sweepListeners) listener()
}

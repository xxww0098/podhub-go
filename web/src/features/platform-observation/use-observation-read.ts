import { useCallback, useEffect, useId, useMemo, useRef, useSyncExternalStore } from "react"
import { clearLive, notifyLive } from "@/lib/notify"
import { errorMessage } from "@/lib/error-message"
import { ObservationResource } from "./observation-resource"

/** Every key owns a fresh resource, so even the first scope-change render is empty. */
export function useObservationRead<T>(key: string, request: () => Promise<T>, fallback: string, enabled = true) {
  const id = "observation-" + useId()
  const resource = useMemo(() => new ObservationResource<T>(), [key])
  const currentResource = useRef(resource)
  currentResource.current = resource
  const latest = useRef({ request, fallback })
  latest.current = { request, fallback }
  const state = useSyncExternalStore(resource.subscribe, resource.snapshot, resource.snapshot)
  const load = useCallback((read?: () => Promise<T>, merge?: (previous: T | undefined, incoming: T) => T) => {
    if (!enabled || currentResource.current !== resource) return Promise.resolve()
    return resource.load(read ?? (() => latest.current.request()), {
      success: () => { if (currentResource.current === resource) clearLive(id) },
      failure: (reason) => {
        if (currentResource.current !== resource) return
        notifyLive({
          id, type: "error", reason,
          title: errorMessage(reason, latest.current.fallback),
          action: { label: "重试", onClick: () => { void load(read, merge) } },
        })
      },
    }, merge)
  }, [resource, id, enabled])

  useEffect(() => {
    if (enabled) void load()
    return () => { resource.invalidate(); clearLive(id) }
  }, [load, resource, id, enabled])

  return { ...state, loading: enabled && ((!state.data && !state.failed) || state.loading), load }
}

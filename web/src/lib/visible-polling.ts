import { useEffect, useRef } from "react"

export type VisiblePollTrigger = "mount" | "beat" | "focus" | "visible"

/**
 * beat / focus / visible only when the document is in front of someone.
 * mount always goes: the first read is not a guess.
 */
export function shouldVisiblePoll(
  trigger: VisiblePollTrigger,
  visibility: DocumentVisibilityState,
): boolean {
  if (trigger === "beat" || trigger === "focus" || trigger === "visible") {
    return visibility === "visible"
  }
  return true
}

/**
 * Foreground window clock. Domain adapters declare cadence and stop;
 * they keep in-flight dedup and result fencing.
 */
export function useVisiblePolling(options: {
  enabled: boolean
  intervalMs: number
  onPoll: (trigger: VisiblePollTrigger) => void
  restartKey?: string | number
}): void {
  const onPollRef = useRef(options.onPoll)
  onPollRef.current = options.onPoll

  useEffect(() => {
    if (!options.enabled) return
    const fire = (trigger: VisiblePollTrigger) => {
      if (!shouldVisiblePoll(trigger, document.visibilityState)) return
      onPollRef.current(trigger)
    }
    fire("mount")
    const timer = window.setInterval(() => fire("beat"), options.intervalMs)
    const onFocus = () => fire("focus")
    const onVisibilityChange = () => fire("visible")
    window.addEventListener("focus", onFocus)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener("focus", onFocus)
      document.removeEventListener("visibilitychange", onVisibilityChange)
    }
  }, [options.enabled, options.intervalMs, options.restartKey])
}

import { flushSync } from "react-dom"

/**
 * Dissolve the module canvas across a React commit.
 *
 * Keep-alive panes toggle `hidden`; without a snapshot pair that is a hard
 * cut. `flushSync` is required so the incoming pane is in the DOM before the
 * "new" snapshot is taken. Reduced motion and a missing API fall through to
 * the same mutate.
 */
export function runViewTransition(mutate: () => void): void {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    (typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  ) {
    mutate()
    return
  }

  try {
    document.startViewTransition(() => {
      flushSync(mutate)
    })
  } catch {
    mutate()
  }
}

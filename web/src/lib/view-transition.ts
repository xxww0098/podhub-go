import { animate } from "motion/react"
import { flushSync } from "react-dom"

const EASE_SETTLE = [0.16, 1, 0.3, 1] as const

/**
 * Dissolve the module canvas across a React commit.
 *
 * Keep-alive panes toggle `hidden`; without a snapshot pair that is a hard
 * cut. `flushSync` is required so the incoming pane is in the DOM before the
 * "new" snapshot is taken. The snapshot pair stays with the View Transition
 * API; the fade itself is a motion tween on the two snapshot pseudo-elements.
 * Reduced motion and a missing API fall through to the same mutate.
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
    const transition = document.startViewTransition(() => {
      flushSync(mutate)
    })
    // The snapshot pair is taken by the API. The fade runs once those
    // pseudo-elements exist; a test double without `ready` still snapped.
    const ready = transition.ready
    if (ready && typeof ready.then === "function") {
      void ready.then(() => {
        if (typeof document === "undefined") return
        fadeSnapshots()
      })
    }
  } catch {
    mutate()
  }
}

function fadeSnapshots() {
  const root = document.documentElement
  fade(root, "::view-transition-old(module-canvas)", [1, 0], 0.14, "easeIn")
  fade(root, "::view-transition-new(module-canvas)", [0, 1], 0.2, EASE_SETTLE)
}

function fade(
  root: HTMLElement,
  pseudoElement: string,
  opacity: [number, number],
  duration: number,
  ease: "easeIn" | readonly [number, number, number, number],
) {
  void animate(
    root,
    { opacity },
    { duration, ease, pseudoElement } as Parameters<typeof animate>[2],
  )
}

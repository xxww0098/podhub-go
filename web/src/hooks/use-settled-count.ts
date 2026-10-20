import { useEffect, useRef, useState } from "react"

/**
 * The authored moment of this product, expressed as one hook.
 *
 * On an effect ledger the only event is a figure changing: a Reconciliation
 * lands and "需 Reconciliation" falls by two while "已 Reconcile" rises by two.
 * That is the whole job, so that is the thing that gets motion. The figure
 * settles into its new value with the same exponential ease the lifecycle rail
 * uses, and the two figures move together because they are one fact.
 *
 * Mount is not news, so a first render never animates — otherwise every screen
 * entrance would counterfeit an event that did not happen.
 */
export function useSettledCount(value: number, duration = 520): number {
  const [display, setDisplay] = useState(value)
  const mounted = useRef(false)
  const frame = useRef<number>(0)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      setDisplay(value)
      return
    }

    if (
      typeof window === "undefined" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      setDisplay(value)
      return
    }

    let from = 0
    setDisplay((current) => {
      from = current
      return current
    })

    if (from === value) return

    const started = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration)
      // The tail of --ease-settle: fast departure, long quiet arrival.
      const eased = 1 - Math.pow(1 - t, 4)
      setDisplay(Math.round(from + (value - from) * eased))
      if (t < 1) frame.current = requestAnimationFrame(step)
    }

    frame.current = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame.current)
  }, [value, duration])

  return display
}

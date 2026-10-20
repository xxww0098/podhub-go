import { useLayoutEffect, useRef, useState, type UIEvent } from "react"

import { workbenchVisibleRange } from "./workbench-virtual-rows"

export type WorkbenchRowWindow = ReturnType<typeof workbenchVisibleRange>

/**
 * Visible-row window for the workbench table.
 *
 * The table renders only the rows inside the scroll viewport, so the window is
 * derived from the viewport geometry, refreshed when the element resizes, and
 * recomputed on scroll. Reaching the same window returns the current state so
 * React can skip the re-render.
 */
export function useWorkbenchRowWindow(rowCount: number) {
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const [rowWindow, setRowWindow] = useState<WorkbenchRowWindow>(() =>
    workbenchVisibleRange(rowCount, 0, 0),
  )

  useLayoutEffect(() => {
    const el = tableScrollRef.current
    setRowWindow(workbenchVisibleRange(rowCount, el?.scrollTop ?? 0, el?.clientHeight ?? 0))
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(() => {
      setRowWindow(workbenchVisibleRange(rowCount, el.scrollTop, el.clientHeight))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [rowCount])

  function onTableScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget
    const next = workbenchVisibleRange(rowCount, el.scrollTop, el.clientHeight)
    setRowWindow((current) =>
      current.start === next.start
        && current.end === next.end
        && current.top === next.top
        && current.bottom === next.bottom
        ? current
        : next,
    )
  }

  return { tableScrollRef, rowWindow, onTableScroll }
}

import { useEffect, useRef, useState, type RefObject } from "react"

/** Prefetch about ten 80px workbench rows so the two-slot queue stays ahead of scroll. */
const PREFETCH_MARGIN = "800px"

/**
 * Whether a workbench row is near the table's own scrollport.
 *
 * The table mounts every Product Instance so selection, editing and sticky
 * columns stay ordinary DOM. Image loading cannot: a thousand data-URL
 * thumbnails would fill the preview queue and the renderer heap. Rows
 * outside this window must not subscribe.
 */
export function useInTableView(): {
  rowRef: RefObject<HTMLTableRowElement | null>
  inView: boolean
} {
  const rowRef = useRef<HTMLTableRowElement>(null)
  const [inView, setInView] = useState(false)

  useEffect(() => {
    const row = rowRef.current
    if (!row) return
    const root = row.closest("[data-slot='table-container']")
    if (!(root instanceof Element) || typeof IntersectionObserver === "undefined") {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setInView(entry.isIntersecting)
      },
      { root, rootMargin: PREFETCH_MARGIN, threshold: 0 },
    )
    observer.observe(row)
    return () => observer.disconnect()
  }, [])

  return { rowRef, inView }
}

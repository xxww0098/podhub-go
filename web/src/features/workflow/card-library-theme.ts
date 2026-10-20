import { useEffect, useRef, useState } from "react"
import type { CategorySchemaView, ListingCardSummary } from "@/bindings/commands"
import { THEME_ATTRIBUTE_ID, fieldByAttributeId } from "./workflow-shared"

/** Theme probes leave the first paint, then run a few at a time. */
export const THEME_PROBE_LIMIT = 4

export function themeCoordinate(form: Pick<ListingCardSummary, "description_category_id" | "type_id" | "language">): string {
  return `${form.description_category_id}:${form.type_id}:${form.language}`
}

/**
 * Schedule schema reads for theme support after the current turn, and never
 * mark a coordinate until that timer actually fires. Cancelling (StrictMode's
 * remount, a new `forms` array) must leave the coordinate eligible.
 */
export function scheduleThemeProbes(options: {
  forms: readonly ListingCardSummary[]
  checked: Set<string>
  load: (form: ListingCardSummary) => Promise<CategorySchemaView>
  onResult: (coordinate: string, supported: boolean | null) => void
  limit?: number
}): () => void {
  let cancelled = false
  const timer = setTimeout(() => {
    if (cancelled) return
    const pending: ListingCardSummary[] = []
    for (const form of options.forms) {
      const coordinate = themeCoordinate(form)
      if (options.checked.has(coordinate)) continue
      options.checked.add(coordinate)
      pending.push(form)
    }
    void runQueue(pending)
  }, 0)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }

  async function runQueue(pending: ListingCardSummary[]) {
    const limit = Math.min(options.limit ?? THEME_PROBE_LIMIT, pending.length)
    if (limit === 0) return
    let cursor = 0
    async function worker() {
      while (!cancelled && cursor < pending.length) {
        const form = pending[cursor]
        cursor += 1
        if (!form) return
        const coordinate = themeCoordinate(form)
        try {
          const schema = await options.load(form)
          if (cancelled) return
          options.onResult(coordinate, Boolean(fieldByAttributeId(schema, THEME_ATTRIBUTE_ID)))
        } catch {
          if (cancelled) return
          options.onResult(coordinate, null)
        }
      }
    }
    await Promise.all(Array.from({ length: limit }, () => worker()))
  }
}

export function useDeferredThemeSupport(
  forms: readonly ListingCardSummary[],
  onLoadCardSchema: (form: ListingCardSummary) => Promise<CategorySchemaView>,
): {
  themeSupport: Record<string, boolean | null>
  noteThemeSupport: (coordinate: string, supported: boolean) => void
} {
  const [themeSupport, setThemeSupport] = useState<Record<string, boolean | null>>({})
  const checked = useRef(new Set<string>())
  const loadRef = useRef(onLoadCardSchema)
  loadRef.current = onLoadCardSchema
  useEffect(() => scheduleThemeProbes({
    forms,
    checked: checked.current,
    load: (form) => loadRef.current(form),
    onResult: (coordinate, supported) => {
      setThemeSupport((current) => ({ ...current, [coordinate]: supported }))
    },
  }), [forms])
  return {
    themeSupport,
    noteThemeSupport: (coordinate, supported) => {
      checked.current.add(coordinate)
      setThemeSupport((current) => ({ ...current, [coordinate]: supported }))
    },
  }
}

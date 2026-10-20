import { cn } from "@/lib/utils"

type IdCodeProps = {
  /** Short caption printed before the value, e.g. `Run`, `Task`, `Offer`. */
  prefix?: string
  value: string
  className?: string
  /** Longer identifiers wrap instead of forcing horizontal scroll. */
  wrap?: boolean
}

/**
 * Identifiers, hashes and fingerprints. Mono with tabular figures so a column of
 * them aligns, and `select-all` so one click grabs the whole value for a ticket.
 */
export function IdCode({ prefix, value, className, wrap = false }: IdCodeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1.5 font-mono text-xs text-muted-foreground",
        wrap ? "break-all" : "truncate",
        className
      )}
    >
      {prefix ? (
        <span className="shrink-0 font-sans text-meta text-faint-foreground">
          {prefix}
        </span>
      ) : null}
      <span className="select-all">{value}</span>
    </span>
  )
}

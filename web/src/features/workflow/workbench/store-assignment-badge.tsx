import type { CSSProperties, ReactNode } from "react"
import { cn } from "@/lib/utils"
import type { StoreTone } from "../store-tone"

/**
 * The store-assignment chip: the tone's dot and label on its badge palette.
 * A caller outside a tone-carrying ancestor (the send dialog) passes `style`
 * from `storeToneStyle`; the 发布状态 cell inherits the row's custom
 * properties instead and passes no style.
 */
export function StoreAssignmentBadge({
  tone,
  style,
  muted,
  ariaLabel,
  children,
}: {
  tone?: StoreTone
  style?: CSSProperties
  /** The toneless fallback: the muted cell chip or the card chip on the send dialog. */
  muted?: boolean
  ariaLabel?: string
  children: ReactNode
}) {
  return (
    <span
      style={style}
      aria-label={ariaLabel}
      className={cn(
        "inline-flex w-fit max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded border px-1.5 py-0.5 text-meta font-medium whitespace-nowrap",
        tone
          ? "store-assignment-badge"
          : muted
            ? "border-transparent bg-muted text-muted-foreground"
            : "border-transparent bg-card text-foreground",
      )}
    >
      {tone ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: "var(--store-tone)" }}
        />
      ) : null}
      {children}
    </span>
  )
}

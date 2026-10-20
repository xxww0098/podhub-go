import type { ReactNode } from "react"

import { cn } from "@/lib/utils"

type PageToolbarProps = {
  /** Left cluster: primary actions, filters, search. */
  primary?: ReactNode
  /** Right cluster: secondary / overflow actions. */
  secondary?: ReactNode
  className?: string
  children?: ReactNode
}

/**
 * One workbench ribbon. Left primary, right secondary, 8px between controls.
 * Always size="sm" buttons — do not stack a second bar under this.
 */
export function PageToolbar({
  primary,
  secondary,
  className,
  children,
}: PageToolbarProps) {
  const start = primary ?? children
  return (
    <div
      data-slot="page-toolbar"
      className={cn(
        "flex min-h-10 shrink-0 flex-wrap items-center gap-2",
        className,
      )}
    >
      {start ? (
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{start}</div>
      ) : (
        <div className="min-w-0 flex-1" />
      )}
      {secondary ? (
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {secondary}
        </div>
      ) : null}
    </div>
  )
}

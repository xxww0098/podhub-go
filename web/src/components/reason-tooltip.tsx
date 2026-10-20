import type { ReactElement } from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * Explains a disabled action: the reason rides a Tooltip, and the trigger
 * wrapper's native `title` carries the same text for environments where the
 * popover never opens. No reason → the child renders untouched.
 */
export function ReasonTooltip({
  reason,
  className,
  children,
}: {
  reason?: string
  className?: string
  children: ReactElement | null
}) {
  if (!reason || !children) return children
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={className ?? "inline-flex"} title={reason} />}>
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{reason}</TooltipContent>
    </Tooltip>
  )
}

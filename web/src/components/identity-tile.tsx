import type { LucideIcon } from "lucide-react"

import { cn } from "@/lib/utils"
import { TONE_TILE, toneFor, type StateTone } from "@/lib/receipt-state"

type IdentityTileProps = {
  icon: LucideIcon
  status?: string
  tone?: StateTone
  className?: string
  size?: "sm" | "default"
}

/**
 * The row's identity square. The reference uses these as brand decoration; here
 * the tint is the row's receipt tone, so a batch's health is legible from the
 * left edge before any text is read.
 */
export function IdentityTile({
  icon: Icon,
  status,
  tone,
  className,
  size = "default",
}: IdentityTileProps) {
  const resolved = tone ?? (status ? toneFor(status) : "idle")

  return (
    <span
      aria-hidden
      data-slot="identity-tile"
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md",
        size === "sm" ? "size-6" : "size-7",
        TONE_TILE[resolved],
        className
      )}
    >
      <Icon className={size === "sm" ? "size-3.5" : "size-4"} />
    </span>
  )
}

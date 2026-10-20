import { cn } from "@/lib/utils"
import { TONE_CHIP, TONE_SOLID, toneFor, type StateTone } from "@/lib/receipt-state"

type StateChipProps = {
  status: string
  label?: string
  tone?: StateTone
  className?: string
}

/**
 * One chip for every claim the ledger makes about an external effect.
 *
 * The `unknown` tone is the only one that carries a drawn hatch: Result Unknown
 * is neither an outcome nor an error, and a flat tint would let it read as a
 * minor warning next to a red failure.
 */
export function StateChip({ status, label, tone, className }: StateChipProps) {
  const resolved = tone ?? toneFor(status)

  return (
    <span
      data-slot="state-chip"
      data-tone={resolved}
      className={cn(
        "inline-flex h-5.5 w-fit shrink-0 items-center gap-1.5 rounded-full border px-2 text-meta leading-none font-medium whitespace-nowrap transition-colors duration-150 ease-settle",
        TONE_CHIP[resolved],
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full transition-colors duration-150 ease-settle",
          TONE_SOLID[resolved]
        )}
      />
      {label ?? status}
    </span>
  )
}

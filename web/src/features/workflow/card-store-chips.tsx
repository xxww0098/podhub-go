import type { OzonStoreView } from "@/bindings/commands"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { cardStoreAvailability } from "./store-availability"
import { parseStoreIds } from "./store-quota"

const VISIBLE_STORE_CHIPS = 2

export function cardStoreChipLabels(
  storeIdString: string,
  stores: readonly OzonStoreView[],
): { id: string; label: string }[] {
  return parseStoreIds(storeIdString).map((id) => ({
    id,
    label: stores.find((store) => store.id === id)?.label?.trim() || id,
  }))
}

/** Nowrap store chips for a Listing Card; overflow is a +N title, never wrap pills. */
export function CardStoreChips({
  storeIdString,
  stores,
  className,
}: {
  storeIdString: string
  stores: readonly OzonStoreView[]
  className?: string
}) {
  const chips = cardStoreChipLabels(storeIdString, stores)
  const availability = cardStoreAvailability(storeIdString, stores)
  if (!chips.length) {
    return (
      <p className={cn("truncate text-meta text-muted-foreground", className)}>
        {availability.label}
      </p>
    )
  }
  const visible = chips.slice(0, VISIBLE_STORE_CHIPS)
  const hidden = chips.slice(VISIBLE_STORE_CHIPS)
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap",
        className,
      )}
      data-testid="card-store-chips"
    >
      {visible.map((chip) => (
        <Badge key={chip.id} variant="outline" className="max-w-[6.5rem] truncate">
          {chip.label}
        </Badge>
      ))}
      {hidden.length ? (
        <Badge variant="outline" title={hidden.map((chip) => chip.label).join("、")}>
          +{hidden.length}
        </Badge>
      ) : null}
      {availability.issue ? (
        <span
          className="truncate text-meta text-muted-foreground"
          title={availability.issue.description}
        >
          {availability.issue.title}
        </span>
      ) : null}
    </div>
  )
}

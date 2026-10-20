import type { ListingCardSummary } from "@/bindings/commands"
import { listingHttp } from "@/bindings/http-listing"
import { createSessionCache } from "@/lib/session-cache"

/**
 * The listing library's card list. Reopening the screen within a minute
 * reuses this snapshot; a card write drops it so the next read cannot paint
 * a list from before the mutation. Concurrent readers share one GET.
 */
export const LISTING_CARD_LIST_TTL_MS = 60_000

const KEY = ""

const cache = createSessionCache<ListingCardSummary[]>(
  () => listingHttp.listingCardListSavedDrafts(),
  { ttlMs: LISTING_CARD_LIST_TTL_MS },
)

export function loadListingCardList(options?: { force?: boolean }): Promise<ListingCardSummary[]> {
  return cache.load(KEY, options)
}

/** A card create, copy, delete or payload write happened. The next read refetches. */
export function invalidateListingCardList(): void {
  cache.invalidate()
}

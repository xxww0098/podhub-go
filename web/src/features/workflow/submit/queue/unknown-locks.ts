import type { PublishOfferLock } from "../../rows/types"

export function offerLocked(locks: readonly PublishOfferLock[], platform: string, destination: string, offerId: string): boolean {
  return locks.some((lock) => lock.platform === platform && lock.destination === destination && lock.offerId === offerId)
}

/** Reading superseded alone cannot release a lock. Exact release receipt AND a full current read are required. */
export function releaseOfferLock(
  locks: readonly PublishOfferLock[], captured: PublishOfferLock,
  releasedIds: readonly string[], current: { complete: boolean; unresolvedIntentIds: readonly string[] },
): PublishOfferLock[] {
  if (!captured.intentId || !releasedIds.includes(captured.intentId) || !current.complete || current.unresolvedIntentIds.length > 0) return [...locks]
  return locks.filter((lock) => !(lock.platform === captured.platform && lock.destination === captured.destination
    && lock.offerId === captured.offerId && lock.rowId === captured.rowId && lock.intentId === captured.intentId))
}

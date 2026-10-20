import {
  subscribeListingWorkbench,
  type ListingWorkbenchRuntime,
} from "../workbench/listing-workbench-store"

const SEND_COHORT = new Set<string>(["queued", "submitting"])

/** True when this snapshot still has a row Cloud has not finished accepting. */
export function cohortInFlight(
  state: Pick<ListingWorkbenchRuntime, "rows" | "productBases">,
): boolean {
  return state.rows.some((row) =>
    SEND_COHORT.has(state.productBases[row.draftId]?.lifecycle.stage ?? ""))
}

/**
 * The open card just lost its last queued/submitting row while the workbench
 * still says the send queue is running.
 *
 * A card that has not loaded rows yet has no cohort to leave, so that
 * snapshot must not unlock the queue. A later card, or a new workbench
 * scope, is not this cohort either.
 */
export function queueDrained(
  previous: ListingWorkbenchRuntime,
  current: ListingWorkbenchRuntime,
): boolean {
  if (!current.queueRunning) return false
  if (!current.cardId || previous.cardId !== current.cardId) return false
  if (previous.scope !== current.scope) return false
  if (previous.rows.length === 0) return false
  return cohortInFlight(previous) && !cohortInFlight(current)
}

/** Re-derive only on the in-flight → empty edge. Returns the unsubscribe. */
export function watchQueueDrain(rederive: (scope: number) => void): () => void {
  return subscribeListingWorkbench((current, previous) => {
    if (!previous || !queueDrained(previous, current)) return
    rederive(current.scope)
  })
}

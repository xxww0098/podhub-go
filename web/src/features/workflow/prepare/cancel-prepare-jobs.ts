import { listingHttp } from "@/bindings/http-listing"
import { mapLimit } from "../source-batch"

/** Draft ids that may still have Cloud prepare jobs to soft-cancel. */
export function normalizePrepareCancelDraftIds(
  draftIds: readonly string[],
): string[] {
  return [
    ...new Set(
      draftIds.map((id) => id.trim()).filter((id) => id.length > 0),
    ),
  ]
}

/**
 * Cancel Cloud prepare jobs (`ai.recognize` / `media.render` / `media.upload`) for the
 * given listing rows. Local prepare lanes must still be stopped by the caller.
 */
export async function cancelPrepareJobsForDrafts(
  draftIds: readonly string[],
): Promise<{ attempted: number; cancelled: number }> {
  const ids = normalizePrepareCancelDraftIds(draftIds)
  // Cloud cancels one row per request. Stop sends them together — three in
  // flight, the intent-cancel bound — not each behind the last round trip.
  const outcomes = await mapLimit(ids, 3, (id) => listingHttp.operationsCancelPrepare({ draft_ids: [id] }))
  return {
    attempted: outcomes.reduce((sum, outcome) => sum + outcome.attempted, 0),
    cancelled: outcomes.reduce((sum, outcome) => sum + outcome.cancelled, 0),
  }
}

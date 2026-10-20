/**
 * Which rows are inside a preparation verb right now, per verb.
 *
 * 全部识别 / 全部切片 / 全部上传 are three independent verbs and the operator
 * may run them at the same time. AI, render and delivery each hold their own
 * lane, and one Product's lifecycle keeps `ai` and `media` on separate tracks
 * so a recognition and a render can land on the same row without either
 * overwriting the other.
 *
 * The same row must not be admitted twice into the same lifecycle track.
 * `RenderStarted` clears the slice list that `DeliveryStarted` requires, so
 * slicing and uploading one row at once is the single overlap refused —
 * 切片 and 上传 therefore share one track here, while 识别 has its own.
 *
 * The claim cannot live on `ListingRow`: every verb settles a row by re-reading
 * the ListingRowView (`projectListingRowLifecycle`), so a settle from one verb
 * would clear a flag the other verb is still relying on. It also has to be
 * readable synchronously — two clicks in one React tick must not both admit the
 * same row — which is why the registry is a plain mutable object behind a ref
 * and the snapshot is what rendering reads.
 */

/** The three preparation verbs, each with exactly one toolbar entry point. */
export type PreparationVerb = "ai" | "render" | "deliver"

/** Rows inside each verb. Empty sets mean no preparation is running. */
export type PreparationActivity = {
  ai: ReadonlySet<string>
  render: ReadonlySet<string>
  deliver: ReadonlySet<string>
}

/**
 * Operator-facing progress for the most recent batch of each verb.
 *
 * Activity answers which rows are fenced right now. Progress answers the
 * different question the toolbar needs: how much of the batch the operator
 * clicked has settled, including failures. Keeping both prevents a running
 * 10-row batch from being rendered as the misleading "0 targets / 10 busy".
 */
export type PreparationBatchProgress = {
  total: number
  settled: number
  failed: number
  failedRowIds: string[]
  active: boolean
  startedAtMs?: number
  /** How many callers still hold this batch open. See `openBatchProgress`. */
  open?: number
}

export type PreparationProgress = Record<
  PreparationVerb,
  PreparationBatchProgress | undefined
>

/** One-click preparation pipelines the three existing prepare lanes. */
export type GuidedPreparation = {
  active: boolean
  total: number
  rowIds: readonly string[]
  stopRequested: boolean
  stopMessage?: string
  stopFailed?: boolean
}

export const NO_PREPARATION_PROGRESS: PreparationProgress = {
  ai: undefined,
  render: undefined,
  deliver: undefined,
}

/** Keep only lanes that are still running. Finished leftovers must not resurrect. */
export function retainActivePreparationProgress(
  progress: PreparationProgress,
): PreparationProgress {
  return {
    ai: progress.ai?.active ? progress.ai : undefined,
    render: progress.render?.active ? progress.render : undefined,
    deliver: progress.deliver?.active ? progress.deliver : undefined,
  }
}

/**
 * Open `verb`'s slot for `total` more rows.
 *
 * Guided preparation pipelines delivery — one Product uploads while the next is
 * still on the render slot — so a single run opens the deliver slot once per
 * row. Every open taken while the slot is still active extends the batch the
 * operator is already watching. Replacing it instead would count row 1's settle
 * against row 2's batch, close the live card while rows 3..N are still
 * uploading, and leave the retry button holding one failed row out of thirty.
 */
export function openBatchProgress(
  progress: PreparationProgress,
  verb: PreparationVerb,
  total: number,
  startedAtMs: number,
): PreparationProgress {
  const batch = progress[verb]
  return {
    ...progress,
    [verb]: batch?.active
      ? { ...batch, total: batch.total + total, open: (batch.open ?? 1) + 1 }
      : {
          total,
          settled: 0,
          failed: 0,
          failedRowIds: [],
          active: true,
          startedAtMs,
          open: 1,
        },
  }
}

/** Count one row out of its batch, failed or not. */
export function settleBatchProgress(
  progress: PreparationProgress,
  verb: PreparationVerb,
  rowId: string,
  failed: boolean,
): PreparationProgress {
  const batch = progress[verb]
  if (!batch) return progress
  return {
    ...progress,
    [verb]: {
      ...batch,
      settled: Math.min(batch.total, batch.settled + 1),
      failed: batch.failed + (failed ? 1 : 0),
      failedRowIds: failed ? [...batch.failedRowIds, rowId] : batch.failedRowIds,
    },
  }
}

/** Release one opener. The batch goes inactive when the last one lets go. */
export function closeBatchProgress(
  progress: PreparationProgress,
  verb: PreparationVerb,
): PreparationProgress {
  const batch = progress[verb]
  if (!batch) return progress
  const open = Math.max(0, (batch.open ?? 1) - 1)
  return { ...progress, [verb]: { ...batch, open, active: open > 0 } }
}

export const NO_GUIDED_PREPARATION: GuidedPreparation = {
  active: false,
  total: 0,
  rowIds: [],
  stopRequested: false,
}

const EMPTY: ReadonlySet<string> = new Set()

export const NO_PREPARATION_ACTIVITY: PreparationActivity = {
  ai: EMPTY,
  render: EMPTY,
  deliver: EMPTY,
}

/**
 * Is this row already inside the lifecycle track the verb would take? 切片 and
 * 上传 answer for each other, because they are the same `media` track.
 */
export function trackBusy(
  activity: PreparationActivity,
  verb: PreparationVerb,
  rowId: string,
): boolean {
  return verb === "ai"
    ? activity.ai.has(rowId)
    : activity.render.has(rowId) || activity.deliver.has(rowId)
}

/** Any verb still holding rows. Card-wide edits wait for this to clear. */
export function preparationRunning(activity: PreparationActivity): boolean {
  return activity.ai.size > 0 || activity.render.size > 0 || activity.deliver.size > 0
}

/**
 * Is any verb still working on this row? Clear-content waits for this so a
 * receipt cannot land on generated fields that were just wiped. Delete does
 * not: a row with work in flight is still removable.
 */
export function rowPreparing(
  activity: PreparationActivity,
  rowId: string,
): boolean {
  return (
    activity.ai.has(rowId) || activity.render.has(rowId) || activity.deliver.has(rowId)
  )
}

export type PreparationTracks = {
  /**
   * Take the track for these rows and return the ones actually admitted. A row
   * whose track is already held is refused here rather than sent to Cloud,
   * where it would come back as a lifecycle rejection on a row the operator
   * never asked to touch twice.
   */
  claim: (verb: PreparationVerb, rowIds: readonly string[]) => string[]
  /** Idempotent: a row released by its settle is not released twice. */
  release: (verb: PreparationVerb, rowIds: readonly string[]) => void
  snapshot: () => PreparationActivity
  /** Publish immediately, then on claims/releases, until this view unsubscribes. */
  subscribe: (listener: (activity: PreparationActivity) => void) => () => void
}

const activeCardTracks = new Map<string, PreparationTracks>()

/** Only cards with live claims stay here; revisiting one retains its admission fence.
 * Registration is eager: deferring it to the first claim let two lookups
 * before any claim (StrictMode double mount) build independent `held` sets
 * that both admit the same row. */
export function preparationTracksForCard(cardId: string): PreparationTracks {
  const existing = activeCardTracks.get(cardId)
  if (existing) return existing
  const tracks = createPreparationTracks(cardId)
  activeCardTracks.set(cardId, tracks)
  return tracks
}

export function createPreparationTracks(cardId?: string): PreparationTracks {
  const listeners = new Set<(activity: PreparationActivity) => void>()
  const publish = () => {
    const activity = tracks.snapshot()
    for (const listener of listeners) listener(activity)
  }
  const held: Record<PreparationVerb, Set<string>> = {
    ai: new Set(),
    render: new Set(),
    deliver: new Set(),
  }
  const tracks: PreparationTracks = {
    claim: (verb, rowIds) => {
      const admitted: string[] = []
      for (const rowId of rowIds) {
        if (trackBusy(held, verb, rowId)) continue
        held[verb].add(rowId)
        admitted.push(rowId)
      }
      if (admitted.length) publish()
      return admitted
    },
    release: (verb, rowIds) => {
      let changed = false
      for (const rowId of rowIds) if (held[verb].delete(rowId)) changed = true
      if (cardId && !preparationRunning(held) && activeCardTracks.get(cardId) === tracks) activeCardTracks.delete(cardId)
      if (changed) publish()
    },
    snapshot: () => ({
      ai: new Set(held.ai),
      render: new Set(held.render),
      deliver: new Set(held.deliver),
    }),
    subscribe(listener) {
      listeners.add(listener)
      listener(tracks.snapshot())
      return () => { listeners.delete(listener) }
    },
  }
  return tracks
}

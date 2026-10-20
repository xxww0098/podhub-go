/**
 * Local source recovery for the open Listing Card.
 *
 * A row keeps `lifecycle.source_asset_handle` — the exact `{sha256}/{fileName}`
 * its import filed — even when this device no longer holds the bytes (another
 * browser, a cleared or evicted OPFS). Re-picking that very file stages the
 * same identity, so the row only needs its local `source` back: no Cloud
 * write, no new row, and nothing starts. Recognition, slicing, upload and send
 * stay on the operator's own verbs and their existing fences.
 *
 * Identity is exact. Same name with other bytes, or the same bytes under
 * another name, is a different handle and restores nothing — it imports as a
 * new file, as any unknown file does.
 */
import type { StagedSource } from "./source-import-actions"
import type { ListingRow } from "./model/listing-row"
import { patchListingWorkbench, peekListingWorkbench } from "./workbench/listing-workbench-store"

/** A picked file some loaded row already carries; `restoredRows` of them were missing it. */
export type SourceRecovery = { restoredRows: number }

const RESTORED_SOURCE_LOG = "已重新导入本地源图，未自动开始准备"

/**
 * Restore every loaded row of `cardId` whose handle one of `staged` carries,
 * in one workbench commit, and only while `scope` is still the open one.
 * Results line up with `staged`; `undefined` means no loaded row carries that
 * file, so it is new. A file picked twice counts its rows once.
 *
 * Only `source` and the row's one-line log change. Row and draft identity,
 * dirty edits, candidates, lifecycle (Unknown included), media, status,
 * selection and queue membership are left exactly as they were.
 */
export function recoverStagedSources(
  staged: readonly (StagedSource | undefined)[],
  fence: { cardId: string, scope: number },
): Array<SourceRecovery | undefined> {
  const recoveries = Array.from<SourceRecovery | undefined>({ length: staged.length })
  const current = peekListingWorkbench()
  if (current.scope !== fence.scope || current.cardId !== fence.cardId) return recoveries
  const wanted = new Map<string, StagedSource>()
  for (const source of staged) if (source && !wanted.has(source.handle)) wanted.set(source.handle, source)
  const restoredByHandle = new Map<string, number>()
  let changed = false
  const rows = current.rows.map((row): ListingRow => {
    const base = current.productBases[row.draftId]
    const handle = base?.parent_card_id === fence.cardId ? base.lifecycle.source_asset_handle : undefined
    const source = handle ? wanted.get(handle) : undefined
    if (!handle || !source || current.pendingRemovalIds.has(row.draftId)) return row
    const restored = restoredByHandle.get(handle) ?? 0
    // Already showing this exact source: reuse it, nothing to restore.
    if (row.source?.handle === handle) {
      restoredByHandle.set(handle, restored)
      return row
    }
    restoredByHandle.set(handle, restored + 1)
    changed = true
    return { ...row, source: { handle, file_name: source.fileName }, log: RESTORED_SOURCE_LOG }
  })
  const counted = new Set<string>()
  for (const [index, source] of staged.entries()) {
    const restored = source ? restoredByHandle.get(source.handle) : undefined
    if (!source || restored === undefined) continue
    recoveries[index] = { restoredRows: counted.has(source.handle) ? 0 : restored }
    counted.add(source.handle)
  }
  // Synchronous with the read above, so no other writer can interleave.
  if (changed) patchListingWorkbench({ rows }, fence.scope)
  return recoveries
}

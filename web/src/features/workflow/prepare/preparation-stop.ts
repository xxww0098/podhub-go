import type { RefObject } from "react"
import { errorMessage } from "@/lib/error-message"
import {
  listingScopeCurrent,
  listingWorkbenchScope,
  patchListingWorkbench,
  peekListingWorkbench,
} from "../workbench/listing-workbench-store"
import { workflowActions } from "../workflow-actions"
import { cancelPrepareJobsForDrafts } from "./cancel-prepare-jobs"
import { cancelablePrepareDraftIds } from "./execution-context"
import type { PrepareWork } from "./preparation-batch"
import type { createPreparationTracks } from "./preparation-tracks"

/** The hook-owned refs one Stop reads: live batches, claims and pending cohorts. */
type PreparationStopContext = {
  preparationTracks: RefObject<ReturnType<typeof createPreparationTracks>>
  activeWork: RefObject<Set<PrepareWork>>
  /** Each cohort's Stop still settling, keyed by workbench scope and sorted draft ids. */
  pendingStops: RefObject<Map<string, Promise<void>>>
  stopAttempt: RefObject<number>
}

/**
 * Stop the guided run, else the ticked rows, else every row still preparing:
 * mark their unstarted pins in every local batch, stop the browser executor,
 * and cancel their Cloud prepare jobs. Requests already sent still settle.
 */
export function stopPreparationCohort({
  preparationTracks,
  activeWork,
  pendingStops,
  stopAttempt,
}: PreparationStopContext): Promise<void> {
  const scope = listingWorkbenchScope()
  const workbench = peekListingWorkbench()
  const guidedIds = new Set(workbench.guidedPreparation.rowIds)
  const preparing = preparationTracks.current.snapshot()
  const preparingRowIds = new Set([
    ...preparing.ai,
    ...preparing.render,
    ...preparing.deliver,
  ])
  const selected = new Set(workbench.selectedIds)
  const selectedIds = selected.size
    ? workbench.rows
        .filter((row) => selected.has(row.id))
        .map((row) => row.draftId)
    : []
  const draftIds = (
    guidedIds.size
      ? workbench.rows
          .filter((row) => guidedIds.has(row.id))
          .map((row) => row.draftId)
      : selectedIds.length
        ? selectedIds
        : workbench.rows
            .filter((row) => preparingRowIds.has(row.id))
            .map((row) => row.draftId)
  ).filter(Boolean)
  // Marking local batches is idempotent, so every click does it: a batch
  // admitted after an earlier Stop must not start these rows either.
  for (const work of activeWork.current) {
    for (const id of draftIds) if (work.draftIds.has(id)) work.cancelled.add(id)
  }
  // The same cohort in the same scope joins the Stop still settling: no second
  // local stop or Cloud cancel scan, and the first attempt's receipt answers
  // both. The entry is claimed before either stop starts and removed only by
  // its own settle, so an older finally never frees another cohort's entry.
  const key = JSON.stringify([scope, [...draftIds].sort()])
  const pending = pendingStops.current.get(key)
  if (pending) return pending
  let settle!: () => void
  const stopping = new Promise<void>((resolve) => { settle = resolve })
  pendingStops.current.set(key, stopping)
  const attempt = ++stopAttempt.current
  const stoppingIds = new Set(draftIds)
  const activeRows = workbench.rows.filter(row => preparingRowIds.has(row.id))
  const stoppingAll = activeRows.length === preparingRowIds.size
    && activeRows.every(row => stoppingIds.has(row.draftId))
  patchListingWorkbench((current) => ({
    guidedPreparation: {
      ...current.guidedPreparation,
      stopRequested: stoppingAll,
      stopMessage: undefined,
      stopFailed: false,
    },
  }))
  const localStop = workflowActions.workflowAnalyzeAssetsStop(draftIds).catch((reason) => {
    if (!listingScopeCurrent(scope) || attempt !== stopAttempt.current) return
    patchListingWorkbench((current) => ({
      guidedPreparation: {
        ...current.guidedPreparation,
        stopMessage: errorMessage(reason, "停止请求未送达；准备仍在继续，请重试。"),
        stopFailed: true,
      },
    }))
  })
  const cloudCancel = cancelPrepareJobsForDrafts(cancelablePrepareDraftIds(draftIds))
    .then(({ cancelled }) => {
      if (!listingScopeCurrent(scope) || attempt !== stopAttempt.current) return
      patchListingWorkbench((current) => {
        if (current.guidedPreparation.stopFailed) return {}
        return {
          guidedPreparation: {
            ...current.guidedPreparation,
            stopMessage: cancelled > 0
              ? `已停止后续准备，并取消 ${cancelled} 个 Cloud 准备作业；已发出的请求会结算，未开始的商品不会消耗 AI 额度。`
              : "已停止后续准备；已发出的请求会结算，未开始的商品不会消耗 AI 额度。",
            stopFailed: false,
          },
        }
      })
    })
    .catch((reason) => {
      if (!listingScopeCurrent(scope) || attempt !== stopAttempt.current) return
      patchListingWorkbench((current) => ({
        guidedPreparation: {
          ...current.guidedPreparation,
          stopMessage: errorMessage(
            reason,
            "本地准备已停止，但 Cloud 准备作业取消失败；云端作业可能仍在跑，请重试停止。",
          ),
          stopFailed: true,
        },
      }))
    })
  // A settled failure leaves the cohort free, so the next click retries it.
  void Promise.allSettled([localStop, cloudCancel]).then(() => {
    if (pendingStops.current.get(key) === stopping) pendingStops.current.delete(key)
    settle()
  })
  return stopping
}

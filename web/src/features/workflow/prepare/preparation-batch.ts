import { readOcrModelChoice, routingForNewTask } from "./ocr-model-preference"
import { peekOcrCatalogue, type PreparationRequest } from "./ocr-model-routing"
import { batchErrorFeedback } from "../batch-error-feedback"
import type { RefObject } from "react"
import type { WorkflowOperationRowResult } from "@/bindings/commands"
import { notifyError } from "@/lib/notify"
import { preparationOpen, type BatchRowDeps } from "../batch-actions"
import { openCardSession } from "../card/card-session"
import type { ListingRow } from "../model/listing-row"
import { listingRowLifecyclePatch } from "../model/listing-row-lifecycle"
import {
  listingScopeCurrent,
  listingWorkbenchScope,
  patchListingWorkbench,
  peekListingWorkbench,
  projectListingRows,
} from "../workbench/listing-workbench-store"
import { commitProductStatus, refreshProductStatus } from "../workbench/product-status"
import {
  closeBatchProgress,
  NO_GUIDED_PREPARATION,
  openBatchProgress,
  settleBatchProgress,
  type createPreparationTracks,
  type PreparationActivity,
  type PreparationTracks,
  type PreparationVerb,
} from "./preparation-tracks"

export function lifecycleForRow(row: ListingRow) {
  return peekListingWorkbench().productDrafts[row.draftId]?.lifecycle
}

function patchRow(rowId: string, patch: Partial<ListingRow>) {
  projectListingRows((current) =>
    current.map((row) => (row.id === rowId ? { ...row, ...patch } : row)),
  )
}

export function startRows(rowIds: readonly string[], patch: Partial<ListingRow>) {
  const targeted = new Set(rowIds)
  projectListingRows((current) =>
    current.map((row) => (targeted.has(row.id) ? { ...row, ...patch } : row)),
  )
}

/** Fail only the admitted image set; one receipt and one batch count per image. */
export function failPreparationRows(targets: readonly ListingRow[], reason: unknown, fallback: string, patch: Partial<ListingRow>, stage: string): string[] {
  const feedback = batchErrorFeedback(patchRow, { stage, cardId: peekListingWorkbench().cardId })
  return targets.map((row) => {
    patchRow(row.id, patch)
    const receipt = feedback.settle(row, true, reason, fallback)!
    return `${row.imageName}：${receipt.summary}`
  })
}

/** Settle a preparation step: refresh from Cloud, or retain its last state. */
async function settlePreparedRow(row: ListingRow, log: string) {
  const scope = listingWorkbenchScope()
  if (await refreshProductStatus(row, log, scope)) return
  if (!listingScopeCurrent(scope)) return
  const lifecycle = lifecycleForRow(row)
  patchRow(row.id, { ...(lifecycle ? listingRowLifecyclePatch(lifecycle) : {}), log })
}

function reportBatchFailures(failures: string[], verb: string) {
  if (!failures.length) return
  notifyError(`${failures.length} 个商品${verb}失败`, {
    description: "查看各图片的错误详情。",
    reason: { code: "preparation_failed" },
    context: {
      stage: "prepare",
      cardId: peekListingWorkbench().cardId,
      refusalReason: "preparation_failed",
      media: { blockedRows: failures.length },
    },
    timeout: 20_000,
  })
}

export type PrepareWork = {
  modelRouting?: import("./ocr-model-routing").OcrModelRouting
  tracks: PreparationTracks
  draftIds: Set<string>
  cancelled: Set<string>
}

/** The hook-owned refs the batch coordinator reads and writes. */
type PreparationBatchContext = {
  /** Undefined only in tests that never touch a supplier verb; the screen always has one. */
  cardId?: string
  preparationTracks: RefObject<ReturnType<typeof createPreparationTracks>>
  guidedPreparationLock: RefObject<boolean>
  activeWork: RefObject<Set<PrepareWork>>
  /** Failure lines waiting for their batch's last opener to let go, per verb. */
  pendingFailures: RefObject<Record<PreparationVerb, string[]>>
  pendingFailureScope: RefObject<ReturnType<typeof listingWorkbenchScope>>
}

export type PreparationBatch = ReturnType<typeof preparationBatch>

/**
 * Row bookkeeping and the queue fence every batch verb shares: claims,
 * progress counters, per-row settles and the batch's single failure toast.
 * 识别 / 切片 / 上传 hold rows, not each other — the claim registry inside
 * `preparationTracks` is the fence a second click reads synchronously.
 */
export function preparationBatch({
  cardId,
  preparationTracks,
  guidedPreparationLock,
  activeWork,
  pendingFailures,
  pendingFailureScope,
}: PreparationBatchContext) {
  /**
   * What still stops a preparation verb: the send queue owns every row while it
   * runs. Another preparation verb does not — 识别 / 切片 / 上传 have separate
   * lanes and separate lifecycle tracks, so they overlap by design and
   * only the rows one of them already claimed leave the others' scope
   * (`preparation-tracks.ts`).
   */
  function preparationBlocked(): boolean {
    if (peekListingWorkbench().queuePaused || peekListingWorkbench().queueRunning) {
      notifyError("队列运行或暂停期间不能运行商品准备。")
      return true
    }
    return false
  }

  /** Take a verb's track for the rows it admitted, and publish it to the UI. */
  function claimPreparation(verb: PreparationVerb, rowIds: readonly string[]): string[] {
    return preparationTracks.current.claim(verb, rowIds)
  }

  /**
   * The open card's supplier verification, cached for the whole session
   * (`CardSession.verifySupplierOnce`) — 打开/识别/切片/上传/发送 collapse
   * into one `POST .../verify` instead of one per verb click. `cardId` is
   * absent only in fixtures that never exercise a supplier verb.
   */
  async function verifySupplierMedia() {
    if (!cardId) return undefined
    const session = await openCardSession(cardId)
    return session.verifySupplierOnce()
  }

  function beginPreparationBatch(verb: PreparationVerb, rowIds: readonly string[]) {
    patchListingWorkbench((current) => ({
      preparationProgress: openBatchProgress(
        current.preparationProgress,
        verb,
        rowIds.length,
        Date.now(),
      ),
    }))
  }

  function settlePreparationBatch(
    verb: PreparationVerb,
    rowId: string,
    failed: boolean,
  ) {
    patchListingWorkbench((current) => ({
      preparationProgress: settleBatchProgress(
        current.preparationProgress,
        verb,
        rowId,
        failed,
      ),
    }))
  }

  /**
   * Let go of one opener, and report the batch's failures once the last one
   * does. Guided delivery opens the deliver slot per row, so reporting inside
   * each call would stack one toast per failed upload.
   */
  function finishPreparationBatch(
    verb: PreparationVerb,
    failures: string[],
    label: string,
  ) {
    pendingFailures.current[verb].push(...failures)
    const { preparationProgress } = patchListingWorkbench((current) => ({
      preparationProgress: closeBatchProgress(current.preparationProgress, verb),
    }))
    if (preparationProgress[verb]?.active) return
    reportBatchFailures(pendingFailures.current[verb].splice(0), label)
  }

  /**
   * A row leaves the verb's track the moment its own settle lands, not when the
   * whole batch does — that is what lets 全部上传 pick up the products 全部切片
   * has already finished while the rest of the batch is still on the render
   * slot. `outstanding` is this batch's own share of the track: a row released
   * here is struck off it, so the batch's closing release can never free a row
   * the next click has already claimed.
   */
  function beginPrepareWork(targets: readonly ListingRow[]) {
    const work: PrepareWork = { tracks: preparationTracks.current, draftIds: new Set(targets.map(row => row.draftId)), cancelled: new Set() }
    // Freeze before any await: later card edits must not change queued rows in this batch.
    // 系统默认 has no primary yet — pin the catalogue default onto this task, still without a backup.
    const preference = peekListingWorkbench().modelRouting ?? readOcrModelChoice()
    const routing = routingForNewTask(preference, peekOcrCatalogue())
    work.modelRouting = routing ? { ...routing } : undefined
    activeWork.current.add(work)
    startRows(targets.map(row => row.id), { errorFeedback: undefined })
    if (pendingFailureScope.current !== listingWorkbenchScope()) {
      pendingFailureScope.current = listingWorkbenchScope()
      pendingFailures.current = { ai: [], render: [], deliver: [] }
    }
    if (!guidedPreparationLock.current) {
      patchListingWorkbench((current) =>
        current.guidedPreparation.active
          ? {}
          : { guidedPreparation: { ...NO_GUIDED_PREPARATION } },
      )
    }
    return work
  }

  function prepareAction(work: PrepareWork, action: (
    request: PreparationRequest, onRow: (row: WorkflowOperationRowResult) => void,
  ) => Promise<WorkflowOperationRowResult[]>) {
    return async (request: PreparationRequest, onRow: (row: WorkflowOperationRowResult) => void) => {
      const row_ids = request.row_ids.filter(id => !work.cancelled.has(id))
      const skipped = request.row_ids.filter(id => work.cancelled.has(id))
      const expected_revisions = request.expected_revisions.filter(pin => !work.cancelled.has(pin.row_id))
      const results = row_ids.length ? await action({ ...request, row_ids, expected_revisions, modelRouting: work.modelRouting }, onRow) : []
      return [...results, ...skipped.map(row_id => ({ row_id, outcome: "noop" as const, blockers: [], noop_reason: "cancelled" }))]
    }
  }

  function batchRowDeps(
    verb: PreparationVerb,
    outstanding: Set<string>,
    work: PrepareWork,
  ): BatchRowDeps {
    const scope = listingWorkbenchScope()
    return {
      feedbackContext: { stage: verb === "deliver" ? "upload" : verb, cardId },
      drafts: () => peekListingWorkbench().productDrafts,
      patchRow,
      startRows,
      commitProduct: (draftId, status) => { commitProductStatus(draftId, status, scope) },
      stopRequested: () => [...work.draftIds].every(id => work.cancelled.has(id)),
      settleProgress: (rowId, failed) => {
        if (outstanding.delete(rowId)) {
          if (listingScopeCurrent(scope)) settlePreparationBatch(verb, rowId, failed)
          work.tracks.release(verb, [rowId])
        }
      },
      settleRow: async (row, log, failed) => {
        try {
          if (listingScopeCurrent(scope)) await settlePreparedRow(row, log)
        } finally {
          if (outstanding.delete(row.id)) {
            if (listingScopeCurrent(scope)) settlePreparationBatch(verb, row.id, failed)
            work.tracks.release(verb, [row.id])
          }
        }
      },
    }
  }

  /**
   * The claimed rows a batch may still start after an await (template restore,
   * supplier verification). Claims are taken synchronously, but the row can be
   * sealed — accepted / Unknown / attested — while the batch waits, and Cloud
   * refuses to touch a sealed row. Those rows leave the batch here, before any
   * row is started or any request is planned: settled as not failed, since
   * nothing ran on them, and their claim released. The rest keep their claim
   * until their own settle.
   */
  function admitOpenTargets(
    verb: PreparationVerb,
    targets: readonly ListingRow[],
    outstanding: Set<string>,
    work: PrepareWork,
    scope: number,
  ): ListingRow[] {
    const open: ListingRow[] = []
    for (const target of targets) {
      if (preparationOpen(lifecycleForRow(target))) {
        open.push(target)
        continue
      }
      if (outstanding.delete(target.id)) {
        if (listingScopeCurrent(scope)) settlePreparationBatch(verb, target.id, false)
        work.tracks.release(verb, [target.id])
      }
    }
    return open
  }

  /** Free whatever this batch still holds — the rows that never settled. */
  function closePreparationBatch(verb: PreparationVerb, outstanding: Set<string>, work: PrepareWork, scope: number) {
    const remaining = [...outstanding]
    outstanding.clear()
    if (listingScopeCurrent(scope)) for (const rowId of remaining) settlePreparationBatch(verb, rowId, true)
    work.tracks.release(verb, remaining)
    activeWork.current.delete(work)
  }

  /**
   * The rows a verb may start on, taken and fenced in one synchronous step.
   *
   * The workbench store rather than rendered props: two clicks inside one React
   * tick see the same stale render, and the claim registry is what makes the
   * second one admit nothing instead of spending a second AI request on the
   * same row.
   */
  function claimBatchTargets(
    verb: PreparationVerb,
    ids: readonly string[],
    eligible: (row: ListingRow, activity: PreparationActivity) => boolean,
  ): ListingRow[] {
    const live = preparationTracks.current.snapshot()
    const wanted = new Set(ids)
    const targets = peekListingWorkbench().rows.filter(
      (row) => wanted.has(row.id) && eligible(row, live),
    )
    const claimed = new Set(claimPreparation(verb, targets.map((row) => row.id)))
    return targets.filter((row) => claimed.has(row.id))
  }

  return {
    preparationBlocked,
    claimPreparation,
    verifySupplierMedia,
    beginPreparationBatch,
    settlePreparationBatch,
    finishPreparationBatch,
    beginPrepareWork,
    prepareAction,
    batchRowDeps,
    admitOpenTargets,
    closePreparationBatch,
    claimBatchTargets,
  }
}

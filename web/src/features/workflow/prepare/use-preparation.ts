import { useEffect, useRef, type RefObject } from "react"
import type { PickedPsdAsset } from "@/bindings/commands"
import { workflowActions } from "../workflow-actions"
import { notifyCommandError, notifyError } from "@/lib/notify"
import { runWorkflowOperationBatch } from "../batch-operation"
import {
  patchListingWorkbench,
  listingWorkbenchScope,
  listingScopeCurrent,
  peekListingWorkbench,
} from "../workbench/listing-workbench-store"
import {
  createPreparationTracks,
  preparationRunning,
  retainActivePreparationProgress,
  type PreparationVerb,
} from "./preparation-tracks"
import { preparationBatch, type PrepareWork } from "./preparation-batch"
import { preparationRuns } from "./preparation-runs"
import { stopPreparationCohort } from "./preparation-stop"

type UsePreparationInput = {
  active: boolean
  ready: boolean
  /** Undefined only in tests that never touch a supplier verb; the screen always has one. */
  cardId?: string
  supplierProductId?: string
  psdTemplateAssetId: string
  psdAsset: PickedPsdAsset | undefined
  setPsdAsset: (asset: PickedPsdAsset | undefined) => void
  psdAssetTemplateIdRef: RefObject<string>
  preparationTracks: RefObject<ReturnType<typeof createPreparationTracks>>
  guidedPreparationLock: RefObject<boolean>
}

/**
 * The renderer half of every batch verb: row bookkeeping and the queue fence.
 * 识别 / 切片 / 上传 hold rows, not each other — the claim registry inside
 * `preparationTracks` is the fence a second click reads synchronously.
 *
 * This hook owns the refs and the one-click 一键准备 run; the shared batch
 * coordinator (`preparation-batch.ts`), the single-lane verbs
 * (`preparation-runs.ts`) and the Stop cohort (`preparation-stop.ts`) read them.
 */
export function usePreparation({
  active,
  ready,
  cardId,
  supplierProductId,
  psdTemplateAssetId,
  psdAsset,
  setPsdAsset,
  psdAssetTemplateIdRef,
  preparationTracks,
  guidedPreparationLock,
}: UsePreparationInput) {
  const activeWork = useRef(new Set<PrepareWork>())
  const stopAttempt = useRef(0)
  /** Each cohort's Stop still settling, keyed by workbench scope and sorted draft ids. */
  const pendingStops = useRef(new Map<string, Promise<void>>())
  /** Failure lines waiting for their batch's last opener to let go, per verb. */
  const pendingFailures = useRef<Record<PreparationVerb, string[]>>({
    ai: [],
    render: [],
    deliver: [],
  })
  const pendingFailureScope = useRef(listingWorkbenchScope())
  const tracks = preparationTracks.current

  useEffect(() => tracks.subscribe(activity => {
    if (preparationTracks.current === tracks) patchListingWorkbench({ activity })
  }), [tracks, preparationTracks])

  useEffect(() => {
    if (active) return
    patchListingWorkbench((current) => ({
      preparationProgress: retainActivePreparationProgress(current.preparationProgress),
    }))
  }, [active])

  useEffect(() => () => {
    for (const work of activeWork.current) {
      for (const rowId of work.draftIds) work.cancelled.add(rowId)
      work.tracks.release("ai", [...work.draftIds])
      work.tracks.release("render", [...work.draftIds])
      work.tracks.release("deliver", [...work.draftIds])
    }
    activeWork.current.clear()
  }, [])

  const batch = preparationBatch({
    cardId,
    preparationTracks,
    guidedPreparationLock,
    activeWork,
    pendingFailures,
    pendingFailureScope,
  })
  const {
    preparationBlocked,
    claimPreparation,
    verifySupplierMedia,
    beginPreparationBatch,
    finishPreparationBatch,
    beginPrepareWork,
    prepareAction,
    batchRowDeps,
    admitOpenTargets,
    closePreparationBatch,
  } = batch
  const { runAiRows, runRenderRows, runDeliverRows } = preparationRuns(batch, {
    ready,
    cardId,
    supplierProductId,
    psdTemplateAssetId,
    psdAsset,
    setPsdAsset,
    psdAssetTemplateIdRef,
  })

  async function runGuidedPreparation(ids: string[]) {
    const scope = listingWorkbenchScope()
    if (guidedPreparationLock.current || preparationBlocked()) return
    if (preparationRunning(preparationTracks.current.snapshot())) {
      notifyError("已有识别、切片或上传任务在进行，请完成后再启动一键准备。")
      return
    }
    const wanted = new Set(ids)
    const targetIds = peekListingWorkbench().rows
      .filter((row) => wanted.has(row.id) && row.status !== "sent" && row.source)
      .map((row) => row.id)
    if (!targetIds.length) return

    // Two constraints, and the `try` is where they both hold. The claim has to
    // land before the first await — the button only disables once
    // `guidedPreparation.active` is set, so a later claim lets a second click
    // reach the `finally` and clear the run the first click is still in — and
    // everything after the claim has to be under the `finally`, or a throw
    // leaves the flag set and 一键准备 is dead until reload.
    try {
      guidedPreparationLock.current = true
      patchListingWorkbench({
        guidedPreparation: {
          active: true,
          total: targetIds.length,
          rowIds: targetIds,
          stopRequested: false,
        },
      })
      // The browser media executor reports missing local templates; Cloud
      // reports missing bindings. Neither prerequisite blocks the AI rail.
      const liveTargets = peekListingWorkbench().rows.filter((row) =>
        targetIds.includes(row.id),
      )
      const claimed = new Set(claimPreparation("deliver", targetIds))
      const targets = liveTargets.filter((row) => claimed.has(row.id))
      const work = beginPrepareWork(targets)
      beginPreparationBatch("deliver", targets.map((row) => row.id))
      const outstanding = new Set(targets.map((row) => row.id))
      let failures: string[] = []
      try {
        if (supplierProductId) {
          // Supplier downloads finish outside the short quota/row transaction.
          // A media failure must not prevent the independent recognition rail.
          try {
            await verifySupplierMedia()
          } catch (reason) {
            if (listingScopeCurrent(scope)) notifyCommandError(reason, "商库素材暂不可用；识别仍可继续。")
          }
          if (!listingScopeCurrent(scope)) return
        }
        const open = admitOpenTargets("deliver", targets, outstanding, work, scope)
        if (!open.length) return
        failures = await runWorkflowOperationBatch(
          open,
          batchRowDeps("deliver", outstanding, work),
          prepareAction(work, workflowActions.workflowPrepare),
          { status: "running", log: "一键准备已开始" },
          "准备已完成",
          // Each independent stage streams its committed Cloud projection.
          "AI 字段已写入商品草稿，切片与上传进行中",
        )
      } finally {
        closePreparationBatch("deliver", outstanding, work, scope)
        if (listingScopeCurrent(scope)) {
          finishPreparationBatch("deliver", failures, "准备")
        }
      }
    } finally {
      if (listingScopeCurrent(scope)) {
        guidedPreparationLock.current = false
        patchListingWorkbench((current) => ({
          guidedPreparation: {
            ...current.guidedPreparation,
            active: false,
          },
        }), scope)
      }
    }
  }

  function stopPreparation(): Promise<void> {
    return stopPreparationCohort({ preparationTracks, activeWork, pendingStops, stopAttempt })
  }

  return {
    runAiRows,
    runRenderRows,
    runDeliverRows,
    runGuidedPreparation,
    stopPreparation,
  }
}

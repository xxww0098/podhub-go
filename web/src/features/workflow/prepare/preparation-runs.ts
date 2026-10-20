import type { RefObject } from "react"
import type { PickedPsdAsset } from "@/bindings/commands"
import { renderOpfs } from "@/bindings/render-opfs"
import { aiBatchEligible, deliverBatchEligible, renderBatchEligible } from "../batch-actions"
import { runWorkflowOperationBatch } from "../batch-operation"
import type { ListingRow } from "../model/listing-row"
import {
  listingScopeCurrent,
  listingWorkbenchScope,
  peekListingWorkbench,
} from "../workbench/listing-workbench-store"
import { workflowActions } from "../workflow-actions"
import { setCardContext } from "./execution-context"
import {
  lifecycleForRow,
  failPreparationRows,
  type PreparationBatch,
  type PrepareWork,
} from "./preparation-batch"
import { NO_PREPARATION_ACTIVITY } from "./preparation-tracks"
import {
  psdTemplateFailure,
  psdTemplateFailurePatch,
  type PsdTemplateFailure,
} from "./psd-template-failure"

type PreparationRunInput = {
  ready: boolean
  /** Undefined only in tests that never touch a supplier verb; the screen always has one. */
  cardId?: string
  supplierProductId?: string
  psdTemplateAssetId: string
  psdAsset: PickedPsdAsset | undefined
  setPsdAsset: (asset: PickedPsdAsset | undefined) => void
  psdAssetTemplateIdRef: RefObject<string>
}

/**
 * The three single-lane verbs: 识别, 切片 and 上传 on the rows the operator
 * picked. Each claims its own lane, runs the fixed Cloud operation, and lets
 * the shared coordinator settle rows, counters and the batch's one toast.
 */
export function preparationRuns(
  {
    preparationBlocked,
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
  }: PreparationBatch,
  {
    ready,
    cardId,
    supplierProductId,
    psdTemplateAssetId,
    psdAsset,
    setPsdAsset,
    psdAssetTemplateIdRef,
  }: PreparationRunInput,
) {
  async function runAiRows(ids: string[]) {
    const scope = listingWorkbenchScope()
    if (preparationBlocked()) return
    if (!ready) return
    const targets = claimBatchTargets("ai", ids, (row, live) =>
      aiBatchEligible(row, lifecycleForRow(row), live),
    )
    if (!targets.length) return
    const work = beginPrepareWork(targets)
    beginPreparationBatch("ai", targets.map((target) => target.id))
    const outstanding = new Set(targets.map((target) => target.id))
    let failures: string[] = []
    try {
      failures = await runWorkflowOperationBatch(
        targets,
        batchRowDeps("ai", outstanding, work),
        prepareAction(work, workflowActions.workflowRecognize),
        { status: "running", ai: "running", log: "AI 识别已开始" },
        "AI 识别已完成",
      )
    } finally {
      closePreparationBatch("ai", outstanding, work, scope)
      if (listingScopeCurrent(scope)) {
        finishPreparationBatch("ai", failures, "AI 识别")
      }
    }
  }

  /**
   * Restore the template this attempt started with. `templateCurrent` is
   * re-read after every await: once it turns false the card has moved on (left,
   * or a card-level invalidation may have swapped the template), so nothing
   * this attempt looked up is written back as the current asset, ref or card
   * context, and the caller treats the result as stale rather than missing.
   */
  async function restoreTemplate(templateCurrent: () => boolean): Promise<boolean> {
    let assetId = psdTemplateAssetId
    if (!assetId && supplierProductId) {
      const media = await verifySupplierMedia()
      if (!templateCurrent()) return false
      if (media) assetId = media.psd_sha256
    }
    let template = psdAssetTemplateIdRef.current === assetId
      ? psdAsset
      : undefined
    if (assetId) {
      // A held asset handle survives cache eviction; verify/recover once per
      // batch before rendering rather than trusting that handle's presence.
      const managed = await renderOpfs.workflowRestoreTemplatePsd(assetId, supplierProductId, cardId)
      if (!templateCurrent()) return false
      template = managed.asset
      setPsdAsset(managed.asset)
      psdAssetTemplateIdRef.current = assetId
    }
    if (templateCurrent()) setCardContext({ psdTemplateSha256: assetId })
    return Boolean(template)
  }

  /**
   * Whether this attempt's template failure still describes the row it
   * claimed. Restoring waits on OPFS and Cloud, and meanwhile the row can move
   * on: Stop cancels it, the card drops or replaces it, its source changes, or
   * the latest durable facts no longer owe a render — slices already rendered
   * or public, a render or upload running elsewhere, or the row sealed
   * (accepted / Unknown / attested). Then the failure is stale: nothing this
   * attempt did touched the row, so it keeps its current facts.
   */
  function templateFailureCurrent(target: ListingRow, work: PrepareWork): boolean {
    if (work.cancelled.has(target.draftId)) return false
    const row = peekListingWorkbench().rows.find((candidate) => candidate.id === target.id)
    if (!row || row.draftId !== target.draftId) return false
    if (row.source?.handle !== target.source?.handle) return false
    // The same predicate that admitted the row, minus this batch's own claim.
    return renderBatchEligible(row, lifecycleForRow(row), NO_PREPARATION_ACTIVITY)
  }

  /**
   * Write this attempt's template failure onto the rows it still describes,
   * and settle every row the attempt holds. A stale row is settled as not
   * failed and released, with no row patch and no failure line, so neither its
   * source, draft, media, progress nor log is overwritten and the batch toast
   * does not name it.
   */
  function failTemplateRows(
    failure: PsdTemplateFailure,
    targets: readonly ListingRow[],
    outstanding: Set<string>,
    work: PrepareWork,
  ): string[] {
    const current = targets.filter((target) => templateFailureCurrent(target, work))
    const failed = new Set(current.map((target) => target.id))
    const failures = failPreparationRows(current, { code: failure.cause, message: failure.message }, failure.message, psdTemplateFailurePatch(failure), "render")
    settleTemplateRows(targets, outstanding, work, failed)
    return failures
  }

  /** Settle every row the attempt still holds before any slice, and release its claim. */
  function settleTemplateRows(
    targets: readonly ListingRow[],
    outstanding: Set<string>,
    work: PrepareWork,
    failed: ReadonlySet<string>,
  ) {
    for (const target of targets) {
      if (outstanding.delete(target.id)) {
        settlePreparationBatch("render", target.id, failed.has(target.id))
        work.tracks.release("render", [target.id])
      }
    }
  }

  async function runRenderRows(ids: string[]) {
    const scope = listingWorkbenchScope()
    if (preparationBlocked()) return
    if (!ready) return
    const targets = claimBatchTargets("render", ids, (row, live) =>
      renderBatchEligible(row, lifecycleForRow(row), live),
    )
    if (!targets.length) return
    // Every failure this attempt writes carries its start, so an older
    // attempt's cause never stands in for this one.
    const attemptSinceMs = Date.now()
    // The template this attempt restores belongs to the card as of this click.
    // A card-level invalidation (template swap) bumps the workbench's existing
    // mediaEpoch without touching row revisions and without cancelling this
    // attempt, so the marker is what tells an old restore it no longer speaks
    // for the card.
    const mediaEpoch = peekListingWorkbench().mediaEpoch
    const templateCurrent = () =>
      listingScopeCurrent(scope) && peekListingWorkbench().mediaEpoch === mediaEpoch
    const work = beginPrepareWork(targets)
    beginPreparationBatch("render", targets.map((target) => target.id))
    const outstanding = new Set(targets.map((target) => target.id))
    let failures: string[] = []
    try {
      let restored: { ready: boolean } | { reason: unknown }
      try {
        restored = { ready: await restoreTemplate(templateCurrent) }
      } catch (reason) {
        restored = { reason }
      }
      if (!listingScopeCurrent(scope)) return
      if (!templateCurrent()) {
        // Stale, whichever way the old restore ended: no slice, no failure
        // patch, cause or toast; every held row settles as not failed.
        settleTemplateRows(targets, outstanding, work, new Set())
        return
      }
      if ("reason" in restored) {
        failures = failTemplateRows(
          psdTemplateFailure("template_restore_failed", attemptSinceMs, restored.reason),
          targets, outstanding, work,
        )
        return
      }
      if (!restored.ready) {
        failures = failTemplateRows(
          psdTemplateFailure(supplierProductId ? "supplier_template_unbound" : "template_unbound", attemptSinceMs),
          targets, outstanding, work,
        )
        return
      }
      const open = admitOpenTargets("render", targets, outstanding, work, scope)
      if (!open.length) return
      failures = await runWorkflowOperationBatch(
        open,
        batchRowDeps("render", outstanding, work),
        prepareAction(work, workflowActions.workflowSlice),
        // A new attempt drops the previous attempt's template failure.
        { status: "running", render: "running", log: "切片已开始", preparationRender: undefined, psdTemplateFailure: undefined },
        "切片已生成，等待上传",
      )
    } catch (reason) {
      // Not a template fact: the batch itself broke after the template was
      // ready, so only the rows it had not settled fail, in this step's words.
      if (listingScopeCurrent(scope)) {
        failures = failPreparationRows(targets.filter(row => outstanding.has(row.id)), reason, "切片中断，请重试切片",
          { status: "failed", render: "failed", log: "切片中断，请重试切片" }, "render")
      }
    } finally {
      closePreparationBatch("render", outstanding, work, scope)
      if (listingScopeCurrent(scope)) {
        finishPreparationBatch("render", failures, "切片")
      }
    }
  }

  async function runDeliverRows(ids: string[]) {
    const scope = listingWorkbenchScope()
    if (preparationBlocked()) return
    if (!ready) return
    const targets = claimBatchTargets("deliver", ids, (row, live) =>
      deliverBatchEligible(row, lifecycleForRow(row), live),
    )
    if (!targets.length) return
    const work = beginPrepareWork(targets)
    beginPreparationBatch("deliver", targets.map((target) => target.id))
    const outstanding = new Set(targets.map((target) => target.id))
    let failures: string[] = []
    try {
      if (supplierProductId) {
        await verifySupplierMedia()
        if (!listingScopeCurrent(scope)) return
      }
      const open = admitOpenTargets("deliver", targets, outstanding, work, scope)
      if (!open.length) return
      failures = await runWorkflowOperationBatch(
        open,
        batchRowDeps("deliver", outstanding, work),
        prepareAction(work, workflowActions.workflowUpload),
        { status: "running", upload: "running", log: "上传已开始" },
        "切片已公网可读",
      )
    } catch (reason) {
      if (listingScopeCurrent(scope)) {
        failures = failPreparationRows(targets.filter(row => outstanding.has(row.id)), reason, "上传准备失败",
          { upload: "failed", log: "上传准备失败" }, "upload")
      }
    } finally {
      closePreparationBatch("deliver", outstanding, work, scope)
      if (listingScopeCurrent(scope)) {
        finishPreparationBatch("deliver", failures, "上传")
      }
    }
  }

  return { runAiRows, runRenderRows, runDeliverRows }
}

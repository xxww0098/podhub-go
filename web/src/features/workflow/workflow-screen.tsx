import { lazy, Suspense, useCallback, useRef, useState } from "react"
import type { CategorySchemaView } from "@/bindings/commands"
import { useAddress } from "@/hooks/use-address"
import { useScreenActive } from "@/components/screen-pane"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { clearLive, notifyError } from "@/lib/notify"
import { replaceAddress } from "@/lib/address"
import type { WorkflowPublishContext } from "./workflow-publish-capabilities"
import { useWorkflowPublishCapabilities } from "./use-workflow-publish-capabilities"
import { peekCardSession } from "./card/card-session"
import { preparationRunning } from "./prepare/preparation-tracks"
import { useAccountOverview } from "@/features/account/account-overview-cache"
import { CardLibraryHost } from "./card-library-host"
import { WorkflowRestoreSkeleton } from "./workflow-restore-skeleton"

const CardRunner = lazy(() =>
  import("./card-runner").then((mod) => ({ default: mod.CardRunner })),
)
import { createPreparationTracks } from "./prepare/preparation-tracks"
import { useCardAutosave } from "./editing/use-card-autosave"
import { useRowAutosaves } from "./editing/use-row-autosaves"
import { useStoreQuotas } from "./use-store-quotas"
import { usePublishQueue } from "./submit/use-publish-queue"
import { usePublishDiagnostics, PublishDiagnosticReporterContext } from "./submit/use-publish-diagnostics"
import { useUnknownRelease } from "./submit/use-unknown-release"
import { usePreparation } from "./prepare/use-preparation"
import { useSourceImport } from "./use-source-import"
import { useWorkbenchPolling } from "./workbench/use-workbench-polling"
import { peekListingWorkbench, resetListingWorkbench } from "./workbench/listing-workbench-store"
import { removeWorkbenchRows } from "./workbench/delete-workbench-rows"
import { readWorkflowCardId, writeWorkflowCardId } from "./workflow-navigation"
import { useWorkflowScreenState, TEMPLATE_NOTICE_ID } from "./workflow-screen-state"
import { useWorkflowScreenLibrary } from "./workflow-screen-library"
import { useWorkflowScreenStream } from "./workflow-screen-stream"
import { useWorkflowScreenEdits } from "./workflow-screen-edits"
import { useWorkflowScreenLifecycle } from "./workflow-screen-lifecycle"

export { resolveRunnerEntry } from "./product-instances"
export { copyListingCardTemplate } from "./workflow-shared"
export { runnerOpenRefused } from "./workflow-screen-library"

export function WorkflowScreen({
  initialSchema,
  workspaceId,
  onOpenStores = () => {},
  onOpenCatalog = () => {},
}: {
  initialSchema?: CategorySchemaView
  workspaceId?: number
  onOpenStores?: () => void
  onOpenCatalog?: () => void
}) {
  const active = useScreenActive()
  const address = useAddress()

  const state = useWorkflowScreenState(initialSchema, workspaceId, active)
  const {
    mode, setMode, restoringCard, schema, draft, setDraft,
    draftId, setDraftId, supplierProductId, supplierBound, cardTemplateId, formName,
    issues, setIssues, busy, setBusy, psdAsset, setPsdAsset,
    psdAssetTemplateIdRef, psdTemplateAssetId, psdTemplateFileName, aiPromptId, aiPrompt, aiPromptFileName,
    savedForms, setSavedForms, libraryBusy, setLibraryBusy, streamHealthy, cardFieldOrigins,
    setCardFieldOrigins, targetStoreId, aiAllowedFieldKeys, videoUploads, setVideoUploads, aiProtectedFieldKeys,
    ozonStores, storeAvailability, storeConfigured, storeLabel, preparationTracks, guidedPreparationLock,
    rowClearLock, runnerOpenLock, runnerGeneration
  } = state
  const {
    pendingValueOriginRef,
    skipNextAutosave,
    flushCardAutosave,
    hasPendingCardChanges,
  } = useCardAutosave({
    mode,
    supplierBound,
    schema,
    draft,
    draftId,
    setDraftId,
    formName,
    aiPromptId,
    aiPrompt,
    aiPromptFileName,
    psdTemplateAssetId,
    psdTemplateFileName,
    targetStoreId,
    aiAllowedFieldKeys,
    initialSkip: Boolean(initialSchema),
    setSavedForms,
    setCardFieldOrigins,
  })
  const [rowSaveConflict, setRowSaveConflict] = useState<{
    message: string
    resolve: (keepMine: boolean) => void
  } | null>(null)
  const confirmRowSaveConflict = useCallback(
    (message: string) =>
      new Promise<boolean>((resolve) => {
        setRowSaveConflict({ message, resolve })
      }),
    [],
  )
  const {
    editRowCell,
    editRowField,
    retryRowSave,
    flushRowAutosavesNow,
    flushRowAutosaves,
    flushRowsFor,
    pendingRowEdits,
    forgetRows,
    resetRowAutosaves,
  } = useRowAutosaves({ schema, confirm: confirmRowSaveConflict })
  const {
    boundStoreIds,
    customStoreQuotas,
    setCustomStoreQuotas,
    handleQuotaChange,
    handleEvenSplitQuotas,
  } = useStoreQuotas({
    targetStoreId,
    preparationTracks,
    guidedPreparationLock,
  })
  useAccountOverview()
  const publishControlVersion = useRef(0)
  const capabilityContext = useRef<WorkflowPublishContext>({ generation: 0, controlVersion: 0, active: false, blocked: true })
  capabilityContext.current = { workspaceId, cardId: cardTemplateId, generation: runnerGeneration.current, controlVersion: publishControlVersion.current,
    active: active && mode === "runner", blocked: busy || runnerOpenLock.current || rowClearLock.current || hasPendingCardChanges() }
  const diagnosticRoute = usePublishDiagnostics(active && mode === "runner", () => capabilityContext.current.active)
  const publishCapabilities = useWorkflowPublishCapabilities(() => ({
    ...capabilityContext.current, generation: runnerGeneration.current, controlVersion: publishControlVersion.current,
    blocked: capabilityContext.current.blocked || preparationRunning(preparationTracks.current.snapshot()),
  }), undefined, peekCardSession)
  const {
    queueStopRequested,
    projectQueueState,
    startPublish,
    resumePublish,
    pausePublish,
    stopPublish,
    cancelRowIntent,
    repairRows,
    repairInFlight,
    submissionPending,
  } = usePublishQueue({
    brandRepairCapability: publishCapabilities?.brandRepair,
    diagnosticCurrent: () => capabilityContext.current.active,
    cardTemplateId,
    supplierProductId,
    busy,
    storeConfigured,
    preparationTracks,
    guidedPreparationLock,
    flushAutosave,
    flushAutosavesFor,
  })
  const { releaseUnknownRows, releaseInFlight, inspectUnknownRows, canReleaseUnknownRows } = useUnknownRelease(
    busy || repairInFlight, publishCapabilities?.unknownRelease, publishCapabilities?.inspectUnknownRows)
  const {
    runAiRows,
    runRenderRows,
    runDeliverRows,
    runGuidedPreparation,
    stopPreparation,
  } = usePreparation({
    active,
    ready: Boolean(schema && draft && draftId),
    cardId: cardTemplateId,
    supplierProductId,
    psdTemplateAssetId,
    psdAsset,
    setPsdAsset,
    psdAssetTemplateIdRef,
    preparationTracks,
    guidedPreparationLock,
  })
  const { importSourceSelection } = useSourceImport({
    cardTemplateId,
    schema,
    boundStoreIds,
    customStoreQuotas,
    preparationTracks,
    flushAutosave,
    setBusy,
  })

  useWorkbenchPolling(() => ({
    active: active && mode === "runner",
    cardId: cardTemplateId,
    generation: runnerGeneration.current,
    busy: busy || runnerOpenLock.current || rowClearLock.current,
    pendingCardChanges: hasPendingCardChanges(),
    streamHealthy,
    queueStopRequested,
    projectQueueState,
  }))

  const { restoreProductInstances } = useWorkflowScreenStream({ state, forgetRows, resetRowAutosaves, setCustomStoreQuotas })
  const { refreshSavedForms, reloadOzonStores, openRunner } = useWorkflowScreenLibrary({
    state, workspaceId, skipNextAutosave, setCustomStoreQuotas, resetRowAutosaves, projectQueueState, restoreProductInstances, leaveRunner,
  })
  const { updateValue, refreshCategorySchema, previewSkuImport, applySkuImport, clearGeneratedRows } = useWorkflowScreenEdits({
    state, pendingValueOriginRef, flushAutosave, flushRowsFor,
  })
  const addressCardId = readWorkflowCardId(address.search)
  useWorkflowScreenLifecycle({ state, active, addressCardId, initialSchema,
    flushCardAutosave, flushRowAutosavesNow, hasPendingCardChanges, pendingRowEdits,
    refreshSavedForms, reloadOzonStores, openRunner, leaveRunner })

  /** Card template and every row: one drain, so nothing durable is left behind. */
  async function flushAutosave() {
    const card = await flushCardAutosave()
    const rowEdits = await flushRowAutosaves()
    return card && rowEdits
  }

  /** Shared Card defaults plus the chosen rows: another row must not hold a send. */
  async function flushAutosavesFor(draftIds: readonly string[]) {
    const card = await flushCardAutosave()
    const rowEdits = await flushRowsFor(draftIds)
    return card && rowEdits
  }

  async function leaveRunner() {
    if (submissionPending()) {
      notifyError("正在提交发送请求，请收到后台回执后再返回上架方案。")
      return
    }
    if (!(await flushAutosave())) {
      notifyError("更改尚未保存。请重试保存后再返回上架方案。")
      return
    }
    runnerGeneration.current += 1
    clearLive(TEMPLATE_NOTICE_ID)
    runnerOpenLock.current = false
    preparationTracks.current = createPreparationTracks()
    resetListingWorkbench()
    replaceAddress(writeWorkflowCardId(window.location.href))
    setPsdAsset(undefined)
    psdAssetTemplateIdRef.current = ""
    setMode("library")
    await refreshSavedForms()
  }

  if (restoringCard) return <WorkflowRestoreSkeleton />

  if (mode === "runner" && schema && draft) {
    const templateReady = Boolean(
      psdAsset && psdAssetTemplateIdRef.current &&
      (psdAssetTemplateIdRef.current === psdTemplateAssetId || (supplierBound && !psdTemplateAssetId)),
    )
    return (
      <PublishDiagnosticReporterContext.Provider value={diagnosticRoute.report}>
      <Suspense fallback={<WorkflowRestoreSkeleton />}>
      <CardRunner
        cardName={formName.trim() || "上架执行"}
        supplierBound={supplierBound}
        schema={schema}
        draft={draft}
        issues={issues}
        storeConfigured={storeConfigured}
        storeLabel={storeLabel}
        storeIssue={storeAvailability.issue}
        targetStoreId={targetStoreId}
        busy={busy || repairInFlight || releaseInFlight}
        onBack={() => void leaveRunner()}
        onUpdateValue={updateValue}
        onDraftChange={(next) => {
          pendingValueOriginRef.current = { kind: "manual" }
          setDraft(next)
          setIssues([])
        }}
        onIssuesClear={() => {
          setIssues([])
        }}
        onImportImages={() => void importSourceSelection([])}
        onImportPaths={(paths) => importSourceSelection(paths)}
        onClearRows={(ids) => void clearGeneratedRows(ids)}
        onRemoveRows={(ids) => void removeWorkbenchRows(ids, { flushRowsFor, forgetRows })}
        onEditCell={editRowCell}
        onEditField={editRowField}
        onRetryRowSave={retryRowSave}
        onFlushRows={flushRowsFor}
        onRunAiRows={(ids) => void runAiRows(ids)}
        onRunRenderRows={(ids) => {
          if (templateReady) void runRenderRows(ids)
          else notifyError("PSD 模板不可用，请返回上架方案重新绑定或重试检查。")
        }}
        onRunDeliverRows={(ids) => void runDeliverRows(ids)}
        onPrepareRows={(ids) => {
          if (templateReady) void runGuidedPreparation(ids)
          else {
            notifyError("PSD 模板不可用，本次仅运行 AI 识别。新切片需重新绑定 PSD 或重试检查。")
            void runAiRows(ids)
          }
        }}
        onStopPreparation={stopPreparation}
        onCancelRowIntent={(draftId) => void cancelRowIntent(draftId)}
        onSendRows={(ids) => {
          if (templateReady || !ids.length) {
            void startPublish(ids)
            return
          }
          const current = peekListingWorkbench()
          const wanted = new Set(ids)
          const blocked = new Set(current.rows.filter((row) => {
            const media = current.productDrafts[row.draftId]?.lifecycle.media
            return wanted.has(row.id) && media !== undefined && media !== "ready"
          }).map((row) => row.id))
          const sendable = ids.filter((id) => !blocked.has(id))
          if (blocked.size) {
            notifyError(sendable.length
              ? `本机 PSD 不可用，已跳过 ${blocked.size} 件媒体尚未就绪的商品；已就绪商品继续发送。`
              : `本机 PSD 不可用，所选 ${blocked.size} 件商品的媒体尚未就绪，请重新绑定 PSD 或重试检查。`)
          }
          if (sendable.length) void startPublish(sendable)
        }}
        brandRepairAvailable={Boolean(publishCapabilities?.brandRepair)}
        canRepairRow={(row, revision) => publishCapabilities?.brandRepair.current(row, revision) ?? false}
        onInspectUnknownRows={(ids) => void inspectUnknownRows(ids)}
        canReleaseUnknownRows={canReleaseUnknownRows}
        onRepairRows={(ids) => void repairRows(ids)}
        repairing={repairInFlight}
        onReleaseUnknownRows={(ids) => void releaseUnknownRows(ids)}
        releasingUnknown={releaseInFlight}
        queueStopRequested={queueStopRequested}
        onPauseQueue={() => { publishControlVersion.current++; void pausePublish() }}
        onCancelQueue={() => { publishControlVersion.current++; void stopPublish() }}
        onResumeQueue={() => void resumePublish()}
        onOpenStores={onOpenStores}
        fieldOrigins={cardFieldOrigins}
        aiAllowedFieldKeys={aiAllowedFieldKeys}
        aiProtectedFieldKeys={aiProtectedFieldKeys}
        onPreviewSkuImport={previewSkuImport}
        onApplySkuImport={applySkuImport}
        onFetchCategorySchema={refreshCategorySchema}
        stores={ozonStores}
        storeQuotas={customStoreQuotas}
        onQuotaChange={handleQuotaChange}
        onEvenSplitQuotas={handleEvenSplitQuotas}
      />
      </Suspense>
      <ConfirmDialog
        open={rowSaveConflict !== null}
        onOpenChange={(open) => {
          if (!open) {
            rowSaveConflict?.resolve(false)
            setRowSaveConflict(null)
          }
        }}
        title="字段存在编辑冲突"
        description={rowSaveConflict?.message}
        confirmText="保留并保存"
        cancelText="暂不保存"
        variant="default"
        onConfirm={() => {
          rowSaveConflict?.resolve(true)
          setRowSaveConflict(null)
        }}
      />
      </PublishDiagnosticReporterContext.Provider>
    )
  }

  return (
    <CardLibraryHost
      forms={savedForms}
      setForms={setSavedForms}
      busy={libraryBusy}
      setBusy={setLibraryBusy}
      refreshForms={refreshSavedForms}
      videoUploads={videoUploads}
      setVideoUploads={setVideoUploads}
      workspaceId={workspaceId}
      fallbackStoreId={targetStoreId}
      onRun={(form) => void openRunner(form)}
      onCardSaved={() => setMode("library")}
      onOpenStores={onOpenStores}
      onOpenCatalog={onOpenCatalog}
      // 商详「进入上架」带着 cardId 落回本屏：库列表在 runner 接管前（或打开
      // 被拒后）仍可见，残留搜索词不得吞掉目标行——交给 highlight 清筛选并定位。
      highlightDraftId={addressCardId}
    />
  )
}

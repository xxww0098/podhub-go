import type { BrandRepairCapability } from "./submit/use-repair-publish"
import { useCallback, useMemo, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import type {
  CategorySchemaView,
  FieldValueOrigin,
  OzonStoreView,
  SkuImportCandidate,
  SkuImportPreview,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowValidationIssue,
} from "@/bindings/commands"
import { useTrailSegment } from "@/app/app-shell"
import { isSourceImage, stageFile } from "@/bindings/file-picker"
import { notifyError } from "@/lib/notify"
import { useFileDropTarget } from "@/hooks/use-file-drop-target"
import { FieldWorkbench } from "./workbench/field-workbench"
import type { WorkbenchEditableColumn } from "./workbench/workbench-cell-editor"
import type { ListingRow } from "./model/listing-row"
import { patchListingWorkbench, useListingWorkbenchStore } from "./workbench/listing-workbench-store"
import type { CardStoreAvailability } from "./store-availability"
import {
  preparationRunning,
  type PreparationActivity,
} from "./prepare/preparation-tracks"
import {
  addComplexItem,
  removeComplexItem,
  type WorkflowValueLocation,
} from "./workflow-draft"

export function activeRunnerCount(
  rows: readonly ListingRow[],
  activity: PreparationActivity,
): number {
  const active = new Set(rows.filter((row) => row.status === "running").map((row) => row.id))
  for (const rowId of [...activity.ai, ...activity.render, ...activity.deliver]) {
    active.add(rowId)
  }
  return active.size
}

type CardRunnerProps = {
  cardName: string
  supplierBound?: boolean
  schema: CategorySchemaView
  draft: WorkflowCategoryDraft
  issues: WorkflowValidationIssue[]
  onPreviewSkuImport: (sku: string) => Promise<SkuImportPreview>
  onApplySkuImport: (candidates: SkuImportCandidate[], sourceSku: number) => void
  onFetchCategorySchema: () => Promise<void>
  storeConfigured: boolean
  storeLabel: string
  storeIssue?: CardStoreAvailability["issue"]
  targetStoreId: string
  busy: boolean
  onBack: () => void
  onUpdateValue: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onDraftChange: (draft: WorkflowCategoryDraft) => void
  onIssuesClear: () => void
  onImportImages: () => void
  onImportPaths: (paths: string[]) => Promise<boolean>
  onClearRows: (ids: string[]) => void
  onRemoveRows: (ids: string[]) => void
  onEditCell: (
    draftId: string,
    column: WorkbenchEditableColumn,
    value: string,
  ) => void
  /** Write one draft value on one row — the 主题 picker's durable half. */
  onEditField: (
    draftId: string,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onRetryRowSave: (draftId: string) => void
  onFlushRows: (draftIds: readonly string[]) => Promise<boolean>
  onRunAiRows: (rowIds: string[], force?: boolean) => void
  onRunRenderRows: (rowIds: string[]) => void
  onRunDeliverRows: (rowIds: string[]) => void
  onPrepareRows: (rowIds: string[]) => void
  onStopPreparation: () => void
  onCancelRowIntent: (draftId: string) => void
  onSendRows: (rowIds: string[]) => void
  brandRepairAvailable?: boolean
  canRepairRow?: BrandRepairCapability["current"]
  onInspectUnknownRows?: (rowIds: string[]) => void
  canReleaseUnknownRows?: (rowIds: readonly string[]) => boolean
  onRepairRows: (rowIds: string[]) => void
  repairing: boolean
  onReleaseUnknownRows: (rowIds: string[]) => void
  releasingUnknown: boolean
  queueStopRequested: boolean
  onPauseQueue: () => void
  onCancelQueue: () => void
  onResumeQueue: () => void
  onOpenStores: () => void
  fieldOrigins: FieldValueOrigin[]
  aiAllowedFieldKeys: string[]
  aiProtectedFieldKeys: string[]
  stores?: OzonStoreView[]
  storeQuotas?: Record<string, number>
  onQuotaChange?: (storeId: string, quota: number) => void
  onEvenSplitQuotas?: () => void
}

export function CardRunner({
  cardName,
  supplierBound = false,
  schema,
  draft,
  issues,
  onPreviewSkuImport,
  onApplySkuImport,
  onFetchCategorySchema,
  storeConfigured,
  storeLabel,
  storeIssue,
  targetStoreId,
  busy,
  onBack,
  onUpdateValue,
  onDraftChange,
  onIssuesClear,
  onImportImages,
  onImportPaths,
  onClearRows,
  onRemoveRows,
  onEditCell,
  onEditField,
  onRetryRowSave,
  onFlushRows,
  onRunAiRows,
  onRunRenderRows,
  onRunDeliverRows,
  onPrepareRows,
  onStopPreparation,
  onCancelRowIntent,
  onSendRows,
  brandRepairAvailable = false,
  canRepairRow,
  onInspectUnknownRows,
  canReleaseUnknownRows,
  onRepairRows,
  repairing,
  onReleaseUnknownRows,
  releasingUnknown,
  queueStopRequested,
  onPauseQueue,
  onCancelQueue,
  onResumeQueue,
  onOpenStores,
  fieldOrigins,
  aiAllowedFieldKeys,
  aiProtectedFieldKeys,
  stores,
  storeQuotas,
  onQuotaChange,
  onEvenSplitQuotas,
}: CardRunnerProps) {
  const {
    rows,
    productDrafts,
    rowSaveStates,
    selectedIds,
    activity,
    preparationProgress,
    guidedPreparation,
    queuePaused,
    queueRunning,
    queueHaltReason,
  } = useListingWorkbenchStore(
    useShallow((state) => ({
      rows: state.rows,
      productDrafts: state.productDrafts,
      rowSaveStates: state.rowSaveStates,
      selectedIds: state.selectedIds,
      activity: state.activity,
      preparationProgress: state.preparationProgress,
      guidedPreparation: state.guidedPreparation,
      queuePaused: state.queuePaused,
      queueRunning: state.queueRunning,
      queueHaltReason: state.queueHaltReason,
    })),
  )
  const selectedRowIds = useMemo(() => new Set(selectedIds), [selectedIds])
  const fieldActionsRef = useRef({
    draft,
    onUpdateValue,
    onDraftChange,
    onIssuesClear,
  })
  fieldActionsRef.current = {
    draft,
    onUpdateValue,
    onDraftChange,
    onIssuesClear,
  }
  const updateCategoryValue = useCallback<CardRunnerProps["onUpdateValue"]>(
    (fieldKey, value, location) => {
      fieldActionsRef.current.onUpdateValue(fieldKey, value, location)
    },
    [],
  )
  const addCategoryComplexItem = useCallback((complexId: number) => {
    const actions = fieldActionsRef.current
    actions.onDraftChange(addComplexItem(actions.draft, complexId))
    actions.onIssuesClear()
  }, [])
  const removeCategoryComplexItem = useCallback((complexId: number, itemIndex: number) => {
    const actions = fieldActionsRef.current
    actions.onDraftChange(removeComplexItem(actions.draft, complexId, itemIndex))
    actions.onIssuesClear()
  }, [])
  useTrailSegment(cardName, onBack)

  const queueLocked = queuePaused || queueRunning
  const imageDrop = useFileDropTarget<HTMLDivElement>({
    // Dropping images is the same gesture as 导入图片, and it waits for the same
    // reason: a running batch reads the card template row by row.
    disabled:
      busy ||
      queueLocked ||
      guidedPreparation.active ||
      preparationRunning(activity),
    onEmptyDrop: () => {
      onImportImages()
    },
    onDropFiles: (files) => {
      const images = files.filter(isSourceImage)
      if (!images.length) {
        notifyError("请拖入 JPG / PNG 图片。")
        return
      }
      void onImportPaths(images.map(stageFile))
    },
  })

  return (
    <div
      className="wf-pipe flex min-h-0 flex-1 flex-col gap-3 overflow-hidden"
      data-testid="workflow-screen"
    >
      <div ref={imageDrop.ref} {...imageDrop.dropProps} className="flex flex-1 flex-col min-h-0">
        <FieldWorkbench
          schema={schema}
          supplierBound={supplierBound}
          rows={rows}
          productDrafts={productDrafts}
          rowSaveStates={rowSaveStates}
          cardDraft={draft}
          cardIssues={issues}
          cardFieldOrigins={fieldOrigins}
          targetStoreId={targetStoreId}
          busy={busy}
          activity={activity}
          preparationProgress={preparationProgress}
          guidedPreparation={guidedPreparation}
          queuePaused={queuePaused}
          queueRunning={queueRunning}
          queueStopRequested={queueStopRequested}
          queueHaltReason={queueHaltReason}
          storeConfigured={storeConfigured}
          storeLabel={storeLabel}
          storeIssue={storeIssue}
          dragging={imageDrop.dragging}
          selectedRowIds={selectedRowIds}
          onSelectionChange={(ids) => patchListingWorkbench({ selectedIds: ids })}
          onImportImages={onImportImages}
          onClearRows={onClearRows}
          onRemoveRows={onRemoveRows}
          onEditCell={onEditCell}
          onEditField={onEditField}
          onRetryRowSave={onRetryRowSave}
          onFlushRows={onFlushRows}
          onRunAiRows={onRunAiRows}
          onRunRenderRows={onRunRenderRows}
          onRunDeliverRows={onRunDeliverRows}
          onPrepareRows={onPrepareRows}
          onStopPreparation={onStopPreparation}
          onCancelRowIntent={onCancelRowIntent}
          onSendRows={onSendRows}
          brandRepairAvailable={brandRepairAvailable}
          canRepairRow={canRepairRow}
          onInspectUnknownRows={onInspectUnknownRows}
          canReleaseUnknownRows={canReleaseUnknownRows}
          onRepairRows={onRepairRows}
          repairing={repairing}
          onReleaseUnknownRows={onReleaseUnknownRows}
          releasingUnknown={releasingUnknown}
          onPauseQueue={onPauseQueue}
          onUpdateCardDefault={updateCategoryValue}
          onAddComplexItem={addCategoryComplexItem}
          onRemoveComplexItem={removeCategoryComplexItem}
          aiAllowedFieldKeys={aiAllowedFieldKeys}
          aiProtectedFieldKeys={aiProtectedFieldKeys}
          onPreviewSkuImport={onPreviewSkuImport}
          onApplySkuImport={onApplySkuImport}
          onFetchCategorySchema={onFetchCategorySchema}
          onCancelQueue={onCancelQueue}
          onResumeQueue={onResumeQueue}
          onOpenStores={onOpenStores}
          onEditCard={onBack}
          stores={stores}
          storeQuotas={storeQuotas}
          onQuotaChange={onQuotaChange}
          onEvenSplitQuotas={onEvenSplitQuotas}
        />
      </div>
    </div>
  )
}

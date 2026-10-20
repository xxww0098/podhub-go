import type { BrandRepairCapability } from "../submit/use-repair-publish"
import { useMemo, useState } from "react"
import { LoaderCircle, RefreshCw } from "lucide-react"
import type {
  CategorySchemaView,
  FieldValueOrigin,
  OzonStoreView,
  QueueHaltReason,
  SkuImportCandidate,
  SkuImportPreview,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowDraftView,
  WorkflowValidationIssue,
} from "@/bindings/commands"
import type { SaveState } from "@/components/save-state-chip"
import { Button } from "@/components/ui/button"
import { sendBatchEligible, workbenchScopes } from "../batch-actions"
import { listedStockTargets, openListedStockOrExplain } from "../listed-stock-dialog"
import type { ListingRow } from "../model/listing-row"
import { brandRepairRowIds } from "../model/publish-remediation"
import { brandRepairIssueCurrent } from "../brand-repair"
import {
  preparationRunning,
  type GuidedPreparation,
  type PreparationActivity,
  type PreparationProgress,
} from "../prepare/preparation-tracks"
import type { CardStoreAvailability } from "../store-availability"
import { calculateSequentialStoreSlices, parseStoreIds } from "../store-quota"
import { useStoreColorPreferences } from "../use-store-color-preferences"
import {
  fieldDisplayValueAsText,
  valueAsText,
  type WorkflowValueLocation,
} from "../workflow-draft"
import { unknownReleaseFacts } from "./unknown-release-facts"
import { UnknownReleaseStrip } from "./unknown-release-strip"
import { useWorkbenchGridKeyboard } from "./use-workbench-grid-keyboard"
import { useWorkbenchRowWindow } from "./use-workbench-row-window"
import type { WorkbenchEditableColumn } from "./workbench-cell-editor"
import { workbenchColumnField } from "./workbench-columns"
import {
  batchSelectionScopes,
  type WorkbenchColumnFields,
  type WorkbenchStores,
} from "./workbench-contract"
import { useWorkbenchDialogs, WorkbenchDialogs } from "./workbench-dialogs"
import { WorkbenchGrid } from "./workbench-grid"
import { useWorkbenchLiveStatus } from "./workbench-live-status"
import { ReconcileFilterBar } from "./reconcile-filter-bar"
import {
  filterReconcileRows,
  reconcileCounts,
  type ReconcileFilter,
} from "./reconcile-filter"
import { WorkbenchRibbon } from "./workbench-ribbon"

export type FieldWorkbenchProps = {
  schema: CategorySchemaView
  supplierBound?: boolean
  rows: ListingRow[]
  productDrafts: Record<string, WorkflowDraftView>
  /** Per-row durable save phase, keyed by Product Instance draft id. */
  rowSaveStates: Record<string, SaveState>
  /** The card template draft the 默认字段 dialog writes. */
  cardDraft: WorkflowCategoryDraft
  cardIssues: WorkflowValidationIssue[]
  cardFieldOrigins: FieldValueOrigin[]
  targetStoreId: string
  /** Card-wide work: import, media edits, and the send queue. */
  busy: boolean
  /**
   * Rows inside the current strict preparation step.
   */
  activity: PreparationActivity
  preparationProgress: PreparationProgress
  guidedPreparation: GuidedPreparation
  queuePaused: boolean
  queueRunning: boolean
  queueStopRequested: boolean
  queueHaltReason?: QueueHaltReason | null
  storeConfigured: boolean
  storeLabel: string
  storeIssue?: CardStoreAvailability["issue"]
  dragging: boolean
  selectedRowIds: ReadonlySet<string>
  onSelectionChange: (rowIds: string[]) => void
  onImportImages: () => void
  onClearRows: (rowIds: string[]) => void
  onRemoveRows: (rowIds: string[]) => void
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
  onRunAiRows: (rowIds: string[]) => void
  onRunRenderRows: (rowIds: string[]) => void
  onRunDeliverRows: (rowIds: string[]) => void
  onPrepareRows: (rowIds: string[]) => void
  onStopPreparation: () => void
  onCancelRowIntent: (draftId: string) => void
  onSendRows: (rowIds: string[]) => void
  onRepairRows?: (rowIds: string[]) => void
  /** True only when native edit/save/revalidation is wired, not merely a row callback. */
  brandRepairAvailable?: boolean
  canRepairRow?: BrandRepairCapability["current"]
  onInspectUnknownRows?: (rowIds: string[]) => void
  canReleaseUnknownRows?: (rowIds: readonly string[]) => boolean
  repairing?: boolean
  onReleaseUnknownRows?: (rowIds: string[]) => void
  releasingUnknown?: boolean
  onPauseQueue: () => void
  onUpdateCardDefault: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onAddComplexItem?: (complexId: number) => void
  onRemoveComplexItem?: (complexId: number, itemIndex: number) => void
  aiAllowedFieldKeys?: string[]
  aiProtectedFieldKeys?: string[]
  onPreviewSkuImport?: (sku: string) => Promise<SkuImportPreview>
  onApplySkuImport?: (candidates: SkuImportCandidate[], sourceSku: number) => void
  onFetchCategorySchema?: () => Promise<void>
  onCancelQueue: () => void
  onResumeQueue: () => void
  onOpenStores?: () => void
  onEditCard?: () => void
  stores?: OzonStoreView[]
  storeQuotas?: Record<string, number>
  onQuotaChange?: (storeId: string, quota: number) => void
  onEvenSplitQuotas?: () => void
}

/**
 * The batch workbench: one row per source image, one column per field an
 * operator reads or writes on the way to Ozon.
 *
 * Field first. Every column is the value itself — not a badge about the value —
 * so pipeline progress is legible as "5 切片 · 未上传" in the cell that will
 * carry the URLs, and there is no separate track rail to keep in sync. Batch
 * verbs act on the ticked rows, or on every eligible row when nothing is ticked.
 *
 * This is the assembly root: the ribbon, the grid, the rows and the dialogs
 * live in their own modules; here the card's props become their scopes.
 */
export function FieldWorkbench({
  schema,
  supplierBound = false,
  rows,
  productDrafts,
  rowSaveStates,
  cardDraft,
  cardIssues,
  cardFieldOrigins,
  targetStoreId,
  busy,
  activity,
  preparationProgress,
  guidedPreparation,
  queuePaused,
  queueRunning,
  queueStopRequested,
  queueHaltReason = null,
  storeConfigured,
  storeLabel,
  storeIssue,
  dragging,
  selectedRowIds,
  onSelectionChange,
  onImportImages,
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
  onRepairRows,
  repairing = false,
  brandRepairAvailable = false,
  canRepairRow,
  onInspectUnknownRows,
  canReleaseUnknownRows,
  onReleaseUnknownRows = () => {},
  releasingUnknown = false,
  onPauseQueue,
  onUpdateCardDefault,
  onAddComplexItem,
  onRemoveComplexItem,
  aiAllowedFieldKeys,
  aiProtectedFieldKeys,
  onPreviewSkuImport,
  onApplySkuImport,
  onFetchCategorySchema = async () => undefined,
  onCancelQueue,
  onResumeQueue,
  onOpenStores = () => {},
  onEditCard = () => {},
  stores,
  storeQuotas,
  onQuotaChange,
  onEvenSplitQuotas,
}: FieldWorkbenchProps) {
  const dialogs = useWorkbenchDialogs()
  const [reconcileFilter, setReconcileFilter] = useState<ReconcileFilter>("all")
  const shownRows = useMemo(
    () => filterReconcileRows(rows, productDrafts, reconcileFilter),
    [productDrafts, reconcileFilter, rows],
  )
  const probeCounts = useMemo(
    () => reconcileCounts(rows, productDrafts),
    [productDrafts, rows],
  )
  const queueLocked = queuePaused || queueRunning
  const queueDispatching = queueRunning
  const liveStatusCards = useWorkbenchLiveStatus({
    queueRunning,
    queuePaused,
    queueStopRequested,
    queueHaltReason,
    storeConfigured,
    storeIssue,
    unknownImageName: rows.find((row) => row.stage === "outcome_unknown")
      ?.imageName,
    progress: preparationProgress,
    guided: guidedPreparation,
    activity,
    rows,
    retryDisabled: busy || queueLocked,
    onStopPreparation,
    onCancelQueue,
    onResumeQueue,
    onOpenStores,
    onEditCard,
    onRetryAi: onRunAiRows,
    onRetryRender: onRunRenderRows,
    onRetryDeliver: onRunDeliverRows,
  })
  // Row creation and the next preparation step wait for the current step.
  const preparing = guidedPreparation.active || preparationRunning(activity)
  const { tableScrollRef, rowWindow, onTableScroll } = useWorkbenchRowWindow(shownRows.length)

  const boundStoreIds = useMemo(() => parseStoreIds(targetStoreId), [targetStoreId])
  const storeSlices = useMemo(
    () => calculateSequentialStoreSlices(rows.length, boundStoreIds, storeQuotas),
    [rows.length, boundStoreIds, storeQuotas],
  )
  const storeMap = useMemo(
    () => Object.fromEntries((stores ?? []).map((s) => [s.id, s])),
    [stores],
  )
  const storeColors = useStoreColorPreferences(boundStoreIds)
  const boundStores: WorkbenchStores = { ...storeColors, boundStoreIds, storeSlices, storeMap }

  const columnFields = useMemo<WorkbenchColumnFields>(
    () => ({
      name: workbenchColumnField(schema, "name"),
      description: workbenchColumnField(schema, "description"),
      tags: workbenchColumnField(schema, "tags"),
      theme: workbenchColumnField(schema, "theme"),
      price: workbenchColumnField(schema, "price"),
      oldPrice: workbenchColumnField(schema, "old_price"),
      richContent: workbenchColumnField(schema, "rich_content"),
      model: workbenchColumnField(schema, "model"),
    }),
    [schema],
  )

  const themeField = columnFields.theme

  /** 卡默认字段的四个 tableInput 值：没打过的行走这一份，格子里只作占位提示。 */
  const cardPrice = valueAsText(cardDraft.values.price)
  const cardOldPrice = valueAsText(cardDraft.values.old_price)
  const cardTheme = themeField
    ? fieldDisplayValueAsText(themeField, cardDraft.values[themeField.key])
        .split("\n")
        .filter(Boolean)
        .join("、")
    : ""
  const richContentField = columnFields.richContent
  const cardRichContent = richContentField
    ? valueAsText(cardDraft.values[richContentField.key]).trim()
    : ""

  // Which rows a verb would act on is decided by `batch-actions.ts`, the same
  // module the screen's handlers filter with. A second copy of these predicates
  // here is how a button ends up counting rows the verb then skips.
  const scopes = useMemo(
    () => workbenchScopes(rows, productDrafts, selectedRowIds, activity, queueRunning, queuePaused),
    [activity, productDrafts, queuePaused, queueRunning, rows, selectedRowIds],
  )

  const selectionScopes = useMemo(
    () => batchSelectionScopes(rows, productDrafts, activity),
    [activity, productDrafts, rows],
  )
  const grid = useWorkbenchGridKeyboard({
    rows: shownRows,
    productDrafts,
    selectedRowIds,
    fields: columnFields,
    tableScrollRef,
    onSelectionChange,
    onEditCell,
    onEditField,
    onRetryRowSave,
    onRunAiRows,
    onRunRenderRows,
    onRunDeliverRows,
    onCancelRowIntent,
    onRepairRows: brandRepairAvailable ? onRepairRows : undefined,
    openProse: dialogs.setProseEdit,
    openTheme: dialogs.setThemeEdit,
    reviewCandidates: dialogs.setReviewRow,
  })

  const selectedSendable = scopes.picked.filter((row) =>
    sendBatchEligible(row, productDrafts[row.draftId]?.lifecycle),
  )
  const selectedMode = scopes.picked.length > 0
  const sendTargets = selectedMode ? selectedSendable : scopes.sendTargets
  const { releaseTargets } = scopes
  const releaseAvailable = canReleaseUnknownRows?.(releaseTargets.map((row) => row.id)) ?? false
  const releaseFacts = unknownReleaseFacts(releaseTargets, productDrafts, storeMap, releaseAvailable)
  // Same gate as the 修复标签并发送 bar; rows receive a boolean, so their memo holds.
  const repairLocked = !brandRepairAvailable || !onRepairRows || busy || repairing || preparing || queueLocked
  const brandRepairable = useMemo(
    () => repairLocked ? new Set<string>() : brandRepairRowIds(rows.filter((row) =>
      (!canRepairRow || canRepairRow(row, productDrafts[row.draftId]?.lifecycle.revision ?? -1))
      && brandRepairIssueCurrent(productDrafts[row.draftId]?.lifecycle, row.draftId, productDrafts[row.draftId]?.target_store_id)), productDrafts, activity),
    [repairLocked, rows, productDrafts, activity, canRepairRow],
  )
  const repairTargets = scopes.repairTargets.filter((row) => brandRepairable.has(row.id))
  const stockEligible = listedStockTargets(
    rows,
    productDrafts,
    selectedRowIds,
    targetStoreId,
  )

  return (
    <div className="relative flex flex-1 flex-col w-full min-w-0 max-w-full gap-2 min-h-0">
      {dragging ? (
        <div className="pointer-events-none absolute inset-0 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-brand bg-brand-soft/90 text-md font-medium text-brand-ink">
          松开导入，每张图建一行
        </div>
      ) : null}

      <WorkbenchRibbon
        rows={rows}
        scopes={scopes}
        selectionScopes={selectionScopes}
        stores={boundStores}
        sendTargets={sendTargets}
        liveStatusCards={liveStatusCards}
        supplierBound={supplierBound}
        busy={busy}
        preparing={preparing}
        activity={activity}
        preparationProgress={preparationProgress}
        guidedPreparation={guidedPreparation}
        queuePaused={queuePaused}
        queueRunning={queueRunning}
        queueStopRequested={queueStopRequested}
        storeConfigured={storeConfigured}
        storeLabel={storeLabel}
        onSelectionChange={onSelectionChange}
        onImportImages={onImportImages}
        onOpenDefaults={() => dialogs.setDefaultsOpen(true)}
        onOpenModel={
          columnFields.model ? () => dialogs.setModelBatchOpen(true) : undefined
        }
        onQuotaChange={onQuotaChange}
        onEvenSplitQuotas={onEvenSplitQuotas}
        onPrepareRows={onPrepareRows}
        onStopPreparation={onStopPreparation}
        onRunAiRows={onRunAiRows}
        onRunRenderRows={onRunRenderRows}
        onRunDeliverRows={onRunDeliverRows}
        onPauseQueue={onPauseQueue}
        onConfirmDelete={dialogs.setPendingDeleteIds}
        onConfirmClear={dialogs.setPendingClearIds}
        onConfirmSend={dialogs.setPendingSendIds}
        onOpenStock={() => openListedStockOrExplain(stockEligible, selectedMode, dialogs.setStockTargets)}
      />

      {brandRepairAvailable && (repairTargets.length > 0 || repairing) ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 px-1">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || repairing || preparing || queueLocked || !repairTargets.length}
            onClick={() => onRepairRows?.(repairTargets.map((row) => row.id))}
            aria-label={`修复标签并发送 ${repairTargets.length}`}
            aria-busy={repairing}
          >
            {repairing ? <LoaderCircle aria-hidden className="animate-spin" /> : <RefreshCw aria-hidden />}
            <span>{repairing ? "修复中…" : `修复标签并发送 ${repairTargets.length}`}</span>
          </Button>
          <p className="text-sm text-foreground">
            清空违规搜索标签并发送到 Ozon，复用识别结果和已上传图片。后台卡片会按新内容更新。
          </p>
        </div>
      ) : null}

      <ReconcileFilterBar value={reconcileFilter} counts={probeCounts} onChange={setReconcileFilter} />

      <UnknownReleaseStrip
        available={releaseAvailable}
        facts={releaseFacts}
        rowIds={releaseTargets.map((row) => row.id)}
        releasing={releasingUnknown}
        disabled={busy || preparing || queueLocked}
        onRelease={onReleaseUnknownRows}
        onInspect={onInspectUnknownRows}
      />

      {shownRows.length === 0 && rows.length > 0 ? (
        <p className="px-1 text-sm text-muted-foreground">没有符合筛选的行</p>
      ) : (
      <WorkbenchGrid
        rows={shownRows}
        productDrafts={productDrafts}
        rowSaveStates={rowSaveStates}
        selectedRowIds={selectedRowIds}
        pickedCount={scopes.picked.length}
        fields={columnFields}
        fallbacks={{ cardPrice, cardOldPrice, cardTheme, cardRichContent }}
        stores={boundStores}
        brandRepairable={brandRepairable}
        preparing={preparing}
        importDisabled={busy || queueLocked || preparing}
        grid={grid}
        rowWindow={rowWindow}
        tableScrollRef={tableScrollRef}
        onTableScroll={onTableScroll}
        onSelectionChange={onSelectionChange}
        onImportImages={onImportImages}
      />
      )}

      <WorkbenchDialogs
        state={dialogs}
        schema={schema}
        targetStoreId={targetStoreId}
        rows={rows}
        selectedRowIds={selectedRowIds}
        productDrafts={productDrafts}
        fields={columnFields}
        stores={boundStores}
        storeLabel={storeLabel}
        selectedMode={selectedMode}
        busy={busy}
        queueDispatching={queueDispatching}
        cardDraft={cardDraft}
        cardIssues={cardIssues}
        cardFieldOrigins={cardFieldOrigins}
        aiAllowedFieldKeys={aiAllowedFieldKeys}
        aiProtectedFieldKeys={aiProtectedFieldKeys}
        onFlushRows={onFlushRows}
        onEditCell={onEditCell}
        onEditField={onEditField}
        onClearRows={onClearRows}
        onRemoveRows={onRemoveRows}
        onSendRows={onSendRows}
        onUpdateCardDefault={onUpdateCardDefault}
        onAddComplexItem={onAddComplexItem}
        onRemoveComplexItem={onRemoveComplexItem}
        onPreviewSkuImport={onPreviewSkuImport}
        onApplySkuImport={onApplySkuImport}
        onFetchCategorySchema={onFetchCategorySchema}
      />
    </div>
  )
}

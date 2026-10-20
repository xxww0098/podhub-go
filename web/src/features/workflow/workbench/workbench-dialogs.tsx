import { useMemo, useState } from "react"
import { Eraser, Send, Trash2 } from "lucide-react"
import type {
  CategorySchemaView,
  FieldValueOrigin,
  SkuImportCandidate,
  SkuImportPreview,
  WorkflowCategoryDraft,
  WorkflowDraftValue,
  WorkflowDraftView,
  WorkflowValidationIssue,
} from "@/bindings/commands"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { CandidateReviewDialog } from "../candidate-review-dialog"
import { DefaultFieldsDialog } from "../default-fields-dialog"
import { DictionaryPickerDialog } from "../dictionary-drawer-field"
import { ListedStockDialog, type ListedStockTarget } from "../listed-stock-dialog"
import type { ListingRow } from "../model/listing-row"
import { proseCellSkip } from "../model/listing-row-lifecycle"
import type { WorkflowValueLocation } from "../workflow-draft"
import { fieldLocation } from "../workflow-shared"
import {
  WorkbenchProseEditor,
  type WorkbenchEditableColumn,
  type WorkbenchProseEdit,
} from "./workbench-cell-editor"
import type { ProseScopeRow } from "./workbench-cell-edit"
import {
  proseCellText,
  type WorkbenchColumnFields,
  type WorkbenchStores,
  type WorkbenchThemeEdit,
} from "./workbench-contract"
import { typedCellRawValue } from "./workbench-grid-navigation"
import { WorkbenchModelDialog } from "./workbench-model-dialog"
import { SendConfirmFacts, sendConfirmAnnouncement } from "./workbench-send-controls"

/** Which dialog is open and with what rows; every workbench dialog reads one field. */
export function useWorkbenchDialogs() {
  const [defaultsOpen, setDefaultsOpen] = useState(false)
  const [modelBatchOpen, setModelBatchOpen] = useState(false)
  const [reviewRow, setReviewRow] = useState<ListingRow | null>(null)
  const [proseEdit, setProseEdit] = useState<WorkbenchProseEdit | null>(null)
  const [themeEdit, setThemeEdit] = useState<WorkbenchThemeEdit | null>(null)
  const [pendingClearIds, setPendingClearIds] = useState<string[]>([])
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([])
  const [pendingSendIds, setPendingSendIds] = useState<string[]>([])
  const [stockTargets, setStockTargets] = useState<ListedStockTarget[]>([])
  return {
    defaultsOpen,
    setDefaultsOpen,
    modelBatchOpen,
    setModelBatchOpen,
    reviewRow,
    setReviewRow,
    proseEdit,
    setProseEdit,
    themeEdit,
    setThemeEdit,
    pendingClearIds,
    setPendingClearIds,
    pendingDeleteIds,
    setPendingDeleteIds,
    pendingSendIds,
    setPendingSendIds,
    stockTargets,
    setStockTargets,
  }
}

type WorkbenchDialogState = ReturnType<typeof useWorkbenchDialogs>

/**
 * Every dialog the workbench opens: candidate review, the 主题 picker, the
 * shared prose editor, stock, 默认字段, and the clear / delete / send
 * confirmations. Irreversible verbs only run from their confirm button.
 */
export function WorkbenchDialogs({
  state,
  schema,
  targetStoreId,
  rows,
  selectedRowIds,
  productDrafts,
  fields,
  stores,
  storeLabel,
  selectedMode,
  busy,
  queueDispatching,
  cardDraft,
  cardIssues,
  cardFieldOrigins,
  aiAllowedFieldKeys,
  aiProtectedFieldKeys,
  onFlushRows,
  onEditCell,
  onEditField,
  onClearRows,
  onRemoveRows,
  onSendRows,
  onUpdateCardDefault,
  onAddComplexItem,
  onRemoveComplexItem,
  onPreviewSkuImport,
  onApplySkuImport,
  onFetchCategorySchema,
}: {
  state: WorkbenchDialogState
  schema: CategorySchemaView
  targetStoreId: string
  rows: ListingRow[]
  selectedRowIds: ReadonlySet<string>
  productDrafts: Record<string, WorkflowDraftView>
  fields: WorkbenchColumnFields
  stores: WorkbenchStores
  storeLabel: string
  selectedMode: boolean
  busy: boolean
  queueDispatching: boolean
  cardDraft: WorkflowCategoryDraft
  cardIssues: WorkflowValidationIssue[]
  cardFieldOrigins: FieldValueOrigin[]
  aiAllowedFieldKeys?: string[]
  aiProtectedFieldKeys?: string[]
  onFlushRows: (draftIds: readonly string[]) => Promise<boolean>
  onEditCell: (
    draftId: string,
    column: WorkbenchEditableColumn,
    value: string,
  ) => void
  onEditField: (
    draftId: string,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onClearRows: (rowIds: string[]) => void
  onRemoveRows: (rowIds: string[]) => void
  onSendRows: (rowIds: string[]) => void
  onUpdateCardDefault: (
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  onAddComplexItem?: (complexId: number) => void
  onRemoveComplexItem?: (complexId: number, itemIndex: number) => void
  onPreviewSkuImport?: (sku: string) => Promise<SkuImportPreview>
  onApplySkuImport?: (candidates: SkuImportCandidate[], sourceSku: number) => void
  onFetchCategorySchema: () => Promise<void>
}) {
  const {
    modelBatchOpen,
    setModelBatchOpen,
    reviewRow,
    setReviewRow,
    proseEdit,
    setProseEdit,
    themeEdit,
    setThemeEdit,
    stockTargets,
    setStockTargets,
    defaultsOpen,
    setDefaultsOpen,
    pendingClearIds,
    setPendingClearIds,
    pendingDeleteIds,
    setPendingDeleteIds,
    pendingSendIds,
    setPendingSendIds,
  } = state
  const themeField = fields.theme
  const { boundStoreIds, storeMap, storeColorAssignments } = stores

  const proseScope = useMemo(() => {
    if (!proseEdit) return { selected: false, rows: [] as ProseScopeRow[] }
    const picked = rows.filter((row) => selectedRowIds.has(row.id))
    const scope = picked.length ? picked : rows
    return {
      selected: picked.length > 0,
      rows: scope.map((row) => {
        const product = productDrafts[row.draftId]
        const skip = proseCellSkip(row, product)
        return {
          draftId: row.draftId,
          writable: skip === null,
          empty: !proseCellText(proseEdit.column, product, fields).trim(),
          skip,
        }
      }),
    }
  }, [proseEdit, rows, selectedRowIds, productDrafts, fields])

  return (
    <>
      <CandidateReviewDialog key={reviewRow?.draftId ?? "closed"} row={reviewRow} schema={schema} flushRows={onFlushRows} onClose={() => setReviewRow(null)} />

      {themeEdit && themeField ? (
        <DictionaryPickerDialog
          open
          onClose={() => setThemeEdit(null)}
          field={themeField}
          schema={schema}
          targetStoreId={targetStoreId}
          value={
            productDrafts[themeEdit.draftId]
              ? typedCellRawValue(
                  productDrafts[themeEdit.draftId],
                  themeField,
                )
              : undefined
          }
          onChange={(value) =>
            onEditField(
              themeEdit.draftId,
              themeField.key,
              value,
              fieldLocation(themeField),
            )
          }
        />
      ) : null}
      <WorkbenchProseEditor
        edit={proseEdit}
        scope={proseScope}
        onClose={() => setProseEdit(null)}
        onCommit={(session, value) => onEditCell(session.draftId, session.column, value)}
        onCommitColumn={(session, value, draftIds) => {
          for (const draftId of draftIds) onEditCell(draftId, session.column, value)
        }}
      />

      <ListedStockDialog
        open={stockTargets.length > 0}
        targets={stockTargets}
        storeLabel={
          storeMap[stockTargets[0]?.storeId ?? ""]?.label
          || stockTargets[0]?.storeId
          || storeLabel
        }
        onClose={() => setStockTargets([])}
      />

      {/* 型号 belongs to one row, so its batch verbs rewrite the selected rows
          through the same single-row autosave instead of a card default. */}
      {fields.model ? (
        <WorkbenchModelDialog
          open={modelBatchOpen}
          onOpenChange={setModelBatchOpen}
          rows={rows}
          productDrafts={productDrafts}
          selectedRowIds={selectedRowIds}
          field={fields.model}
          onEditCell={onEditCell}
          onFlushRows={onFlushRows}
        />
      ) : null}

      <DefaultFieldsDialog
        open={defaultsOpen}
        onOpenChange={setDefaultsOpen}
        schema={schema}
        draft={cardDraft}
        issues={cardIssues}
        fieldOrigins={cardFieldOrigins}
        targetStoreId={targetStoreId}
        onUpdateValue={onUpdateCardDefault}
        onAddComplexItem={onAddComplexItem}
        onRemoveComplexItem={onRemoveComplexItem}
        aiAllowedFieldKeys={aiAllowedFieldKeys}
        aiProtectedFieldKeys={aiProtectedFieldKeys}
        onPreviewSkuImport={onPreviewSkuImport}
        onApplySkuImport={onApplySkuImport}
        onFetchSchema={onFetchCategorySchema}
        busy={busy}
        queueLocked={queueDispatching}
      />

      <ConfirmDialog
        open={pendingClearIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingClearIds([])
        }}
        title={`清空 ${pendingClearIds.length} 行的生成内容？`}
        description="清空名称、简介、切片和上传结果。原图、货号、型号、店铺和视频保留，清空后可重新一键准备生成。"
        confirmText="确认清空"
        variant="destructive"
        icon={<Eraser aria-hidden />}
        onConfirm={() => {
          const ids = pendingClearIds
          setPendingClearIds([])
          onClearRows(ids)
        }}
      />

      <ConfirmDialog
        open={pendingDeleteIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteIds([])
        }}
        title={`删除 ${pendingDeleteIds.length} 行商品？`}
        description="删除草稿和媒体进度。已上架商品不受影响，不可撤销。"
        confirmText="确认删除"
        variant="destructive"
        icon={<Trash2 aria-hidden />}
        onConfirm={() => {
          const ids = pendingDeleteIds
          setPendingDeleteIds([])
          onRemoveRows(ids)
        }}
      />

      <ConfirmDialog
        open={pendingSendIds.length > 0}
        onOpenChange={(open) => {
          if (!open) setPendingSendIds([])
        }}
        title={
          selectedMode
            ? `确认发送选中的 ${pendingSendIds.length} 件商品？`
            : `确认发送 ${pendingSendIds.length} 件商品？`
        }
        description={sendConfirmAnnouncement(storeLabel, boundStoreIds.length)}
        descriptionClassName="sr-only"
        size="md"
        confirmText="确认发送"
        variant="brand"
        icon={<Send aria-hidden />}
        onConfirm={() => {
          const ids = pendingSendIds
          setPendingSendIds([])
          onSendRows(ids)
        }}
      >
        <SendConfirmFacts
          storeLabel={storeLabel}
          storeIds={boundStoreIds}
          storeMap={storeMap}
          assignments={storeColorAssignments}
        />
      </ConfirmDialog>
    </>
  )
}

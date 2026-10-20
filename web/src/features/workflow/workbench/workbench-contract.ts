import type {
  OzonStoreView,
  WorkflowDraftValue,
  WorkflowDraftView,
} from "@/bindings/commands"
import {
  aiBatchEligible,
  deliverBatchEligible,
  renderBatchEligible,
  sendBatchEligible,
  type workbenchScopes,
} from "../batch-actions"
import type { ListingRow } from "../model/listing-row"
import { bucketOf, rowStatusFromLifecycle } from "../model/listing-row-lifecycle"
import {
  NO_PREPARATION_ACTIVITY,
  type PreparationActivity,
  type PreparationVerb,
} from "../prepare/preparation-tracks"
import type { calculateSequentialStoreSlices } from "../store-quota"
import type { useStoreColorPreferences } from "../use-store-color-preferences"
import {
  readWorkflowValue,
  valueAsText,
  type WorkflowValueLocation,
} from "../workflow-draft"
import { fieldLocation } from "../workflow-shared"
import type { WorkbenchEditableColumn, WorkbenchProseEdit } from "./workbench-cell-editor"
import { formatTagString } from "./workbench-cell-edit"
import { typedCellRawText, type WorkbenchColumnFields } from "./workbench-grid-navigation"
import { modelText } from "./workbench-model"

export type { WorkbenchColumnFields }

export function proseCellText(
  column: WorkbenchEditableColumn,
  product: WorkflowDraftView | undefined,
  fields: WorkbenchColumnFields,
): string {
  if (column === "tags") {
    if (product?.draft && fields.tags) {
      const raw = readWorkflowValue(
        product.draft,
        fields.tags.key,
        fieldLocation(fields.tags),
      )
      return valueAsText(raw).trim()
    }
    return formatTagString(product?.lifecycle.ai_summary?.tags ?? [])
  }
  if (column === "rich_content") {
    // JSON富内容 is a tableInput: only the row's own typed value counts. An
    // untouched row inherits the card default at send (painted as the cell's
    // muted placeholder), so it still counts as empty for 「填入 N 行」.
    if (!product?.draft || !fields.richContent) return ""
    return typedCellRawText(product, fields.richContent)
  }
  if (column === "model") {
    // 型号 counts as the row's own only when it was actually written: the
    // file-name fallback the cell paints is not an answer, so 「填入 N 行」
    // still reaches every row whose model comes from the source name.
    return modelText(product?.draft, fields.model)
  }
  const field = column === "name" ? fields.name : fields.description
  if (!product?.draft || !field) return ""
  return valueAsText(readWorkflowValue(product.draft, field.key, fieldLocation(field)))
}

/** Which row's 主题 the picker edits. The value comes from the row's own typed cell. */
export type WorkbenchThemeEdit = { draftId: string }

export type WorkbenchRowActions = {
  toggle: (index: number, checked: boolean) => void
  armShift: (shift: boolean) => void
  openProse: (edit: WorkbenchProseEdit) => void
  openTheme: (edit: WorkbenchThemeEdit) => void
  /** 逐行输入列（销售价/划线价）把打完的值写进这一行。 */
  editField: (
    draftId: string,
    fieldKey: string,
    value: WorkflowDraftValue | undefined,
    location: WorkflowValueLocation,
  ) => void
  reviewCandidates: (row: ListingRow) => void
  retrySave: (draftId: string) => void
  /** Retry one failed prepare stage; never whole-row 一键准备. */
  retryStage: (rowId: string, verb: PreparationVerb) => void
  /** Retry the row’s failed media track through its existing batch handler. */
  retryMedia: (rowId: string) => void
  /** Soft-cancel the Cloud submission intent for this Product Instance. */
  cancelIntent: (draftId: string) => void
  /** Clear this row's violating search tags and send it; the policy is re-checked there. */
  repairBrand: (rowId: string) => void
  focusCell: (rowIndex: number, colIndex: number) => void
}

export type BatchSelectionScope = {
  key: "exceptions" | "ai" | "render" | "deliver" | "send" | "unsent" | "listed"
  label: string
  rows: ListingRow[]
}

/**
 * Row scopes for 按状态选择. Counts use the same eligibility predicates as
 * the ribbon verbs, so a row whose local source is gone is not 「待识别」.
 */
export function batchSelectionScopes(
  rows: ListingRow[],
  productDrafts: Record<string, WorkflowDraftView>,
  activity: PreparationActivity = NO_PREPARATION_ACTIVITY,
): BatchSelectionScope[] {
  const unsent: ListingRow[] = []
  const listed: ListingRow[] = []
  const exceptions: ListingRow[] = []
  const ai: ListingRow[] = []
  const render: ListingRow[] = []
  const deliver: ListingRow[] = []
  const send: ListingRow[] = []
  for (const row of rows) {
    if ((productDrafts[row.draftId]?.lifecycle.ozon_sku ?? 0) > 0) {
      listed.push(row)
    }
    const lifecycle = productDrafts[row.draftId]?.lifecycle
    if (lifecycle && rowStatusFromLifecycle(lifecycle) === "sent") continue
    if (!lifecycle && row.status === "sent") continue
    unsent.push(row)
    if (lifecycle && bucketOf(lifecycle) === "exceptions") {
      exceptions.push(row)
    }
    if (aiBatchEligible(row, lifecycle, activity)) ai.push(row)
    if (renderBatchEligible(row, lifecycle, activity)) render.push(row)
    if (deliverBatchEligible(row, lifecycle, activity)) deliver.push(row)
    if (sendBatchEligible(row, lifecycle)) send.push(row)
  }
  return [
    { key: "exceptions", label: "异常行", rows: exceptions },
    { key: "ai", label: "待识别", rows: ai },
    { key: "render", label: "待切片", rows: render },
    { key: "deliver", label: "待上传", rows: deliver },
    { key: "send", label: "可发送", rows: send },
    { key: "unsent", label: "全部未发送", rows: unsent },
    { key: "listed", label: "已有 SKU", rows: listed },
  ]
}

/** The row scopes every ribbon verb counts and acts on (`batch-actions.ts`). */
export type WorkbenchScopes = ReturnType<typeof workbenchScopes>

/**
 * The card's bound Stores as the ribbon, the rows and the send confirmation
 * read them: one colour assignment, one quota split, one label lookup.
 */
export type WorkbenchStores = ReturnType<typeof useStoreColorPreferences> & {
  boundStoreIds: string[]
  storeSlices: ReturnType<typeof calculateSequentialStoreSlices>
  storeMap: Record<string, OzonStoreView | undefined>
}

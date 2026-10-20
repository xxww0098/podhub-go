import type {
  CategoryFieldView,
  WorkflowDraftValue,
  WorkflowDraftView,
} from "@/bindings/commands"
import type { ListingRow } from "../model/listing-row"
import { proseCellSkip } from "../model/listing-row-lifecycle"
import { WORKBENCH_COLUMNS, type WorkbenchColumn } from "./workbench-columns"
import type { WorkbenchEditableColumn } from "./workbench-cell-editor"
import { formatTagString } from "./workbench-cell-edit"
import { modelText } from "./workbench-model"
import {
  fieldDisplayValueAsText,
  readWorkflowValue,
  valueAsText,
} from "../workflow-draft"
import { fieldLocation } from "../workflow-shared"

export type GridCoordinate = {
  rowIndex: number
  colIndex: number
}

export type GridNavDirection =
  | "up"
  | "down"
  | "left"
  | "right"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"

export type GridAction =
  | GridNavDirection
  | "select-toggle"
  | "select-all"
  | "open-edit"
  | "fill-down"
  | "copy"
  | "escape"

export function columnAt(colIndex: number): WorkbenchColumn | undefined {
  return WORKBENCH_COLUMNS[colIndex]
}

export function colIndexFor(columnId: string): number {
  return WORKBENCH_COLUMNS.findIndex((col) => col.id === columnId)
}

export function editableColumnForIndex(
  colIndex: number,
): WorkbenchEditableColumn | null {
  const col = columnAt(colIndex)
  if (
    col?.id === "name" ||
    col?.id === "description" ||
    col?.id === "tags" ||
    col?.id === "rich_content" ||
    col?.id === "model"
  ) {
    return col.id
  }
  return null
}

export function nextGridCoordinate(
  current: GridCoordinate | null,
  action: GridNavDirection,
  rowCount: number,
  colCount: number = WORKBENCH_COLUMNS.length,
): GridCoordinate | null {
  if (rowCount <= 0 || colCount <= 0) return null
  if (!current) {
    return { rowIndex: 0, colIndex: 0 }
  }

  const { rowIndex, colIndex } = current
  switch (action) {
    case "up":
      return { rowIndex: Math.max(0, rowIndex - 1), colIndex }
    case "down":
      return { rowIndex: Math.min(rowCount - 1, rowIndex + 1), colIndex }
    case "left":
      return { rowIndex, colIndex: Math.max(0, colIndex - 1) }
    case "right":
      return { rowIndex, colIndex: Math.min(colCount - 1, colIndex + 1) }
    case "home":
      return { rowIndex, colIndex: 0 }
    case "end":
      return { rowIndex, colIndex: colCount - 1 }
    case "pageup":
      return { rowIndex: Math.max(0, rowIndex - 10), colIndex }
    case "pagedown":
      return { rowIndex: Math.min(rowCount - 1, rowIndex + 10), colIndex }
  }
}

export function gridActionFromKey(event: {
  key: string
  shiftKey?: boolean
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
}): GridAction | null {
  const cmd = Boolean(event.metaKey || event.ctrlKey)

  if (cmd && (event.key === "d" || event.key === "D")) {
    return "fill-down"
  }
  if (cmd && (event.key === "c" || event.key === "C")) {
    return "copy"
  }
  if (cmd && (event.key === "a" || event.key === "A")) {
    return "select-all"
  }

  if (event.key === "Escape") {
    return "escape"
  }

  if (event.key === " " && !cmd && !event.altKey) {
    return "select-toggle"
  }

  if ((event.key === "Enter" || event.key === "F2") && !cmd && !event.altKey) {
    return "open-edit"
  }

  switch (event.key) {
    case "ArrowUp":
      return "up"
    case "ArrowDown":
      return "down"
    case "ArrowLeft":
      return "left"
    case "ArrowRight":
      return "right"
    case "Home":
      return "home"
    case "End":
      return "end"
    case "PageUp":
      return "pageup"
    case "PageDown":
      return "pagedown"
    default:
      return null
  }
}

export type WorkbenchColumnFields = {
  name?: CategoryFieldView
  description?: CategoryFieldView
  tags?: CategoryFieldView
  theme?: CategoryFieldView
  price?: CategoryFieldView
  oldPrice?: CategoryFieldView
  richContent?: CategoryFieldView
  model?: CategoryFieldView
}

/**
 * Copied/read-out text of a 逐行输入 cell matches what the grid paints: only a
 * `handEditedKeys`-marked key is the row's own answer; a seeded card-default
 * copy or a cleared key reads empty and the cell inherits the card default
 * shown as the placeholder.
 */
export function typedCellRawValue(
  product: WorkflowDraftView,
  field: CategoryFieldView,
): WorkflowDraftValue | undefined {
  const cleared = product.draft.cleared ?? []
  if (
    cleared.includes(field.key) ||
    !product.hand_edited_keys?.includes(field.key)
  ) {
    return undefined
  }
  return readWorkflowValue(product.draft, field.key, fieldLocation(field))
}

export function typedCellRawText(
  product: WorkflowDraftView,
  field: CategoryFieldView,
): string {
  return valueAsText(typedCellRawValue(product, field))
}

export function readCellRawText(
  colIndex: number,
  row: ListingRow,
  product: WorkflowDraftView | undefined,
  fields: WorkbenchColumnFields,
): string {
  const column = columnAt(colIndex)
  if (!column) return ""

  switch (column.id) {
    case "select":
      return row.id
    case "source":
      return row.imageName
    case "publish_state":
      return row.status
    case "name": {
      if (!product?.draft || !fields.name) return ""
      return valueAsText(readWorkflowValue(product.draft, fields.name.key, fieldLocation(fields.name)))
    }
    case "offer_id": {
      return product?.draft ? valueAsText(product.draft.values.offer_id) : ""
    }
    case "model": {
      // Only the row's own 型号 — the file-name fallback is not its answer, the
      // same way 货号 copies nothing for a row that has no `offer_id` yet.
      return modelText(product?.draft, fields.model)
    }
    case "price": {
      if (!product?.draft || !fields.price) return ""
      return typedCellRawText(product, fields.price)
    }
    case "old_price": {
      if (!product?.draft || !fields.oldPrice) return ""
      return typedCellRawText(product, fields.oldPrice)
    }
    case "description": {
      if (!product?.draft || !fields.description) return ""
      return valueAsText(readWorkflowValue(product.draft, fields.description.key, fieldLocation(fields.description)))
    }
    case "tags": {
      if (product?.draft && fields.tags) {
        const raw = readWorkflowValue(
          product.draft,
          fields.tags.key,
          fieldLocation(fields.tags),
        )
        if (raw !== undefined) return valueAsText(raw).trim()
      }
      return formatTagString(product?.lifecycle.ai_summary?.tags ?? [])
    }
    case "theme": {
      if (!product?.draft || !fields.theme) return ""
      return fieldDisplayValueAsText(
        fields.theme,
        typedCellRawValue(product, fields.theme),
      )
        .split("\n")
        .filter(Boolean)
        .join("、")
    }
    case "rich_content": {
      if (!product?.draft || !fields.richContent) return ""
      return typedCellRawText(product, fields.richContent)
    }
    default:
      return column.label
  }
}

/** Every column ⌘D can fill from: the prose cells plus the per-row field columns. */
export type FillDownColumn =
  | WorkbenchEditableColumn
  | "price"
  | "old_price"
  | "theme"

export type FillDownPlan = {
  column: FillDownColumn
  columnLabel: string
  sourceValue: string
  targetDraftIds: string[]
  /** Present on a field-column plan (price / old_price / theme) — the attribute the fill writes. */
  field?: CategoryFieldView
  /** The value a field-column plan stamps as-is; undefined clears the target. */
  draftValue?: WorkflowDraftValue
}

function fillDownColumnForIndex(colIndex: number): FillDownColumn | null {
  const col = columnAt(colIndex)
  if (col?.id === "price" || col?.id === "old_price" || col?.id === "theme") {
    return col.id
  }
  return editableColumnForIndex(colIndex)
}

function isFieldColumn(
  column: FillDownColumn,
): column is "price" | "old_price" | "theme" {
  return column === "price" || column === "old_price" || column === "theme"
}

/**
 * Plans a Fill Down (Cmd+D / 向下批量填充) operation from the currently active cell.
 *
 * Rules:
 * 1. Must be on an editable column: "name", "description", "tags", "rich_content",
 *    and the three field columns "price" / "old_price" / "theme". A field-column
 *    plan also carries the schema field and the draft value to stamp — all
 *    four `tableInput` columns (price / old_price / theme / rich_content) keep
 *    their hand-edited gate, so a seeded card-default copy is never stamped as
 *    a row's own answer. A category without that attribute cannot take the
 *    fill at all.
 * 2. If multiple rows are selected: fills the active cell's value into all selected rows that are writable.
 * 3. If no multiple rows are selected: fills down from the current row to all writable rows below it (or just the row below if single step).
 */
export function planFillDown(input: {
  focusedCell: GridCoordinate
  rows: readonly ListingRow[]
  productDrafts: Readonly<Record<string, WorkflowDraftView>>
  selectedRowIds: ReadonlySet<string>
  fields: WorkbenchColumnFields
}): FillDownPlan | null {
  const { focusedCell, rows, productDrafts, selectedRowIds, fields } = input
  const editCol = fillDownColumnForIndex(focusedCell.colIndex)
  if (!editCol) return null

  const field =
    editCol === "price"
      ? fields.price
      : editCol === "old_price"
        ? fields.oldPrice
        : editCol === "theme"
          ? fields.theme
          : undefined
  if (isFieldColumn(editCol) && !field) return null

  const currentRow = rows[focusedCell.rowIndex]
  if (!currentRow) return null

  const currentProduct = productDrafts[currentRow.draftId]
  const sourceValue = readCellRawText(focusedCell.colIndex, currentRow, currentProduct, fields)
  // 型号 has no "clear" verb: 向下填充 from a row without its own 型号 would
  // stamp the empty value onto every target and the next build would silently
  // refill each from its own file name. Filling a written 型号 down is fine.
  if (editCol === "model" && !sourceValue.trim()) return null
  const draftValue =
    field && currentProduct ? typedCellRawValue(currentProduct, field) : undefined
  const columnDef = columnAt(focusedCell.colIndex)
  const columnLabel = columnDef?.label || "文本"

  const targetDraftIds: string[] = []

  if (selectedRowIds.size > 0 && selectedRowIds.has(currentRow.id)) {
    // Fill across selected rows
    for (const r of rows) {
      if (!selectedRowIds.has(r.id)) continue
      const prod = productDrafts[r.draftId]
      if (proseCellSkip(r, prod) === null) {
        targetDraftIds.push(r.draftId)
      }
    }
  } else {
    // Fill down from current row to subsequent rows below
    const belowRows = rows.slice(focusedCell.rowIndex + 1)
    for (const r of belowRows) {
      const prod = productDrafts[r.draftId]
      if (proseCellSkip(r, prod) === null) {
        targetDraftIds.push(r.draftId)
      }
    }
    // If no subsequent rows, at least include current row if writable
    if (targetDraftIds.length === 0 && proseCellSkip(currentRow, currentProduct) === null) {
      targetDraftIds.push(currentRow.draftId)
    }
  }

  return {
    column: editCol,
    columnLabel,
    sourceValue,
    targetDraftIds,
    field,
    draftValue,
  }
}

import { useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import type { WorkflowDraftValue, WorkflowDraftView } from "@/bindings/commands"
import { notifySuccess } from "@/lib/notify"
import type { ListingRow } from "../model/listing-row"
import { mediaRetry } from "../prepare/preparation-branches"
import type { WorkflowValueLocation } from "../workflow-draft"
import { fieldLocation } from "../workflow-shared"
import type { WorkbenchEditableColumn, WorkbenchProseEdit } from "./workbench-cell-editor"
import {
  proseCellText,
  type WorkbenchColumnFields,
  type WorkbenchRowActions,
  type WorkbenchThemeEdit,
} from "./workbench-contract"
import {
  columnAt,
  editableColumnForIndex,
  gridActionFromKey,
  nextGridCoordinate,
  planFillDown,
  readCellRawText,
  type GridCoordinate,
} from "./workbench-grid-navigation"
import { WORKBENCH_ROW_HEIGHT } from "./workbench-virtual-rows"

type WorkbenchGridHandlers = {
  onSelectionChange: (rowIds: string[]) => void
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
  onRetryRowSave: (draftId: string) => void
  onRunAiRows: (rowIds: string[]) => void
  onRunRenderRows: (rowIds: string[]) => void
  onRunDeliverRows: (rowIds: string[]) => void
  onCancelRowIntent: (draftId: string) => void
  onRepairRows?: (rowIds: string[]) => void
  /** The dialogs a row or a key opens; their state lives with the dialog host. */
  openProse: (edit: WorkbenchProseEdit) => void
  openTheme: (edit: WorkbenchThemeEdit) => void
  reviewCandidates: (row: ListingRow) => void
}

type WorkbenchGridInput = WorkbenchGridHandlers & {
  rows: ListingRow[]
  productDrafts: Record<string, WorkflowDraftView>
  selectedRowIds: ReadonlySet<string>
  fields: WorkbenchColumnFields
  tableScrollRef: RefObject<HTMLDivElement | null>
}

export type WorkbenchGrid = ReturnType<typeof useWorkbenchGridKeyboard>

/**
 * Selection and keyboard state of the workbench grid: the focused cell, the
 * shift-click anchor, the fill-down ripple, and the row actions every memoized
 * row reads. Keys that land in an input, a textarea or a dialog stay theirs.
 */
export function useWorkbenchGridKeyboard(input: WorkbenchGridInput) {
  const {
    rows,
    productDrafts,
    selectedRowIds,
    fields: columnFields,
    tableScrollRef,
    onSelectionChange,
    onEditCell,
  } = input
  const shiftRef = useRef(false)
  const lastToggledIndex = useRef(-1)
  const [focusedCell, setFocusedCell] = useState<GridCoordinate | null>(null)
  const [ripplingCells, setRipplingCells] = useState<ReadonlySet<string>>(new Set())

  // Row callbacks stay identity-stable across a thousand rows: the memoized row
  // reads the current handlers through this ref instead of taking a new closure
  // on every parent render.
  const latestRef = useRef(input)
  latestRef.current = input

  const actions = useMemo<WorkbenchRowActions>(() => ({
    armShift: (shift) => {
      shiftRef.current = shift
    },
    toggle: (index, checked) => {
      const handlers = latestRef.current
      const next = new Set(handlers.selectedRowIds)
      const anchor = lastToggledIndex.current
      const span =
        shiftRef.current && anchor >= 0
          ? handlers.rows.slice(Math.min(anchor, index), Math.max(anchor, index) + 1)
          : handlers.rows.slice(index, index + 1)
      for (const row of span) {
        if (checked) next.add(row.id)
        else next.delete(row.id)
      }
      lastToggledIndex.current = index
      shiftRef.current = false
      // Report in visible row order so batch verbs run top to bottom.
      handlers.onSelectionChange(
        handlers.rows.filter((row) => next.has(row.id)).map((row) => row.id),
      )
    },
    openProse: (edit) => latestRef.current.openProse(edit),
    openTheme: (edit) => latestRef.current.openTheme(edit),
    editField: (draftId, fieldKey, value, location) => {
      latestRef.current.onEditField(draftId, fieldKey, value, location)
    },
    reviewCandidates: (row) => latestRef.current.reviewCandidates(row),
    retrySave: (draftId) => latestRef.current.onRetryRowSave(draftId),
    retryStage: (rowId, verb) => {
      const { onRunAiRows, onRunRenderRows, onRunDeliverRows } = latestRef.current
      const run = verb === "ai" ? onRunAiRows : verb === "render" ? onRunRenderRows : onRunDeliverRows
      run([rowId])
    },
    retryMedia: (rowId) => {
      const { rows, onRunAiRows, onRunRenderRows, onRunDeliverRows } = latestRef.current
      const row = rows.find((candidate) => candidate.id === rowId)
      if (!row) return
      const retry = mediaRetry(row.render, row.upload)
      const run = retry?.verb === "render"
        ? onRunRenderRows
        : retry?.verb === "deliver"
          ? onRunDeliverRows
          : row.ai === "failed"
            ? onRunAiRows
            : undefined
      run?.([rowId])
    },
    cancelIntent: (draftId) => latestRef.current.onCancelRowIntent(draftId),
    repairBrand: (rowId) => latestRef.current.onRepairRows?.([rowId]),
    focusCell: (rowIndex, colIndex) => setFocusedCell({ rowIndex, colIndex }),
  }), [])

  const fillDownPlan = focusedCell ? planFillDown({
    focusedCell, rows, productDrafts, selectedRowIds, fields: columnFields,
  }) : null
  const canFillDown = Boolean(fillDownPlan?.targetDraftIds.length)

  function runFillDown() {
    const plan = fillDownPlan
    if (!plan || plan.targetDraftIds.length === 0) return

    if (
      plan.column === "price" ||
      plan.column === "old_price" ||
      plan.column === "theme"
    ) {
      const field = plan.field
      if (!field) return
      for (const draftId of plan.targetDraftIds) {
        actions.editField(draftId, field.key, plan.draftValue, fieldLocation(field))
      }
    } else {
      for (const draftId of plan.targetDraftIds) {
        onEditCell(draftId, plan.column, plan.sourceValue)
      }
    }

    const nextRipples = new Set(plan.targetDraftIds.map((id) => `${id}:${plan.column}`))
    setRipplingCells(nextRipples)
    setTimeout(() => setRipplingCells(new Set()), 600)
    notifySuccess(`已向下填充 ${plan.targetDraftIds.length} 行「${plan.columnLabel}」`)
  }

  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
      return
    }
    // A dialog portals out of the grid in the DOM but not out of the React
    // tree, so its keys still bubble here. Whatever is on top owns them.
    if (target?.closest('[role="dialog"]')) return

    const action = gridActionFromKey({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
    })
    if (!action) return

    if (action === "escape") {
      setFocusedCell(null)
      return
    }

    if (action === "select-all") {
      event.preventDefault()
      onSelectionChange(rows.map((r) => r.id))
      return
    }

    if (action === "copy") {
      if (!focusedCell) return
      const row = rows[focusedCell.rowIndex]
      if (!row) return
      const prod = productDrafts[row.draftId]
      const text = readCellRawText(focusedCell.colIndex, row, prod, columnFields)
      if (text) {
        event.preventDefault()
        navigator.clipboard?.writeText(text).catch(() => undefined)
        const colDef = columnAt(focusedCell.colIndex)
        const rippleKey = `${row.draftId}:${colDef?.id ?? ""}`
        setRipplingCells(new Set([rippleKey]))
        setTimeout(() => setRipplingCells(new Set()), 600)
        notifySuccess(`已复制「${text.slice(0, 24)}${text.length > 24 ? "…" : ""}」`)
      }
      return
    }

    if (action === "fill-down") {
      if (!focusedCell) return
      event.preventDefault()
      runFillDown()
      return
    }

    if (action === "select-toggle") {
      if (!focusedCell) return
      event.preventDefault()
      const row = rows[focusedCell.rowIndex]
      if (!row) return
      const isSelected = selectedRowIds.has(row.id)
      actions.toggle(focusedCell.rowIndex, !isSelected)
      return
    }

    if (action === "open-edit") {
      if (!focusedCell) return
      const editCol = editableColumnForIndex(focusedCell.colIndex)
      const row = rows[focusedCell.rowIndex]
      if (editCol && row) {
        event.preventDefault()
        const prod = productDrafts[row.draftId]
        const val = proseCellText(editCol, prod, columnFields)
        actions.openProse({
          draftId: row.draftId,
          column: editCol,
          imageName: row.imageName,
          value: val,
        })
      }
      return
    }

    // Grid Navigation: up, down, left, right, home, end, pageup, pagedown
    event.preventDefault()
    const nextCoord = nextGridCoordinate(focusedCell, action, rows.length)
    if (nextCoord) {
      setFocusedCell(nextCoord)

      if (event.shiftKey && (action === "up" || action === "down" || action === "pageup" || action === "pagedown")) {
        const anchor = focusedCell ? focusedCell.rowIndex : 0
        const startIdx = Math.min(anchor, nextCoord.rowIndex)
        const endIdx = Math.max(anchor, nextCoord.rowIndex)
        const spanIds = rows.slice(startIdx, endIdx + 1).map((r) => r.id)
        onSelectionChange(spanIds)
      }

      const el = tableScrollRef.current
      if (el) {
        const targetTop = nextCoord.rowIndex * WORKBENCH_ROW_HEIGHT
        const currentTop = el.scrollTop
        const viewHeight = el.clientHeight
        if (targetTop < currentTop) {
          el.scrollTop = targetTop
        } else if (targetTop + WORKBENCH_ROW_HEIGHT > currentTop + viewHeight) {
          el.scrollTop = targetTop + WORKBENCH_ROW_HEIGHT - viewHeight
        }
      }
    }
  }

  return {
    actions,
    focusedCell,
    setFocusedCell,
    ripplingCells,
    canFillDown,
    runFillDown,
    onGridKeyDown,
  }
}

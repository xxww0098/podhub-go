import { cn } from "@/lib/utils"
import {
  WORKBENCH_COLUMNS,
  workbenchColumn,
  type WorkbenchColumn,
} from "./workbench-columns"

/** Column divider — every column but the last carries one. */
const CELL = "min-w-0 overflow-hidden border-r border-border/40 px-2 py-2 align-top"
const CELL_LAST = "min-w-0 overflow-hidden px-2 py-2 align-top"
const HEAD = "h-8 px-2 text-meta font-semibold tracking-normal normal-case text-muted-foreground"

const LAST_COLUMN_ID = WORKBENCH_COLUMNS[WORKBENCH_COLUMNS.length - 1]!.id

/**
 * Head and body cell take their geometry from the same column declaration, so a
 * width change moves both — and so the header a column shows and the field that
 * column writes can never be two different opinions.
 */
export function headClass(column: WorkbenchColumn) {
  return cn(
    HEAD,
    column.id === LAST_COLUMN_ID ? CELL_LAST : CELL,
    column.width,
    column.sticky && `sticky ${column.sticky} z-30`,
    column.edge && "border-r-border-strong",
    "border-b border-b-border-strong bg-card",
  )
}

export function cellClass(columnId: string, extra?: string, active?: boolean, rippling?: boolean) {
  const column = workbenchColumn(columnId)
  return cn(
    column.id === LAST_COLUMN_ID ? CELL_LAST : CELL,
    column.width,
    column.sticky && `sticky ${column.sticky} z-10`,
    column.edge && "border-r-border-strong",
    "border-b border-b-border transition-colors duration-150",
    // No z-index: the inset ring needs none, and z-20 here made a scrolled-under
    // focused cell paint over the frozen columns (which sit at z-10).
    active && "ring-1 ring-inset ring-brand bg-brand-soft/25",
    rippling && "ledger-cell-ripple",
    extra,
  )
}

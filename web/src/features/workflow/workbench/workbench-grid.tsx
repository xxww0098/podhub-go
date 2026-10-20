import type { RefObject, UIEvent } from "react"
import type { WorkflowDraftView } from "@/bindings/commands"
import type { SaveState } from "@/components/save-state-chip"
import { Checkbox } from "@/components/ui/checkbox"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { ListingRow } from "../model/listing-row"
import { storeToneFor } from "../store-tone"
import type { WorkbenchGrid as WorkbenchGridState } from "./use-workbench-grid-keyboard"
import type { WorkbenchRowWindow } from "./use-workbench-row-window"
import { WORKBENCH_COLUMNS } from "./workbench-columns"
import type { WorkbenchColumnFields, WorkbenchStores } from "./workbench-contract"
import { WorkbenchEmptyState } from "./workbench-empty-state"
import { WorkbenchGridHud } from "./workbench-grid-hud"
import { WorkbenchRow } from "./workbench-row"
import { headClass } from "./workbench-table-classes"

/** The four tableInput card defaults an untouched row shows as its placeholder. */
type WorkbenchCardFallbacks = {
  cardPrice: string
  cardOldPrice: string
  cardTheme: string
  cardRichContent: string
}

/**
 * The table body of the workbench: the empty drop target, or the windowed
 * rows under a sticky header with the keyboard HUD, all inside the context
 * menu that fills down.
 */
export function WorkbenchGrid({
  rows,
  productDrafts,
  rowSaveStates,
  selectedRowIds,
  pickedCount,
  fields,
  fallbacks,
  stores,
  brandRepairable,
  preparing,
  importDisabled,
  grid,
  rowWindow,
  tableScrollRef,
  onTableScroll,
  onSelectionChange,
  onImportImages,
}: {
  rows: ListingRow[]
  productDrafts: Record<string, WorkflowDraftView>
  rowSaveStates: Record<string, SaveState>
  selectedRowIds: ReadonlySet<string>
  /** Ticked rows in the current scope; the header checkbox and HUD read it. */
  pickedCount: number
  fields: WorkbenchColumnFields
  fallbacks: WorkbenchCardFallbacks
  stores: WorkbenchStores
  /** Rows the existing brand repair policy admits right now. */
  brandRepairable: ReadonlySet<string>
  preparing: boolean
  importDisabled: boolean
  grid: WorkbenchGridState
  rowWindow: WorkbenchRowWindow
  tableScrollRef: RefObject<HTMLDivElement | null>
  onTableScroll: (event: UIEvent<HTMLDivElement>) => void
  onSelectionChange: (rowIds: string[]) => void
  onImportImages: () => void
}) {
  const { boundStoreIds, storeMap, storeColorAssignments } = stores
  const { focusedCell, setFocusedCell } = grid
  const allSelected = rows.length > 0 && pickedCount === rows.length
  const someSelected = pickedCount > 0 && !allSelected
  const selectedMode = pickedCount > 0

  return (
    <ContextMenu>
      <ContextMenuTrigger
        onContextMenuCapture={(event) => {
          const cell = (event.target as Element).closest<HTMLTableCellElement>("td")
          const rowIndex = cell?.parentElement?.dataset.rowIndex
          setFocusedCell(cell && rowIndex !== undefined
            ? { rowIndex: Number(rowIndex), colIndex: cell.cellIndex }
            : null)
        }}
        render={
          <div className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col" />
        }
      >
        {rows.length === 0 ? (
          <WorkbenchEmptyState
            disabled={importDisabled}
            onImportImages={onImportImages}
          />
        ) : (
          <div
            tabIndex={0}
            onKeyDown={grid.onGridKeyDown}
            aria-label="批量上架数据表格矩阵"
            className="flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card outline-none focus-visible:ring-1 focus-visible:ring-brand/40"
          >
            {preparing ? (
              <div aria-hidden className="h-[2px] w-full shrink-0 overflow-hidden bg-primary/15">
                <div className="h-full w-full bg-primary animate-pulse" />
              </div>
            ) : null}
            <Table
              className="min-w-[1880px] table-fixed border-separate border-spacing-0"
              containerClassName="min-w-0 max-w-full flex-1 min-h-0 overflow-auto overscroll-contain [scrollbar-gutter:stable]"
              containerRef={tableScrollRef}
              onContainerScroll={onTableScroll}
            >
              <TableHeader className="sticky top-0 z-20 [&_tr]:border-0">
                <TableRow className="hover:bg-transparent">
                  {WORKBENCH_COLUMNS.map((column) => (
                    <TableHead key={column.id} className={headClass(column)}>
                      {column.id === "select" ? (
                        <Checkbox
                          aria-label="选择全部商品"
                          checked={allSelected}
                          indeterminate={someSelected}
                          disabled={!rows.length}
                          onCheckedChange={(checked) =>
                            onSelectionChange(checked === true ? rows.map((row) => row.id) : [])
                          }
                        />
                      ) : (
                        column.label
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody data-workbench-window={`${rowWindow.start}:${rowWindow.end}`}>
                {rowWindow.top > 0 ? (
                  <TableRow aria-hidden className="pointer-events-none hover:bg-transparent">
                    <TableCell
                      colSpan={WORKBENCH_COLUMNS.length}
                      data-testid="workbench-virtual-top"
                      className="border-0 p-0"
                      style={{ height: rowWindow.top }}
                    />
                  </TableRow>
                ) : null}
                {rows.slice(rowWindow.start, rowWindow.end).map((row, offset) => {
                  const index = rowWindow.start + offset
                  const product = productDrafts[row.draftId]
                  const rowStoreId = product?.target_store_id?.trim() || ""
                  const rowStoreLabel = boundStoreIds.length > 1 && rowStoreId
                    ? storeMap[rowStoreId]?.label || rowStoreId
                    : undefined
                  const rowStoreTone = rowStoreLabel
                    ? storeToneFor(rowStoreId, storeColorAssignments)
                    : undefined
                  return (
                    <WorkbenchRow
                      key={row.id}
                      row={row}
                      index={index}
                      selected={selectedRowIds.has(row.id)}
                      product={product}
                      saveState={rowSaveStates[row.draftId] ?? "idle"}
                      fields={fields}
                      actions={grid.actions}
                      brandRepairable={brandRepairable.has(row.id)}
                      rowStoreLabel={rowStoreLabel}
                      storeTone={rowStoreTone}
                      cardPrice={fallbacks.cardPrice}
                      cardOldPrice={fallbacks.cardOldPrice}
                      cardTheme={fallbacks.cardTheme}
                      cardRichContent={fallbacks.cardRichContent}
                      activeColIndex={focusedCell?.rowIndex === index ? focusedCell.colIndex : null}
                      ripplingCells={grid.ripplingCells}
                    />
                  )
                })}
                {rowWindow.bottom > 0 ? (
                  <TableRow aria-hidden className="pointer-events-none hover:bg-transparent">
                    <TableCell
                      colSpan={WORKBENCH_COLUMNS.length}
                      data-testid="workbench-virtual-bottom"
                      className="border-0 p-0"
                      style={{ height: rowWindow.bottom }}
                    />
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>

            <WorkbenchGridHud
              focusedCell={focusedCell}
              selectedMode={selectedMode}
              pickedCount={pickedCount}
              canFillDown={grid.canFillDown}
              onFillDown={grid.runFillDown}
            />
          </div>
        )}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem disabled={!grid.canFillDown} onClick={grid.runFillDown}>
          向下填充
          <span className="ml-auto text-meta text-muted-foreground">⌘D / Ctrl+D</span>
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

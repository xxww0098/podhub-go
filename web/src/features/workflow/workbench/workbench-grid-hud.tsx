import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { columnAt, type GridCoordinate } from "./workbench-grid-navigation"

/**
 * The keyboard-matrix status bar under the table: where focus sits, the keys
 * the grid answers, and fill-down as a real button next to its shortcut.
 */
export function WorkbenchGridHud({
  focusedCell,
  selectedMode,
  pickedCount,
  canFillDown,
  onFillDown,
}: {
  focusedCell: GridCoordinate | null
  selectedMode: boolean
  pickedCount: number
  canFillDown: boolean
  onFillDown: () => void
}) {
  return (
    <footer
      role="status"
      aria-label="工作台键盘矩阵导航状态"
      className="flex h-8 w-full shrink-0 items-center justify-between border-t border-border bg-muted/40 px-3 text-meta text-muted-foreground"
    >
      <div className="flex items-center gap-2 font-mono tabular-nums">
        <span className="flex items-center gap-1.5 font-medium text-foreground">
          <span
            aria-hidden
            className={cn(
              "size-1.5 rounded-full transition-colors",
              focusedCell ? "bg-brand" : "bg-muted-foreground/40",
            )}
          />
          {focusedCell ? (
            <>
              <span>R{focusedCell.rowIndex + 1}:C{focusedCell.colIndex + 1}</span>
              <span className="font-sans text-muted-foreground">
                · {columnAt(focusedCell.colIndex)?.label || "单元格"}
              </span>
            </>
          ) : (
            <span className="font-sans text-muted-foreground">Pro Ledger 矩阵导航已就绪</span>
          )}
        </span>
        {focusedCell && selectedMode ? (
          <span className="text-muted-foreground">（已选 {pickedCount} 行）</span>
        ) : null}
      </div>
      <div className="flex items-center gap-3 text-meta">
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-meta text-foreground">↑↓←→</kbd>
          <span>导航</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-meta text-foreground">Enter</kbd>
          <span>编辑</span>
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!canFillDown}
          onClick={onFillDown}
          onKeyDown={(event) => event.stopPropagation()}
          title="将当前单元格填充到选中行或下方可编辑行（⌘D / Ctrl+D）"
        >
          向下填充
          <kbd>⌘D / Ctrl+D</kbd>
        </Button>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-meta text-foreground">Space</kbd>
          <span>勾选</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <kbd className="rounded border border-border bg-card px-1 py-0.5 font-mono text-meta text-foreground">⌘C</kbd>
          <span>复制</span>
        </span>
      </div>
    </footer>
  )
}

/** Matches `WorkbenchRow` `h-20`. Variable content clips; height stays stable. */
export const WORKBENCH_ROW_HEIGHT = 80
const OVERSCAN_ROWS = 12
/** Static markup and first layout have no measured scrollport. */
const UNMEASURED_MOUNT = 48

export type WorkbenchRowWindow = {
  start: number
  end: number
  top: number
  bottom: number
}

/**
 * Which Product Instance rows the workbench may mount.
 *
 * A 1000-row table cannot keep 1000 `WorkbenchRow` trees (inputs, observers,
 * slice subscriptions) alive. The scrollport plus overscan is the working set;
 * spacers preserve the scrollbar for the rest.
 */
export function workbenchVisibleRange(
  rowCount: number,
  scrollTop: number,
  viewportHeight: number,
): WorkbenchRowWindow {
  if (rowCount <= 0) return { start: 0, end: 0, top: 0, bottom: 0 }
  if (viewportHeight <= 0) {
    const end = Math.min(rowCount, UNMEASURED_MOUNT)
    return { start: 0, end, top: 0, bottom: (rowCount - end) * WORKBENCH_ROW_HEIGHT }
  }
  const start = Math.max(0, Math.floor(Math.max(0, scrollTop) / WORKBENCH_ROW_HEIGHT) - OVERSCAN_ROWS)
  const visible = Math.ceil(viewportHeight / WORKBENCH_ROW_HEIGHT)
  const end = Math.min(rowCount, start + visible + OVERSCAN_ROWS)
  return {
    start,
    end,
    top: start * WORKBENCH_ROW_HEIGHT,
    bottom: (rowCount - end) * WORKBENCH_ROW_HEIGHT,
  }
}

/**
 * 当前队列的计数。看板列头用份数，不加第二套图。
 */
import { isUrgent, type DeadlineRow } from "./supplier-urgency"

type FactRow = DeadlineRow & { payoutCents?: number | null }

export type QueueFacts = {
  pending: number
  producing: number
  shipped: number
  urgent: number
  /** 待接单 + 生产中的成本，分。已发货不重复计入。 */
  openCents: number
}

/** 排单和打开的钱包共用。隐藏标签页不打点，回到前台再补拉。 */
export const SUPPLIER_PORTAL_POLL_MS = 15_000

export function queueFacts(
  queue: { pending: FactRow[]; producing: FactRow[]; shipped: FactRow[] },
  now: number,
): QueueFacts {
  const open = [...queue.pending, ...queue.producing]
  return {
    pending: queue.pending.length,
    producing: queue.producing.length,
    shipped: queue.shipped.length,
    urgent: open.filter((row) => isUrgent(row, now)).length,
    openCents: open.reduce((sum, row) => sum + (row.payoutCents ?? 0), 0),
  }
}

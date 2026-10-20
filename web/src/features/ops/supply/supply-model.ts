import type {
  SupplyListView,
  SupplyOrderView,
  SupplyStatusCountView,
  SupplyWarehouseStockView,
} from "@/bindings/commands"
import { errorMessage } from "@/lib/error-message"

export const ALL_STATE = ""

export const DEFAULT_STATE = "READY_TO_SUPPLY"

export const QUEUE_STATES = [
  { value: DEFAULT_STATE, label: "待供货" },
  { value: "IN_TRANSIT", label: "运输中" },
  { value: "OVERDUE", label: "已过期" },
  { value: ALL_STATE, label: "全部" },
] as const

const STATE_LABEL: Record<string, string> = {
  DATA_FILLING: "填写资料",
  READY_TO_SUPPLY: "待供货",
  ACCEPTED_AT_SUPPLY_WAREHOUSE: "已到达发货仓",
  IN_TRANSIT: "运输中",
  ACCEPTANCE_AT_STORAGE_WAREHOUSE: "入库验收",
  REPORTS_CONFIRMATION_AWAITING: "待确认交接",
  REPORT_REJECTED: "交接被拒",
  COMPLETED: "已完成",
  REJECTED_AT_SUPPLY_WAREHOUSE: "发货仓拒收",
  CANCELLED: "已取消",
  OVERDUE: "已过期",
  UNSPECIFIED: "未指定",
}

export type SupplyReadState<T> = {
  view: T
  loading: boolean
  error: string
  reason?: unknown
}

export async function runSupplyRead<T>(options: {
  request: () => Promise<T>
  isCurrent: () => boolean
  setState: (update: (previous: SupplyReadState<T>) => SupplyReadState<T>) => void
  fallback: string
  onError?: (reason: unknown) => void
  accept?: (next: T) => boolean
  reject?: (previous: T, next: T) => T
}): Promise<boolean> {
  options.setState((previous) => ({ ...previous, loading: true, error: "", reason: undefined }))
  try {
    const next = await options.request()
    if (!options.isCurrent()) return false
    const accepted = options.accept?.(next) ?? true
    options.setState((previous) => ({
      view: accepted ? next : (options.reject?.(previous.view, next) ?? previous.view),
      loading: false,
      error: "",
    }))
    return accepted
  } catch (reason) {
    if (!options.isCurrent()) return false
    options.setState((previous) => ({
      ...previous,
      loading: false,
      error: errorMessage(reason, options.fallback),
      reason,
    }))
    options.onError?.(reason)
    return false
  }
}

export const EMPTY_SUPPLY_LIST: SupplyListView = {
  orders: [],
  last_id: "",
  has_more: false,
  status_counts: [],
}

/** Chinese gloss for an Ozon inbound state. Unknown values stay as the wire token. */
export function supplyStateLabel(state: string): string {
  const key = state.trim()
  if (!key) return "全部"
  return STATE_LABEL[key] ?? key
}

export function statusTotal(counts: SupplyStatusCountView[]): number {
  return counts.reduce((sum, item) => sum + item.count, 0)
}

export function formatCount(value: number): string {
  return value.toLocaleString("zh-CN")
}

/**
 * Timeslot window. Empty bounds stay "—"; a one-sided window prints the side
 * that exists. Timezone is shown only when Ozon sent one.
 */
export function formatTimeslot(order: Pick<
  SupplyOrderView,
  "timeslot_from" | "timeslot_to" | "timeslot_timezone"
>): string {
  const zone = order.timeslot_timezone.trim()
  const from = formatInstant(order.timeslot_from, zone)
  const to = formatInstant(order.timeslot_to, zone)
  if (!from && !to) return "—"
  const window = from && to ? `${from} – ${to}` : from || to
  return zone ? `${window} (${zone})` : window
}

// ponytail: unbounded per-zone cache; zones come from order data, count stays tiny
const INSTANT_FORMATS = new Map<string, Intl.DateTimeFormat>()

function instantFormat(timeZone?: string): Intl.DateTimeFormat {
  const key = timeZone ?? ""
  let format = INSTANT_FORMATS.get(key)
  if (!format) {
    format = new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone,
    })
    INSTANT_FORMATS.set(key, format)
  }
  return format
}

export function formatInstant(raw: string, zone = ""): string {
  const value = raw.trim()
  if (!value) return ""
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed)) return value
  let instant = parsed
  let timeZone: string | undefined
  const offset = zone.match(/^([+-])(\d{2}):(\d{2})$/)
  if (offset) {
    const hours = Number(offset[2])
    const minutes = Number(offset[3])
    if (hours > 23 || minutes > 59) return value
    instant += (offset[1] === "+" ? 1 : -1) * (hours * 60 + minutes) * 60_000
    timeZone = "UTC"
  } else if (zone) {
    timeZone = zone
  }
  try {
    return instantFormat(timeZone).format(instant)
  } catch {
    return value
  }
}

export function warehouseDisplayName(warehouse: SupplyWarehouseStockView): string {
  return warehouse.name.trim() || `warehouse_id ${warehouse.warehouse_id}`
}

export function orderIdentity(order: SupplyOrderView): string {
  return order.order_number.trim() || order.order_id
}

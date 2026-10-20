import type {
  OzonStoreView,
  ShippingListView,
  ShippingPostingView,
} from "@/bindings/commands"
import { isCredentialExpiredAt } from "@/lib/credential-expiry"
import { isOpsAuthRefusal } from "@/lib/error-message"

export { preferredStoreUid } from "../ops-store-roster"

/** `OpsErrorCode::OzonShippingFailed`, as `@/api/client` delivers it. */
const SHIPPING_FAILED_CODE = "cloud_ozon_shipping_failed"

export const DEFAULT_WINDOW_DAYS = 7
export const PAGE_SIZE = 50
export const SHIPPING_POLL_INTERVAL_MS = 60_000

export const ALL_STATUS = "all"

/** Operator queue tabs. Wire status/window stay what Seller already accepts. */
export type ShippingQueue = "awaiting_label" | "awaiting_ship" | "due_today" | "all"

export const QUEUE_FILTERS: { value: ShippingQueue; label: string }[] = [
  { value: "awaiting_label", label: "待打单" },
  { value: "awaiting_ship", label: "待发货" },
  { value: "due_today", label: "今日截止" },
  { value: "all", label: "全部" },
]

export const DEFAULT_QUEUE: ShippingQueue = "awaiting_label"

export function queueRequest(queue: ShippingQueue): {
  status: string
  windowDays: number
} {
  switch (queue) {
    case "awaiting_label":
      return { status: "awaiting_packaging", windowDays: DEFAULT_WINDOW_DAYS }
    case "awaiting_ship":
      return { status: "awaiting_deliver", windowDays: DEFAULT_WINDOW_DAYS }
    case "due_today":
      return { status: "", windowDays: 1 }
    case "all":
      return { status: "", windowDays: DEFAULT_WINDOW_DAYS }
  }
}

export type ShippingAction = "label" | "ship"

export function shippingActions(
  posting: ShippingPostingView,
): { id: ShippingAction; label: string }[] {
  const actions: { id: ShippingAction; label: string }[] = []
  if (posting.label_state === "label_ready") {
    actions.push({ id: "label", label: "打单" })
  }
  if (posting.packing_state === "packed") {
    actions.push({ id: "ship", label: "发货" })
  }
  if (actions.length === 0) {
    actions.push({ id: "label", label: "打单" })
  }
  return actions
}

/// Ozon posting statuses in operator Chinese.
///
/// The wire value stays the wire value — it is what the filter sends and what
/// `toneFor` keys on. Only the printed text is translated, and an unmapped
/// status still prints itself rather than hiding behind a guess.
const STATUS_LABELS: Record<string, string> = {
  awaiting_registration: "待登记",
  acceptance_in_progress: "验收中",
  awaiting_approve: "待确认",
  awaiting_packaging: "待组包",
  awaiting_deliver: "待发货",
  arbitration: "仲裁中",
  client_arbitration: "买家仲裁",
  delivering: "运输中",
  driver_pickup: "司机揽收",
  delivered: "已送达",
  sent_by_seller: "卖家已发出",
  not_accepted: "未验收",
  cancelled: "已取消",
}

export function shippingStatusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status
}

export function requestStatus(filter: string): string {
  return filter === ALL_STATUS ? "" : filter
}

export type ShippingLoadState = "idle" | "loading" | "ready" | "empty" | "error"

export type CommandFailure = {
  code: string
  message: string
  remediation?: string
}

/** No Store can serve 发货: disabled, over quota, or holding a lapsed key. */
export function hasUnavailableShippingStores(stores: OzonStoreView[]): boolean {
  return stores.some(
    (store) =>
      store.configured &&
      Boolean(store.cloud_store_uuid?.trim()) &&
      (store.cloud_status === "manual_disabled" ||
        store.cloud_status === "quota_suspended" ||
        isCredentialExpiredAt(store.key_expires_at_ms)),
  )
}

export function deadlineLabel(state: string): string {
  switch (state) {
    case "deadline_overdue":
      return "逾期"
    case "deadline_approaching":
      return "临期"
    case "deadline_ok":
      return "未到"
    default:
      return "—"
  }
}

export function packingLabel(state: string): string {
  switch (state) {
    case "unpacked":
      return "未组包"
    case "packed":
      return "已组包"
    case "failed":
      return "组包失败"
    case "result_unknown":
      return "Result Unknown"
    default:
      return "—"
  }
}

export function labelPrintLabel(state: string): string {
  switch (state) {
    case "label_not_ready":
      return "未到打单"
    case "label_ready":
      return "可打单"
    case "skipped":
      return "不打单"
    case "label_unknown":
      return "Result Unknown"
    default:
      return "—"
  }
}

/** The row's identity tile follows the deadline when it is the claim. */
export function rowToneStatus(posting: ShippingPostingView): string {
  if (
    posting.deadline_state === "deadline_overdue" ||
    posting.deadline_state === "deadline_approaching"
  ) {
    return posting.deadline_state
  }
  return posting.status || "unknown"
}

const INSTANT_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
})

export function formatInstant(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "—"
  const parsed = Date.parse(trimmed)
  if (Number.isNaN(parsed)) return trimmed
  return INSTANT_FORMAT.format(parsed)
}

export function emptyView(storeId: string): ShippingListView {
  return { store_id: storeId, postings: [], has_next: false, cursor: "" }
}

export function isEmptyShippingAdvance(
  advancing: boolean,
  next: ShippingListView,
): boolean {
  return advancing && next.postings.length === 0
}

export function shouldStartShippingRead(
  quiet: boolean,
  inFlight: boolean,
): boolean {
  return !quiet || !inFlight
}

export function describeFailure(failure: CommandFailure): string {
  return failure.remediation
    ? `${failure.message} ${failure.remediation}`
    : failure.message
}

export function commandFailure(reason: unknown, fallback: string): CommandFailure {
  if (typeof reason === "object" && reason !== null) {
    const code =
      "code" in reason && typeof reason.code === "string" && reason.code.trim()
        ? reason.code
        : SHIPPING_FAILED_CODE
    const message =
      "message" in reason && typeof reason.message === "string" && reason.message.trim()
        ? reason.message
        : fallback
    const remediation =
      "remediation" in reason &&
      typeof reason.remediation === "string" &&
      reason.remediation.trim()
        ? reason.remediation
        : undefined
    return { code, message, remediation }
  }
  if (typeof reason === "string" && reason.trim()) {
    return { code: SHIPPING_FAILED_CODE, message: reason }
  }
  return { code: SHIPPING_FAILED_CODE, message: fallback }
}

export function isAuthFailure(failure: CommandFailure): boolean {
  return isOpsAuthRefusal(failure.code)
}

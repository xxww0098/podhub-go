import type {
  OpsCancellationRowView,
  OpsCancellationsListView,
  OpsReturnRowView,
  OpsReturnsListView,
} from "@/bindings/commands"
import { isOpsAuthRefusal } from "@/lib/error-message"

export const EMPTY_RETURNS: OpsReturnsListView = {
  items: [],
  has_next: false,
  last_id: "",
}

export const EMPTY_CANCELLATIONS: OpsCancellationsListView = {
  items: [],
  last_id: "",
  counter: 0,
  has_next: false,
}

export type OpsListError = {
  code: string
  message: string
  remediation?: string
  reason?: unknown
  retry?: "replace" | "append"
}

export type OpsListState<T> = {
  loading: boolean
  loadingMore: boolean
  error: OpsListError | null
  view: T
}

export function asOpsListError(reason: unknown, fallback: string): OpsListError {
  if (typeof reason === "object" && reason !== null) {
    const code = "code" in reason && typeof reason.code === "string" ? reason.code : ""
    const message =
      "message" in reason && typeof reason.message === "string" && reason.message.trim()
        ? reason.message.trim()
        : fallback
    const remediation =
      "remediation" in reason &&
      typeof reason.remediation === "string" &&
      reason.remediation.trim()
        ? reason.remediation.trim()
        : undefined
    return { code, message, remediation }
  }
  if (typeof reason === "string" && reason.trim()) {
    return { code: "", message: reason.trim() }
  }
  return { code: "", message: fallback }
}

export function isAuthError(error: OpsListError | null): boolean {
  return isOpsAuthRefusal(error?.code)
}

export async function loadOpsListPage<Item, View extends { items: Item[] }>(options: {
  append: boolean
  request: () => Promise<View>
  isCurrent: () => boolean
  setState: (
    update: (previous: OpsListState<View>) => OpsListState<View>,
  ) => void
  fallback: string
}): Promise<void> {
  options.setState((previous) => ({
    ...previous,
    loading: !options.append,
    loadingMore: options.append,
    error: null,
  }))
  try {
    const next = await options.request()
    if (!options.isCurrent()) return
    options.setState((previous) => ({
      loading: false,
      loadingMore: false,
      error: null,
      view: options.append
        ? { ...next, items: [...previous.view.items, ...next.items] }
        : next,
    }))
  } catch (reason) {
    if (!options.isCurrent()) return
    options.setState((previous) => ({
      ...previous,
      loading: false,
      loadingMore: false,
      error: {
        ...asOpsListError(reason, options.fallback),
        reason,
        retry: options.append ? "append" : "replace",
      },
    }))
  }
}

// toLocaleString("zh-CN") 的显式等价形式，提升为模块级单例避免每行重建。
const OCCURRED_AT_FORMAT = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
})

export function formatOccurredAt(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "—"
  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return trimmed
  return OCCURRED_AT_FORMAT.format(ms)
}

export function displayReason(reason: string): string {
  return reason.trim() || "—"
}

export function statusLabel(row: Pick<OpsReturnRowView, "status" | "status_label">): string {
  return row.status_label.trim() || row.status.trim() || "—"
}

export function cancellationStatusLabel(
  row: Pick<OpsCancellationRowView, "status" | "status_label">,
): string {
  return row.status_label.trim() || cancellationFilterLabel(row.status.trim()) || "—"
}

const CANCELLATION_FILTER_LABELS: Record<string, string> = {
  ON_APPROVAL: "待审批",
  APPROVED: "已批准",
  REJECTED: "已拒绝",
}

const INITIATOR_LABELS: Record<string, string> = {
  OZON: "Ozon",
  SELLER: "卖家",
  CLIENT: "买家",
  SYSTEM: "系统",
  DELIVERY: "配送",
}

export function cancellationFilterLabel(value: string): string {
  return CANCELLATION_FILTER_LABELS[value] ?? value
}

export function initiatorLabel(value: string): string {
  return INITIATOR_LABELS[value] ?? value
}

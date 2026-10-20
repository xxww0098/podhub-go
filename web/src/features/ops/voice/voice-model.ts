import type {
  OpsVoiceChatItem,
  OpsVoiceChatsView,
  OpsVoiceQuestionsView,
  OpsVoiceReviewsView,
  VoiceSourceKind,
} from "@/bindings/commands"
import { errorMessage } from "@/lib/error-message"

export const PREMIUM_PLUS_COPY = "当前店铺未订阅 Premium Plus，Ozon 不提供该数据"

export type VoiceLoadMode = "replace" | "append"

export type VoiceReadState<T> = {
  view: T
  loading: VoiceLoadMode | null
  hasSnapshot: boolean
  error: string
  errorMode: VoiceLoadMode | null
}

export function voiceReadState<T>(view: T): VoiceReadState<T> {
  return {
    view,
    loading: null,
    hasSnapshot: false,
    error: "",
    errorMode: null,
  }
}

export async function runVoiceRead<T>(options: {
  mode: VoiceLoadMode
  request: () => Promise<T>
  isCurrent: () => boolean
  setState: (update: (previous: VoiceReadState<T>) => VoiceReadState<T>) => void
  fallback: string
  merge?: (previous: T, next: T) => T
}): Promise<boolean> {
  options.setState((previous) => ({
    ...previous,
    loading: options.mode,
    error: "",
    errorMode: null,
  }))
  try {
    const next = await options.request()
    if (!options.isCurrent()) return false
    options.setState((previous) => ({
      view: options.merge?.(previous.view, next) ?? next,
      loading: null,
      hasSnapshot: true,
      error: "",
      errorMode: null,
    }))
    return true
  } catch (reason) {
    if (!options.isCurrent()) return false
    options.setState((previous) => ({
      ...previous,
      loading: null,
      error: errorMessage(reason, options.fallback),
      errorMode: options.mode,
    }))
    throw reason
  }
}

const LOCAL_DATE_TIME = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZoneName: "short",
})

export function formatPublishedAt(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "—"
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return trimmed
  return LOCAL_DATE_TIME.format(parsed)
}

export function reviewStatusLabel(status: string): string {
  switch (status) {
    case "UNPROCESSED":
      return "未回复"
    case "PROCESSED":
      return "已回复"
    default:
      return status || "—"
  }
}

export function questionStatusLabel(status: string): string {
  switch (status) {
    case "UNPROCESSED":
      return "未回复"
    case "PROCESSED":
      return "已回复"
    case "NEW":
      return "新"
    case "VIEWED":
      return "已读"
    default:
      return status || "—"
  }
}

export function chatStatusLabel(status: string): string {
  switch (canonicalChatStatus(status)) {
    case "Opened":
      return "进行中"
    case "Closed":
      return "已关闭"
    case "All":
      return "全部"
    default:
      return canonicalChatStatus(status) || "—"
  }
}

export function canonicalChatStatus(status: string): string {
  switch (status.trim().toUpperCase()) {
    case "OPENED":
      return "Opened"
    case "CLOSED":
      return "Closed"
    case "ALL":
      return "All"
    default:
      return status.trim()
  }
}

export function chatTypeLabel(type: string): string {
  switch (type.trim().toUpperCase()) {
    case "BUYER_SELLER":
      return "买家与卖家"
    case "SELLER_SUPPORT":
      return "卖家与客服"
    case "UNSPECIFIED":
      return "未指定"
    default:
      return type.trim() || "—"
  }
}

/** Ozon's count endpoint may have failed while the list succeeded. */
export function formatQueueCount(value: number | null | undefined): string {
  return value == null ? "—" : value.toLocaleString("zh-CN")
}

export function isAvailable(kind: VoiceSourceKind): boolean {
  return kind === "available"
}

export function isPremiumPlus(kind: VoiceSourceKind): boolean {
  return kind === "premium_plus_required"
}

export function emptyReviews(): OpsVoiceReviewsView {
  return {
    kind: "available",
    reason: "",
    items: [],
    has_next: false,
    last_id: "",
    unprocessed: null,
  }
}

export function emptyQuestions(): OpsVoiceQuestionsView {
  return {
    kind: "available",
    reason: "",
    items: [],
    has_next: false,
    last_id: "",
    unprocessed: null,
  }
}

export function emptyChats(): OpsVoiceChatsView {
  return {
    kind: "available",
    reason: "",
    items: [],
    has_next: false,
    cursor: "",
    total_unread_count: 0,
  }
}

export function appendReviews(
  previous: OpsVoiceReviewsView,
  next: OpsVoiceReviewsView,
): OpsVoiceReviewsView {
  if (!isAvailable(next.kind)) return next
  const seen = new Set(previous.items.map((item) => item.review_id))
  return {
    ...next,
    items: [
      ...previous.items,
      ...next.items.filter((item) => !seen.has(item.review_id)),
    ],
    unprocessed: previous.unprocessed,
  }
}

export function appendQuestions(
  previous: OpsVoiceQuestionsView,
  next: OpsVoiceQuestionsView,
): OpsVoiceQuestionsView {
  if (!isAvailable(next.kind)) return next
  const seen = new Set(previous.items.map((item) => item.question_id))
  return {
    ...next,
    items: [
      ...previous.items,
      ...next.items.filter((item) => !seen.has(item.question_id)),
    ],
    unprocessed: previous.unprocessed,
  }
}

export function appendChats(
  previous: OpsVoiceChatsView,
  next: OpsVoiceChatsView,
): OpsVoiceChatsView {
  if (!isAvailable(next.kind)) return next
  const seen = new Set(previous.items.map(chatIdentity))
  const items = [
    ...previous.items,
    ...next.items.filter((item) => !seen.has(chatIdentity(item))),
  ]
  items.sort((left, right) =>
    right.unread_count - left.unread_count ||
    right.created_at.localeCompare(left.created_at),
  )
  return {
    ...next,
    items,
    total_unread_count: previous.total_unread_count,
  }
}

function chatIdentity(item: OpsVoiceChatItem): string {
  return item.chat_id.trim() || item.last_message_id.trim()
}

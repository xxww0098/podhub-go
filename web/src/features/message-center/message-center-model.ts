import type {
  MessageCenterChatItem,
  MessageCenterFailedStore,
  MessageCenterInboxRequest,
  MessageCenterInboxView,
  MessageCenterMessageView,
  MessageCenterSendRequest,
  MessageCenterStoreView,
  OzonStoreView,
} from "@/bindings/commands"
import { isCredentialExpiredAt } from "@/lib/credential-expiry"
import { errorMessage } from "@/lib/error-message"

export const MESSAGE_CENTER_POLL_MS = 60_000

export const TRANSLATION_HELP =
  "本页未接入翻译：中文草稿仅自己可见，实际发送以俄文为准。"

export const COMMON_REPLIES_KEY = "podhub.message-center.replies"

export type SessionKind = "buyer" | "ticket" | "platform"
export type StoreFilter = "all" | "waiting"

export type InboxStoreInput = {
  storeId: string
  name: string
  storeNumber: string
}

export function sessionKindOf(chat: Pick<MessageCenterChatItem, "session_kind">): SessionKind {
  switch (chat.session_kind) {
    case "buyer":
    case "ticket":
    case "platform":
      return chat.session_kind
    default:
      return "platform"
  }
}

export function chatStatusLabel(status: string): string {
  switch (status.trim().toUpperCase()) {
    case "OPENED":
      return "进行中"
    case "CLOSED":
      return "已关闭"
    default:
      return status.trim() || "—"
  }
}

export function sessionKindLabel(kind: SessionKind): string {
  switch (kind) {
    case "buyer":
      return "买家消息"
    case "ticket":
      return "客服工单"
    case "platform":
      return "平台通知"
  }
}

const RELATIVE = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
})

export function formatSessionTime(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return "—"
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return trimmed
  return `${RELATIVE.format(parsed)} 起`
}

/** Bubble body: item parts are paragraphs, not tokens — keep the line breaks. */
export function messageBody(message: Pick<MessageCenterMessageView, "items">): string {
  return message.items.map((part) => part.trim()).filter(Boolean).join("\n")
}

export function storeNumberOf(store: OzonStoreView): string {
  if (store.create_order != null) return String(store.create_order)
  return store.client_id.trim()
}

/**
 * Every roster store — including those without a Cloud session — except a
 * Store whose Seller key lapsed: Cloud refuses its chat exits, so naming it in
 * the request would only spend a round trip on a guaranteed failure.
 */
export function inboxStoresFromRoster(stores: OzonStoreView[]): InboxStoreInput[] {
  return stores
    .filter((store) => !isCredentialExpiredAt(store.key_expires_at_ms))
    .map((store) => ({
      storeId: store.cloud_store_uuid?.trim() ?? "",
      name: store.label.trim() || store.client_id.trim() || store.id,
      storeNumber: storeNumberOf(store),
    }))
}

export function inboxRequestOf(stores: InboxStoreInput[]): MessageCenterInboxRequest {
  return {
    stores: stores.map((store) => ({
      store_id: store.storeId,
      name: store.name,
      store_number: store.storeNumber,
    })),
  }
}

export function filterStores(
  stores: MessageCenterStoreView[],
  query: string,
  filter: StoreFilter,
): MessageCenterStoreView[] {
  const needle = query.trim().toLowerCase()
  return stores.filter((store) => {
    if (filter === "waiting" && !store.waiting_reply) return false
    if (!needle) return true
    return (
      store.name.toLowerCase().includes(needle) ||
      store.store_number.toLowerCase().includes(needle) ||
      store.store_id.toLowerCase().includes(needle)
    )
  })
}

export function filterSessions(
  chats: MessageCenterChatItem[],
  kind: SessionKind,
): MessageCenterChatItem[] {
  return chats.filter((chat) => sessionKindOf(chat) === kind)
}

export function sessionCounts(chats: MessageCenterChatItem[]): Record<SessionKind, number> {
  return {
    buyer: chats.filter((chat) => sessionKindOf(chat) === "buyer").length,
    ticket: chats.filter((chat) => sessionKindOf(chat) === "ticket").length,
    platform: chats.filter((chat) => sessionKindOf(chat) === "platform").length,
  }
}

export function failedStoreCount(view: Pick<MessageCenterInboxView, "failed_stores" | "failed_store_count">): number {
  return Math.max(view.failed_store_count, view.failed_stores.length)
}

export function failedStoresNotice(failed: MessageCenterFailedStore[]): string {
  if (failed.length === 0) return ""
  if (failed.length === 1) return "一家店拉不到消息"
  return `${failed.length} 家店拉不到消息`
}

export function discloseUnread(count: number): string {
  return count.toLocaleString("zh-CN")
}

export function unreadLiveStatus(count: number): string {
  return `${discloseUnread(count)} 条未读`
}

/**
 * Thread-empty-but-unread note. Ozon 的会话列表未读与历史可见消息是两套
 * 口径：history 只回「可见」消息（已归档或过期的被轮换掉），列表元数据
 * 仍带着未读计数。此时线程必须说明差异，而不是谎报「暂无消息」。
 */
export function invisibleUnreadNote(count: number): string {
  return `${discloseUnread(count)} 条消息暂不可见（已归档或过期）`
}

export function sendRequestOf(
  storeId: string,
  chatId: string,
  russianText: string,
): MessageCenterSendRequest {
  return {
    store_id: storeId,
    chat_id: chatId,
    text: russianText.trim(),
  }
}

export function readCommonReplies(): string[] {
  if (typeof localStorage === "undefined") return []
  try {
    const raw = localStorage.getItem(COMMON_REPLIES_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
  } catch {
    return []
  }
}

export function writeCommonReplies(replies: string[]): void {
  if (typeof localStorage === "undefined") return
  try {
    localStorage.setItem(
      COMMON_REPLIES_KEY,
      JSON.stringify(replies.map((item) => item.trim()).filter(Boolean)),
    )
  } catch {
    // The other five writers on this origin already swallow a full or refusing
    // quota. This one threw into the 客服 workbench instead, which turned a
    // snippet nobody could save into a broken screen.
  }
}

export function inboxError(reason: unknown): string {
  return errorMessage(reason, "读取客服消息失败")
}

export function sendError(reason: unknown): string {
  return errorMessage(reason, "发送俄文失败")
}

export function sessionIdentity(chat: MessageCenterChatItem): string {
  return `${chat.store_id}:${chat.chat_id}`
}

export function relativeUpdated(at: number | null, now = Date.now()): string {
  if (at == null) return "尚未更新"
  const delta = Math.max(0, now - at)
  if (delta < 15_000) return "更新于刚刚"
  if (delta < 60_000) return `更新于 ${Math.floor(delta / 1000)} 秒前`
  if (delta < 3_600_000) return `更新于 ${Math.floor(delta / 60_000)} 分钟前`
  return `更新于 ${RELATIVE.format(at)}`
}

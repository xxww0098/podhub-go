import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  Copy,
  MessagesSquare,
  RefreshCw,
  Search,
  Send,
  Settings,
} from "lucide-react"

import type { MessageCenterChatItem, MessageCenterHistoryView, MessageCenterInboxView, MessageCenterMessageView, MessageCenterStoreView } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { IdCode } from "@/components/id-code"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import {
  Tabs,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { useScreenActive } from "@/components/screen-pane"
import {
  loadStoreRoster,
  peekStoreRoster,
  useStoreRoster,
} from "@/features/stores/store-roster-cache"
import {
  commandErrorCode,
  errorMessage,
  SELLER_RESULT_UNKNOWN_CODE,
  WRITES_DISABLED_CODE,
} from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyError, notifyLive, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { cn } from "@/lib/utils"

import { ChatMarkdown } from "./chat-markdown"
import {
  MESSAGE_CENTER_POLL_MS,
  TRANSLATION_HELP,
  chatStatusLabel,
  discloseUnread,
  failedStoreCount,
  failedStoresNotice,
  unreadLiveStatus,
  filterSessions,
  filterStores,
  formatSessionTime,
  inboxError,
  inboxRequestOf,
  inboxStoresFromRoster,
  invisibleUnreadNote,
  messageBody,
  readCommonReplies,
  relativeUpdated,
  sendError,
  sendRequestOf,
  sessionCounts,
  sessionIdentity,
  sessionKindLabel,
  writeCommonReplies,
  type SessionKind,
  type StoreFilter,
} from "./message-center-model"

type MessageCenterScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const MESSAGE_CENTER_READ_LIVE = "message-center-read"

export function MessageCenterScreen({ workspaceId, onOpenStores }: MessageCenterScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [inbox, setInbox] = useState<MessageCenterInboxView>(() => ({
    stores: [],
    failed_stores: [],
    waiting_reply_count: 0,
    platform_notification_count: 0,
    store_count: 0,
    waiting_reply_store_count: 0,
    session_count: 0,
    failed_store_count: 0,
  }))
  const [load, setLoad] = useState<"idle" | "loading">("idle")
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [storeFilter, setStoreFilter] = useState<StoreFilter>("all")
  const [storeId, setStoreId] = useState("")
  const [sessionKind, setSessionKind] = useState<SessionKind>("buyer")
  const [sessionKey, setSessionKey] = useState("")
  const [history, setHistory] = useState<MessageCenterHistoryView | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [showOriginal, setShowOriginal] = useState(true)
  const [draftZh, setDraftZh] = useState("")
  const [draftRu, setDraftRu] = useState("")
  const [sending, setSending] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [replies, setReplies] = useState<string[]>(() => readCommonReplies())
  const requestSequence = useRef(0)
  const historySequence = useRef(0)

  const selectedStore = inbox.stores.find((store) => store.store_id === storeId) ?? inbox.stores[0]
  const selectedChats = selectedStore?.chats ?? []
  const visibleStores = useMemo(
    () => filterStores(inbox.stores, query, storeFilter),
    [inbox.stores, query, storeFilter],
  )
  const visibleSessions = useMemo(
    () => filterSessions(selectedChats, sessionKind),
    [selectedChats, sessionKind],
  )
  const selectedSession =
    visibleSessions.find((chat) => sessionIdentity(chat) === sessionKey) ?? visibleSessions[0]
  const counts = sessionCounts(selectedChats)

  const refreshInbox = useCallback(
    async (quiet = false) => {
      const overview = peekStoreRoster(workspaceId)?.overview ?? (await loadStoreRoster({ workspaceId }))
      const stores = inboxStoresFromRoster(overview.stores)
      const sequence = ++requestSequence.current
      if (!quiet) setLoad("loading")
      try {
        const next = await opsHttp.messageCenterInbox(inboxRequestOf(stores))
        if (sequence !== requestSequence.current) return
        setInbox(next)
        setUpdatedAt(Date.now())
        if (failedStoreCount(next) > 0) {
          notifyLive({
            id: MESSAGE_CENTER_READ_LIVE,
            type: "error",
            title: failedStoresNotice(next.failed_stores) || "部分店铺拉不到消息",
            description: next.failed_stores.length > 0
              ? `拉不到消息的店铺：${next.failed_stores
                  .map((store) => store.name.trim() || store.store_id || "未命名店铺")
                  .join("、")}`
              : undefined,
            action: { label: "刷新", onClick: () => void refreshInbox(true) },
          })
        } else {
          clearLive(MESSAGE_CENTER_READ_LIVE)
        }
        setStoreId((current) => {
          if (current && next.stores.some((store) => store.store_id === current)) return current
          return next.stores.find((store) => store.fetched)?.store_id
            ?? next.stores[0]?.store_id
            ?? ""
        })
      } catch (reason) {
        if (sequence !== requestSequence.current) return
        notifyLive({
          id: MESSAGE_CENTER_READ_LIVE,
          type: "error",
          reason,
          title: inboxError(reason),
          action: { label: "刷新", onClick: () => void refreshInbox(true) },
        })
      } finally {
        if (sequence === requestSequence.current) setLoad("idle")
      }
    },
    [workspaceId],
  )

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void loadStoreRoster({ workspaceId }).then(() => {
      if (!cancelled) void refreshInbox(false)
    })
    return () => {
      cancelled = true
      requestSequence.current += 1
    }
  }, [active, workspaceId, refreshInbox])

  useVisiblePolling({
    enabled: active,
    intervalMs: MESSAGE_CENTER_POLL_MS,
    restartKey: workspaceId ?? "session",
    onPoll: (trigger) => {
      if (trigger === "mount") return
      void refreshInbox(true)
    },
  })

  useEffect(() => () => clearLive(MESSAGE_CENTER_READ_LIVE), [])

  useEffect(() => {
    if (!selectedSession) {
      setHistory(null)
      return
    }
    const key = sessionIdentity(selectedSession)
    setSessionKey(key)
    const sequence = ++historySequence.current
    setHistoryLoading(true)
    void opsHttp
      .messageCenterHistory({
        store_id: selectedSession.store_id,
        chat_id: selectedSession.chat_id,
      })
      .then((next) => {
        if (sequence !== historySequence.current) return
        setHistory(next)
      })
      .catch((reason) => {
        if (sequence !== historySequence.current) return
        notifyCommandError(reason, inboxError(reason))
      })
      .finally(() => {
        if (sequence === historySequence.current) setHistoryLoading(false)
      })
  }, [selectedSession?.store_id, selectedSession?.chat_id])

  const onSend = useCallback(async () => {
    if (!selectedSession) return
    const request = sendRequestOf(
      selectedSession.store_id,
      selectedSession.chat_id,
      draftRu,
    )
    if (!request.text) {
      notifyError("右侧俄文不能为空")
      return
    }
    setSending(true)
    try {
      await opsHttp.messageCenterSend(request)
      notifySuccess("俄文消息已发送")
      setDraftZh("")
      setDraftRu("")
      const next = await opsHttp.messageCenterHistory({
        store_id: selectedSession.store_id,
        chat_id: selectedSession.chat_id,
      })
      setHistory(next)
      void refreshInbox(true)
    } catch (reason) {
      const code = commandErrorCode(reason)
      if (code === SELLER_RESULT_UNKNOWN_CODE) {
        // The message may already be in the buyer's chat. Re-sending would
        // post it twice, so the draft goes and the reconciler settles it.
        setDraftZh("")
        setDraftRu("")
        notifyError("结果未知", {
          reason,
          description: errorMessage(reason, "Ozon 没有确认这条消息，请勿重发，等待对账。"),
        })
        void refreshInbox(true)
        return
      }
      if (code === WRITES_DISABLED_CODE) {
        notifyError("写入已停用", {
          reason,
          description: errorMessage(reason, "Ozon 实时写入已停止，这条消息没有发出。"),
        })
        return
      }
      notifyCommandError(reason, sendError(reason))
    } finally {
      setSending(false)
    }
  }, [draftRu, refreshInbox, selectedSession])

  return (
    <div className="mc-inbox flex min-h-0 flex-1 flex-col gap-2 overflow-hidden">
      <InboxStats
        inbox={inbox}
        loading={load === "loading"}
        updatedAt={updatedAt}
        onRefresh={() => void refreshInbox(false)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {roster && roster.overview.stores.length === 0 ? (
        <Empty className="min-h-64">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <MessagesSquare />
            </EmptyMedia>
            <EmptyTitle>还没有店铺</EmptyTitle>
            <EmptyDescription>到店铺绑定 Seller 凭据后再拉客服消息。</EmptyDescription>
          </EmptyHeader>
          {onOpenStores ? (
            <Button variant="brand" size="sm" className="cursor-pointer" onClick={onOpenStores}>
              打开店铺
            </Button>
          ) : null}
        </Empty>
      ) : (
        <div
          className={cn(
            "grid min-h-0 flex-1 grid-cols-1 overflow-hidden border border-border bg-card",
            inbox.stores.length > 1
              ? "lg:grid-cols-[minmax(15rem,17.5rem)_minmax(18rem,21rem)_minmax(0,1fr)]"
              : "lg:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]",
          )}
        >
          {inbox.stores.length > 1 ? (
            <StoreColumn
              stores={visibleStores}
              total={inbox.store_count}
              waiting={inbox.waiting_reply_store_count}
              selectedId={selectedStore?.store_id ?? ""}
              query={query}
              filter={storeFilter}
              onQuery={setQuery}
              onFilter={setStoreFilter}
              onSelect={setStoreId}
            />
          ) : null}
          <SessionColumn
            kind={sessionKind}
            counts={counts}
            sessions={visibleSessions}
            selectedKey={selectedSession ? sessionIdentity(selectedSession) : ""}
            onKind={setSessionKind}
            onSelect={(chat) => setSessionKey(sessionIdentity(chat))}
          />
          <ThreadColumn
            store={selectedStore}
            session={selectedSession}
            history={history}
            historyLoading={historyLoading}
            showOriginal={showOriginal}
            onShowOriginal={setShowOriginal}
            draftZh={draftZh}
            draftRu={draftRu}
            onDraftZh={setDraftZh}
            onDraftRu={setDraftRu}
            replies={replies}
            sending={sending}
            onSend={() => void onSend()}
          />
        </div>
      )}

      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        replies={replies}
        onReplies={(next) => {
          setReplies(next)
          writeCommonReplies(next)
        }}
      />
    </div>
  )
}

function InboxStats({
  inbox,
  loading,
  updatedAt,
  onRefresh,
  onOpenSettings,
}: {
  inbox: MessageCenterInboxView
  loading: boolean
  updatedAt: number | null
  onRefresh: () => void
  onOpenSettings: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
      <Badge
        variant="destructive"
        className="whitespace-nowrap"
        aria-live="polite"
        aria-atomic="true"
      >
        {discloseUnread(inbox.waiting_reply_count)} 条等你回复
      </Badge>
      <span className="font-mono whitespace-nowrap tabular-nums text-muted-foreground">
        平台通知 {discloseUnread(inbox.platform_notification_count)}
      </span>
      <span className="font-mono whitespace-nowrap tabular-nums text-muted-foreground">
        {discloseUnread(inbox.store_count)} 家店 · {discloseUnread(inbox.session_count)} 个会话
      </span>
      <span className="ml-auto whitespace-nowrap text-faint-foreground">
        {relativeUpdated(updatedAt)}
      </span>
      <Button
        type="button"
        variant="outline"
        size="xs"
        className="cursor-pointer"
        onClick={onRefresh}
        disabled={loading}
      >
        {loading ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}
        刷新
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        className="cursor-pointer"
        aria-label="设置"
        onClick={onOpenSettings}
      >
        <Settings />
      </Button>
    </div>
  )
}

export function StoreColumn({
  stores,
  total,
  waiting,
  selectedId,
  query,
  filter,
  onQuery,
  onFilter,
  onSelect,
}: {
  stores: MessageCenterStoreView[]
  total: number
  waiting: number
  selectedId: string
  query: string
  filter: StoreFilter
  onQuery: (value: string) => void
  onFilter: (value: StoreFilter) => void
  onSelect: (storeId: string) => void
}) {
  return (
    <section className="flex min-h-0 flex-col border-b border-border lg:border-r lg:border-b-0">
      <header className="flex items-center justify-between border-b border-border px-2 py-1.5">
        <span className="text-xs font-medium">店铺</span>
        <span className="font-mono text-meta text-muted-foreground">
          {waiting}/{total}
        </span>
      </header>
      <div className="border-b border-border px-2 py-1.5">
        <Field className="gap-1">
          <FieldLabel htmlFor="mc-store-search" className="sr-only">
            搜索店铺名 / 编号
          </FieldLabel>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="mc-store-search"
              value={query}
              onChange={(event) => onQuery(event.target.value)}
              placeholder="搜索店铺名 / 编号"
              className="h-7 pl-7 text-xs"
            />
          </div>
        </Field>
      </div>
      <div className="border-b border-border px-2 py-1.5">
        <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="店铺筛选">
          {(
            [
              ["all", "全部"],
              ["waiting", `只看待回复 ${waiting}`],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={cn(
                "flex-1 cursor-pointer rounded-md px-2 py-1 text-xs whitespace-nowrap transition-colors outline-none focus-visible:outline-2 focus-visible:outline-ring",
                filter === value
                  ? "bg-card font-medium text-foreground shadow-sm ring-1 ring-border-strong/70"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <ul
        role="listbox"
        aria-label="店铺"
        className="min-h-0 flex-1 overflow-y-auto scroll-pt-2"
        onKeyDown={(event) =>
          moveList(event, stores, selectedId, (store) => store.store_id, (store) =>
            onSelect(store.store_id),
          )
        }
      >
        {stores.map((store) => {
          const selected = store.store_id === selectedId
          return (
            <li key={`${store.store_id}:${store.store_number}:${store.name}`}>
              <button
                type="button"
                role="option"
                aria-selected={selected}
                title={store.fetched ? undefined : store.fail_reason || undefined}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 border-l-2 px-2 py-1.5 text-left text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                  selected
                    ? "border-l-brand bg-brand-soft text-brand-ink ring-1 ring-inset ring-brand"
                    : "border-l-transparent hover:bg-muted",
                  !store.fetched && "opacity-70",
                )}
                onClick={() => onSelect(store.store_id)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{store.name}</span>
                  <span className="block truncate text-meta text-muted-foreground">
                    编号 {store.store_number || "—"} · {store.session_count} 个会话
                    {!store.fetched ? " · 拉不到" : ""}
                  </span>
                </span>
                {store.unread_count > 0 ? (
                  <UnreadBadge count={store.unread_count} />
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export function SessionColumn({
  kind,
  counts,
  sessions,
  selectedKey,
  onKind,
  onSelect,
}: {
  kind: SessionKind
  counts: Record<SessionKind, number>
  sessions: MessageCenterChatItem[]
  selectedKey: string
  onKind: (kind: SessionKind) => void
  onSelect: (chat: MessageCenterChatItem) => void
}) {
  return (
    <section className="flex min-h-0 flex-col border-b border-border lg:border-r lg:border-b-0">
      <Tabs value={kind} onValueChange={(value) => onKind(value as SessionKind)}>
        <TabsList className="w-full rounded-none border-0 border-b">
          <TabsIndicator />
          <TabsTrigger value="buyer" className="flex-1">
            买家消息 {counts.buyer}
          </TabsTrigger>
          <TabsTrigger value="ticket" className="flex-1">
            客服工单 {counts.ticket}
          </TabsTrigger>
          <TabsTrigger value="platform" className="flex-1">
            平台通知 {counts.platform}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      <ul
        role="listbox"
        aria-label={sessionKindLabel(kind)}
        className="min-h-0 flex-1 overflow-y-auto scroll-pt-2"
        onKeyDown={(event) =>
          moveList(event, sessions, selectedKey, sessionIdentity, onSelect)
        }
      >
        {sessions.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">没有会话</li>
        ) : (
          sessions.map((chat) => {
            const selected = sessionIdentity(chat) === selectedKey
            const preview = chat.preview.trim()
            const closed = chat.chat_status.trim().toUpperCase() === "CLOSED"
            return (
              <li key={sessionIdentity(chat)}>
                <button
                  type="button"
                  role="option"
                  aria-selected={selected}
                  title={chat.chat_id}
                  className={cn(
                    "flex w-full cursor-pointer flex-col gap-1 border-l-2 px-2.5 py-2 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                    selected
                      ? "border-l-brand bg-brand-soft"
                      : "border-l-transparent hover:bg-muted",
                  )}
                  onClick={() => onSelect(chat)}
                >
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate font-mono text-xs text-foreground">
                      #{chat.chat_id.slice(0, 8)}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <span className="text-meta whitespace-nowrap tabular-nums text-faint-foreground">
                        {formatSessionTime(chat.created_at)}
                      </span>
                      {chat.unread_count > 0 ? (
                        <UnreadCount count={chat.unread_count} />
                      ) : null}
                    </span>
                  </span>
                  {preview ? (
                    <span className="line-clamp-2 text-xs break-words text-muted-foreground">
                      {preview}
                    </span>
                  ) : null}
                  {closed ? (
                    <span className="text-meta text-faint-foreground">
                      {chatStatusLabel(chat.chat_status)}
                    </span>
                  ) : null}
                </button>
              </li>
            )
          })
        )}
      </ul>
    </section>
  )
}

export function ThreadColumn({
  store,
  session,
  history,
  showOriginal,
  onShowOriginal,
  draftZh,
  draftRu,
  onDraftZh,
  onDraftRu,
  replies,
  sending,
  onSend,
}: {
  store?: MessageCenterStoreView
  session?: MessageCenterChatItem
  history: MessageCenterHistoryView | null
  historyLoading: boolean
  showOriginal: boolean
  onShowOriginal: (value: boolean) => void
  draftZh: string
  draftRu: string
  onDraftZh: (value: string) => void
  onDraftRu: (value: string) => void
  replies: string[]
  sending: boolean
  onSend: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el && history) el.scrollTop = el.scrollHeight
  }, [history])

  if (!session || !store) {
    return (
      <section className="grid min-h-72 place-items-center text-xs text-muted-foreground">
        选择左侧店铺和会话
      </section>
    )
  }

  const closed = session.chat_status.trim().toUpperCase() === "CLOSED"
  const kind = sessionKindOfSafe(session)
  // A history payload belongs to exactly one chat — never paint the previous
  // chat's messages under the newly selected header.
  const current = history && history.chat_id === session.chat_id ? history : null
  const messages = current?.messages ?? []

  return (
    <section className="flex min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2">
        <span className="text-xs font-semibold text-foreground">
          {sessionKindLabel(kind)}
        </span>
        <span className="text-faint-foreground" aria-hidden>·</span>
        <span className="text-xs text-muted-foreground">{store.name}</span>
        {closed ? (
          <Badge variant="outline" className="whitespace-nowrap">
            {chatStatusLabel(session.chat_status)}
          </Badge>
        ) : null}
        <span className="flex items-center gap-0.5">
          <IdCode value={`#${session.chat_id.slice(0, 8)}`} />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="cursor-pointer"
            aria-label="复制会话 ID"
            title={session.chat_id}
            onClick={() => {
              void navigator.clipboard
                .writeText(session.chat_id)
                .then(() => notifySuccess("已复制会话 ID"))
            }}
          >
            <Copy />
          </Button>
        </span>
        <span className="ml-auto flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-meta text-muted-foreground">
            <Switch
              size="sm"
              checked={showOriginal}
              onCheckedChange={onShowOriginal}
            />
            原文
          </label>
        </span>
      </header>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto scroll-pb-4 px-3 py-3">
        {!current ? (
          <div className="grid h-32 place-items-center">
            <Spinner aria-label="正在读取会话" />
          </div>
        ) : messages.length === 0 ? (
          // 列表徽标的未读来自会话元数据，线程内容来自 history 的「可见」
          // 消息。两条口径在 Ozon 侧可以对不齐：消息被归档或过期后 history
          // 返回空，元数据未读还在。此时说明差异，禁止「徽标 1 + 暂无消息」
          // 同屏。该文案是持久化的说明性业务状态，属 AGENTS.md 错误文案规则的明文例外。
          session.unread_count > 0 ? (
            <div className="grid h-32 place-items-center px-6 text-center text-xs text-muted-foreground">
              {invisibleUnreadNote(session.unread_count)}
            </div>
          ) : (
            <div className="grid h-32 place-items-center text-xs text-muted-foreground">
              暂无消息
            </div>
          )
        ) : (
          <ol className="flex flex-col gap-2.5">
            {current.has_next ? (
              <li className="pb-1 text-center text-meta text-faint-foreground">
                仅显示最近 {messages.length} 条
              </li>
            ) : null}
            {messages.map((message, index) => (
              <ThreadMessage
                key={index}
                message={message}
                showOriginal={showOriginal}
              />
            ))}
          </ol>
        )}
      </div>
      {kind === "platform" || closed ? (
        <div className="border-t border-border px-3 py-2 text-meta text-faint-foreground">
          {closed ? "会话已关闭，无法回复。" : "平台通知为单向推送，不支持回复。"}
        </div>
      ) : (
        <Composer
          draftZh={draftZh}
          draftRu={draftRu}
          onDraftZh={onDraftZh}
          onDraftRu={onDraftRu}
          replies={replies}
          sending={sending}
          onSend={onSend}
        />
      )}
    </section>
  )
}

function sessionKindOfSafe(chat: MessageCenterChatItem) {
  return chat.session_kind === "buyer" || chat.session_kind === "ticket"
    ? chat.session_kind
    : "platform"
}

function ThreadMessage({
  message,
  showOriginal,
}: {
  message: MessageCenterMessageView
  showOriginal: boolean
}) {
  const body = messageBody(message)
  return (
    <li className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        <div className="max-w-[80%] rounded-lg border border-border bg-muted/50 px-2.5 py-1.5 text-xs leading-relaxed text-foreground">
          {showOriginal ? (
            <p className="whitespace-pre-wrap break-words">
              <ChatMarkdown text={body || "—"} />
            </p>
          ) : (
            <p className="text-muted-foreground">{TRANSLATION_HELP}</p>
          )}
        </div>
      </div>
    </li>
  )
}

function Composer({
  draftZh,
  draftRu,
  onDraftZh,
  onDraftRu,
  replies,
  sending,
  onSend,
}: {
  draftZh: string
  draftRu: string
  onDraftZh: (value: string) => void
  onDraftRu: (value: string) => void
  replies: string[]
  sending: boolean
  onSend: () => void
}) {
  function onRuKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      onSend()
    }
  }

  return (
    <div className="border-t border-border">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
        <Popover>
          <PopoverTrigger
            render={
              <Button type="button" variant="outline" size="xs" className="cursor-pointer">
                常用回复
              </Button>
            }
          />
          <PopoverContent className="w-72">
            {replies.length === 0 ? (
              <p className="text-xs text-muted-foreground">设置里添加常用回复。</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {replies.map((reply) => (
                  <li key={reply}>
                    <button
                      type="button"
                      className="w-full cursor-pointer px-1 py-1 text-left text-xs hover:bg-muted"
                      onClick={() => onDraftZh(reply)}
                    >
                      {reply}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
        <p id="mc-translate-help" className="text-meta text-faint-foreground">
          {TRANSLATION_HELP}
        </p>
      </div>
      <div className="grid gap-0 border-t border-border md:grid-cols-2">
        <Field className="gap-1 border-b border-border px-3 py-2 md:border-r md:border-b-0">
          <FieldLabel htmlFor="mc-draft-zh" className="text-meta text-faint-foreground">
            中文草稿 · 仅自己可见
          </FieldLabel>
          <Textarea
            id="mc-draft-zh"
            value={draftZh}
            onChange={(event) => onDraftZh(event.target.value)}
            placeholder="中文备忘，不会发送"
            className="min-h-20 rounded-none text-xs"
          />
        </Field>
        <Field className="gap-1 px-3 py-2">
          <FieldLabel htmlFor="mc-draft-ru" className="text-meta text-faint-foreground">
            发送内容 · 俄文
          </FieldLabel>
          <Textarea
            id="mc-draft-ru"
            value={draftRu}
            onChange={(event) => onDraftRu(event.target.value)}
            onKeyDown={onRuKey}
            placeholder="输入或粘贴俄文，Enter 发送"
            className="min-h-20 rounded-none text-xs"
          />
        </Field>
      </div>
      <div className="flex items-center justify-between border-t border-border px-3 py-1.5">
        <FieldDescription>Enter 发送 · Shift+Enter 换行</FieldDescription>
        <Button
          type="button"
          variant="brand"
          size="sm"
          className="cursor-pointer"
          disabled={sending}
          onClick={onSend}
        >
          {sending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
          发送俄文
        </Button>
      </div>
    </div>
  )
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <Badge variant="destructive" className="max-w-full shrink-0 whitespace-nowrap rounded-none">
      {unreadLiveStatus(count)}
    </Badge>
  )
}

function UnreadCount({ count }: { count: number }) {
  return (
    <Badge
      variant="destructive"
      aria-label={unreadLiveStatus(count)}
      title={unreadLiveStatus(count)}
      className="h-5 min-w-5 shrink-0 justify-center px-1 whitespace-nowrap tabular-nums"
    >
      {discloseUnread(count)}
    </Badge>
  )
}

function SettingsDialog({
  open,
  onOpenChange,
  replies,
  onReplies,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  replies: string[]
  onReplies: (replies: string[]) => void
}) {
  const [draft, setDraft] = useState("")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle>消息中心设置</DialogTitle>
          <DialogDescription>{TRANSLATION_HELP}</DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <Field>
            <FieldLabel htmlFor="mc-reply-new">常用回复</FieldLabel>
            <Textarea
              id="mc-reply-new"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              className="min-h-16 text-xs"
            />
          </Field>
          <ul className="flex flex-col gap-1">
            {replies.map((reply) => (
              <li key={reply} className="flex items-center gap-2 text-xs">
                <span className="min-w-0 flex-1 whitespace-nowrap">{reply}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="cursor-pointer"
                  onClick={() => onReplies(replies.filter((item) => item !== reply))}
                >
                  删除
                </Button>
              </li>
            ))}
          </ul>
        </div>
        <DialogFooter className="m-0 shrink-0 rounded-none px-4 py-3">
          <Button
            type="button"
            variant="brand"
            size="sm"
            className="cursor-pointer"
            onClick={() => {
              const next = draft.trim()
              if (!next) return
              onReplies([...replies, next])
              setDraft("")
            }}
          >
            添加
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function moveList<T>(
  event: KeyboardEvent<HTMLUListElement>,
  items: T[],
  selected: string,
  idOf: (item: T) => string,
  onSelect: (item: T) => void,
) {
  if (items.length === 0) return
  const index = items.findIndex((item) => idOf(item) === selected)
  if (event.key === "ArrowDown") {
    event.preventDefault()
    onSelect(items[Math.min(items.length - 1, Math.max(0, index) + 1)])
  } else if (event.key === "ArrowUp") {
    event.preventDefault()
    onSelect(items[Math.max(0, (index < 0 ? 0 : index) - 1)])
  } else if (event.key === "Home") {
    event.preventDefault()
    onSelect(items[0])
  } else if (event.key === "End") {
    event.preventDefault()
    onSelect(items[items.length - 1])
  }
}

export function MessageCenterResults({
  inbox,
  children,
}: {
  inbox: MessageCenterInboxView
  children?: ReactNode
}) {
  return (
    <div className="mc-inbox">
      <InboxStats
        inbox={inbox}
        loading={false}
        updatedAt={null}
        onRefresh={() => {}}
        onOpenSettings={() => {}}
      />
      {children}
    </div>
  )
}

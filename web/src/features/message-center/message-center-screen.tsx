import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { ChevronDown, Copy, Info, ListFilter, Loader2Icon, LockKeyhole, MessagesSquare, NotebookPen, RefreshCw, Search, Send, Settings } from "lucide-react"
import { StoreIcon } from "@/components/store-icon"
import type { MessageCenterChatItem, MessageCenterHistoryView, MessageCenterInboxView, MessageCenterMessageView, MessageCenterStoreView } from "@/bindings/commands"
import { opsHttp } from "@/bindings/http-ops"
import { ErrorNotice } from "@/components/error-notice"
import { IdCode } from "@/components/id-code"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
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
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
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
  OZON_AUTH_FAILED_CODE,
  SELLER_RESULT_UNKNOWN_CODE,
  WRITES_DISABLED_CODE,
} from "@/lib/error-message"
import { clearLive, notifyCommandError, notifyError, notifyLive, notifySuccess } from "@/lib/notify"
import { useVisiblePolling } from "@/lib/visible-polling"
import { cn } from "@/lib/utils"

import { ChatMarkdown } from "./chat-markdown"
import { sendAndReadMessage } from "./message-center-send"
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
  formatMessageTime,
  formatSessionTime,
  inboxError,
  inboxRequestOf,
  inboxStoresFromRoster,
  invisibleUnreadNote,
  messageBody,
  messageImageLinks,
  messageSender,
  readCommonReplies,
  relativeUpdated,
  sendError,
  sendRequestOf,
  sessionCounts,
  sessionIdentity,
  sessionKindOf,
  sessionKindLabel,
  writeCommonReplies,
  type SessionKind,
  type SessionStatus,
  type StoreFilter,
} from "./message-center-model"

type MessageCenterScreenProps = {
  workspaceId?: number
  onOpenStores?: () => void
}

const MESSAGE_CENTER_READ_LIVE = "message-center-read"
const EMPTY_INBOX: MessageCenterInboxView = {
  stores: [],
  failed_stores: [],
  waiting_reply_count: 0,
  platform_notification_count: 0,
  store_count: 0,
  waiting_reply_store_count: 0,
  session_count: 0,
  failed_store_count: 0,
}
type MessageDraft = { zh: string; ru: string }

export function MessageCenterScreen({ workspaceId, onOpenStores }: MessageCenterScreenProps) {
  const active = useScreenActive()
  const roster = useStoreRoster(workspaceId)
  const [inboxState, setInboxState] = useState({ workspaceId, value: EMPTY_INBOX })
  const inbox = inboxState.workspaceId === workspaceId ? inboxState.value : EMPTY_INBOX
  const [load, setLoad] = useState<"idle" | "loading">("idle")
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [query, setQuery] = useState("")
  const [storeFilter, setStoreFilter] = useState<StoreFilter>("all")
  const [storeId, setStoreId] = useState("")
  const [sessionKind, setSessionKind] = useState<SessionKind>("buyer")
  const [sessionQuery, setSessionQuery] = useState("")
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("all")
  const [sessionKey, setSessionKey] = useState("")
  const [history, setHistory] = useState<{ key: string; value: MessageCenterHistoryView } | null>(null)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyFailureKey, setHistoryFailureKey] = useState<string | null>(null)
  const [historyReload, setHistoryReload] = useState(0)
  const [showOriginal, setShowOriginal] = useState(true)
  const [drafts, setDrafts] = useState<Record<string, MessageDraft>>({})
  const [sendingKeys, setSendingKeys] = useState<Set<string>>(() => new Set())
  const sendingKeysRef = useRef(new Set<string>())
  const sendOperationsRef = useRef(new Map<string, { text: string; id: string }>())
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
    () => filterSessions(selectedChats, sessionKind, sessionQuery, sessionStatus),
    [selectedChats, sessionKind, sessionQuery, sessionStatus],
  )
  const selectedSession =
    selectedChats.find((chat) => sessionKindOf(chat) === sessionKind && sessionIdentity(chat) === sessionKey) ?? visibleSessions[0]
  const counts = sessionCounts(selectedChats)
  const conversationKey = selectedSession ? JSON.stringify([workspaceId, selectedSession.store_id, selectedSession.chat_id]) : ""
  const scopeRef = useRef({ workspaceId, conversationKey, active })
  if (scopeRef.current.workspaceId !== workspaceId || scopeRef.current.conversationKey !== conversationKey || scopeRef.current.active !== active) {
    scopeRef.current = { workspaceId, conversationKey, active }
  }
  const mountedRef = useRef(true)
  const draftZh = drafts[conversationKey]?.zh ?? ""
  const draftRu = drafts[conversationKey]?.ru ?? ""
  const sending = sendingKeys.has(conversationKey)
  const setDraftField = useCallback((field: keyof MessageDraft, value: string) => {
    if (!conversationKey) return
    setDrafts((current) => ({
      ...current,
      [conversationKey]: { ...(current[conversationKey] ?? { zh: "", ru: "" }), [field]: value },
    }))
  }, [conversationKey])

  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  const refreshInbox = useCallback(
    async (quiet = false) => {
      if (!mountedRef.current || scopeRef.current.workspaceId !== workspaceId) return
      const sequence = ++requestSequence.current
      if (!quiet) setLoad("loading")
      try {
        const overview = peekStoreRoster(workspaceId)?.overview ?? (await loadStoreRoster({ workspaceId }))
        if (!mountedRef.current || scopeRef.current.workspaceId !== workspaceId || sequence !== requestSequence.current) return
        const stores = inboxStoresFromRoster(overview.stores)
        const next = await opsHttp.messageCenterInbox(inboxRequestOf(stores))
        if (!mountedRef.current || scopeRef.current.workspaceId !== workspaceId || sequence !== requestSequence.current) return
        setInboxState({ workspaceId, value: next })
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
        if (!mountedRef.current || scopeRef.current.workspaceId !== workspaceId || sequence !== requestSequence.current) return
        notifyLive({
          id: MESSAGE_CENTER_READ_LIVE,
          type: "error",
          reason,
          title: inboxError(reason),
          action: { label: "刷新", onClick: () => void refreshInbox(true) },
        })
      } finally {
        if (mountedRef.current && scopeRef.current.workspaceId === workspaceId && sequence === requestSequence.current) setLoad("idle")
      }
    },
    [workspaceId],
  )

  useEffect(() => {
    if (!active || !workspaceId) return
    void refreshInbox(false)
    return () => {
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
    const sequence = ++historySequence.current
    if (!selectedSession) {
      setHistory(null)
      setHistoryLoading(false)
      setHistoryFailureKey(null)
      return
    }
    if (!active) {
      setHistoryLoading(false)
      return
    }
    const scope = scopeRef.current
    const isCurrent = () => mountedRef.current && scopeRef.current === scope && sequence === historySequence.current
    const key = sessionIdentity(selectedSession)
    setSessionKey(key)
    setHistoryLoading(true)
    setHistoryFailureKey(null)
    void opsHttp
      .messageCenterHistory({
        store_id: selectedSession.store_id,
        chat_id: selectedSession.chat_id,
      })
      .then((next) => {
        if (!isCurrent()) return
        setHistory({ key: conversationKey, value: next })
      })
      .catch((reason) => {
        if (!isCurrent()) return
        setHistoryFailureKey(conversationKey)
        notifyCommandError(reason, inboxError(reason))
      })
      .finally(() => {
        if (isCurrent()) setHistoryLoading(false)
      })
    return () => {
      if (sequence === historySequence.current) historySequence.current += 1
    }
  }, [active, conversationKey, selectedSession?.store_id, selectedSession?.chat_id, historyReload])

  const onSend = useCallback(async () => {
    if (!selectedSession || !conversationKey || sendingKeysRef.current.has(conversationKey)) return
    const text = draftRu.trim()
    const previous = sendOperationsRef.current.get(conversationKey)
    const operation = previous?.text === text ? previous : { text, id: crypto.randomUUID() }
    sendOperationsRef.current.set(conversationKey, operation)
    const request = sendRequestOf(
      selectedSession.store_id,
      selectedSession.chat_id,
      draftRu,
      operation.id,
    )
    if (!request.text) {
      notifyError("右侧俄文不能为空")
      return
    }
    const scope = scopeRef.current
    const isCurrent = () => mountedRef.current && scopeRef.current === scope
    const origin = `${selectedStore?.name || "店铺"} · #${selectedSession.chat_id.slice(0, 8)}`
    const clearSubmittedDraft = () => {
      if (!mountedRef.current) return
      setDrafts((current) => {
        const draft = current[conversationKey]
        if (!draft || draft.ru !== draftRu) return current
        return {
          ...current,
          [conversationKey]: {
            zh: draft.zh === draftZh ? "" : draft.zh,
            ru: "",
          },
        }
      })
    }
    sendingKeysRef.current.add(conversationKey)
    setSendingKeys((current) => new Set(current).add(conversationKey))
    try {
      const result = await sendAndReadMessage(request, isCurrent)
      sendOperationsRef.current.delete(conversationKey)
      clearSubmittedDraft()
      if (isCurrent() && result.status !== "skipped") {
        historySequence.current += 1
        setHistoryLoading(false)
        if (result.status === "ready") {
          setHistory({ key: conversationKey, value: result.history })
          setHistoryFailureKey(null)
        } else {
          setHistoryFailureKey(conversationKey)
        }
      }
      if (result.status === "failed") {
        notifyError("消息已发送，会话刷新失败", {
          reason: result.refreshError,
          description: `${origin}：请重试读取会话，无需重新发送。`,
        })
      } else {
        notifySuccess("俄文消息已发送", { description: origin })
      }
      void refreshInbox(true)
    } catch (reason) {
      const code = commandErrorCode(reason)
      if (code === OZON_AUTH_FAILED_CODE || code === "cloud_ozon_message_center_failed") {
        sendOperationsRef.current.delete(conversationKey)
      }
      if (code === SELLER_RESULT_UNKNOWN_CODE) {
        // The message may already be in the buyer's chat. Re-sending would
        // post it twice, so the draft goes and the operator checks the conversation.
        clearSubmittedDraft()
        sendOperationsRef.current.delete(conversationKey)
        notifyError("结果未知，请勿重发", {
          reason,
          description: `${origin}：${errorMessage(reason, "Ozon 没有确认这条消息，请勿重发。请读取会话人工核对。")}`,
        })
        void refreshInbox(true)
        return
      }
      if (code === WRITES_DISABLED_CODE) {
        notifyError("写入已停用", {
          reason,
          description: `${origin}：${errorMessage(reason, "Ozon 实时写入已停止，这条消息没有发出。")}`,
        })
        return
      }
      notifyCommandError(reason, sendError(reason))
    } finally {
      sendingKeysRef.current.delete(conversationKey)
      if (mountedRef.current) setSendingKeys((current) => {
        const next = new Set(current)
        next.delete(conversationKey)
        return next
      })
    }
  }, [conversationKey, draftRu, draftZh, refreshInbox, selectedSession, selectedStore?.name])

  if (!workspaceId) {
    return (
      <div className="flex min-h-80 w-full flex-col items-center justify-center rounded-xl border border-border bg-card p-8 text-center sm:p-12">
        <Empty role="status" className="min-h-0 border-0 bg-transparent p-0">
          <EmptyHeader className="max-w-md">
            <EmptyMedia variant="icon">
              <MessagesSquare className="size-6 text-primary" />
            </EmptyMedia>
            <EmptyTitle>尚未选择工作空间</EmptyTitle>
            <EmptyDescription>
              客服消息基于工作空间下的店铺聚合。请先在左侧栏选择或创建工作空间以查看消息会话。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  return (
    <div className="mc-inbox flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto rounded-xl border border-border bg-card lg:grid-cols-[minmax(14rem,16.5rem)_minmax(0,1fr)] lg:overflow-hidden">
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
          noStores={Boolean(roster && roster.overview.stores.length === 0)}
          loading={load === "loading"}
          loaded={Boolean(updatedAt && inboxState.workspaceId === workspaceId)}
          onOpenStores={onOpenStores}
          actions={<InboxStats
            compact
            inbox={inbox}
            loading={load === "loading"}
            updatedAt={inboxState.workspaceId === workspaceId ? updatedAt : null}
            onRefresh={() => void refreshInbox(false)}
            onOpenSettings={() => setSettingsOpen(true)}
          />}
        />
        <div className="flex min-h-0 min-w-0 flex-col">
          <SessionToolbar
            kind={sessionKind}
            counts={counts}
            query={sessionQuery}
            status={sessionStatus}
            onKind={setSessionKind}
            onQuery={setSessionQuery}
            onStatus={setSessionStatus}
          />
          <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]">
          <SessionColumn
            kind={sessionKind}
            counts={counts}
            sessions={visibleSessions}
            selectedKey={selectedSession ? sessionIdentity(selectedSession) : ""}
            query={sessionQuery}
            status={sessionStatus}
            onKind={setSessionKind}
            onQuery={setSessionQuery}
            onStatus={setSessionStatus}
            onSelect={(chat) => setSessionKey(sessionIdentity(chat))}
            showToolbar={false}
            hasStore={Boolean(selectedStore)}
          />
          <ThreadColumn
            key={conversationKey || "empty"}
            store={selectedStore}
            session={selectedSession}
            history={history?.key === conversationKey ? history.value : null}
            historyLoading={historyLoading}
            historyFailed={Boolean(conversationKey && historyFailureKey === conversationKey)}
            onRetryHistory={() => setHistoryReload((revision) => revision + 1)}
            showOriginal={showOriginal}
            onShowOriginal={setShowOriginal}
            draftZh={draftZh}
            draftRu={draftRu}
            onDraftZh={(value) => setDraftField("zh", value)}
            onDraftRu={(value) => setDraftField("ru", value)}
            replies={replies}
            sending={sending}
            onSend={() => void onSend()}
          />
          </div>
        </div>
      </div>

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
  compact = false,
}: {
  inbox: MessageCenterInboxView
  loading: boolean
  updatedAt: number | null
  onRefresh: () => void
  onOpenSettings: () => void
  compact?: boolean
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-xs", compact ? "ml-auto gap-x-1" : "px-3 py-1.5")}>
      <Badge
        variant="destructive"
        className={cn("whitespace-nowrap", compact && "sr-only")}
        aria-live="polite"
        aria-atomic="true"
      >
        {discloseUnread(inbox.waiting_reply_count)} 条等你回复
      </Badge>
      <span className={cn("font-mono whitespace-nowrap tabular-nums text-muted-foreground", compact && "sr-only")}>
        平台通知 {discloseUnread(inbox.platform_notification_count)}
      </span>
      <span className={cn("font-mono whitespace-nowrap tabular-nums text-muted-foreground", compact && "sr-only")}>
        {discloseUnread(inbox.store_count)} 家店 · {discloseUnread(inbox.session_count)} 个会话
      </span>
      <span className={cn("ml-auto whitespace-nowrap text-faint-foreground", compact && "sr-only")}>
        {relativeUpdated(updatedAt)}
      </span>
      <IconButton
        icon={loading ? Loader2Icon : RefreshCw}
        label="刷新"
        variant="outline"
        size="icon-xs"
        className={cn("cursor-pointer", loading && "[&_svg]:animate-spin")}
        onClick={onRefresh}
        disabled={loading}
      />
      <IconButton
        icon={Settings}
        label="设置"
        size="icon-xs"
        className="cursor-pointer"
        onClick={onOpenSettings}
      />
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
  noStores = false,
  loading = false,
  loaded = true,
  onOpenStores,
  actions,
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
  noStores?: boolean
  loading?: boolean
  loaded?: boolean
  onOpenStores?: () => void
  actions?: ReactNode
}) {
  return (
    <section className="flex min-h-36 max-h-64 flex-col border-b border-border lg:min-h-0 lg:max-h-none lg:border-r lg:border-b-0">
      <header className="flex min-h-14 items-center gap-2 border-b border-border px-4">
        <span className="text-base font-semibold">Ozon 店铺</span>
        <span className="ml-auto font-mono text-meta text-muted-foreground">
          {waiting}/{total}
        </span>
        <Popover>
          <PopoverTrigger render={<IconButton icon={ListFilter} label="筛选店铺" variant="outline" size="icon-xs" />} />
          <PopoverContent className="w-64 space-y-3">
            <Field className="gap-1">
              <FieldLabel htmlFor="mc-store-search" className="sr-only">搜索店铺名 / 编号</FieldLabel>
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input id="mc-store-search" value={query} onChange={(event) => onQuery(event.target.value)} placeholder="搜索店铺名 / 编号" className="h-8 pl-7 text-xs" />
              </div>
            </Field>
            <div className="flex rounded-lg bg-muted p-0.5" role="group" aria-label="店铺筛选">
              {([ ["all", "全部"], ["waiting", `只看待回复 ${waiting}`] ] as const).map(([value, label]) => (
                <button key={value} type="button" aria-pressed={filter === value} className={cn("flex-1 cursor-pointer rounded-md px-2 py-1 text-xs whitespace-nowrap outline-none focus-visible:outline-2 focus-visible:outline-ring", filter === value ? "bg-card font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")} onClick={() => onFilter(value)}>{label}</button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        {actions}
      </header>
      <ul
        role="listbox"
        aria-label="店铺"
        className="min-h-0 flex-1 overflow-y-auto scroll-pt-2 p-2"
        onKeyDown={(event) =>
          moveList(event, stores, selectedId, (store) => store.store_id, (store) =>
            onSelect(store.store_id),
          )
        }
      >
        {stores.length === 0 ? <li className="flex flex-col items-center gap-2 px-4 py-8 text-center text-xs leading-relaxed text-muted-foreground">
          <span>{noStores ? "还没有店铺" : !loaded ? loading ? "正在读取店铺…" : "店铺状态未知，请刷新" : query.trim() || filter !== "all" ? "没有符合条件的店铺" : "暂无可用店铺"}</span>
          {noStores && onOpenStores ? <Button variant="outline" size="sm" onClick={onOpenStores}>打开店铺</Button> : null}
        </li> : null}
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
                  "flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-3 text-left text-xs outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                  selected
                    ? "bg-brand-soft text-brand-ink ring-1 ring-inset ring-brand"
                    : "hover:bg-muted",
                  !store.fetched && "opacity-70",
                )}
                onClick={() => onSelect(store.store_id)}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"><StoreIcon className="size-4" aria-hidden /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{store.name}</span>
                  <span className="block truncate text-meta text-muted-foreground">
                    编号 {store.store_number || "—"} · {store.session_count} 个会话
                    {!store.fetched ? " · 拉不到" : ""}
                  </span>
                </span>
                {store.unread_count > 0 ? (
                  <UnreadCount count={store.unread_count} />
                ) : null}
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function SessionToolbar({
  kind,
  counts,
  query,
  status,
  onKind,
  onQuery,
  onStatus,
}: {
  kind: SessionKind
  counts: Record<SessionKind, number>
  query: string
  status: SessionStatus
  onKind: (kind: SessionKind) => void
  onQuery: (query: string) => void
  onStatus: (status: SessionStatus) => void
}) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
      <Tabs value={kind} onValueChange={(value) => onKind(value as SessionKind)} className="gap-0">
        <TabsList variant="line" className="gap-3">
          <TabsIndicator variant="line" className="bg-brand" />
          <TabsTrigger value="buyer" variant="line" className="gap-1 data-active:text-brand-ink">买家消息 <span className="rounded-md bg-muted px-1.5 tabular-nums">{counts.buyer}</span></TabsTrigger>
          <TabsTrigger value="ticket" variant="line" className="gap-1 data-active:text-brand-ink">客服工单 <span className="rounded-md bg-muted px-1.5 tabular-nums">{counts.ticket}</span></TabsTrigger>
          <TabsTrigger value="platform" variant="line" className="gap-1 data-active:text-brand-ink">平台通知 <span className="rounded-md bg-muted px-1.5 tabular-nums">{counts.platform}</span></TabsTrigger>
        </TabsList>
      </Tabs>
      <Select value={status} onValueChange={(value) => { if (value) onStatus(value as SessionStatus) }}>
        <SelectTrigger size="sm" aria-label="会话状态"><SelectValue>{status === "opened" ? "进行中" : status === "closed" ? "已关闭" : "全部状态"}</SelectValue></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">全部状态</SelectItem>
          <SelectItem value="opened">进行中</SelectItem>
          <SelectItem value="closed">已关闭</SelectItem>
        </SelectContent>
      </Select>
      <InputGroup className="h-9 min-w-36 flex-1 sm:max-w-72">
        <InputGroupAddon><Search aria-hidden /></InputGroupAddon>
        <InputGroupInput aria-label="搜索会话编号或消息" placeholder="搜索会话编号或消息" value={query} onChange={(event) => onQuery(event.target.value)} />
      </InputGroup>
    </div>
  )
}

export function SessionColumn({
  kind,
  counts,
  sessions,
  selectedKey,
  query,
  status,
  onKind,
  onQuery,
  onStatus,
  onSelect,
  showToolbar = true,
  hasStore = true,
}: {
  kind: SessionKind
  counts: Record<SessionKind, number>
  sessions: MessageCenterChatItem[]
  selectedKey: string
  query: string
  status: SessionStatus
  onKind: (kind: SessionKind) => void
  onQuery: (query: string) => void
  onStatus: (status: SessionStatus) => void
  onSelect: (chat: MessageCenterChatItem) => void
  showToolbar?: boolean
  hasStore?: boolean
}) {
  return (
    <section className="flex min-h-44 max-h-80 flex-col border-b border-border lg:min-h-0 lg:max-h-none lg:border-r lg:border-b-0">
      {showToolbar ? <SessionToolbar kind={kind} counts={counts} query={query} status={status} onKind={onKind} onQuery={onQuery} onStatus={onStatus} /> : null}
      {selectedKey && !sessions.some((chat) => sessionIdentity(chat) === selectedKey) ? (
        <p role="status" className="px-3 py-2 text-xs text-muted-foreground">当前会话不在筛选结果中</p>
      ) : null}
      <ul
        role="listbox"
        aria-label={sessionKindLabel(kind)}
        className="min-h-0 flex-1 overflow-y-auto scroll-pt-2 p-2"
        onKeyDown={(event) =>
          moveList(event, sessions, selectedKey, sessionIdentity, onSelect)
        }
      >
        {sessions.length === 0 ? (
          <li className="px-3 py-6 text-center text-xs text-muted-foreground">{!hasStore ? "请先选择店铺" : query.trim() || status !== "all" ? "没有符合条件的会话" : "没有会话"}</li>
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
                    "flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-4 text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring",
                    selected
                      ? "bg-brand-soft"
                      : "hover:bg-muted",
                  )}
                  onClick={() => onSelect(chat)}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink"><MessagesSquare className="size-4" aria-hidden /></span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
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
                  </span>
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
  historyLoading,
  historyFailed = false,
  onRetryHistory,
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
  historyFailed?: boolean
  onRetryHistory?: () => void
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
      <section className="flex min-h-48 min-w-0 flex-col items-center justify-center gap-3 bg-muted/25 px-6 text-center">
        <MessagesSquare className="size-7 text-muted-foreground" aria-hidden />
        <p className="text-sm text-muted-foreground">选择左侧店铺和会话</p>
      </section>
    )
  }

  const closed = session.chat_status.trim().toUpperCase() === "CLOSED"
  const kind = sessionKindOfSafe(session)
  // A thread belongs to one store and chat, even when two stores share a chat ID.
  const current = history?.store_id === session.store_id && history.chat_id === session.chat_id ? history : null
  const messages = Array.isArray(current?.messages) ? current.messages : []

  return (
    <section className="mc-thread flex min-h-80 min-w-0 flex-col bg-background lg:min-h-0" aria-label="会话详情">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink"><MessagesSquare className="size-4" aria-hidden /></span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 break-words font-mono text-sm font-semibold text-foreground">#{session.chat_id.slice(0, 8)}</h2>
            <span className="text-xs text-muted-foreground">{sessionKindLabel(kind)}</span>
            {closed ? (
              <Badge variant="outline" className="whitespace-nowrap">{chatStatusLabel(session.chat_status)}</Badge>
            ) : null}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 text-meta text-muted-foreground">
            <span className="rounded bg-muted px-1.5 py-0.5">{store.name}</span>
            <span className="inline-flex items-center gap-0.5">
              <IdCode value={`#${session.chat_id.slice(0, 8)}`} />
              <IconButton
                icon={Copy}
                label="复制会话 ID"
                size="icon-xs"
                title={session.chat_id}
                onClick={() => {
                  void navigator.clipboard.writeText(session.chat_id)
                    .then(() => notifySuccess("已复制会话 ID"))
                    .catch((reason) => notifyCommandError(reason, "会话 ID 复制失败"))
                }}
              />
            </span>
            <span className="tabular-nums">{formatSessionTime(session.created_at)}</span>
          </div>
        </div>
        <label className="flex shrink-0 cursor-pointer items-center gap-2 text-xs text-muted-foreground">
          <Switch size="sm" checked={showOriginal} onCheckedChange={onShowOriginal} aria-label="显示消息原文" />
          原文
        </label>
      </header>
      <div ref={scrollRef} role="region" aria-label="会话消息" aria-busy={historyLoading} className="min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-pb-4 bg-card px-4 py-5">
        {historyFailed ? (
          <ErrorNotice
            layout={current ? "banner" : "block"}
            title="会话内容未能读取"
            onRetry={onRetryHistory}
          />
        ) : null}
        {!current ? (
          !historyFailed ? (
            <div role="status" aria-label="正在读取会话" className="flex max-w-lg flex-col gap-4" aria-live="polite">
              <span className="sr-only">正在读取会话</span>
              <Skeleton className="h-20 w-4/5" />
              <Skeleton className="h-28 w-full" />
              <Skeleton className="h-14 w-3/5" />
            </div>
          ) : null
        ) : messages.length === 0 ? (
          <div className="flex min-h-40 items-center justify-center px-3 text-center text-sm leading-relaxed text-muted-foreground">
            {session.unread_count > 0 ? invisibleUnreadNote(session.unread_count) : "暂无消息"}
          </div>
        ) : !showOriginal ? (
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{TRANSLATION_HELP}</p>
        ) : (
          <ol className="flex max-w-[72ch] flex-col gap-4">
            {current.has_next ? (
              <li className="pb-1 text-center text-meta text-muted-foreground">仅显示最近 {messages.length} 条</li>
            ) : null}
            {messages.map((message, index) => <ThreadMessage key={index} message={message} />)}
          </ol>
        )}
      </div>
      {kind === "platform" || closed ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-border bg-muted/25 px-4 py-3 text-xs text-muted-foreground">
          {closed ? <LockKeyhole className="size-4 shrink-0" aria-hidden /> : <Info className="size-4 shrink-0" aria-hidden />}
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

function ThreadMessage({ message }: { message: MessageCenterMessageView | null | undefined }) {
  const sender = messageSender(message?.user_type)
  const timestamp = formatMessageTime(message?.created_at)
  const body = messageBody(message)
  const imageLinks = message?.is_image === true ? messageImageLinks(message) : []
  return (
    <li className="min-w-0 self-start">
      <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-meta text-muted-foreground">
        <span className="break-words font-medium">{sender}</span>
        {timestamp ? <time dateTime={message?.created_at}>{timestamp}</time> : null}
      </div>
      <div className="rounded-xl rounded-tl-sm bg-muted px-4 py-3 text-sm leading-7 text-foreground">
        {message?.is_image === true ? (
          <div>
            <p>图片消息{imageLinks.length === 0 ? "（暂无法查看）" : ""}</p>
            {imageLinks.map((href, index) => (
              <a key={`${href}:${index}`} href={href} target="_blank" rel="noreferrer noopener" className="mr-3 text-brand-ink underline underline-offset-2">查看图片{imageLinks.length > 1 ? ` ${index + 1}` : ""}</a>
            ))}
          </div>
        ) : (
          <div>
            {typeof message?.is_image !== "boolean" ? <p className="text-xs text-muted-foreground">消息类型未知</p> : null}
            <p className="whitespace-pre-wrap wrap-anywhere"><ChatMarkdown text={body || (Array.isArray(message?.data) ? "消息内容为空" : "消息内容不可用")} /></p>
          </div>
        )}
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
  const [notesOpen, setNotesOpen] = useState(Boolean(draftZh))

  function onRuKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault()
      if (!sending && draftRu.trim()) onSend()
    }
  }

  return (
    <div className="max-h-[55%] shrink-0 overflow-y-auto border-t border-border bg-card px-4 py-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <FieldLabel htmlFor="mc-draft-ru" className="text-xs font-medium">发送内容 · 俄文</FieldLabel>
        <div className="flex flex-wrap items-center gap-1">
          <Popover>
            <PopoverTrigger render={<Button type="button" variant="outline" size="xs"><NotebookPen aria-hidden />常用回复<ChevronDown aria-hidden /></Button>} />
            <PopoverContent className="w-72">
              {replies.length === 0 ? (
                <p className="text-xs text-muted-foreground">设置里添加常用回复。</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {replies.map((reply) => (
                    <li key={reply}>
                      <button
                        type="button"
                        className="w-full cursor-pointer rounded-md px-2 py-2 text-left text-xs leading-relaxed wrap-anywhere outline-none hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => { onDraftZh(reply); setNotesOpen(true) }}
                      >
                        {reply}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant={notesOpen ? "secondary" : "ghost"}
            size="xs"
            aria-expanded={notesOpen}
            aria-controls="mc-private-draft"
            onClick={() => setNotesOpen((open) => !open)}
          >
            <NotebookPen aria-hidden />
            中文草稿
            <ChevronDown aria-hidden className={cn(notesOpen && "rotate-180")} />
          </Button>
        </div>
      </div>
      {notesOpen ? (
        <Field id="mc-private-draft" className="mb-3 gap-1.5 rounded-lg border border-border bg-muted/25 p-3">
          <FieldLabel htmlFor="mc-draft-zh" className="text-xs">中文草稿 · 仅自己可见</FieldLabel>
          <Textarea
            id="mc-draft-zh"
            lang="zh-CN"
            value={draftZh}
            onChange={(event) => onDraftZh(event.target.value)}
            aria-describedby="mc-translate-help"
            placeholder="中文备忘，不会发送"
            className="min-h-16 max-h-32 resize-y bg-background text-sm"
          />
          <FieldDescription id="mc-translate-help">{TRANSLATION_HELP}</FieldDescription>
        </Field>
      ) : null}
      <div className="rounded-lg border border-border bg-background focus-within:ring-2 focus-within:ring-ring/30">
        <Textarea
          id="mc-draft-ru"
          lang="ru"
          value={draftRu}
          onChange={(event) => onDraftRu(event.target.value)}
          onKeyDown={onRuKey}
          placeholder="输入或粘贴要发送的俄文…"
          aria-describedby="mc-send-help"
          className="min-h-20 max-h-48 resize-y border-0 bg-transparent text-sm leading-relaxed shadow-none focus-visible:ring-0"
        />
        <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2">
          <FieldDescription id="mc-send-help">Enter 发送 · Shift+Enter 换行</FieldDescription>
          <Button type="button" variant="brand" size="sm" disabled={sending || !draftRu.trim()} onClick={onSend}>
            {sending ? <Spinner data-icon="inline-start" /> : <Send data-icon="inline-start" />}
            {sending ? "发送中…" : "发送俄文"}
          </Button>
        </div>
      </div>
    </div>
  )
}

function UnreadCount({ count }: { count: number }) {
  return (
    <Badge
      variant="destructive"
      aria-label={unreadLiveStatus(count)}
      title={unreadLiveStatus(count)}
      className="h-5 min-w-5 shrink-0 justify-center rounded-full border-transparent bg-destructive px-1 whitespace-nowrap text-white tabular-nums"
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

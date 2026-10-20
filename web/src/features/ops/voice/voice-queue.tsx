import { AlertTriangle, Inbox, MessageSquare, RefreshCw } from "lucide-react"
import { useState, type ReactNode } from "react"

import type {
  OpsVoiceChatsView,
  OpsVoiceQuestionItem,
  OpsVoiceQuestionsView,
  OpsVoiceReviewItem,
  OpsVoiceReviewsView,
} from "@/bindings/commands"
import { IdCode } from "@/components/id-code"
import { Section } from "@/components/section"
import { StateChip } from "@/components/state-chip"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { TONE_INK } from "@/lib/receipt-state"
import { cn } from "@/lib/utils"

import {
  PREMIUM_PLUS_COPY,
  canonicalChatStatus,
  chatStatusLabel,
  chatTypeLabel,
  formatPublishedAt,
  formatQueueCount,
  isAvailable,
  isPremiumPlus,
  questionStatusLabel,
  reviewStatusLabel,
  type VoiceLoadMode,
} from "./voice-model"

type QueueReadProps = {
  hasSnapshot: boolean
  loading: VoiceLoadMode | null
  errorMode: VoiceLoadMode | null
  onRetry: () => void
}

function SourceNotice({
  kind,
  reason,
  failed,
  onRetry,
  emptyTitle,
  emptyDescription,
}: {
  kind: OpsVoiceReviewsView["kind"]
  reason: string
  failed: boolean
  onRetry: () => void
  emptyTitle: string
  emptyDescription: string
}) {
  if (failed) {
    return (
      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
        <AlertTriangle className="size-5 shrink-0 text-st-bad-ink" />
        <Button size="sm" variant="outline" onClick={onRetry}>
          重试
        </Button>
      </div>
    )
  }
  if (isPremiumPlus(kind)) {
    return (
      <div
        role="status"
        className="flex gap-3 rounded-xl border border-border bg-card p-4"
      >
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-st-attest-ink" />
        <div className="min-w-0">
          <strong className="text-sm">{PREMIUM_PLUS_COPY}</strong>
          {reason.trim() ? (
            <p className={cn("mt-1 break-words text-compact", TONE_INK.attest)}>
              {reason}
            </p>
          ) : null}
        </div>
      </div>
    )
  }
  return (
    <Empty role="status">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox />
        </EmptyMedia>
        <EmptyTitle>{emptyTitle}</EmptyTitle>
        <EmptyDescription>{emptyDescription}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function LoadingPanel({ label }: { label: string }) {
  return (
    <div
      role="status"
      className="grid min-h-36 place-items-center rounded-xl border border-border bg-card text-sm text-muted-foreground"
    >
      <span className="inline-flex items-center gap-2">
        <Spinner className="size-4" />
        {label}
      </span>
    </div>
  )
}

function ReadNotice({ hasSnapshot, loading }: Pick<QueueReadProps, "hasSnapshot" | "loading">) {
  if (loading === "replace" && hasSnapshot) {
    return (
      <p role="status" className="inline-flex items-center gap-2 text-xs text-muted-foreground">
        <Spinner className="size-3.5" />
        正在刷新，仍显示上次成功结果
      </p>
    )
  }
  return null
}

function PageTail({
  loaded,
  hasNext,
  busy,
  loadingMore,
  failed,
  onLoadMore,
}: {
  loaded: number
  hasNext: boolean
  busy: boolean
  loadingMore: boolean
  failed: boolean
  onLoadMore: () => void
}) {
  if (loaded === 0) return null
  return (
    <div
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-compact text-muted-foreground"
    >
      <span>
        已加载{" "}
        <span className="font-mono tabular-nums text-foreground">{loaded}</span>
        {hasNext ? "，还有下一页" : "，已到最后一页"}
      </span>
      {hasNext ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onLoadMore}
        >
          {loadingMore ? <Spinner /> : <RefreshCw />}
          {loadingMore ? "正在加载…" : failed ? "重试加载更多" : "加载更多"}
        </Button>
      ) : null}
    </div>
  )
}

function TableFrame({
  label,
  busy,
  children,
  loaded,
  hasNext,
  loadingMore,
  loadFailed,
  onLoadMore,
}: {
  label: string
  busy: boolean
  children: ReactNode
  loaded: number
  hasNext: boolean
  loadingMore: boolean
  loadFailed: boolean
  onLoadMore: () => void
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <div
        role="region"
        aria-label={label}
        aria-busy={busy}
        tabIndex={0}
        className="max-h-[32rem] overflow-auto"
      >
        {children}
      </div>
      <PageTail
        loaded={loaded}
        hasNext={hasNext}
        busy={busy}
        loadingMore={loadingMore}
        failed={loadFailed}
        onLoadMore={onLoadMore}
      />
    </div>
  )
}

export function ReviewsSection({
  view,
  onLoadMore,
  ...read
}: QueueReadProps & {
  view: OpsVoiceReviewsView
  onLoadMore: () => void
}) {
  const initialLoading = !read.hasSnapshot && read.loading === "replace"
  const showTable = read.hasSnapshot && isAvailable(view.kind) && view.items.length > 0
  const [reply, setReply] = useState<OpsVoiceReviewItem | null>(null)
  const [draft, setDraft] = useState("")
  return (
    <Section
      title="评价"
      action={
        read.hasSnapshot && isAvailable(view.kind) ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            未回复 {formatQueueCount(view.unprocessed)}
          </span>
        ) : null
      }
    >
      <ReadNotice {...read} />
      {initialLoading ? (
        <LoadingPanel label="正在读取未回复评价…" />
      ) : showTable ? (
        <TableFrame
          label="评价列表"
          busy={read.loading !== null}
          loaded={view.items.length}
          hasNext={view.has_next}
          loadingMore={read.loading === "append"}
          loadFailed={read.errorMode === "append"}
          onLoadMore={onLoadMore}
        >
          <Table className="min-w-[760px]" containerClassName="overflow-visible">
            <TableHeader className="sticky top-0 z-[1] bg-card">
              <TableRow>
                <TableHead className="w-16">星级</TableHead>
                <TableHead>内容</TableHead>
                <TableHead className="w-36">SKU</TableHead>
                <TableHead className="w-44">时间</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-20">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.map((item) => (
                <TableRow key={item.review_id} className="cursor-pointer" onClick={() => {
                  setDraft("")
                  setReply(item)
                }}>
                  <TableCell>
                    <span className="font-mono text-sm tabular-nums">
                      {item.rating}
                    </span>
                  </TableCell>
                  <TableCell className="max-w-[46ch]">
                    <p className="break-words text-compact leading-snug">
                      {item.text.trim() || "（无文字）"}
                    </p>
                    {item.photos_amount > 0 || item.videos_amount > 0 ? (
                      <p className="mt-1 font-mono text-meta tabular-nums text-muted-foreground">
                        图 {item.photos_amount} · 视频 {item.videos_amount}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <IdCode value={item.sku} wrap />
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                    {formatPublishedAt(item.published_at)}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={item.status}
                      label={reviewStatusLabel(item.status)}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={`回复评价 ${item.review_id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDraft("")
                        setReply(item)
                      }}
                    >
                      回复
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <SourceNotice
          kind={view.kind}
          reason={view.reason}
          failed={!read.hasSnapshot && read.errorMode !== null}
          onRetry={read.onRetry}
          emptyTitle="没有待回复的评价"
          emptyDescription="当前店铺没有 UNPROCESSED 评价。"
        />
      )}
      <ReplyDialog
        open={Boolean(reply)}
        title={reply ? `评价 ${reply.review_id}` : "评价"}
        body={reply?.text}
        draft={draft}
        onDraft={setDraft}
        onOpenChange={(next) => {
          if (!next) setReply(null)
        }}
      />
    </Section>
  )
}

export function QuestionsSection({
  view,
  onLoadMore,
  ...read
}: QueueReadProps & {
  view: OpsVoiceQuestionsView
  onLoadMore: () => void
}) {
  const initialLoading = !read.hasSnapshot && read.loading === "replace"
  const showTable = read.hasSnapshot && isAvailable(view.kind) && view.items.length > 0
  const [reply, setReply] = useState<OpsVoiceQuestionItem | null>(null)
  const [draft, setDraft] = useState("")
  return (
    <Section
      title="提问"
      action={
        read.hasSnapshot && isAvailable(view.kind) ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            未回复 {formatQueueCount(view.unprocessed)}
          </span>
        ) : null
      }
    >
      <ReadNotice {...read} />
      {initialLoading ? (
        <LoadingPanel label="正在读取未回复提问…" />
      ) : showTable ? (
        <TableFrame
          label="提问列表"
          busy={read.loading !== null}
          loaded={view.items.length}
          hasNext={view.has_next}
          loadingMore={read.loading === "append"}
          loadFailed={read.errorMode === "append"}
          onLoadMore={onLoadMore}
        >
          <Table className="min-w-[700px]" containerClassName="overflow-visible">
            <TableHeader className="sticky top-0 z-[1] bg-card">
              <TableRow>
                <TableHead>问题</TableHead>
                <TableHead className="w-36">SKU</TableHead>
                <TableHead className="w-44">时间</TableHead>
                <TableHead className="w-24">状态</TableHead>
                <TableHead className="w-20">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.map((item) => (
                <TableRow
                  key={item.question_id}
                  className="cursor-pointer"
                  onClick={() => {
                    setDraft("")
                    setReply(item)
                  }}
                >
                  <TableCell className="max-w-[46ch]">
                    <p className="break-words text-compact leading-snug">
                      {item.text.trim() || "（无文字）"}
                    </p>
                    {item.author_name.trim() ? (
                      <p className="mt-1 truncate text-meta text-muted-foreground">
                        {item.author_name}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <IdCode value={item.sku} wrap />
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                    {formatPublishedAt(item.published_at)}
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={item.status}
                      label={questionStatusLabel(item.status)}
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      size="xs"
                      variant="outline"
                      aria-label={`回复提问 ${item.question_id}`}
                      onClick={(event) => {
                        event.stopPropagation()
                        setDraft("")
                        setReply(item)
                      }}
                    >
                      回复
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <SourceNotice
          kind={view.kind}
          reason={view.reason}
          failed={!read.hasSnapshot && read.errorMode !== null}
          onRetry={read.onRetry}
          emptyTitle="没有待回复的提问"
          emptyDescription="当前店铺没有 UNPROCESSED 提问。"
        />
      )}
      <ReplyDialog
        open={Boolean(reply)}
        title={reply ? `提问 ${reply.question_id}` : "提问"}
        body={reply?.text}
        draft={draft}
        onDraft={setDraft}
        onOpenChange={(next) => {
          if (!next) setReply(null)
        }}
      />
    </Section>
  )
}

function ReplyDialog({
  open,
  title,
  body,
  draft,
  onDraft,
  onOpenChange,
}: {
  open: boolean
  title: string
  body?: string
  draft: string
  onDraft: (value: string) => void
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(42rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="border-b border-border px-4 py-3 pr-12">
          <DialogTitle className="font-mono text-sm break-all">{title}</DialogTitle>
          <DialogDescription>
            口碑不发送回复。会话写路径在 消息。
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          {body?.trim() ? (
            <p className="break-words text-sm leading-relaxed">{body}</p>
          ) : null}
          <Field>
            <FieldLabel htmlFor="ops-voice-reply">回复</FieldLabel>
            <Textarea
              id="ops-voice-reply"
              value={draft}
              onChange={(event) => onDraft(event.target.value)}
            />
            <FieldDescription>Seller 写接口未接入，这段文字不会发出。</FieldDescription>
          </Field>
        </div>
        <DialogFooter className="m-0 shrink-0 rounded-none px-4 py-3">
          <Button type="button" variant="outline" disabled>
            回复
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ChatsSection({
  view,
  onLoadMore,
  ...read
}: QueueReadProps & {
  view: OpsVoiceChatsView
  onLoadMore: () => void
}) {
  const initialLoading = !read.hasSnapshot && read.loading === "replace"
  const showTable = read.hasSnapshot && isAvailable(view.kind) && view.items.length > 0
  return (
    <Section
      title="聊天"
      action={
        read.hasSnapshot && isAvailable(view.kind) ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            未读消息 {view.total_unread_count.toLocaleString("zh-CN")}
          </span>
        ) : null
      }
    >
      <ReadNotice {...read} />
      {initialLoading ? (
        <LoadingPanel label="正在读取会话列表…" />
      ) : showTable ? (
        <TableFrame
          label="聊天列表"
          busy={read.loading !== null}
          loaded={view.items.length}
          hasNext={view.has_next}
          loadingMore={read.loading === "append"}
          loadFailed={read.errorMode === "append"}
          onLoadMore={onLoadMore}
        >
          <Table className="min-w-[760px]" containerClassName="overflow-visible">
            <TableHeader className="sticky top-0 z-[1] bg-card">
              <TableRow>
                <TableHead>会话 ID</TableHead>
                <TableHead className="w-28">状态</TableHead>
                <TableHead className="w-36">类型</TableHead>
                <TableHead className="w-24">未读</TableHead>
                <TableHead className="w-44">时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {view.items.map((item) => (
                <TableRow key={item.chat_id || item.last_message_id}>
                  <TableCell>
                    <IdCode value={item.chat_id || "—"} wrap />
                  </TableCell>
                  <TableCell>
                    <StateChip
                      status={canonicalChatStatus(item.chat_status)}
                      label={chatStatusLabel(item.chat_status)}
                    />
                  </TableCell>
                  <TableCell>
                    <span className="text-xs">{chatTypeLabel(item.chat_type)}</span>
                  </TableCell>
                  <TableCell>
                    <span className="inline-flex items-center gap-1.5 font-mono text-sm tabular-nums">
                      <MessageSquare className="size-3.5 text-muted-foreground" />
                      {item.unread_count.toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs tabular-nums">
                    {formatPublishedAt(item.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableFrame>
      ) : (
        <SourceNotice
          kind={view.kind}
          reason={view.reason}
          failed={!read.hasSnapshot && read.errorMode !== null}
          onRetry={read.onRetry}
          emptyTitle="没有会话"
          emptyDescription="当前店铺没有聊天会话。"
        />
      )}
    </Section>
  )
}

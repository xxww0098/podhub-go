import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"

import type {
  OpsVoiceChatsView,
  OpsVoiceQuestionsView,
  OpsVoiceReviewsView,
} from "@/bindings/commands"

import {
  PREMIUM_PLUS_COPY,
  appendChats,
  canonicalChatStatus,
  chatStatusLabel,
  chatTypeLabel,
  emptyChats,
  emptyQuestions,
  emptyReviews,
  formatPublishedAt,
  runVoiceRead,
  voiceReadState,
  type VoiceReadState,
} from "./voice-model"
import { ChatsSection, QuestionsSection, ReviewsSection } from "./voice-queue"

const longRu =
  "Картина пришла помятой, цвета бледнее чем на фото в карточке товара, рамка слегка трещит по углам и упаковка была мокрой после доставки из распределительного центра."
const longZh =
  "买家写了一段很长的中文评价，反复说明画芯受潮起皱、色差明显，以及物流时效远超页面承诺，要求说明是否可以补发或退货。"

const reviewsAvailable: OpsVoiceReviewsView = {
  kind: "available",
  reason: "",
  items: [
    {
      review_id: "rev-ru",
      rating: 2,
      text: longRu,
      sku: "9007199254740993",
      published_at: "2026-08-12T16:41:03Z",
      status: "UNPROCESSED",
      photos_amount: 2,
      videos_amount: 0,
    },
    {
      review_id: "rev-zh",
      rating: 1,
      text: longZh,
      sku: "4882201103",
      published_at: "2026-08-11T04:02:00Z",
      status: "UNPROCESSED",
      photos_amount: 0,
      videos_amount: 0,
    },
  ],
  has_next: true,
  last_id: "rev_last_01",
  unprocessed: 7,
}

const questionsPremium: OpsVoiceQuestionsView = {
  ...emptyQuestions(),
  kind: "premium_plus_required",
  reason: "The method is available only with a Premium Plus subscription",
}

const chatsAvailable: OpsVoiceChatsView = {
  kind: "available",
  reason: "",
  items: [
    {
      chat_id: "chat-one",
      chat_status: "OPENED",
      chat_type: "BUYER_SELLER",
      created_at: "2026-08-10T09:14:22Z",
      unread_count: 3,
      last_message_id: "88412088",
    },
  ],
  has_next: false,
  cursor: "",
  total_unread_count: 1,
}

const ready = {
  hasSnapshot: true,
  loading: null,
  errorMode: null,
  onRetry: () => {},
} as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test("review rows preserve exact SKU and full customer text", () => {
  const html = renderToStaticMarkup(
    <ReviewsSection {...ready} view={reviewsAvailable} onLoadMore={() => {}} />,
  )
  assert.match(html, /未回复 7/)
  assert.match(html, /9007199254740993/)
  assert.match(html, new RegExp(longRu))
  assert.match(html, /还有下一页/)
  assert.match(html, /aria-label="回复评价 rev-ru"/)
  assert.doesNotMatch(html, /line-clamp/)
})

test("queue tables are named, bounded, focusable and sticky", () => {
  const html = renderToStaticMarkup(
    <ReviewsSection {...ready} view={reviewsAvailable} onLoadMore={() => {}} />,
  )
  assert.match(html, /role="region"/)
  assert.match(html, /aria-label="评价列表"/)
  assert.match(html, /tabindex="0"/)
  assert.match(html, /max-h-\[32rem\]/)
  assert.match(html, /sticky top-0/)
})

test("a true empty queue is not a Premium Plus refusal", () => {
  const html = renderToStaticMarkup(
    <QuestionsSection {...ready} view={emptyQuestions()} onLoadMore={() => {}} />,
  )
  assert.match(html, /没有待回复的提问/)
  assert.doesNotMatch(html, new RegExp(PREMIUM_PLUS_COPY))
})

test("Premium Plus is a capability fact, never an empty list", () => {
  const html = renderToStaticMarkup(
    <QuestionsSection {...ready} view={questionsPremium} onLoadMore={() => {}} />,
  )
  assert.match(html, new RegExp(PREMIUM_PLUS_COPY))
  assert.match(html, /The method is available only with a Premium Plus subscription/)
  assert.doesNotMatch(html, /没有待回复的提问|<table/)
})

test("an initial Ozon failure keeps only the retry affordance", () => {
  const html = renderToStaticMarkup(
    <ChatsSection
      hasSnapshot={false}
      loading={null}
      errorMode="replace"
      onRetry={() => {}}
      view={emptyChats()}
      onLoadMore={() => {}}
    />,
  )
  assert.doesNotMatch(html, /role="alert"/)
  assert.doesNotMatch(html, /Permission denied/)
  assert.match(html, /重试/)
  assert.doesNotMatch(html, /没有会话/)
})

test("a refresh paints the last snapshot and exposes busy semantics", () => {
  const html = renderToStaticMarkup(
    <ReviewsSection
      {...ready}
      loading="replace"
      view={reviewsAvailable}
      onLoadMore={() => {}}
    />,
  )
  assert.match(html, /仍显示上次成功结果/)
  assert.match(html, /9007199254740993/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /disabled=""/)
})

test("an append failure keeps rows and an inline same-page retry", () => {
  const html = renderToStaticMarkup(
    <ReviewsSection
      {...ready}
      errorMode="append"
      view={reviewsAvailable}
      onLoadMore={() => {}}
    />,
  )
  assert.match(html, /9007199254740993/)
  assert.doesNotMatch(html, /RATE_LIMIT_EXCEEDED/)
  assert.match(html, /重试加载更多/)
})

test("voice queue sections never paint read failure copy", () => {
  const source = readFileSync(new URL("./voice-queue.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /role="alert"/)
  assert.doesNotMatch(source, /\{error\}/)
})

test("real uppercase chat tokens are localized", () => {
  const html = renderToStaticMarkup(
    <ChatsSection {...ready} view={chatsAvailable} onLoadMore={() => {}} />,
  )
  assert.match(html, /未读消息 1/)
  assert.match(html, /进行中/)
  assert.match(html, /买家与卖家/)
  assert.doesNotMatch(html, /OPENED|BUYER_SELLER/)
  assert.equal(canonicalChatStatus("opened"), "Opened")
  assert.equal(chatStatusLabel("CLOSED"), "已关闭")
  assert.equal(chatTypeLabel("UNSPECIFIED"), "未指定")
})

test("chat pages deduplicate and remain globally unread-first", () => {
  const merged = appendChats(
    {
      ...chatsAvailable,
      has_next: true,
      cursor: "page-1",
      items: [
        chatsAvailable.items[0],
        { ...chatsAvailable.items[0], chat_id: "chat-zero", unread_count: 0 },
      ],
    },
    {
      ...chatsAvailable,
      cursor: "",
      items: [
        { ...chatsAvailable.items[0], chat_id: "chat-one", unread_count: 99 },
        { ...chatsAvailable.items[0], chat_id: "chat-seven", unread_count: 7 },
      ],
      total_unread_count: 99,
    },
  )
  assert.deepEqual(merged.items.map((item) => item.chat_id), [
    "chat-seven",
    "chat-one",
    "chat-zero",
  ])
  assert.equal(merged.total_unread_count, 1)
})

test("late reads cannot replace the newest committed queue snapshot", async () => {
  const first = deferred<OpsVoiceReviewsView>()
  const second = deferred<OpsVoiceReviewsView>()
  let generation = 1
  let state = voiceReadState(emptyReviews())
  const setState = (
    update: (previous: VoiceReadState<OpsVoiceReviewsView>) => VoiceReadState<OpsVoiceReviewsView>,
  ) => {
    state = update(state)
  }
  const stale = runVoiceRead({
    mode: "replace",
    request: () => first.promise,
    isCurrent: () => generation === 1,
    setState,
    fallback: "failed",
  })
  generation = 2
  const current = runVoiceRead({
    mode: "replace",
    request: () => second.promise,
    isCurrent: () => generation === 2,
    setState,
    fallback: "failed",
  })

  second.resolve(reviewsAvailable)
  assert.equal(await current, true)
  first.resolve({ ...reviewsAvailable, items: [] })
  assert.equal(await stale, false)
  assert.equal(state.view.items[0]?.review_id, "rev-ru")
  assert.equal(state.loading, null)
})

test("a failed refresh preserves the painted queue and retry mode", async () => {
  let state: VoiceReadState<OpsVoiceReviewsView> = {
    ...voiceReadState(reviewsAvailable),
    hasSnapshot: true,
  }
  await assert.rejects(
    runVoiceRead<OpsVoiceReviewsView>({
      mode: "replace",
      request: async () => {
        throw new Error("RATE_LIMIT_EXCEEDED")
      },
      isCurrent: () => true,
      setState: (update) => {
        state = update(state)
      },
      fallback: "刷新评价失败，请稍后重试",
    }),
    /RATE_LIMIT_EXCEEDED/,
  )
  assert.equal(state.view.items[0]?.review_id, "rev-ru")
  assert.equal(state.error, "刷新评价失败，请稍后重试")
  assert.equal(state.errorMode, "replace")
  assert.equal(state.loading, null)
})

test("loading never claims an empty result", () => {
  const html = renderToStaticMarkup(
    <ReviewsSection
      hasSnapshot={false}
      loading="replace"
      errorMode={null}
      onRetry={() => {}}
      view={emptyReviews()}
      onLoadMore={() => {}}
    />,
  )
  assert.match(html, /正在读取未回复评价/)
  assert.doesNotMatch(html, /没有待回复的评价/)
})

test("dates expose an explicit operator timezone and invalid input stays verbatim", () => {
  assert.equal(formatPublishedAt(""), "—")
  assert.equal(formatPublishedAt("not-a-date"), "not-a-date")
  assert.match(formatPublishedAt("2026-08-12T16:41:03Z"), /(GMT|UTC)/)
})

test("Voice controller owns no duplicate title and distinguishes unavailable Stores", () => {
  const source = readFileSync(new URL("./voice-screen.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(source, /<h1/)
  assert.match(source, /hasUnavailableStores/)
  assert.match(source, /rosterHasUnavailableStores/)
  assert.match(source, /reviewsSequence\.current \+= 1/)
  assert.match(source, /questionsSequence\.current \+= 1/)
  assert.doesNotMatch(source, /chatsSequence/)
  assert.doesNotMatch(source, /opsVoiceListChats/)
  assert.match(source, /会话请到 消息/)
  assert.doesNotMatch(source, /space-y-/)
  assert.match(source, /VOICE_REVIEWS_LIVE = "voice-reviews-read"/)
  assert.match(source, /VOICE_QUESTIONS_LIVE = "voice-questions-read"/)
  assert.match(source, /notifyLive\(\{/)
  assert.doesNotMatch(source, /notifyCommandError/)
})
